// Glare from roof-mounted panels: when, where and how far into people's field
// of view would the sun's reflection in the panels reach their eyes?
//
//   node tools/roof-solar/glare.mjs --observers <points.geojson>
//        [--panels kansli:W,studio:S] [--roofs public/data/solar-roofs.json]
//        [--look-at E,N] [--eye-m 1.6] [--year 2026] [--step-min 5]
//        [--spread-deg 0.5] [--sun-mask-deg 15] [--out glare.json]
//
// --observers: GeoJSON points in SWEREF 99 TM (EPSG:3006), one per eye
//   position; e.g. from walkzone.mjs (where golfers walk on a hole), or any
//   hand-made set (a terrace, a road, a window). A point's `looks` ([[E, N], ...],
//   e.g. the pin, the line of play ahead and the walking direction; the one
//   nearest the glare counts) or look_e/look_n say where that person looks; --look-at sets one
//   target for all; with neither, every direction counts as "in view".
//   Other properties are passed through to the output.
// --panels: building key and roof faces (N, NE, E, SE, S, SW, W, NW, flat)
//   from solar-roofs.json, comma-separated: the panels as laid out there.
//   --panels none: only the --array ones.
// --array name:E,N,height,tilt,azimuth,length,depth  (repeatable) a planned
//   array on a roof without laser data: one flat rectangle centred at E,N
//   (SWEREF 99 TM), its centre height above ground (m), tilt and azimuth (°),
//   length along the ridge and depth up the slope (m).
// --high 06-01:08-31, --season 03-01:10-25, --weights 3,1,0: the high season,
//   the playing season and how much a minute of glare in view counts in each
//   (high season, rest of the season, off-season) for the weighted score.
//
// Method (a simplified form of the usual glare-hazard analysis, as in
// Sandia's SGHAT / ForgeSolar):
// - each panel is a flat quad at the measured roof height plus the rails,
//   with its roof face's tilt and azimuth;
// - every step through the year with the sun up and in front of a panel, the
//   sun's direction is mirrored in the panel's normal (r = 2(n·s)n − s);
// - an eye sees glare when the ray from the eye back along −r hits a panel,
//   widened by --spread-deg (the sun's disc, ±0.27°, plus panel unevenness);
// - each hit is classified by the angle between the glare and the person's
//   view (eye towards the target at eye height):
//     central ≤ 10°  (straight in the eyes while looking at the target)
//     near    ≤ 25°  (clearly in the field of view)
//     side    ≤ 50°  (peripheral: noticed, rarely disabling)
//     outside > 50°  (behind or to the side: only when turning round)
//   and flagged when it lies within --sun-mask-deg of the sun itself (then the
//   sun dazzles anyway, and the reflection adds little).
// Ground is flat (laser heights are above the local ground), and trees and
// buildings between the panels and the eye are ignored: a worst case.
// Glare intensity (retinal irradiance) is not modelled: a hit means "the
// reflection reaches the eye", which for glass panels is a bright, brief flash.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const arg = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
if (!args.includes('--observers')) throw new Error('usage: glare.mjs --observers <points.geojson> [--panels kansli:W] [options]');
const obsFile = JSON.parse(fs.readFileSync(arg('--observers'), 'utf8'));
const roofs = JSON.parse(fs.readFileSync(arg('--roofs', path.join(ROOT, 'public/data/solar-roofs.json')), 'utf8'));
const panelSpec = arg('--panels', 'kansli:W');
const lookAt = arg('--look-at')?.split(',').map(Number);
const year = Number(arg('--year', '2026'));
const stepMin = Number(arg('--step-min', '5'));
const spreadDeg = Number(arg('--spread-deg', '0.5'));
const sunMaskDeg = Number(arg('--sun-mask-deg', '15'));
const eye = Number(arg('--eye-m', '1.6'));
const outPath = arg('--out');
const mmdd = (s) => s.split(':').map((x) => Number(x.replace('-', '')));
const HIGH = mmdd(arg('--high', '06-01:08-31'));
const SEASON = mmdd(arg('--season', '03-01:10-25'));
const WEIGHTS = arg('--weights', '3,1,0').split(',').map(Number);
const PERIODS = ['high', 'season', 'off'];
const periodOf = (month, day) => {
  const md = month * 100 + day;
  if (md >= HIGH[0] && md <= HIGH[1]) return 0;
  if (md >= SEASON[0] && md <= SEASON[1]) return 1;
  return 2;
};
const arrays = args.flatMap((a, i) => (a === '--array' ? [args[i + 1]] : []));

