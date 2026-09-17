// Builds one self-contained snapshot of everything the dashboard shows, so the
// UI can run from a static JSON file (GitHub Pages) with no server and no token.
import { normalizeLocation, normalizeSession, normalizeCdr } from './normalize.js';
import { computeLive } from './live.js';

// Long enough for the "This year" range to be complete all year round.
export const DEFAULT_CDR_DAYS = 400;

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

export async function buildSnapshot({
  client,
  now = new Date(),
  cdrDays = DEFAULT_CDR_DAYS,
  generator = 'local',
  keepPersonalFields = false,
}) {
  const discovery = await client.discover();

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const sessionsFrom = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const cdrsFrom = new Date(startOfDay.getTime() - cdrDays * 86_400_000).toISOString();

  const [locationsPage, sessionsPage, cdrsPage] = await Promise.all([
    client.getAll('locations'),
    client.getAll('sessions', { date_from: sessionsFrom }),
    client.getAll('cdrs', { date_from: cdrsFrom }),
  ]);

  const locations = locationsPage.items.map(normalizeLocation);
  const sessions = sessionsPage.items.map(normalizeSession);
  const cdrs = cdrsPage.items
    .map(normalizeCdr)
    .sort((a, b) => Date.parse(b.start || 0) - Date.parse(a.start || 0));

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
    discovery: {
      version: discovery.version,
      versionUrl: discovery.versionUrl,
      availableVersions: discovery.availableVersions,
      endpoints: discovery.endpoints,
      encoding: discovery.encoding,
      attempts: discovery.attempts,
      discoveredAt: discovery.discoveredAt,
    },
    cdr_window: { from: cdrsFrom, to: now.toISOString(), days: cdrDays },
    counts: {
      locations: locations.length,
      evses: live.summary.evses_total,
      cdrs: cdrs.length,
      cdr_pages: cdrsPage.pages,
      sessions_24h: sessions.length,
    },
  };

  const snapshot = {
    status,
    locations,
    live,
    cdrs: { items: cdrs, pages: cdrsPage.pages, total: cdrsPage.total, date_from: cdrsFrom, date_to: null },
    sessions: { items: sessions, pages: sessionsPage.pages, total: sessionsPage.total, date_from: sessionsFrom, date_to: null },
  };
  return keepPersonalFields ? snapshot : stripPersonalFields(snapshot);
}
