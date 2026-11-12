import * as THREE from 'three';

/**
 * What the places an office can stand in are built from: a random source that gives the same place to everybody,
 * noise for shaders, a sky, and a few ways of putting many copies of one thing into a scene at the cost of one.
 * See `docs/SURROUNDINGS.md`.
 */

/** The same numbers for the same seed, on every computer: everybody in an office sees the same trees. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value noise in the plane, the same for the same point: for shaping ground and shores on the processor. */
export function noise2(x: number, y: number, seed = 0): number {
  const h = (ix: number, iy: number) => {
    let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  return (h(ix, iy) * (1 - u) + h(ix + 1, iy) * u) * (1 - v) + (h(ix, iy + 1) * (1 - u) + h(ix + 1, iy + 1) * u) * v;
}

/** A few layers of `noise2`, between 0 and 1. */
export function fbm2(x: number, y: number, octaves = 4, seed = 0): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x, y, seed + i * 17) * amp;
    norm += amp;
    amp *= 0.5;
    x *= 2.03;
    y *= 2.03;
  }
  return sum / norm;
}

/** The same noise for shaders. */
export const GLSL_NOISE = /* glsl */ `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash31(vec3 p3) { p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s / 0.96875;
}
float fbm3(vec2 p) {
  float s = 0.0; float a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s / 0.875;
}
`;

/** Fog in a shader of our own, the way the built-in materials have it (the scene's fog, so the two agree). */
export const FOG = {
  uniforms: () => THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
  parsVertex: /* glsl */ `#include <fog_pars_vertex>`,
  /** After `vec4 mvPosition = …`. */
  vertex: /* glsl */ `#include <fog_vertex>`,
  parsFragment: /* glsl */ `#include <fog_pars_fragment>`,
  /** After `gl_FragColor` has its colour. */
  fragment: /* glsl */ `#include <fog_fragment>`,
};

/** The end of every fragment shader of ours: the renderer's tone curve and colour space, as for the built-in materials. */
export const OUTPUT = /* glsl */ `
#include <tonemapping_fragment>
#include <colorspace_fragment>
`;

export interface SkyLook {
  /** Straight up, part of the way up, at the horizon, and under it. */
  zenith: string;
  mid: string;
  horizon: string;
  ground: string;
  /** How far up (0–1) the middle colour sits. */
  midAt?: number;
  /** Where the sun (or the moon) stands; it need not be over the horizon. */
  sun: [number, number, number];
  sunColor: string;
  /** Radius of the disc in radians; 0 for none. */
  sunSize?: number;
  /** The light around the disc, and along the horizon under it. */
  halo?: number;
  glow?: string;
  glowAmount?: number;
  /** 0: none. 1: a clear night far from any town. */
  stars?: number;
  /** 0: none. 1: overcast. */
  clouds?: number;
  cloudLit?: string;
  cloudShade?: string;
  /** How fast the clouds drift. */
  wind?: number;
  /** Northern lights, 0–1. */
  aurora?: number;
  /** A band of faint light across the sky (the galaxy seen from outside the air), 0–1. */
  galaxy?: number;
}

/**
 * The sky: a shell around the camera, drawn behind everything. Colours by height, a sun, and — where a place asks
 * for them — stars, clouds that drift, northern lights. Nothing here is a picture; all of it is worked out per pixel.
 */
