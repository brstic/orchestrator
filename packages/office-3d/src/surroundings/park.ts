import * as THREE from 'three';
import { ON_SURFACE } from '../surface.ts';
import { Kept, OUTPUT, at, fbm2, flock, grain, instanced, merged, rng, swaying, turned, waterMaterial } from './kit.ts';
import type { Place, PlaceInput } from './place.ts';

/**
 * A pavilion in a park on a clear day: mown lawns, gravel paths to a fountain and a pond, trees that move in the
 * wind, hills further off, birds and a few hot-air balloons over them.
 *
 * The ground near the building is one flat picture (lawn, paths, beds, the shadows of the trees), so nothing lies on
 * top of anything else there and nothing can shimmer; from its edge on, the land is a surface that rises into hills.
 */

/** Half the side of the flat, painted ground; the land beyond it is made of squares this wide. */
const INNER = 135;
const CELL = 15;
const REACH = 780;
const GROUND = -0.2;
const SUN: [number, number, number] = [0.5, 0.78, 0.38];

interface Layout {
  entrance: { x: number; z: number };
  plaza: { x: number; z: number; r: number };
  pond: { x: number; z: number; rx: number; rz: number };
  /** Paths as lines of points, each with a width. */
  paths: Array<{ points: Array<[number, number]>; width: number }>;
  /** Where no tree may stand: the building and the rooms members may add to it. */
  keep: { minX: number; maxX: number; minZ: number; maxZ: number };
}

function curve(points: Array<[number, number]>, steps = 24): Array<[number, number]> {
  const c = new THREE.CatmullRomCurve3(points.map(([x, z]) => new THREE.Vector3(x, 0, z)));
  return c.getPoints(steps * (points.length - 1)).map((p) => [p.x, p.z]);
}

function layoutOf({ building, entrance }: PlaceInput): Layout {
  const plaza = { x: entrance.x, z: building.maxZ + 38, r: 10.5 };
  const pond = { x: building.minX - 36, z: building.maxZ + 52, rx: 27, rz: 17 };
  // A walk all the way round, far enough out to clear any member's room.
  const lx = building.maxX + 30;
  const lz0 = building.minZ - 30;
  const lz1 = plaza.z;
  const loop = curve([[-lx, lz0 + 14], [-lx + 14, lz0], [0, lz0 - 5], [lx - 14, lz0], [lx, lz0 + 14], [lx + 4, (lz0 + lz1) / 2], [lx - 6, lz1 - 6], [plaza.x + 22, lz1 + 3], [plaza.x, lz1]], 16);
  const west = curve([[plaza.x, lz1], [plaza.x - 24, lz1 + 6], [pond.x + pond.rx + 7, pond.z - 6], [pond.x + 6, pond.z - pond.rz - 6], [pond.x - pond.rx - 4, pond.z - 12], [-lx - 6, (lz0 + lz1) / 2 + 12], [-lx, lz0 + 14]], 16);
  return {
    entrance,
    plaza,
    pond,
    paths: [
      { points: [[entrance.x, building.maxZ + 0.5], [entrance.x, plaza.z]], width: 4.2 },
      { points: loop, width: 2.8 },
      { points: west, width: 2.8 },
      { points: curve([[plaza.x, plaza.z], [plaza.x + 6, plaza.z + 30], [plaza.x - 10, plaza.z + 70], [plaza.x + 8, INNER + 40]], 12), width: 2.6 },
    ],
    keep: { minX: building.minX - 26, maxX: building.maxX + 26, minZ: building.minZ - 26, maxZ: building.maxZ + 5 },
  };
}

function nearPath(l: Layout, x: number, z: number, margin: number): boolean {
  for (const p of l.paths) {
    const reach = p.width / 2 + margin;
    for (let i = 1; i < p.points.length; i++) {
      const [ax, az] = p.points[i - 1]!;
      const [bx, bz] = p.points[i]!;
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)));
      if (Math.hypot(x - ax - dx * t, z - az - dz * t) < reach) return true;
    }
  }
  return false;
}

function inPond(l: Layout, x: number, z: number, margin: number): boolean {
  return ((x - l.pond.x) / (l.pond.rx + margin)) ** 2 + ((z - l.pond.z) / (l.pond.rz + margin)) ** 2 < 1;
}

/** How high the land is at a point: flat as far as the painted ground reaches, then rising into hills. */
function heightAt(x: number, z: number): number {
  const d = Math.max(Math.abs(x), Math.abs(z));
  if (d <= INNER) return GROUND;
  const k = THREE.MathUtils.smoothstep(d, INNER, INNER + 210);
  const far = THREE.MathUtils.smoothstep(d, 360, 760);
  return GROUND + k * (fbm2(x / 240 + 3.1, z / 240 + 7.7, 4, 11) * 64 - 20) + far * fbm2(x / 400 + 1.3, z / 400 + 5.1, 3, 5) * 110;
}

