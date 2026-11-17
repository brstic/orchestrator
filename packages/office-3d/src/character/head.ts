import * as THREE from 'three';
import type { Appearance } from '@orchestrator/contracts';
import { TAU, clamp01, lerp, smooth, wrapPi } from './motion.ts';
import { ball, clothUV, curve, finish, fuse, mirrorX, orient, paint, ringGeo, sheet, tube, xf } from './shape.ts';

/**
 * The head: one sculpted surface with the nose, the lips and the hollows of the eyes in it, eyes with an iris and a
 * lid that closes over them, brows, a head of hair per style, and what is worn on it. Everything is measured from
 * the centre of the head, in metres at life size (the head is then drawn a little larger: `HEAD_SCALE`).
 */

export const HEAD = { a: 0.103, b: 0.126, c: 0.113 };
/** Seen from above the face is flatter than an ellipse: this is the exponent of its outline (2 would be the ellipse). */
const PLAN = 2.25;

const deg = (d: number) => (d * Math.PI) / 180;
const bell = (t: number) => Math.exp(-t * t);

/**
 * A point on the skull for a direction given as azimuth (0 = face, +x = the character's left) and polar angle from
 * the crown. `inf` pushes it outward, which is how hair and hats are wrapped around the same shape; `jaw` is how
 * much the head narrows toward the chin.
 */
export function headPt(az: number, pol: number, inf = 0, jaw = 0.28): [number, number, number] {
  const sr = Math.sin(pol);
  const py = Math.cos(pol);
  const sa = Math.sin(az);
  const ca = Math.cos(az);
  const e = 2 / PLAN;
  const px = sr * (ca > 0 ? Math.sign(sa) * Math.pow(Math.abs(sa), e) : sa);
  const pz = sr * (ca > 0 ? Math.pow(ca, e) : ca);
  const t = clamp01(-py);
  const low = t * t * (3 - 2 * t);
  // Fuller cranium, softly narrowing jaw, flatter face than back of the skull.
  const x = (HEAD.a + inf) * px * (1 - jaw * low) * (1 + 0.04 * Math.max(0, py));
  const y = (HEAD.b + inf) * (py < 0 ? py * (1 - 0.07 * low) : py);
  // (The jaw is carried forward under the face, so the chin sits below the lips rather than behind them.)
  const z = pz > 0 ? (HEAD.c * 0.93 + inf) * pz * (1 - 0.06 * low) + 0.03 * low * pz : (HEAD.c * 0.98 + inf) * pz * (1 - 0.28 * low);
  return [x, y, z];
}

function yOfPol(pol: number): number {
  const py = Math.cos(pol);
  if (py >= 0) return HEAD.b * py;
  const low = py * py * (3 + 2 * py);
  return HEAD.b * py * (1 - 0.07 * low);
}

