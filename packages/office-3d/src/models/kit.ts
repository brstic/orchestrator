import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * The furniture kit: what every model in the office is built from.
 *
 * Nothing is loaded from a file. A model is sculpted in code out of a handful of shapes (soft boxes,
 * lathed profiles, extruded slabs, tubes), every shape gets the material it is made of, and all shapes of one
 * material are fused into a single geometry — so a chair with thirty parts is drawn in four calls, and forty
 * chairs in the same four (see `InstancedModel`).
 *
 * Sizes are metres, +Y is up, a model stands on the floor at its origin.
 */

export interface Part {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** Small or flat things (a keyboard, a rug) are left out of the shadow pass. */
  cast: boolean;
}

export interface Model {
  parts: Part[];
  triangles: number;
}

// ───────────────────────────── shapes ─────────────────────────────

/** Normals from the faces, shared where faces meet: a bevelled edge then catches the light as a rounded one. */
export function smooth(g: THREE.BufferGeometry, tolerance = 1e-4): THREE.BufferGeometry {
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const merged = mergeVertices(g, tolerance);
  merged.computeVertexNormals();
  return merged;
}

export interface SoftBoxOptions {
  /** Segments across each rounded edge. */
  round?: number;
  /** Segments across the flat of each side (more are needed when the box is bent afterwards). */
  flat?: number | [number, number, number];
  /** The top rises by this much in the middle, like a filled cushion. */
  puff?: number;
  /** The same for the bottom, front (+Z) and back (−Z). */
  puffBottom?: number;
  puffFront?: number;
  puffBack?: number;
}

/**
 * A box whose edges are rounded with radius `r`, with enough vertices on its sides to be shaped afterwards:
 * the starting point of cushions, seats, panels and anything upholstered.
 */
export function softBox(w: number, h: number, d: number, r: number, o: SoftBoxOptions = {}): THREE.BufferGeometry {
  r = Math.min(r, w / 2, h / 2, d / 2);
  const k = o.round ?? 2;
  const flat = typeof o.flat === 'number' ? [o.flat, o.flat, o.flat] : (o.flat ?? [1, 1, 1]);
  const axis = (half: number, m: number) => {
    const inner: number[] = [];
    const off: number[] = [];
    // Spaced by angle, so the rounding is even: the corner is a quarter turn shared by the two sides that meet in it.
    for (let i = 0; i <= k; i++) {
      inner.push(-(half - r));
      off.push(-Math.tan(((1 - i / k) * Math.PI) / 4));
    }
    for (let j = 1; j < m; j++) {
      inner.push(-(half - r) + ((2 * (half - r)) * j) / m);
      off.push(0);
    }
    for (let i = 0; i <= k; i++) {
      inner.push(half - r);
      off.push(Math.tan(((i / k) * Math.PI) / 4));
    }
    return { inner, off, n: 2 * k + m };
  };
  const ax = axis(w / 2, flat[0]!);
  const ay = axis(h / 2, flat[1]!);
  const az = axis(d / 2, flat[2]!);
  const g = new THREE.BoxGeometry(1, 1, 1, ax.n, ay.n, az.n);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const ix = Math.round((pos.getX(i) + 0.5) * ax.n);
    const iy = Math.round((pos.getY(i) + 0.5) * ay.n);
    const iz = Math.round((pos.getZ(i) + 0.5) * az.n);
    v.set(ax.off[ix]!, ay.off[iy]!, az.off[iz]!);
    if (v.lengthSq() > 0) v.normalize();
    let x = ax.inner[ix]! + v.x * r;
    let y = ay.inner[iy]! + v.y * r;
    let z = az.inner[iz]! + v.z * r;
    // A cushion: each face swells toward its middle.
    const fx = 1 - Math.pow(Math.abs(x) / (w / 2), 2.4);
    const fy = 1 - Math.pow(Math.abs(y) / (h / 2), 2.4);
    const fz = 1 - Math.pow(Math.abs(z) / (d / 2), 2.4);
    if (o.puff && v.y > 0) y += o.puff * fx * fz * v.y;
    if (o.puffBottom && v.y < 0) y += o.puffBottom * fx * fz * v.y;
    if (o.puffFront && v.z > 0) z += o.puffFront * fx * fy * v.z;
    if (o.puffBack && v.z < 0) z += o.puffBack * fx * fy * v.z;
    pos.setXYZ(i, x, y, z);
  }
  return smooth(g);
}

/** Moves every vertex with a function of where it is (bending a back rest, tapering a leg). Normals are made again. */
export function warp(g: THREE.BufferGeometry, f: (p: THREE.Vector3) => void): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    f(v);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  pos.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** A solid of revolution from a profile of [radius, height] points, bottom to top. */
export function lathe(profile: Array<[number, number]>, segments = 24): THREE.BufferGeometry {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.00001), y)), segments);
}

