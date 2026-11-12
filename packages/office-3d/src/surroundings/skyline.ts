import * as THREE from 'three';
import type { Box } from '../world.ts';
import { FOG, GLSL_NOISE, Kept, OUTPUT, at, instanced, painted, rng } from './kit.ts';
import type { Place, PlaceInput } from './place.ts';

/**
 * The top floor of a tower, a city at dusk far below: streets with traffic, hundreds of buildings with their windows
 * lit, a few that rise past this floor, red lights on the tall ones, a helicopter on its round.
 *
 * Everything that repeats is one thing to draw (buildings, cars, lights), and everything that moves is moved by the
 * graphics card from the time alone — nothing here is worked out per frame on the processor.
 */

/** How far the street is under the office floor. */
const DROP = 150;
/** From the middle of one street to the middle of the next, and how wide a street is. */
const PITCH = 116;
const STREET = 20;
/** Blocks from the middle to the edge of the city, in each direction. */
const REACH = 6;
const FLOOR_H = 3.5;
const BAY = 2.4;

function streetTile(ctx: CanvasRenderingContext2D, s: number): void {
  const m = s / PITCH; // pixels a metre
  const half = (STREET / 2) * m;
  // Under the buildings and between them.
  ctx.fillStyle = '#16181f';
  ctx.fillRect(0, 0, s, s);
  // The block: pavement around it, courtyards inside.
  ctx.fillStyle = '#2c2f3a';
  ctx.fillRect(half, half, s - 2 * half, s - 2 * half);
  ctx.fillStyle = '#1b1d25';
  const walk = 3.5 * m;
  ctx.fillRect(half + walk, half + walk, s - 2 * (half + walk), s - 2 * (half + walk));
  // Lane lines: the tile's edges are the middles of the streets, so each edge carries half a street.
  const dash = (x0: number, y0: number, x1: number, y1: number, color: string, width: number, pattern: number[]) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(pattern);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  };
  for (const edge of [0, s]) {
    dash(half, edge, s - half, edge, '#8f7a34', 0.5 * m, []);
    dash(edge, half, edge, s - half, '#8f7a34', 0.5 * m, []);
    for (const side of [-1, 1]) {
      dash(half, edge + side * 5 * m, s - half, edge + side * 5 * m, '#6d7078', 0.3 * m, [3 * m, 5 * m]);
      dash(edge + side * 5 * m, half, edge + side * 5 * m, s - half, '#6d7078', 0.3 * m, [3 * m, 5 * m]);
    }
  }
  ctx.setLineDash([]);
  // Crossings at the four corners of the block.
  ctx.fillStyle = '#767a84';
  for (const cx of [half, s - half]) {
    for (let k = 0; k < 7; k++) {
      const off = (-half + 1.6 * m + k * 2.6 * m);
      // across the street that runs along x (at the tile's top and bottom edges)
      ctx.fillRect(cx + (cx < s / 2 ? 1 : -1) * 1.5 * m - 0.6 * m, (off + s) % s, 1.2 * m, 1.2 * m * 0 + 1.3 * m);
      ctx.fillRect((off + s) % s, cx + (cx < s / 2 ? 1 : -1) * 1.5 * m - 0.6 * m, 1.3 * m, 1.2 * m);
    }
  }
  // Street lamps along the pavement: pools of warm light.
  const lamp = (x: number, y: number) => {
    const r = 9 * m;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255, 196, 120, 0.55)');
    g.addColorStop(0.35, 'rgba(255, 170, 90, 0.2)');
    g.addColorStop(1, 'rgba(255, 160, 80, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  };
  for (let k = 0; k < 4; k++) {
    const p = half + ((k + 0.5) * (s - 2 * half)) / 4;
    lamp(p, half - 1.2 * m);
    lamp(p, s - half + 1.2 * m);
    lamp(half - 1.2 * m, p);
    lamp(s - half + 1.2 * m, p);
  }
}

/**
 * What a building is told about itself (`aLook`) is kept on a grid of this many steps: exact in a float, and far
 * enough from the next step that the hair an interpolated value is off by never crosses one.
 */
const SEED_STEPS = 4096;
const onGrid = (v: number): number => Math.round(v * SEED_STEPS) / SEED_STEPS;

