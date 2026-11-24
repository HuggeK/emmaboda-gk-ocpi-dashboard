// A stand-in for E.ON's Energidata API with invented values, answering in the
// API's own format (Swedish local read-time stamps, ".01" on the repeated
// October hour) so demo mode runs the same parsing as the real thing.
// Consumption = a made-up club base load + the demo chargers' modelled load.
import { hourlyProfile, limitAt, isWinter } from '../public/analysis.js';
import { toWall, wallToUtc, parseEonTime } from './eon.js';

const HOUR_MS = 3_600_000;
const QUARTER_MS = 900_000;
const DAY_MS = 86_400_000;
const SERIES_ID = 900001;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Clubhouse, kitchen and heating: higher in winter (heating) and in the
// daytime, a lunch bump in the golf season.
function baseLoadKw(t, rand) {
  const d = new Date(t);
  const hour = d.getHours();
  const winter = isWinter(t);
  const night = winter ? 22 : 6;
  const day = winter ? 36 : 14;
  const open = hour >= 7 && hour < 21;
  const lunch = !winter && hour >= 11 && hour < 14 ? 9 : 0;
  return (open ? day : night) + lunch + rand() * 5;
}

// Wall-clock read time as E.ON writes it, with ".01" on the second 02:xx in October.
function eonStamp(readAt) {
  const wall = toWall(readAt);
  const [date, time] = wall.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const later = wallToUtc(y, mo, d, h, mi, 0, false) !== readAt;
  return later ? `${wall}.01` : wall;
}

export function createDemoEonClient({ records = [], now = Date.now(), historyDays = 420 } = {}) {
  const chargers = hourlyProfile(records, { model: 'front', rateKw: 11 });
  const startMs = Math.floor((now - historyDays * DAY_MS) / HOUR_MS) * HOUR_MS;
  const lastMs = Math.floor((now - 20 * HOUR_MS) / HOUR_MS) * HOUR_MS; // E.ON publishes about a day late
  const quarters = new Map(); // quarter start -> kWh
  const rand = mulberry32(20260917);
  for (let t = startMs; t < lastMs; t += HOUR_MS) {
    // Under a whole-facility ceiling the chargers only get what the base load leaves.
    const base = baseLoadKw(t, rand);
    const limit = limitAt(t);
    const charging = chargers.get(t)?.kw || 0;
    const hourKw = base + (limit?.kind === 'facility' ? Math.min(charging, Math.max(0, limit.kw - base)) : charging);
    // split the hour into four uneven quarters with the same total
    const weights = [0, 1, 2, 3].map(() => 0.8 + rand() * 0.4);
    const sum = weights.reduce((a, b) => a + b, 0);
    weights.forEach((w, i) => quarters.set(t + i * QUARTER_MS, (hourKw * w) / sum));
  }
  const requests = [];

  function between(from, to) {
    const fromMs = from ? parseEonTime(from) : -Infinity;
    const toMs = to ? parseEonTime(to) : Infinity;
    return { fromMs, toMs };
  }

  return {
    isDemo: true,
    async getInstallations() {
      return [{
        id: '735999000000000001',
        active: true,
        address: 'Golf Course Road 1, 361 93 Emmaboda',
        business: 'Demo Golf Club',
        category: 'Electricity',
        city: 'Emmaboda',
        energyClass: 'Electricity',
        gridArea: 'DMO',
        name: 'Demo clubhouse',
        orgNumber: '000000-0000',
        priceArea: 'SE4',
        resolution: 'Quarterly',
        safetyLevel: 125,
        hasMeasurementsSubscription: true,
        hasCostsSubscription: false,
      }];
    },
    async getMeasurementSeries() {
      return [{
        id: '735999000000000001',
        measurementSeries: [
          { id: SERIES_ID, seriesType: 'Consumption', unit: 'kWh', lastUpdate: toWall(lastMs) },
          { id: SERIES_ID + 1, seriesType: 'Reactive consumption', unit: 'kVArh', lastUpdate: toWall(lastMs) },
        ],
      }];
    },
    async getMeasurements(seriesId, resolution, { from, to } = {}) {
      requests.push({ step: `measurements ${resolution}`, url: `demo://measurements/${seriesId}/${resolution}?from=${from}&to=${to}`, httpStatus: 200 });
      if (Number(seriesId) !== SERIES_ID) return [];
      const { fromMs, toMs } = between(from, to);
      const stepMs = resolution === 'quarter' ? QUARTER_MS : HOUR_MS;
      const out = [];
      for (let t = startMs; t < lastMs; t += stepMs) {
        const readAt = t + stepMs;
        if (readAt <= fromMs || readAt > toMs) continue;
        let kwh = 0;
        for (let q = t; q < t + stepMs; q += QUARTER_MS) kwh += quarters.get(q) || 0;
        out.push({ timeStamp: eonStamp(readAt), value: Math.round(kwh * 1000) / 1000 });
      }
      return out;
    },
    requests: () => requests.slice(-40),
  };
}
