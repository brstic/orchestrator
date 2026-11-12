import * as THREE from 'three';
import type { Box } from '../world.ts';
import { Kept, at, fbm2, flock, instanced, merged, painted, rng, shoreTexture, swaying, turned, waterMaterial } from './kit.ts';
import type { Footing, Place, PlaceInput } from './place.ts';

/**
 * A small island at sunset: the office on a deck above the sand, palms leaning in the wind, a pier out towards the
 * sun with a boat at its end, shallows turning from clear to deep, sails far out, a lighthouse on a rock.
 */

const GROUND = -0.2;
const SEA = -1.05;
export const ISLAND_SUN: [number, number, number] = [-0.92, 0.1, 0.28];

/** How far from the middle the water starts, in each direction: a rounded shape, longer one way. */
function shore(angle: number): number {
  return 82 + 10 * Math.sin(angle * 2 + 1) + 6 * Math.sin(angle * 3 + 2.2) + 4 * Math.sin(angle * 5 + 0.5);
}

/** How high the sand is: a level top, a beach that slopes to the water, and the bottom falling away beyond. */
function sandAt(t: number): number {
  if (t < 0.7) return GROUND;
  if (t < 1) return GROUND + (SEA - GROUND) * Math.pow((t - 0.7) / 0.3, 1.25);
  return SEA - (t - 1) * 10;
}

function palm(bend: number, height: number): { trunk: THREE.BufferGeometry; crown: THREE.BufferGeometry; top: THREE.Vector3 } {
  // The trunk leans, more towards its top.
  const points = Array.from({ length: 7 }, (_, i) => {
    const u = i / 6;
    return new THREE.Vector3(bend * u * u * height * 0.34, u * height, 0);
  });
  const path = new THREE.CatmullRomCurve3(points);
  const trunk = new THREE.TubeGeometry(path, 10, 0.19, 7);
  // Thicker at the foot.
  const tp = trunk.getAttribute('position');
  for (let i = 0; i < tp.count; i++) {
    const k = 1 + 0.5 * Math.max(0, 1 - tp.getY(i) / (height * 0.35));
    const centre = path.getPoint(Math.min(1, Math.max(0, tp.getY(i) / height)));
    tp.setX(i, centre.x + (tp.getX(i) - centre.x) * k);
    tp.setZ(i, (tp.getZ(i) - centre.z) * k);
  }
  const top = points[points.length - 1]!.clone();
  const parts: Array<{ geometry: THREE.BufferGeometry; color: string | THREE.Color; matrix?: THREE.Matrix4 }> = [];
  const leaves = 11;
  for (let n = 0; n < leaves; n++) {
    const length = 3.6 + ((n * 37) % 10) * 0.09;
    const leaf = new THREE.PlaneGeometry(1.05, length, 2, 7);
    const p = leaf.getAttribute('position');
    const droop = 0.75 + ((n * 13) % 7) * 0.09;
    for (let i = 0; i < p.count; i++) {
      const u = p.getY(i) / length + 0.5; // 0 at the stem, 1 at the tip
      const across = p.getX(i);
      const wide = Math.sin(Math.min(1, u * 1.15 + 0.08) * Math.PI) * 0.95 + 0.05;
      // Out from the crown, rising a little and then hanging; folded along its middle.
      p.setXYZ(i, across * wide, Math.sin(u * 1.5) * 0.9 - u * u * 2.3 * droop - Math.abs(across) * 0.42 * wide, u * length);
    }
    leaf.computeVertexNormals();
    const tone = new THREE.Color().setHSL(0.27 + ((n * 7) % 5) * 0.012, 0.5, 0.25 + ((n * 11) % 6) * 0.018);
    parts.push({ geometry: leaf, color: tone, matrix: at(top.x, top.y - 0.05, top.z, (n / leaves) * Math.PI * 2 + (n % 2) * 0.2, 1, 1, 1, -0.25 + (n % 3) * 0.2) });
  }
  for (let n = 0; n < 3; n++) parts.push({ geometry: new THREE.SphereGeometry(0.2, 8, 6), color: '#4a3524', matrix: at(top.x + Math.cos(n * 2.1) * 0.25, top.y - 0.3, top.z + Math.sin(n * 2.1) * 0.25) });
  return { trunk, crown: merged(parts), top };
}

