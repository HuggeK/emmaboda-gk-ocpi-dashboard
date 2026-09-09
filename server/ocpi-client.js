// OCPI client: token auth, version discovery, paginated module fetches.
// Zero dependencies - uses Node's built-in fetch.
import { randomUUID } from 'node:crypto';

const VERSION_PREFERENCE = ['2.2.1', '2.2', '2.1.1', '2.1', '2.0'];
const PAGE_LIMIT = 100;
const MAX_PAGES = 200;
const REQUEST_TIMEOUT_MS = 25_000;

export class OcpiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'OcpiError';
    this.details = details;
  }

  toJSON() {
    return { message: this.message, ...this.details };
  }
}

export function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (match) return match[1];
  }
  return null;
}

export function withParams(url, params) {
  const u = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    u.searchParams.set(key, String(value));
  }
  return u.toString();
}

export function createOcpiClient(config) {
  const {
    versionsUrl,
    token,
    tokenEncoding = 'auto',
    preferredVersion,
    fromCountryCode,
    fromPartyId,
    log = () => {},
  } = config;

  if (!versionsUrl) throw new Error('OCPI_VERSIONS_URL is required');
  if (!token) throw new Error('OCPI_TOKEN is required');

  let discovery = null;
  let discoveryPromise = null;
  let lastError = null;

  function encodeToken(encoding) {
    return encoding === 'base64' ? Buffer.from(token, 'utf8').toString('base64') : token;
  }

  function headersFor(encoding) {
    const headers = {
      Authorization: `Token ${encodeToken(encoding)}`,
      Accept: 'application/json',
      'X-Request-ID': randomUUID(),
      'X-Correlation-ID': randomUUID(),
    };
    if (fromCountryCode) headers['OCPI-from-country-code'] = fromCountryCode;
    if (fromPartyId) headers['OCPI-from-party-id'] = fromPartyId;
    return headers;
  }

  async function rawGet(url, encoding) {
    const started = Date.now();
    const res = await fetch(url, {
      headers: headersFor(encoding),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    log(`GET ${url} -> ${res.status} (${Date.now() - started} ms)`);
    return { status: res.status, headers: res.headers, body, text };
  }

  function unwrap(response, url) {
    if (response.status === 401 || response.status === 403) {
      throw new OcpiError(`The OCPI server rejected the token (HTTP ${response.status})`, {
        code: 'UNAUTHORIZED',
        httpStatus: response.status,
        url,
      });
    }
    if (response.status >= 400) {
      throw new OcpiError(`HTTP ${response.status} from ${url}`, {
        code: 'HTTP_ERROR',
        httpStatus: response.status,
        url,
        body: response.text.slice(0, 500),
      });
    }
    const body = response.body;
    if (!body || typeof body !== 'object') {
      throw new OcpiError(`Non-JSON response from ${url}`, {
        code: 'BAD_RESPONSE',
        httpStatus: response.status,
        url,
        body: response.text.slice(0, 500),
      });
    }
    if (typeof body.status_code === 'number' && body.status_code >= 2000) {
      throw new OcpiError(`OCPI status ${body.status_code}: ${body.status_message || 'error'}`, {
        code: 'OCPI_STATUS',
        ocpiStatus: body.status_code,
        url,
      });
    }
    return body.data !== undefined ? body.data : body;
  }

  async function runDiscovery() {
    const attempts = [];
    const encodings = tokenEncoding === 'auto' ? ['plain', 'base64'] : [tokenEncoding];
    let versions = null;
    let encodingUsed = null;

    for (const encoding of encodings) {
      const res = await rawGet(versionsUrl, encoding);
      attempts.push({ step: 'versions', encoding, url: versionsUrl, httpStatus: res.status });
      if (res.status === 401 || res.status === 403) continue;
      versions = unwrap(res, versionsUrl);
      encodingUsed = encoding;
      break;
    }

    if (!versions) {
      throw new OcpiError('The OCPI server rejected the token on the versions endpoint', {
        code: 'UNAUTHORIZED',
        httpStatus: 401,
        url: versionsUrl,
        attempts,
      });
    }
    if (!Array.isArray(versions)) {
      throw new OcpiError('Unexpected versions payload (expected an array)', { code: 'BAD_RESPONSE', attempts });
    }

    const order = preferredVersion ? [preferredVersion, ...VERSION_PREFERENCE] : VERSION_PREFERENCE;
    const chosen = order.map((v) => versions.find((x) => x.version === v)).find(Boolean) || versions[0];
    if (!chosen?.url) {
      throw new OcpiError('No usable OCPI version offered', { code: 'BAD_RESPONSE', attempts, versions });
    }

    const detailRes = await rawGet(chosen.url, encodingUsed);
    attempts.push({ step: 'version-details', encoding: encodingUsed, url: chosen.url, httpStatus: detailRes.status });
    const details = unwrap(detailRes, chosen.url);

    // OCPI 2.2+: { identifier, role, url } - we call the CPO's SENDER interfaces.
    // OCPI 2.1.1: { identifier, url } - no role field.
    const endpoints = {};
    for (const ep of details.endpoints || []) {
      if (!ep?.identifier || !ep?.url) continue;
      const isSender = !ep.role || ep.role === 'SENDER';
      if (isSender || !endpoints[ep.identifier]) endpoints[ep.identifier] = ep.url;
    }

    return {
      ok: true,
      version: details.version || chosen.version,
      versionUrl: chosen.url,
      availableVersions: versions.map((v) => v.version),
      endpoints,
      encoding: encodingUsed,
      attempts,
      discoveredAt: new Date().toISOString(),
    };
  }

  async function discover({ force = false } = {}) {
    if (discovery && !force) return discovery;
    if (!discoveryPromise || force) {
      discoveryPromise = runDiscovery()
        .then((result) => {
          discovery = result;
          lastError = null;
          return result;
        })
        .catch((err) => {
          lastError = err;
          throw err;
        })
        .finally(() => {
          discoveryPromise = null;
        });
    }
    return discoveryPromise;
  }

  async function getAll(identifier, params = {}) {
    const d = await discover();
    const base = d.endpoints[identifier];
    if (!base) {
      throw new OcpiError(`Module "${identifier}" is not offered by this OCPI server`, {
        code: 'MODULE_MISSING',
        available: Object.keys(d.endpoints),
      });
    }
    let url = withParams(base, { limit: PAGE_LIMIT, ...params });
    const items = [];
    let pages = 0;
    let total = null;
    while (url && pages < MAX_PAGES) {
      const res = await rawGet(url, d.encoding);
      const data = unwrap(res, url);
      if (Array.isArray(data)) items.push(...data);
      else if (data && typeof data === 'object') items.push(data);
      const totalCount = res.headers.get('x-total-count');
      if (totalCount) total = Number(totalCount);
      url = parseNextLink(res.headers.get('link'));
      pages += 1;
    }
    return { items, pages, total: total ?? items.length };
  }

  function status() {
    return {
      mode: 'live',
      versionsUrl,
      tokenPreview: `${token.slice(0, 4)}...${token.slice(-4)} (${token.length} chars)`,
      tokenEncoding,
      discovery,
      lastError: lastError instanceof OcpiError ? lastError.toJSON() : lastError ? { message: String(lastError) } : null,
    };
  }

  return { discover, getAll, status, isDemo: false };
}