/** The polar angle at which the skull is at height y. */
function polOfY(y: number): number {
  let lo = 0;
  let hi = Math.PI;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (yOfPol(mid) > y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The azimuth (0 … 90°) at which the front of the skull is x from the middle, at a given polar angle. */
function azOfX(x: number, pol: number, jaw: number): number {
  let lo = 0;
  let hi = Math.PI / 2;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (headPt(mid, pol, 0, jaw)[0] < x) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ───────────────────────────── the face ─────────────────────────────

/** What differs from one face to the next. */
interface Face {
  /** How much the head narrows to the chin; fuller lower cheeks; a stronger chin; a larger nose. */
  jaw: number;
  cheek: number;
  chin: number;
  nose: number;
  /** Half the width of the mouth, and how far its corners turn up. */
  mouthW: number;
  smile: number;
}
/** Soft oval, round, and longer with a firm jaw. */
const FACES: Face[] = [
  { jaw: 0.31, cheek: 0.001, chin: 1, nose: 1, mouthW: 0.0185, smile: 0.0034 },
  { jaw: 0.23, cheek: 0.0035, chin: 0.75, nose: 0.88, mouthW: 0.0198, smile: 0.004 },
  { jaw: 0.27, cheek: -0.0005, chin: 1.45, nose: 1.12, mouthW: 0.0176, smile: 0.0028 },
];
export const FACE_COUNT = FACES.length;

const MOUTH_Y = -0.0655;
/** The ridge of the nose from under its tip up to between the brows: how far it stands out, and how wide it is. */
const NOSE_H: [number, number][] = [[-0.0495, 0], [-0.0455, 0.011], [-0.04, 0.0165], [-0.034, 0.0165], [-0.026, 0.0105], [-0.016, 0.005], [-0.004, 0.002], [0.01, 0]];
const NOSE_W: [number, number][] = [[-0.0495, 0.0105], [-0.04, 0.012], [-0.034, 0.0114], [-0.026, 0.0094], [-0.016, 0.0082], [0, 0.0076], [0.021, 0.009]];

/** The eyes: where their centres are on the face, and how far they are turned outward with the curve of the face. */
const EX = 0.043;
const EY = -0.012;
export const EYE_YAW = 0.19;
/** The eyeball is a flattened ball (its radius up-down and front-back, and its half width); the lids lie on it, a little larger. */
const EYE_R = 0.025;
const EYE_AX = 0.031;
const LID = 0.0011;
const POD_R = EYE_R + LID;
const POD_AX = EYE_AX + LID;
/** The hollow the eye sits in is flat, this far in front of the eye's centre; the lids and the eye swell out of it. */
const FLOOR = 0.019;
/** The lids at rest: the upper one's edge is this far above straight ahead, the lower one's this far below (radians round the eye). */
const LID_UP = deg(29);
const LID_LOW = deg(-34);
/** How far the upper lid turns down to close the eye. */
export const LID_CLOSE = LID_UP - LID_LOW;

/** Lips: how far a point is from the line where they part (y − that line), and across the mouth (−1 … 1). */
function lips(x: number, y: number, f: Face): { d: number; u: number; h: number; span: number } {
  const u = x / f.mouthW;
  const au = Math.abs(u);
  const d = y - (MOUTH_Y + f.smile * Math.min(au * au, 1.7));
  const span = Math.max(0, 1 - u * u);
  const h = d >= 0 ? 0.0046 * Math.pow(span, 0.7) * (1 - 0.2 * bell(u / 0.2)) : 0.0064 * Math.pow(span, 0.6);
  return { d, u: au, h, span };
}

/** The face without the hollows of the eyes. */
function rawFace(az: number, pol: number, f: Face): [number, number, number] {
  const p = headPt(az, pol, 0, f.jaw);
  const front = smooth(0, 0.34, Math.sin(pol) * Math.cos(az));
  if (front <= 0) return p;
  const y = p[1];
  const ax = Math.abs(p[0]);
  let dz = 0;
  // Brow ridge, cheekbones, fuller lower cheeks.
  dz += 0.0026 * bell((y - 0.024) / 0.011) * Math.exp(-Math.pow(ax / 0.066, 4));
  dz += 0.003 * bell((ax - 0.048) / 0.022) * bell((y + 0.03) / 0.02);
  dz += f.cheek * bell((ax - 0.046) / 0.03) * bell((y + 0.05) / 0.03);
  // Nose: a ridge that widens to the tip, and the wings beside it.
  dz += curve(NOSE_H, y) * f.nose * Math.exp(-Math.pow(ax / curve(NOSE_W, y), 2.4));
  dz += 0.0032 * f.nose * bell((ax - 0.0105) / 0.0055) * bell((y + 0.039) / 0.0055);
  // The mouth stands on a slight swell; a dip under the lower lip; the chin.
  dz += 0.0022 * bell(ax / 0.032) * bell((y - MOUTH_Y) / 0.017);
  dz -= 0.0015 * bell(ax / 0.02) * bell((y + 0.083) / 0.007);
  dz += 0.007 * f.chin * bell(ax / 0.027) * bell((y + 0.1) / 0.017);
  const m = lips(p[0], y, f);
  if (m.u < 1.3 && Math.abs(m.d) < 0.012) {
    const q = m.h > 1e-5 ? Math.abs(m.d) / m.h : 9;
    const lobe = q < 1.15 ? Math.sin(Math.PI * Math.pow(q / 1.15, 0.85)) : 0;
    dz += (m.d >= 0 ? 0.002 : 0.003) * lobe * Math.sqrt(m.span);
    dz -= 0.0009 * bell(m.d / 0.0012) * (1 - smooth(1, 1.25, m.u));
  }
  p[0] *= 1 + f.cheek * 3.2 * bell((y + 0.05) / 0.035) * front;
  p[2] += dz * front;
  return p;
}

/** The point of the face that is x from the middle at height y (front of the head only). */
function faceAtRaw(x: number, y: number, f: Face): [number, number, number] {
  const pol = polOfY(y);
  return rawFace(Math.sign(x) * azOfX(Math.abs(x), pol, f.jaw), pol, f);
}

/** Centre of the left eye (the right one is its mirror image): under the face by the eye's own depth, less what it stands proud. */
const EYE_C: [number, number, number] = (() => {
  const s = faceAtRaw(EX, EY, FACES[0]!);
  const back = POD_R - 0.001;
  return [s[0] - Math.sin(EYE_YAW) * back, s[1], s[2] - Math.cos(EYE_YAW) * back];
})();
/** Where the eyes are in the head (the left one; mirror x for the right). */
export const EYE_AT = { x: EYE_C[0], y: EYE_C[1], z: EYE_C[2] };
/** The front of an eye, for things worn in front of it. */
const EYE_FRONT = EYE_C[2] + POD_R;

/** A point of the face: the sculpted surface, with a flat hollow round each eye. */
function facePt(az: number, pol: number, f: Face): [number, number, number] {
  const p = rawFace(az, pol, f);
  if (p[2] <= 0) return p;
  const side = p[0] >= 0 ? 1 : -1;
  const sy = Math.sin(EYE_YAW) * side;
  const cy = Math.cos(EYE_YAW);
  const dx = p[0] - side * EYE_C[0];
  const dy = p[1] - EYE_C[1];
  const dz = p[2] - EYE_C[2];
  // In the eye's own frame: across it, up, and out along the way it faces.
  const lx = dx * cy - dz * sy;
  const lz = dx * sy + dz * cy;
  const q = (lx / 0.0245) ** 2 + (dy / 0.021) ** 2;
  const m = 1 - smooth(0.85, 3.2, q);
  if (m <= 0) return p;
  const move = (FLOOR - lz) * m;
  p[0] += sy * move;
  p[2] += cy * move;
  return p;
}

/** The point of the finished face that is x from the middle at height y. */
function faceAt(x: number, y: number, f: Face = FACES[0]!): [number, number, number] {
  const pol = polOfY(y);
  return facePt(Math.sign(x) * azOfX(Math.abs(x), pol, f.jaw), pol, f);
}

/** Skin is painted where it is not skin-coloured: the lips, the line between them, a little warmth in the cheeks. */
function faceTint(x: number, y: number, z: number, f: Face, out: [number, number, number]): void {
  // Under the jaw, where the light of the room does not reach.
  const under = 0.2 * smooth(-0.098, -0.118, y);
  for (let i = 0; i < 3; i++) out[i]! *= 1 - under;
  if (z < 0.03) return;
  const ax = Math.abs(x);
  const blush = 0.55 * bell((ax - 0.05) / 0.02) * bell((y + 0.036) / 0.017);
  out[1] *= 1 - 0.07 * blush;
  out[2] *= 1 - 0.09 * blush;
  // The soft shadows a face has whatever the light: under the nose, in the corners of the eyes, under the lower lip.
  const shadow = 0.16 * bell(ax / 0.009) * bell((y + 0.0485) / 0.0028) + 0.1 * bell((ax - EX) / 0.03) * bell((y - EY - 0.004) / 0.022) + 0.1 * bell(ax / 0.016) * bell((y + 0.08) / 0.005);
  out[0] *= 1 - 0.8 * shadow;
  out[1] *= 1 - shadow;
  out[2] *= 1 - shadow;
  const m = lips(x, y, f);
  if (m.u > 1.3 || Math.abs(m.d) > 0.012) return;
  const q = m.h > 1e-5 ? Math.abs(m.d) / m.h : 9;
  const lip = (1 - smooth(0.8, 1.2, q)) * (1 - smooth(0.86, 1, m.u)) * 0.92;
  const tone = m.d >= 0 ? [0.8, 0.5, 0.5] : [0.88, 0.58, 0.57];
  for (let i = 0; i < 3; i++) out[i] = lerp(out[i]!, out[i]! * tone[i]!, lip);
  const line = bell(m.d / 0.0011) * (1 - smooth(1, 1.22, m.u));
  out[0] = lerp(out[0], 0.2, line);
  out[1] = lerp(out[1], 0.1, line);
  out[2] = lerp(out[2], 0.1, line);
}

/** Columns of the head's surface: close together across the face, wide apart round the back. */
const HEAD_AZ: number[] = (() => {
  const xs = [0, 0.0034, 0.007, 0.011, 0.0155, 0.0205, 0.026, 0.032, 0.038, 0.044, 0.05, 0.056, 0.0625, 0.07, 0.078, 0.087, 0.096];
  const half = xs.map((x) => Math.asin(Math.pow(x / HEAD.a, PLAN / 2)));
  for (const d of [90, 104, 120, 138, 158, 180]) half.push(deg(d));
  return [...half, ...half.slice(1, -1).reverse().map((a) => -a)];
})();
/** Rows of it, from the crown down: by angle over the cranium and under the chin, by height down the face. */
const HEAD_ROWS: { pol?: number; y?: number }[] = [
  ...[0, 12, 24, 36, 47, 56, 64].map((d) => ({ pol: deg(d) })),
  ...[0.045, 0.035, 0.026, 0.018, 0.011, 0.004, -0.003, -0.01, -0.017, -0.0235, -0.0285, -0.033, -0.037, -0.0405, -0.044, -0.048, -0.053].map((y) => ({ y })),
  ...[0.0078, 0.0054, 0.0037, 0.0021, 0.0009, 0, -0.0009, -0.0022, -0.0038, -0.0054, -0.0068, -0.0092].map((o) => ({ y: MOUTH_Y + o })),
  ...[-0.08, -0.087, -0.094, -0.101].map((y) => ({ y })),
  ...[156, 167, 180].map((d) => ({ pol: deg(d) })),
];

/** The part of the surface of revolution the lids lie on, between two angles round the eye (0 = straight ahead, up is positive). */
function lidShell(from: number, to: number, nx = 10, na = 6): number[][] {
  const rows: number[][] = [];
  for (let i = 0; i <= na; i++) {
    const a = lerp(from, to, i / na);
    const row: number[] = [];
    for (let j = 0; j <= nx; j++) {
      const x = lerp(-0.985, 0.985, j / nx) * POD_AX;
      const r = POD_R * Math.sqrt(1 - (x / POD_AX) ** 2);
      row.push(x, r * Math.sin(a), r * Math.cos(a));
    }
    rows.push(row);
  }
  return rows;
}

/** A bead along the edge of a lid: what gives the lid its thickness (and, dark, the lashes). */
function lidEdge(at: number, thick: number, nx = 10): THREE.BufferGeometry {
  const rings: number[][] = [];
  for (let j = 0; j <= nx; j++) {
    const x = lerp(-0.985, 0.985, j / nx) * POD_AX;
    const r = POD_R * Math.sqrt(1 - (x / POD_AX) ** 2);
    const t = thick * (0.35 + 0.65 * Math.sqrt(1 - (x / POD_AX) ** 2));
    const ring: number[] = [];
    for (let k = 0; k < 5; k++) {
      const b = (k / 5) * TAU;
      const rr = r + Math.cos(b) * t * 0.8;
      const aa = at + (Math.sin(b) * t) / Math.max(r, 0.004);
      ring.push(x, rr * Math.sin(aa), rr * Math.cos(aa));
    }
    rings.push(ring);
  }
  return orient(ringGeo(rings, true, true));
}

/** Put a part made in an eye's own frame where that eye is in the head. */
const atEye = (g: THREE.BufferGeometry, side: 1 | -1) => xf(g, side * EYE_C[0], EYE_C[1], EYE_C[2], 0, side * EYE_YAW, 0);

const HEADS = new Map<string, THREE.BufferGeometry>();
/**
 * The head for one of the faces: skull, face, ears and lower lids as one painted surface. With facial hair, the
 * triangles where it grows come last, as a second group (draw it with `[skin, hair]`).
 */
export function headGeo(face: number, facial: FacialHairKind | null = null): THREE.BufferGeometry {
  const i = ((face % FACES.length) + FACES.length) % FACES.length;
  const key = `${i}|${facial ?? ''}`;
  let g = HEADS.get(key);
  if (!g) {
    g = facial ? withFacialHair(headGeo(i).clone(), facial, i) : finish(buildHead(FACES[i]!));
    HEADS.set(key, g);
  }
  return g;
}

function withFacialHair(g: THREE.BufferGeometry, kind: FacialHairKind, face: number): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const index = g.getIndex()!;
  const skin: number[] = [];
  const hair: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t);
    const b = index.getX(t + 1);
    const c = index.getX(t + 2);
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
    const z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    (hasFacialHair(kind, x, y, z, face) ? hair : skin).push(a, b, c);
  }
  g.setIndex([...skin, ...hair]);
  g.clearGroups();
  g.addGroup(0, skin.length, 0);
  g.addGroup(skin.length, hair.length, 1);
  return g;
}

