// Packs the map layers for the Solar tab's 3D model into one small file:
// the golf course from OpenStreetMap (so people can find their way around the
// model) and the results of glare.mjs runs (where and when panels would dazzle).
//
//   node tools/roof-solar/site-layers.mjs <golf.geojson>
//        [--box E0,N0,E1,N1] [--glare key|label|glare.json ...]
//        [--out public/data/solar-site.json]
//
// golf.geojson: golf features in SWEREF 99 TM, e.g. extracted from golfTiles.
// The output keeps SWEREF 99 TM coordinates rounded to 0.1 m and the
// OpenStreetMap attribution (ODbL), which the dashboard shows under the model.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const arg = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const golfPath = args[0];
if (!golfPath || golfPath.startsWith('--')) throw new Error('usage: site-layers.mjs <golf.geojson> [--box E0,N0,E1,N1] [--glare key|label|file ...] [--out file]');
const golf = JSON.parse(fs.readFileSync(golfPath, 'utf8'));
const box = arg('--box', '535800,6264300,536750,6265700').split(',').map(Number);
const outPath = arg('--out', path.join(ROOT, 'public/data/solar-site.json'));

const r1 = (x) => Math.round(x * 10) / 10;
const inBox = ([e, n]) => e >= box[0] && e <= box[2] && n >= box[1] && n <= box[3];
const kind = (p) => p.golf || p.natural || p.landuse || p.leisure || p.highway || p.waterway || (p.building ? 'building' : '') || '';
// Drop points closer than 0.5 m to the previous one: the tiles are denser than the model needs.
const thin = (pts) => pts.filter((p, i) => i === 0 || i === pts.length - 1 || Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) >= 0.5).map(([e, n]) => [r1(e), r1(n)]);
const KEEP = ['fairway', 'rough', 'green', 'tee', 'bunker', 'sand', 'water', 'lateral_water_hazard', 'water_hazard', 'wetland', 'forest', 'wood', 'scrub', 'grass', 'driving_range', 'building', 'clubhouse', 'parking', 'camp_site', 'pitch'];

const areas = [];
const lines = [];
const trees = [];
const pins = [];
for (const f of golf.features) {
  const g = f.geometry;
  const k = kind(f.properties);
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  for (const poly of polys) {
    if (!KEEP.includes(k) || !poly[0].some(inBox)) continue;
    areas.push({ k: f.properties.building ? 'building' : k, rings: poly.map(thin) });
  }
  if (g.type === 'LineString' && g.coordinates.some(inBox)) {
    lines.push({ k: k === 'hole' ? 'hole' : f.properties.highway ? 'path' : k, way: k === 'hole' ? f.properties.mvt_id : undefined, pts: thin(g.coordinates) });
  }
  const pts = g.type === 'MultiPoint' ? g.coordinates : g.type === 'Point' ? [g.coordinates] : [];
  for (const p of pts.filter(inBox)) {
    if (['tree', 'shrub'].includes(k)) trees.push([r1(p[0]), r1(p[1])]);
    if (k === 'pin') pins.push([r1(p[0]), r1(p[1])]);
  }
}

// Glare runs: keep the totals, the month × hour table and the places that see
// glare in their field of view (≤ 25°), with minutes per period.
const glare = args.flatMap((a, i) => (a === '--glare' ? [args[i + 1]] : [])).map((spec) => {
  const [key, label, file] = spec.split('|');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const F = Object.fromEntries(j.observer_fields.map((name, i) => [name, i]));
  const seen = j.observers.filter((o) => o[F.min].some((m) => m > 0));
  const inView = seen.filter((o) => o[F.min][0] + o[F.min][1] > 0);
  return {
    key,
    label,
    settings: j.settings,
    faces: j.faces,
    observers: j.observers.length,
    observers_seeing: seen.length,
    minutes_any: j.minutes_any,
    minutes_in_view: j.minutes_in_view,
    minutes_in_view_by_period: j.minutes_in_view_by_period,
    by_month_hour_in_view: j.by_month_hour_in_view,
    // e, n, minutes in view [high, season, off], minutes straight in the eyes, days in view, of them high season, hole way, on
    point_fields: ['e', 'n', 'in_view', 'central', 'days', 'high_days', 'hole_way', 'on'],
    points: inView.map((o) => [o[F.e], o[F.n], o[F.in_view], o[F.min][0], o[F.days], o[F.high_days], o[F.props]?.hole_way ?? null, o[F.props]?.on ?? null]),
  };
});

const out = {
  generated_by: 'tools/roof-solar/site-layers.mjs',
  crs: 'EPSG:3006',
  attribution: 'Golf course: © OpenStreetMap contributors (ODbL), via golfTiles',
  box,
  golf: { areas, lines, trees, pins },
  glare,
};
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`areas ${areas.length}, lines ${lines.length}, trees ${trees.length}, pins ${pins.length}; glare runs ${glare.map((g) => `${g.key} (${g.points.length} places in view)`).join(', ')}; ${(fs.statSync(outPath).size / 1024).toFixed(0)} kB → ${outPath}`);