export function buildIsland({ building, quality }: PlaceInput): Place {
  const kept = new Kept();
  const group = new THREE.Group();
  const random = rng(9041);
  const time = { value: 0 };

  // ── the sand ──
  {
    const rings = [0, 0.2, 0.4, 0.55, 0.66, 0.72, 0.78, 0.84, 0.89, 0.93, 0.96, 0.98, 1.0, 1.02, 1.05, 1.1, 1.18, 1.3, 1.5];
    const around = 128;
    const positions: number[] = [];
    const colors: number[] = [];
    const dry = new THREE.Color('#e3c690');
    const pale = new THREE.Color('#f0dcae');
    const wet = new THREE.Color('#a8875a');
    const under = new THREE.Color('#c9d4a8');
    const c = new THREE.Color();
    for (const t of rings) {
      for (let j = 0; j <= around; j++) {
        const a = (j / around) * Math.PI * 2 - Math.PI;
        const r = t * shore(a);
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        positions.push(x, sandAt(t), z);
        c.copy(dry).lerp(pale, fbm2(x / 14, z / 14, 3, 4));
        if (t > 0.86) c.lerp(wet, THREE.MathUtils.smoothstep(t, 0.86, 0.985) * 0.85);
        if (t > 1) c.lerp(under, THREE.MathUtils.smoothstep(t, 1, 1.12));
        colors.push(c.r, c.g, c.b);
      }
    }
    const indices: number[] = [];
    for (let i = 0; i < rings.length - 1; i++) {
      for (let j = 0; j < around; j++) {
        const a = i * (around + 1) + j;
        const b = a + around + 1;
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const sand = kept.add(new THREE.BufferGeometry());
    sand.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    sand.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    sand.setIndex(indices);
    sand.computeVertexNormals();
    const ripples = kept.add(
      painted(256, (ctx, s) => {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, s, s);
        // The wind's small ridges.
        for (let y = 0; y < s; y += 8) {
          ctx.strokeStyle = 'rgba(150, 120, 80, 0.16)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let x = 0; x <= s; x += 8) ctx.lineTo(x, y + Math.sin((x / s) * Math.PI * 4 + y) * 2.2);
          ctx.stroke();
        }
      }),
    );
    const mat = kept.add(new THREE.MeshLambertMaterial({ vertexColors: true, map: ripples }));
    // The picture repeats by where a point is, not by the shape's own corners.
    const uv = new Float32Array((positions.length / 3) * 2);
    for (let i = 0; i < positions.length / 3; i++) uv.set([positions[i * 3]! / 6, positions[i * 3 + 2]! / 6], i * 2);
    sand.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const mesh = new THREE.Mesh(sand, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // ── the sea ──
  const shoreTex = kept.add(shoreTexture(shore));
  const sea = kept.add(waterMaterial({ deep: '#1d5378', shallow: '#48cfc4', sky: '#f0a890', sun: ISLAND_SUN, sunColor: '#ffd2a2', glitter: 1.5, wave: 11, speed: 1, rough: 0.36, shore: shoreTex }));
  const water = new THREE.Mesh(kept.add(new THREE.PlaneGeometry(5200, 5200).rotateX(-Math.PI / 2)), sea);
  water.position.y = SEA;
  water.renderOrder = 1;
  group.add(water);

  // ── palms ──
  const keep = { minX: building.minX - 27, maxX: building.maxX + 27, minZ: building.minZ - 27, maxZ: building.maxZ + 6 };
  const bark = kept.add(new THREE.MeshLambertMaterial({ color: '#8a6a4c' }));
  const fronds = kept.add(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  swaying(fronds, time, 2.2);
  swaying(bark, time, 1.1);
  const kinds = [palm(1, 8.6), palm(0.45, 7.2), palm(1.5, 9.6)];
  const spots: Array<{ x: number; z: number; turn: number; size: number; kind: number }> = [];
  const wanted = quality === 'low' ? 20 : 52;
  for (let i = 0; i < 600 && spots.length < wanted; i++) {
    const a = random() * Math.PI * 2;
    const t = 0.5 + random() * 0.4;
    const x = Math.cos(a) * t * shore(a);
    const z = Math.sin(a) * t * shore(a);
    if (x > keep.minX && x < keep.maxX && z > keep.minZ && z < keep.maxZ) continue;
    // The way to the pier stays open.
    if (x < 0 && Math.abs(z - (building.maxZ + 6)) < 5.5) continue;
    if (spots.some((s) => Math.hypot(s.x - x, s.z - z) < 5.5)) continue;
    // A palm leans out towards the water.
    spots.push({ x, z, turn: -a + (random() - 0.5) * 0.9, size: 0.85 + random() * 0.4, kind: Math.floor(random() * kinds.length) });
  }
  kinds.forEach((k, n) => {
    kept.add(k.trunk);
    kept.add(k.crown);
    const m = spots.filter((s) => s.kind === n).map((s) => at(s.x, sandAt(Math.hypot(s.x, s.z) / shore(Math.atan2(s.z, s.x))) - 0.1, s.z, s.turn, s.size));
    group.add(instanced(k.trunk, bark, m), instanced(k.crown, fronds, m));
  });

  // ── rocks along the water, and out in it ──
  const rockAt: THREE.Matrix4[] = [];
  const rockTint: THREE.Color[] = [];
  const rock = (x: number, y: number, z: number, s: number) => {
    rockAt.push(at(x, y, z, random() * 6, s * (0.8 + random() * 0.6), s * (0.5 + random() * 0.4), s * (0.8 + random() * 0.6), random() * 0.5, random() * 0.5));
    rockTint.push(new THREE.Color().setHSL(0.07 + random() * 0.04, 0.12, 0.2 + random() * 0.1));
  };
  for (let i = 0; i < 46; i++) {
    const a = random() * Math.PI * 2;
    const t = 0.94 + random() * 0.14;
    // Not where the pier lands.
    if (Math.abs(a) > 2.7) continue;
    rock(Math.cos(a) * t * shore(a), sandAt(t) + 0.1, Math.sin(a) * t * shore(a), 0.5 + random() * 1.1);
  }
  // The lighthouse's rock, and a smaller island with its own palms.
  const light = { x: -310, z: 215 };
  for (let i = 0; i < 16; i++) rock(light.x + (random() - 0.5) * 30, SEA + random() * 2.5, light.z + (random() - 0.5) * 26, 5 + random() * 6);
  const islet = { x: 210, z: -250 };
  for (let i = 0; i < 12; i++) rock(islet.x + (random() - 0.5) * 44, SEA - 0.5 + random() * 1.4, islet.z + (random() - 0.5) * 30, 6 + random() * 7);
  group.add(instanced(kept.add(new THREE.IcosahedronGeometry(1, 1)), kept.add(new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true })), rockAt, rockTint));
  const isletPalms = [0, 1, 2, 3, 4].map((n) => at(islet.x + (n - 2) * 6 + random() * 3, SEA + 1.2, islet.z + (random() - 0.5) * 12, random() * 6, 1.1 + random() * 0.4));
  group.add(instanced(kinds[0]!.trunk, bark, isletPalms), instanced(kinds[0]!.crown, fronds, isletPalms));
  // Land on the horizon: low hills in the haze.
  const hills = kept.add(new THREE.MeshLambertMaterial({ color: '#4a4660' }));
  const hill = kept.add(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2));
  const hillAt: THREE.Matrix4[] = [];
  for (const [hx, hz, wide, high] of [[900, -1250, 520, 95], [-1150, -1000, 420, 80], [1400, 700, 380, 70]] as const) {
    // A coast is never one mound: several, of different heights, run into each other.
    for (let n = 0; n < 5; n++) hillAt.push(at(hx + (n - 2) * wide * 0.42 + random() * 60, SEA - 2, hz + (random() - 0.5) * 120, random() * 0.6, wide * (0.35 + random() * 0.35), high * (0.45 + random() * 0.7), wide * 0.3));
  }
  group.add(instanced(hill, hills, hillAt));

  // ── low green between the palms: the island is not bare ──
  const shrubAt: THREE.Matrix4[] = [];
  const shrubTint: THREE.Color[] = [];
  for (const s of spots) {
    const n = 1 + Math.floor(random() * 4);
    for (let k = 0; k < n; k++) {
      const x = s.x + (random() - 0.5) * 7;
      const z = s.z + (random() - 0.5) * 7;
      if (x > keep.minX + 16 && x < keep.maxX - 16 && z > keep.minZ + 16 && z < keep.maxZ + 6) continue;
      if (x < 0 && Math.abs(z - (building.maxZ + 6)) < 3.5) continue;
      const size = 0.4 + random() * 0.7;
      shrubAt.push(at(x, GROUND + 0.1, z, random() * 6, size * 1.3, size * 0.7, size * 1.3));
      shrubTint.push(new THREE.Color().setHSL(0.24 + random() * 0.08, 0.42, 0.2 + random() * 0.1));
    }
  }
  group.add(instanced(kept.add(new THREE.IcosahedronGeometry(1, 1)), kept.add(new THREE.MeshLambertMaterial({ color: '#ffffff' })), shrubAt, shrubTint));

  // ── the lighthouse ──
  const tower = new THREE.Group();
  const white = kept.add(new THREE.MeshLambertMaterial({ vertexColors: true }));
  const shaft = kept.add(
    merged([
      { geometry: turned([[3.2, 0], [2.9, 6], [2.9, 6.01]], 16), color: '#e9e4d8' },
      { geometry: turned([[2.9, 6], [2.6, 12], [2.6, 12.01]], 16), color: '#c4463a' },
      { geometry: turned([[2.6, 12], [2.3, 18], [2.3, 18.01]], 16), color: '#e9e4d8' },
      { geometry: turned([[2.3, 18], [2.05, 23], [2.9, 23.2], [2.9, 23.6], [0, 23.6]], 16), color: '#c4463a' },
      { geometry: turned([[1.7, 26.4], [1.9, 26.6], [0, 28.4]], 12), color: '#2c2f36' },
    ]),
  );
  tower.add(new THREE.Mesh(shaft, white));
  const lampMat = kept.add(new THREE.MeshBasicMaterial({ color: '#fff0c0' }));
  lampMat.toneMapped = false;
  const lamp = new THREE.Mesh(kept.add(new THREE.CylinderGeometry(1.5, 1.5, 2.6, 12).translate(0, 25, 0)), lampMat);
  tower.add(lamp);
  // Two beams that go round: long, thin, brighter at the lamp.
  const beamMat = kept.add(
    new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {},
      vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `precision highp float; varying vec2 vUv; void main() { float a = (1.0 - vUv.x) * (1.0 - vUv.x) * smoothstep(0.5, 0.0, abs(vUv.y - 0.5)) * 0.5; gl_FragColor = vec4(vec3(1.0, 0.93, 0.72) * a, a); }`,
    }),
  );
  const beams = new THREE.Group();
  for (const turn of [0, Math.PI]) {
    for (const tilt of [0, Math.PI / 2]) {
      const g = kept.add(new THREE.PlaneGeometry(240, 9).translate(120, 0, 0));
      const p = g.getAttribute('position');
      // Narrow at the lamp, wide far out.
      for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) * (0.16 + (p.getX(i) / 240) * 1.6));
      const beam = new THREE.Mesh(g, beamMat);
      beam.rotation.set(tilt, turn, 0, 'YXZ');
      beams.add(beam);
    }
  }
  beams.position.y = 25;
  tower.add(beams);
  tower.position.set(light.x, SEA + 2.4, light.z);
  tower.scale.setScalar(1.25);
  group.add(tower);

  // ── sails far out ──
  const sailGeo = kept.add(
    merged([
      { geometry: new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), color: '#2c3a52', matrix: at(0, 0.9, 0, 0, 1.3, 1.1, 5.2) },
      { geometry: new THREE.CylinderGeometry(0.09, 0.09, 13, 5), color: '#d8d2c4', matrix: at(0, 7.4, 0.6) },
      { geometry: new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 1.6, 0.45, 0, 13.6, 0.5, 0, 1.6, -4.6], 3)), color: '#fff3e2' },
      { geometry: new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 1.9, 0.8, 0, 11.8, 0.7, 0, 1.6, 4.8], 3)), color: '#ffe4c8' },
    ]),
  );
  const sailMat = kept.add(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  const sails = [
    { far: 330, angle: 2.5, speed: 0.006, size: 1.6 },
    { far: 520, angle: 3.6, speed: -0.004, size: 1.9 },
    { far: 420, angle: 0.4, speed: 0.005, size: 1.5 },
    { far: 700, angle: 2.95, speed: 0.003, size: 2.2 },
  ].map((s) => {
    const mesh = new THREE.Mesh(sailGeo, sailMat);
    mesh.scale.setScalar(s.size);
    group.add(mesh);
    return { mesh, ...s };
  });

  // ── gulls ──
  const gulls = flock(kept, quality === 'low' ? 6 : 16, random, [[-70, 30, 30, 16], [40, 80, 44, 24]], [0.93, 0.91, 0.88], 1.15);
  group.add(gulls.mesh);

  return {
    group,
    update(t) {
      time.value = t;
      sea.uniforms.uTime!.value = t;
      gulls.material.uniforms.uTime!.value = t;
      beams.rotation.y = t * 0.45;
      for (const s of sails) {
        const a = s.angle + t * s.speed;
        s.mesh.position.set(Math.cos(a) * s.far, SEA - 0.25 + Math.sin(t * 0.6 + s.far) * 0.18, Math.sin(a) * s.far);
        s.mesh.rotation.set(Math.sin(t * 0.5 + s.far) * 0.03, -a + (s.speed > 0 ? Math.PI : 0), 0.08 + Math.sin(t * 0.4 + s.angle) * 0.03);
      }
    },
    dispose() {
      kept.dispose();
    },
  };
}

