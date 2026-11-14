import * as THREE from 'three';
import type { Box } from '../world.ts';
import { FOG, GLSL_NOISE, Kept, OUTPUT, at, grain, instanced, merged, painted, rng } from './kit.ts';
import { AMBER, CYCLE, GREEN, Z_OFFSET, LENGTH, TRAFFIC_GLSL, acrossOf, spanOf, traffic, vehicleAt, type StreetGrid, type Vehicle } from './traffic.ts';
import { cityWalkers, type Walker } from '../city/walkers.ts';
import { PART, vehicleShape, type Body } from '../city/vehicles.ts';
import { DROP, FRONT, PITCH, PLAIN, SEED_STEPS, STREET, STREET_Y, blockAt, blockIndex, onGrid, streetTrees } from '../city/blocks.ts';
import type { Place, PlaceInput } from './place.ts';

/**
 * The top floor of a tower, a city at dusk far below: streets with traffic, hundreds of buildings with their windows
 * lit, a few that rise past this floor, red lights on the tall ones, a helicopter on its round.
 *
 * Everything that repeats is one thing to draw (buildings, cars, lights), and everything that moves is moved by the
 * graphics card from the time alone — nothing here is worked out per frame on the processor.
 */

/** Blocks from the middle to the edge of the traffic's pattern, in each direction (it repeats beyond). */
const REACH = 6;
const FLOOR_H = 3.5;
const BAY = 2.4;

function streetTile(ctx: CanvasRenderingContext2D, s: number): void {
  const m = s / PITCH; // pixels a metre
  const half = (STREET / 2) * m;
  const walk = 4 * m; // the pavement, from the kerb to the building line
  // The road.
  ctx.fillStyle = '#1a1c22';
  ctx.fillRect(0, 0, s, s);
  // Worn tarmac: darker where the wheels run, patches here and there.
  const r = rng(77);
  for (let k = 0; k < 140; k++) {
    ctx.fillStyle = `rgba(${r() < 0.5 ? '10,11,14' : '40,42,48'},${0.12 + r() * 0.16})`;
    const x = r() * s;
    const y = r() * s;
    ctx.fillRect(x, y, (1 + r() * 4) * m, (1 + r() * 4) * m);
  }
  // The block: kerb, pavement in slabs, and the block itself (built over, so mostly hidden).
  ctx.fillStyle = '#5b5d63';
  ctx.fillRect(half, half, s - 2 * half, s - 2 * half);
  ctx.fillStyle = '#44464d';
  ctx.fillRect(half + 0.3 * m, half + 0.3 * m, s - 2 * half - 0.6 * m, s - 2 * half - 0.6 * m);
  ctx.strokeStyle = 'rgba(20,20,24,0.35)';
  ctx.lineWidth = 0.08 * m;
  for (let p = half; p < s - half; p += 1.5 * m) {
    ctx.beginPath();
    ctx.moveTo(p, half);
    ctx.lineTo(p, half + walk);
    ctx.moveTo(p, s - half - walk);
    ctx.lineTo(p, s - half);
    ctx.moveTo(half, p);
    ctx.lineTo(half + walk, p);
    ctx.moveTo(s - half - walk, p);
    ctx.lineTo(s - half, p);
    ctx.stroke();
  }
  ctx.fillStyle = '#26272d';
  ctx.fillRect(half + walk, half + walk, s - 2 * (half + walk), s - 2 * (half + walk));
  const line = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  // Markings. The tile's edges are the middles of the streets: the street at y = 0 has its +z half at the top of the
  // tile and its -z half at the bottom (and the same for x). Traffic on a street along x drives towards +x on its +z
  // half; on a street along z towards -z on its +x half (traffic.ts, `dirOf`).
  const white = '#c9c9c4';
  const yellow = '#b39232';
  const stop = (STREET / 2 + 4.3) * m; // the stop line, from the middle of the crossing
  for (const edge of [0, s]) {
    // A double yellow line down the middle, white dashes between the lanes — between the crossings only.
    line(half + 5.6 * m, edge - 0.35 * m, s - 2 * half - 11.2 * m, 0.25 * m, yellow);
    line(half + 5.6 * m, edge + 0.1 * m, s - 2 * half - 11.2 * m, 0.25 * m, yellow);
    line(edge - 0.35 * m, half + 5.6 * m, 0.25 * m, s - 2 * half - 11.2 * m, yellow);
    line(edge + 0.1 * m, half + 5.6 * m, 0.25 * m, s - 2 * half - 11.2 * m, yellow);
    for (const side of [-1, 1]) {
      for (let p = half + 6 * m; p < s - half - 8 * m; p += 9 * m) {
        line(p, edge + side * 5 * m - 0.07 * m, 3 * m, 0.15 * m, white);
        line(edge + side * 5 * m - 0.07 * m, p, 0.15 * m, 3 * m, white);
      }
    }
  }
  // Zebra crossings at the four sides of each crossing, and the stop lines before them.
  for (const c of [0, s]) {
    const at = c === 0 ? half : s - half; // where the crossing ends towards this tile's inside
    const out = c === 0 ? 1 : -1;
    for (let k = -half + 0.6 * m; k < half - 0.6 * m; k += 1.1 * m) {
      for (const edge of [0, s]) {
        // across the street along x, next to the crossing at x = c
        line(at + out * 0.8 * m - (out < 0 ? 3 * m : 0), edge + k, 3 * m, 0.55 * m, white);
        // across the street along z, next to the crossing at y = c
        line(edge + k, at + out * 0.8 * m - (out < 0 ? 3 * m : 0), 0.55 * m, 3 * m, white);
      }
    }
  }
  // Stop lines: on the half of the road that drives towards the crossing.
  line(s - stop - 0.5 * m, 0, 0.5 * m, half, white); // street along x at y=0, +x traffic (+z half) before x = s
  line(stop, s - half, 0.5 * m, half, white); // the same street, -x traffic (-z half, the tile's bottom) before x = 0
  line(0, stop, half, 0.5 * m, white); // street along z at x=0, -z traffic (+x half) before y = 0
  line(s - half, s - stop - 0.5 * m, half, 0.5 * m, white); // the same street, +z traffic (-x half) before y = s
  // Street lamps along the pavement: pools of warm light.
  const lamp = (x: number, y: number) => {
    const rr = 10 * m;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rr);
    g.addColorStop(0, 'rgba(255, 200, 130, 0.42)');
    g.addColorStop(0.4, 'rgba(255, 170, 90, 0.14)');
    g.addColorStop(1, 'rgba(255, 160, 80, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rr, y - rr, 2 * rr, 2 * rr);
  };
  for (let k = 0; k < 4; k++) {
    const p = half + ((k + 0.5) * (s - 2 * half)) / 4;
    lamp(p, half + 0.8 * m);
    lamp(p, s - half - 0.8 * m);
    lamp(half + 0.8 * m, p);
    lamp(s - half - 0.8 * m, p);
  }
  grain(ctx, s, 6, r);
}