export const CLASSES = [
  { key: 'central', maxDeg: 10, label: 'straight in the eyes' },
  { key: 'near', maxDeg: 25, label: 'in the field of view' },
  { key: 'side', maxDeg: 50, label: 'peripheral' },
  { key: 'outside', maxDeg: 180, label: 'outside the view' },
];
const RAD = Math.PI / 180;
const LAT = 56.53;
const LON = 15.58;
const RAIL = 0.15 + 0.04; // panel surface above the roof (as in the 3D model)

// ---- the sun (NOAA approximation, as in simulate.mjs) ----------------------
function sun(t) {
  const d = new Date(t);
  const doy = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5;
  const hr = d.getUTCHours() + d.getUTCMinutes() / 60;
  const g = (2 * Math.PI / 365) * (doy - 1 + (hr - 12) / 24);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = ((hr * 60 + eqt + 4 * LON) / 4 - 180) * RAD;
  const la = LAT * RAD;
  const sinEl = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha);
  const el = Math.asin(sinEl);
  const cosAz = (Math.sin(decl) - Math.sin(la) * sinEl) / (Math.cos(la) * Math.cos(el));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz)));
  if (ha > 0) az = 2 * Math.PI - az;
  return { el: el / RAD, v: [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)] }; // east, north, up
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a) => mul(a, 1 / Math.hypot(...a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const angleDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b)))) / RAD;

// ---- the panels, in SWEREF 99 TM metres (east, north, height) ---------------
const faces = []; // { building, dir, n, c, radius, panels: [{ c0, u, v, flat }] }
const compass = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((az % 360) + 360) % 360) / 45) % 8];
function addFace(building, dir, tilt, azimuth, polys) {
  const n = [Math.sin(azimuth * RAD) * Math.sin(tilt * RAD), Math.cos(azimuth * RAD) * Math.sin(tilt * RAD), Math.cos(tilt * RAD)];
  const panels = polys.map((corners) => {
    const c0 = mul(corners.reduce(add, [0, 0, 0]), 1 / corners.length);
    const u = norm(sub(corners[1], corners[0]));
    const v = norm(cross(n, u));
    const flat = corners.map((p) => [dot(sub(p, c0), u), dot(sub(p, c0), v)]);
    const s = flat.reduce((acc, p, i) => { const q = flat[(i + 1) % flat.length]; return acc + p[0] * q[1] - q[0] * p[1]; }, 0);
    return { c0, u, v, flat, sign: Math.sign(s) || 1, corners };
  });
  const all = panels.flatMap((p) => p.corners);
  const c = mul(all.reduce(add, [0, 0, 0]), 1 / all.length);
  faces.push({ building, dir, tilt, azimuth, n, c, radius: Math.max(...all.map((p) => Math.hypot(...sub(p, c)))), panels });
}
for (const spec of arrays) {
  const [name, nums] = spec.split(':');
  const [e, nn, h, tilt, az, len, depth] = nums.split(',').map(Number);
  const along = [Math.cos(az * RAD), -Math.sin(az * RAD), 0]; // horizontal, along the ridge
  const up = [-Math.sin(az * RAD) * Math.cos(tilt * RAD), -Math.cos(az * RAD) * Math.cos(tilt * RAD), Math.sin(tilt * RAD)]; // up the slope
  const C = [e, nn, h];
  const corner = (a, b) => add(C, add(mul(along, (a * len) / 2), mul(up, (b * depth) / 2)));
  addFace(name, compass(az), tilt, az, [[corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]]);
}
for (const spec of panelSpec === 'none' ? [] : panelSpec.split(',')) {
  const [key, dirs = ''] = spec.split(':');
  const b = roofs.buildings.find((x) => x.key === key);
  if (!b) throw new Error(`no building ${key} in solar-roofs.json`);
  const bytes = Buffer.from(b.heights_dm, 'base64');
  const hAt = (r, c) => (r >= 0 && r < b.height && c >= 0 && c < b.width ? bytes.readInt16LE((r * b.width + c) * 2) / 10 : 0);
  const roofHeight = (cx, cy) => { // the mean of the roof cells around a point (cell units)
    let s = 0;
    let n = 0;
    for (let r = Math.floor(cy - 1); r <= Math.floor(cy); r += 1) {
      for (let c = Math.floor(cx - 1); c <= Math.floor(cx); c += 1) { const v = hAt(r, c); if (v > 0) { s += v; n += 1; } }
    }
    return n ? s / n : 0;
  };
  const wanted = dirs ? dirs.split('+').concat(dirs.split('|')) : null;
  for (const f of b.faces.filter((x) => x.panels > 0 && (!wanted || wanted.includes(x.flat ? 'flat' : x.direction)))) {
    addFace(key, f.flat ? 'flat' : f.direction, f.panel_tilt, f.azimuth,
      f.panel_polygons.map((poly) => poly.map(([cx, cy]) => [b.origin[0] + cx * b.px, b.origin[1] - cy * b.px, roofHeight(cx, cy) + RAIL])));
  }
}
if (!faces.length) throw new Error(`no panels for ${panelSpec}`);