/** Lighter at the top than underneath, the way leaves are: a shape's own colours, by height. */
function shadeByHeight(g: THREE.BufferGeometry, lo: number, hi: number, dark = 0.62, light = 1.12): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const c = g.getAttribute('color');
  for (let i = 0; i < p.count; i++) {
    const k = dark + (light - dark) * THREE.MathUtils.clamp((p.getY(i) - lo) / (hi - lo), 0, 1);
    c.setXYZ(i, c.getX(i) * k, c.getY(i) * k, c.getZ(i) * k);
  }
  return g;
}

function blob(r: number, x: number, y: number, z: number, sy = 1, sx = 1, detail = 2): { geometry: THREE.BufferGeometry; color: string; matrix: THREE.Matrix4 } {
  return { geometry: new THREE.IcosahedronGeometry(r, detail), color: '#ffffff', matrix: at(x, y, z, 0, sx, sy, sx) };
}

function paintGround(ctx: CanvasRenderingContext2D, size: number, l: Layout, building: PlaceInput['building'], shadows: Array<[number, number, number]>, random: () => number): void {
  const m = size / (2 * INNER);
  const px = (x: number) => (x + INNER) * m;
  const pz = (z: number) => (z + INNER) * m;
  // Lawn, mown in bands; the bands fade out towards the edge, where the land beyond takes over.
  ctx.fillStyle = '#5a9a45';
  ctx.fillRect(0, 0, size, size);
  const band = 4.5 * m;
  for (let i = 0; i * band < size; i += 2) {
    ctx.fillStyle = 'rgba(126, 190, 96, 0.34)';
    ctx.fillRect(0, i * band, size, band);
  }
  // Patches: no lawn is one colour.
  for (let i = 0; i < 900; i++) {
    const r = (5 + random() * 18) * m;
    const x = random() * size;
    const y = random() * size;
    const tone = random() < 0.5 ? '60, 120, 50' : '170, 205, 110';
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${tone}, 0.1)`);
    g.addColorStop(1, `rgba(${tone}, 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  const edge = ctx.createRadialGradient(size / 2, size / 2, size * 0.36, size / 2, size / 2, size * 0.72);
  edge.addColorStop(0, 'rgba(90, 154, 69, 0)');
  edge.addColorStop(1, 'rgba(90, 154, 69, 1)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, size, size);

  grain(ctx, size, 7, random);

  // The shadows of the trees that stand on this ground, thrown away from the sun.
  for (const [x, z, r] of shadows) {
    const sx = px(x - SUN[0] * r * 0.9);
    const sz = pz(z - SUN[2] * r * 0.9);
    const g = ctx.createRadialGradient(sx, sz, 0, sx, sz, r * 1.25 * m);
    g.addColorStop(0, 'rgba(20, 50, 30, 0.42)');
    g.addColorStop(0.6, 'rgba(20, 50, 30, 0.3)');
    g.addColorStop(1, 'rgba(20, 50, 30, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(sx, sz, r * 1.3 * m, r * 1.05 * m, 0.6, 0, Math.PI * 2);
    ctx.fill();
  }

  // The pond's bank: reeds' green, then sand, then the wet edge. The water itself lies over the middle.
  for (const [grow, color] of [[3.2, '#4c8a3e'], [1.7, '#cdbf94'], [0.7, '#8f8463']] as const) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(px(l.pond.x), pz(l.pond.z), (l.pond.rx + grow) * m, (l.pond.rz + grow) * m, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Gravel paths with a darker edge.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const pass of [0, 1]) {
    for (const p of l.paths) {
      ctx.strokeStyle = pass === 0 ? '#9c8f6c' : '#dccfab';
      ctx.lineWidth = (p.width + (pass === 0 ? 0.5 : 0)) * m;
      ctx.beginPath();
      p.points.forEach(([x, z], i) => (i ? ctx.lineTo(px(x), pz(z)) : ctx.moveTo(px(x), pz(z))));
      ctx.stroke();
    }
  }
  // The round place with the fountain: stone in rings, beds of flowers around it.
  const { x: fx, z: fz, r } = l.plaza;
  ctx.fillStyle = '#9c8f6c';
  ctx.beginPath();
  ctx.arc(px(fx), pz(fz), (r + 0.3) * m, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#d9d0b8';
  ctx.beginPath();
  ctx.arc(px(fx), pz(fz), r * m, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120, 108, 84, 0.5)';
  ctx.lineWidth = 0.12 * m;
  for (let k = 1; k < 6; k++) {
    ctx.beginPath();
    ctx.arc(px(fx), pz(fz), (r * k) / 6, 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(px(fx) + Math.cos(a) * 4.4 * m, pz(fz) + Math.sin(a) * 4.4 * m);
    ctx.lineTo(px(fx) + Math.cos(a) * r * m, pz(fz) + Math.sin(a) * r * m);
    ctx.stroke();
  }
  const bed = (cx: number, cz: number, rx: number, rz: number, rot: number, colors: string[]) => {
    ctx.save();
    ctx.translate(px(cx), pz(cz));
    ctx.rotate(rot);
    ctx.fillStyle = '#3b2c20';
    ctx.beginPath();
    ctx.ellipse(0, 0, rx * m, rz * m, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#356b2f';
    ctx.beginPath();
    ctx.ellipse(0, 0, (rx - 0.25) * m, (rz - 0.25) * m, 0, 0, Math.PI * 2);
    ctx.fill();
    for (let i = 0; i < rx * rz * 26; i++) {
      const a = random() * Math.PI * 2;
      const d = Math.sqrt(random());
      ctx.fillStyle = colors[Math.floor(random() * colors.length)]!;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * d * (rx - 0.4) * m, Math.sin(a) * d * (rz - 0.4) * m, (0.1 + random() * 0.12) * m, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };
  const palettes = [['#f25c78', '#ffd166', '#ffffff'], ['#b06cf0', '#ffe9a8', '#ff8fab'], ['#ff9f43', '#ffe066', '#f25c78'], ['#ffffff', '#8ecbff', '#c9a6ff']];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    // Not across the paths that leave the place.
    const bx = fx + Math.cos(a) * (r + 3.3);
    const bz = fz + Math.sin(a) * (r + 3.3);
    if (nearPath(l, bx, bz, 1.6)) continue;
    bed(bx, bz, 3.2, 1.5, a + Math.PI / 2, palettes[k % palettes.length]!);
  }
  for (const side of [-1, 1]) {
    for (let k = 0; k < 3; k++) bed(l.entrance.x + side * 4.6, building.maxZ + 8 + k * 9, 1.2, 3.2, 0, palettes[(k + (side > 0 ? 1 : 0)) % palettes.length]!);
  }

  // Paving round the building.
  const walk = 3.2;
  ctx.fillStyle = '#b9b3a4';
  ctx.fillRect(px(building.minX - walk), pz(building.minZ - walk), (building.maxX - building.minX + 2 * walk) * m, (building.maxZ - building.minZ + 2 * walk) * m);
  ctx.strokeStyle = 'rgba(105, 98, 84, 0.55)';
  ctx.lineWidth = Math.max(1, 0.06 * m);
  for (let x = building.minX - walk; x <= building.maxX + walk + 0.01; x += 1.6) {
    ctx.beginPath();
    ctx.moveTo(px(x), pz(building.minZ - walk));
    ctx.lineTo(px(x), pz(building.maxZ + walk));
    ctx.stroke();
  }
  for (let z = building.minZ - walk; z <= building.maxZ + walk + 0.01; z += 1.6) {
    ctx.beginPath();
    ctx.moveTo(px(building.minX - walk), pz(z));
    ctx.lineTo(px(building.maxX + walk), pz(z));
    ctx.stroke();
  }
}

/** Water thrown up and falling back: points on arcs, each from the time alone. */
function jetMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uScale: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec4 aJet; // outward speed x, z; upward speed; where in its flight it starts
      uniform float uTime;
      varying float vLife;
      void main() {
        float flight = 2.0 * aJet.z / 9.8;
        float t = mod(uTime + aJet.w * flight, flight);
        vLife = t / flight;
        vec3 p = position + vec3(aJet.x * t, aJet.z * t - 4.9 * t * t, aJet.y * t);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(150.0 / max(-mv.z, 1.0), 1.5, 14.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying float vLife;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.2, d) * (0.5 + 0.35 * (1.0 - vLife));
        gl_FragColor = vec4(vec3(0.93, 0.97, 1.0), a);
        ${OUTPUT}
      }
    `,
  });
}

export function buildPark(input: PlaceInput): Place {
  const { building, quality } = input;
  const kept = new Kept();
  const group = new THREE.Group();
  const random = rng(77120);
  const l = layoutOf(input);
  const time = { value: 0 };

  // ── where the trees stand ──
  interface Tree { x: number; z: number; y: number; size: number; kind: number; turn: number; tint: THREE.Color }
  const trees: Tree[] = [];
  const tintOf = (): THREE.Color => {
    const r = random();
    if (r < 0.05) return new THREE.Color().setHSL(0.93 + random() * 0.04, 0.55, 0.74); // in blossom
    if (r < 0.1) return new THREE.Color().setHSL(0.11 + random() * 0.03, 0.62, 0.5); // turning
    return new THREE.Color().setHSL(0.25 + random() * 0.09, 0.42 + random() * 0.18, 0.3 + random() * 0.13);
  };
  const free = (x: number, z: number, gap: number) => {
    if (x > l.keep.minX && x < l.keep.maxX && z > l.keep.minZ && z < l.keep.maxZ) return false;
    if (Math.hypot(x - l.plaza.x, z - l.plaza.z) < l.plaza.r + 6.5) return false;
    if (inPond(l, x, z, 4.5) || nearPath(l, x, z, 2.6)) return false;
    // Nothing between the door and the fountain but the view.
    if (Math.abs(x - l.entrance.x) < 9 && z > building.maxZ && z < l.plaza.z) return false;
    return !trees.some((t) => Math.hypot(t.x - x, t.z - z) < gap);
  };
  const plant = (x: number, z: number, gap: number, kind?: number) => {
    if (!free(x, z, gap)) return;
    trees.push({ x, z, y: heightAt(x, z), size: 0.8 + random() * 0.75, kind: kind ?? (random() < 0.24 ? 1 : 0), turn: random() * Math.PI * 2, tint: tintOf() });
  };
  // An avenue along the way to the fountain, and trees along the walks.
  for (let z = building.maxZ + 6; z < l.plaza.z - l.plaza.r - 4; z += 8.5) for (const side of [-1, 1]) trees.push({ x: l.entrance.x + side * 10.5, z, y: GROUND, size: 1.05, kind: 1, turn: random() * 6, tint: new THREE.Color().setHSL(0.29, 0.5, 0.36) });
  // On the lawns: singly and in clumps.
  for (let i = 0; i < 46; i++) {
    const cx = (random() * 2 - 1) * (INNER - 8);
    const cz = (random() * 2 - 1) * (INNER - 8);
    const clump = random() < 0.45 ? 1 : 2 + Math.floor(random() * 4);
    for (let k = 0; k < clump; k++) plant(cx + (random() - 0.5) * 16 * Math.min(1, clump - 1), cz + (random() - 0.5) * 16 * Math.min(1, clump - 1), 6.5);
  }
  const lawnTrees = trees.length;
  // Beyond the lawns: woods on the hills, thinning with distance.
  const far = quality === 'low' ? 320 : 760;
  for (let i = 0; i < far * 3 && trees.length < lawnTrees + far; i++) {
    const a = random() * Math.PI * 2;
    const d = INNER + 4 + Math.pow(random(), 1.5) * 520;
    const x = Math.cos(a) * d * 1.1;
    const z = Math.sin(a) * d * 1.1;
    if (Math.max(Math.abs(x), Math.abs(z)) < INNER + 3) continue;
    // Woods stand where the noise says so: there are clearings.
    if (fbm2(x / 90, z / 90, 3, 3) < 0.47) continue;
    trees.push({ x, z, y: heightAt(x, z) - 0.3, size: 1 + random() * 0.9, kind: random() < 0.2 ? 1 : 0, turn: random() * 6, tint: tintOf() });
  }

  // ── the ground: a painted lawn, and the land beyond ──
  const ground = kept.add(new THREE.CanvasTexture(document.createElement('canvas')));
  {
    const canvas = ground.image as HTMLCanvasElement;
    canvas.width = canvas.height = quality === 'low' ? 1024 : 2048;
    const shadows = trees.slice(0, lawnTrees).map((t) => [t.x, t.z, (t.kind === 1 ? 2.4 : 3.6) * t.size] as [number, number, number]);
    paintGround(canvas.getContext('2d')!, canvas.width, l, building, shadows, random);
    ground.colorSpace = THREE.SRGBColorSpace;
    ground.anisotropy = 16;
    ground.needsUpdate = true;
  }
  const lawn = new THREE.Mesh(kept.add(new THREE.PlaneGeometry(2 * INNER, 2 * INNER).rotateX(-Math.PI / 2)), kept.add(new THREE.MeshLambertMaterial({ map: ground })));
  lawn.position.y = GROUND;
  lawn.receiveShadow = true;
  group.add(lawn);

  {
    // Its colours are a picture too (meadow, wood, dry grass on the heights): colours given corner by corner show the squares.
    const tones = kept.add(new THREE.CanvasTexture(document.createElement('canvas')));
    const canvas = tones.image as HTMLCanvasElement;
    const res = quality === 'low' ? 256 : 512;
    canvas.width = canvas.height = res;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(res, res);
    const grass = new THREE.Color('#5a9a45');
    const wood = new THREE.Color('#3f7a3a');
    const dry = new THREE.Color('#93b05c');
    const c = new THREE.Color();
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = ((i + 0.5) / res - 0.5) * 2 * REACH;
        const z = ((j + 0.5) / res - 0.5) * 2 * REACH;
        const d = Math.max(Math.abs(x), Math.abs(z));
        const k = THREE.MathUtils.smoothstep(d, INNER, INNER + 70);
        const woods = THREE.MathUtils.smoothstep(fbm2(x / 90, z / 90, 3, 3), 0.44, 0.52);
        c.copy(grass).lerp(dry, k * 0.55 * fbm2(x / 60, z / 60, 3, 9)).lerp(wood, k * woods * 0.75);
        c.convertLinearToSRGB();
        img.data.set([c.r * 255, c.g * 255, c.b * 255, 255], (j * res + i) * 4);
      }
    }
    ctx.putImageData(img, 0, 0);
    tones.colorSpace = THREE.SRGBColorSpace;
    tones.needsUpdate = true;
    const n = Math.round((2 * REACH) / CELL);
    const land = new THREE.PlaneGeometry(2 * REACH, 2 * REACH, n, n).rotateX(-Math.PI / 2);
    const p = land.getAttribute('position');
    for (let i = 0; i < p.count; i++) p.setY(i, heightAt(p.getX(i), p.getZ(i)));
    // The squares under the painted lawn are left out.
    const index = land.getIndex()!;
    const keptFaces: number[] = [];
    for (let i = 0; i < index.count; i += 3) {
      const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      const mx = (p.getX(ids[0]!) + p.getX(ids[1]!) + p.getX(ids[2]!)) / 3;
      const mz = (p.getZ(ids[0]!) + p.getZ(ids[1]!) + p.getZ(ids[2]!)) / 3;
      if (Math.abs(mx) < INNER && Math.abs(mz) < INNER) continue;
      keptFaces.push(...ids);
    }
    land.setIndex(keptFaces);
    land.computeVertexNormals();
    group.add(new THREE.Mesh(kept.add(land), kept.add(new THREE.MeshLambertMaterial({ map: tones }))));
  }

  // ── trees ──
  const bark = kept.add(new THREE.MeshLambertMaterial({ color: '#6a4a34' }));
  const leaves = kept.add(new THREE.MeshLambertMaterial({ vertexColors: true }));
  swaying(leaves, time, 1);
  // The trees on the lawns are rounder than the woods on the hills, which are never seen close.
  const crownsOf = (detail: number) => [
    kept.add(shadeByHeight(merged([blob(2.9, 0, 5.7, 0, 0.92, 1, detail), blob(2.1, 1.7, 4.7, 0.5, 1, 1, detail), blob(2.0, -1.4, 4.9, -1.0, 1, 1, detail), blob(1.9, 0.2, 7.4, 0.3, 1, 1, detail), blob(1.7, -0.6, 4.6, 1.7, 1, 1, detail)]), 3, 9)),
    kept.add(shadeByHeight(merged([blob(1.75, 0, 7.4, 0, 3.0, 1, detail), blob(1.25, 0.3, 4.6, 0.2, 1.7, 1, detail)]), 2.5, 12.5)),
  ];
  const near = crownsOf(2);
  const distant = crownsOf(1);
  const trunks = [kept.add(new THREE.CylinderGeometry(0.2, 0.34, 4.2, 7).translate(0, 2.1, 0)), kept.add(new THREE.CylinderGeometry(0.14, 0.26, 3.4, 7).translate(0, 1.7, 0))];
  for (const kind of [0, 1]) {
    for (const [from, to, crowns] of [[0, lawnTrees, near], [lawnTrees, trees.length, distant]] as const) {
      const these = trees.slice(from, to).filter((t) => t.kind === kind);
      const m = these.map((t) => at(t.x, t.y, t.z, t.turn, t.size, t.size * (0.9 + ((t.turn * 7) % 1) * 0.25), t.size));
      group.add(instanced(trunks[kind]!, bark, m), instanced(crowns[kind]!, leaves, m, these.map((t) => t.tint)));
    }
  }

  // ── bushes by the building's corners and round the fountain ──
  const bushAt: THREE.Matrix4[] = [];
  const bushTint: THREE.Color[] = [];
  const bush = (x: number, z: number, s: number) => {
    bushAt.push(at(x, GROUND + 0.35 * s, z, random() * 6, s * (0.9 + random() * 0.3), s * (0.6 + random() * 0.25), s * (0.9 + random() * 0.3)));
    bushTint.push(new THREE.Color().setHSL(0.27 + random() * 0.07, 0.45, 0.27 + random() * 0.1));
  };
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    const x = l.plaza.x + Math.cos(a) * (l.plaza.r + 6.2);
    const z = l.plaza.z + Math.sin(a) * (l.plaza.r + 6.2);
    if (!nearPath(l, x, z, 1.5)) bush(x, z, 1.1);
  }
  for (const [cx, cz] of [[building.minX - 4.4, building.maxZ + 4.4], [building.maxX + 4.4, building.maxZ + 4.4]] as const) for (let k = 0; k < 5; k++) bush(cx + (random() - 0.5) * 3, cz + (random() - 0.5) * 3, 0.9 + random() * 0.5);
  const bushGeo = kept.add(shadeByHeight(merged([blob(1, 0, 0.4, 0)]), -0.4, 1.4, 0.7, 1.15));
  group.add(instanced(bushGeo, leaves, bushAt, bushTint));

  // ── the pond ──
  const pondWater = kept.add(waterMaterial({ deep: '#1f5d6b', shallow: '#3f8f8a', sky: '#9cc7ee', sun: SUN, sunColor: '#fff6dc', glitter: 0.6, wave: 4.5, speed: 0.4, rough: 0.07 }));
  Object.assign(pondWater, ON_SURFACE);
  const pond = new THREE.Mesh(kept.add(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2)), pondWater);
  pond.position.set(l.pond.x, GROUND + 0.02, l.pond.z);
  pond.scale.set(l.pond.rx, 1, l.pond.rz);
  group.add(pond);
  // A jetty and two boats.
  const timber = kept.add(new THREE.MeshLambertMaterial({ color: '#8a6846' }));
  const jx = l.pond.x + l.pond.rx * 0.62;
  const jz = l.pond.z - l.pond.rz * 0.55;
  const jetty = new THREE.Mesh(kept.add(new THREE.BoxGeometry(1.8, 0.14, 9).translate(0, 0.25, 0)), timber);
  jetty.position.set(jx, GROUND, jz);
  jetty.rotation.y = -0.9;
  group.add(jetty);
  const boatGeo = kept.add(
    merged([
      { geometry: new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), color: '#f2ede2', matrix: at(0, 0.5, 0, 0, 0.75, 0.55, 2.0) },
      { geometry: new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2), color: '#d9d2c2', matrix: at(0, 0.2, 0, 0, 0.6, 1, 1.75) },
      { geometry: new THREE.BoxGeometry(1.1, 0.06, 0.3), color: '#8a6846', matrix: at(0, 0.38, 0.3) },
      { geometry: new THREE.BoxGeometry(1.1, 0.06, 0.3), color: '#8a6846', matrix: at(0, 0.38, -0.7) },
      { geometry: new THREE.TorusGeometry(1, 0.05, 6, 20), color: '#c0483c', matrix: at(0, 0.5, 0, 0, 0.76, 2.02, 1, Math.PI / 2) },
    ]),
  );
  const boatMat = kept.add(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  const boats = [new THREE.Mesh(boatGeo, boatMat), new THREE.Mesh(boatGeo, boatMat)];
  boats[0]!.position.set(jx - 4.6, GROUND - 0.1, jz + 2.2);
  boats[1]!.position.set(l.pond.x - 6, GROUND - 0.1, l.pond.z + 3);
  group.add(...boats);
  // Water lilies.
  const padAt: THREE.Matrix4[] = [];
  for (let i = 0; i < 46; i++) {
    const a = random() * Math.PI * 2;
    const d = 0.45 + random() * 0.45;
    padAt.push(at(l.pond.x + Math.cos(a) * d * l.pond.rx * (0.6 + 0.4 * random()), GROUND + 0.035, l.pond.z + Math.sin(a) * d * l.pond.rz, random() * 6, 0.35 + random() * 0.35));
  }
  const padMat = kept.add(new THREE.MeshLambertMaterial({ color: '#3f8a45', ...ON_SURFACE, polygonOffsetFactor: -8 }));
  group.add(instanced(kept.add(new THREE.CircleGeometry(1, 10, 0.5, Math.PI * 2 - 0.6).rotateX(-Math.PI / 2)), padMat, padAt));

  // ── the fountain ──
  const stone = kept.add(new THREE.MeshStandardMaterial({ color: '#cfc8b6', roughness: 0.85 }));
  const basin = new THREE.Mesh(kept.add(turned([[3.6, 0], [4.0, 0], [4.0, 0.62], [3.75, 0.7], [3.55, 0.62], [3.55, 0.2], [0.0, 0.2]], 40)), stone);
  basin.position.set(l.plaza.x, GROUND, l.plaza.z);
  const stem = new THREE.Mesh(kept.add(turned([[0.0, 0.2], [0.55, 0.2], [0.42, 0.5], [0.22, 1.2], [0.3, 1.9], [1.5, 2.25], [1.55, 2.35], [1.35, 2.33], [0.2, 2.05], [0.14, 2.9], [0.0, 2.9]], 24)), stone);
  stem.position.copy(basin.position);
  const fountainWater = kept.add(waterMaterial({ deep: '#3d8fa6', shallow: '#6fbdcc', sky: '#cfe8ff', sun: SUN, sunColor: '#fff6dc', glitter: 0.9, wave: 0.7, speed: 1.4, rough: 0.28 }));
  const pool = new THREE.Mesh(kept.add(new THREE.CircleGeometry(3.56, 40).rotateX(-Math.PI / 2)), fountainWater);
  pool.position.set(l.plaza.x, GROUND + 0.52, l.plaza.z);
  const bowl = new THREE.Mesh(kept.add(new THREE.CircleGeometry(1.36, 24).rotateX(-Math.PI / 2)), fountainWater);
  bowl.position.set(l.plaza.x, GROUND + 2.31, l.plaza.z);
  group.add(basin, stem, pool, bowl);
  const drops = quality === 'low' ? 140 : 420;
  const jets = new Float32Array(drops * 4);
  const dropAt = new Float32Array(drops * 3);
  for (let i = 0; i < drops; i++) {
    const a = random() * Math.PI * 2;
    // One jet straight up from the top; a ring of smaller ones falling outward from the bowl's rim.
    const top = i % 3 === 0;
    const out = top ? 0.25 + random() * 0.3 : 1.0 + random() * 0.35;
    jets.set([Math.cos(a) * out, Math.sin(a) * out, top ? 7.2 + random() * 0.9 : 2.2 + random() * 0.7, random()], i * 4);
    dropAt.set(top ? [0, 2.9, 0] : [Math.cos(a) * 1.3, 2.34, Math.sin(a) * 1.3], i * 3);
  }
  const jetGeo = kept.add(new THREE.BufferGeometry());
  jetGeo.setAttribute('position', new THREE.BufferAttribute(dropAt, 3));
  jetGeo.setAttribute('aJet', new THREE.BufferAttribute(jets, 4));
  const jetMat = kept.add(jetMaterial());
  const spray = new THREE.Points(jetGeo, jetMat);
  spray.position.copy(basin.position);
  spray.frustumCulled = false;
  group.add(spray);

  // ── benches and lamps along the walks ──
  const benchGeo = kept.add(
    merged([
      { geometry: new THREE.BoxGeometry(1.8, 0.07, 0.5), color: '#9a7350', matrix: at(0, 0.45, 0) },
      { geometry: new THREE.BoxGeometry(1.8, 0.4, 0.07), color: '#9a7350', matrix: at(0, 0.78, -0.25, 0, 1, 1, 1, -0.16) },
      { geometry: new THREE.BoxGeometry(0.08, 0.45, 0.5), color: '#2f343c', matrix: at(-0.75, 0.22, 0) },
      { geometry: new THREE.BoxGeometry(0.08, 0.45, 0.5), color: '#2f343c', matrix: at(0.75, 0.22, 0) },
    ]),
  );
  const lampGeo = kept.add(
    merged([
      { geometry: turned([[0.12, 0], [0.12, 0.25], [0.05, 0.4], [0.045, 3.3], [0.1, 3.36], [0.0, 3.36]], 8), color: '#2b3038' },
      { geometry: new THREE.SphereGeometry(0.24, 12, 8), color: '#fbf6e6', matrix: at(0, 3.56, 0) },
    ]),
  );
  const props = kept.add(new THREE.MeshLambertMaterial({ vertexColors: true }));
  const benchAt: THREE.Matrix4[] = [];
  const lampAt: THREE.Matrix4[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const x = l.plaza.x + Math.cos(a) * (l.plaza.r - 1.2);
    const z = l.plaza.z + Math.sin(a) * (l.plaza.r - 1.2);
    if (nearPath(l, x + Math.cos(a) * 3, z + Math.sin(a) * 3, 0.4)) lampAt.push(at(l.plaza.x + Math.cos(a + 0.3) * (l.plaza.r + 0.2), GROUND, l.plaza.z + Math.sin(a + 0.3) * (l.plaza.r + 0.2)));
    else benchAt.push(at(x, GROUND, z, -a - Math.PI / 2));
  }
  for (const p of l.paths.slice(1, 3)) {
    for (let i = 14; i < p.points.length - 6; i += 22) {
      const [x, z] = p.points[i]!;
      const [nx, nz] = p.points[i + 1]!;
      const dir = Math.atan2(nx - x, nz - z);
      const ox = Math.cos(dir) * (p.width / 2 + 0.9);
      const oz = -Math.sin(dir) * (p.width / 2 + 0.9);
      if (Math.max(Math.abs(x), Math.abs(z)) > INNER - 4) continue;
      if (i % 44 < 22) benchAt.push(at(x + ox, GROUND, z + oz, dir - Math.PI / 2));
      else lampAt.push(at(x - ox, GROUND, z - oz));
    }
  }
  for (let z = building.maxZ + 10; z < l.plaza.z - l.plaza.r; z += 8.5) for (const side of [-1, 1]) lampAt.push(at(l.entrance.x + side * 2.9, GROUND, z + 4.2));
  group.add(instanced(benchGeo, props, benchAt), instanced(lampGeo, props, lampAt));

  // ── hot-air balloons over the hills ──
  const balloonColors = [['#e94f37', '#f6f7eb'], ['#3f88c5', '#ffd166'], ['#8e5bd0', '#f6f7eb'], ['#f29e4c', '#2a9d8f'], ['#ef476f', '#ffd166']];
  const balloons = balloonColors.map(([a, b], n) => {
    const envelope = turned([[0, 0], [1.1, 0.4], [3.4, 3.6], [4.9, 7.2], [5.1, 9.4], [4.4, 11.6], [2.6, 13.3], [0, 13.9]], 16);
    // Gores: every other one in the second colour.
    const g = envelope.toNonIndexed();
    envelope.dispose();
    const pos = g.getAttribute('position');
    const col = new Float32Array(pos.count * 3);
    const ca = new THREE.Color(a);
    const cb = new THREE.Color(b);
    for (let i = 0; i < pos.count; i += 3) {
      const mx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
      const mz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
      const my = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
      const gore = Math.floor(((Math.atan2(mz, mx) + Math.PI) / (Math.PI * 2)) * 16 + 0.001);
      const c = (gore + (n % 2 && my > 6 && my < 10 ? 1 : 0)) % 2 ? ca : cb;
      for (let k = 0; k < 3; k++) col.set([c.r, c.g, c.b], (i + k) * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const basket = new THREE.BoxGeometry(1.1, 0.9, 1.1).translate(0, -1.6, 0).toNonIndexed();
    const bc = new Float32Array(basket.getAttribute('position').count * 3);
    for (let i = 0; i < bc.length; i += 3) bc.set([0.42, 0.28, 0.16], i);
    basket.setAttribute('color', new THREE.BufferAttribute(bc, 3));
    const mesh = new THREE.Group();
    mesh.add(new THREE.Mesh(kept.add(g), props), new THREE.Mesh(kept.add(basket), props));
    const angle = (n / balloonColors.length) * Math.PI * 2 + 0.7;
    const spot = { angle, far: 250 + ((n * 97) % 230), high: 70 + ((n * 53) % 90), size: 1.5 + (n % 3) * 0.35 };
    mesh.scale.setScalar(spot.size);
    group.add(mesh);
    return { mesh, spot };
  });

  // ── birds ──
  const birds = flock(kept, quality === 'low' ? 8 : 22, random, [[-60, 50, 26, 20], [90, -70, 38, 29], [30, 120, 50, 38]]);
  group.add(birds.mesh);

  return {
    group,
    update(t) {
      time.value = t;
      pondWater.uniforms.uTime!.value = t;
      fountainWater.uniforms.uTime!.value = t;
      jetMat.uniforms.uTime!.value = t;
      birds.material.uniforms.uTime!.value = t;
      for (const { mesh, spot } of balloons) {
        const a = spot.angle + t * 0.0035;
        mesh.position.set(Math.cos(a) * spot.far, spot.high + Math.sin(t * 0.11 + spot.angle * 3) * 5, Math.sin(a) * spot.far);
        mesh.rotation.y = t * 0.02 + spot.angle;
      }
      boats.forEach((b, i) => {
        b.rotation.set(Math.sin(t * 0.7 + i) * 0.03, 0.6 + i * 1.9 + Math.sin(t * 0.13 + i) * 0.08, Math.sin(t * 0.9 + i * 2) * 0.04);
      });
    },
    dispose() {
      kept.dispose();
    },
  };
}