export function cyl(rTop: number, rBottom: number, h: number, segments = 16, open = false): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBottom, h, segments, 1, open);
}

/** A round bar through the given points (a chair's spine, a lamp's arc, a handle). */
export function tube(points: Array<[number, number, number]>, radius: number, radial = 8, along = 0, closed = false): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), closed, 'centripetal');
  const g = new THREE.TubeGeometry(curve, along || Math.max(4, (points.length - 1) * 5), radius, radial, closed);
  if (closed) return g;
  // Ends are closed with a disc each, so a bar seen end-on is not hollow.
  const caps: THREE.BufferGeometry[] = [g];
  for (const end of [0, 1]) {
    const at = curve.getPoint(end);
    const dir = curve.getTangent(end).multiplyScalar(end ? 1 : -1);
    const cap = new THREE.CircleGeometry(radius, radial);
    cap.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir));
    cap.translate(at.x, at.y, at.z);
    caps.push(cap);
  }
  return fuse(caps);
}

function roundedRect(w: number, d: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -d / 2;
  r = Math.max(0.0005, Math.min(r, w / 2, d / 2));
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + d - r);
  s.absarc(x + w - r, y + d - r, r, 0, Math.PI / 2, false);
  s.lineTo(x + r, y + d);
  s.absarc(x + r, y + d - r, r, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + r);
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false);
  return s;
}

/**
 * A flat board lying on XZ, centred on the origin: `w` × `d`, `h` thick, its corners rounded (in plan) by
 * `corner` and its edges eased by `bevel`. Table tops, shelves, doors, plinths.
 */
export function slab(w: number, h: number, d: number, corner = 0.01, bevel = 0.004, curve = 4): THREE.BufferGeometry {
  bevel = Math.min(bevel, h / 2 - 0.0005, corner);
  return shapeSlab(roundedRect(w - bevel * 2, d - bevel * 2, Math.max(0.0005, corner - bevel)), h, bevel, curve);
}

/** Any outline (drawn on X/Y, where Y becomes −Z) made into a board `h` thick with eased edges. */
export function shapeSlab(shape: THREE.Shape, h: number, bevel = 0.004, curve = 4): THREE.BufferGeometry {
  bevel = Math.min(bevel, h / 2 - 0.0005);
  const g = new THREE.ExtrudeGeometry(shape, { depth: h - bevel * 2, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: curve, steps: 1 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, -(h - bevel * 2) / 2, 0);
  return smooth(g);
}

export function sphere(r: number, w = 16, h = 12): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, w, h);
}

export function torus(r: number, tube: number, radial = 8, around = 24, arc = Math.PI * 2): THREE.BufferGeometry {
  return new THREE.TorusGeometry(r, tube, radial, around, arc);
}

/** Scales, turns and moves a shape, in that order; it is rolled (Z) and pitched (X) before it is turned about the vertical (Y). */
export function at(g: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')), new THREE.Vector3(sx, sy, sz));
  return g.clone().applyMatrix4(m);
}

