// Deterministic demo data shaped like OCPI 2.2.1 payloads, so the whole UI
// can be exercised without a working ChargeNode token.
// All values here are invented.

const LOCATION_ID = 'LOC-DEMO-GOLF-CLUB';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function round(n, decimals = 3) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

const EVSE_SPECS = [
  { uid: 'EVSE-01', evse_id: 'SE*DMO*E001', ref: 'P1', kw: 22, amps: 32 },
  { uid: 'EVSE-02', evse_id: 'SE*DMO*E002', ref: 'P2', kw: 22, amps: 32 },
  { uid: 'EVSE-03', evse_id: 'SE*DMO*E003', ref: 'P3', kw: 22, amps: 32 },
  { uid: 'EVSE-04', evse_id: 'SE*DMO*E004', ref: 'P4', kw: 22, amps: 32 },
  { uid: 'EVSE-05', evse_id: 'SE*DMO*E005', ref: 'P5', kw: 11, amps: 16 },
  { uid: 'EVSE-06', evse_id: 'SE*DMO*E006', ref: 'P6', kw: 11, amps: 16 },
];

// Active demo sessions: fixed EVSEs, different power-reporting styles.
const ACTIVE_SPECS = [
  { uid: 'EVSE-02', startedMinutesAgo: 47, powerKw: 21.3, reportPower: true },
  { uid: 'EVSE-05', startedMinutesAgo: 112, powerKw: 10.7, reportPower: true },
  { uid: 'EVSE-06', startedMinutesAgo: 23, powerKw: 9.8, reportPower: false }, // ENERGY only -> derived
];
const OUT_OF_ORDER = new Set(['EVSE-04']);

const PRICE_PER_KWH_EXCL_VAT = 3.5;
const VAT_RATE = 0.25;
const CURRENCY = 'SEK';

function buildLocation(now) {
  const activeByUid = new Map(ACTIVE_SPECS.map((a) => [a.uid, a]));
  return {
    country_code: 'SE',
    party_id: 'DMO',
    id: LOCATION_ID,
    publish: true,
    name: 'Demo Golf Club',
    address: 'Golf Course Road 1',
    city: 'Emmaboda',
    postal_code: '361 93',
    country: 'SWE',
    coordinates: { latitude: '56.6260', longitude: '15.5350' },
    time_zone: 'Europe/Stockholm',
    operator: { name: 'Demo CPO' },
    evses: EVSE_SPECS.map((spec) => {
      let status = 'AVAILABLE';
      if (OUT_OF_ORDER.has(spec.uid)) status = 'OUTOFORDER';
      else if (activeByUid.has(spec.uid)) status = 'CHARGING';
      return {
        uid: spec.uid,
        evse_id: spec.evse_id,
        status,
        capabilities: ['RFID_READER', 'REMOTE_START_STOP_CAPABLE'],
        physical_reference: spec.ref,
        connectors: [
          {
            id: '1',
            standard: 'IEC_62196_T2',
            format: 'SOCKET',
            power_type: 'AC_3_PHASE',
            max_voltage: 230,
            max_amperage: spec.amps,
            max_electric_power: spec.kw * 1000,
            tariff_ids: ['TARIFF-STANDARD'],
            last_updated: iso(now - 30 * DAY_MS),
          },
        ],
        last_updated: iso(now - 5 * 60_000),
      };
    }),
    last_updated: iso(now - 5 * 60_000),
  };
}

function buildTariff(now) {
  return {
    country_code: 'SE',
    party_id: 'DMO',
    id: 'TARIFF-STANDARD',
    currency: CURRENCY,
    type: 'REGULAR',
    tariff_alt_text: [{ language: 'en', text: `${PRICE_PER_KWH_EXCL_VAT} ${CURRENCY}/kWh excl. VAT` }],
    elements: [
      { price_components: [{ type: 'ENERGY', price: PRICE_PER_KWH_EXCL_VAT, vat: VAT_RATE * 100, step_size: 1 }] },
    ],
    last_updated: iso(now - 200 * DAY_MS),
  };
}