function buildHead(f: Face): THREE.BufferGeometry {
  const rings: number[][] = [];
  for (const row of HEAD_ROWS) {
    const ring: number[] = [];
    for (const az of HEAD_AZ) {
      let pol = row.pol ?? polOfY(row.y!);
      if (row.y !== undefined && Math.cos(az) > 0) {
        // Rows near the mouth bend with it, so the line between the lips runs along one of them.
        const x = Math.abs(headPt(az, pol, 0, f.jaw)[0]);
        const lift = bell((row.y - MOUTH_Y) / 0.0105) * f.smile * Math.min((x / f.mouthW) ** 2, 1.7) * (1 - smooth(0.045, 0.08, x));
        if (lift > 1e-6) pol = polOfY(row.y + lift);
      }
      const p = facePt(az, pol, f);
      ring.push(p[0], p[1], p[2]);
    }
    rings.push(ring);
  }
  const skull = ringGeo(rings, false, false, true, true);
  const pos = skull.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(pos.count * 3);
  const c: [number, number, number] = [1, 1, 1];
  for (let i = 0; i < pos.count; i++) {
    c[0] = c[1] = c[2] = 1;
    faceTint(pos.getX(i), pos.getY(i), pos.getZ(i), f, c);
    col.set(c, i * 3);
  }
  skull.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const parts = [skull];
  for (const side of [1, -1] as const) {
    // Ear: a shallow cup with a rolled rim, tilted back against the head.
    const e = headPt(side * EAR_AZ, Math.PI / 2 + 0.05);
    const cup = xf(ball(10, 6), 0, 0, 0, 0, 0, 0, 0.0075, 0.03, 0.0185);
    const rim = xf(new THREE.TorusGeometry(1, 0.2, 5, 16), 0.002 * side, 0.002, -0.001, 0, Math.PI / 2, 0, 0.0165, 0.0265, 0.021);
    parts.push(xf(fuse([cup, rim]), e[0] - side * 0.003, e[1], e[2] - 0.002, 0.12, -side * 0.42, 0));
    // Lower lid: the eye's own surface from under the eye up to its edge, with a rim.
    parts.push(atEye(sheet(lidShell(LID_LOW - deg(52), LID_LOW), true), side));
    parts.push(atEye(lidEdge(LID_LOW, 0.0007), side));
  }
  return fuse(parts);
}