/** The deck the office stands on, the walk to the pier, the pier, and the boat tied up at its end. */
export function buildDeck(plate: Box): Footing {
  const kept = new Kept();
  const group = new THREE.Group();
  const w = plate.maxX - plate.minX;
  const d = plate.maxZ - plate.minZ;
  const planks = (rx: number, rz: number) =>
    kept.add(
      painted(256, (ctx, s) => {
        ctx.fillStyle = '#8f6c4a';
        ctx.fillRect(0, 0, s, s);
        const n = 8;
        for (let i = 0; i < n; i++) {
          const v = 128 + ((i * 37) % 5) * 9;
          ctx.fillStyle = `rgb(${v + 22},${v - 12},${v - 52})`;
          ctx.fillRect(0, (i * s) / n + 1, s, s / n - 2);
          // Where one board ends and the next begins.
          ctx.fillStyle = 'rgba(50, 34, 20, 0.6)';
          ctx.fillRect(((i * 97) % 200) + 20, (i * s) / n, 2, s / n);
        }
      }, [rx, rz]),
    );
  const timber = (map: THREE.Texture) => kept.add(new THREE.MeshStandardMaterial({ map, roughness: 0.8 }));
  const deck = new THREE.Mesh(kept.add(new THREE.BoxGeometry(w, 0.16, d)), timber(planks(w / 7, d / 1.6)));
  deck.position.set((plate.minX + plate.maxX) / 2, GROUND + 0.02, (plate.minZ + plate.maxZ) / 2);
  deck.receiveShadow = true;
  group.add(deck);

  // The pier: out towards the sun from the deck's south-west, over the sand and then over the water.
  const pz = plate.maxZ - 3;
  const end = -(shore(Math.PI) + 34);
  const length = plate.minX - end;
  const pier = new THREE.Mesh(kept.add(new THREE.BoxGeometry(length, 0.14, 2.6)), timber(planks(length / 7, 1.6)));
  pier.position.set((plate.minX + end) / 2, GROUND + 0.01, pz);
  const head = new THREE.Mesh(kept.add(new THREE.BoxGeometry(7, 0.14, 8)), timber(planks(1, 5)));
  head.position.set(end - 3.5 + 0.01, GROUND + 0.012, pz);
  group.add(pier, head);
  const postAt: THREE.Matrix4[] = [];
  const lampAt: THREE.Matrix4[] = [];
  for (let x = plate.minX - 3; x > end; x -= 4.2) {
    for (const side of [-1, 1]) postAt.push(at(x, GROUND - 2.2, pz + side * 1.2, 0, 1, 1, 1));
    if (Math.round((plate.minX - x) / 4.2) % 3 === 1) lampAt.push(at(x, GROUND + 0.08, pz + 1.15));
  }
  for (const [dx, dz] of [[-0.4, -3.8], [-0.4, 3.8], [-6.6, -3.8], [-6.6, 3.8]] as const) postAt.push(at(end + dx, GROUND - 2.2, pz + dz));
  const dark = kept.add(new THREE.MeshLambertMaterial({ color: '#5a4230' }));
  group.add(instanced(kept.add(new THREE.CylinderGeometry(0.13, 0.13, 4.6, 6)), dark, postAt));
  // Lanterns along one side, already lit.
  const lantern = kept.add(
    merged([
      { geometry: new THREE.CylinderGeometry(0.035, 0.035, 1.1, 5), color: '#3a2c20', matrix: at(0, 0.55, 0) },
      { geometry: new THREE.BoxGeometry(0.2, 0.26, 0.2), color: '#fff0c0', matrix: at(0, 1.2, 0) },
      { geometry: new THREE.ConeGeometry(0.2, 0.14, 4), color: '#3a2c20', matrix: at(0, 1.4, 0, Math.PI / 4) },
    ]),
  );
  const glow = kept.add(new THREE.MeshBasicMaterial({ vertexColors: true }));
  group.add(instanced(lantern, glow, lampAt));

  // The boat at the pier's head.
  const boat = new THREE.Group();
  const hull = kept.add(
    merged([
      { geometry: new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), color: '#f4efe4', matrix: at(0, 0.75, 0, 0, 1.25, 0.95, 4.2) },
      { geometry: new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2), color: '#a07a52', matrix: at(0, 0.6, 0, 0, 1.1, 1, 3.9) },
      { geometry: new THREE.TorusGeometry(1, 0.05, 6, 24), color: '#1f5d8a', matrix: at(0, 0.75, 0, 0, 1.26, 4.22, 1, Math.PI / 2) },
      { geometry: new THREE.CylinderGeometry(0.07, 0.07, 8.5, 6), color: '#d8d2c4', matrix: at(0, 4.9, 0.5) },
      { geometry: new THREE.CylinderGeometry(0.05, 0.05, 3.9, 6), color: '#d8d2c4', matrix: at(0, 1.5, -1.45, 0, 1, 1, 1, Math.PI / 2) },
      { geometry: new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([0, 1.6, 0.4, 0, 9.0, 0.45, 0, 1.6, -3.3], 3)), color: '#fff3e2' },
    ]),
  );
  boat.add(new THREE.Mesh(hull, kept.add(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }))));
  boat.position.set(end - 3.5, SEA - 0.35, pz + 6.4);
  group.add(boat);

  // Chairs and parasols on the deck's sunny side.
  const parasol = kept.add(
    merged([
      { geometry: new THREE.CylinderGeometry(0.03, 0.03, 2.3, 5), color: '#d8d2c4', matrix: at(0, 1.15, 0) },
      ...Array.from({ length: 8 }, (_, n) => ({ geometry: new THREE.ConeGeometry(1.5, 0.5, 8, 1, true, (n / 8) * Math.PI * 2, Math.PI / 4), color: n % 2 ? '#f4efe4' : '#e2574c', matrix: at(0, 2.3, 0) })),
      { geometry: new THREE.BoxGeometry(0.62, 0.07, 1.9), color: '#f4efe4', matrix: at(-0.85, 0.3, 0.1, 0, 1, 1, 1, -0.06) },
      { geometry: new THREE.BoxGeometry(0.62, 0.07, 0.75), color: '#f4efe4', matrix: at(-0.85, 0.52, -1.1, 0, 1, 1, 1, 0.75) },
      { geometry: new THREE.BoxGeometry(0.62, 0.07, 1.9), color: '#f4efe4', matrix: at(0.85, 0.3, 0.1, 0, 1, 1, 1, -0.06) },
      { geometry: new THREE.BoxGeometry(0.62, 0.07, 0.75), color: '#f4efe4', matrix: at(0.85, 0.52, -1.1, 0, 1, 1, 1, 0.75) },
    ]),
  );
  const shade = kept.add(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  const parasolAt: THREE.Matrix4[] = [];
  for (let z = plate.minZ + 5; z < plate.maxZ - 8; z += 7.5) parasolAt.push(at(plate.minX + 3.2, GROUND + 0.1, z, -Math.PI / 2));
  group.add(instanced(parasol, shade, parasolAt));

  return {
    group,
    update(t) {
      boat.position.y = SEA - 0.35 + Math.sin(t * 0.8) * 0.09;
      boat.rotation.set(Math.sin(t * 0.7) * 0.025, 0.12, Math.sin(t * 0.9 + 1) * 0.04);
    },
    dispose: () => kept.dispose(),
  };
}
