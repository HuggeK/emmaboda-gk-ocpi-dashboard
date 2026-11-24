// Local dashboard server: serves the static UI and proxies the OCPI API so the
// token never reaches the browser. Binds to 127.0.0.1 only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOcpiClient, OcpiError } from './ocpi-client.js';
import { createDemoClient } from './demo-data.js';
import { normalizeLocation, normalizeSession, normalizeCdr } from './normalize.js';
import { computeLive } from './live.js';
import { createEonClient, EonError } from './eon-client.js';
import { createDemoEonClient } from './eon-demo.js';
import { buildEonData, eonFailure } from './eon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const args = process.argv.slice(2);

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env file - rely on real environment variables (or demo mode).
}

const config = {
  demo: args.includes('--demo') || process.env.OCPI_DEMO === '1',
  check: args.includes('--check'),
  port: Number(argValue('--port') || process.env.PORT || 3000),
  host: '127.0.0.1',
  versionsUrl: process.env.OCPI_VERSIONS_URL || 'https://ocpi.chargenode.eu/ocpi/cpo/versions',
  token: process.env.OCPI_TOKEN || '',
  tokenEncoding: process.env.OCPI_TOKEN_ENCODING || 'auto',
  preferredVersion: process.env.OCPI_PREFERRED_VERSION || undefined,
  fromCountryCode: process.env.OCPI_FROM_COUNTRY_CODE || undefined,
  fromPartyId: process.env.OCPI_FROM_PARTY_ID || undefined,
  verbose: args.includes('--verbose') || process.env.OCPI_VERBOSE === '1',
};

function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const log = (message) => {
  if (config.verbose) console.log(`[ocpi] ${message}`);
};

let client;
if (config.demo) {
  client = createDemoClient();
} else if (!config.token || config.token === 'replace-me') {
  console.error('No OCPI_TOKEN configured. Copy .env.example to .env and fill in the token, or run `npm run demo`.');
  process.exit(1);
} else {
  client = createOcpiClient({ ...config, log });
}

// ---- tiny cache -----------------------------------------------------------
const cache = new Map();
async function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await producer();
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ---- data loaders --------------------------------------------------------
async function loadLocations() {
  return cached('locations', 30_000, async () => {
    const { items } = await client.getAll('locations');
    return items.map(normalizeLocation);
  });
}

async function loadSessions(dateFrom, dateTo) {
  return cached(`sessions:${dateFrom}:${dateTo}`, 15_000, async () => {
    const { items, pages, total } = await client.getAll('sessions', { date_from: dateFrom, date_to: dateTo });
    return { items: items.map(normalizeSession), pages, total };
  });
}

async function loadCdrs(dateFrom, dateTo) {
  return cached(`cdrs:${dateFrom}:${dateTo}`, 60_000, async () => {
    const { items, pages, total } = await client.getAll('cdrs', { date_from: dateFrom, date_to: dateTo });
    const cdrs = items.map(normalizeCdr).sort((a, b) => Date.parse(b.start || 0) - Date.parse(a.start || 0));
    return { items: cdrs, pages, total };
  });
}

async function loadLive() {
  return cached('live', 10_000, async () => {
    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const sessionsFrom = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    const [locations, sessions, todayCdrs] = await Promise.all([
      loadLocations(),
      loadSessions(sessionsFrom, undefined),
      loadCdrs(startOfDay.toISOString(), undefined).catch(() => null),
    ]);
    const todayKwh = todayCdrs ? todayCdrs.items.reduce((sum, c) => sum + (c.energy_kwh || 0), 0) : null;
    return computeLive({ locations, sessions: sessions.items, todayKwh, now });
  });
}

function defaultRange(query, days = 30) {
  const to = query.get('date_to') || undefined;
  let from = query.get('date_from');
  if (!from) from = new Date(Date.now() - days * 86_400_000).toISOString();
  return { from, to };
}

