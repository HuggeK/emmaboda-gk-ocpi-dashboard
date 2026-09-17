// Builds one self-contained snapshot of everything the dashboard shows, so the
// UI can run from a static JSON file (GitHub Pages) with no server and no token.
import { normalizeLocation, normalizeSession, normalizeCdr } from './normalize.js';
import { computeLive } from './live.js';

// Fields that identify the person who charged (RFID / app token). They are
// dropped from published snapshots because the GitHub Pages site is public.
const PERSONAL_FIELDS = new Set(['token_uid', 'contract_id']);

export function stripPersonalFields(value) {
  if (Array.isArray(value)) return value.map(stripPersonalFields);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (!PERSONAL_FIELDS.has(key)) out[key] = stripPersonalFields(item);
    }
    return out;
  }
  return value;
}

function pickDiscovery(discovery) {
  return {
    version: discovery.version,
    versionUrl: discovery.versionUrl,
    availableVersions: discovery.availableVersions,
    endpoints: discovery.endpoints,
    encoding: discovery.encoding,
    attempts: discovery.attempts,
    discoveredAt: discovery.discoveredAt,
  };
}

const EMPTY_PAGE = { items: [], pages: 0, total: 0, date_from: null, date_to: null };

// A snapshot with the connection facts but no data, for when ChargeNode accepts
// the key on the versions endpoint but refuses the data modules (an OCPI
// registration token, "token A"). The site is still published so the
// Connection tab can say what happened and the static OCPI files stay online.
export function buildEmptySnapshot({
  client,
  discovery,
  dataError,
  now = new Date(),
  generator = 'local',
}) {
  const live = computeLive({ locations: [], sessions: [], todayKwh: null, now });
  const status = {
    mode: 'snapshot',
    generator,
    generated_at: now.toISOString(),
    versionsUrl: client.status().versionsUrl,
    discovery: pickDiscovery(discovery),
    cdr_window: { from: null, to: now.toISOString(), days: 0, incremental: false, fetched: 0, fetched_from: null },
    counts: { locations: 0, evses: 0, cdrs: 0, cdr_pages: 0, cdr_fetched: 0, sessions_24h: 0 },
    data_error: dataError,
  };
  return { status, locations: [], live, cdrs: { ...EMPTY_PAGE }, sessions: { ...EMPTY_PAGE } };
}

// A previously built snapshot can be extended instead of refetching every
// charge record, but only if it came from the same source and holds data.
export function usableBase(base, client) {
  return Boolean(
    base
    && base.status?.mode === 'snapshot'
    && !base.status.data_error
    && base.status.generated_at
    && base.status.versionsUrl === client.status().versionsUrl
    && Array.isArray(base.cdrs?.items),
  );
}

export async function buildSnapshot({
  client,
  now = new Date(),
  generator = 'local',
  keepPersonalFields = false,
  base = null, // a previous snapshot to extend with the records changed since it was built
  overlapDays = 2, // refetch this far back before the base's build time, so late corrections are caught
  historyFrom = null, // ISO date to start from on a full fetch; null = everything the CPO has
}) {
  const discovery = await client.discover();

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const sessionsFrom = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const incremental = usableBase(base, client);
  const cdrsFrom = incremental
    ? new Date(Date.parse(base.status.generated_at) - overlapDays * 86_400_000).toISOString()
    : historyFrom;

  const [locationsPage, sessionsPage, cdrsPage] = await Promise.all([
    client.getAll('locations'),
    client.getAll('sessions', { date_from: sessionsFrom }),
    client.getAll('cdrs', cdrsFrom ? { date_from: cdrsFrom } : {}),
  ]);

  const locations = locationsPage.items.map(normalizeLocation);
  const sessions = sessionsPage.items.map(normalizeSession);
  const fetched = cdrsPage.items.map(normalizeCdr);
  // OCPI lists by last_updated, so a refetched record replaces the copy in the base.
  const merged = new Map((incremental ? base.cdrs.items : []).map((c) => [c.id, c]));
  for (const c of fetched) merged.set(c.id, c);
  const cdrs = [...merged.values()].sort((a, b) => Date.parse(b.start || 0) - Date.parse(a.start || 0));
  const earliest = cdrs.length ? cdrs[cdrs.length - 1].start : null;

  // "Energy delivered today": sessions that ended since midnight.
  const todayKwh = cdrs
    .filter((c) => Date.parse(c.end || c.start || 0) >= startOfDay.getTime())
    .reduce((sum, c) => sum + (c.energy_kwh || 0), 0);

  const live = computeLive({ locations, sessions, todayKwh, now });

  const status = {
    mode: 'snapshot',
    generator,
    generated_at: now.toISOString(),
    versionsUrl: client.status().versionsUrl,
    discovery: pickDiscovery(discovery),
    cdr_window: {
      from: earliest,
      to: now.toISOString(),
      days: earliest ? Math.ceil((now.getTime() - Date.parse(earliest)) / 86_400_000) : 0,
      incremental,
      fetched: fetched.length,
      fetched_from: cdrsFrom || null,
    },
    counts: {
      locations: locations.length,
      evses: live.summary.evses_total,
      cdrs: cdrs.length,
      cdr_pages: cdrsPage.pages,
      cdr_fetched: fetched.length,
      sessions_24h: sessions.length,
    },
    data_error: null,
  };

  const snapshot = {
    status,
    locations,
    live,
    cdrs: { items: cdrs, pages: cdrsPage.pages, total: cdrs.length, date_from: earliest, date_to: null },
    sessions: { items: sessions, pages: sessionsPage.pages, total: sessionsPage.total, date_from: sessionsFrom, date_to: null },
  };
  return keepPersonalFields ? snapshot : stripPersonalFields(snapshot);
}