// Point in a convex polygon (2D, panel plane), with a margin.
function inside(p, [x, y], margin) {
  const q = p.flat;
  for (let i = 0; i < q.length; i += 1) {
    const [x1, y1] = q[i];
    const [x2, y2] = q[(i + 1) % q.length];
    const d = ((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) / Math.hypot(x2 - x1, y2 - y1);
    if (d * p.sign < -margin) return false;
  }
  return true;
}

// ---- the observers -------------------------------------------------------------
const observers = obsFile.features.filter((f) => f.geometry?.type === 'Point').map((f) => {
  const [e, n] = f.geometry.coordinates;
  const { look_e: le, look_n: ln, looks, ...props } = f.properties || {};
  // Where the person looks: --look-at, else the point's looks (several: the
  // nearest one to the glare counts), else look_e/look_n. Level views.
  const targets = lookAt ? [lookAt] : looks?.length ? looks : le != null && ln != null ? [[le, ln]] : [];
  const views = targets.filter(([te, tn]) => Math.hypot(te - e, tn - n) > 1).map(([te, tn]) => norm([te - e, tn - n, 0]));
  return { e, n, O: [e, n, eye], views, props, min: [0, 0, 0, 0], period: [0, 0, 0], masked: 0, days: new Set(), highDays: new Set(), first: null, last: null };
});
const tan = Math.tan(spreadDeg * RAD);

// ---- the year ------------------------------------------------------------------
const swedish = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Stockholm', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' });
const parts = (t) => Object.fromEntries(swedish.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
const byMonthHour = Array.from({ length: 12 }, () => new Array(24).fill(0)); // minutes with glare in view (≤ 25°) at any observer
let minutesAny = 0;
let minutesInView = 0;
const minutesByPeriod = [0, 0, 0]; // minutes with glare in someone's view, per period
for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += stepMin * 60_000) {
  const s = sun(t);
  if (s.el <= 0) continue;
  const rays = faces.map((f) => { const ns = dot(f.n, s.v); return ns > 0 ? sub(mul(f.n, 2 * ns), s.v) : null; });
  if (rays.every((r) => !r || r[2] > 0.5)) continue; // sun behind every face, or reflected steeply up
  let any = false;
  let inView = false;
  const p = parts(t);
  const period = periodOf(Number(p.month), Number(p.day));
  for (const o of observers) {
    let hit = null;
    faces.forEach((f, fi) => {
      const r = rays[fi];
      if (hit || !r) return;
      // Quick test: does the line from the eye back along −r pass near the face at all?
      const w = sub(f.c, o.O);
      const along = -dot(w, r); // distance from the eye to the face along −r
      if (along <= 0) return; // the face is not back along the ray
      if (Math.hypot(...cross(w, r)) > f.radius + along * tan + 0.5) return;
      for (const p of f.panels) {
        const nr = dot(f.n, r);
        if (nr <= 0) continue;
        const tHit = dot(f.n, sub(o.O, p.c0)) / nr; // P = O − t·r lies on the panel's plane
        if (tHit <= 0) continue;
        const P = sub(o.O, mul(r, tHit));
        if (inside(p, [dot(sub(P, p.c0), p.u), dot(sub(P, p.c0), p.v)], tHit * tan)) { hit = mul(r, -1); return; }
      }
    });
    if (!hit) continue;
    const a = o.views.length ? Math.min(...o.views.map((v) => angleDeg(hit, v))) : 0;
    const cls = CLASSES.findIndex((c) => a <= c.maxDeg);
    o.min[cls] += stepMin;
    if (angleDeg(hit, s.v) <= sunMaskDeg) o.masked += stepMin;
    any = true;
    if (cls <= 1) {
      inView = true;
      o.period[period] += stepMin;
      o.days.add(`${p.month}-${p.day}`);
      if (period === 0) o.highDays.add(`${p.month}-${p.day}`);
      o.first ??= t;
      o.last = t;
    }
  }
  if (any) minutesAny += stepMin;
  if (inView) {
    minutesInView += stepMin;
    minutesByPeriod[period] += stepMin;
    byMonthHour[Number(p.month) - 1][Number(p.hour)] += stepMin;
  }
}
const score = (o) => o.period.reduce((s, m, i) => s + m * WEIGHTS[i], 0);

