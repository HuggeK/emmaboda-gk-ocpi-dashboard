// Client for E.ON's Energidata API ("Navigator", https://navigator-api.eon.se),
// which serves the grid meter's measured values for the installations the
// business account subscribes to. OAuth2 client credentials: the client id
// and secret are exchanged at /connect/token for a short-lived bearer token.
//
// Endpoints used (all GET, Swagger: /swagger/v1/swagger.json):
//   /api/installations                                    metadata per installation
//   /api/installations/measurement-series                 series ids, type, unit
//   /api/measurements/{id}/resolution/{quarter|hour|day|month}?from&to&includeMissing
//
// Timestamps in requests and responses are Swedish local time without an
// offset; see server/eon.js for how they are turned into UTC instants.

export const EON_BASE_URL = 'https://navigator-api.eon.se';
const TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;

export class EonError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'EonError';
    this.details = details;
  }

  toJSON() {
    return { message: this.message, ...this.details };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createEonClient({ clientId, clientSecret, baseUrl = EON_BASE_URL, log = () => {} } = {}) {
  if (!clientId || !clientSecret) throw new EonError('E.ON client id and secret are not configured', { code: 'NOT_CONFIGURED' });
  const base = baseUrl.replace(/\/+$/, '');
  let token = null; // { value, expiresAt }
  const requests = [];

  async function fetchToken() {
    const url = `${base}/connect/token`;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'navigator' });
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new EonError(`Could not reach E.ON's token endpoint: ${err.message}`, { code: 'NETWORK', url });
    }
    requests.push({ step: 'token', url, httpStatus: res.status, at: new Date().toISOString() });
    log(`POST ${url} -> ${res.status}`);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok || !json?.access_token) {
      const reason = json?.error_description || json?.error || text.slice(0, 200) || `HTTP ${res.status}`;
      throw new EonError(`E.ON refused the client credentials (HTTP ${res.status}): ${reason}`, {
        code: res.status === 400 || res.status === 401 ? 'UNAUTHORIZED' : 'TOKEN_FAILED',
        httpStatus: res.status,
        url,
      });
    }
    const lifetimeS = Number(json.expires_in) || 3600;
    token = { value: json.access_token, expiresAt: Date.now() + (lifetimeS - 60) * 1000 };
    return token.value;
  }

  async function bearer() {
    if (token && Date.now() < token.expiresAt) return token.value;
    return fetchToken();
  }

  // GET a path under the API. Returns parsed JSON, or null for 204 No Content.
  async function get(pathAndQuery, step = 'get') {
    const url = `${base}${pathAndQuery}`;
    for (let attempt = 0; ; attempt += 1) {
      let res;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${await bearer()}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        if (err instanceof EonError) throw err;
        throw new EonError(`Could not reach E.ON: ${err.message}`, { code: 'NETWORK', url });
      }
      requests.push({ step, url, httpStatus: res.status, at: new Date().toISOString() });
      log(`GET ${url} -> ${res.status}`);

      if (res.status === 401 && attempt === 0) {
        token = null; // expired early; get a new one once
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(Math.min(30_000, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * (attempt + 1)));
        continue;
      }
      if (res.status === 204) return null;
      const text = await res.text();
      if (!res.ok) {
        throw new EonError(`E.ON answered HTTP ${res.status} on ${pathAndQuery}${text ? `: ${text.slice(0, 300)}` : ''}`, {
          code: res.status === 401 || res.status === 403 ? 'UNAUTHORIZED' : res.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
          httpStatus: res.status,
          url,
        });
      }
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        throw new EonError(`E.ON returned something that is not JSON from ${pathAndQuery}`, { code: 'BAD_RESPONSE', url });
      }
    }
  }

  return {
    isDemo: false,
    async getInstallations() {
      return (await get('/api/installations', 'installations'))?.installations || [];
    },
    async getMeasurementSeries() {
      return (await get('/api/installations/measurement-series', 'measurement-series'))?.installations || [];
    },
    // from / to: Swedish local wall time strings, "YYYY-MM-DDTHH:mm:ss".
    async getMeasurements(seriesId, resolution, { from, to, includeMissing = false } = {}) {
      const query = new URLSearchParams();
      if (from) query.set('from', from);
      if (to) query.set('to', to);
      if (includeMissing) query.set('includeMissing', 'true');
      const qs = query.toString();
      const body = await get(`/api/measurements/${encodeURIComponent(seriesId)}/resolution/${resolution}${qs ? `?${qs}` : ''}`, `measurements ${resolution}`);
      return body?.measurements || [];
    },
    requests: () => requests.slice(-40),
  };
}