/**
 * One material for every building and for what stands on the roofs. A front is worked out per pixel from where on the
 * wall the pixel is: stone or brick with windows set in it, bands of windows, a wall of glass that mirrors the sky, or
 * piers with tall windows between. A lit window shows a room — brighter under the ceiling, a blind half down here and
 * there; an unlit one shows the sky it faces, more of it the flatter one looks at it. `round`: the same for a round
 * tower (a cylinder), where the way round the tower is the way along the wall.
 */
function buildingMaterial(round = false): THREE.ShaderMaterial {
  const c = (hex: string) => new THREE.Color(hex);
  return new THREE.ShaderMaterial({
    fog: true,
    defines: round ? { ROUND: 1 } : {},
    uniforms: {
      ...FOG.uniforms(),
      uTime: { value: 0 },
      uGlow: { value: c('#ff8c5a') },
      uGlowDir: { value: new THREE.Vector3(-1, 0, -0.35).normalize() },
      uZenith: { value: c('#0b1236') },
      uMid: { value: c('#3a2d6e') },
      uHorizon: { value: c('#b06a82') },
      uSkyAmb: { value: c('#8f86c4') },
      uGround: { value: c('#4a3a40') },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aLook; // seed, share of windows lit, what the front is, its tint
      varying vec3 vLocal;
      varying vec3 vSize;
      varying vec3 vNormal;
      varying vec3 vWorld;
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
        vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        ${FOG.vertex}
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vLocal;
      varying vec3 vSize;
      varying vec3 vNormal;
      varying vec3 vWorld;
      varying vec4 vLook;
      varying float vStreet;
      uniform vec3 uGlow, uGlowDir, uZenith, uMid, uHorizon, uSkyAmb, uGround;
      uniform float uTime;
      ${GLSL_NOISE}
      ${FOG.parsFragment}

      // The sky as a pane of glass mirrors it: the last light low in the west, dark blue overhead; below the horizon,
      // the city at dusk.
      vec3 mirrored(vec3 r) {
        float y = r.y;
        vec3 up = mix(uHorizon, uMid, smoothstep(0.0, 0.22, y));
        up = mix(up, uZenith, smoothstep(0.22, 0.75, y));
        vec3 flat_ = normalize(vec3(r.x, 0.0, r.z) + 1e-5);
        up += uGlow * pow(max(dot(flat_, uGlowDir), 0.0), 5.0) * (1.0 - smoothstep(0.0, 0.3, y)) * 0.8;
        // (The city below glows warm: its streets and its windows.)
        vec3 down = mix(uHorizon * 0.5, vec3(0.09, 0.06, 0.07), smoothstep(0.0, 0.35, -y));
        return mix(down, up, smoothstep(-0.02, 0.02, y));
      }

      vec3 albedo(float kind, float t) {
        if (kind < 0.5) return t < 0.3 ? vec3(0.49, 0.42, 0.31) : t < 0.58 ? vec3(0.25, 0.075, 0.045) : t < 0.8 ? vec3(0.15, 0.06, 0.04) : vec3(0.27, 0.27, 0.25);
        if (kind < 1.5) return t < 0.4 ? vec3(0.32, 0.32, 0.3) : t < 0.75 ? vec3(0.56, 0.54, 0.5) : vec3(0.07, 0.075, 0.09);
        if (kind < 2.5) return t < 0.3 ? vec3(0.012, 0.04, 0.058) : t < 0.6 ? vec3(0.013, 0.028, 0.078) : t < 0.8 ? vec3(0.042, 0.03, 0.019) : vec3(0.074, 0.098, 0.133);
        if (kind < 3.5) return t < 0.55 ? vec3(0.38, 0.35, 0.28) : t < 0.8 ? vec3(0.2, 0.19, 0.17) : vec3(0.027, 0.031, 0.04);
        return t < 0.5 ? vec3(0.2, 0.2, 0.19) : t < 0.85 ? vec3(0.12, 0.13, 0.14) : t < 0.95 ? vec3(0.13, 0.065, 0.03) : vec3(0.05, 0.11, 0.035);
      }

      void main() {
        vec3 n = normalize(vNormal);
        vec3 V = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 3.0);
        vec3 refl = mirrored(reflect(-V, n));
        // The seed reaches a pixel through interpolation, which on some graphics cards leaves it a hair off from one
        // pixel to the next; the hashes below turn a hair into another answer, and a window near the line between lit
        // and dark then came out as a field of lit and dark pixels that crawled when the camera moved. So the seed is
        // put back on the grid it was made on (SEED_STEPS), and so is the share of lit windows.
        float seed = floor(vLook.x * ${SEED_STEPS.toFixed(1)} + 0.5) / ${SEED_STEPS.toFixed(1)};
        float share = floor(vLook.y * ${SEED_STEPS.toFixed(1)} + 0.5) / ${SEED_STEPS.toFixed(1)};
        float kind = floor(vLook.z + 0.5);
        float tint = floor(vLook.w * ${SEED_STEPS.toFixed(1)} + 0.5) / ${SEED_STEPS.toFixed(1)};
        vec3 base = albedo(kind, tint);
        // Light: the sky from above, the street's glow from below, the last of the sun from the west; the higher, the more sky.
        float above = vWorld.y + ${DROP.toFixed(1)};
        float high = smoothstep(0.0, 260.0, above);
        vec3 light = mix(uGround, uSkyAmb, n.y * 0.5 + 0.5) * (0.85 + 0.75 * high) + uGlow * max(dot(n, uGlowDir), 0.0) * (0.3 + 0.55 * high);
        vec3 col;
        if (n.y > 0.5) {
          // A roof: gravel and tar, a parapet round its edge — or the top of whatever stands on it.
          #ifdef ROUND
            float edge = vSize.x * 0.5 - length(vLocal.xz);
          #else
            vec2 e2 = vSize.xz * 0.5 - abs(vLocal.xz);
            float edge = min(e2.x, e2.y);
          #endif
          float rim = 1.0 - smoothstep(0.5, 1.2, edge);
          vec2 p = vWorld.xz / 7.0;
          float fine = 1.0 - smoothstep(0.25, 0.9, length(fwidth(p)));
          float patchy = 0.82 + 0.36 * mix(0.5, vnoise(p + seed * 50.0), fine);
          vec3 roof = kind > 3.5 ? base : vec3(0.085, 0.082, 0.075) * patchy;
          // (A roof sees the whole sky; seen from above it is still the darkest thing in a lit city.)
          vec3 roofLight = mix(light, vec3(dot(light, vec3(0.333))), 0.55) * 0.75;
          col = roof * roofLight + base * light * rim * (kind > 3.5 ? 0.0 : 0.6);
        } else {
          #ifdef ROUND
            vec2 q = vLocal.xz / max(vSize.xz * 0.5, vec2(0.01));
            float u = (atan(q.y, q.x) + 3.14159265) * vSize.x * 0.5;
            float side = 1.0;
            float wallLen = 3.14159265 * vSize.x;
          #else
            bool alongZ = abs(n.x) > 0.5;
            float u = (alongZ ? vLocal.z : vLocal.x) + (alongZ ? vSize.z : vSize.x) * 0.5;
            float side = alongZ ? (n.x > 0.0 ? 1.0 : 2.0) : (n.z > 0.0 ? 3.0 : 4.0);
            float wallLen = alongZ ? vSize.z : vSize.x;
          #endif
          float bay = kind > 1.5 && kind < 2.5 ? 1.6 : ${BAY.toFixed(1)};
          vec2 cell = vec2(u / bay, vLocal.y / ${FLOOR_H.toFixed(1)});
          vec2 id = floor(cell);
          vec2 f = fract(cell);
          vec2 w = fwidth(cell);
          // Where the glass is within one bay of one floor, for each kind of front.
          vec2 lo = kind < 0.5 ? vec2(0.22, 0.28) : kind < 1.5 ? vec2(0.0, 0.36) : kind < 2.5 ? vec2(0.0, 0.0) : vec2(0.32, 0.14);
          vec2 hi = kind < 0.5 ? vec2(0.78, 0.82) : kind < 1.5 ? vec2(1.0, 0.86) : kind < 2.5 ? vec2(1.0, 0.8) : vec2(0.92, 0.9);
          vec2 inside = smoothstep(lo - w, lo + w, f) * (1.0 - smoothstep(hi - w, hi + w, f));
          float glass = kind > 3.5 ? 0.0 : inside.x * inside.y;
          // Mullions: the thin frames between panes of a band or a wall of glass.
          float mullion = (kind > 0.5 && kind < 2.5) ? 1.0 - smoothstep(0.035, 0.035 + w.x * 1.5, min(f.x, 1.0 - f.x)) : 0.0;
          glass *= 1.0 - mullion;
          float area = kind > 3.5 ? 0.0 : (hi.x - lo.x) * (hi.y - lo.y) * (kind > 0.5 && kind < 2.5 ? 0.93 : 1.0);
          // Which rooms have the light on: by room, with whole floors working late or gone home.
          float floorMood = hash21(vec2(id.y, seed * 57.0 + side));
          float on = step(hash21(id + vec2(seed * 131.0, side * 7.0)), share * (floorMood > 0.86 ? 2.4 : floorMood < 0.25 ? 0.2 : 1.0));
          float pick = hash21(id * 1.7 + seed * 17.0);
          vec3 lamp = pick < 0.55 ? vec3(1.0, 0.66, 0.34) : pick < 0.88 ? vec3(1.0, 0.85, 0.66) : vec3(0.7, 0.85, 1.0);
          lamp *= 0.55 + 0.6 * hash21(id + seed * 3.0);
          // The room behind a lit window: the ceiling's lights at the top, darker towards the floor; a blind half down.
          vec2 g = clamp((f - lo) / max(hi - lo, vec2(0.01)), 0.0, 1.0);
          vec3 room = lamp * (0.4 + 0.85 * g.y * g.y);
          float blind = step(hash21(id * 2.3 + seed * 7.0), 0.35) * (0.25 + 0.6 * hash21(id * 5.1 + seed));
          room *= mix(1.0, 0.32, smoothstep(1.0 - blind - w.y * 3.0, 1.0 - blind + w.y * 3.0, g.y));
          float shine = kind > 1.5 && kind < 2.5 ? 1.0 : kind > 0.5 && kind < 1.5 ? 0.75 : 0.5;
          // Panes are never quite flat: each mirrors a shade differently.
          float pane = 0.8 + 0.4 * hash21(id * 0.37 + seed * 9.0);
          vec3 dark = vec3(0.01, 0.011, 0.016) + refl * mix(0.22, 0.95, fres) * shine * pane;
          vec3 lit = room * 1.15 + refl * fres * 0.3 * shine;
          // The wall: its stone or panel in the light; a wall of glass mirrors between the windows too.
          vec3 wall = base * light;
          if (kind > 1.5 && kind < 2.5) wall = base * light * 1.2 + refl * mix(0.3, 0.9, fres) * 0.8;
          // Piers stand out from the wall: one side of each in shade.
          if (kind > 2.5 && kind < 3.5) wall *= 0.78 + 0.22 * smoothstep(0.0, 0.3, f.x);
          vec3 near = mix(mix(wall, wall * 0.55, mullion), mix(dark, lit, on), glass);
          // Far away a window is smaller than a pixel: what is left is the wall's average, which does not shimmer.
          vec3 mean = mix(wall, mix(vec3(0.01) + refl * mix(0.22, 0.95, fres) * shine, vec3(1.0, 0.74, 0.46) * 0.8, share), area);
          float detail = 1.0 - smoothstep(0.3, 0.85, max(w.x, w.y));
          col = mix(mean, near, detail);
          // Edges: a darker line at every corner, so a block has corners.
          #ifndef ROUND
            float fromSide = min(u, wallLen - u);
            col *= 0.75 + 0.25 * smoothstep(0.0, 0.9, fromSide);
          #endif
          // The ground floors: shop fronts, lit, under a dark band of awnings and signs.
          float shop = vStreet * (1.0 - smoothstep(4.0, 4.3, vLocal.y)) * smoothstep(0.5, 0.8, vLocal.y);
          float sign_ = vStreet * smoothstep(4.0, 4.3, vLocal.y) * (1.0 - smoothstep(5.0, 5.3, vLocal.y));
          float bayShop = fract(u / 7.0);
          vec3 window_ = vec3(1.0, 0.72, 0.42) * (0.2 + 0.5 * hash21(vec2(floor(u / 7.0), seed))) * (0.9 - 0.45 * bayShop) * (1.0 - 0.85 * step(bayShop, 0.06));
          col = mix(col, window_, shop * (kind > 3.5 ? 0.0 : 1.0));
          col = mix(col, base * 0.15 + vec3(0.9, 0.3, 0.2) * step(0.8, hash21(vec2(floor(u / 7.0), seed * 3.0))) * 0.4, sign_ * (kind > 3.5 ? 0.0 : 1.0));
          // The crown of some towers is lit from below at night.
          float crowned = step(hash21(vec2(seed, 3.1)), 0.32) * step(50.0, vSize.y) * step(1.5, kind) * step(kind, 3.5);
          vec3 flood = hash21(vec2(seed, 7.7)) < 0.5 ? vec3(1.0, 0.8, 0.55) : vec3(0.75, 0.85, 1.0);
          float crown = smoothstep(vSize.y - 18.0, vSize.y, vLocal.y);
          col += flood * crowned * crown * crown * 0.12;
        }
        // Down in the street, between the towers, the light does not reach.
        col *= mix(0.42, 1.0, smoothstep(0.0, 34.0, above));
        gl_FragColor = vec4(col, 1.0);
        ${OUTPUT}
        ${FOG.fragment}
      }
    `,
  });
}

/** What drives: one material for the cars and one for the buses, each moved along its lane by the time. */
function vehicleMaterial(grid: StreetGrid): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: {
      ...FOG.uniforms(),
      uTime: { value: 0 },
      uSpan: { value: spanOf(grid) },
      uAcross: { value: acrossOf(grid) },
      uOrigin: { value: new THREE.Vector2() },
      uBand: { value: new THREE.Vector2(0, 1e9) },
      uPitch: { value: grid.pitch },
      uCycle: { value: CYCLE },
      uZOff: { value: Z_OFFSET },
      uGlow: { value: new THREE.Color('#ff8c5a') },
      uSky: { value: new THREE.Color('#8f86c4') },
      uHorizon: { value: new THREE.Color('#b06a82') },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aLane; // 1 when the street runs along x, where the lane is across it, direction, time for a block
      attribute vec4 aCar; // nose at its first wait, delay after green, length, kind (0 car, 1 bus)
      attribute vec3 aPaint;
      attribute vec3 aScale; // its width, height and length against the shape's
      attribute float aPart; // which part (city/vehicles.ts, PART)
      uniform float uTime, uSpan, uAcross, uPitch, uCycle, uZOff;
      uniform vec2 uOrigin, uBand;
      varying vec3 vPaint;
      varying float vPart;
      varying vec3 vAt;
      varying vec3 vNormal;
      varying float vBrake;
      varying float vKind;
      varying float vHalf;
      ${TRAFFIC_GLSL}
      ${FOG.parsVertex}
      void main() {
        float n;
        float f = trafficF(aLane.x, aCar.y, aLane.w, n);
        float along = trafficCenter(aCar.x, aCar.z, n, f);
        // Brake lights: standing, or slowing down for the next queue.
        vBrake = (f <= 0.0 || f >= 1.0 || f > 0.62) ? 1.0 : 0.0;
        vec3 p = position * aScale;
        vAt = p;
        vHalf = aCar.z * 0.5;
        vPaint = aPaint;
        vPart = aPart;
        vKind = aCar.w;
        float d = aLane.z;
        vNormal = aLane.x > 0.5 ? vec3(normal.z * d, normal.y, -normal.x * d) : vec3(normal.x * d, normal.y, normal.z * d);
        // The shape is drawn heading along +z; turn it to its street and its direction.
        // Laid round where one looks from: the pattern repeats along the street and across the streets.
        float a = aLane.x > 0.5 ? nearTo(along * d, uOrigin.x, uSpan) : nearTo(along * d, uOrigin.y, uSpan);
        float b = aLane.x > 0.5 ? nearTo(aLane.y, uOrigin.y, uAcross) : nearTo(aLane.y, uOrigin.x, uAcross);
        vec3 world = aLane.x > 0.5
          ? vec3(a + p.z * d, p.y, b - p.x * d)
          : vec3(b + p.x * d, p.y, a + p.z * d);
        world.y += ${(-DROP).toFixed(1)};
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        // Taken out of the traffic: somebody is driving it. And each shape only within its band of distance: the
        // full one near the camera, the simple one further off.
        float away = length(world.xz - uOrigin);
        if (aCar.w < -0.5 || away < uBand.x || away >= uBand.y) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        ${FOG.vertex}
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vPaint;
      varying float vPart;
      varying vec3 vAt;
      varying vec3 vNormal;
      varying float vBrake;
      varying float vKind;
      varying float vHalf;
      uniform vec3 uGlow, uSky, uHorizon;
      ${FOG.parsFragment}
      void main() {
        vec3 n = normalize(vNormal);
        vec3 light = mix(vec3(0.05, 0.04, 0.05), uSky * 0.45, n.y * 0.5 + 0.5) + uGlow * 0.12 + vec3(0.25, 0.2, 0.14) * 0.6;
        vec3 paint = pow(vPaint, vec3(2.2));
        float part = floor(vPart + 0.5);
        // Paint: its colour in the light, and the sky in its lacquer on top.
        vec3 col = paint * light + uHorizon * 0.16 * pow(max(n.y, 0.0), 2.0) + uSky * 0.04;
        if (part == ${PART.glass.toFixed(1)}) col = vec3(0.018, 0.022, 0.032) + mix(uHorizon * 0.22, uSky * 0.16, max(n.y, 0.0));
        else if (part == ${PART.tyre.toFixed(1)}) col = vec3(0.012);
        else if (part == ${PART.rim.toFixed(1)}) col = vec3(0.32, 0.33, 0.35) * light;
        else if (part == ${PART.trim.toFixed(1)}) col = vec3(0.025, 0.026, 0.03) * (0.6 + light);
        else if (part == ${PART.headlamp.toFixed(1)}) col = vec3(3.0, 2.7, 2.1);
        else if (part == ${PART.taillamp.toFixed(1)}) col = vec3(1.0, 0.05, 0.03) * (vBrake > 0.5 ? 3.2 : 1.3);
        else if (part == ${PART.sign.toFixed(1)}) col = vec3(2.0, 1.75, 1.1);
        else if (part == ${PART.cabin.toFixed(1)}) col = vec3(1.0, 0.82, 0.55) * 0.6 * (0.75 + 0.25 * step(0.12, fract(vAt.z / 1.6)));
        gl_FragColor = vec4(col, 1.0);
        ${OUTPUT}
        ${FOG.fragment}
      }
    `,
  });
}

