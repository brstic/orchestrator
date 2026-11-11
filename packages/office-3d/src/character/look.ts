import * as THREE from 'three';
import type { Appearance } from '@orchestrator/contracts';
import { textures } from '../models/kit.ts';
import type { Outfit } from './body.ts';
import { BROW_COUNT, FACE_COUNT, IRIS } from './head.ts';

/**
 * What a character is made of, and what makes one person different from the next. Materials are shared by colour
 * across the whole office; the differences between people (face, brows, eyes, which side the hair is parted on,
 * how broad they are) all follow from the look they already have, so nobody has to choose them.
 */

const GREY = new THREE.Color('#6b7280');
const WHITE = new THREE.Color('#ffffff');
const BLACK = new THREE.Color('#000000');
const MATS = new Map<string, THREE.MeshStandardMaterial>();
const SKINNED = new WeakMap<THREE.Material, THREE.Material>();

/**
 * The same material, for a part that bends (a skinned mesh). The renderer compiles a material differently for skinned
 * and rigid meshes, and a material shared by both is looked up again at every switch between them — about 150 times a
 * frame in a full office, a fifth of the time spent drawing. One twin per material, shared by everyone, avoids that.
 */
export function skinned<T extends THREE.Material>(m: T): T {
  let twin = SKINNED.get(m) as T | undefined;
  if (!twin) {
    twin = m.clone() as T;
    SKINNED.set(m, twin);
  }
  return twin;
}

/**
 * The shadow of a part that bends is drawn with a depth material of its own, for the same reason: the renderer's one
 * built-in depth material would be recompiled-by-lookup at every switch between a bending and a rigid part.
 */
export const SKINNED_DEPTH = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });

/** How far someone without a live session is washed toward grey: dimmed, but still plainly themselves. */
const DIM = 0.26;

type Grain = 'weave' | 'knit' | 'curl';

/** A height map drawn once (nothing to draw on outside a browser: the surface then stays smooth). */
function heightMap(size: number, repeat: number, draw: (ctx: CanvasRenderingContext2D, s: number) => void): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  draw(cv.getContext('2d')!, size);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  // Cloth coordinates are the second set (see `clothUV`).
  t.channel = 1;
  return t;
}

const GRAINS: Partial<Record<Grain, THREE.Texture | null>> = {};
function grain(kind: Grain): THREE.Texture | null {
  if (kind in GRAINS) return GRAINS[kind] ?? null;
  let t: THREE.Texture | null = null;
  if (kind === 'weave') {
    // The furniture's woven cloth, read through the clothes' own coordinates.
    const src = textures.weave();
    if (src) {
      t = src.clone();
      t.channel = 1;
      t.repeat.set(26, 26);
      t.needsUpdate = true;
    }
  } else if (kind === 'knit') {
    // Ribs running down the cloth, each a column of stitches.
    t = heightMap(128, 13, (ctx, s) => {
      const img = ctx.createImageData(s, s);
      const ribs = 8;
      for (let y = 0; y < s; y++)
        for (let x = 0; x < s; x++) {
          const u = ((x / s) * ribs) % 1;
          const v = ((y / s) * ribs * 1.5) % 1;
          const rib = Math.pow(Math.sin(u * Math.PI), 0.7);
          const stitch = 0.78 + 0.22 * Math.abs(Math.sin((v + Math.abs(u - 0.5) * 0.9) * Math.PI));
          const i = (y * s + x) * 4;
          img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(30 + 215 * rib * stitch);
          img.data[i + 3] = 255;
        }
      ctx.putImageData(img, 0, 0);
    });
  } else {
    // Curls: soft rounded tufts of different sizes.
    t = heightMap(128, 11, (ctx, s) => {
      ctx.fillStyle = '#555555';
      ctx.fillRect(0, 0, s, s);
      let seed = 7;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 150; i++) {
        const x = rnd() * s;
        const y = rnd() * s;
        const r = 5 + rnd() * 9;
        for (const dx of [-s, 0, s])
          for (const dy of [-s, 0, s]) {
            const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
            g.addColorStop(0, 'rgba(235,235,235,0.9)');
            g.addColorStop(1, 'rgba(120,120,120,0)');
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
            ctx.fill();
          }
      }
    });
  }
  GRAINS[kind] = t;
  return t;
}

export interface MatOptions {
  /** < 0 darkens, > 0 lightens. */
  shade?: number;
  /** Blend in a second colour first. */
  toward?: string;
  mix?: number;
  /** Lies on another surface: drawn as if a hair nearer, so the two never flicker. */
  decal?: boolean;
  /** A suit's cloth: a fine lighter stripe. */
  stripe?: boolean;
  /** Takes paint from its vertices (multiplied with its colour). */
  painted?: boolean;
  /** The texture of the surface, and how deep it is. */
  grain?: Grain;
  depth?: number;
  /** How much of the room is mirrored in it (skin and cloth: little). */
  sheen?: number;
}