/** One material for every building: its windows are worked out from where on the wall a pixel is. */
function buildingMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: {
      ...FOG.uniforms(),
      uTime: { value: 0 },
      uGlow: { value: new THREE.Color('#ff8c5a') },
      uGlowDir: { value: new THREE.Vector3(-1, 0, -0.35).normalize() },
      uSky: { value: new THREE.Color('#34396c') },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aLook; // seed, share of windows lit, kind of front, tint
      varying vec3 vLocal;
      varying vec3 vSize;
      varying vec3 vNormal;
      varying vec4 vLook;
      varying float vStreet;
      ${FOG.parsVertex}
      void main() {
        // Does this part stand on the street, or on a lower part of its tower?
        vStreet = step(instanceMatrix[3].y, ${(-DROP + 1).toFixed(1)});
        vec3 size = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vSize = size;
        vLocal = position * size;
        vNormal = normal;
        vLook = aLook;
        vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        ${FOG.vertex}
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vLocal;
      varying vec3 vSize;
      varying vec3 vNormal;
      varying vec4 vLook;
      varying float vStreet;
      uniform vec3 uGlow, uGlowDir, uSky;
      uniform float uTime;
      ${GLSL_NOISE}
      ${FOG.parsFragment}
      void main() {
        vec3 n = normalize(vNormal);
        // The seed reaches a pixel through interpolation, which on some graphics cards leaves it a hair off from one
        // pixel to the next; the hashes below turn a hair into another answer, and a window near the line between lit
        // and dark then came out as a field of lit and dark pixels that crawled when the camera moved. So the seed is
        // put back on the grid it was made on (SEED_STEPS), and so is the share of lit windows.
        float seed = floor(vLook.x * ${SEED_STEPS.toFixed(1)} + 0.5) / ${SEED_STEPS.toFixed(1)};
        vec3 tint = mix(vec3(0.085, 0.095, 0.13), vec3(0.14, 0.115, 0.105), vLook.w);
        vec3 col;
        if (n.y > 0.5) {
          // The roof: a parapet, and plant on some of it.
          vec2 p = vLocal.xz;
          vec2 edge = vSize.xz * 0.5 - abs(p);
          float rim = 1.0 - smoothstep(0.6, 1.4, min(edge.x, edge.y));
          float plant = step(0.72, hash21(floor(p / 5.0) + seed * 91.0)) * step(3.0, min(edge.x, edge.y));
          col = tint * 0.9 + vec3(0.035) * rim + vec3(0.03, 0.032, 0.04) * plant + uSky * (0.1 + 0.25 * smoothstep(0.0, 260.0, vSize.y));
        } else {
          bool alongZ = abs(n.x) > 0.5;
          float u = (alongZ ? vLocal.z : vLocal.x) + (alongZ ? vSize.z : vSize.x) * 0.5;
          float side = alongZ ? (n.x > 0.0 ? 1.0 : 2.0) : (n.z > 0.0 ? 3.0 : 4.0);
          vec2 cell = vec2(u / ${BAY.toFixed(1)}, vLocal.y / ${FLOOR_H.toFixed(1)});
          vec2 id = floor(cell);
          vec2 f = fract(cell);
          vec2 w = fwidth(cell);
          float kind = floor(vLook.z + 0.5);
          // Where the glass is within one bay of one floor: separate windows, bands, or a wall of glass.
          vec2 lo = kind < 0.5 ? vec2(0.24, 0.3) : kind < 1.5 ? vec2(0.0, 0.4) : vec2(0.05, 0.07);
          vec2 hi = kind < 0.5 ? vec2(0.76, 0.8) : kind < 1.5 ? vec2(1.0, 0.8) : vec2(0.95, 0.93);
          vec2 inside = smoothstep(lo - w, lo + w, f) * (1.0 - smoothstep(hi - w, hi + w, f));
          float glass = inside.x * inside.y;
          float area = (hi.x - lo.x) * (hi.y - lo.y);
          // Which rooms have the light on: by room, with whole floors working late or gone home.
          float share = floor(vLook.y * ${SEED_STEPS.toFixed(1)} + 0.5) / ${SEED_STEPS.toFixed(1)};
          float floorMood = hash21(vec2(id.y, seed * 57.0 + side));
          float on = step(hash21(id + vec2(seed * 131.0, side * 7.0)), share * (floorMood > 0.86 ? 2.4 : floorMood < 0.25 ? 0.2 : 1.0));
          float pick = hash21(id * 1.7 + seed * 17.0);
          vec3 lamp = pick < 0.62 ? vec3(1.0, 0.68, 0.36) : pick < 0.9 ? vec3(1.0, 0.84, 0.62) : vec3(0.62, 0.8, 1.0);
          lamp *= 0.5 + 0.75 * hash21(id + seed * 3.0);
          // The wall catches the last light on the side that faces it; the glass shows the sky it looks at.
          float toward = max(dot(n, uGlowDir), 0.0);
          float away = max(-dot(n, uGlowDir), 0.0);
          float up = clamp(vLocal.y / max(vSize.y, 1.0), 0.0, 1.0);
          float high = smoothstep(0.0, 260.0, vLocal.y);
          vec3 wall = tint * (0.55 + 0.75 * high) + uGlow * toward * (0.035 + 0.12 * high) + uSky * 0.05 * away;
          vec3 mirror = mix(uSky * (0.34 + 0.5 * high), uGlow * (0.34 + 0.7 * high), pow(toward, 1.3));
          mirror *= 0.75 + 0.25 * hash21(id * 0.37 + seed);
          vec3 near = mix(wall, mix(mirror, lamp * 1.25, on), glass);
          // Far away a window is smaller than a pixel: what is left is the wall's average, which does not shimmer.
          vec3 mean = mix(wall, mix(mirror, vec3(1.0, 0.74, 0.46) * 1.05, share), area);
          float detail = 1.0 - smoothstep(0.3, 0.85, max(w.x, w.y));
          col = mix(mean, near, detail);
          // A dark line at every corner and a lighter one along the top, so a tower has edges.
          float fromSide = min(u, (alongZ ? vSize.z : vSize.x) - u);
          col *= 0.72 + 0.28 * smoothstep(0.0, 0.9, fromSide);
          col += uSky * 0.22 * smoothstep(1.6, 0.0, vSize.y - vLocal.y) * step(8.0, vSize.x);
          // The ground floors: shops, lit.
          col += vec3(1.0, 0.7, 0.4) * mix(0.1, 0.3, vStreet) * (1.0 - smoothstep(3.5, 6.0, vLocal.y)) * (0.4 + 0.6 * hash21(vec2(floor(u / 6.0), seed)));
        }
        gl_FragColor = vec4(col, 1.0);
        ${OUTPUT}
        ${FOG.fragment}
      }
    `,
  });
}

interface Car {
  alongX: boolean;
  fixed: number;
  dir: number;
  speed: number;
  offset: number;
  color: THREE.Color;
}

/** Cars and their lights: one shape each, set on its way along a street by the time. */
function trafficMaterial(lights: boolean, length: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    transparent: lights,
    depthWrite: !lights,
    blending: lights ? THREE.AdditiveBlending : THREE.NormalBlending,
    uniforms: { ...FOG.uniforms(), uTime: { value: 0 }, uLength: { value: length } },
    vertexShader: /* glsl */ `
      attribute vec4 aLane; // 1 when the street runs along x, where the lane is across it, direction, speed
      attribute vec4 aCar; // where along the street it started, and its colour
      uniform float uTime, uLength;
      varying vec3 vColor;
      varying vec3 vAt;
      ${FOG.parsVertex}
      void main() {
        float along = mod(aCar.x + aLane.w * uTime, uLength) - uLength * 0.5;
        vec3 p = position;
        vAt = position;
        vColor = aCar.yzw;
        // The shape is drawn heading along +z; turn it to its street and its direction.
        vec3 world = aLane.x > 0.5
          ? vec3(along * aLane.z + p.z * aLane.z, p.y, aLane.y - p.x * aLane.z)
          : vec3(aLane.y + p.x * aLane.z, p.y, along * aLane.z + p.z * aLane.z);
        world.y += ${(-DROP).toFixed(1)};
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        ${FOG.vertex}
      }
    `,
    fragmentShader: lights
      ? /* glsl */ `
      precision highp float;
      varying vec3 vColor;
      varying vec3 vAt;
      ${FOG.parsFragment}
      void main() {
        // Ahead: the beam on the road, widening. Behind: the red of the tail lights.
        float ahead = step(0.0, vAt.z);
        float reach = ahead > 0.5 ? (vAt.z - 2.2) / 15.0 : (-vAt.z - 2.2) / 4.0;
        float width = abs(vAt.x) / (ahead > 0.5 ? 1.1 + reach * 3.4 : 1.5);
        float glow = smoothstep(1.0, 0.0, width) * smoothstep(1.0, 0.0, reach) * smoothstep(-0.12, 0.05, reach);
        vec3 col = ahead > 0.5 ? vec3(1.0, 0.9, 0.7) * 0.95 : vec3(1.0, 0.1, 0.06) * 1.25;
        gl_FragColor = vec4(col * glow, glow);
        ${OUTPUT}
        ${FOG.fragment}
      }
    `
      : /* glsl */ `
      precision highp float;
      varying vec3 vColor;
      varying vec3 vAt;
      ${FOG.parsFragment}
      void main() {
        // A roof a shade lighter than the sides, a windscreen, lamps at both ends.
        vec3 col = vColor * (vAt.y > 1.35 ? 1.25 : 0.8);
        if (vAt.y > 1.0 && abs(vAt.z) < 1.4 && vAt.y < 1.36) col = vec3(0.05, 0.07, 0.1);
        if (vAt.z > 2.14 && vAt.y < 0.95) col = vec3(2.6, 2.3, 1.7);
        if (vAt.z < -2.14 && vAt.y < 0.95) col = vec3(2.4, 0.12, 0.08);
        gl_FragColor = vec4(col, 1.0);
        ${OUTPUT}
        ${FOG.fragment}
      }
    `,
  });
}

/** Lights that stand still and blink: on the tall roofs, and on what flies. Always a few pixels wide, however far. */
export function beaconMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uScale: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec4 aBeacon; // colour, and where in its second it flashes (under 0: it does not blink)
      uniform float uTime, uScale;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float phase = aBeacon.w;
        float blink = phase < 0.0 ? 1.0 : 0.25 + 0.75 * smoothstep(0.75, 1.0, sin((uTime * 0.55 + phase) * 6.2832) * 0.5 + 0.5);
        vColor = aBeacon.rgb * blink;
        gl_PointSize = clamp(260.0 * uScale / max(-mv.z, 1.0), 2.5, 9.0) * uScale;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, d);
        gl_FragColor = vec4(vColor * a * a * 1.6, a);
        ${OUTPUT}
      }
    `,
  });
}

