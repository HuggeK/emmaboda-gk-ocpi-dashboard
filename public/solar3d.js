// 3D model of the club's roofs and the solar panels that fit on them, built
// from public/data/solar-roofs.json (Lantmäteriet's laser data and building
// outlines, processed by tools/roof-solar). Loaded only when the Solar tab is
// opened; three.js comes from the import map in index.html.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const COLORS = {
  south: 0xeb6834,
  east: 0x2a78d6,
  west: 0x1baf7a,
  flat: 0xeda100,
  northLow: 0x8a6fd1,
  north: 0xb0aea6,
  roof: 0xd8d6cf,
  wall: 0xe9e7e1,
  panel: 0x0d2a52,
  panelEdge: 0x9ec5f4,
  frame: 0xb8bcc2, // the panel's aluminium frame
  rail: 0x8d939b, // mounting rails
  ground: 0xcfd8c4,
};

// ---- the sun ------------------------------------------------------------------
// The club, for the sun's position (WGS 84).
const LAT = 56.53;
const LON = 15.58;
const RAD = Math.PI / 180;
const SKY_R = 55; // m: radius of the sky dome the sun paths are drawn on (around the buildings)
export const SUN_DAYS = [
  { key: 'summer', label: '21 Jun', month: 6, day: 21, color: 0xf5b700 },
  { key: 'equinox', label: '20 Mar / 23 Sep', month: 3, day: 20, color: 0xd97706 },
  { key: 'winter', label: '21 Dec', month: 12, day: 21, color: 0x92400e },
];

// Swedish time's offset from UTC on a date (hours): +2 from the last Sunday
// of March to the last Sunday of October, else +1.
function swedenOffset(y, m, d) {
  const lastSunday = (month) => {
    const last = new Date(Date.UTC(y, month, 0));
    return last.getUTCDate() - last.getUTCDay();
  };
  const md = m * 100 + d;
  return md >= 300 + lastSunday(3) && md < 1000 + lastSunday(10) ? 2 : 1;
}

// The instant of a Swedish wall-clock time (hours may be fractional).
export function swedishInstant(y, m, d, hours) {
  return Date.UTC(y, m - 1, d) + (hours - swedenOffset(y, m, d)) * 3_600_000;
}

// Sun elevation and azimuth (deg; azimuth from north, clockwise) at an
// instant, NOAA's approximation (as in tools/roof-solar/simulate.mjs).
export function sunPosition(t) {
  const d = new Date(t);
  const doy = (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5;
  const hr = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  const g = (2 * Math.PI / 365) * (doy - 1 + (hr - 12) / 24);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const ha = ((hr * 60 + eqt + 4 * LON) / 4 - 180) * RAD;
  const la = LAT * RAD;
  const sinEl = Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha);
  const el = Math.asin(sinEl);
  const cosAz = (Math.sin(decl) - Math.sin(la) * sinEl) / (Math.cos(la) * Math.cos(el));
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) / RAD;
  if (ha > 0) az = 360 - az;
  return { el: el / RAD, az };
}

// Scene direction towards the sun: x east, y up, z south.
function sunVector(el, az) {
  return new THREE.Vector3(Math.sin(az * RAD) * Math.cos(el * RAD), Math.sin(el * RAD), -Math.cos(az * RAD) * Math.cos(el * RAD));
}

// Mounting as on a real roof: rails hold the panels this far above the roof
// surface (m), and a panel with its frame is this thick.
const PANEL_GAP = 0.15;
const PANEL_THICK = 0.04;

export function faceKind(f) {
  if (f.flat) return 'flat';
  if (!f.worth_it) return 'north';
  const a = ((f.azimuth % 360) + 360) % 360;
  if (a >= 112.5 && a < 247.5) return 'south';
  if (a >= 67.5 && a < 112.5) return 'east';
  if (a >= 247.5 && a < 292.5) return 'west';
  return 'northLow'; // north-facing but low enough pitch to be worth panels
}