// ───────────────────────────── eyes, lids, brows ─────────────────────────────

/**
 * Eyes, lids and brows say they are one size, a little smaller than they are: the office leaves small parts of
 * far-away people out by size (see People.tsx), and these belong together — shown together from a few desks away,
 * and left out together from across the building, where a face is a handful of pixels.
 */
function faceSized(g: THREE.BufferGeometry, lid = false): THREE.BufferGeometry {
  g.boundingSphere = new THREE.Sphere(lid ? new THREE.Vector3(0, 0, 0) : new THREE.Vector3(0, EYE_C[1] + 0.008, EYE_C[2] + 0.01), 0.058);
  return g;
}

/** Iris colours, from the most to the least common. */
export const IRIS = ['#5a3a22', '#3d2616', '#6f5a2c', '#4d7a55', '#3f78ad', '#6d7f8c'];

const EYES = new Map<string, THREE.BufferGeometry>();
/** Both eyes, painted: white, an iris of the given colour with a darker rim, the pupil, and the light caught in each. */
export function eyesGeo(iris: string): THREE.BufferGeometry {
  let g = EYES.get(iris);
  if (!g) EYES.set(iris, (g = faceSized(finish(fuse([atEye(eyeball(1, iris), 1), atEye(eyeball(-1, iris), -1)])))));
  return g;
}

function eyeball(side: 1 | -1, irisHex: string): THREE.BufferGeometry {
  const seg = 20;
  // The iris sits a touch toward the nose and up: both eyes then look at the same thing, straight ahead.
  const cx = -side * 0.0011;
  const cy = -0.0006;
  const IRIS_R = 0.0135;
  const iris = new THREE.Color(irisHex);
  const light = iris.clone().lerp(new THREE.Color('#ffffff'), 0.2);
  const rim = iris.clone().multiplyScalar(0.42);
  const pupil = new THREE.Color('#0b0909');
  const white = new THREE.Color('#f7f5f0');
  const shade = new THREE.Color('#e9e3dc');
  const RIM = 0.86;
  // [distance from the centre of the iris, or (negative) how far out toward the edge of the eye; colour]
  const bands: [number, THREE.Color][] = [[0, pupil], [0.006, pupil], [0.0067, light], [0.0102, iris], [0.0126, rim], [IRIS_R, white], [-0.4, white], [-0.75, white], [-1, shade]];
  const rings: number[][] = [];
  const cols: number[] = [];
  const surf = (x: number, y: number) => EYE_R * Math.sqrt(Math.max(0, 1 - (x / EYE_AX) ** 2 - (y / EYE_R) ** 2));
  for (const [r, colour] of bands) {
    const ring: number[] = [];
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * TAU;
      let x = cx + Math.abs(r) * Math.cos(a);
      let y = cy + Math.abs(r) * Math.sin(a);
      if (r < 0) {
        x = lerp(cx + IRIS_R * Math.cos(a), RIM * EYE_AX * Math.cos(a), -r);
        y = lerp(cy + IRIS_R * Math.sin(a), RIM * EYE_R * Math.sin(a), -r);
      }
      ring.push(x, y, surf(x, y));
      // The upper lid throws a soft shadow on the eye.
      const dim = lerp(1, 0.78, smooth(0.002, 0.012, y));
      cols.push(colour.r * dim, colour.g * dim, colour.b * dim);
    }
    rings.push(ring);
  }
  const g = ringGeo(rings, false, false, true, false);
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  // The light caught in the eye: a fleck toward the upper side, the same side on both.
  const gx = cx + 0.005;
  const gy = cy + 0.0052;
  const glint = paint(xf(ball(8, 6), gx, gy, surf(gx, gy) + 0.0003, 0, 0, 0, 0.0028, 0.0033, 0.0009), 1, 1, 1);
  return fuse([g, glint]);
}

let LIDS: THREE.BufferGeometry | null = null;
/**
 * One upper lid, in the eye's own frame (it turns about the eye's side-to-side axis to close): skin, with a dark
 * edge of lashes. It reaches far enough back over the eye that the eye stays covered when it is down.
 */
export function lidGeo(): THREE.BufferGeometry {
  if (LIDS) return LIDS;
  const skin = paint(sheet(lidShell(LID_UP, LID_UP + deg(112)), true), 1, 1, 1);
  const lash = paint(lidEdge(LID_UP, 0.002), 0.035, 0.025, 0.025);
  LIDS = faceSized(finish(fuse([skin, lash])), true);
  return LIDS;
}

/** Brows: soft arch, straight and heavy, angled. [height at the inner end, arch, where the arch peaks, drop of the tail, thickness] */
const BROWS: [number, number, number, number, number][] = [
  [0.0215, 0.0052, 0.55, 0.0045, 0.0072],
  [0.0225, 0.0022, 0.5, 0.0014, 0.0086],
  [0.0195, 0.0076, 0.66, 0.0062, 0.0068],
  // Chosen in the character creator only (a look the office makes up uses the first three, as before):
  // straight and full; fine and high-arched.
  [0.022, 0.0012, 0.45, 0.0008, 0.0098],
  [0.0205, 0.0098, 0.7, 0.0085, 0.0048],
];
export const BROW_COUNT = BROWS.length;
/** The brows a made-up look picks from: the first three (so that every look made before keeps its brows). */
export const BROWS_MADE_UP = 3;
const BROW_GEOS: (THREE.BufferGeometry | undefined)[] = [];
export function browsGeo(kind: number): THREE.BufferGeometry {
  const i = ((kind % BROWS.length) + BROWS.length) % BROWS.length;
  return (BROW_GEOS[i] ??= faceSized(finish(fuse([brow(1, BROWS[i]!), brow(-1, BROWS[i]!)]))));
}