// Generates completed charge sessions for the last `days` days.
function buildHistory(now, days) {
  const rand = mulberry32(20240901);
  const specByUid = new Map(EVSE_SPECS.map((s) => [s.uid, s]));
  const cdrs = [];
  const sessions = [];
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  let sequence = 1;

  for (let dayOffset = days; dayOffset >= 0; dayOffset -= 1) {
    const day = new Date(startOfToday.getTime() - dayOffset * DAY_MS);
    const weekday = day.getDay();
    const month = day.getMonth();
    const seasonFactor = month >= 4 && month <= 8 ? 1.4 : 0.7; // busier in golf season
    const weekendFactor = weekday === 0 || weekday === 6 ? 1.5 : 1;
    const expected = 1.6 * seasonFactor * weekendFactor;
    const count = Math.max(0, Math.round(expected + (rand() - 0.5) * 3));

    for (let i = 0; i < count; i += 1) {
      const spec = EVSE_SPECS[Math.floor(rand() * EVSE_SPECS.length)];
      const startHour = 7 + rand() * 12;
      const start = day.getTime() + startHour * HOUR_MS;
      const durationH = 0.5 + rand() * 4.5;
      const end = start + durationH * HOUR_MS;
      if (end > now - 10 * 60_000) continue; // still running -> not a CDR yet
      const utilisation = 0.55 + rand() * 0.4;
      const energy = round(Math.min(durationH * spec.kw * utilisation, 72), 3);
      const costExcl = round(energy * PRICE_PER_KWH_EXCL_VAT, 2);
      const costIncl = round(costExcl * (1 + VAT_RATE), 2);
      const authMethod = rand() < 0.6 ? 'AUTH_REQUEST' : rand() < 0.5 ? 'WHITELIST' : 'COMMAND';
      const tokenType = authMethod === 'COMMAND' ? 'APP_USER' : 'RFID';
      const tokenUid = `DEMO${String(1000 + Math.floor(rand() * 40)).padStart(6, '0')}`;
      const id = `CDR-${String(sequence).padStart(5, '0')}`;
      const sessionId = `SESSION-${String(sequence).padStart(5, '0')}`;
      sequence += 1;

      const chargingPeriods = [
        {
          start_date_time: iso(start),
          dimensions: [
            { type: 'ENERGY', volume: energy },
            { type: 'TIME', volume: round(durationH, 3) },
          ],
          tariff_id: 'TARIFF-STANDARD',
        },
      ];

      cdrs.push({
        country_code: 'SE',
        party_id: 'DMO',
        id,
        start_date_time: iso(start),
        end_date_time: iso(end),
        session_id: sessionId,
        cdr_token: { country_code: 'SE', party_id: 'DMO', uid: tokenUid, type: tokenType, contract_id: `SE-DMO-C${tokenUid.slice(-4)}` },
        auth_method: authMethod,
        cdr_location: {
          id: LOCATION_ID,
          name: 'Demo Golf Club',
          address: 'Golf Course Road 1',
          city: 'Emmaboda',
          postal_code: '361 93',
          country: 'SWE',
          coordinates: { latitude: '56.6260', longitude: '15.5350' },
          evse_uid: spec.uid,
          evse_id: spec.evse_id,
          connector_id: '1',
          connector_standard: 'IEC_62196_T2',
          connector_format: 'SOCKET',
          connector_power_type: 'AC_3_PHASE',
        },
        currency: CURRENCY,
        tariffs: [buildTariff(now)],
        charging_periods: chargingPeriods,
        total_cost: { excl_vat: costExcl, incl_vat: costIncl },
        total_energy: energy,
        total_energy_cost: { excl_vat: costExcl, incl_vat: costIncl },
        total_time: round(durationH, 3),
        total_parking_time: 0,
        last_updated: iso(end + 60_000),
      });

      sessions.push({
        country_code: 'SE',
        party_id: 'DMO',
        id: sessionId,
        start_date_time: iso(start),
        end_date_time: iso(end),
        kwh: energy,
        cdr_token: { country_code: 'SE', party_id: 'DMO', uid: tokenUid, type: tokenType, contract_id: `SE-DMO-C${tokenUid.slice(-4)}` },
        auth_method: authMethod,
        location_id: LOCATION_ID,
        evse_uid: spec.uid,
        connector_id: '1',
        currency: CURRENCY,
        charging_periods: chargingPeriods,
        total_cost: { excl_vat: costExcl, incl_vat: costIncl },
        status: 'COMPLETED',
        last_updated: iso(end + 60_000),
      });
    }
  }
  return { cdrs, sessions, specByUid };
}