export function buildSkyline({ quality }: PlaceInput): Place {
  const kept = new Kept();
  const group = new THREE.Group();
  const random = rng(20261112);
  const span = (2 * REACH + 1) * PITCH;

  // ── the streets ──
  const tile = kept.add(painted(512, streetTile, [2 * REACH + 5, 2 * REACH + 5]));
  const groundSize = (2 * REACH + 5) * PITCH;
  const ground = new THREE.Mesh(kept.add(new THREE.PlaneGeometry(groundSize, groundSize)), kept.add(new THREE.MeshBasicMaterial({ map: tile })));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -DROP;
  group.add(ground);

  // ── the buildings ──
  const matrices: THREE.Matrix4[] = [];
  const looks: number[] = [];
  const beacons: number[] = [];
  const beaconLooks: number[] = [];
  const tower = (x: number, z: number, w: number, d: number, h: number) => {
    const seed = onGrid(random());
    const share = onGrid(0.05 + random() * random() * 0.42);
    const kind = Math.floor(random() * 3);
    const tintOf = random();
    const push = (bx: number, by: number, bz: number, bw: number, bh: number, bd: number) => {
      matrices.push(at(bx, by - DROP, bz, 0, bw, bh, bd));
      looks.push(seed, share, kind, tintOf);
    };
    // A tall one steps back as it rises, and may end in a mast.
    const tiers = h > 150 ? 2 + Math.floor(random() * 2) : h > 95 && random() < 0.45 ? 2 : 1;
    let base = 0;
    let bw = w;
    let bd = d;
    for (let t = 0; t < tiers; t++) {
      const th = tiers === 1 ? h : t === 0 ? h * (0.5 + random() * 0.15) : (h - base) * (t === tiers - 1 ? 1 : 0.6);
      push(x, base, z, bw, th, bd);
      base += th;
      bw *= 0.66 + random() * 0.14;
      bd *= 0.66 + random() * 0.14;
    }
    let top = base;
    if (h > 170 && random() < 0.7) {
      const mast = 18 + random() * 34;
      matrices.push(at(x, base - DROP, z, 0, 1.6, mast, 1.6));
      looks.push(seed, 0, 0, tintOf);
      top += mast;
    }
    if (h > 120) {
      beacons.push(x, top - DROP + 1.2, z);
      beaconLooks.push(1, 0.12, 0.08, random());
    }
  };
  for (let i = -REACH; i <= REACH; i++) {
    for (let j = -REACH; j <= REACH; j++) {
      if (i === 0 && j === 0) continue; // this tower's own block
      const cx = i * PITCH;
      const cz = j * PITCH;
      const block = PITCH - STREET - 8;
      const ring = Math.max(Math.abs(i), Math.abs(j));
      // A cluster of the tallest stands to the north-west, against the last light.
      const downtown = Math.hypot(i + 3.2, j + 2.4) < 2.3;
      const cols = random() < 0.3 ? 1 : random() < 0.6 ? 2 : 3;
      const rows = random() < 0.4 ? 1 : 2;
      for (let a = 0; a < cols; a++) {
        for (let b = 0; b < rows; b++) {
          const lotW = block / cols;
          const lotD = block / rows;
          const w = lotW - 5 - random() * 6;
          const d = lotD - 5 - random() * 6;
          const r = random();
          let h = 26 + 150 * Math.pow(r, 2.1);
          if (downtown) h = 150 + random() * 170;
          else if (random() < 0.09 && ring >= 1 && ring <= 4) h = 165 + random() * 110;
          if (ring >= 5) h = Math.min(h, 40 + random() * 70);
          // Next door, nothing stands taller than the eye: the view is kept open.
          if (ring === 1 && !downtown) h = Math.min(h, 60 + random() * 70);
          tower(cx - block / 2 + lotW * (a + 0.5), cz - block / 2 + lotD * (b + 0.5), Math.min(w, h > 150 ? 46 : 80), Math.min(d, h > 150 ? 46 : 80), h);
        }
      }
    }
  }
  const unit = kept.add(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  unit.setAttribute('aLook', new THREE.InstancedBufferAttribute(new Float32Array(looks), 4));
  const buildings = kept.add(buildingMaterial());
  const city = instanced(unit, buildings, matrices);
  city.frustumCulled = false;
  group.add(city);

  // ── traffic ──
  const cars: Car[] = [];
  const paints = ['#b8bcc4', '#2a2d34', '#8e1f1f', '#d9c23c', '#1d3557', '#e8e6e0', '#3b3f48', '#d9c23c'];
  const every = quality === 'low' ? 95 : 52;
  for (let k = -REACH - 1; k <= REACH; k++) {
    const mid = (k + 0.5) * PITCH;
    for (const alongX of [true, false]) {
      for (const lane of [-7.4, -2.6, 2.6, 7.4]) {
        const dir = lane > 0 === alongX ? 1 : -1;
        const speed = 9 + random() * 7;
        for (let s = random() * every; s < span; s += every * (0.45 + random() * 1.1)) {
          cars.push({ alongX, fixed: mid + lane, dir, speed: speed * (0.9 + random() * 0.2), offset: s, color: new THREE.Color(paints[Math.floor(random() * paints.length)]!) });
        }
      }
    }
  }
  const lanes = new Float32Array(cars.length * 4);
  const carLooks = new Float32Array(cars.length * 4);
  cars.forEach((c, i) => {
    lanes.set([c.alongX ? 1 : 0, c.fixed, c.dir, c.speed], i * 4);
    carLooks.set([c.offset, c.color.r, c.color.g, c.color.b], i * 4);
  });
  const withLanes = (g: THREE.BufferGeometry) => {
    g.setAttribute('aLane', new THREE.InstancedBufferAttribute(lanes, 4));
    g.setAttribute('aCar', new THREE.InstancedBufferAttribute(carLooks, 4));
    return g;
  };
  const body = withLanes(kept.add(new THREE.BoxGeometry(1.9, 1.45, 4.4).translate(0, 0.725, 0)));
  // One flat piece for both pools of light: it reaches ahead of the car and a little behind it.
  const pool = withLanes(kept.add(new THREE.PlaneGeometry(9.5, 24).rotateX(-Math.PI / 2).translate(0, 0.12, 5.6)));
  const bodyMat = kept.add(trafficMaterial(false, span));
  const poolMat = kept.add(trafficMaterial(true, span));
  const identity = cars.map(() => new THREE.Matrix4());
  const bodies = instanced(body, bodyMat, identity);
  const pools = instanced(pool, poolMat, identity);
  bodies.frustumCulled = pools.frustumCulled = false;
  pools.renderOrder = 2;
  group.add(bodies, pools);

  // ── lights on the tall roofs, and what flies ──
  const flying = 3; // the helicopter's two, and an aeroplane high up
  const beaconAt = new Float32Array(beacons.length + flying * 3);
  beaconAt.set(beacons);
  const beaconLook = new Float32Array(beaconLooks.length + flying * 4);
  beaconLook.set(beaconLooks);
  beaconLook.set([1, 0.15, 0.1, 0.0, 0.6, 1, 0.7, -1, 1, 1, 1, 0.4], beaconLooks.length);
  const beaconGeo = kept.add(new THREE.BufferGeometry());
  const beaconPos = new THREE.BufferAttribute(beaconAt, 3);
  beaconPos.setUsage(THREE.DynamicDrawUsage);
  beaconGeo.setAttribute('position', beaconPos);
  beaconGeo.setAttribute('aBeacon', new THREE.BufferAttribute(beaconLook, 4));
  const beaconMat = kept.add(beaconMaterial());
  const points = new THREE.Points(beaconGeo, beaconMat);
  points.frustumCulled = false;
  points.renderOrder = 3;
  group.add(points);

  // ── a helicopter on its round ──
  const heli = new THREE.Group();
  const dark = kept.add(new THREE.MeshBasicMaterial({ color: '#141821' }));
  const cabin = new THREE.Mesh(kept.add(new THREE.SphereGeometry(1.5, 12, 8).scale(1, 0.85, 1.7)), dark);
  const tail = new THREE.Mesh(kept.add(new THREE.BoxGeometry(0.35, 0.4, 5.4).translate(0, 0.3, -4.4)), dark);
  const fin = new THREE.Mesh(kept.add(new THREE.BoxGeometry(0.12, 1.5, 0.8).translate(0, 0.9, -6.9)), dark);
  const rotor = new THREE.Mesh(kept.add(new THREE.CircleGeometry(5.2, 24).rotateX(-Math.PI / 2).translate(0, 1.55, 0)), kept.add(new THREE.MeshBasicMaterial({ color: '#aab4c8', transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide })));
  const glass = new THREE.Mesh(kept.add(new THREE.SphereGeometry(1.2, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(0.95, 0.8, 1.2).rotateX(Math.PI / 2.6).translate(0, 0.25, 1.45)), kept.add(new THREE.MeshBasicMaterial({ color: '#5a6f96' })));
  heli.add(cabin, tail, fin, rotor, glass);
  group.add(heli);

  return {
    group,
    update(time) {
      buildings.uniforms.uTime!.value = time;
      bodyMat.uniforms.uTime!.value = time;
      poolMat.uniforms.uTime!.value = time;
      beaconMat.uniforms.uTime!.value = time;
      // The helicopter: a wide slow round a little under the floor, rising and sinking.
      const a = time * 0.05;
      const r = 250;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r * 0.8;
      const y = -26 + Math.sin(a * 2.3) * 14;
      heli.position.set(x, y, z);
      heli.rotation.set(0.1, -a, -0.14, 'YXZ');
      const n = beacons.length;
      beaconAt.set([x, y - 1.3, z, x - Math.sin(-a) * 6.5, y + 1.2, z - Math.cos(-a) * 6.5], n);
      // The aeroplane: far off and high, across the sky in a few minutes.
      const p = ((time * 0.004) % 1) * 2 - 1;
      beaconAt.set([p * 1300, 330, -900 + p * 240], n + 6);
      beaconPos.needsUpdate = true;
    },
    dispose() {
      kept.dispose();
    },
  };
}

/** The tower under the office and the terrace around it: made again when a member's room makes the floor wider. */
export function buildTower(plate: Box): { group: THREE.Group; dispose(): void } {
  const kept = new Kept();
  const group = new THREE.Group();
  const w = plate.maxX - plate.minX;
  const d = plate.maxZ - plate.minZ;
  const cx = (plate.minX + plate.maxX) / 2;
  const cz = (plate.minZ + plate.maxZ) / 2;

  // The shaft, with its own windows; a recess under the terrace, so the top floor reads as a floor of its own.
  const unit = kept.add(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
  unit.setAttribute('aLook', new THREE.InstancedBufferAttribute(new Float32Array([onGrid(0.37), onGrid(0.17), 2, 0.1, onGrid(0.37), 0, 1, 0.1]), 4));
  const shaft = instanced(unit, kept.add(buildingMaterial()), [at(cx, -DROP, cz, 0, w - 5, DROP - 1.6, d - 5), at(cx, -1.6, cz, 0, w - 8, 1.2, d - 8)]);
  shaft.frustumCulled = false;
  group.add(shaft);

  // The terrace: paving that takes the building's shadow.
  const paving = kept.add(
    painted(256, (ctx, s) => {
      // Large slabs of dark stone, laid in a bond, with fine joints.
      ctx.fillStyle = '#2b2e36';
      ctx.fillRect(0, 0, s, s);
      const h = s / 4;
      for (let j = 0; j < 4; j++) {
        for (let i = -1; i < 2; i++) {
          const v = 62 + ((i * 5 + j * 3 + 8) % 4) * 4;
          ctx.fillStyle = `rgb(${v},${v + 2},${v + 8})`;
          ctx.fillRect(i * (s / 2) + (j % 2 ? s / 4 : 0) + 1, j * h + 1, s / 2 - 2, h - 2);
          ctx.fillRect(i * (s / 2) + (j % 2 ? s / 4 : 0) + 1 + s, j * h + 1, s / 2 - 2, h - 2);
        }
      }
    }, [w / 3.6, d / 3.6]),
  );
  const deck = new THREE.Mesh(kept.add(new THREE.BoxGeometry(w, 0.3, d)), kept.add(new THREE.MeshStandardMaterial({ map: paving, roughness: 0.85 })));
  deck.position.set(cx, -0.36, cz);
  deck.receiveShadow = true;
  group.add(deck);

  // A balustrade of glass with a rail, and a line of light at its foot.
  const glassMat = kept.add(new THREE.MeshStandardMaterial({ color: '#bfe1ff', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.16, depthWrite: false }));
  const railMat = kept.add(new THREE.MeshStandardMaterial({ color: '#2c3442', roughness: 0.4, metalness: 0.6 }));
  const ledMat = kept.add(new THREE.MeshBasicMaterial({ color: '#ffcf96' }));
  ledMat.toneMapped = false;
  for (const [x, z, lx, lz] of [[cx, plate.minZ + 0.15, w - 0.3, 0], [cx, plate.maxZ - 0.15, w - 0.3, 0], [plate.minX + 0.15, cz, 0, d - 0.3], [plate.maxX - 0.15, cz, 0, d - 0.3]] as const) {
    const pane = new THREE.Mesh(kept.add(new THREE.BoxGeometry(lx || 0.03, 1.05, lz || 0.03)), glassMat);
    pane.position.set(x, 0.33, z);
    const rail = new THREE.Mesh(kept.add(new THREE.BoxGeometry(lx ? lx + 0.1 : 0.07, 0.05, lz ? lz + 0.1 : 0.07)), railMat);
    rail.position.set(x, 0.88, z);
    const led = new THREE.Mesh(kept.add(new THREE.BoxGeometry(lx ? lx - 0.6 : 0.05, 0.03, lz ? lz - 0.6 : 0.05)), ledMat);
    led.position.set(x + (lx ? 0 : x < cx ? 0.12 : -0.12), -0.19, z + (lz ? 0 : z < cz ? 0.12 : -0.12));
    group.add(pane, rail, led);
  }
  return { group, dispose: () => kept.dispose() };
}

export const SKYLINE_DROP = DROP;