// ---- grid meter (E.ON) ---------------------------------------------------
// Optional. Credentials come from the environment, never from a file:
//   $env:EON_CLIENT_ID = '...'; $env:EON_CLIENT_SECRET = '...'; npm start
let eonData = null; // last result, extended on each refresh like the published snapshot
async function loadEon() {
  return cached('eon', 10 * 60_000, async () => {
    let client;
    if (config.demo) {
      const { items } = await loadAllCdrsForDemo();
      client = createDemoEonClient({ records: items });
    } else if (process.env.EON_CLIENT_ID && process.env.EON_CLIENT_SECRET) {
      client = createEonClient({ clientId: process.env.EON_CLIENT_ID, clientSecret: process.env.EON_CLIENT_SECRET, log: (m) => config.verbose && console.log(`[eon] ${m}`) });
    } else {
      return { configured: false };
    }
    try {
      eonData = await buildEonData({
        client,
        base: eonData?.error ? null : eonData,
        historyFrom: process.env.EON_HISTORY_FROM || '2024-01-01',
        preferredSeriesId: process.env.EON_SERIES_ID || null,
        preferredInstallationId: process.env.EON_INSTALLATION_ID || null,
      });
    } catch (err) {
      if (!(err instanceof EonError)) console.error(err);
      return eonFailure(err, eonData);
    }
    return eonData;
  });
}

async function loadAllCdrsForDemo() {
  const { items } = await client.getAll('cdrs', {});
  return { items: items.map(normalizeCdr) };
}

// ---- routing -------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err) {
  if (err instanceof OcpiError) {
    const statusCode = err.details.code === 'UNAUTHORIZED' ? 502 : err.details.code === 'MODULE_MISSING' ? 501 : 502;
    sendJson(res, statusCode, { error: err.toJSON() });
    return;
  }
  console.error(err);
  sendJson(res, 500, { error: { message: err?.message || String(err), code: 'INTERNAL' } });
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/\/+$/, '');
  const query = url.searchParams;

  if (route === '/api/status') {
    let discovery = null;
    let error = null;
    try {
      discovery = await client.discover({ force: query.get('retry') === '1' });
    } catch (err) {
      error = err instanceof OcpiError ? err.toJSON() : { message: String(err) };
    }
    if (query.get('retry') === '1') cache.clear();
    const status = client.status();
    sendJson(res, 200, {
      ...status,
      discovery: discovery || status.discovery,
      lastError: error || status.lastError,
      connected: Boolean(discovery && !error),
      server: { node: process.version, startedAt: STARTED_AT, port: config.port },
    });
    return;
  }

  if (route === '/api/locations') {
    sendJson(res, 200, { items: await loadLocations() });
    return;
  }

  if (route === '/api/live') {
    sendJson(res, 200, await loadLive());
    return;
  }

  if (route === '/api/sessions') {
    const { from, to } = defaultRange(query, 7);
    const result = await loadSessions(from, to);
    sendJson(res, 200, { ...result, date_from: from, date_to: to ?? null });
    return;
  }

  if (route === '/api/cdrs') {
    const { from, to } = defaultRange(query, 30);
    const result = await loadCdrs(from, to);
    sendJson(res, 200, { ...result, date_from: from, date_to: to ?? null });
    return;
  }

  if (route === '/api/eon') {
    sendJson(res, 200, await loadEon());
    return;
  }

  if (route === '/api/tariffs') {
    const { items } = await cached('tariffs', 300_000, () => client.getAll('tariffs'));
    sendJson(res, 200, { items });
    return;
  }

  sendJson(res, 404, { error: { message: `Unknown API route ${route}`, code: 'NOT_FOUND' } });
}

function serveStatic(req, res, url) {
  let filePath = decodeURIComponent(url.pathname);
  if (filePath === '/' || filePath === '') filePath = '/index.html';
  const resolved = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const STARTED_AT = new Date().toISOString();

async function main() {
  if (config.check) {
    try {
      const discovery = await client.discover();
      console.log(JSON.stringify(discovery, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(JSON.stringify(err instanceof OcpiError ? err.toJSON() : { message: String(err) }, null, 2));
      process.exit(1);
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: { message: 'Only GET is supported', code: 'METHOD_NOT_ALLOWED' } });
          return;
        }
        await handleApi(req, res, url);
      } else {
        serveStatic(req, res, url);
      }
    } catch (err) {
      sendError(res, err);
    }
  });

  server.listen(config.port, config.host, () => {
    const mode = client.isDemo ? 'DEMO DATA' : `live OCPI at ${config.versionsUrl}`;
    console.log(`Charger dashboard running at http://${config.host}:${config.port}/  (${mode})`);
    if (!client.isDemo) {
      client.discover().then(
        (d) => console.log(`Connected: OCPI ${d.version}, modules: ${Object.keys(d.endpoints).join(', ')}`),
        (err) => console.warn(`OCPI connection failed: ${err.message} - open the Connection tab for details`),
      );
    }
  });
}

main();