/** Shared material per colour and finish. Offline characters are dimmed slightly toward grey. */
export function mat(hex: string, rough: number, offline: boolean, o: MatOptions = {}): THREE.MeshStandardMaterial {
  const key = `${hex}|${rough}|${offline ? 1 : 0}|${o.shade ?? 0}|${o.decal ? 1 : 0}|${o.toward ?? ''}|${o.mix ?? 0}|${o.stripe ? 1 : 0}|${o.painted ? 1 : 0}|${o.grain ?? ''}|${o.depth ?? 0}|${o.sheen ?? 1}`;
  let m = MATS.get(key);
  if (!m) {
    const c = new THREE.Color(hex);
    if (o.toward) c.lerp(new THREE.Color(o.toward), o.mix ?? 0);
    const shade = o.shade ?? 0;
    if (shade < 0) c.lerp(BLACK, -shade);
    else if (shade > 0) c.lerp(WHITE, shade);
    if (offline) c.lerp(GREY, DIM);
    m = new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: 0, vertexColors: !!o.painted, envMapIntensity: o.sheen ?? 1 });
    if (o.stripe) {
      // The cloth texture is darker than white between its stripes: lift the colour so the ground stays the colour asked for.
      m.map = stripeTexture();
      m.color.multiplyScalar(1 / 0.584);
    }
    const bump = o.grain ? grain(o.grain) : null;
    if (bump) {
      m.bumpMap = bump;
      m.bumpScale = o.depth ?? 1;
    }
    if (o.decal) {
      m.polygonOffset = true;
      m.polygonOffsetFactor = -2;
      m.polygonOffsetUnits = -2;
    }
    MATS.set(key, m);
  }
  return m;
}

let STRIPES: THREE.Texture | null = null;
/** Suit cloth: a fine, slightly lighter stripe on the plain colour (the texture only ever brightens). */
function stripeTexture(): THREE.Texture | null {
  if (STRIPES || typeof document === 'undefined') return STRIPES;
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 4;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#c9c9c9';
  ctx.fillRect(0, 0, 64, 4);
  ctx.fillStyle = '#e2e2e2';
  ctx.fillRect(29, 0, 6, 4);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(30, 0, 4, 4);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  STRIPES = t;
  return t;
}

const EYE_MATS: (THREE.MeshStandardMaterial | undefined)[] = [];
/** Eyes are painted (white, iris, pupil) and wet: the one glossy thing on a face. */
export function eyeMat(offline: boolean): THREE.MeshStandardMaterial {
  return (EYE_MATS[offline ? 1 : 0] ??= new THREE.MeshStandardMaterial({ color: offline ? new THREE.Color('#ffffff').lerp(GREY, DIM) : '#ffffff', roughness: 0.18, metalness: 0, vertexColors: true }));
}

const BADGE_MATS = new Map<string, THREE.MeshStandardMaterial>();
export function badgeMat(level: number, offline: boolean): THREE.MeshStandardMaterial {
  const tier = level >= 8 ? 2 : level >= 4 ? 1 : 0;
  const key = `${tier}|${offline ? 1 : 0}`;
  let m = BADGE_MATS.get(key);
  if (!m) {
    const c = new THREE.Color(tier === 2 ? '#f5c542' : tier === 1 ? '#c0c8d6' : '#4f8cff');
    if (offline) c.lerp(GREY, DIM);
    m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.3, metalness: 0.6, emissive: tier === 2 && !offline ? '#5a4300' : '#000000' });
    BADGE_MATS.set(key, m);
  }
  return m;
}

let SPARK_MAT: THREE.MeshBasicMaterial | null = null;
export const sparkMat = () => (SPARK_MAT ??= new THREE.MeshBasicMaterial({ color: '#fff6d8', toneMapped: false }));

let ZZZ: THREE.Texture | null = null;
/** A hand-drawn "Z" (white, dark outline) for the letters that drift up from a sleeper. */
export function zTexture(): THREE.Texture {
  if (ZZZ) return ZZZ;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d')!;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const z = () => {
    ctx.beginPath();
    ctx.moveTo(18, 17);
    ctx.lineTo(46, 17);
    ctx.lineTo(18, 47);
    ctx.lineTo(46, 47);
    ctx.stroke();
  };
  ctx.strokeStyle = '#27324a';
  ctx.lineWidth = 15;
  z();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 8;
  z();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  ZZZ = t;
  return t;
}

// ───────────────────────────── one person and the next ─────────────────────────────

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const OUTFITS: Outfit[] = ['polo', 'shirt', 'tee', 'sweater'];
export const TIES = ['#a8323e', '#2f6fb5', '#3d7f5a', '#7d55b8'];
export const SHOES = ['#22252c', '#4a3122', '#2b2f3a', '#e6e3dc'];

/** What follows from a look without being part of it. The same look always gives the same person. */
export interface Traits {
  seed: number;
  outfit: Outfit;
  /** Which of the faces and brows (see head.ts), and the colour of the eyes. */
  face: number;
  brow: number;
  iris: string;
  /** The hair parted on the other side. */
  flip: boolean;
  /** The head a little wider or narrower, deeper or shallower; the trunk broader or slighter. */
  headW: number;
  headD: number;
  girth: number;
}

export function traitsOf(a: Appearance, level: number): Traits {
  const seed = hash(`${a.skin}${a.hair}${a.shirt}${a.pants}${a.hairStyle}${a.accessory}`);
  // A second draw, so that these do not line up with what the first one already decides (outfit, tie, shoes).
  const r = hash(`who:${seed}`);
  const light = new THREE.Color(a.skin).getHSL({ h: 0, s: 0, l: 0 }).l;
  // Brown is the common colour everywhere; lighter eyes come with lighter skin.
  const pool = light < 0.45 ? [0, 1, 1, 0, 2] : light < 0.64 ? [0, 1, 0, 2, 3, 0] : [0, 2, 3, 4, 4, 5, 0, 1];
  return {
    seed,
    outfit: level >= 8 ? 'suit' : OUTFITS[seed % OUTFITS.length]!,
    face: (r >>> 15) % FACE_COUNT,
    brow: (r >>> 13) % BROW_COUNT,
    iris: IRIS[pool[(r >>> 18) % pool.length]!]!,
    flip: ((r >>> 12) & 1) === 1,
    headW: 0.97 + (((r >>> 3) % 8) / 7) * 0.07,
    headD: 0.98 + (((r >>> 6) % 5) / 4) * 0.04,
    girth: 0.97 + (((r >>> 9) % 8) / 7) * 0.09,
  };
}