function buildActiveSessions(now) {
  const specByUid = new Map(EVSE_SPECS.map((s) => [s.uid, s]));
  return ACTIVE_SPECS.map((active, index) => {
    const spec = specByUid.get(active.uid);
    const start = now - active.startedMinutesAgo * 60_000;
    const hours = active.startedMinutesAgo / 60;
    const energy = round(active.powerKw * hours, 3);
    const lastUpdated = now - 2 * 60_000;
    const periodStart = now - 15 * 60_000; // latest 15-minute period
    const periodHours = (lastUpdated - periodStart) / HOUR_MS;
    const dimensions = [{ type: 'ENERGY', volume: round(active.powerKw * periodHours, 3) }];
    if (active.reportPower) dimensions.push({ type: 'POWER', volume: active.powerKw });
    const costExcl = round(energy * PRICE_PER_KWH_EXCL_VAT, 2);
    return {
      country_code: 'SE',
      party_id: 'DMO',
      id: `SESSION-ACTIVE-${index + 1}`,
      start_date_time: iso(start),
      kwh: energy,
      cdr_token: { country_code: 'SE', party_id: 'DMO', uid: `DEMO00${1050 + index}`, type: 'RFID', contract_id: `SE-DMO-C${1050 + index}` },
      auth_method: 'AUTH_REQUEST',
      location_id: LOCATION_ID,
      evse_uid: spec.uid,
      connector_id: '1',
      currency: CURRENCY,
      charging_periods: [
        { start_date_time: iso(start), dimensions: [{ type: 'ENERGY', volume: round(energy - dimensions[0].volume, 3) }], tariff_id: 'TARIFF-STANDARD' },
        { start_date_time: iso(periodStart), dimensions, tariff_id: 'TARIFF-STANDARD' },
      ],
      total_cost: { excl_vat: costExcl, incl_vat: round(costExcl * (1 + VAT_RATE), 2) },
      status: 'ACTIVE',
      last_updated: iso(lastUpdated),
    };
  });
}

function inRange(item, params) {
  const updated = Date.parse(item.last_updated);
  if (params.date_from && updated < Date.parse(params.date_from)) return false;
  if (params.date_to && updated >= Date.parse(params.date_to)) return false;
  return true;
}

export function createDemoClient({ historyDays = 180 } = {}) {
  const discovery = {
    ok: true,
    version: '2.2.1',
    versionUrl: 'demo://ocpi/cpo/2.2.1',
    availableVersions: ['2.2.1'],
    endpoints: {
      credentials: 'demo://ocpi/cpo/2.2.1/credentials',
      locations: 'demo://ocpi/cpo/2.2.1/locations',
      sessions: 'demo://ocpi/cpo/2.2.1/sessions',
      cdrs: 'demo://ocpi/cpo/2.2.1/cdrs',
      tariffs: 'demo://ocpi/cpo/2.2.1/tariffs',
    },
    encoding: 'plain',
    attempts: [],
    discoveredAt: new Date().toISOString(),
  };

  let cache = null;
  function data() {
    const now = Date.now();
    if (cache && now - cache.builtAt < 60_000) return cache;
    const history = buildHistory(now, historyDays);
    cache = {
      builtAt: now,
      locations: [buildLocation(now)],
      tariffs: [buildTariff(now)],
      cdrs: history.cdrs,
      sessions: [...history.sessions, ...buildActiveSessions(now)],
    };
    return cache;
  }

  return {
    isDemo: true,
    async discover() {
      return discovery;
    },
    async getAll(identifier, params = {}) {
      const d = data();
      const items = (d[identifier] || []).filter((item) => inRange(item, params));
      if (!d[identifier]) throw new Error(`Module "${identifier}" is not available in demo mode`);
      return { items, pages: 1, total: items.length };
    },
    status() {
      return {
        mode: 'demo',
        versionsUrl: 'demo://ocpi/cpo/versions',
        tokenPreview: '(demo mode - no token used)',
        tokenEncoding: 'n/a',
        discovery,
        lastError: null,
      };
    },
  };
}