export function skyMaterial(look: SkyLook): THREE.ShaderMaterial {
  const c = (hex: string) => new THREE.Color(hex);
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: {
      uZenith: { value: c(look.zenith) },
      uMid: { value: c(look.mid) },
      uHorizon: { value: c(look.horizon) },
      uGround: { value: c(look.ground) },
      uMidAt: { value: look.midAt ?? 0.3 },
      uSunDir: { value: new THREE.Vector3(...look.sun).normalize() },
      uSunColor: { value: c(look.sunColor) },
      uSunSize: { value: look.sunSize ?? 0 },
      uHalo: { value: look.halo ?? 0 },
      uGlow: { value: c(look.glow ?? look.horizon) },
      uGlowAmount: { value: look.glowAmount ?? 0 },
      uStars: { value: look.stars ?? 0 },
      uClouds: { value: look.clouds ?? 0 },
      uCloudLit: { value: c(look.cloudLit ?? '#ffffff') },
      uCloudShade: { value: c(look.cloudShade ?? '#9aa7b8') },
      uWind: { value: look.wind ?? 1 },
      uAurora: { value: look.aurora ?? 0 },
      uGalaxy: { value: look.galaxy ?? 0 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        // Turned with the camera and never moved with it: the sky is as far away from wherever one stands.
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        // As far away as anything can be: whatever else is drawn is in front of it.
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vDir;
      uniform vec3 uZenith, uMid, uHorizon, uGround, uSunDir, uSunColor, uGlow, uCloudLit, uCloudShade;
      uniform float uMidAt, uSunSize, uHalo, uGlowAmount, uStars, uClouds, uWind, uAurora, uGalaxy, uTime;
      ${GLSL_NOISE}
      void main() {
        vec3 dir = normalize(vDir);
        float y = dir.y;
        vec3 col = y >= 0.0
          ? mix(mix(uHorizon, uMid, smoothstep(0.0, uMidAt, y)), uZenith, smoothstep(uMidAt, 1.0, y))
          : mix(uHorizon, uGround, smoothstep(0.0, -0.22, y));

        // The light along the horizon on the sun's side.
        vec2 az = normalize(dir.xz + 1e-5);
        vec2 sunAz = normalize(uSunDir.xz + 1e-5);
        float toward = max(dot(az, sunAz), 0.0);
        col += uGlow * uGlowAmount * pow(toward, 2.5) * exp(-abs(y) * 5.5);

        float away = 1.0;
        if (uStars > 0.0 || uGalaxy > 0.0) {
          // A band of faint light, tilted across the sky.
          if (uGalaxy > 0.0) {
            vec3 n = normalize(vec3(0.35, 0.5, -0.8));
            float band = exp(-pow(dot(dir, n) * 4.2, 2.0));
            float dust = fbm(dir.xy * 6.0 + dir.zx * 4.0);
            col += vec3(0.42, 0.46, 0.62) * band * pow(dust, 2.2) * 0.3 * uGalaxy;
          }
          // Stars: points on a grid over the shell, each at least a pixel wide so that turning the head does not make them sparkle.
          for (int layer = 0; layer < 2; layer++) {
            float scale = layer == 0 ? 85.0 : 150.0;
            vec3 p = dir * scale;
            vec3 cell = floor(p);
            float h = hash31(cell + float(layer) * 19.0);
            float chance = (layer == 0 ? 0.022 : 0.05) * uStars;
            if (h < chance) {
              vec3 off = vec3(hash31(cell + 3.1), hash31(cell + 7.7), hash31(cell + 13.3)) - 0.5;
              float d = length(fract(p) - 0.5 - off * 0.6);
              float w = max(layer == 0 ? 0.075 : 0.06, length(fwidth(p)) * 0.9);
              float b = smoothstep(w, 0.0, d) * (0.35 + 0.65 * hash31(cell + 5.5));
              b *= 0.85 + 0.15 * sin(uTime * (0.6 + 2.0 * h / chance) + h * 600.0);
              vec3 tint = mix(vec3(0.75, 0.84, 1.0), vec3(1.0, 0.9, 0.78), hash31(cell + 9.9));
              col += tint * b * (layer == 0 ? 1.3 : 0.7) * smoothstep(-0.02, 0.22, y + uGalaxy);
            }
          }
        }

        // Northern lights: curtains hung along slow curves — a sharp lower edge, fading upward, with rays running through.
        if (uAurora > 0.0 && y > 0.0) {
          vec2 uv = dir.xz / (y + 0.3);
          float t = uTime * 0.03;
          vec3 lights = vec3(0.0);
          for (int i = 0; i < 4; i++) {
            float fi = float(i);
            float along = uv.x * (0.5 + 0.11 * fi) + fi * 2.7;
            float line = -1.3 + 0.95 * fi + 0.5 * sin(along + t * (1.0 + 0.3 * fi)) + 0.7 * (fbm3(vec2(along * 0.7 + t, fi * 4.0)) - 0.5);
            // Under 0: higher in the sky than the curtain's foot.
            float dist = uv.y - line;
            float rise = max(-dist, 0.0);
            float curtain = smoothstep(0.07, 0.0, dist) * exp(-rise * (1.5 + 0.5 * fi));
            float rays = 0.3 + 0.7 * pow(vnoise(vec2(along * 9.0 + fi * 31.0 + t * 1.6, fi * 7.0 + t)), 1.5);
            rays *= 0.8 + 0.2 * vnoise(vec2(along * 38.0, t * 5.0 + fi));
            vec3 hue = mix(vec3(0.16, 1.0, 0.5), vec3(0.62, 0.28, 0.95), smoothstep(0.15, 1.3, rise));
            lights += hue * curtain * rays * (1.0 - 0.14 * fi);
          }
          col += lights * uAurora * 1.05 * smoothstep(0.03, 0.2, y);
        }

        // Clouds on a plane overhead, thinning towards the horizon.
        if (uClouds > 0.0 && y > 0.015) {
          vec2 uv = dir.xz / (y + 0.16) * 0.55 + vec2(uTime * 0.004, uTime * 0.0015) * uWind;
          float d = fbm(uv);
          float cover = smoothstep(1.0 - uClouds * 0.72, 1.06 - uClouds * 0.5, d + 0.18 * fbm3(uv * 3.1));
          float lit = smoothstep(-0.25, 0.35, d - fbm(uv + sunAz * 0.22));
          vec3 cloud = mix(uCloudShade, uCloudLit, lit);
          // Thin edges take the colour of the light behind them.
          cloud += uSunColor * 0.35 * pow(max(dot(dir, uSunDir), 0.0), 6.0) * (1.0 - cover);
          away = 1.0 - cover * 0.92;
          col = mix(col, cloud, cover * smoothstep(0.015, 0.2, y));
        }

        // The disc and the light around it.
        float s = dot(dir, uSunDir);
        if (uSunSize > 0.0) {
          float edge = cos(uSunSize);
          col = mix(col, uSunColor * 1.6, smoothstep(edge - 0.0006, edge + 0.0004, s) * away);
        }
        col += uSunColor * uHalo * (0.55 * pow(max(s, 0.0), 180.0) + 0.3 * pow(max(s, 0.0), 22.0) + 0.1 * pow(max(s, 0.0), 5.0)) * (0.4 + 0.6 * away);

        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }
    `,
  });
}

const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpEuler = new THREE.Euler();

/** Where one copy stands: a place, a turn around the vertical (or all three), and a size. */
export function at(x: number, y: number, z: number, rotY = 0, sx = 1, sy = sx, sz = sx, rotX = 0, rotZ = 0): THREE.Matrix4 {
  tmpEuler.set(rotX, rotY, rotZ, 'YXZ');
  return new THREE.Matrix4().compose(tmpPos.set(x, y, z), tmpQuat.setFromEuler(tmpEuler), tmpScale.set(sx, sy, sz));
}

/** Many copies of one shape as a single thing to draw. `colors` gives each its own tint. */
export function instanced(geometry: THREE.BufferGeometry, material: THREE.Material, matrices: THREE.Matrix4[], colors?: THREE.Color[]): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, matrices.length));
  mesh.count = matrices.length;
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  if (colors) colors.forEach((c, i) => mesh.setColorAt(i, c));
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.computeBoundingBox();
  mesh.matrixAutoUpdate = false;
  return mesh;
}

/** Several shapes as one, each coloured: what a tree or a boat is made of. Colours are per corner, so one material does. */
export function merged(parts: Array<{ geometry: THREE.BufferGeometry; color: string | THREE.Color; matrix?: THREE.Matrix4 }>): THREE.BufferGeometry {
  let count = 0;
  const prepared = parts.map(({ geometry, color, matrix }) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    if (matrix) g.applyMatrix4(matrix);
    count += g.getAttribute('position').count;
    return { g, color: color instanceof THREE.Color ? color : new THREE.Color(color) };
  });
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  let o = 0;
  for (const { g, color: c } of prepared) {
    const p = g.getAttribute('position');
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    const n = g.getAttribute('normal');
    position.set(p.array as Float32Array, o * 3);
    normal.set(n.array as Float32Array, o * 3);
    for (let i = 0; i < p.count; i++) {
      color[(o + i) * 3] = c.r;
      color[(o + i) * 3 + 1] = c.g;
      color[(o + i) * 3 + 2] = c.b;
    }
    o += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('color', new THREE.BufferAttribute(color, 3));
  out.computeBoundingSphere();
  return out;
}

/** A picture painted once with the 2D canvas, as a texture that repeats. */
export function painted(size: number, draw: (ctx: CanvasRenderingContext2D, size: number) => void, repeat?: [number, number]): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d')!, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  if (repeat) tex.repeat.set(...repeat);
  return tex;
}

/** Everything a place made — shapes, materials, pictures — let go of in one call when the place is left. */
export class Kept {
  private readonly things: Array<{ dispose(): void }> = [];
  add<T extends { dispose(): void }>(thing: T): T {
    this.things.push(thing);
    return thing;
  }
  dispose(): void {
    for (const t of this.things) t.dispose();
    this.things.length = 0;
  }
}

export interface WaterLook {
  deep: string;
  shallow: string;
  /** What the water shows of the sky when looked along. */
  sky: string;
  sun: [number, number, number];
  sunColor: string;
  /** How much the sun glitters on it. */
  glitter?: number;
  /** Metres from one wave to the next, and how fast they travel. */
  wave?: number;
  speed?: number;
  /** How rough: 0 a pond, 1 open sea. */
  rough?: number;
  /**
   * The shore of an island around the origin: its distance from the middle for each direction (see `shoreTexture`).
   * The water is clear and pale over the shallows there, and breaks into foam at the edge.
   */
  shore?: THREE.Texture;
  opacity?: number;
  /** 0–1: lights moving in the sky above (northern lights) show in the water as slow bands of `sky` and a second colour. */
  lights?: number;
  lightsColor?: string;
}

/** Water that lies flat and moves: ripples from the time alone, the sky in it, the sun glittering. */
export function waterMaterial(look: WaterLook): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    fog: true,
    transparent: (look.opacity ?? 1) < 1 || !!look.shore,
    uniforms: {
      ...FOG.uniforms(),
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color(look.deep) },
      uShallow: { value: new THREE.Color(look.shallow) },
      uSky: { value: new THREE.Color(look.sky) },
      uSunDir: { value: new THREE.Vector3(...look.sun).normalize() },
      uSunColor: { value: new THREE.Color(look.sunColor) },
      uGlitter: { value: look.glitter ?? 1 },
      uWave: { value: look.wave ?? 6 },
      uSpeed: { value: look.speed ?? 1 },
      uRough: { value: look.rough ?? 0.3 },
      uShore: { value: look.shore ?? null },
      uHasShore: { value: look.shore ? 1 : 0 },
      uOpacity: { value: look.opacity ?? 1 },
      uLights: { value: look.lights ?? 0 },
      uLightsColor: { value: new THREE.Color(look.lightsColor ?? look.sky) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      ${FOG.parsVertex}
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        ${FOG.vertex}
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      varying vec3 vWorld;
      uniform vec3 uDeep, uShallow, uSky, uSunDir, uSunColor;
      uniform float uTime, uGlitter, uWave, uSpeed, uRough, uHasShore, uOpacity, uLights;
      uniform vec3 uLightsColor;
      uniform sampler2D uShore;
      ${GLSL_NOISE}
      ${FOG.parsFragment}
      // The slope of the surface at a point: a few trains of waves crossing each other.
      // A train of waves finer than a pixel is left out (grain: how much water one pixel covers): drawn, it would crawl.
      vec2 slope(vec2 p, float t, float grain) {
        vec2 s = vec2(0.0);
        float a = 1.0;
        float k = 6.2832 / uWave;
        vec2 d = normalize(vec2(1.0, 0.35));
        for (int i = 0; i < 5; i++) {
          // Each train is bent a little by the water it crosses: no two crests run parallel for long.
          float ph = dot(p, d) * k + t * sqrt(k) * 1.6 + float(i) * 1.7 + 3.2 * vnoise(p * 0.7 / uWave + float(i) * 5.3);
          // Waves come in groups: stronger here, nearly flat there.
          float group = 0.35 + 1.3 * vnoise(p * 0.22 / uWave + float(i) * 11.0 + t * 0.02);
          s += d * cos(ph) * a * k * 0.16 * uWave * group * (1.0 - smoothstep(0.3, 1.3, k * grain));
          d = normalize(vec2(d.x * 0.61 - d.y * 0.79, d.x * 0.79 + d.y * 0.61));
          k *= 1.73;
          a *= 0.62;
        }
        return s * uRough;
      }
      void main() {
        vec3 toEye = cameraPosition - vWorld;
        float dist = length(toEye);
        vec3 v = toEye / dist;
        float t = uTime * uSpeed;
        float grain = max(length(dFdx(vWorld.xz)), length(dFdy(vWorld.xz)));
        float calm = smoothstep(0.3, 1.3, 6.2832 / uWave * grain);
        vec2 s = slope(vWorld.xz, t, grain);
        s += (vec2(vnoise(vWorld.xz * 1.7 + t * 0.4), vnoise(vWorld.xz * 1.7 - t * 0.33 + 9.0)) - 0.5) * 0.22 * uRough * (1.0 - smoothstep(0.3, 1.3, 10.7 * grain));
        vec3 n = normalize(vec3(-s.x, 1.0, -s.y));
        float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
        float depth = 1.0;
        float foam = 0.0;
        float alpha = uOpacity;
        if (uHasShore > 0.5) {
          float ang = atan(vWorld.z, vWorld.x) / 6.2832 + 0.5;
          float edge = texture2D(uShore, vec2(ang, 0.5)).r * 400.0;
          float out_ = length(vWorld.xz) - edge;
          depth = smoothstep(0.0, 34.0, out_);
          // Lines of foam that come in to the beach and thin out.
          float wash = sin(out_ * 0.75 - t * 1.25 + 4.0 * vnoise(vWorld.xz * 0.12)) * 0.5 + 0.5;
          foam = smoothstep(0.62, 1.0, wash) * smoothstep(9.0, 0.5, out_) * (0.45 + 0.55 * vnoise(vWorld.xz * 1.3 + t * 0.2));
          foam += smoothstep(2.0, 0.7, out_) * 0.7;
          // The water thins to nothing just before it meets the sand: its edge is this fade, not the line where two
          // surfaces cut each other — that line moves by a pixel with every step of the camera.
          alpha = mix(0.55, 1.0, smoothstep(0.0, 6.0, out_)) * smoothstep(0.05, 0.7, out_);
        }
        vec3 body = mix(uShallow, uDeep, depth);
        vec3 above = uSky;
        if (uLights > 0.0) {
          // What is overhead is seen stretched towards the viewer, and it moves.
          vec2 q = vWorld.xz * vec2(0.02, 0.05) + n.xz * 1.5;
          float band = smoothstep(0.36, 0.7, fbm3(q + vec2(uTime * 0.012, 0.0)));
          float second = smoothstep(0.5, 0.8, fbm3(q * 1.7 + vec2(4.0, uTime * 0.01)));
          above = mix(uDeep * 1.6, mix(uSky, uLightsColor, second), band * uLights);
        }
        vec3 col = mix(body, above, clamp(0.12 + fres * 0.88, 0.0, 1.0) * mix(0.55, 1.0, depth));
        // The sun: a path of light broken up by the waves.
        vec3 h = normalize(uSunDir + v);
        float spec = pow(max(dot(n, h), 0.0), mix(900.0, 160.0, uRough));
        col += uSunColor * spec * 2.4 * uGlitter;
        col += uSunColor * pow(max(dot(reflect(-v, n), uSunDir), 0.0), 14.0) * 0.16 * uGlitter;
        // Where the waves are too far to be seen one by one, what is left of their sparkle is a path of light towards the sun.
        col += uSunColor * pow(max(dot(reflect(-v, vec3(0.0, 1.0, 0.0)), uSunDir), 0.0), mix(60.0, 18.0, uRough)) * 0.55 * uGlitter * calm;
        col = mix(col, vec3(1.0), clamp(foam, 0.0, 1.0));
        gl_FragColor = vec4(col, alpha);
        ${OUTPUT}
        ${FOG.fragment}
      }
    `,
  });
}