function brow(side: 1 | -1, [y0, arch, peak, drop, thick]: [number, number, number, number, number]): THREE.BufferGeometry {
  const N = 10;
  const rings: number[][] = [];
  const up = new THREE.Vector3();
  const out = new THREE.Vector3();
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    const x = lerp(0.016, 0.068, s);
    const y = y0 + arch * Math.sin((Math.PI / 2) * Math.min(1, s / peak)) - drop * Math.pow(Math.max(0, (s - peak) / (1 - peak)), 1.5);
    const p = faceAt(side * x, y);
    out.set(p[0] / HEAD.a ** 2, (p[1] / HEAD.b ** 2) * 0.6, p[2] / HEAD.c ** 2).normalize();
    up.set(0, 1, 0).addScaledVector(out, -out.y).normalize();
    // Blunt at the inner end, drawn out to a point at the tail.
    const t = (thick / 2) * lerp(1, 0.22, Math.pow(s, 1.6)) * Math.sqrt(smooth(-0.02, 0.1, s));
    const ring: number[] = [];
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * TAU;
      const u = Math.cos(a) * t;
      const v = Math.sin(a) * 0.0021 + 0.0005;
      ring.push(p[0] + up.x * u + out.x * v, p[1] + up.y * u + out.y * v, p[2] + up.z * u + out.z * v);
    }
    rings.push(ring);
  }
  return orient(ringGeo(rings, true, true));
}

// ───────────────────────────── hair ─────────────────────────────

export type HairStyle = Appearance['hairStyle'];

/** Smoothly interpolated limit (degrees in, radians out) keyed by |azimuth| in degrees. */
function keyed(keys: [number, number][], az: number): number {
  let a = az % TAU;
  if (a < 0) a += TAU;
  if (a > Math.PI) a = TAU - a;
  const d = (a * 180) / Math.PI;
  for (let i = 0; i < keys.length - 1; i++) {
    const k0 = keys[i]!;
    const k1 = keys[i + 1]!;
    if (d <= k1[0]) return deg(lerp(k0[1], k1[1], smooth(k0[0], k1[0], d)));
  }
  return deg(keys[keys.length - 1]![1]);
}

const ring = (half: number[]) => [...half, ...half.slice(1, -1).reverse().map((a) => -a)].map(deg);
/** Columns of a head of hair: closer together round the ears, where the hairline turns. */
const HAIR_AZ = ring([0, 8, 16, 24, 32, 40, 48, 54, 58, 62, 66, 70, 74, 78, 82, 86, 90, 94, 98, 102, 106, 110, 114, 118, 124, 132, 140, 150, 160, 170, 180]);
const EVEN_AZ = (n: number) => Array.from({ length: n }, (_v, j) => (j / n) * TAU);

interface Shell {
  /** Where the surface ends (polar angle) for each azimuth. */
  line: (az: number) => number;
  thick: (az: number, pol: number) => number;
  azs?: number[];
  rows?: number;
  /** How far down (0 … 1) the edge starts rounding over. */
  lip?: number;
  /** Clearance from the skull on top, and where the last row of the edge ends (negative: under the skin). */
  base?: number;
  edge?: number;
}

/** A shell wrapped over the skull from the crown down to a per-azimuth edge, with a rounded lip that ends in the skin. */
function shell(o: Shell): THREE.BufferGeometry {
  const azs = o.azs ?? HAIR_AZ;
  const rows = o.rows ?? 18;
  const lipStart = o.lip ?? 0.8;
  const base = o.base ?? 0.0015;
  const edge = o.edge ?? -0.003;
  const rings: number[][] = [];
  for (let i = 0; i <= rows; i++) {
    const v = 1 - Math.pow(1 - i / rows, 1.7);
    const lip = v < lipStart ? 1 : Math.sqrt(Math.max(0, 1 - ((v - lipStart) / (1 - lipStart)) ** 2));
    const r: number[] = [];
    for (const az of azs) {
      const pol = v * o.line(az);
      const t = o.thick(az, pol);
      // The edge keeps a little thickness to the very end, then turns straight down into the skin: a clean hairline,
      // and never two surfaces lying on one another.
      const p = headPt(az, pol, i === rows ? edge : base + Math.max(lip * t, Math.min(t, 0.0022)));
      r.push(p[0], p[1], p[2]);
    }
    rings.push(r);
  }
  return ringGeo(rings, false, false, true, false);
}

export const EAR_AZ = Math.PI / 2 + 0.14;

const SHORT_LINE: [number, number][] = [[0, 51], [26, 53], [46, 58], [60, 72], [70, 88], [80, 93], [88, 88], [94, 80], [102, 77], [110, 84], [120, 104], [140, 120], [180, 126]];
const LONG_LINE: [number, number][] = [[0, 49], [24, 52], [40, 59], [52, 76], [62, 90], [180, 92]];
const BUN_LINE: [number, number][] = [[0, 48], [30, 51], [50, 58], [64, 70], [78, 77], [92, 76], [104, 80], [116, 94], [132, 110], [180, 121]];
const CURLY_LINE: [number, number][] = [[0, 50], [30, 53], [50, 61], [64, 80], [76, 92], [88, 88], [98, 80], [108, 86], [120, 104], [180, 122]];
const CAP_LINE: [number, number][] = [[0, 63], [60, 75], [100, 84], [180, 87]];

const topness = (pol: number) => Math.pow(Math.max(0, Math.cos(pol)), 0.7);

/**
 * Short: clipped close at the sides and the back, longer on top and combed across to one side from a parting,
 * lifted at the front. The few broad locks are in the shape, so they read from across the room.
 */
function shortHair(): THREE.BufferGeometry {
  return shell({
    line: (az) => keyed(SHORT_LINE, az),
    thick: (az, pol) => {
      const a = wrapPi(az);
      const crown = smooth(deg(78), deg(50), pol);
      const sweep = Math.max(0, Math.cos(a - 0.45));
      const quiff = Math.exp(-((pol - 0.74) ** 2) / 0.07) * sweep * sweep * smooth(1.9, 1.1, Math.abs(a));
      const part = bell((a + 0.62) / 0.11) * smooth(0.2, 0.5, pol) * smooth(1.25, 0.8, pol);
      const locks = Math.sin(6 * a + 2.4 * pol + 0.6) * smooth(0.22, 0.6, pol);
      return 0.0048 + crown * (0.0165 + 0.011 * quiff - 0.0055 * part + 0.0022 * locks);
    },
    lip: 0.74,
  });
}

/** Hair kept close to the head: what shows of short hair or a bun under a cap, and the swept-back hair of a bun. */
function closeHair(line: [number, number][], thick: (az: number, pol: number) => number): THREE.BufferGeometry {
  return shell({ line: (az) => keyed(line, az), thick, lip: 0.84 });
}