function unpackBits(b64, n) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = (bytes[i >> 3] >> (7 - (i & 7))) & 1;
  return out;
}

function heights(b) {
  const bytes = Uint8Array.from(atob(b.heights_dm), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const h = new Float32Array(b.width * b.height);
  for (let i = 0; i < h.length; i += 1) h[i] = view.getInt16(i * 2, true) / 10;
  return h;
}

// One building as a mesh: the roof surface, coloured by roof face, with walls
// down to the ground, plus its panels. Coordinates: x east, y up, z south (m),
// relative to the site origin (e0, n0).
function buildingGroup(b, e0, n0) {
  const { width: W, height: H, px } = b;
  const h = heights(b);
  const roof = (r, c) => r >= 0 && r < H && c >= 0 && c < W && h[r * W + c] > 0;
  const faceOf = new Int16Array(W * H).fill(-1);
  b.faces.forEach((f, i) => {
    const m = unpackBits(f.mask, W * H);
    for (let k = 0; k < m.length; k += 1) if (m[k] && roof(Math.floor(k / W), k % W)) faceOf[k] = i;
  });
  // Height at each grid corner: the mean of the roof cells around it.
  const corner = (r, c) => {
    let s = 0;
    let n = 0;
    for (const [dr, dc] of [[-1, -1], [-1, 0], [0, -1], [0, 0]]) {
      if (roof(r + dr, c + dc)) {
        s += h[(r + dr) * W + (c + dc)];
        n += 1;
      }
    }
    return n ? s / n : 0;
  };
  const x0 = b.origin[0] - e0;
  const z0 = n0 - b.origin[1];
  const X = (c) => x0 + c * px;
  const Z = (r) => z0 + r * px;
  const pos = [];
  const col = [];
  const color = new THREE.Color();
  const tri = (a, bb, cc, hex) => {
    pos.push(...a, ...bb, ...cc);
    color.setHex(hex);
    for (let i = 0; i < 3; i += 1) col.push(color.r, color.g, color.b);
  };
  for (let r = 0; r < H; r += 1) {
    for (let c = 0; c < W; c += 1) {
      if (!roof(r, c)) continue;
      const fi = faceOf[r * W + c];
      const hex = fi >= 0 ? COLORS[faceKind(b.faces[fi])] : COLORS.roof;
      const p00 = [X(c), corner(r, c), Z(r)];
      const p01 = [X(c + 1), corner(r, c + 1), Z(r)];
      const p10 = [X(c), corner(r + 1, c), Z(r + 1)];
      const p11 = [X(c + 1), corner(r + 1, c + 1), Z(r + 1)];
      tri(p00, p10, p11, hex);
      tri(p00, p11, p01, hex);
      // Walls where the roof ends.
      const walls = [
        [!roof(r - 1, c), p01, p00],
        [!roof(r + 1, c), p10, p11],
        [!roof(r, c - 1), p00, p10],
        [!roof(r, c + 1), p11, p01],
      ];
      for (const [edge, a, bb] of walls) {
        if (!edge) continue;
        const a0 = [a[0], 0, a[2]];
        const b0 = [bb[0], 0, bb[2]];
        tri(a, a0, b0, COLORS.wall);
        tri(a, b0, bb, COLORS.wall);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const group = new THREE.Group();
  const shell = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0, side: THREE.DoubleSide, transparent: true }));
  shell.castShadow = true;
  shell.receiveShadow = true;
  group.add(shell);

  // Panels as mounted on a roof: on two aluminium rails running along the
  // roof, PANEL_GAP above the surface, PANEL_THICK thick, following its slope.
  const surface = (cx, cy) => {
    // Bilinear height at a point given in cell units (x = column, y = row).
    const c = Math.min(Math.max(cx, 0), W);
    const r = Math.min(Math.max(cy, 0), H);
    const c0 = Math.floor(c);
    const r0 = Math.floor(r);
    const fc = c - c0;
    const fr = r - r0;
    return (corner(r0, c0) * (1 - fc) + corner(r0, c0 + 1) * fc) * (1 - fr) + (corner(r0 + 1, c0) * (1 - fc) + corner(r0 + 1, c0 + 1) * fc) * fr;
  };
  const panelPos = [];
  const sidePos = [];
  const railPos = [];
  const edgePos = [];
  const quad = (arr, a, b2, c, d) => arr.push(...a, ...b2, ...c, ...a, ...c, ...d);
  const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const at = ([cx, cy], up) => [X(cx), surface(cx, cy) + up, Z(cy)];
  for (const f of b.faces) {
    for (const poly of f.panel_polygons) {
      // Corners in cell units: 0→1 along the roof (contour), 1→2 up the slope.
      const top = poly.map((p) => at(p, PANEL_GAP + PANEL_THICK));
      const bottom = poly.map((p) => at(p, PANEL_GAP));
      quad(panelPos, top[0], top[1], top[2], top[3]);
      for (let i = 0; i < 4; i += 1) {
        const j = (i + 1) % 4;
        quad(sidePos, bottom[i], bottom[j], top[j], top[i]);
        edgePos.push(...top[i], ...top[j]);
      }
      // Two rails under the panel, at a quarter and three quarters up it,
      // standing on the roof (a strip from the roof up to the panel).
      for (const t of [0.25, 0.75]) {
        const a = lerp(poly[0], poly[3], t);
        const c = lerp(poly[1], poly[2], t);
        quad(railPos, at(a, 0.02), at(c, 0.02), at(c, PANEL_GAP), at(a, PANEL_GAP));
      }
    }
  }
  const panels = new THREE.Group();
  const mesh = (pos, material) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.castShadow = true;
    return m;
  };
  if (panelPos.length) {
    panels.add(mesh(panelPos, new THREE.MeshStandardMaterial({ color: COLORS.panel, roughness: 0.3, metalness: 0.4, side: THREE.DoubleSide })));
    panels.add(mesh(sidePos, new THREE.MeshStandardMaterial({ color: COLORS.frame, roughness: 0.5, metalness: 0.6, side: THREE.DoubleSide })));
    panels.add(mesh(railPos, new THREE.MeshStandardMaterial({ color: COLORS.rail, roughness: 0.5, metalness: 0.7, side: THREE.DoubleSide })));
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
    panels.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: COLORS.panelEdge })));
  }
  group.add(panels);
  group.userData = { shell, panels, centre: new THREE.Vector3(X(W / 2), 0, Z(H / 2)), top: Math.max(...h) };
  return group;
}