/** The light a vehicle throws: a beam on the road ahead, red behind — the red brighter while it brakes. */
function poolMaterial(grid: StreetGrid): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { ...FOG.uniforms(), uTime: { value: 0 }, uSpan: { value: spanOf(grid) }, uAcross: { value: acrossOf(grid) }, uOrigin: { value: new THREE.Vector2() }, uPitch: { value: grid.pitch }, uCycle: { value: CYCLE }, uZOff: { value: Z_OFFSET } },
    vertexShader: /* glsl */ `
      attribute vec4 aLane;
      attribute vec4 aCar;
      uniform float uTime, uSpan, uAcross, uPitch, uCycle, uZOff;
      uniform vec2 uOrigin;
      varying vec3 vAt;
      varying float vBrake;
      ${TRAFFIC_GLSL}
      ${FOG.parsVertex}
      void main() {
        float n;
        float f = trafficF(aLane.x, aCar.y, aLane.w, n);
        float along = trafficCenter(aCar.x, aCar.z, n, f);
        vBrake = (f <= 0.0 || f >= 1.0 || f > 0.62) ? 1.0 : 0.0;
        vec3 p = position;
        // The shape's middle is a car's; a bus's lamps are further out.
        float grow = (aCar.z - ${LENGTH.car.toFixed(1)}) * 0.5;
        p.z += p.z > 0.0 ? grow : -grow;
        vAt = vec3(position.x, position.y, p.z - (p.z > 0.0 ? grow : -grow));
        float d = aLane.z;
        // Laid round where one looks from: the pattern repeats along the street and across the streets.
        float a = aLane.x > 0.5 ? nearTo(along * d, uOrigin.x, uSpan) : nearTo(along * d, uOrigin.y, uSpan);
        float b = aLane.x > 0.5 ? nearTo(aLane.y, uOrigin.y, uAcross) : nearTo(aLane.y, uOrigin.x, uAcross);
        vec3 world = aLane.x > 0.5
          ? vec3(a + p.z * d, p.y, b - p.x * d)
          : vec3(b + p.x * d, p.y, a + p.z * d);
        world.y += ${(-DROP).toFixed(1)};
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        // Taken out of the traffic: somebody is driving it.
        if (aCar.w < -0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        ${FOG.vertex}
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vAt;
      varying float vBrake;
      ${FOG.parsFragment}
      void main() {
        float ahead = step(0.0, vAt.z);
        float reach = ahead > 0.5 ? (vAt.z - 2.3) / 16.0 : (-vAt.z - 2.3) / (vBrake > 0.5 ? 5.0 : 3.5);
        float width = abs(vAt.x) / (ahead > 0.5 ? 1.1 + reach * 3.2 : 1.5);
        float glow = smoothstep(1.0, 0.0, width) * smoothstep(1.0, 0.0, reach) * smoothstep(-0.12, 0.05, reach);
        vec3 col = ahead > 0.5 ? vec3(1.0, 0.9, 0.72) * 0.7 : vec3(1.0, 0.1, 0.06) * (vBrake > 0.5 ? 1.5 : 0.8);
        gl_FragColor = vec4(col * glow, glow);
        ${OUTPUT}
        ${FOG.fragment}
      }
    `,
  });
}