/**
 * Long: parted in the middle, over the ears and down to the shoulders, turning in at the ends. One surface from the
 * crown down the outside, round the ends and back up the inside, so there is hair wherever it is looked at from.
 */
function longHair(underCap: boolean): THREE.BufferGeometry {
  const azs = HAIR_AZ;
  const capRows = 13;
  const hangRows = 7;
  const inRows = 4;
  const lipStart = 0.78;
  const line = (az: number) => keyed(LONG_LINE, az);
  /** 0 across the forehead (the hair ends at the hairline) … 1 where it hangs. */
  const hangs = (az: number) => smooth(deg(46), deg(68), Math.abs(wrapPi(az)));
  const length = (az: number) => 0.148 + 0.036 * Math.pow(smooth(deg(95), deg(170), Math.abs(wrapPi(az))), 1.4);
  const thick = (az: number, pol: number) => {
    if (underCap) return 0.007;
    const a = wrapPi(az);
    const part = bell(a / 0.075) * smooth(0.08, 0.3, pol);
    const curtain = bell((Math.abs(a) - 0.5) / 0.32) * smooth(0.45, 0.85, pol);
    return 0.0155 + 0.008 * topness(pol) - 0.0065 * part + 0.0045 * curtain;
  };
  const rings: number[][] = [];
  const ends: [number, number, number][] = [];
  for (let i = 0; i <= capRows; i++) {
    const v = 1 - Math.pow(1 - i / capRows, 1.2);
    const round = v < lipStart ? 1 : Math.sqrt(Math.max(0, 1 - ((v - lipStart) / (1 - lipStart)) ** 2));
    const r: number[] = [];
    for (const az of azs) {
      const h = hangs(az);
      const pol = v * line(az);
      const t = thick(az, pol);
      // Across the forehead the hair ends in an edge that turns down into the skin; elsewhere it goes on down.
      const p = headPt(az, pol, lerp(i === capRows ? -0.003 : 0.0015 + Math.max(round * t, 0.0022), 0.002 + t, Math.min(1, h * 2.5)));
      r.push(p[0], p[1], p[2]);
      if (i === capRows) ends.push(p);
    }
    rings.push(r);
  }
  const hang = (t: number, inner: number) => {
    const r: number[] = [];
    azs.forEach((az, j) => {
      const e = ends[j]!;
      const h = hangs(az);
      const back = smooth(deg(110), deg(170), Math.abs(wrapPi(az)));
      // It swells a little below the ears, then turns in toward the neck at the ends.
      const lock = 1 + 0.028 * Math.sin(7 * az + 0.4) * smooth(0, 0.6, t) * h;
      const f = (1 - h * 0.23 * Math.pow(t, 2)) * lock * lerp(1, 0.7, inner * Math.min(1, h * 3));
      r.push(e[0] * f, e[1] - length(az) * (1 + 0.04 * Math.sin(7 * az)) * h * t + inner * 0.005 * h, e[2] * f + 0.008 * back * h * t * (1 - inner));
    });
    rings.push(r);
  };
  for (let k = 1; k <= hangRows; k++) hang(Math.pow(k / hangRows, 1.5), 0);
  // Round the ends, then back up the inside.
  hang(1.04, 0.5);
  for (let k = 0; k <= inRows; k++) hang(1 - k / inRows, 1);
  return ringGeo(rings, false, false, true, false);
}

/** A knot of hair: a ball with the hair wound round it. */
function knot(x: number, y: number, z: number, r: number): THREE.BufferGeometry {
  const g = ball(18, 12);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    const wind = 1 + 0.045 * Math.sin(3 * Math.atan2(px, py) + 5 * pz) * (1 - pz * pz);
    pos.setXYZ(i, px * wind, py * wind, pz * 0.86);
  }
  g.computeVertexNormals();
  return xf(g, x, y, z, 0, 0, 0, r);
}

/** Directions of the curls: spread evenly over the head, each a little out of place. */
const CURLS: [number, number, number, number][] = (() => {
  const out: [number, number, number, number][] = [];
  const N = 230;
  for (let i = 0; i < N; i++) {
    const r1 = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
    const r2 = Math.abs(Math.sin(i * 78.233) * 12345.678) % 1;
    const y = 1 - ((i + 0.5) / N) * 1.8 + (r1 - 0.5) * 0.04;
    const az = i * 2.399963 + (r2 - 0.5) * 0.3;
    const s = Math.sqrt(Math.max(0, 1 - y * y));
    out.push([s * Math.sin(az), y, s * Math.cos(az), 0.7 + 0.3 * r1]);
  }
  return out;
})();

/** How much curl there is in a direction from the centre of the head: 0 between curls … about 1 on one. */
function curl(az: number, pol: number): number {
  const sr = Math.sin(pol);
  const x = sr * Math.sin(az);
  const y = Math.cos(pol);
  const z = sr * Math.cos(az);
  // Each curl is a dome; where two meet there is a crease (the larger of the two, softened), not a saddle.
  let s = 0;
  for (const c of CURLS) {
    const d2 = 2 - 2 * (x * c[0] + y * c[1] + z * c[2]);
    if (d2 < 0.1) s += Math.pow(c[3] * Math.max(0, 1 - d2 / 0.03), 4);
  }
  return Math.pow(s, 0.25) ** 0.6;
}

/** Curly: a full, rounded head of curls. Under a cap only what is below the cap's edge is full. */
function curlyHair(underCap: boolean): THREE.BufferGeometry {
  return shell({
    line: (az) => keyed(CURLY_LINE, az),
    thick: (az, pol) => {
      const full = underCap ? smooth(-0.04, 0.14, pol - keyed(CAP_LINE, az)) : 1;
      return 0.004 + full * (0.014 + 0.011 * topness(pol) + 0.02 * curl(az, pol));
    },
    azs: EVEN_AZ(72),
    rows: 28,
    lip: 0.72,
  });
}

/** Afro: a full round cloud of tight curls, well clear of the head. Under a cap, full only below the cap's edge. */
function afroHair(underCap: boolean): THREE.BufferGeometry {
  return shell({
    line: (az) => keyed(CURLY_LINE, az) + deg(4),
    thick: (az, pol) => {
      const full = underCap ? smooth(-0.04, 0.14, pol - keyed(CAP_LINE, az)) : 1;
      return 0.004 + full * (0.03 + 0.024 * topness(pol) + 0.012 * Math.sin(pol) + 0.012 * curl(az, pol));
    },
    azs: EVEN_AZ(72),
    rows: 30,
    lip: 0.7,
  });
}

