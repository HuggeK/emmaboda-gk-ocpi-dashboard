// Builds the static dashboard into an output directory: a copy of public/ plus
// data/snapshot.json with everything the UI shows, ready for GitHub Pages or
// any static host. The OCPI key is only used here, at build time.
//
//   node scripts/build-snapshot.js [--out dist] [--base-url <url>] [--full]
//                                  [--history-from <ISO date>] [--demo] [--verbose]
//
// Configuration comes from the environment (OCPI_TOKEN, OCPI_VERSIONS_URL, ...)
// or from .env, exactly like the local server. Inside GitHub Actions the script
// also writes step outputs and a job summary so the workflow can report.
//
// Charge records: with --base-url the previously published snapshot is fetched
// and only the records changed since it was built are requested from the CPO
// (a handful of requests instead of a full history). --full ignores the base
// and refetches everything from --history-from (default: all the CPO has).
// SE4 spot prices per quarter hour are always extended from the base: past
// prices never change.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOcpiClient, OcpiError } from '../server/ocpi-client.js';
import { createDemoClient } from '../server/demo-data.js';
import { buildSnapshot, buildEmptySnapshot } from '../server/snapshot.js';
import { createEonClient } from '../server/eon-client.js';
import { createDemoEonClient } from '../server/eon-demo.js';
import { buildEonData, eonFailure } from '../server/eon.js';
import { buildSpotData, createDemoSpot } from '../server/spot.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SNAPSHOT_META = '<meta name="dashboard-snapshot" content="data/snapshot.json">';
const args = process.argv.slice(2);

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env - rely on real environment variables (GitHub Actions) or --demo.
}

function argValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const config = {
  demo: args.includes('--demo') || process.env.OCPI_DEMO === '1',
  verbose: args.includes('--verbose') || process.env.OCPI_VERBOSE === '1',
  outDir: path.resolve(ROOT, argValue('--out') || 'dist'),
  baseUrl: argValue('--base-url') || process.env.SNAPSHOT_BASE_URL || '',
  full: args.includes('--full'),
  historyFrom: argValue('--history-from') || process.env.OCPI_HISTORY_FROM || null,
  versionsUrl: process.env.OCPI_VERSIONS_URL || 'https://ocpi.chargenode.eu/ocpi/cpo/versions',
  token: process.env.OCPI_TOKEN || '',
  tokenEncoding: process.env.OCPI_TOKEN_ENCODING || 'auto',
  preferredVersion: process.env.OCPI_PREFERRED_VERSION || undefined,
  fromCountryCode: process.env.OCPI_FROM_COUNTRY_CODE || undefined,
  fromPartyId: process.env.OCPI_FROM_PARTY_ID || undefined,
  // E.ON Energidata API (grid meter values). Optional: without it the Meter
  // tab explains how to set it up.
  eonClientId: process.env.EON_CLIENT_ID || '',
  eonClientSecret: process.env.EON_CLIENT_SECRET || '',
  eonHistoryFrom: process.env.EON_HISTORY_FROM || '2024-01-01',
  eonSeriesId: process.env.EON_SERIES_ID || null,
  eonInstallationId: process.env.EON_INSTALLATION_ID || null,
};
const inGitHubActions = process.env.GITHUB_ACTIONS === 'true';

const log = (message) => {
  if (config.verbose) console.log(`[ocpi] ${message}`);
};

// GitHub Actions plumbing; both are no-ops outside a workflow run.
function setOutputs(pairs) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(pairs).map(([key, value]) => `${key}=${String(value ?? '').replace(/\r?\n/g, ' ')}`);
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}
function addSummary(markdown) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function createClient() {
  if (config.demo) return createDemoClient();
  if (!config.token || config.token === 'replace-me') {
    throw new Error('No OCPI_TOKEN configured. Set it in .env or the environment, or run with --demo.');
  }
  return createOcpiClient({ ...config, log });
}

