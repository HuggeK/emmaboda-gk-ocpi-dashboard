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
  ground: 0xcfd8c4,
};

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

  // Panels: quads 8 cm above the roof surface, following its slope.
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
  const edgePos = [];
  for (const f of b.faces) {
    for (const poly of f.panel_polygons) {
      const pts = poly.map(([cx, cy]) => [X(cx), surface(cx, cy) + 0.08, Z(cy)]);
      panelPos.push(...pts[0], ...pts[1], ...pts[2], ...pts[0], ...pts[2], ...pts[3]);
      for (let i = 0; i < 4; i += 1) edgePos.push(...pts[i], ...pts[(i + 1) % 4]);
    }
  }
  const panels = new THREE.Group();
  if (panelPos.length) {
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(panelPos, 3));
    pg.computeVertexNormals();
    panels.add(new THREE.Mesh(pg, new THREE.MeshStandardMaterial({ color: COLORS.panel, roughness: 0.3, metalness: 0.4, side: THREE.DoubleSide })));
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
    panels.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: COLORS.panelEdge })));
  }
  group.add(panels);
  group.userData = { shell, panels, centre: new THREE.Vector3(X(W / 2), 0, Z(H / 2)), top: Math.max(...h) };
  return group;
}

function label(text) {
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
  sprite.scale.set(w / 12, 44 / 12, 1);
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
    camera.position.copy(focus).add(new THREE.Vector3(35, 45, 70)); // from the south-east, above
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
  return { select, dispose };
}