// ---- report --------------------------------------------------------------------
const inViewMin = (o) => o.min[0] + o.min[1];
const hit = observers.filter((o) => o.min.some((m) => m > 0));
const fmt = (t) => new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Stockholm', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
console.log(`${observers.length} observers; ${faces.reduce((s, f) => s + f.panels.length, 0)} panels: ${faces.map((f) => `${f.building} ${f.dir} (${f.panels.length}, tilt ${f.tilt}°, az ${Math.round(f.azimuth)}°)`).join(', ')}`);
console.log(`${year}, every ${stepMin} min: glare reaches some observer in ${(minutesAny / 60).toFixed(1)} h, in someone's field of view (≤ 25°) in ${(minutesInView / 60).toFixed(1)} h`);
console.log(`observers that ever see it: ${hit.length}; in the field of view: ${observers.filter((o) => inViewMin(o) > 0).length}; straight in the eyes (≤ 10°): ${observers.filter((o) => o.min[0] > 0).length}`);
console.log(`hours with glare in someone's view: high season ${(minutesByPeriod[0] / 60).toFixed(1)}, rest of the season ${(minutesByPeriod[1] / 60).toFixed(1)}, off-season ${(minutesByPeriod[2] / 60).toFixed(1)} (weights ${WEIGHTS.join('/')})`);
for (const o of [...observers].sort((a, b) => score(b) - score(a) || inViewMin(b) - inViewMin(a)).slice(0, 5).filter((o) => inViewMin(o) > 0)) {
  console.log(`  E ${Math.round(o.e)} N ${Math.round(o.n)} ${JSON.stringify(o.props)}: ${o.min.join('/')} min (central/near/side/outside); in view ${o.period.join('/')} min (high/season/off), ${o.days.size} days (${o.highDays.size} in high season), ${fmt(o.first)} – ${fmt(o.last)}`);
}
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify({
    generated_by: 'tools/roof-solar/glare.mjs',
    settings: { year, step_min: stepMin, spread_deg: spreadDeg, sun_mask_deg: sunMaskDeg, eye_m: eye, panels: panelSpec, arrays, look_at: lookAt || 'per observer', high: arg('--high', '06-01:08-31'), season: arg('--season', '03-01:10-25'), weights: WEIGHTS },
    periods: PERIODS,
    minutes_in_view_by_period: minutesByPeriod,
    note: 'Flat ground; trees and buildings between the panels and the eye ignored (worst case). Intensity not modelled.',
    attribution: obsFile.attribution || null,
    classes: CLASSES,
    faces: faces.map((f) => ({ building: f.building, dir: f.dir, tilt: f.tilt, azimuth: f.azimuth, panels: f.panels.length, centre: f.c.map((x) => Math.round(x * 10) / 10) })),
    minutes_any: minutesAny,
    minutes_in_view: minutesInView,
    by_month_hour_in_view: byMonthHour,
    // e, n; minutes per class [central, near, side, outside]; minutes in view (≤ 25°) per period [high, season, off];
    // the weighted score; minutes beside the sun; days in view; of them in the high season; first/last in view (ms)
    observer_fields: ['e', 'n', 'min', 'in_view', 'score', 'masked', 'days', 'high_days', 'first', 'last', 'props'],
    observers: observers.map((o) => [Math.round(o.e * 10) / 10, Math.round(o.n * 10) / 10, o.min, o.period, score(o), o.masked, o.days.size, o.highDays.size, o.first, o.last, o.props]),
  }));
  console.log(`wrote ${outPath}`);
}