function writeSite(snapshot) {
  const { outDir } = config;
  if (outDir === ROOT || ROOT.startsWith(outDir + path.sep)) {
    throw new Error(`Refusing to build into ${outDir}: it contains the project itself.`);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(PUBLIC_DIR, outDir, { recursive: true });

  // GitHub Pages caches every file for 10 minutes, so a deploy could otherwise
  // pair a fresh index.html with a stale app.js in the reader's browser. A
  // build id on the asset URLs makes each deploy fetch its own scripts.
  const buildId = Date.now().toString(36);
  const rewrite = (file, replacements) => {
    let text = fs.readFileSync(file, 'utf8');
    for (const [from, to] of replacements) {
      if (!text.includes(from)) throw new Error(`${path.basename(file)} no longer contains "${from}"; update writeSite() in scripts/build-snapshot.js`);
      text = text.replace(from, to);
    }
    fs.writeFileSync(file, text);
  };
  rewrite(path.join(outDir, 'index.html'), [
    ['<meta name="viewport"', `${SNAPSHOT_META}\n  <meta name="viewport"`],
    ['href="styles.css"', `href="styles.css?v=${buildId}"`],
    ['src="app.js"', `src="app.js?v=${buildId}"`],
  ]);
  rewrite(path.join(outDir, 'app.js'), [
    ["from './analysis.js'", `from './analysis.js?v=${buildId}'`],
    ["from './meter.js'", `from './meter.js?v=${buildId}'`],
    ["from './economics.js'", `from './economics.js?v=${buildId}'`],
    ["from './facility.js'", `from './facility.js?v=${buildId}'`],
    ["from './contracts.js'", `from './contracts.js?v=${buildId}'`],
    ["import('./solar3d.js')", `import('./solar3d.js?v=${buildId}')`],
  ]);
  // The other modules must import the same analysis.js URL, or the browser loads it twice.
  rewrite(path.join(outDir, 'meter.js'), [
    ["from './analysis.js'", `from './analysis.js?v=${buildId}'`],
    ["from './contracts.js'", `from './contracts.js?v=${buildId}'`],
  ]);
  rewrite(path.join(outDir, 'economics.js'), [["from './analysis.js'", `from './analysis.js?v=${buildId}'`]]);

  fs.mkdirSync(path.join(outDir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'data', 'snapshot.json'), JSON.stringify(snapshot));
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
}

// The previously published snapshot, to extend instead of refetching all
// records. Any problem means a full fetch, never a failed build.
async function loadBase() {
  if (!config.baseUrl || config.demo) return null;
  const url = `${config.baseUrl}${config.baseUrl.includes('?') ? '&' : '?'}nocache=${Date.now()}`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const base = await res.json();
    if (!base?.status?.generated_at || !Array.isArray(base?.cdrs?.items)) throw new Error('not a snapshot');
    console.log(`Previous snapshot from ${base.status.generated_at} with ${base.cdrs.items.length} records loaded from ${config.baseUrl}`);
    return base;
  } catch (err) {
    console.warn(`No usable previous snapshot at ${config.baseUrl} (${err.message}); fetching the full history.`);
    return null;
  }
}

function describe(snapshot) {
  const { status, live, cdrs } = snapshot;
  const thirtyDaysAgo = Date.parse(status.generated_at) - 30 * 86_400_000;
  const recent = cdrs.items.filter((c) => Date.parse(c.start || c.end || 0) >= thirtyDaysAgo);
  return {
    generated_at: status.generated_at,
    ocpi_version: status.discovery.version,
    modules: Object.keys(status.discovery.endpoints).join(', '),
    evses: live.summary.evses_total,
    evses_charging: live.summary.evses_charging,
    cdr_count: cdrs.items.length,
    cdr_since: status.cdr_window.from ? status.cdr_window.from.slice(0, 10) : '',
    cdr_days: status.cdr_window.days,
    cdr_pages: status.counts.cdr_pages,
    cdr_fetched: status.counts.cdr_fetched,
    incremental: status.cdr_window.incremental ? 'true' : 'false',
    sessions_30d: recent.length,
    kwh_30d: Math.round(recent.reduce((sum, c) => sum + (c.energy_kwh || 0), 0) * 10) / 10,
  };
}

