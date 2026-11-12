import * as THREE from 'three';
import { ON_SURFACE } from '../surface.ts';
import type { Box } from '../world.ts';
import { Kept, OUTPUT, at, fbm2, grain, instanced, merged, noise2, rng, swaying, waterMaterial } from './kit.ts';
import type { Place, PlaceInput } from './place.ts';

/**
 * A valley deep in snow under the northern lights: mountains all round, pines, a lake that shows the sky, two cabins
 * with their windows lit, lamps along the way down to the water, and snow falling — outside, never into the office.
 *
 * It is night here and the office is lit as ever, so everything outside is painted in night colours: under the
 * office's lamps a white snowfield would be daylight.
 */

const INNER = 135;
const CELL = 27;
const REACH = 1323;
const GROUND = -0.2;
export const NORTH_MOON: [number, number, number] = [0.42, 0.5, -0.76];

/** Sharp ridges: noise folded over on itself. */
function ridged(x: number, z: number): number {
  let sum = 0;
  let amp = 0.55;
  let f = 1;
  for (let i = 0; i < 4; i++) {
    const n = 1 - Math.abs(2 * noise2(x * f, z * f, 31 + i * 7) - 1);
    sum += n * n * amp;
    amp *= 0.5;
    f *= 2.1;
  }
  return sum;
}

/** How high the land is: level round the office and across the lake, then up into the mountains. */
function heightAt(x: number, z: number): number {
  const d = Math.max(Math.abs(x), Math.abs(z));
  if (d <= INNER) return GROUND;
  const r = Math.hypot(x, z);
  const foot = THREE.MathUtils.smoothstep(r, INNER, 330);
  const range = THREE.MathUtils.smoothstep(r, 330, 940);
  return GROUND + foot * (fbm2(x / 150 + 4, z / 150 + 1, 3, 2) * 40 - 8) + range * ridged(x / 520 + 3.3, z / 520 + 1.7) * 380;
}

interface Layout {
  lake: { x: number; z: number; rx: number; rz: number };
  path: Array<[number, number]>;
  lamps: Array<[number, number]>;
  cabin: { x: number; z: number; turn: number };
}

function layoutOf({ building, entrance }: PlaceInput): Layout {
  const lake = { x: entrance.x - 14, z: building.maxZ + 72, rx: 62, rz: 33 };
  const cabin = { x: lake.x + lake.rx + 13, z: lake.z - 16, turn: -2.2 };
  const c = new THREE.CatmullRomCurve3([
    new THREE.Vector3(entrance.x, 0, building.maxZ + 0.5),
    new THREE.Vector3(entrance.x + 2, 0, building.maxZ + 16),
    new THREE.Vector3(entrance.x + 12, 0, lake.z - lake.rz - 10),
    new THREE.Vector3(cabin.x - 9, 0, cabin.z - 11),
    new THREE.Vector3(cabin.x - 3.5, 0, cabin.z - 4.5),
  ]);
  const path = c.getPoints(60).map((p) => [p.x, p.z] as [number, number]);
  const lamps: Array<[number, number]> = [];
  for (let i = 6; i < path.length - 4; i += 9) {
    const [x, z] = path[i]!;
    const [nx, nz] = path[i + 1]!;
    const len = Math.hypot(nx - x, nz - z) || 1;
    const side = (i / 9) % 2 ? 1 : -1;
    lamps.push([x + ((nz - z) / len) * 2.1 * side, z - ((nx - x) / len) * 2.1 * side]);
  }
  return { lake, path, lamps, cabin };
}