/** The traffic lights: at each corner of a crossing, one for each direction, green, amber or red by the time. */
function signalMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uScale: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute float aAxis; // 0: for the street along x, 1: along z
      uniform float uTime, uScale;
      varying vec3 vColor;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float local = mod(uTime - aAxis * ${Z_OFFSET.toFixed(1)}, ${CYCLE.toFixed(1)});
        vColor = local < ${GREEN.toFixed(1)} ? vec3(0.2, 1.0, 0.55) : local < ${(GREEN + AMBER).toFixed(1)} ? vec3(1.0, 0.62, 0.08) : vec3(1.0, 0.08, 0.05);
        gl_PointSize = clamp(110.0 * uScale / max(-mv.z, 1.0), 1.5, 6.0) * uScale;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = smoothstep(1.0, 0.0, d);
        gl_FragColor = vec4(vColor * a * a * 1.4, a);
        ${OUTPUT}
      }
    `,
  });
}

/** Many vehicles of one shape as one thing to draw, each told its lane, its place in the queue and its paint. */
function fleet(kept: Kept, shape: THREE.BufferGeometry, material: THREE.Material, list: Vehicle[], scaleOf: (v: Vehicle) => [number, number, number]): THREE.InstancedMesh {
  const lanes = new Float32Array(list.length * 4);
  const looks = new Float32Array(list.length * 4);
  const paints = new Float32Array(list.length * 3);
  const scales = new Float32Array(list.length * 3);
  list.forEach((v, i) => {
    lanes.set([v.alongX ? 1 : 0, v.across, v.dir, v.travel], i * 4);
    looks.set([v.stop, v.delay, v.length, v.kind === 'bus' ? 1 : 0], i * 4);
    paints.set(v.paint, i * 3);
    scales.set(scaleOf(v), i * 3);
  });
  const g = kept.add(shape);
  g.setAttribute('aLane', new THREE.InstancedBufferAttribute(lanes, 4));
  g.setAttribute('aCar', new THREE.InstancedBufferAttribute(looks, 4));
  if (g.getAttribute('aPart')) {
    g.setAttribute('aPaint', new THREE.InstancedBufferAttribute(paints, 3));
    g.setAttribute('aScale', new THREE.InstancedBufferAttribute(scales, 3));
  }
  const mesh = instanced(g, material, list.map(() => new THREE.Matrix4()));
  mesh.frustumCulled = false;
  return mesh;
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

/** People on the pavements: one shape, each moved round its block by the time, legs and arms swinging as they go. */
function walkerMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: { ...FOG.uniforms(), uTime: { value: 0 }, uOrigin: { value: new THREE.Vector2() }, uHide: { value: 0 }, uGlow: { value: new THREE.Color('#ff8c5a') }, uSky: { value: new THREE.Color('#8f86c4') } },
    vertexShader: /* glsl */ `
      attribute vec4 aWalk; // where round the block they started, speed (its sign: which way round), how far out from the block's middle, stride
      attribute vec2 aBlock; // which block, from the pattern's middle
      attribute vec3 aShirt;
      attribute vec3 aPants;
      attribute vec3 aSkin;
      attribute vec3 aPart; // shirt, trousers, skin
      uniform float uTime, uHide;
      uniform vec2 uOrigin;
      varying vec3 vColor;
      varying vec3 vNormal;
      ${FOG.parsVertex}
      vec3 swing(vec3 p, float pivot, float a) {
        float y = p.y - pivot;
        return vec3(p.x, pivot + y * cos(a) - p.z * sin(a), y * sin(a) + p.z * cos(a));
      }
      void main() {
        float r = aWalk.z;
        float len = 8.0 * r;
        float s = mod(aWalk.x + aWalk.y * uTime, len);
        float side = floor(s / (2.0 * r));
        float u = s - side * 2.0 * r - r;
        vec2 at = side < 0.5 ? vec2(u, -r) : side < 1.5 ? vec2(r, u) : side < 2.5 ? vec2(-u, r) : vec2(-r, -u);
        float heading = side < 0.5 ? 1.5708 : side < 1.5 ? 0.0 : side < 2.5 ? -1.5708 : 3.14159;
        if (aWalk.y < 0.0) heading += 3.14159;
        float phase = s / aWalk.w * 6.2832;
        vec3 p = position;
        vec3 nn = normal;
        float left = p.x < 0.0 ? 1.0 : -1.0;
        if (aPart.y > 0.5) p = swing(p, 0.88, sin(phase) * 0.5 * left);
        else if (aPart.x > 0.5 && abs(p.x) > 0.24) p = swing(p, 1.42, -sin(phase) * 0.4 * left);
        float c = cos(heading);
        float sn = sin(heading);
        vec3 turned = vec3(p.x * c + p.z * sn, p.y + abs(sin(phase)) * 0.03, -p.x * sn + p.z * c);
        vNormal = vec3(nn.x * c + nn.z * sn, nn.y, -nn.x * sn + nn.z * c);
        vec2 block = vec2(${(9 * PITCH).toFixed(1)});
        vec2 middle = uOrigin + mod(aBlock * ${PITCH.toFixed(1)} - uOrigin + block * 0.5, block) - block * 0.5;
        vec3 world = vec3(middle.x + at.x, ${STREET_Y.toFixed(1)} + 0.15, middle.y + at.y) + turned;
        vColor = aPart.x > 0.5 ? aShirt : aPart.y > 0.5 ? aPants : aSkin;
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        // Near the camera they are drawn as characters of their own (CityWalkers): not twice.
        if (length(vec2(middle.x + at.x, middle.y + at.y) - uOrigin) < uHide) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        ${FOG.vertex}
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vColor;
      varying vec3 vNormal;
      uniform vec3 uGlow, uSky;
      ${FOG.parsFragment}
      void main() {
        vec3 n = normalize(vNormal);
        vec3 light = mix(vec3(0.12, 0.09, 0.08), uSky * 0.5, n.y * 0.5 + 0.5) + vec3(0.42, 0.32, 0.22) * 0.55;
        gl_FragColor = vec4(vColor * light, 1.0);
        ${OUTPUT}
        ${FOG.fragment}
      }
    `,
  });
}

/** A person: legs, a body with arms, a head — parts by `aPart` (shirt, trousers, skin). */
function walkerShape(): THREE.BufferGeometry {
  const shirt = new THREE.Color(1, 0, 0);
  const pants = new THREE.Color(0, 1, 0);
  const skin = new THREE.Color(0, 0, 1);
  const t = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
  const g = merged([
    { geometry: new THREE.BoxGeometry(0.16, 0.86, 0.18), color: pants, matrix: t(-0.1, 0.45, 0) },
    { geometry: new THREE.BoxGeometry(0.16, 0.86, 0.18), color: pants, matrix: t(0.1, 0.45, 0) },
    { geometry: new THREE.BoxGeometry(0.42, 0.62, 0.24), color: shirt, matrix: t(0, 1.18, 0) },
    { geometry: new THREE.BoxGeometry(0.1, 0.58, 0.12), color: shirt, matrix: t(-0.27, 1.14, 0) },
    { geometry: new THREE.BoxGeometry(0.1, 0.58, 0.12), color: shirt, matrix: t(0.27, 1.14, 0) },
    { geometry: new THREE.BoxGeometry(0.2, 0.24, 0.22), color: skin, matrix: t(0, 1.64, 0) },
  ]);
  g.setAttribute('aPart', g.getAttribute('color'));
  g.deleteAttribute('color');
  return g;
}

/** Nearer than this to the camera, a vehicle is drawn in its full shape. */
const NEAR_CARS = 160;

/** How many blocks round the camera are drawn, each way. */
const SHOWN = 6;

/** The traffic of the city: the same list for the picture and for the person who takes a car out of it. */
export const CITY_GRID: StreetGrid = { pitch: PITCH, street: STREET, reach: REACH };
const fleets = new Map<string, Vehicle[]>();
export function cityTraffic(quality: PlaceInput['quality']): Vehicle[] {
  const key = quality === 'low' ? 'low' : 'high';
  let list = fleets.get(key);
  if (!list) fleets.set(key, (list = traffic(CITY_GRID, rng(77001), quality === 'low' ? 0.55 : 1)));
  return list;
}

/** What the city shows that somebody outside changes: the vehicle they took out of the traffic (its index), or -1. */
export const cityLive = { taken: -1, quality: 'high' as PlaceInput['quality'], walkersNear: 0 };

/** The people of the pavements: the same list for the picture far away and for the characters near by. */
const crowds = new Map<string, Walker[]>();
export function cityWalkersFor(quality: PlaceInput['quality']): Walker[] {
  const key = quality === 'low' ? 'low' : 'high';
  let list = crowds.get(key);
  if (!list) crowds.set(key, (list = cityWalkers(quality === 'low' ? 4 : 9)));
  return list;
}

export function buildSkyline({ quality }: PlaceInput): Place {
  const kept = new Kept();
  const group = new THREE.Group();
  const random = rng(20261112);
  const grid = CITY_GRID;
  cityLive.quality = quality;

  // ── the streets: one picture that repeats, kept under the camera ──
  const tile = kept.add(painted(quality === 'low' ? 512 : 1024, streetTile, [2 * SHOWN + 5, 2 * SHOWN + 5]));
  const groundSize = (2 * SHOWN + 5) * PITCH;
  const ground = new THREE.Mesh(kept.add(new THREE.PlaneGeometry(groundSize, groundSize)), kept.add(new THREE.MeshBasicMaterial({ map: tile, color: '#b8b0c8' })));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -DROP;
  group.add(ground);

  // ── the buildings: those of the blocks round the camera, made again when the camera reaches another block ──
  const material = kept.add(buildingMaterial());
  const roundMaterial = kept.add(buildingMaterial(true));
  const tankShape = merged([
    { geometry: new THREE.CylinderGeometry(1, 1, 1.5, 14), color: '#000', matrix: new THREE.Matrix4().makeTranslation(0, 2.35, 0) },
    { geometry: new THREE.ConeGeometry(1.08, 0.7, 14), color: '#000', matrix: new THREE.Matrix4().makeTranslation(0, 3.45, 0) },
    ...[[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]].map(([x, z]) => ({ geometry: new THREE.BoxGeometry(0.12, 1.6, 0.12), color: '#000', matrix: new THREE.Matrix4().makeTranslation(x!, 0.8, z!) })),
  ]);
  const blocksAcross = 2 * SHOWN + 1;
  const kinds: Record<'box' | 'round' | 'tank' | 'tree' | 'lawn', { geometry: THREE.BufferGeometry; material: THREE.ShaderMaterial; capacity: number }> = {
    box: { geometry: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), material, capacity: blocksAcross ** 2 * 26 + 81 * 40 },
    round: { geometry: new THREE.CylinderGeometry(0.5, 0.5, 1, 40, 1).translate(0, 0.5, 0), material: roundMaterial, capacity: blocksAcross ** 2 * 2 },
    tank: { geometry: tankShape, material, capacity: blocksAcross ** 2 * 4 },
    tree: { geometry: new THREE.IcosahedronGeometry(1, 1), material, capacity: blocksAcross ** 2 * 60 },
    lawn: { geometry: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), material, capacity: blocksAcross ** 2 },
  };
  const meshes = Object.fromEntries(
    Object.entries(kinds).map(([k, v]) => {
      const g = kept.add(v.geometry);
      const looks = new THREE.InstancedBufferAttribute(new Float32Array(v.capacity * 4), 4);
      looks.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('aLook', looks);
      const mesh = new THREE.InstancedMesh(g, v.material, v.capacity);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      group.add(mesh);
      return [k, { mesh, looks, capacity: v.capacity }];
    }),
  ) as unknown as Record<keyof typeof kinds, { mesh: THREE.InstancedMesh; looks: THREE.InstancedBufferAttribute; capacity: number }>;
  const tmp = new THREE.Matrix4();
  const beaconSpots: number[] = [];
  let shownAt = '';
  const nearTrees = quality === 'low' ? 2 : 4;
  /** Lay out the blocks round block (bi, bj). */
  const showAround = (bi: number, bj: number) => {
    const fill = { box: 0, round: 0, tank: 0, tree: 0, lawn: 0 };
    const put = (shape: keyof typeof fill, x: number, y: number, z: number, w: number, h: number, d: number, rot: number, look: readonly number[]) => {
      const m = meshes[shape];
      const n = fill[shape];
      if (n >= m.capacity) return;
      m.mesh.setMatrixAt(n, tmp.copy(at(x, y, z, rot, w, h, d)));
      m.looks.setXYZW(n, look[0]!, look[1]!, look[2]!, look[3]!);
      fill[shape] = n + 1;
    };
    beaconSpots.length = 0;
    for (let i = bi - SHOWN; i <= bi + SHOWN; i++) {
      for (let j = bj - SHOWN; j <= bj + SHOWN; j++) {
        const b = blockAt(i, j);
        for (const p of b.parts) put(p.shape, p.x, p.y, p.z, p.w, p.h, p.d, p.rot, p.look);
        for (const [x, y, z] of b.beacons) beaconSpots.push(x, y, z);
        if (Math.abs(i - bi) <= nearTrees && Math.abs(j - bj) <= nearTrees) {
          // A street tree: a trunk, and its crown high enough to walk under.
          for (const [x, z, r] of streetTrees(i, j)) {
            put('box', x, -DROP, z, 0.24, 5.4, 0.24, 0, [0.5, 0, FRONT.plain, PLAIN.wood]);
            put('tree', x, -DROP + 5.3 + r * 0.45, z, r, r * 0.8, r, 0, [onGrid(((x * 7 + z * 13) % 1 + 1) % 1), 0, FRONT.plain, PLAIN.leaves]);
          }
        }
      }
    }
    for (const [k, m] of Object.entries(meshes)) {
      m.mesh.count = fill[k as keyof typeof fill];
      m.mesh.instanceMatrix.needsUpdate = true;
      m.looks.needsUpdate = true;
    }
    // The red lights on the tall roofs (the first of the beacons; what flies comes after them).
    const n = Math.min(beaconSpots.length / 3, MAX_BEACONS);
    beaconAt.fill(0, 0, MAX_BEACONS * 3);
    beaconAt.set(beaconSpots.slice(0, n * 3));
    for (let k = 0; k < MAX_BEACONS; k++) beaconLook.set(k < n ? [1, 0.12, 0.08, ((k * 0.618) % 1)] : [0, 0, 0, 0], k * 4);
    beaconLookAttr.needsUpdate = true;
    beaconPos.needsUpdate = true;
  };

  // ── traffic, and the lights it stops at ──
  const vehicles = cityTraffic(quality);
  const carMat = kept.add(vehicleMaterial(grid));
  const poolMat = kept.add(poolMaterial(grid));
  // One shape for each kind (a saloon, an SUV, a taxi, a bus), each drawn at once for all of its kind.
  const byKind: Record<Vehicle['kind'], number[]> = { car: [], suv: [], taxi: [], bus: [] };
  vehicles.forEach((v, i) => byKind[v.kind].push(i));
  const shapes: Record<Vehicle['kind'], Body> = { car: 'sedan', suv: 'suv', taxi: 'taxi', bus: 'bus' };
  // Two of each: everyone in a simple shape (drawn further than NEAR_CARS from the camera), and the few near the
  // camera in the full one — chosen again every few tenths of a second (`pickNear`), wider than they are drawn, so that
  // nobody near is missing between two choices.
  const fleetOf = Object.fromEntries((Object.keys(byKind) as Array<Vehicle['kind']>).map((k) => [k, fleet(kept, vehicleShape(shapes[k], true, true), carMat, byKind[k].map((i) => vehicles[i]!), () => [1, 1, 1])])) as Record<Vehicle['kind'], THREE.InstancedMesh>;
  (carMat.uniforms.uBand!.value as THREE.Vector2).set(NEAR_CARS, 1e9);
  const nearMat = kept.add(carMat.clone());
  (nearMat.uniforms.uBand!.value as THREE.Vector2).set(0, NEAR_CARS);
  const NEAR_CAP = 400;
  const nearOf = Object.fromEntries(
    (Object.keys(byKind) as Array<Vehicle['kind']>).map((k) => {
      const g = kept.add(vehicleShape(shapes[k]));
      const attr = (n: number) => {
        const a = new THREE.InstancedBufferAttribute(new Float32Array(NEAR_CAP * n), n);
        a.setUsage(THREE.DynamicDrawUsage);
        return a;
      };
      const parts = { aLane: attr(4), aCar: attr(4), aPaint: attr(3), aScale: attr(3) };
      for (const [name, a] of Object.entries(parts)) g.setAttribute(name, a);
      const mesh = new THREE.InstancedMesh(g, nearMat, NEAR_CAP);
      mesh.count = 0;
      mesh.frustumCulled = false;
      return [k, { mesh, ...parts }];
    }),
  ) as unknown as Record<Vehicle['kind'], { mesh: THREE.InstancedMesh; aLane: THREE.InstancedBufferAttribute; aCar: THREE.InstancedBufferAttribute; aPaint: THREE.InstancedBufferAttribute; aScale: THREE.InstancedBufferAttribute }>;
  let pickedAt = -1;
  let pickedTaken = -1;
  const pickNear = (time: number, at: { x: number; z: number }) => {
    const fill = { car: 0, suv: 0, taxi: 0, bus: 0 } as Record<Vehicle['kind'], number>;
    for (let i = 0; i < vehicles.length; i++) {
      if (i === cityLive.taken) continue;
      const v = vehicles[i]!;
      const p = vehicleAt(v, time, grid, at);
      if (Math.hypot(p.x - at.x, p.z - at.z) > NEAR_CARS + 45) continue;
      const n = nearOf[v.kind];
      const k = fill[v.kind];
      if (k >= NEAR_CAP) continue;
      n.aLane.setXYZW(k, v.alongX ? 1 : 0, v.across, v.dir, v.travel);
      n.aCar.setXYZW(k, v.stop, v.delay, v.length, v.kind === 'bus' ? 1 : 0);
      n.aPaint.setXYZ(k, v.paint[0], v.paint[1], v.paint[2]);
      n.aScale.setXYZ(k, 1, 1, 1);
      fill[v.kind] = k + 1;
    }
    for (const k of Object.keys(nearOf) as Array<Vehicle['kind']>) {
      const n = nearOf[k];
      n.mesh.count = fill[k];
      for (const a of [n.aLane, n.aCar, n.aPaint, n.aScale]) a.needsUpdate = true;
    }
  };
  group.add(...Object.values(nearOf).map((n) => n.mesh));
  const pools = fleet(kept, new THREE.PlaneGeometry(9.5, 24).rotateX(-Math.PI / 2).translate(0, 0.12, 5.6), poolMat, vehicles, () => [1, 1, 1]);
  pools.renderOrder = 2;
  group.add(...Object.values(fleetOf), pools);
  /** Take a vehicle out of the traffic (somebody is driving it now), or put it back. */
  let hidden = -1;
  const hide = (index: number, gone: boolean) => {
    if (index < 0 || index >= vehicles.length) return;
    const v = vehicles[index]!;
    const kind = gone ? -1 : v.kind === 'bus' ? 1 : 0;
    const own = fleetOf[v.kind];
    const at_ = byKind[v.kind].indexOf(index);
    for (const [mesh, k] of [[own, at_], [pools, index]] as const) {
      const attr = mesh.geometry.getAttribute('aCar') as THREE.InstancedBufferAttribute;
      attr.setW(k, kind);
      attr.needsUpdate = true;
    }
  };
  const signalAt: number[] = [];
  const signalAxis: number[] = [];
  for (let a = -SHOWN - 1; a <= SHOWN; a++) {
    for (let b = -SHOWN - 1; b <= SHOWN; b++) {
      const x = (a + 0.5) * PITCH;
      const z = (b + 0.5) * PITCH;
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
        const ox = x + sx * (STREET / 2 + 0.8);
        const oz = z + sz * (STREET / 2 + 0.8);
        signalAt.push(ox, -DROP + 5.2, oz, ox - sx * 0.6, -DROP + 5.2, oz - sz * 0.6);
        signalAxis.push(0, 1);
      }
    }
  }
  const signalGeo = kept.add(new THREE.BufferGeometry());
  signalGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(signalAt), 3));
  signalGeo.setAttribute('aAxis', new THREE.BufferAttribute(new Float32Array(signalAxis), 1));
  const signalMat = kept.add(signalMaterial());
  const signals = new THREE.Points(signalGeo, signalMat);
  signals.frustumCulled = false;
  signals.renderOrder = 3;
  group.add(signals);

  // ── people on the pavements: far away one simple shape each; near the camera the office's own characters (CityWalkers) ──
  const walkers = cityWalkersFor(quality);
  const rgb = (hex: string) => {
    const c = new THREE.Color(hex);
    return [c.r, c.g, c.b];
  };
  const walkerGeo = kept.add(walkerShape());
  const attr = (n: number, f: (w: Walker) => readonly number[]) => new THREE.InstancedBufferAttribute(new Float32Array(walkers.flatMap((w) => [...f(w)])), n);
  walkerGeo.setAttribute('aWalk', attr(4, (w) => w.walk));
  walkerGeo.setAttribute('aBlock', attr(2, (w) => w.block));
  walkerGeo.setAttribute('aShirt', attr(3, (w) => rgb(w.look.shirt)));
  walkerGeo.setAttribute('aPants', attr(3, (w) => rgb(w.look.pants)));
  walkerGeo.setAttribute('aSkin', attr(3, (w) => rgb(w.look.skin)));
  const walkerMat = kept.add(walkerMaterial());
  const people = instanced(walkerGeo, walkerMat, walkers.map(() => new THREE.Matrix4()));
  people.frustumCulled = false;
  group.add(people);

  // ── lights on the tall roofs, and what flies ──
  const MAX_BEACONS = 1200;
  const flying = 3; // the helicopter's two, and an aeroplane high up
  const beaconAt = new Float32Array((MAX_BEACONS + flying) * 3);
  const beaconLook = new Float32Array((MAX_BEACONS + flying) * 4);
  beaconLook.set([1, 0.15, 0.1, 0.0, 0.6, 1, 0.7, -1, 1, 1, 1, 0.4], MAX_BEACONS * 4);
  const beaconGeo = kept.add(new THREE.BufferGeometry());
  const beaconPos = new THREE.BufferAttribute(beaconAt, 3);
  beaconPos.setUsage(THREE.DynamicDrawUsage);
  beaconGeo.setAttribute('position', beaconPos);
  const beaconLookAttr = new THREE.BufferAttribute(beaconLook, 4);
  beaconGeo.setAttribute('aBeacon', beaconLookAttr);
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

  const origin = new THREE.Vector2();
  return {
    group,
    update(time, camera) {
      // Everything is laid round where the camera is: the blocks round it, the street picture under it, the traffic
      // and the people repeating round it.
      origin.set(camera.position.x, camera.position.z);
      const bi = blockIndex(origin.x);
      const bj = blockIndex(origin.y);
      if (`${bi},${bj}` !== shownAt) {
        shownAt = `${bi},${bj}`;
        showAround(bi, bj);
        ground.position.set(bi * PITCH, -DROP, bj * PITCH);
        signals.position.set(bi * PITCH, 0, bj * PITCH);
      }
      if (cityLive.taken !== hidden) {
        hide(hidden, false);
        hide(cityLive.taken, true);
        hidden = cityLive.taken;
      }
      material.uniforms.uTime!.value = time;
      roundMaterial.uniforms.uTime!.value = time;
      if (time - pickedAt > 0.3 || time < pickedAt || cityLive.taken !== pickedTaken) {
        pickedAt = time;
        pickedTaken = cityLive.taken;
        pickNear(time, { x: origin.x, z: origin.y });
      }
      for (const m of [carMat, nearMat, poolMat]) {
        m.uniforms.uTime!.value = time;
        (m.uniforms.uOrigin!.value as THREE.Vector2).copy(origin);
      }
      walkerMat.uniforms.uTime!.value = time;
      walkerMat.uniforms.uHide!.value = cityLive.walkersNear;
      (walkerMat.uniforms.uOrigin!.value as THREE.Vector2).copy(origin);
      signalMat.uniforms.uTime!.value = time;
      beaconMat.uniforms.uTime!.value = time;
      // The helicopter: a wide slow round a little under the floor, rising and sinking.
      const a = time * 0.05;
      const r = 250;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r * 0.8;
      const y = -26 + Math.sin(a * 2.3) * 14;
      heli.position.set(x, y, z);
      heli.rotation.set(0.1, -a, -0.14, 'YXZ');
      const n = MAX_BEACONS;
      beaconAt.set([x, y - 1.3, z, x - Math.sin(-a) * 6.5, y + 1.2, z - Math.cos(-a) * 6.5], n * 3);
      // The aeroplane: far off and high, across the sky in a few minutes.
      const p = ((time * 0.004) % 1) * 2 - 1;
      beaconAt.set([p * 1300, 330, -900 + p * 240], (n + 2) * 3);
      beaconPos.needsUpdate = true;
    },
    dispose() {
      if (hidden >= 0) cityLive.taken = -1;
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
  // Its top 1 cm under the office's floor: one walks out of the door onto it without a step.
  deck.position.set(cx, -0.162, cz);
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
    led.position.set(x + (lx ? 0 : x < cx ? 0.12 : -0.12), 0.0, z + (lz ? 0 : z < cz ? 0.12 : -0.12));
    group.add(pane, rail, led);
  }
  return { group, dispose: () => kept.dispose() };
}

export const SKYLINE_DROP = DROP;