// Grid meter values from E.ON, added to the snapshot. A failure here never
// fails the build: the previous snapshot's values are kept with the reason.
async function addEon(snapshot, base) {
  const eonLog = (message) => {
    if (config.verbose) console.log(`[eon] ${message}`);
  };
  let client;
  if (config.demo) client = createDemoEonClient({ records: snapshot.cdrs.items });
  else if (config.eonClientId && config.eonClientSecret) client = createEonClient({ clientId: config.eonClientId, clientSecret: config.eonClientSecret, log: eonLog });
  else {
    snapshot.eon = { configured: false };
    console.log('E.ON: not configured (EON_CLIENT_ID / EON_CLIENT_SECRET unset); the Meter tab says how to set it up.');
    return { eon_result: 'not_configured' };
  }
  try {
    snapshot.eon = await buildEonData({
      client,
      base: base?.eon?.configured ? base.eon : null,
      full: config.full,
      historyFrom: config.eonHistoryFrom,
      preferredSeriesId: config.eonSeriesId,
      preferredInstallationId: config.eonInstallationId,
    });
  } catch (err) {
    snapshot.eon = eonFailure(err, base?.eon?.configured ? base.eon : null);
    console.warn(`E.ON: ${err.message} (kept the previous meter values)`);
    return { eon_result: 'error', eon_error: err.message };
  }
  const withData = snapshot.eon.installations.filter((i) => i.hourly);
  const hours = withData.reduce((n, i) => n + i.hourly.values.filter((v) => v !== null).length, 0);
  const last = withData.map((i) => i.last_value_end).filter(Boolean).sort().at(-1) || '';
  const problems = snapshot.eon.installations.flatMap((i) => i.errors.map((e) => `${i.name || i.ref} ${e.resolution || ''}: ${e.message}`));
  console.log(`E.ON: ${snapshot.eon.installations.length} installation(s), ${hours} hourly values up to ${last || '–'}${problems.length ? `; ${problems.join('; ')}` : ''}`);
  return { eon_result: withData.length ? 'ok' : 'no_data', eon_hours: hours, eon_last: last, eon_error: problems.join('; ') };
}

// SE4 spot prices per quarter hour, for pricing the meter's quarter values. A
// failure keeps the previous prices and never fails the build.
async function addSpot(snapshot, base) {
  if (config.demo) {
    snapshot.spot = createDemoSpot({ historyFrom: config.eonHistoryFrom });
    return { spot_result: 'demo' };
  }
  const spotLog = (message) => {
    if (config.verbose) console.log(`[spot] ${message}`);
  };
  try {
    snapshot.spot = await buildSpotData({ base: base?.spot || null, historyFrom: config.eonHistoryFrom, log: spotLog });
  } catch (err) {
    snapshot.spot = base?.spot ? { ...base.spot, error: err.message } : null;
    const kept = base?.spot ? ' (kept the previous prices)' : '';
    console.warn(`Spot prices: ${err.message}${kept}`);
    addSummary(`### Spot prices (SE4)\n\nFailed: ${err.message}${kept}.\n`);
    return { spot_result: 'error', spot_error: err.message };
  }
  const f = snapshot.spot.fetch;
  console.log(`Spot prices: SE4 per quarter hour up to ${snapshot.spot.last_value_end}; ${f.fetched} day(s) fetched${f.errors.length ? `, ${f.errors.length} failed: ${f.errors[0]}` : ''}`);
  addSummary(`### Spot prices (SE4)\n\nPer quarter hour up to ${snapshot.spot.last_value_end}, ${f.fetched} day(s) fetched this run.\n`);
  return { spot_result: 'ok', spot_last: snapshot.spot.last_value_end };
}

// Set once ChargeNode has accepted the key on the versions endpoint, so a
// later 401 on a data module can be told apart from a rejected key.
let keyAccepted = false;