function paintSnow(ctx: CanvasRenderingContext2D, size: number, l: Layout, building: PlaceInput['building'], shadows: Array<[number, number, number]>, random: () => number): void {
  const m = size / (2 * INNER);
  const px = (x: number) => (x + INNER) * m;
  const pz = (z: number) => (z + INNER) * m;
  ctx.fillStyle = '#5a6788';
  ctx.fillRect(0, 0, size, size);
  // Drifts: long soft bands, lighter on the side the moon is on.
  for (let i = 0; i < 520; i++) {
    const x = random() * size;
    const y = random() * size;
    const r = (6 + random() * 22) * m;
    const tone = random() < 0.5 ? '128, 146, 190' : '52, 62, 92';
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${tone}, 0.2)`);
    g.addColorStop(1, `rgba(${tone}, 0)`);
    ctx.fillStyle = g;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1.8, 0.6);
    ctx.translate(-x, -y);
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    ctx.restore();
  }
  grain(ctx, size, 5, random);
  // The pines' shadows in the moonlight.
  for (const [x, z, r] of shadows) {
    const sx = px(x - NORTH_MOON[0] * r * 1.6);
    const sz = pz(z - NORTH_MOON[2] * r * 1.6);
    const g = ctx.createRadialGradient(sx, sz, 0, sx, sz, r * 1.7 * m);
    g.addColorStop(0, 'rgba(16, 24, 52, 0.5)');
    g.addColorStop(1, 'rgba(16, 24, 52, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(sx - r * 2 * m, sz - r * 2 * m, r * 4 * m, r * 4 * m);
  }
  // The lake's edge: snow banked up, darker where it meets the ice.
  for (const [grow, color] of [[2.4, '#6a80b0'], [0.9, '#2a3a60']] as const) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(px(l.lake.x), pz(l.lake.z), (l.lake.rx + grow) * m, (l.lake.rz + grow) * m, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // The trodden way, and the cleared ground round the building.
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [width, color] of [[3.4, '#5e74a6'], [2.2, '#34446e']] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width * m;
    ctx.beginPath();
    l.path.forEach(([x, z], i) => (i ? ctx.lineTo(px(x), pz(z)) : ctx.moveTo(px(x), pz(z))));
    ctx.stroke();
  }
  const walk = 2.6;
  ctx.fillStyle = '#5e74a6';
  ctx.fillRect(px(building.minX - walk - 0.6), pz(building.minZ - walk - 0.6), (building.maxX - building.minX + 2 * walk + 1.2) * m, (building.maxZ - building.minZ + 2 * walk + 1.2) * m);
  ctx.fillStyle = '#3a4a74';
  ctx.fillRect(px(building.minX - walk), pz(building.minZ - walk), (building.maxX - building.minX + 2 * walk) * m, (building.maxZ - building.minZ + 2 * walk) * m);
  // Light on the snow: from the office's windows, from each lamp, from the cabin's door.
  const pool = (x: number, z: number, r: number, strength: number) => {
    const g = ctx.createRadialGradient(px(x), pz(z), 0, px(x), pz(z), r * m);
    g.addColorStop(0, `rgba(255, 190, 110, ${strength})`);
    g.addColorStop(0.4, `rgba(255, 170, 90, ${strength * 0.4})`);
    g.addColorStop(1, 'rgba(255, 160, 80, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(px(x - r), pz(z - r), 2 * r * m, 2 * r * m);
  };
  for (let x = building.minX; x <= building.maxX; x += 5.5) {
    pool(x, building.minZ - 2, 7, 0.2);
    pool(x, building.maxZ + 2, 7, 0.2);
  }
  for (let z = building.minZ; z <= building.maxZ; z += 5) {
    pool(building.minX - 2, z, 7, 0.2);
    pool(building.maxX + 2, z, 7, 0.2);
  }
  for (const [x, z] of l.lamps) pool(x, z, 7.5, 0.62);
  pool(l.cabin.x - 3.4, l.cabin.z - 4.4, 7, 0.5);
}

/** Snow in the air: flakes in a box that travels with the camera, falling and drifting from the time alone. */
function snowMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uDry: { value: new THREE.Vector4(-1, -1, 1, 1) } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec4 uDry; // the floor that has a roof over it: min x, min z, max x, max z
      varying float vAlpha;
      const vec3 BOX = vec3(90.0, 46.0, 90.0);
      void main() {
        vec3 p = position;
        p.y -= uTime * (1.5 + fract(position.x * 7.3) * 1.3);
        p.x += sin(uTime * 0.5 + position.z * 0.2) * 0.7 + uTime * 0.6;
        p.z += cos(uTime * 0.4 + position.x * 0.2) * 0.7;
        // Wrapped round the camera: the same flakes, wherever one stands.
        p = mod(p - cameraPosition + BOX * 0.5, BOX) - BOX * 0.5 + cameraPosition;
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float inside = step(uDry.x, p.x) * step(p.x, uDry.z) * step(uDry.y, p.z) * step(p.z, uDry.w);
        vAlpha = (1.0 - inside) * smoothstep(45.0, 30.0, -mv.z) * step(-0.25, p.y);
        gl_PointSize = clamp(120.0 / max(-mv.z, 1.0), 1.4, 5.0) * (0.6 + fract(position.y * 3.7) * 0.8);
        if (vAlpha <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying float vAlpha;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        gl_FragColor = vec4(vec3(0.86, 0.91, 1.0), smoothstep(1.0, 0.3, d) * 0.8 * vAlpha);
        ${OUTPUT}
      }
    `,
  });
}