/** Mohawk: the sides and back shaved close, a tall crest from the forehead over the crown to the nape. */
function mohawkHair(underCap: boolean): THREE.BufferGeometry {
  if (underCap) return closeHair(SHORT_LINE, () => 0.0035);
  return shell({
    line: (az) => keyed(SHORT_LINE, az),
    thick: (az, pol) => {
      // How far from the middle of the head, across: the crest is a few centimetres wide wherever it runs.
      const across = Math.abs(Math.sin(az)) * Math.sin(pol) * HEAD.a;
      // Shaved either side: there the surface runs well under the skin (`base`), so the crest's edge is a clean
      // line in it and nowhere does the surface lie on the skin.
      const crest = bell(across / 0.019) * smooth(deg(124), deg(96), pol);
      return 0.042 * smooth(0.3, 0.7, crest) + 0.006 * crest * Math.sin(9 * pol + 0.5);
    },
    azs: EVEN_AZ(96),
    rows: 26,
    lip: 0.8,
    base: -0.007,
  });
}

/** Ponytail: swept back close to the head and gathered at the back, the tail hanging to the nape and a little below. */
function ponytailHair(underCap: boolean): THREE.BufferGeometry {
  const back = closeHair(BUN_LINE, (az, pol) => (underCap ? 0.0055 : 0.006 + 0.006 * topness(pol) + 0.0012 * Math.sin(10 * az) * smooth(0.3, 0.7, pol)));
  const at = underCap ? headPt(Math.PI, deg(110), 0.012) : headPt(Math.PI, deg(84), 0.012);
  const tail = tube(
    [
      [at[0], at[1], at[2] + 0.004],
      [at[0], at[1] - 0.03, at[2] - 0.03],
      [at[0], at[1] - 0.09, at[2] - 0.035],
      [at[0], at[1] - 0.15, at[2] - 0.02],
      [at[0], at[1] - 0.19, at[2] - 0.006],
    ],
    (t) => 0.019 * (1 - 0.35 * t) * (t < 0.08 ? 0.75 + 3 * t : 1) * (1 - 0.6 * smooth(0.82, 1, t)),
    12,
    2,
  );
  const tie = xf(new THREE.TorusGeometry(0.016, 0.004, 6, 14), at[0], at[1] - 0.004, at[2] - 0.006, 1.1, 0, 0);
  return fuse([back, tail, tie]);
}

function buildHair(style: HairStyle, underCap: boolean): THREE.BufferGeometry | null {
  switch (style) {
    case 'buzz':
      // Clipped all over, the same length everywhere.
      return closeHair(SHORT_LINE, () => 0.0034);
    case 'afro':
      return clothUV(afroHair(underCap));
    case 'mohawk':
      return mohawkHair(underCap);
    case 'ponytail':
      return ponytailHair(underCap);
    case 'bald':
      return null;
    case 'short':
      return underCap ? closeHair(SHORT_LINE, () => 0.0055) : shortHair();
    case 'long':
      return longHair(underCap);
    case 'bun': {
      // Swept back from the face with a little lift over the forehead; the knot high on the back of the head, or low under a cap.
      const back = closeHair(BUN_LINE, (az, pol) => (underCap ? 0.0055 : 0.0065 + 0.007 * topness(pol) + 0.004 * Math.exp(-((pol - 0.7) ** 2) / 0.08) * Math.max(0, Math.cos(az)) + 0.0011 * Math.sin(10 * az) * smooth(0.3, 0.7, pol)));
      const b = underCap ? headPt(Math.PI, deg(112), 0.028) : headPt(Math.PI, deg(48), 0.03);
      return fuse([back, knot(b[0], b[1], b[2], 0.047)]);
    }
    case 'curly':
      // (With coordinates for the finer curl that is drawn on its surface.)
      return clothUV(curlyHair(underCap));
  }
}

const HAIR_CACHE = new Map<string, THREE.BufferGeometry | null>();
/** The hair for a style. `flip` is the same hair parted on the other side. */
export function hairGeo(style: HairStyle, underCap: boolean, flip: boolean): THREE.BufferGeometry | null {
  const key = `${style}|${underCap ? 1 : 0}|${flip ? 1 : 0}`;
  if (!HAIR_CACHE.has(key)) {
    const g = flip ? hairGeo(style, underCap, false) : buildHair(style, underCap);
    HAIR_CACHE.set(key, g ? finish(flip ? mirrorX(g) : g) : g);
  }
  return HAIR_CACHE.get(key) ?? null;
}

// ───────────────────────────── facial hair ─────────────────────────────

export type FacialHairKind = 'stubble' | 'mustache' | 'goatee' | 'beard';

/** How thick the hair is over the skin at a point of the face (negative: none — the sheet runs under the skin there). */
function facialThickness(kind: FacialHairKind, x: number, y: number, z: number, f: Face): number {
  const ax = Math.abs(x);
  const NONE = -0.0035;
  // Round the lips, whatever is worn: the mouth stays clear.
  const m = lips(x, y, f);
  const mouth = (1 - smooth(1.05, 1.35, m.u)) * (1 - smooth(0.006, 0.011, Math.abs(m.d + 0.001)));
  // Over the upper lip, under the nose.
  const lipBand = (1 - smooth(f.mouthW * 1.2, f.mouthW * 1.6, ax)) * smooth(MOUTH_Y + 0.004, MOUTH_Y + 0.007, y) * (1 - smooth(-0.0525, -0.049, y));
  // The chin, from under the lower lip down and under it.
  // (Edges run along the face's own rows, which are level, and its columns, which are upright — clean lines.)
  const chin = ax < 0.025 && y < MOUTH_Y - 0.012 ? 1 : 0;
  // The whole lower face: jaw and cheeks below a level line, sideburns up to the ear, and under the chin.
  // (Round the side of the head the columns go by the angle round it: the sideburn's edge is one of them.)
  const round = Math.abs(Math.atan2(x, z));
  const jaw = (y < -0.046 || (round > deg(66) && round < deg(100) && y < 0.002)) && round < deg(100) ? 1 : 0;
  let t = NONE;
  if (kind === 'stubble') t = jaw > 0.02 || lipBand > 0.02 ? lerp(NONE, 0.0011, Math.max(jaw, lipBand)) : NONE;
  else if (kind === 'mustache') t = lerp(NONE, 0.0042, lipBand);
  else if (kind === 'goatee') t = lerp(NONE, 0.0045, Math.max(lipBand, chin));
  else t = lerp(NONE, 0.0028 + 0.0075 * smooth(-0.06, -0.11, y), Math.max(jaw, lipBand * 0.9));
  // (Never over the mouth.)
  return lerp(t, NONE, mouth);
}