async function main() {
  const client = createClient();
  const startedAt = Date.now();

  // The versions call is what keeps the key alive at ChargeNode. Report it on
  // its own so a later failure (say, a CDR page timing out) cannot hide that
  // the key was in fact used.
  const discovery = await client.discover();
  keyAccepted = true;
  setOutputs({ key_used: 'true' });
  console.log(`Connected: OCPI ${discovery.version}, modules: ${Object.keys(discovery.endpoints).join(', ')}`);

  const generator = config.demo ? 'demo' : inGitHubActions ? 'github-actions' : 'local';
  const base = await loadBase();
  let snapshot;
  let dataError = null;
  try {
    snapshot = await buildSnapshot({ client, generator, base: config.full ? null : base, historyFrom: config.historyFrom });
  } catch (err) {
    // A key that opens versions but not the data modules still gets a
    // published site: the Connection tab can then say why, and the static
    // OCPI files under /ocpi stay online for the credentials handshake.
    if (!(err instanceof OcpiError) || err.details.code !== 'UNAUTHORIZED') throw err;
    dataError = err.toJSON();
    snapshot = buildEmptySnapshot({ client, discovery, dataError, generator });
  }
  const eonInfo = await addEon(snapshot, base);
  setOutputs(eonInfo);
  setOutputs(await addSpot(snapshot, base));
  addSummary(`### Grid meter (E.ON)\n\n${{
    ok: `${eonInfo.eon_hours} hourly values, up to ${eonInfo.eon_last}.${eonInfo.eon_error ? ` Problems: ${eonInfo.eon_error}` : ''}`,
    no_data: `Connected, but no meter values came back. ${eonInfo.eon_error || ''}`,
    error: `Failed: ${eonInfo.eon_error}. The previous values were kept.`,
    not_configured: 'Not configured: set the CLIENTID and CLIENTSECRET repository secrets.',
  }[eonInfo.eon_result]}\n`);
  writeSite(snapshot);

  const info = describe(snapshot);
  const size = fs.statSync(path.join(config.outDir, 'data', 'snapshot.json')).size;
  console.log(`Snapshot written to ${config.outDir} (${Math.round(size / 1024)} kB) in ${Date.now() - startedAt} ms`);
  if (!dataError) {
    console.log(snapshot.status.cdr_window.incremental
      ? `  extended the previous snapshot: ${info.cdr_fetched} record(s) changed since ${snapshot.status.cdr_window.fetched_from}, ${info.cdr_pages} page(s) fetched`
      : `  full fetch: ${info.cdr_fetched} records in ${info.cdr_pages} page(s)`);
  }

  if (dataError) {
    const explanation = explain('module_unauthorized', dataError);
    console.error(explanation);
    setOutputs({ result: 'module_unauthorized', error: dataError.message, ...info });
    addSummary(`### Site published without data\n\n${explanation}`);
    return;
  }

  console.log(`  ${info.evses} charging points, ${info.cdr_count} charge records since ${info.cdr_since}, ${info.sessions_30d} sessions / ${info.kwh_30d} kWh in the last 30 days`);
  setOutputs({ result: 'ok', ...info });
  addSummary([
    '### Snapshot built',
    '',
    '| | |',
    '|---|---|',
    `| Generated | ${info.generated_at} |`,
    `| OCPI | ${info.ocpi_version} (${info.modules}) |`,
    `| Charging points | ${info.evses} (${info.evses_charging} charging at snapshot time) |`,
    `| Charge records | ${info.cdr_count} since ${info.cdr_since} (${info.incremental === 'true' ? `${info.cdr_fetched} changed since the previous snapshot` : `full fetch, ${info.cdr_pages} pages`}) |`,
    `| Last 30 days | ${info.sessions_30d} sessions, ${info.kwh_30d} kWh |`,
  ].join('\n'));
}

function explain(result, details) {
  return {
    unauthorized: 'ChargeNode rejected the OCPI key on the versions endpoint (HTTP 401). The key expires after a week without use; ask ChargeNode for a new one and update the SECRET_KEY repository secret.',
    module_unauthorized: `ChargeNode accepted the key on the versions and credentials endpoints but refused the data module (HTTP ${details.httpStatus || 401} from ${details.url}). That is how an OCPI registration token ("token A") behaves before the credentials handshake: ask ChargeNode for a key with direct read access to locations, sessions and cdrs, or to complete the registration.`,
    error: `Snapshot failed: ${details.message}`,
  }[result];
}

main().catch((err) => {
  const details = err instanceof OcpiError ? err.toJSON() : { message: err?.message || String(err) };
  const unauthorized = details.code === 'UNAUTHORIZED';
  const result = !unauthorized ? 'error' : keyAccepted ? 'module_unauthorized' : 'unauthorized';
  const explanation = explain(result, details);
  console.error(explanation);
  console.error(JSON.stringify(details, null, 2));
  setOutputs({ result, error: details.message });
  addSummary(`### Snapshot failed\n\n${explanation}\n\n\`\`\`\n${JSON.stringify(details, null, 2)}\n\`\`\``);
  process.exit(1);
});