export function buildNorth(input: PlaceInput): Place {
  const { building, quality } = input;
  const kept = new Kept();
  const group = new THREE.Group();
  const random = rng(60212);
  const l = layoutOf(input);
  const time = { value: 0 };
  const inLake = (x: number, z: number, margin: number) => ((x - l.lake.x) / (l.lake.rx + margin)) ** 2 + ((z - l.lake.z) / (l.lake.rz + margin)) ** 2 < 1;
  const onPath = (x: number, z: number, margin: number) => l.path.some(([px, pz]) => Math.hypot(px - x, pz - z) < margin);

  // ── where the pines stand ──
  interface Pine { x: number; z: number; y: number; size: number; turn: number }
  const pines: Pine[] = [];
  const keep = { minX: building.minX - 27, maxX: building.maxX + 27, minZ: building.minZ - 27, maxZ: building.maxZ + 6 };
  for (let i = 0; i < 400 && pines.length < 120; i++) {
    const x = (random() * 2 - 1) * (INNER - 6);
    const z = (random() * 2 - 1) * (INNER - 6);
    if (x > keep.minX && x < keep.maxX && z > keep.minZ && z < keep.maxZ) continue;
    if (inLake(x, z, 5) || onPath(x, z, 4.5) || Math.hypot(x - l.cabin.x, z - l.cabin.z) < 9) continue;
    // The view from the door down to the lake is left open.
    if (Math.abs(x - input.entrance.x) < 16 && z > building.maxZ && z < l.lake.z) continue;
    if (fbm2(x / 60, z / 60, 2, 8) < 0.42) continue;
    if (pines.some((p) => Math.hypot(p.x - x, p.z - z) < 4.2)) continue;
    pines.push({ x, z, y: GROUND, size: 0.8 + random() * 0.9, turn: random() * 6 });
  }
  const onLawn = pines.length;
  const more = quality === 'low' ? 360 : 900;
  for (let i = 0; i < more * 4 && pines.length < onLawn + more; i++) {
    const a = random() * Math.PI * 2;
    const d = INNER + 4 + Math.pow(random(), 1.3) * 560;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    if (Math.max(Math.abs(x), Math.abs(z)) < INNER + 3) continue;
    const y = heightAt(x, z);
    // Up to the tree line, and in woods rather than evenly.
    if (y > 150 || fbm2(x / 110, z / 110, 3, 6) < 0.45) continue;
    pines.push({ x, z, y: y - 0.4, size: 1 + random() * 1.1, turn: random() * 6 });
  }

  // ── the snow near the office: one painted surface ──
  const snow = kept.add(new THREE.CanvasTexture(document.createElement('canvas')));
  {
    const canvas = snow.image as HTMLCanvasElement;
    canvas.width = canvas.height = quality === 'low' ? 1024 : 2048;
    paintSnow(canvas.getContext('2d')!, canvas.width, l, building, pines.slice(0, onLawn).map((p) => [p.x, p.z, 2.2 * p.size] as [number, number, number]), random);
    snow.colorSpace = THREE.SRGBColorSpace;
    snow.anisotropy = 16;
    snow.needsUpdate = true;
  }
  const field = new THREE.Mesh(kept.add(new THREE.PlaneGeometry(2 * INNER, 2 * INNER).rotateX(-Math.PI / 2)), kept.add(new THREE.MeshLambertMaterial({ map: snow })));
  field.position.y = GROUND;
  field.receiveShadow = true;
  group.add(field);

  // ── the mountains ──
  {
    const tones = kept.add(new THREE.CanvasTexture(document.createElement('canvas')));
    const canvas = tones.image as HTMLCanvasElement;
    const res = quality === 'low' ? 256 : 512;
    canvas.width = canvas.height = res;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(res, res);
    const flat = new THREE.Color('#5a6788');
    const high = new THREE.Color('#93a3c8');
    const rock = new THREE.Color('#1c2438');
    const wood = new THREE.Color('#1d2f3c');
    const c = new THREE.Color();
    const step = (2 * REACH) / res;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = ((i + 0.5) / res - 0.5) * 2 * REACH;
        const z = ((j + 0.5) / res - 0.5) * 2 * REACH;
        const y = heightAt(x, z);
        // Steep ground holds no snow; the side turned to the moon is the lighter one.
        const dx = (heightAt(x + step, z) - y) / step;
        const dz = (heightAt(x, z + step) - y) / step;
        const steep = Math.hypot(dx, dz);
        const lit = THREE.MathUtils.clamp(0.5 - (dx * NORTH_MOON[0] + dz * NORTH_MOON[2]) * 0.55, 0, 1);
        c.copy(flat).lerp(high, THREE.MathUtils.smoothstep(y, 30, 330) * lit);
        c.lerp(wood, THREE.MathUtils.smoothstep(fbm2(x / 110, z / 110, 3, 6), 0.45, 0.55) * (1 - THREE.MathUtils.smoothstep(y, 110, 170)) * THREE.MathUtils.smoothstep(Math.max(Math.abs(x), Math.abs(z)), INNER, INNER + 40) * 0.8);
        c.lerp(rock, THREE.MathUtils.smoothstep(steep, 0.75, 1.25) * (0.55 + 0.45 * fbm2(x / 30, z / 30, 2, 12)));
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
    const index = land.getIndex()!;
    const faces: number[] = [];
    for (let i = 0; i < index.count; i += 3) {
      const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
      const mx = (p.getX(ids[0]!) + p.getX(ids[1]!) + p.getX(ids[2]!)) / 3;
      const mz = (p.getZ(ids[0]!) + p.getZ(ids[1]!) + p.getZ(ids[2]!)) / 3;
      if (Math.abs(mx) < INNER && Math.abs(mz) < INNER) continue;
      faces.push(...ids);
    }
    land.setIndex(faces);
    land.computeVertexNormals();
    group.add(new THREE.Mesh(kept.add(land), kept.add(new THREE.MeshLambertMaterial({ map: tones }))));
  }

  // ── pines ──
  const tier = (r: number, h: number, y: number) => [
    { geometry: new THREE.ConeGeometry(r, h, 8), color: '#16302a', matrix: at(0, y + h / 2, 0) },
    // Snow lying on each tier of branches.
    { geometry: new THREE.ConeGeometry(r * 0.8, h * 0.55, 8), color: '#7f95c4', matrix: at(0, y + h * 0.75, 0) },
  ];
  const pineGeo = kept.add(merged([{ geometry: new THREE.CylinderGeometry(0.16, 0.24, 1.6, 6), color: '#2a2019', matrix: at(0, 0.8, 0) }, ...tier(2.1, 2.9, 1.0), ...tier(1.65, 2.6, 2.6), ...tier(1.2, 2.3, 4.1), ...tier(0.75, 2.0, 5.5)]));
  const needles = kept.add(new THREE.MeshLambertMaterial({ vertexColors: true }));
  swaying(needles, time, 0.5);
  group.add(instanced(pineGeo, needles, pines.map((p) => at(p.x, p.y, p.z, p.turn, p.size, p.size * (1 + ((p.turn * 3) % 1) * 0.35), p.size))));

  // ── the lake: still enough to show the lights ──
  const ice = kept.add(waterMaterial({ deep: '#081424', shallow: '#0d2030', sky: '#2a9070', sun: NORTH_MOON, sunColor: '#dfe9ff', glitter: 0.9, wave: 5, speed: 0.25, rough: 0.035, lights: 1, lightsColor: '#7a4fd0' }));
  Object.assign(ice, ON_SURFACE);
  const lake = new THREE.Mesh(kept.add(new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2)), ice);
  lake.position.set(l.lake.x, GROUND + 0.02, l.lake.z);
  lake.scale.set(l.lake.rx, 1, l.lake.rz);
  group.add(lake);

  // ── cabins: logs, a roof under snow, the windows lit ──
  const cabinGeo = kept.add(
    merged([
      { geometry: new THREE.BoxGeometry(7, 2.8, 5.4), color: '#3a2a20', matrix: at(0, 1.4, 0) },
      // The roof: two slopes, with what has fallen on them.
      { geometry: new THREE.BoxGeometry(7.8, 0.3, 3.7), color: '#7f95c4', matrix: at(0, 3.75, 1.5, 0, 1, 1, 1, 0.62) },
      { geometry: new THREE.BoxGeometry(7.8, 0.3, 3.7), color: '#7f95c4', matrix: at(0, 3.75, -1.5, 0, 1, 1, 1, -0.62) },
      { geometry: new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-3.5, 2.8, -2.7, -3.5, 2.8, 2.7, -3.5, 4.7, 0, 3.5, 2.8, 2.7, 3.5, 2.8, -2.7, 3.5, 4.7, 0], 3)), color: '#3a2a20' },
      { geometry: new THREE.BoxGeometry(0.8, 1.9, 0.8), color: '#2a2c33', matrix: at(2.1, 4.6, 0.9) },
      { geometry: new THREE.BoxGeometry(1.0, 0.16, 1.0), color: '#7f95c4', matrix: at(2.1, 5.62, 0.9) },
    ]),
  );
  const lit = kept.add(new THREE.MeshBasicMaterial({ color: '#ffc46a' }));
  lit.toneMapped = false;
  const windowGeo = kept.add(
    merged([
      { geometry: new THREE.PlaneGeometry(1.1, 1.0), color: '#ffffff', matrix: at(-1.9, 1.6, 2.72) },
      { geometry: new THREE.PlaneGeometry(1.1, 1.0), color: '#ffffff', matrix: at(1.9, 1.6, 2.72) },
      { geometry: new THREE.PlaneGeometry(0.9, 1.9), color: '#ffffff', matrix: at(0, 0.98, 2.72) },
      { geometry: new THREE.PlaneGeometry(1.1, 1.0), color: '#ffffff', matrix: at(0, 1.6, -2.72, Math.PI) },
      { geometry: new THREE.PlaneGeometry(1.1, 1.0), color: '#ffffff', matrix: at(3.52, 1.6, 0, Math.PI / 2) },
      { geometry: new THREE.PlaneGeometry(1.1, 1.0), color: '#ffffff', matrix: at(-3.52, 1.6, 0, -Math.PI / 2) },
    ]),
  );
  const far = { x: -260, z: -120 };
  const cabins = [at(l.cabin.x, GROUND, l.cabin.z, l.cabin.turn), at(far.x, heightAt(far.x, far.z) - 0.2, far.z, 0.8, 1.2), at(far.x + 22, heightAt(far.x + 22, far.z + 9) - 0.2, far.z + 9, 2.4, 1.2)];
  group.add(instanced(cabinGeo, needles, cabins), instanced(windowGeo, lit, cabins));

  // ── lamps along the way ──
  const lampGeo = kept.add(merged([{ geometry: new THREE.CylinderGeometry(0.05, 0.08, 3.1, 6), color: '#161a22', matrix: at(0, 1.55, 0) }, { geometry: new THREE.BoxGeometry(0.42, 0.06, 0.42), color: '#7f95c4', matrix: at(0, 3.5, 0) }]));
  const lampAt = l.lamps.map(([x, z]) => at(x, GROUND, z));
  group.add(instanced(lampGeo, needles, lampAt), instanced(kept.add(new THREE.BoxGeometry(0.3, 0.36, 0.3).translate(0, 3.27, 0)), lit, lampAt));

  // ── somebody built a snowman by the door ──
  const snowman = new THREE.Mesh(
    kept.add(
      merged([
        { geometry: new THREE.SphereGeometry(0.62, 14, 10), color: '#8ea4d2', matrix: at(0, 0.55, 0) },
        { geometry: new THREE.SphereGeometry(0.45, 14, 10), color: '#8ea4d2', matrix: at(0, 1.4, 0) },
        { geometry: new THREE.SphereGeometry(0.32, 14, 10), color: '#8ea4d2', matrix: at(0, 2.02, 0) },
        { geometry: new THREE.ConeGeometry(0.06, 0.34, 6), color: '#e0762a', matrix: at(0, 2.02, 0.44, 0, 1, 1, 1, Math.PI / 2) },
        { geometry: new THREE.TorusGeometry(0.33, 0.07, 6, 14), color: '#b83232', matrix: at(0, 1.74, 0, 0, 1, 1, 1, Math.PI / 2) },
        { geometry: new THREE.CylinderGeometry(0.2, 0.22, 0.3, 10), color: '#14161c', matrix: at(0, 2.42, 0) },
        { geometry: new THREE.CylinderGeometry(0.34, 0.34, 0.04, 10), color: '#14161c', matrix: at(0, 2.28, 0) },
        { geometry: new THREE.SphereGeometry(0.04, 6, 4), color: '#14161c', matrix: at(-0.12, 2.1, 0.29) },
        { geometry: new THREE.SphereGeometry(0.04, 6, 4), color: '#14161c', matrix: at(0.12, 2.1, 0.29) },
      ]),
    ),
    needles,
  );
  snowman.position.set(input.entrance.x + 6.2, GROUND, building.maxZ + 6.5);
  snowman.rotation.y = -0.5;
  group.add(snowman);

  // ── the snow that is falling ──
  const count = quality === 'low' ? 900 : 3200;
  const flakes = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) flakes.set([random() * 90, random() * 46, random() * 90], i * 3);
  const flakeGeo = kept.add(new THREE.BufferGeometry());
  flakeGeo.setAttribute('position', new THREE.BufferAttribute(flakes, 3));
  const flakeMat = kept.add(snowMaterial());
  const fall = new THREE.Points(flakeGeo, flakeMat);
  fall.frustumCulled = false;
  fall.renderOrder = 4;
  group.add(fall);

  return {
    group,
    setFloor(floor) {
      (flakeMat.uniforms.uDry!.value as THREE.Vector4).set(floor.minX - 0.3, floor.minZ - 0.3, floor.maxX + 0.3, floor.maxZ + 0.3);
    },
    update(t) {
      time.value = t;
      ice.uniforms.uTime!.value = t;
      flakeMat.uniforms.uTime!.value = t;
    },
    dispose() {
      kept.dispose();
    },
  };
}