/**
 * Hair on the face is part of the head: the head's own triangles where it grows are drawn with a second material,
 * in the colour of the hair (`headGeo(face, kind)` puts them in a group of their own). Nothing lies on the skin, so
 * nothing can fight it for the same depth, and its edge is the face's own fine mesh (dense round the mouth).
 */
export function hasFacialHair(kind: FacialHairKind, x: number, y: number, z: number, face: number): boolean {
  const f = FACES[((face % FACES.length) + FACES.length) % FACES.length]!;
  return z > -0.075 && facialThickness(kind, x, y, z, f) > 0;
}

// ───────────────────────────── worn on the head ─────────────────────────────

let GLASSES: THREE.BufferGeometry | null = null;
export function glassesGeo(): THREE.BufferGeometry {
  if (GLASSES) return GLASSES;
  const zf = EYE_FRONT + 0.01;
  const y = EYE_C[1] - 0.0015;
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [1, -1] as const) {
    const cx = side * (EYE_C[0] + 0.003);
    // Rims as large as the eyes behind them, turned a little with the face.
    parts.push(xf(new THREE.TorusGeometry(0.0275, 0.0026, 6, 28), cx, y, zf - 0.003, 0, side * 0.14, 0, 1, 0.86, 1));
    // Temple arm: out from the rim, then back along the side of the head to the top of the ear.
    const ear = headPt(side * EAR_AZ, Math.PI / 2 - 0.2, 0.005);
    const mid = headPt(side * deg(58), Math.PI / 2 - 0.12, 0.007);
    parts.push(
      tube(
        [
          [cx + side * 0.027, y + 0.004, zf - 0.007],
          [mid[0], y + 0.006, mid[2]],
          [ear[0], ear[1], ear[2]],
        ],
        () => 0.0021,
        5,
        1,
      ),
    );
  }
  parts.push(xf(new THREE.TorusGeometry(0.0085, 0.0022, 6, 10, Math.PI), 0, y + 0.004, zf - 0.001, 0, 0, 0, 1, 0.7, 1));
  GLASSES = finish(fuse(parts));
  return GLASSES;
}

/** Over-ear headphones sized to clear the hair: `top` is the band height above the head centre, `cupX` the ear-cup offset. */
function buildHeadphones(top: number, cupX: number): THREE.BufferGeometry {
  const cy = -0.004;
  const cz = -0.014;
  const band = new THREE.TorusGeometry(1, 0.062, 8, 30, Math.PI);
  const parts = [xf(band, 0, cy, cz, 0, 0, 0, cupX + 0.008, top - cy, 0.2)];
  for (const side of [1, -1]) {
    // The cushion against the head, the shell outside it, and the yoke that holds it to the band.
    parts.push(xf(new THREE.TorusGeometry(0.03, 0.013, 8, 18), side * (cupX - 0.004), cy, cz, 0, Math.PI / 2, 0, 1, 1.18, 1));
    parts.push(xf(ball(16, 10), side * (cupX + 0.006), cy, cz, 0, 0, 0, 0.02, 0.046, 0.039));
    parts.push(xf(new THREE.CylinderGeometry(0.03, 0.034, 0.008, 18), side * (cupX + 0.022), cy, cz, 0, 0, Math.PI / 2));
  }
  return fuse(parts);
}

const PHONES_CACHE = new Map<HairStyle, THREE.BufferGeometry>();
export function headphonesGeo(style: HairStyle): THREE.BufferGeometry {
  let g = PHONES_CACHE.get(style);
  if (!g) {
    g =
      style === 'curly'
        ? buildHeadphones(0.184, 0.133)
        : style === 'afro'
          ? buildHeadphones(0.214, 0.163)
          : style === 'long'
            ? buildHeadphones(0.166, 0.128)
            : style === 'bald' || style === 'buzz'
              ? buildHeadphones(0.139, 0.111)
              : style === 'bun' || style === 'ponytail'
                ? buildHeadphones(0.153, 0.113)
                : style === 'mohawk'
                  ? buildHeadphones(0.168, 0.112)
                  : buildHeadphones(0.164, 0.114);
    g = finish(g);
    PHONES_CACHE.set(style, g);
  }
  return g;
}

let CAP: THREE.BufferGeometry | null = null;
export function capGeo(): THREE.BufferGeometry {
  if (CAP) return CAP;
  // A structured crown (taller front panel) with a crisp edge, and a flat, slightly curved peak.
  const crown = shell({ line: (az) => keyed(CAP_LINE, az), thick: (az, pol) => 0.0085 + 0.009 * Math.max(0, Math.cos(az)) ** 2 * Math.sin(pol), azs: EVEN_AZ(40), rows: 14, lip: 0.93, base: 0.0075, edge: 0.005 });
  const A = deg(58);
  const m = 12;
  const steps = 7;
  const rings: number[][] = [];
  const brimPt = (az: number, r: number, top: boolean, out: number[]) => {
    const b = headPt(az, keyed(CAP_LINE, az) - 0.02, 0.011);
    const w = Math.cos((az / A) * (Math.PI / 2));
    const ext = 0.112 * r * Math.pow(Math.max(0, w), 0.5);
    const th = 0.0045 * (1 - r * 0.4);
    out.push(b[0] * (1 + 0.06 * r), b[1] - 0.014 * r - 0.01 * (az / A) ** 2 * r + (top ? th : -th), b[2] + ext);
  };
  for (let k = 0; k <= steps; k++) {
    const r = k / steps;
    const out: number[] = [];
    for (let j = 0; j <= m; j++) brimPt(lerp(-A, A, j / m), r, true, out);
    for (let j = m; j >= 0; j--) brimPt(lerp(-A, A, j / m), r, false, out);
    rings.push(out);
  }
  const brim = ringGeo(rings, false, true);
  const top = headPt(0, 0, 0.016);
  const button = xf(ball(8, 6), 0, top[1], top[2], 0, 0, 0, 0.012, 0.006, 0.012);
  CAP = finish(xf(fuse([crown, brim, button]), 0, 0.004, -0.002, -0.1, 0, 0));
  return CAP;
}