function plain(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g.clone();
  for (const name of Object.keys(out.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') out.deleteAttribute(name);
  if (!out.attributes.normal) out.computeVertexNormals();
  out.morphAttributes = {};
  return out;
}

/** Several shapes as one. */
export function fuse(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = list.map(plain);
  const uv = parts.every((p) => !!p.attributes.uv);
  const color = parts.every((p) => !!p.attributes.color);
  for (const p of parts) {
    if (!uv) p.deleteAttribute('uv');
    if (!color) p.deleteAttribute('color');
  }
  return mergeGeometries(parts, false)!;
}

/**
 * Texture coordinates laid on from the three sides, a metre of surface to one repeat: whatever the shape, wood
 * grain and cloth weave come out at the same scale and are not stretched. `turn` runs the grain the other way.
 */
export function boxUV(g: THREE.BufferGeometry, turn = false): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = g.attributes.normal as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let t = 0; t < pos.count; t += 3) {
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = t; i < t + 3; i++) {
      nx += nor.getX(i);
      ny += nor.getY(i);
      nz += nor.getZ(i);
    }
    const axis = Math.abs(ny) >= Math.abs(nx) && Math.abs(ny) >= Math.abs(nz) ? 1 : Math.abs(nx) >= Math.abs(nz) ? 0 : 2;
    for (let i = t; i < t + 3; i++) {
      const u = axis === 0 ? pos.getZ(i) : pos.getX(i);
      const v = axis === 1 ? pos.getZ(i) : pos.getY(i);
      uv[i * 2] = turn ? v : u;
      uv[i * 2 + 1] = turn ? u : v;
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Paints a shape with one colour per vertex (leaves of slightly different greens, book spines). The material must use vertex colours. */
export function tint(g: THREE.BufferGeometry, color: THREE.ColorRepresentation): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = (g.attributes.position as THREE.BufferAttribute).count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r;
    a[i * 3 + 1] = c.g;
    a[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

// ───────────────────────────── building a model ─────────────────────────────

/** Collects shapes by what they are made of and fuses each material's shapes into one geometry. */
export class Build {
  // Shapes by what they are made of, and by whether they throw a shadow: the two are drawn as separate parts,
  // so the many small things on a model (keys, handles, cups) stay out of the shadow pass.
  private slots = new Map<string, { material: THREE.Material; cast: boolean; list: THREE.BufferGeometry[] }>();

  private slot(material: THREE.Material, cast: boolean): THREE.BufferGeometry[] {
    const key = `${material.uuid}:${cast ? 1 : 0}`;
    let s = this.slots.get(key);
    if (!s) this.slots.set(key, (s = { material, cast, list: [] }));
    return s.list;
  }

  /** Adds a shape. `o.turn` runs wood grain the other way; `o.cast: false` keeps it out of the shadow pass. */
  add(material: THREE.Material, g: THREE.BufferGeometry, o: { turn?: boolean; cast?: boolean; keepUV?: boolean } = {}): this {
    const p = plain(g);
    const hadColor = !!p.attributes.color;
    // `keepUV`: the shape carries a picture of its own (a face plate), laid out by the shape itself.
    if (!o.keepUV || !p.attributes.uv) boxUV(p, o.turn);
    if (!hadColor) tint(p, '#ffffff');
    this.slot(material, o.cast ?? true).push(p);
    return this;
  }

  /** Adds every part of another model, placed. */
  put(model: Model, x = 0, y = 0, z = 0, ry = 0, s = 1): this {
    for (const part of model.parts) {
      const g = at(part.geometry.index ? part.geometry.toNonIndexed() : part.geometry, x, y, z, 0, ry, 0, s);
      if (!g.attributes.color) tint(g, '#ffffff');
      this.slot(part.material, part.cast).push(g);
    }
    return this;
  }

  done(): Model {
    const parts: Part[] = [];
    let triangles = 0;
    for (const { material, cast, list } of this.slots.values()) {
      const geometry = mergeVertices(mergeGeometries(list, false)!, 1e-5);
      // Vertex colours are kept only by materials that use them.
      if (!(material as THREE.MeshStandardMaterial).vertexColors) geometry.deleteAttribute('color');
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
      triangles += (geometry.index ? geometry.index.count : (geometry.attributes.position as THREE.BufferAttribute).count) / 3;
      parts.push({ geometry, material, cast });
    }
    return { parts, triangles };
  }
}

/** A model built the first time it is asked for, and the same one ever after. */
export function once<T>(make: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= make());
}

// ───────────────────────────── surfaces ─────────────────────────────

function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void, repeat = 1, color = true): THREE.CanvasTexture | null {
  // Outside a browser (the tests that measure the models) there is nothing to paint on: the surface stays plain.
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  draw(canvas.getContext('2d')!, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  if (color) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function rng(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

/** Wood grain running along U, in light greys: the material's colour gives it its tone. Repeats without a seam. */
const woodGrain = once(() =>
  canvasTexture(512, (ctx, s) => {
    const rnd = rng(71);
    ctx.fillStyle = '#e9e9e9';
    ctx.fillRect(0, 0, s, s);
    // Broad bands of slightly different tone (the boards' growth), then fine pores along the grain.
    for (let i = 0; i < 26; i++) {
      const y = rnd() * s;
      const h = 6 + rnd() * 34;
      ctx.fillStyle = `rgba(${rnd() < 0.5 ? '120,110,100' : '255,255,255'},${0.05 + rnd() * 0.1})`;
      for (const dy of [-s, 0, s]) ctx.fillRect(0, y + dy, s, h);
    }
    for (let i = 0; i < 900; i++) {
      const y = rnd() * s;
      const x = rnd() * s;
      const len = 30 + rnd() * 160;
      const wob = (rnd() - 0.5) * 5;
      ctx.strokeStyle = `rgba(70,55,40,${0.05 + rnd() * 0.16})`;
      ctx.lineWidth = 0.6 + rnd() * 1.1;
      for (const dx of [-s, 0, s]) {
        ctx.beginPath();
        ctx.moveTo(x + dx, y);
        ctx.bezierCurveTo(x + dx + len * 0.3, y + wob, x + dx + len * 0.7, y - wob, x + dx + len, y + wob * 0.4);
        ctx.stroke();
      }
    }
  }, 0.9),
);

/** Woven cloth as a height map: threads over and under, with a little unevenness. */
const weave = once(() =>
  canvasTexture(
    128,
    (ctx, s) => {
      const rnd = rng(5);
      const img = ctx.createImageData(s, s);
      const n = 16;
      for (let y = 0; y < s; y++)
        for (let x = 0; x < s; x++) {
          const u = (x / s) * n;
          const v = (y / s) * n;
          const over = (Math.floor(u) + Math.floor(v)) % 2 === 0;
          const a = Math.sin((u % 1) * Math.PI);
          const b = Math.sin((v % 1) * Math.PI);
          const hgt = (over ? a * 0.75 + b * 0.25 : b * 0.75 + a * 0.25) * 200 + 30 + (rnd() - 0.5) * 36;
          const i = (y * s + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(0, Math.min(255, hgt));
          img.data[i + 3] = 255;
        }
      ctx.putImageData(img, 0, 0);
    },
    22,
    false,
  ),
);

/** Fine grain for leather and soft plastics. */
const pebble = once(() =>
  canvasTexture(
    128,
    (ctx, s) => {
      const rnd = rng(11);
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 1400; i++) {
        const x = rnd() * s;
        const y = rnd() * s;
        const r = 1 + rnd() * 2.6;
        const c = Math.round(90 + rnd() * 110);
        ctx.fillStyle = `rgba(${c},${c},${c},0.5)`;
        for (const dx of [-s, 0, s])
          for (const dy of [-s, 0, s]) {
            ctx.beginPath();
            ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
            ctx.fill();
          }
      }
    },
    14,
    false,
  ),
);

/** The height maps themselves, for what is not furniture (people's clothes). */
export const textures = { weave, pebble };

const cache = new Map<string, THREE.MeshStandardMaterial>();
function cached(key: string, make: () => THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
  let m = cache.get(key);
  if (!m) cache.set(key, (m = make()));
  return m;
}

/** What things are made of. One material per look in the whole office, however many models use it. */
export const M = {
  /** Oiled wood with visible grain. */
  wood: (color = '#b98d5e') => cached(`wood:${color}`, () => new THREE.MeshStandardMaterial({ color, map: woodGrain(), roughness: 0.52, metalness: 0 })),
  /** A smooth painted or laminated surface. */
  paint: (color = '#f1f3f6', rough = 0.55) => cached(`paint:${color}:${rough}`, () => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 })),
  /** Moulded plastic: a little grain, a soft highlight. */
  plastic: (color = '#1d2129', rough = 0.5) => cached(`plastic:${color}:${rough}`, () => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05, bumpMap: pebble(), bumpScale: 0.25 })),
  /** Upholstery cloth. */
  fabric: (color = '#2f3846') => cached(`fabric:${color}`, () => new THREE.MeshStandardMaterial({ color, roughness: 0.96, metalness: 0, bumpMap: weave(), bumpScale: 1.1 })),
  leather: (color = '#20242c') => cached(`leather:${color}`, () => new THREE.MeshStandardMaterial({ color, roughness: 0.42, metalness: 0, bumpMap: pebble(), bumpScale: 0.5 })),
  /** Polished or brushed metal; `rough` 0.2 is chrome, 0.45 brushed aluminium. */
  metal: (color = '#c3c9d2', rough = 0.28) => cached(`metal:${color}:${rough}`, () => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.92 })),
  /** Powder-coated steel: metal under paint. */
  steel: (color = '#2a2f38', rough = 0.5) => cached(`steel:${color}:${rough}`, () => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.45 })),
  rubber: (color = '#15171b') => cached(`rubber:${color}`, () => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 })),
  ceramic: (color = '#e9e4da', rough = 0.32) => cached(`ceramic:${color}:${rough}`, () => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 })),
  /** A dark glossy panel: a screen that is off, smoked glass. */
  gloss: (color = '#07090c') => cached(`gloss:${color}`, () => new THREE.MeshStandardMaterial({ color, roughness: 0.12, metalness: 0.4 })),
  /** Takes its colour from each vertex (leaves, book spines, anything of many colours in one draw). */
  varied: (rough = 0.8) => cached(`varied:${rough}`, () => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: rough, metalness: 0, vertexColors: true })),
  /** Leaves: coloured per vertex, lit from both sides. */
  leaf: () => cached('leaf', () => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.62, metalness: 0, vertexColors: true, side: THREE.DoubleSide })),
  glass: (color = '#bfe2ff', opacity = 0.22) => cached(`glass:${color}:${opacity}`, () => new THREE.MeshStandardMaterial({ color, roughness: 0.04, metalness: 0.1, transparent: true, opacity, depthWrite: false })),
  /** Something that gives off light of its own. */
  glow: (color = '#ffe2a8', strength = 1.4) => cached(`glow:${color}:${strength}`, () => new THREE.MeshStandardMaterial({ color, emissive: new THREE.Color(color), emissiveIntensity: strength, roughness: 0.6, toneMapped: false })),
};
