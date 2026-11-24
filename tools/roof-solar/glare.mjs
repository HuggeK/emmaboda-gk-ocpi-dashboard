// Glare from roof-mounted panels onto a golf hole: when and where would the
// sun's reflection in the panels reach golfers' eyes?
//
//   node tools/roof-solar/glare.mjs <golf.geojson> --hole-way <OSM way id>
//        [--roofs public/data/solar-roofs.json] [--building kansli] [--faces W]
//        [--year 2026] [--step-min 5] [--spread-deg 0.5] [--eye-m 1.6]
//        [--out glare.json]
//
// golf.geojson: golf features in SWEREF 99 TM (EPSG:3006), e.g. extracted from
// golfTiles (OpenStreetMap data, ODbL). The hole is picked by its OSM way id
// (golfTiles keeps ids but not the hole number); its tees, green and fairways
// are the golf=tee/green/fairway areas along the hole line.
//
// Method (a simplified form of the usual glare-hazard analysis):
// - each panel is a flat quad at the measured roof height plus the rails,
//   facing the roof face's tilt and azimuth;
// - every step through the year with the sun up and in front of the panels,
//   the sun's direction is mirrored in the panel normal (r = 2(n·s)n − s);
// - an observer (golfer's eye) sees glare when the ray from the eye back along
//   −r hits a panel, widened by spread-deg (the sun's disc, ±0.27°, plus panel
//   and mounting unevenness);
// - each hit also records the angle between the glare and the golfer's view
//   towards the green.
// Ground is taken as flat (laser heights are above the local ground), and
// trees and buildings between the panels and the hole are ignored: a worst case.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const arg = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const golfPath = args[0];
if (!golfPath || golfPath.startsWith('--')) throw new Error('usage: glare.mjs <golf.geojson> --hole-way <id> [options]');
const golf = JSON.parse(fs.readFileSync(golfPath, 'utf8'));
const roofs = JSON.parse(fs.readFileSync(arg('--roofs', path.join(ROOT, 'public/data/solar-roofs.json')), 'utf8'));
const holeWay = Number(arg('--hole-way'));
const buildingKey = arg('--building', 'kansli');
const faceDirs = arg('--faces', 'W').split(',');
const year = Number(arg('--year', '2026'));
const stepMin = Number(arg('--step-min', '5'));
const spread = (Number(arg('--spread-deg', '0.5')) * Math.PI) / 180;
const eye = Number(arg('--eye-m', '1.6'));
const outPath = arg('--out');

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
  // East, north, up.
  return { el: el / RAD, v: [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)] };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a) => mul(a, 1 / Math.hypot(...a));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// ---- the panels, in SWEREF 99 TM metres (east, north, height) ---------------
const b = roofs.buildings.find((x) => x.key === buildingKey);
if (!b) throw new Error(`no building ${buildingKey}`);
const W = b.width;
const H = b.height;
const bytes = Buffer.from(b.heights_dm, 'base64');
const hAt = (r, c) => (r >= 0 && r < H && c >= 0 && c < W ? bytes.readInt16LE((r * W + c) * 2) / 10 : 0);
// Roof height at a point in cell units: the mean of the nearby roof cells.
function roofHeight(cx, cy) {
  let s = 0;
  let n = 0;
  for (let r = Math.floor(cy - 1); r <= Math.floor(cy); r += 1) {
    for (let c = Math.floor(cx - 1); c <= Math.floor(cx); c += 1) {
      const v = hAt(r, c);
      if (v > 0) { s += v; n += 1; }
    }
  }
  return n ? s / n : 0;
}
const toWorld = ([cx, cy]) => [b.origin[0] + cx * b.px, b.origin[1] - cy * b.px];
const panels = [];
for (const f of b.faces.filter((x) => x.panels > 0 && faceDirs.includes(x.direction))) {
  const tilt = f.panel_tilt * RAD;
  const az = f.azimuth * RAD;
  const n = [Math.sin(az) * Math.sin(tilt), Math.cos(az) * Math.sin(tilt), Math.cos(tilt)];
  for (const poly of f.panel_polygons) {
    const corners = poly.map((p) => { const [e, nn] = toWorld(p); return [e, nn, roofHeight(p[0], p[1]) + RAIL]; });
    // Panel plane through the corners' mean, with the face's normal; in-plane axes for the 2D test.
    const c0 = mul(corners.reduce(add, [0, 0, 0]), 1 / 4);
    const u = norm(sub(corners[1], corners[0]));
    const v = norm(cross(n, u));
    const flat = corners.map((p) => [dot(sub(p, c0), u), dot(sub(p, c0), v)]);
    panels.push({ face: f.direction, n, c0, u, v, flat });
  }
}
if (!panels.length) throw new Error('no panels on those faces');
const faceNormal = panels[0].n;