function label(text, scale = 1) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = '600 28px system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 24;
  canvas.width = w;
  canvas.height = 44;
  ctx.font = '600 28px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.fillRect(0, 0, w, 44);
  ctx.fillStyle = '#0b0b0b';
  ctx.fillText(text, 12, 31);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  sprite.scale.set((w / 12) * scale, (44 / 12) * scale, 1);
  return sprite;
}

// Mounts the model in `container`. `selected` is a set of building keys whose
// panels are shown; the others are drawn faded. Returns { select, dispose }.
export function mountSolar3d(container, data, selected) {
  const buildings = data.buildings.filter((b) => !b.error && b.heights_dm);
  const e0 = buildings.reduce((s, b) => s + b.e, 0) / buildings.length;
  const n0 = buildings.reduce((s, b) => s + b.n, 0) / buildings.length;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  container.innerHTML = '';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe8eef3);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a9a7a, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(40, 80, 60); // from the south-east, high
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -90, right: 90, top: 90, bottom: -90, near: 1, far: 300 });
  scene.add(sun);
  scene.add(sun.target);

  // The sun's paths over the site on three days, with a mark every hour
  // (Swedish time), drawn on a dome around the buildings.
  const year = new Date().getFullYear();
  const hourLabels = [];
  for (const day of SUN_DAYS) {
    const pts = [];
    for (let h = 0; h <= 24; h += 1 / 6) {
      const p = sunPosition(swedishInstant(year, day.month, day.day, h));
      if (p.el > -1) pts.push(sunVector(Math.max(p.el, 0), p.az).multiplyScalar(SKY_R));
    }
    const path = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: day.color, transparent: true, opacity: 0.9 }));
    scene.add(path);
    for (let h = 1; h < 24; h += 1) {
      const p = sunPosition(swedishInstant(year, day.month, day.day, h));
      if (p.el <= 0) continue;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.7, 10, 8), new THREE.MeshBasicMaterial({ color: day.color }));
      dot.position.copy(sunVector(p.el, p.az).multiplyScalar(SKY_R));
      scene.add(dot);
      if (day.key === 'summer' && h % 3 === 0) {
        const tag = label(`${String(h).padStart(2, '0')}:00`, 0.9);
        tag.position.copy(dot.position).add(new THREE.Vector3(0, 3, 0));
        scene.add(tag);
        hourLabels.push(tag);
      }
    }
    const noon = sunPosition(swedishInstant(year, day.month, day.day, day.month >= 4 && day.month <= 9 ? 13 : 12));
    const name = label(day.label, 1);
    name.position.copy(sunVector(noon.el, noon.az).multiplyScalar(SKY_R)).add(new THREE.Vector3(0, -4, 0));
    scene.add(name);
  }
  // The sun itself, moved by setSun().
  const sunBall = new THREE.Mesh(new THREE.SphereGeometry(2.4, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffd34d }));
  scene.add(sunBall);
  const hemi = scene.children.find((c) => c.isHemisphereLight);

  // Moves the sun (and its light and shadows) to a Swedish date and time.
  // Returns its elevation and azimuth.
  function setSun(month, day, hours) {
    const p = sunPosition(swedishInstant(year, month, day, hours));
    const v = sunVector(Math.max(p.el, -2), p.az);
    sunBall.position.copy(v).multiplyScalar(SKY_R);
    sunBall.visible = p.el > -1;
    sun.position.copy(v).multiplyScalar(150);
    sun.target.position.set(0, 0, 0);
    const up = Math.max(0, Math.min(1, p.el / 15)); // fades in over the first 15° above the horizon
    sun.intensity = 2.4 * up;
    if (hemi) hemi.intensity = 0.6 + 0.8 * up;
    return p;
  }

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);
  // A north arrow on the ground.
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(-55, 0.2, 45), 14, 0x52514e, 4, 3);
  scene.add(arrow);
  const north = label('N');
  north.position.set(-55, 2, 27);
  scene.add(north);

  const groups = new Map();
  for (const b of buildings) {
    const g = buildingGroup(b, e0, n0);
    scene.add(g);
    const tag = label(b.name.replace(/ \(.*\)/, ''));
    tag.position.copy(g.userData.centre).setY(g.userData.top + 4);
    scene.add(tag);
    groups.set(b.key, g);
  }

  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.minDistance = 10;
  controls.maxDistance = 300;

  function select(keys) {
    const focus = new THREE.Vector3();
    let n = 0;
    for (const [key, g] of groups) {
      const on = keys.has(key);
      g.userData.panels.visible = on;
      g.userData.shell.material.opacity = on ? 1 : 0.35;
      g.userData.shell.material.depthWrite = on;
      if (on) {
        focus.add(g.userData.centre);
        n += 1;
      }
    }
    if (n) focus.divideScalar(n);
    controls.target.copy(focus);
    camera.position.copy(focus).add(new THREE.Vector3(60, 95, 150)); // from the south-east, high, with the sun paths in view
    controls.update();
  }

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();
  select(selected);

  let running = true;
  (function loop() {
    if (!running || !container.isConnected) return dispose();
    if (container.offsetParent !== null) { // only while the tab is visible
      controls.update();
      renderer.render(scene, camera);
    }
    requestAnimationFrame(loop);
  }());

  function dispose() {
    if (!running) return;
    running = false;
    ro.disconnect();
    controls.dispose();
    renderer.dispose();
  }
  setSun(6, 21, 13);
  return { select, dispose, setSun };
}
