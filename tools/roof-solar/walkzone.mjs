// Where golfers walk on one or more holes: a grid of observer points (eye
// positions) for glare.mjs, estimated from the OpenStreetMap golf areas around
// each hole line.
//
//   node tools/roof-solar/walkzone.mjs <golf.geojson> --hole-way <OSM way id>[,<id>...]
//        [--corridor-m 40] [--likely-m 15] [--step-m 4] [--out observers.geojson]
//
// golf.geojson: golf features in SWEREF 99 TM (EPSG:3006), e.g. extracted from
// golfTiles (OpenStreetMap data, ODbL). Output: a GeoJSON FeatureCollection of
// points (SWEREF 99 TM) with
//   hole_way the hole's OSM way id (with several holes a place can appear
//            once per hole, each time looking at that hole's pin)
//   on       the golf area the point is in: tee, fairway, green, bunker, rough or other
//   likely   1 on the tee, fairway or green or within --likely-m of the hole line
//            (where most golfers walk), 0 for rough and open ground further out
//   along_m  distance along the hole from the tee
//   off_m    distance from the hole line
//   look_e, look_n   where the golfer looks: the pin (golf=pin near the green
//            end of the hole line, else the end of the line)
// Points in forest, water, wetland and buildings are left out: nobody walks there.
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback);
const golfPath = args[0];
if (!golfPath || golfPath.startsWith('--') || !args.includes('--hole-way')) throw new Error('usage: walkzone.mjs <golf.geojson> --hole-way <id>[,<id>...] [options]');
const golf = JSON.parse(fs.readFileSync(golfPath, 'utf8'));
const holeWays = String(arg('--hole-way')).split(',');
const CORRIDOR = Number(arg('--corridor-m', '40'));
const LIKELY = Number(arg('--likely-m', '15'));
const STEP = Number(arg('--step-m', '4'));
const outPath = arg('--out');

const BLOCKED = ['forest', 'wood', 'scrub', 'lateral_water_hazard', 'water_hazard', 'wetland', 'water'];
const PLAY = ['green', 'tee', 'bunker', 'sand', 'fairway', 'rough']; // in priority order when areas overlap
const kind = (p) => p.golf || p.natural || p.landuse || p.leisure || (p.building ? 'building' : '') || '';
const rings = (g) => (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []);

function inRing([x, y], ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
// A polygon with holes: inside the outer ring and in none of the inner ones.
const inPoly = (p, poly) => inRing(p, poly[0]) && !poly.slice(1).some((r) => inRing(p, r));

function walkZone(holeWay) {
  // A hole can be split into several pieces in the tiles: join them in order.
  const pieces = golf.features.filter((f) => String(f.properties.mvt_id) === holeWay && f.properties.golf === 'hole').map((f) => f.geometry.coordinates);
  if (!pieces.length) throw new Error(`no golf=hole line with way id ${holeWay}`);
  const line = pieces.reduce((acc, p) => acc.concat(acc.length && Math.hypot(acc.at(-1)[0] - p[0][0], acc.at(-1)[1] - p[0][1]) < 1 ? p.slice(1) : p), []);
  const onLine = ([x, y]) => {
    let best = Infinity;
    let along = 0;
    let acc = 0;
    for (let i = 1; i < line.length; i += 1) {
      const [ax, ay] = line[i - 1];
      const [bx, by] = line[i];
      const L = Math.hypot(bx - ax, by - ay);
      if (!L) continue;
      const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (L * L)));
      const d = Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
      if (d < best) { best = d; along = acc + t * L; }
      acc += L;
    }
    return { d: best, along, total: acc };
  };
  const es = line.map((p) => p[0]);
  const ns = line.map((p) => p[1]);
  const box = [Math.min(...es) - CORRIDOR, Math.min(...ns) - CORRIDOR, Math.max(...es) + CORRIDOR, Math.max(...ns) + CORRIDOR];
  const near = (poly) => poly[0].some(([x, y]) => x > box[0] - 200 && x < box[2] + 200 && y > box[1] - 200 && y < box[3] + 200);
  const blocked = [];
  const play = [];
  let pin = null;
  const end = line.at(-1);
  for (const f of golf.features) {
    const k = kind(f.properties);
    if (k === 'pin') {
      const pts = f.geometry.type === 'MultiPoint' ? f.geometry.coordinates : f.geometry.type === 'Point' ? [f.geometry.coordinates] : [];
      for (const p of pts) if (Math.hypot(p[0] - end[0], p[1] - end[1]) < 30) pin = p;
    }
    for (const poly of rings(f.geometry)) {
      if (!near(poly)) continue;
      if (BLOCKED.includes(k) || f.properties.building) blocked.push(poly);
      else if (PLAY.includes(k)) play.push({ k, poly });
    }
  }
  pin ||= end;
  const out = [];
  for (let x = Math.ceil(box[0] / STEP) * STEP; x <= box[2]; x += STEP) {
    for (let y = Math.ceil(box[1] / STEP) * STEP; y <= box[3]; y += STEP) {
      const p = [x, y];
      const { d, along } = onLine(p);
      if (d > CORRIDOR || blocked.some((poly) => inPoly(p, poly))) continue;
      const hits = play.filter((a) => inPoly(p, a.poly)).map((a) => a.k);
      const on = PLAY.find((k) => hits.includes(k))?.replace('sand', 'bunker') || 'other';
      const likely = ['fairway', 'tee', 'green'].includes(on) || d <= LIKELY ? 1 : 0;
      out.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: p },
        properties: { hole_way: Number(holeWay), on, likely, along_m: Math.round(along), off_m: Math.round(d), look_e: pin[0], look_n: pin[1] },
      });
    }
  }
  console.log(`hole way ${holeWay}: ${Math.round(onLine(end).total)} m, ${out.length} points (${out.filter((f) => f.properties.likely).length} likely)`);
  return out;
}

const features = holeWays.flatMap(walkZone);
const counts = {};
for (const f of features) counts[f.properties.on] = (counts[f.properties.on] || 0) + 1;
console.log(`${features.length} observer points every ${STEP} m within ${CORRIDOR} m of the hole lines:`, counts);
const out = {
  type: 'FeatureCollection',
  crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::3006' } },
  attribution: 'Derived from OpenStreetMap data © OpenStreetMap contributors (ODbL), via golfTiles',
  hole_ways: holeWays.map(Number),
  features,
};
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify(out));
  console.log(`wrote ${outPath}`);
} else process.stdout.write(JSON.stringify(out));