// Point in a convex quad (2D), with a margin.
function inside(q, [x, y], margin) {
  for (let i = 0; i < 4; i += 1) {
    const [x1, y1] = q[i];
    const [x2, y2] = q[(i + 1) % 4];
    const ex = x2 - x1;
    const ey = y2 - y1;
    const len = Math.hypot(ex, ey);
    // Signed distance to the edge (positive inside for a counter-clockwise quad; take |orientation|).
    const d = ((x - x1) * ey - (y - y1) * ex) / len;
    q.sign ??= Math.sign(((q[2][0] - q[0][0]) * (q[1][1] - q[0][1]) - (q[2][1] - q[0][1]) * (q[1][0] - q[0][0])) || 1);
    if (d * q.sign < -margin) return false;
  }
  return true;
}

// ---- the hole and the observers --------------------------------------------
const holeLine = golf.features.find((f) => f.properties.mvt_id === holeWay && f.properties.golf === 'hole');
if (!holeLine) throw new Error(`no hole line with way id ${holeWay}`);
const line = holeLine.geometry.coordinates;
const distToLine = ([e, n]) => {
  let best = Infinity;
  for (let i = 1; i < line.length; i += 1) {
    const [a0, a1] = line[i - 1];
    const [b0, b1] = line[i];
    const l2 = (b0 - a0) ** 2 + (b1 - a1) ** 2;
    const t = Math.max(0, Math.min(1, ((e - a0) * (b0 - a0) + (n - a1) * (b1 - a1)) / l2));
    best = Math.min(best, Math.hypot(e - (a0 + t * (b0 - a0)), n - (a1 + t * (b1 - a1))));
  }
  return best;
};
const ringOf = (f) => (f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates[0][0] : null);
const centroid = (ring) => ring.reduce((s, p) => [s[0] + p[0] / ring.length, s[1] + p[1] / ring.length], [0, 0]);
const tee = line[0];
const pin = line.at(-1);
const areas = golf.features.filter((f) => ['tee', 'green', 'fairway'].includes(f.properties.golf) && ringOf(f));
const pick = (kind, test) => areas.filter((f) => f.properties.golf === kind && test(centroid(ringOf(f)), ringOf(f)));
const holeAreas = [
  ...pick('tee', (c) => Math.hypot(c[0] - tee[0], c[1] - tee[1]) < 45),
  ...pick('green', (c) => Math.hypot(c[0] - pin[0], c[1] - pin[1]) < 30),
  ...pick('fairway', (c, ring) => distToLine(c) < 35 && ring.some((p) => distToLine(p) < 25)),
];
function pointInRing([x, y], ring) {
  let ok = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ok = !ok;
  }
  return ok;
}
const observers = [];
const addObserver = (e, n, where) => observers.push({ e, n, where, minutes: 0, inView: 0, samples: [] });
for (const f of holeAreas) {
  const ring = ringOf(f);
  const step = f.properties.golf === 'fairway' ? 8 : 4;
  const es = ring.map((p) => p[0]);
  const ns = ring.map((p) => p[1]);
  for (let e = Math.min(...es); e <= Math.max(...es); e += step) {
    for (let n = Math.min(...ns); n <= Math.max(...ns); n += step) if (pointInRing([e, n], ring)) addObserver(e, n, f.properties.golf);
  }
}
for (let i = 1; i < line.length; i += 1) {
  const [a0, a1] = line[i - 1];
  const [b0, b1] = line[i];
  const len = Math.hypot(b0 - a0, b1 - a1);
  for (let s = 0; s < len; s += 5) addObserver(a0 + ((b0 - a0) * s) / len, a1 + ((b1 - a1) * s) / len, 'hole line');
}