/** An island's shore for `waterMaterial`: how far from the middle the water starts, for 256 directions round. */
export function shoreTexture(radius: (angle: number) => number): THREE.DataTexture {
  const n = 256;
  const data = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    // The same angle the shader works out: atan(z, x) / 2π + ½.
    const angle = (i / n - 0.5) * Math.PI * 2;
    data[i * 4] = Math.max(0, Math.min(255, Math.round((radius(angle) / 400) * 255)));
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Leaves and branches that move in the wind: put on a built-in material, it bends what stands tall, more the higher up. */
export function swaying(material: THREE.Material, time: { value: number }, amount = 1): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uSwayTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uSwayTime;')
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 swayAt = instanceMatrix[3].xyz;
        #else
          vec3 swayAt = vec3(0.0);
        #endif
        float swayUp = max(transformed.y - 1.2, 0.0);
        float swayPhase = swayAt.x * 0.21 + swayAt.z * 0.17;
        transformed.x += sin(uSwayTime * 1.1 + swayPhase + transformed.y * 0.5) * swayUp * 0.022 * ${amount.toFixed(2)};
        transformed.z += cos(uSwayTime * 0.9 + swayPhase * 1.3 + transformed.x * 0.6) * swayUp * 0.016 * ${amount.toFixed(2)};`,
      );
  };
}

/** A shape turned round an axis from an outline — a balloon, a basin, a lamp post. */
export function turned(outline: Array<[number, number]>, segments = 16): THREE.LatheGeometry {
  return new THREE.LatheGeometry(outline.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}

/** Birds: a body and two wings that beat, each on a round of its own. */
function birdMaterial(tone: [number, number, number]): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    fog: false,
    uniforms: { uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute vec4 aRound; // middle x, middle z, radius, height
      attribute vec3 aBeat; // where on the round, how fast round, how fast the wings
      uniform float uTime;
      void main() {
        float a = aBeat.x + uTime * aBeat.y;
        vec3 p = position;
        // A wing tip rises and falls; the body rides the other way a little.
        float flap = sin(uTime * aBeat.z + aBeat.x * 9.0);
        p.y += pow(abs(p.x), 1.4) * flap * 0.6 - flap * 0.05;
        float c = cos(-a); float s = sin(-a);
        vec3 w = vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
        w += vec3(aRound.x + cos(a) * aRound.z, aRound.w + sin(a * 2.0 + aBeat.x) * 3.0, aRound.y + sin(a) * aRound.z);
        gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      void main() {
        gl_FragColor = vec4(${tone.map((v) => v.toFixed(3)).join(', ')}, 1.0);
        ${OUTPUT}
      }
    `,
  });
}


