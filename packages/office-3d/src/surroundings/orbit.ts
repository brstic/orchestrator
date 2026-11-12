import * as THREE from 'three';
import type { Box } from '../world.ts';
import { GLSL_NOISE, Kept, at, instanced, merged, painted, rng, turned } from './kit.ts';
import type { Footing, Place, PlaceInput } from './place.ts';
import { beaconMaterial } from './skyline.ts';

/**
 * A station in orbit: the office on a deck of its own, a long truss with solar wings to either side, modules docked
 * fore and aft, a great wheel turning round it all, somebody out on a spacewalk — and the Earth below, turning,
 * with its clouds, its night side lit by cities, and the thin blue line of its air.
 *
 * The Earth is not a thing in the scene: like the sky it is drawn where it is seen from, so walking about the
 * office does not move it — as it would not.
 */

export const ORBIT_SUN: [number, number, number] = [0.62, 0.36, 0.5];
/** Which way the middle of the Earth is, and how much of the view it takes (the sine of half its width). */
const EARTH_DIR = new THREE.Vector3(0.3, -0.8, -0.52).normalize();
const EARTH_SIZE = 0.885;
/** The wheel's radius. */
const WHEEL = 92;

function earthMaterial(air: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.FrontSide,
    transparent: air,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    blending: air ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: {
      uCentre: { value: EARTH_DIR.clone() },
      uRadius: { value: EARTH_SIZE * (air ? 1.035 : 1) },
      uSun: { value: new THREE.Vector3(...ORBIT_SUN).normalize() },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      uniform vec3 uCentre;
      uniform float uRadius;
      varying vec3 vNormal;
      varying vec3 vAt;
      void main() {
        vNormal = position;
        // Where this point is from the eye, in the world's directions: the middle is one unit away.
        vAt = uCentre + position * uRadius;
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * vAt, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uSun;
      uniform float uTime;
      varying vec3 vNormal;
      varying vec3 vAt;
      ${GLSL_NOISE}
      float noise3(vec3 p) {
        vec3 i = floor(p); vec3 f = fract(p); vec3 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(mix(hash31(i), hash31(i + vec3(1, 0, 0)), u.x), mix(hash31(i + vec3(0, 1, 0)), hash31(i + vec3(1, 1, 0)), u.x), u.y),
          mix(mix(hash31(i + vec3(0, 0, 1)), hash31(i + vec3(1, 0, 1)), u.x), mix(hash31(i + vec3(0, 1, 1)), hash31(i + vec3(1, 1, 1)), u.x), u.y), u.z);
      }
      float layers(vec3 p) {
        float s = 0.0; float a = 0.5;
        for (int i = 0; i < 6; i++) { s += a * noise3(p); p = p * 2.02 + vec3(11.3, 4.7, 7.1); a *= 0.5; }
        return s / 0.984;
      }
      vec3 turn(vec3 p, float a) { float c = cos(a); float s = sin(a); return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c); }
      void main() {
        vec3 n = normalize(vNormal);
        vec3 toEye = normalize(-vAt);
        float facing = max(dot(n, toEye), 0.0);
        float day = dot(n, uSun);
        ${
          air
            ? /* glsl */ `
        // The air seen edge-on, a shell a little larger than the ball: bright at the limb, on the lit side, and
        // nothing where one looks straight down through it.
        float rim = pow(1.0 - facing, 6.0);
        float lit = smoothstep(-0.25, 0.4, day);
        gl_FragColor = vec4(vec3(0.28, 0.56, 1.0) * rim * (0.08 + 0.7 * lit), 1.0);
        `
            : /* glsl */ `
        vec3 p = turn(n, uTime * 0.012);
        float h = layers(p * 4.2 + 3.0);
        float land = smoothstep(0.515, 0.545, h);
        float lat = abs(p.y);
        // Sea, shallower by the coasts; land from forest to desert to bare heights; ice at the poles.
        vec3 sea = mix(vec3(0.008, 0.05, 0.2), vec3(0.02, 0.17, 0.34), smoothstep(0.44, 0.515, h));
        float dry = smoothstep(0.35, 0.75, noise3(p * 6.5 + 9.0) + (0.35 - lat) * 0.6);
        vec3 ground = mix(vec3(0.07, 0.22, 0.08), vec3(0.5, 0.4, 0.22), dry);
        ground = mix(ground, vec3(0.34, 0.3, 0.26), smoothstep(0.6, 0.72, h));
        vec3 surface = mix(sea, ground, land);
        float ice = smoothstep(0.78, 0.88, lat + (h - 0.5) * 0.3);
        surface = mix(surface, vec3(0.86, 0.9, 0.95), ice);

        // Clouds drift on their own; they throw the planet's weather across it in swirls.
        vec3 q = turn(n, uTime * 0.017 + 1.0);
        float swirl = layers(q * 7.0 + vec3(layers(q * 3.4) * 1.8));
        float cloud = smoothstep(0.55, 0.78, swirl) * 0.9;

        float light = smoothstep(-0.12, 0.35, day);
        vec3 col = surface * (0.03 + 0.95 * light);
        // The sun on the sea.
        vec3 r = reflect(-uSun, n);
        col += vec3(1.0, 0.93, 0.8) * pow(max(dot(r, toEye), 0.0), 140.0) * (1.0 - land) * (1.0 - cloud) * 0.5;
        col = mix(col, vec3(0.9, 0.92, 0.96) * (0.04 + 0.72 * light), cloud);
        // Night: cities, where there is land and no cloud over it.
        float cells = step(0.72, hash31(floor(p * 150.0))) * smoothstep(0.52, 0.62, noise3(p * 18.0));
        col += vec3(1.0, 0.72, 0.36) * cells * land * (1.0 - ice) * (1.0 - cloud) * (1.0 - smoothstep(-0.2, 0.05, day)) * 0.9;
        // The air over the surface: bluer and brighter towards the edge.
        // (From this low, most of what is seen is seen at a slant: the haze is kept to the last of it.)
        float rim = pow(1.0 - facing, 7.0);
        col = mix(col, vec3(0.26, 0.52, 0.95) * (0.1 + 0.8 * light), rim * 0.7);
        col += vec3(0.05, 0.11, 0.22) * (1.0 - facing) * light;
        gl_FragColor = vec4(col, 1.0);
        `
        }
        #include <colorspace_fragment>
      }
    `,
  });
}

function hullTexture(kept: Kept, repeat: [number, number]): THREE.Texture {
  return kept.add(
    painted(512, (ctx, s) => {
      ctx.fillStyle = '#c9ced6';
      ctx.fillRect(0, 0, s, s);
      // Plates of slightly different greys, with seams and a few fixings.
      const n = 4;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const v = 196 + ((i * 7 + j * 11) % 6) * 5;
          ctx.fillStyle = `rgb(${v},${v + 3},${v + 9})`;
          ctx.fillRect(i * (s / n) + 2, j * (s / n) + 2, s / n - 4, s / n - 4);
          ctx.fillStyle = 'rgba(70, 78, 92, 0.7)';
          for (const [dx, dy] of [[10, 10], [s / n - 14, 10], [10, s / n - 14], [s / n - 14, s / n - 14]] as const) ctx.fillRect(i * (s / n) + dx, j * (s / n) + dy, 4, 4);
        }
      }
      ctx.strokeStyle = 'rgba(60, 68, 82, 0.55)';
      ctx.lineWidth = 2;
      for (let i = 0; i <= n; i++) {
        ctx.beginPath();
        ctx.moveTo(i * (s / n), 0);
        ctx.lineTo(i * (s / n), s);
        ctx.moveTo(0, i * (s / n));
        ctx.lineTo(s, i * (s / n));
        ctx.stroke();
      }
    }, repeat),
  );
}

export function buildOrbit(_input: PlaceInput): Place {
  const kept = new Kept();
  const group = new THREE.Group();
  const random = rng(4242);

  // ── the Earth, and the air round it ──
  const ball = kept.add(new THREE.SphereGeometry(1, 96, 64));
  const earth = kept.add(earthMaterial(false));
  const air = kept.add(earthMaterial(true));
  const planet = new THREE.Mesh(ball, earth);
  const halo = new THREE.Mesh(ball, air);
  planet.frustumCulled = halo.frustumCulled = false;
  // After the stars and before anything of the station: both are as far away as can be, and drawn in this order.
  planet.renderOrder = 901;
  halo.renderOrder = 902;
  group.add(planet, halo);

  // ── the truss: from one end of the station to the other, under the deck ──
  const hull = kept.add(new THREE.MeshStandardMaterial({ map: hullTexture(kept, [1, 1]), roughness: 0.55, metalness: 0.35 }));
  const dark = kept.add(new THREE.MeshStandardMaterial({ color: '#3a4250', roughness: 0.5, metalness: 0.6 }));
  const girder = kept.add(
    painted(256, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      ctx.fillStyle = '#aeb6c2';
      ctx.fillRect(0, 0, s, 22);
      ctx.fillRect(0, s - 22, s, 22);
      ctx.fillRect(0, 0, 14, s);
      ctx.strokeStyle = '#aeb6c2';
      ctx.lineWidth = 16;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(s, s);
      ctx.moveTo(s, 0);
      ctx.lineTo(0, s);
      ctx.stroke();
    }, [64, 1]),
  );
  const lattice = kept.add(new THREE.MeshStandardMaterial({ map: girder, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.5 }));
  const span = 330;
  const truss = new THREE.Mesh(kept.add(new THREE.BoxGeometry(span, 5, 5)), lattice);
  truss.position.set(0, -5.2, 0);
  group.add(truss);
  const spine = new THREE.Mesh(kept.add(new THREE.CylinderGeometry(0.7, 0.7, span, 10).rotateZ(Math.PI / 2)), dark);
  spine.position.copy(truss.position);
  group.add(spine);

  // ── solar wings: four pairs each side, and radiators nearer in ──
  const cells = kept.add(
    painted(256, (ctx, s) => {
      ctx.fillStyle = '#0c1a3c';
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 4; j++) {
          const g = ctx.createLinearGradient(i * 32, j * 64, i * 32 + 32, j * 64 + 64);
          g.addColorStop(0, '#1c3f8f');
          g.addColorStop(1, '#10275e');
          ctx.fillStyle = g;
          ctx.fillRect(i * 32 + 2, j * 64 + 2, 28, 60);
        }
      }
      ctx.fillStyle = '#b8c0cc';
      ctx.fillRect(0, s / 2 - 2, s, 4);
    }, [3, 1]),
  );
  const wingMat = kept.add(new THREE.MeshStandardMaterial({ map: cells, roughness: 0.3, metalness: 0.65, side: THREE.DoubleSide }));
  const wing = kept.add(new THREE.BoxGeometry(11, 0.12, 46));
  const wingAt: THREE.Matrix4[] = [];
  const armAt: THREE.Matrix4[] = [];
  for (const side of [-1, 1]) {
    for (let k = 0; k < 4; k++) {
      const x = side * (74 + k * 26);
      for (const end of [-1, 1]) wingAt.push(at(x, -5.2, end * 29, 0, 1, 1, 1, 0, 0.5 * side));
      armAt.push(at(x, -5.2, 0, 0, 1, 1, 1, Math.PI / 2));
    }
  }
  group.add(instanced(wing, wingMat, wingAt), instanced(kept.add(new THREE.CylinderGeometry(0.28, 0.28, 16, 8)), dark, armAt));
  const radiator = kept.add(new THREE.MeshStandardMaterial({ color: '#e6e9ee', roughness: 0.6, metalness: 0.2, side: THREE.DoubleSide }));
  group.add(instanced(kept.add(new THREE.BoxGeometry(7, 0.1, 22)), radiator, [-1, 1].flatMap((side) => [-1, 1].map((end) => at(side * 52, -5.2, end * 15, 0, 1, 1, 1, 0, -0.9 * side)))));

  // ── modules docked fore and aft, with their windows lit ──
  const tube = kept.add(turned([[0, -13], [2.4, -12.6], [4.4, -10.6], [4.6, -9], [4.6, 9], [4.4, 10.6], [2.4, 12.6], [0, 13]], 20));
  const collar = kept.add(new THREE.CylinderGeometry(2.6, 2.6, 2.4, 16));
  const moduleMat = kept.add(new THREE.MeshStandardMaterial({ map: hullTexture(kept, [6, 3]), roughness: 0.5, metalness: 0.35 }));
  const lit = kept.add(new THREE.MeshBasicMaterial({ color: '#ffd9a0' }));
  lit.toneMapped = false;
  const ports = kept.add(
    merged(
      Array.from({ length: 12 }, (_, i) => {
        const a = (i % 2 ? 0.55 : -0.55) + Math.PI / 2;
        return { geometry: new THREE.CircleGeometry(0.42, 12), color: '#ffffff', matrix: at(Math.cos(a) * 4.62, -7.5 + Math.floor(i / 2) * 3, Math.sin(a) * 4.62, -a + Math.PI / 2) };
      }),
    ),
  );
  const modules: Array<[number, number, number, number]> = [[-58, -3.2, -50, 0], [58, -3.2, 48, 0], [-24, -11.5, 0, Math.PI / 2], [26, -11.5, 0, Math.PI / 2]];
  for (const [x, y, z, turnY] of modules) {
    const m = new THREE.Group();
    const body = new THREE.Mesh(tube, moduleMat);
    const lights = new THREE.Mesh(ports, lit);
    m.add(body, lights, new THREE.Mesh(collar, dark));
    m.rotation.set(Math.PI / 2, turnY, 0, 'YXZ');
    m.position.set(x, y, z);
    group.add(m);
  }
  // The arms that hold the fore and aft modules to the truss.
  group.add(instanced(kept.add(new THREE.CylinderGeometry(1.5, 1.5, 1, 12).rotateX(Math.PI / 2)), dark, [at(-58, -4.2, -22, 0, 1, 1, 36), at(58, -4.2, 20, 0, 1, 1, 36)]));

  // ── the wheel: a ring at the station's far end, turning round the truss ──
  const wheel = new THREE.Group();
  const rim = new THREE.Mesh(kept.add(new THREE.TorusGeometry(WHEEL, 3.4, 12, 120)), kept.add(new THREE.MeshStandardMaterial({ map: hullTexture(kept, [70, 2]), roughness: 0.5, metalness: 0.4 })));
  wheel.add(rim);
  const spokes = Array.from({ length: 6 }, (_, i) => at(0, 0, 0, 0, 1, 1, 1, 0, (i / 6) * Math.PI));
  wheel.add(instanced(kept.add(new THREE.CylinderGeometry(0.5, 0.5, 2 * WHEEL - 6, 8)), dark, spokes));
  const windowsAt: THREE.Matrix4[] = [];
  for (let i = 0; i < 160; i++) {
    if (random() < 0.3) continue;
    const a = (i / 160) * Math.PI * 2;
    for (const side of [-1, 1]) windowsAt.push(at(Math.cos(a) * WHEEL, Math.sin(a) * WHEEL, side * 3.43, side > 0 ? 0 : Math.PI, 1, 1, 1, 0, a));
  }
  wheel.add(instanced(kept.add(new THREE.PlaneGeometry(1.5, 0.7)), lit, windowsAt));
  // Its hub is the end of the truss; nothing of it comes near the office.
  wheel.rotation.y = Math.PI / 2;
  const wheelTurn = new THREE.Group();
  wheelTurn.position.set(-span / 2 - 5, -5.2, 0);
  wheelTurn.add(wheel, new THREE.Mesh(kept.add(new THREE.SphereGeometry(7, 20, 14)), moduleMat));
  group.add(wheelTurn);

  // ── somebody outside ──
  const suit = kept.add(
    merged([
      { geometry: new THREE.CapsuleGeometry(0.32, 0.5, 6, 12), color: '#eef0f3', matrix: at(0, 0, 0) },
      { geometry: new THREE.SphereGeometry(0.27, 14, 10), color: '#eef0f3', matrix: at(0, 0.66, 0) },
      { geometry: new THREE.SphereGeometry(0.2, 12, 8), color: '#c9962e', matrix: at(0, 0.67, 0.13, 0, 1, 0.9, 0.8) },
      { geometry: new THREE.BoxGeometry(0.55, 0.72, 0.26), color: '#d5d9df', matrix: at(0, 0.08, -0.33) },
      { geometry: new THREE.CapsuleGeometry(0.11, 0.5, 4, 8), color: '#eef0f3', matrix: at(-0.46, 0.18, 0.08, 0, 1, 1, 1, 0, 0.75) },
      { geometry: new THREE.CapsuleGeometry(0.11, 0.5, 4, 8), color: '#eef0f3', matrix: at(0.46, 0.3, 0.1, 0, 1, 1, 1, 0.3, -1.1) },
      { geometry: new THREE.CapsuleGeometry(0.13, 0.55, 4, 8), color: '#eef0f3', matrix: at(-0.17, -0.72, 0.05, 0, 1, 1, 1, 0.2, 0.08) },
      { geometry: new THREE.CapsuleGeometry(0.13, 0.55, 4, 8), color: '#eef0f3', matrix: at(0.17, -0.7, -0.08, 0, 1, 1, 1, -0.3, -0.08) },
      { geometry: new THREE.BoxGeometry(0.14, 0.05, 0.02), color: '#c63a3a', matrix: at(-0.14, 0.2, 0.31) },
    ]),
  );
  const walker = new THREE.Mesh(suit, kept.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 })));
  walker.scale.setScalar(1.15);
  group.add(walker);
  // The line that keeps them from drifting off.
  const tether = new THREE.Line(kept.add(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(20 * 3), 3))), kept.add(new THREE.LineBasicMaterial({ color: '#d9c88a' })));
  tether.frustumCulled = false;
  group.add(tether);

  // ── lights that mark the station's ends, and a ship that goes by ──
  const marks: number[] = [];
  const markLooks: number[] = [];
  for (const side of [-1, 1]) {
    marks.push(side * (span / 2), -5.2, 0);
    markLooks.push(side < 0 ? 1 : 0.2, side < 0 ? 0.12 : 1, side < 0 ? 0.1 : 0.3, side < 0 ? 0 : 0.5);
    for (let k = 0; k < 4; k++) {
      for (const end of [-1, 1]) {
        marks.push(side * (74 + k * 26), -5.2 + (end * side > 0 ? 11 : -11) * 0, end * 52);
        markLooks.push(1, 1, 1, random());
      }
    }
  }
  marks.push(0, 0, 0);
  markLooks.push(0.7, 0.85, 1, -1);
  const markAt = new THREE.BufferAttribute(new Float32Array(marks), 3);
  markAt.setUsage(THREE.DynamicDrawUsage);
  const markGeo = kept.add(new THREE.BufferGeometry());
  markGeo.setAttribute('position', markAt);
  markGeo.setAttribute('aBeacon', new THREE.BufferAttribute(new Float32Array(markLooks), 4));
  const markMat = kept.add(beaconMaterial());
  const beacons = new THREE.Points(markGeo, markMat);
  beacons.frustumCulled = false;
  beacons.renderOrder = 3;
  group.add(beacons);
  const ship = new THREE.Mesh(
    kept.add(
      merged([
        { geometry: turned([[0, -4], [1.3, -3.4], [1.5, 2.2], [0.9, 3.6], [0, 4]], 12), color: '#dfe3ea', matrix: at(0, 0, 0, 0, 1, 1, 1, Math.PI / 2) },
        { geometry: new THREE.BoxGeometry(7.5, 0.1, 2.2), color: '#1c3f8f', matrix: at(0, 0, -1) },
        { geometry: new THREE.ConeGeometry(0.9, 1.2, 10), color: '#3a4250', matrix: at(0, 0, -4.4, 0, 1, 1, 1, -Math.PI / 2) },
      ]),
    ),
    kept.add(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.3 })),
  );
  group.add(ship);

  return {
    group,
    update(t) {
      earth.uniforms.uTime!.value = t;
      markMat.uniforms.uTime!.value = t;
      wheelTurn.rotation.x = t * 0.02;
      // The spacewalker: turning slowly, at the end of a line from the deck's corner.
      const wx = 46 + Math.sin(t * 0.07) * 3;
      const wy = 9 + Math.sin(t * 0.05 + 1) * 2.5;
      const wz = 30 + Math.cos(t * 0.06) * 3;
      walker.position.set(wx, wy, wz);
      walker.rotation.set(t * 0.05, t * 0.08, 0.4 + t * 0.03);
      const line = tether.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < 20; i++) {
        const u = i / 19;
        // Slack: it bows, and the bow wanders.
        const bow = Math.sin(u * Math.PI) * (2.2 + Math.sin(t * 0.1) * 0.6);
        line.setXYZ(i, 31 + (wx - 31) * u + bow * 0.4, -0.2 + (wy + 0.2) * u + bow, 22 + (wz - 22) * u - bow * 0.3);
      }
      line.needsUpdate = true;
      // The ship: a long way round, a little above the deck's level, in a few minutes.
      const a = t * 0.022;
      const sx = Math.cos(a) * 210;
      const sz = Math.sin(a) * 170;
      ship.position.set(sx, 24 + Math.sin(a * 2) * 10, sz);
      ship.rotation.set(0, -a + Math.PI, Math.sin(a * 2) * 0.1, 'YXZ');
      markAt.setXYZ(markAt.count - 1, sx, ship.position.y + 1.8, sz);
      markAt.needsUpdate = true;
    },
    dispose() {
      kept.dispose();
    },
  };
}

/** The deck the office stands on: plated, with a lit edge, and the housing under it that joins it to the truss. */
export function buildStationDeck(plate: Box): Footing {
  const kept = new Kept();
  const group = new THREE.Group();
  const w = plate.maxX - plate.minX;
  const d = plate.maxZ - plate.minZ;
  const cx = (plate.minX + plate.maxX) / 2;
  const cz = (plate.minZ + plate.maxZ) / 2;
  const top = new THREE.Mesh(kept.add(new THREE.BoxGeometry(w, 0.5, d)), kept.add(new THREE.MeshStandardMaterial({ map: hullTexture(kept, [w / 12, d / 12]), roughness: 0.6, metalness: 0.3 })));
  top.position.set(cx, -0.46, cz);
  top.receiveShadow = true;
  group.add(top);
  const under = new THREE.Mesh(kept.add(new THREE.BoxGeometry(w - 6, 2.4, d - 6)), kept.add(new THREE.MeshStandardMaterial({ color: '#59616e', roughness: 0.6, metalness: 0.4 })));
  under.position.set(cx, -1.9, cz);
  const keel = new THREE.Mesh(kept.add(new THREE.BoxGeometry(w - 16, 2.2, Math.max(6, d - 22))), kept.add(new THREE.MeshStandardMaterial({ color: '#434a57', roughness: 0.6, metalness: 0.4 })));
  keel.position.set(cx, -4.1, cz);
  group.add(under, keel);
  // A line of light along the edge, and a low rail.
  const glow = kept.add(new THREE.MeshBasicMaterial({ color: '#9fd4ff' }));
  glow.toneMapped = false;
  const rail = kept.add(new THREE.MeshStandardMaterial({ color: '#2c3442', roughness: 0.4, metalness: 0.7 }));
  for (const [x, z, lx, lz] of [[cx, plate.minZ + 0.2, w - 0.4, 0], [cx, plate.maxZ - 0.2, w - 0.4, 0], [plate.minX + 0.2, cz, 0, d - 0.4], [plate.maxX - 0.2, cz, 0, d - 0.4]] as const) {
    const strip = new THREE.Mesh(kept.add(new THREE.BoxGeometry(lx ? lx - 1 : 0.08, 0.04, lz ? lz - 1 : 0.08)), glow);
    strip.position.set(x, -0.19, z);
    const bar = new THREE.Mesh(kept.add(new THREE.BoxGeometry(lx || 0.06, 0.06, lz || 0.06)), rail);
    bar.position.set(x, 0.75, z);
    group.add(strip, bar);
  }
  const postAt: THREE.Matrix4[] = [];
  for (let x = plate.minX + 0.2; x <= plate.maxX; x += 3.2) postAt.push(at(x, 0.27, plate.minZ + 0.2), at(x, 0.27, plate.maxZ - 0.2));
  for (let z = plate.minZ + 0.2; z <= plate.maxZ; z += 3.2) postAt.push(at(plate.minX + 0.2, 0.27, z), at(plate.maxX - 0.2, 0.27, z));
  group.add(instanced(kept.add(new THREE.BoxGeometry(0.06, 0.96, 0.06)), rail, postAt));
  return { group, dispose: () => kept.dispose() };
}