// ---- the year ------------------------------------------------------------------
const pad = (x) => String(x).padStart(2, '0');
const swedish = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const byMonthHour = Array.from({ length: 12 }, () => new Array(24).fill(0));
const events = []; // [time, observer index, glare direction az°, el°]
let stepsWithGlare = 0;
for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += stepMin * 60_000) {
  const s = sun(t);
  if (s.el <= 0) continue;
  const ns = dot(faceNormal, s.v);
  if (ns <= 0) continue; // the sun is behind the panels
  const r = sub(mul(faceNormal, 2 * ns), s.v); // reflected ray
  if (r[2] >= 0.3) continue; // reflected steeply upwards: cannot reach eye height below the roof
  let any = false;
  observers.forEach((o, i) => {
    const O = [o.e, o.n, eye];
    for (const p of panels) {
      const nr = dot(p.n, r);
      if (nr <= 0) continue;
      const tHit = dot(p.n, sub(O, p.c0)) / nr; // P = O − t r lies on the panel plane
      if (tHit <= 0) continue;
      const P = sub(O, mul(r, tHit));
      const q = [dot(sub(P, p.c0), p.u), dot(sub(P, p.c0), p.v)];
      if (!inside(p.flat, q, tHit * Math.tan(spread))) continue;
      if (process.env.GLARE_DEBUG && !globalThis.debugged) {
        globalThis.debugged = true;
        console.log('DEBUG', { t: new Date(t).toISOString(), sun: s.v.map((x) => x.toFixed(3)), r: r.map((x) => x.toFixed(3)), O, P: P.map((x) => x.toFixed(2)), tHit: tHit.toFixed(2), q: q.map((x) => x.toFixed(2)), quad: p.flat.map((c) => c.map((x) => x.toFixed(2))), c0: p.c0.map((x) => x.toFixed(2)) });
      }
      // Hit: angle between the glare (from the eye towards P) and the view to the green.
      const toP = [P[0] - o.e, P[1] - o.n];
      const toPin = [pin[0] - o.e, pin[1] - o.n];
      const angle = Math.abs(((Math.atan2(toP[0], toP[1]) - Math.atan2(toPin[0], toPin[1])) / RAD + 540) % 360 - 180);
      o.minutes += stepMin;
      if (angle <= 50) o.inView += stepMin;
      if (o.samples.length < 400) o.samples.push(t);
      const d = new Date(t);
      byMonthHour[Number(swedish.formatToParts(d).find((x) => x.type === 'month').value) - 1][Number(swedish.formatToParts(d).find((x) => x.type === 'hour').value) % 24] += stepMin;
      events.push([t, i, Math.round(angle)]);
      any = true;
      break;
    }
  });
  if (any) stepsWithGlare += 1;
}

// ---- report --------------------------------------------------------------------
const hit = observers.filter((o) => o.minutes > 0);
const totalMin = stepsWithGlare * stepMin;
console.log(`hole way ${holeWay}: ${observers.length} observer points (${holeAreas.length} areas: ${holeAreas.map((f) => f.properties.golf).join(', ')}); ${panels.length} panels on ${buildingKey} ${faceDirs.join('+')}, normal az ${Math.round((Math.atan2(faceNormal[0], faceNormal[1]) / RAD + 360) % 360)}°, tilt ${Math.round(Math.acos(faceNormal[2]) / RAD)}°`);
console.log(`glare reaches some point of the hole in ${totalMin} min of ${year} (${(totalMin / 60).toFixed(1)} h); ${hit.length} of ${observers.length} points ever see it`);
if (hit.length) {
  const worst = [...hit].sort((a, b2) => b2.minutes - a.minutes).slice(0, 8);
  for (const o of worst) {
    const ds = o.samples.map((t) => swedish.format(new Date(t)));
    console.log(`  ${o.where} at E ${Math.round(o.e)} N ${Math.round(o.n)} (${Math.round(distToLine([o.e, o.n]))} m from the hole line, ${Math.round(Math.hypot(o.e - pin[0], o.n - pin[1]))} m from the pin): ${o.minutes} min/yr, ${o.inView} min within 50° of the view to the green; first ${ds[0]}, last ${ds.at(-1)}`);
  }
  console.log('minutes per month (Swedish time) and hours:');
  byMonthHour.forEach((hours, m) => {
    const tot = hours.reduce((a, x) => a + x, 0);
    if (tot) console.log(`  ${pad(m + 1)}: ${tot} min, hours ${hours.map((x, h) => (x ? `${pad(h)}:00 ${x}` : null)).filter(Boolean).join(', ')}`);
  });
}
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify({
    year, stepMin, spreadDeg: Number(arg('--spread-deg', '0.5')), eyeM: eye, holeWay, building: buildingKey, faces: faceDirs,
    note: 'Flat ground; trees and buildings between the panels and the hole ignored (worst case).',
    totalMinutes: totalMin,
    observers: observers.map((o) => ({ e: Math.round(o.e * 10) / 10, n: Math.round(o.n * 10) / 10, where: o.where, minutes: o.minutes, inView: o.inView })),
    byMonthHour,
    events: events.slice(0, 5000),
  }));
  console.log(`wrote ${outPath}`);
}