/**
 * Birds in the air: `count` of them, shared out over a few rounds (middle x, middle z, radius, height), each beating
 * its wings at its own pace. One thing to draw; the graphics card flies them.
 */
export function flock(kept: Kept, count: number, random: () => number, rounds: Array<[number, number, number, number]>, tone: [number, number, number] = [0.13, 0.14, 0.17], size = 1): { mesh: THREE.InstancedMesh; material: THREE.ShaderMaterial } {
  const geometry = kept.add(new THREE.BufferGeometry());
  // A body and, each side, a wing in two parts that narrows to its tip.
  const wing = (s: number) => [0, 0, 0.2, 0, 0, -0.16, s * 0.55, 0, -0.12, 0, 0, 0.2, s * 0.55, 0, -0.12, s * 0.55, 0, 0.1, s * 0.55, 0, 0.1, s * 0.55, 0, -0.12, s * 1.15, 0, -0.2];
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([...wing(-1), ...wing(1), -0.06, 0, 0.42, 0.06, 0, 0.42, 0, 0, -0.42].map((v) => v * size), 3));
  const where = new Float32Array(count * 4);
  const beats = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const n = i % rounds.length;
    const [x, z, r, h] = rounds[n]!;
    where.set([x + random() * 14, z + random() * 14, r + random() * 10, h + random() * 6], i * 4);
    beats.set([random() * 0.6 + n * 2.1, (0.16 + random() * 0.03) * (n % 2 ? -1 : 1), 7 + random() * 2.5], i * 3);
  }
  geometry.setAttribute('aRound', new THREE.InstancedBufferAttribute(where, 4));
  geometry.setAttribute('aBeat', new THREE.InstancedBufferAttribute(beats, 3));
  const material = kept.add(birdMaterial(tone));
  const mesh = instanced(geometry, material, Array.from({ length: count }, () => new THREE.Matrix4()));
  mesh.frustumCulled = false;
  return { mesh, material };
}

/**
 * Fine grain over a painted picture. Soft washes of colour laid over each other come out of a canvas in visible
 * steps (it keeps 256 levels a channel); seen close, on the ground, those steps read as a pattern. A little noise
 * hides them — and grass and snow are not smooth anyway.
 */
export function grain(ctx: CanvasRenderingContext2D, size: number, amount: number, random: () => number): void {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (random() - 0.5) * 2 * amount;
    d[i] = d[i]! + n;
    d[i + 1] = d[i + 1]! + n;
    d[i + 2] = d[i + 2]! + n;
  }
  ctx.putImageData(img, 0, 0);
}
