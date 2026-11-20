import * as THREE from 'three';

/**
 * How a character moves: the poses of someone seated (functions of time), the gait of someone on their feet (feet
 * placed on the floor from the body's real velocity, legs by inverse kinematics), the one-shot reactions layered
 * over either, and the whip. Nothing here knows what the body looks like — only the lengths of its bones.
 */
export type PoseName =
  | 'typing'
  | 'reading'
  | 'watching'
  | 'thinking'
  | 'planning'
  | 'raiseHand'
  | 'blocked'
  | 'idle'
  | 'celebrate'
  /** No live session: asleep at the desk, folded forward with the head on the forearms. */
  | 'offline'
  /** No live session and no desk to sleep at: dozing on their feet. */
  | 'doze'
  | 'still'
  | 'talking'
  | 'walk'
  | 'stand'
  /** One-shot hit reaction layered over whatever the character was doing; eases back by itself within ~0.9 s. */
  | 'ouch'
  /** One-shot whip crack with the right arm (~0.7 s) layered over whatever the character was doing. */
  | 'whip'
  /** A gesture a person asked their character to make (the wheel), layered over the standing body for a few seconds. */
  | EmotePose;

/** The gestures of the wheel, by the names the office passes around (`EMOTES` in contracts). */
export type EmotePose = 'wave' | 'dance' | 'clap' | 'thumbsUp' | 'shrug' | 'point' | 'cheer' | 'bow';
/** How long each gesture lasts, in seconds: it eases in, plays, and eases back into standing by itself. */
export const EMOTE_SECONDS: Record<EmotePose, number> = { wave: 2.6, dance: 6.5, clap: 2.8, thumbsUp: 2.2, shrug: 1.9, point: 2.2, cheer: 2.8, bow: 2.3 };
export const isEmotePose = (name: string): name is EmotePose => Object.prototype.hasOwnProperty.call(EMOTE_SECONDS, name);

/** How a character on its feet is moving, in its own frame of reference. Written by the owner of the transform, read here every frame. */
export interface Motion {
  /** Velocity in world units per second: +x is the character's left, +z straight ahead. */
  vx: number;
  vz: number;
  /** Turn rate in radians per second, with the sign of `rotation.y` (positive = to its left). */
  turn: number;
  /** Setting off at (or keeping up) a running pace: the legs run from the first step instead of walking up to it. */
  run: boolean;
}

// ───────────────────────────── poses ─────────────────────────────

export interface Pose {
  /** Hip centre: sideways sway, height above the floor, slide forward (+) or back (−) on the seat. */
  hipX: number;
  hipY: number;
  hipZ: number;
  /** Hips and legs turned about the vertical axis; roll of the pelvis. */
  pelYaw: number;
  pelRoll: number;
  /** Spine: pitch forward, twist, lean sideways. */
  lean: number;
  twist: number;
  side: number;
  /** Shoulders lifted toward the ears. */
  shrug: number;
  headPitch: number;
  headYaw: number;
  headRoll: number;
  sLx: number;
  sLz: number;
  /** Upper-arm twist toward the body's midline (so a bent forearm points inward). */
  tL: number;
  eL: number;
  sRx: number;
  sRz: number;
  tR: number;
  eR: number;
  /**
   * The hands, on top of how they turn by themselves (palms down as the elbow bends): roll about the forearm, and a
   * bend of the wrist toward the palm (+) or the back of the hand (−). Zero in every pose that does not hold something.
   */
  wrL: number;
  wfL: number;
  wrR: number;
  wfR: number;
  /** Legs: hip flexion, abduction, twist; knee; ankle. */
  hL: number;
  aL: number;
  yL: number;
  kL: number;
  fL: number;
  hR: number;
  aR: number;
  yR: number;
  kR: number;
  fR: number;
}

export const POSE_KEYS: (keyof Pose)[] = [
  'hipX', 'hipY', 'hipZ', 'pelYaw', 'pelRoll', 'lean', 'twist', 'side', 'shrug', 'headPitch', 'headYaw', 'headRoll',
  'sLx', 'sLz', 'tL', 'eL', 'sRx', 'sRz', 'tR', 'eR', 'wrL', 'wfL', 'wrR', 'wfR',
  'hL', 'aL', 'yL', 'kL', 'fL', 'hR', 'aR', 'yR', 'kR', 'fR',
];
export const NKEYS = POSE_KEYS.length;

export const SIT_Y = 0.56;
export const STAND_Y = 0.88;
/** Top of the chair cushion; used to keep small/large builds sitting on the seat. */
export const SEAT_TOP = 0.51;

export const newPose = (): Pose => ({
  hipX: 0, hipY: SIT_Y, hipZ: 0, pelYaw: 0, pelRoll: 0, lean: 0, twist: 0, side: 0, shrug: 0, headPitch: 0, headYaw: 0, headRoll: 0,
  sLx: 0, sLz: 0, tL: 0, eL: 0, sRx: 0, sRz: 0, tR: 0, eR: 0, wrL: 0, wfL: 0, wrR: 0, wfR: 0,
  hL: 0, aL: 0, yL: 0, kL: 0, fL: 0, hR: 0, aR: 0, yR: 0, kR: 0, fR: 0,
});

export const TAU = Math.PI * 2;
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const wrapPi = (a: number) => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};

function setSit(o: Pose): void {
  o.hipX = 0;
  o.hipY = SIT_Y;
  o.hipZ = 0;
  o.pelYaw = 0;
  o.pelRoll = 0;
  o.lean = 0;
  o.twist = 0;
  o.side = 0;
  o.shrug = 0;
  o.headPitch = 0;
  o.headYaw = 0;
  o.headRoll = 0;
  o.sLx = -0.25;
  o.sLz = 0.08;
  o.tL = 0;
  o.eL = -0.9;
  o.sRx = -0.25;
  o.sRz = -0.08;
  o.tR = 0;
  o.eR = -0.9;
  o.wrL = o.wfL = o.wrR = o.wfR = 0;
  o.hL = -1.5;
  o.aL = 0.025;
  o.yL = 0;
  o.kL = 1.45;
  o.fL = 0.05;
  o.hR = -1.5;
  o.aR = -0.025;
  o.yR = 0;
  o.kR = 1.45;
  o.fR = 0.05;
}

/** The desk in front of a seat (see `DESK_SIZE` and `deskSeat` in the contracts): height of its top surface, in metres. */
export const DESK_TOP = 0.7625;
/** Half the thickness of a forearm lying on the desk. */
export const ARM_R = 0.04;
export const UPPER_ARM = 0.26;
export const FOREARM = 0.225;
export const HEAD_Y = 0.585;
/** The head is drawn larger than life: a stylised figure reads by its face, close up and from across the floor. */
export const HEAD_SCALE = 1.14;
/** Centre of the head above and ahead of the neck joint, and half its width (what lies on the forearms when asleep). */
const HEAD_UP = 0.103 * HEAD_SCALE;
const HEAD_FWD = 0.014 * HEAD_SCALE;
const HEAD_HALF = 0.094 * HEAD_SCALE;
export const SHOULDER_X = 0.187;
export const SHOULDER_Y = 0.44;
/** How fast a sleeper breathes, radians per second (a breath every four seconds). */
export const SLEEP_BREATH = TAU * 0.25;

/**
 * Two-bone arm for a seated, leaning body: puts the wrist at (wx, wy, wz) and the elbow at height `ey`, on the outside
 * — or, given `near`, as close to that point as the arm allows. Coordinates are relative to the hip centre, in the
 * character's frame; the spine is pitched forward by `lean` and nothing else. Returns where the elbow is.
 */
function restArm(o: Pose, left: boolean, lean: number, wx: number, wy: number, wz: number, ey: number, near?: readonly [number, number, number]): [number, number, number] {
  const side = left ? 1 : -1;
  const cl = Math.cos(lean);
  const sl = Math.sin(lean);
  const sh = SHOULDER_Y + o.shrug;
  const sx = side * SHOULDER_X;
  const sy = sh * cl;
  const sz = sh * sl;
  let dx = wx - sx;
  let dy = wy - sy;
  let dz = wz - sz;
  let d = Math.hypot(dx, dy, dz);
  const reach = clamp(d, UPPER_ARM - FOREARM + 0.01, UPPER_ARM + FOREARM - 0.004);
  dx *= reach / d;
  dy *= reach / d;
  dz *= reach / d;
  d = reach;
  const nx = dx / d;
  const ny = dy / d;
  const nz = dz / d;
  // The elbow lies on a circle around the line from shoulder to wrist.
  const a = (UPPER_ARM * UPPER_ARM - FOREARM * FOREARM + d * d) / (2 * d);
  const r = Math.sqrt(Math.max(0, UPPER_ARM * UPPER_ARM - a * a));
  const cx = sx + nx * a;
  const cy = sy + ny * a;
  const cz = sz + nz * a;
  // v: the steepest direction in the plane of that circle; u: the level one.
  let vx = -ny * nx;
  let vy = 1 - ny * ny;
  let vz = -ny * nz;
  const vl = Math.hypot(vx, vy, vz) || 1;
  vx /= vl;
  vy /= vl;
  vz /= vl;
  const ux = ny * vz - nz * vy;
  const uz = nx * vy - ny * vx;
  let ex: number;
  let eY: number;
  let ez: number;
  if (near) {
    // The point of the circle nearest to the one asked for.
    let hx = near[0] - cx;
    let hy = near[1] - cy;
    let hz = near[2] - cz;
    const along = hx * nx + hy * ny + hz * nz;
    hx -= along * nx;
    hy -= along * ny;
    hz -= along * nz;
    const hl = Math.hypot(hx, hy, hz) || 1;
    ex = cx + (r * hx) / hl;
    eY = cy + (r * hy) / hl;
    ez = cz + (r * hz) / hl;
  } else {
    const sp = clamp((ey - cy) / (r * vy || 1e-6), -1, 1);
    const cp = Math.sqrt(1 - sp * sp) * (side * ux >= 0 ? 1 : -1);
    ex = cx + r * (cp * ux + sp * vx);
    eY = cy + r * sp * vy;
    ez = cz + r * (cp * uz + sp * vz);
  }
  // Directions of the two bones, turned into the frame of the spine.
  const ax = (ex - sx) / UPPER_ARM;
  const ay0 = (eY - sy) / UPPER_ARM;
  const az0 = (ez - sz) / UPPER_ARM;
  const ay = ay0 * cl + az0 * sl;
  const az = -ay0 * sl + az0 * cl;
  const fx = (sx + dx - ex) / FOREARM;
  const fy0 = (sy + dy - eY) / FOREARM;
  const fz0 = (sz + dz - ez) / FOREARM;
  const fy = fy0 * cl + fz0 * sl;
  const fz = -fy0 * sl + fz0 * cl;
  const rz = Math.asin(clamp(ax, -1, 1));
  const rx = Math.atan2(-az, -ay);
  // The forearm as the upper arm sees it: what is left is the bend of the elbow and the twist of the upper arm.
  const c1 = Math.cos(rx);
  const s1 = Math.sin(rx);
  const gy = fy * c1 + fz * s1;
  const gz = -fy * s1 + fz * c1;
  const c2 = Math.cos(rz);
  const s2 = Math.sin(rz);
  const hx = fx * c2 + gy * s2;
  const hy = -fx * s2 + gy * c2;
  const bend = -Math.acos(clamp(-hy, -1, 1));
  const tw = Math.atan2(hx, gz);
  if (left) {
    o.sLx = rx;
    o.sLz = rz;
    o.tL = -tw;
    o.eL = bend;
  } else {
    o.sRx = rx;
    o.sRz = rz;
    o.tR = tw;
    o.eR = bend;
  }
  return [ex, eY, ez];
}

/**
 * Asleep at the desk: folded forward from the hips, both forearms flat on the desk top, the head turned to one side
 * and resting on them, the back rising and falling with slow, deep breaths. Everything that touches the desk is
 * solved for the real desk height, for any build.
 */
function sleepAtDesk(o: Pose, t: number, ph: number, build: number): void {
  const k = 1 / build;
  const rootY = SIT_Y + SEAT_TOP * (k - 1);
  const desk = DESK_TOP * k;
  const breath = Math.sin(t * SLEEP_BREATH + ph * 1.9);
  /** Which way the face is turned (and which forearm lies in front): the same for one person every time. */
  const turn = Math.sin(ph * 12.9898 + 1.3) >= 0 ? 1 : -1;
  // The head lies on its side, its crown pointing at the monitor, a cheek on the wrists.
  const tip = 1.47;
  const headUp = HEAD_UP * Math.cos(tip) - HEAD_FWD * Math.sin(tip);
  const headOut = HEAD_UP * Math.sin(tip) + HEAD_FWD * Math.cos(tip);
  const headY = desk + 2 * ARM_R + HEAD_HALF;
  const lean0 = Math.acos(clamp((headY - rootY - headUp) / HEAD_Y, 0.35, 0.94));
  // Breathing in lifts the back and the shoulders; the head stays where it lies.
  const lean = lean0 - breath * 0.013;
  o.hipZ = clamp(0.475 * k - HEAD_Y * Math.sin(lean0) - headOut, -0.1, 0.08);
  o.lean = lean;
  o.shrug = 0.012 + breath * 0.007;
  o.headPitch = tip - lean + 0.3 * (lean0 - lean);
  o.headYaw = turn * (1.02 + Math.sin(t * 0.11 + ph * 3.3) * 0.03);
  o.headRoll = turn * 0.05;
  // Forearms: one a little further onto the desk than the other, wrists crossing under the cheek.
  const y = desk + ARM_R - rootY;
  const far = turn > 0;
  restArm(o, true, lean, -0.05 * k, y, (far ? 0.487 : 0.442) * k - o.hipZ, y + 0.005);
  restArm(o, false, lean, 0.05 * k, y, (far ? 0.442 : 0.487) * k - o.hipZ, y + 0.005);
  // Legs slack under the desk: knees fallen apart, one foot slid forward.
  o.aL = 0.1;
  o.aR = -0.1;
  o.kL = 1.45 - 0.2 * (turn > 0 ? 1 : 0);
  o.kR = 1.45 - 0.2 * (turn > 0 ? 0 : 1);
  o.fL = 1.5 - o.kL;
  o.fR = 1.5 - o.kR;
}

/**
 * How a hand is turned at the end of its forearm: by itself, palm down as the elbow bends (keyboard, desk) and forward
 * as the arm is raised — less so for a runner's pumping arms (`desk` 1 seated, toward 0.25 at a run) — and on top of
 * that what the pose asks (`wrL`/`wfL`, `wrR`/`wfR`). Written into `r` (the hand's rotation).
 */
export function handTurn(r: THREE.Euler, o: Pose, left: boolean, desk = 1): void {
  if (left) r.set(0, -1.45 * Math.max(0.3, smooth(0.4, 1.1, -o.eL) * desk, smooth(1.9, 2.6, -o.sLx)) + o.wrL, -o.wfL, 'YZX');
  else r.set(0, 1.45 * Math.max(0.3, smooth(0.4, 1.1, -o.eR) * desk, smooth(1.9, 2.6, -o.sRx)) + o.wrR, o.wfR, 'YZX');
}

/** A number in [0, 1) that stays the same for the same arguments: which look, which way, for whom. */
const hash01 = (a: number, b: number): number => {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Where the underside of the chin is, relative to the hip centre, for a spine pitched by `lean` and a head turned by
 * the pose's own angles (the order the rig applies them in: pitch, then yaw, then roll).
 */
function chinAt(o: Pose, lean: number): [number, number, number] {
  // The underside of the chin in the head's own frame, from the joint at the top of the neck.
  let x = 0;
  let y = -0.012;
  let z = 0.079;
  // roll (z), yaw (y), pitch (x)
  const cr = Math.cos(o.headRoll);
  const sr = Math.sin(o.headRoll);
  [x, y] = [x * cr - y * sr, x * sr + y * cr];
  const cy = Math.cos(o.headYaw);
  const sy = Math.sin(o.headYaw);
  [x, z] = [x * cy + z * sy, -x * sy + z * cy];
  const cp = Math.cos(o.headPitch);
  const sp = Math.sin(o.headPitch);
  [y, z] = [y * cp - z * sp, y * sp + z * cp];
  // The neck joint on the spine, then the spine's pitch.
  y += HEAD_Y;
  z += -0.002;
  const cl = Math.cos(lean);
  const sl = Math.sin(lean);
  return [x, y * cl - z * sl, y * sl + z * cl];
}

/** How long one look of somebody thinking lasts, on average (seconds), and how long the head takes to move to the next. */
const THINK_LOOK = 5.5;
const THINK_TURN = 1.6;

/**
 * Thinking it over: one forearm across the waist, the other elbow resting on that hand, the chin resting in the palm
 * of the raised hand, leaning forward a little. The thoughts wander: every few seconds the head settles into another
 * look — a few degrees to one side, a little up or down, as far as a head resting on a hand turns — and the hand goes
 * with the chin, so it never lets go of it nor goes through it. Now and then the fingers rub the jaw. Which hand holds
 * the chin is the person's own (some the left, some the right), and so is the rhythm.
 */
function thinkAt(o: Pose, t: number, ph: number): void {
  const s = Math.sin;
  /** −1: the right hand holds the chin; +1: the left. */
  const side = hash01(ph, 3.1) < 0.5 ? -1 : 1;
  // The look now and the one before it, eased from one to the other.
  const at = t / THINK_LOOK + ph * 5.3;
  const n = Math.floor(at);
  const ease = smooth(0, THINK_TURN / THINK_LOOK, at - n);
  // (A head resting on a hand turns only a little: a few degrees each way, a little up or down.)
  const lookYaw = (k: number) => (hash01(k, ph) - 0.5) * 0.3 + side * 0.06;
  const lookPitch = (k: number) => -0.12 + hash01(k + 17, ph) * 0.14;
  const breath = s(t * 1.3 + ph * 1.9);
  const lean = 0.13 + breath * 0.005 + s(t * 0.13 + ph * 4.1) * 0.012;
  o.hipZ = 0.03;
  o.lean = lean;
  o.shrug = 0.012 + breath * 0.0025;
  o.headYaw = lerp(lookYaw(n - 1), lookYaw(n), ease) + s(t * 0.41 + ph) * 0.02;
  o.headPitch = lerp(lookPitch(n - 1), lookPitch(n), ease) + s(t * 0.33 + ph * 2.1) * 0.012 - breath * 0.004;
  // The head leans into the hand.
  o.headRoll = -side * (0.11 + s(t * 0.23 + ph * 1.4) * 0.025);
  const [cx, cy, cz] = chinAt(o, lean);
  // The chin rests in the palm: the wrist just under and in front of it, the forearm coming up from the elbow. Now and
  // then (one look in three) the fingers rub the jaw for a moment.
  const rubbing = hash01(n, ph + 9) < 0.34 ? smooth(0.25, 0.4, at - n) * (1 - smooth(0.62, 0.78, at - n)) : 0;
  const rub = rubbing * s(t * 9.5) * 0.009;
  const chinArm = side > 0;
  // (Found by measuring the hand against the head for every look: the palm under the chin and turned up to it, the
  // fingers level along the jaw, touching the face and never more than 7 mm into it — `test/thinking.test.ts`.)
  const [ex, ey, ez] = restArm(o, chinArm, lean, cx + side * 0.01 + rub, cy - 0.037, cz + 0.051, 0, [side * 0.075, 0.23, 0.27]);
  // The other forearm across the waist, its hand holding that elbow.
  restArm(o, !chinArm, lean, ex - side * 0.06, ey - 0.05, ez - 0.04, 0, [-side * 0.17, ey - 0.07, 0.07]);
  // The hand at the chin: the wrist bent well back, so that the palm is turned up under the chin and the fingers lie
  // along the jaw; the supporting hand turns its palm up under the elbow.
  if (chinArm) {
    o.wrL = -1.2;
    o.wfL = -1.3;
    o.wrR = 1.6;
    o.wfR = 0.25;
  } else {
    o.wrR = 1.2;
    o.wfR = -1.3;
    o.wrL = -1.6;
    o.wfL = 0.25;
  }
}

/** A seated pose as a function of time (seconds) and a per-character phase so nobody moves in sync. Writes into `o` (no allocation). `build` is the body scale, for poses that touch the desk. */
export function poseAt(name: PoseName, t: number, ph: number, o: Pose, build = 1): void {
  const s = Math.sin;
  setSit(o);
  switch (name) {
    case 'typing': {
      const k = t * 13 + ph;
      // Eyes drop to the keyboard now and then.
      const glance = smooth(0.82, 0.95, s(t * 0.43 + ph * 2.3));
      o.hipZ = 0.07;
      o.lean = 0.2;
      o.headPitch = 0.08 + s(t * 0.7 + ph) * 0.03 + glance * 0.16;
      o.sLx = -0.95;
      o.sRx = -0.95;
      o.sLz = 0.2 + s(t * 1.7 + ph) * 0.015;
      o.sRz = -0.2 + s(t * 1.3 + ph * 1.4) * 0.015;
      o.tL = 0.3;
      o.tR = 0.3;
      o.eL = -0.84 + s(k) * 0.05;
      o.eR = -0.84 + s(k + 1.9) * 0.05;
      break;
    }
    case 'reading':
      o.hipZ = 0.04;
      o.lean = 0.16 + s(t * 0.4 + ph) * 0.03;
      o.headPitch = 0.06;
      o.headYaw = s(t * 0.5 + ph) * 0.12;
      o.sLx = -0.6;
      o.sLz = 0.2;
      o.tL = 0.5;
      o.eL = -1.25;
      o.sRx = -0.72;
      o.sRz = -0.28;
      o.tR = 0.2;
      o.eR = -1.05 + s(t * 2 + ph) * 0.03;
      break;
    case 'watching':
      // Leaning back with the arms folded.
      o.hipZ = -0.03;
      o.lean = -0.16;
      o.headPitch = -0.04;
      o.sLx = -0.32;
      o.sLz = 0.12;
      o.tL = 1.15;
      o.eL = -1.62;
      o.sRx = -0.42;
      o.sRz = -0.12;
      o.tR = 1.15;
      o.eR = -1.5;
      break;
    case 'thinking':
      thinkAt(o, t, ph);
      // (Its own breathing: the hand at the chin is placed for the head as it is.)
      return;
    case 'planning':
      o.hipZ = 0.04;
      o.lean = 0.2;
      o.headPitch = 0.4;
      o.sRx = -0.72;
      o.tR = 0.35;
      o.eR = -1.1 + s(t * 5 + ph) * 0.05;
      o.sRz = -0.16 + s(t * 2.5 + ph) * 0.06;
      o.sLx = -0.58;
      o.sLz = 0.18;
      o.tL = 0.5;
      o.eL = -1.2;
      break;
    case 'raiseHand':
      o.lean = -0.05;
      o.headPitch = -0.08;
      o.side = -0.04;
      o.sRx = -2.85;
      o.sRz = -0.25 + s(t * 3 + ph) * 0.12;
      o.eR = -0.25 + s(t * 3 + ph) * 0.1;
      o.sLx = -0.5;
      o.sLz = 0.14;
      o.tL = 0.45;
      o.eL = -1.25;
      break;
    case 'blocked':
      // Slumped back, arms hanging, head shaking.
      o.hipZ = -0.03;
      o.lean = -0.2;
      o.headPitch = 0.1;
      o.headYaw = s(t * 1.6 + ph) * 0.3;
      o.sLx = 0.12;
      o.sLz = 0.3;
      o.eL = -0.3;
      o.sRx = 0.12;
      o.sRz = -0.3;
      o.eR = -0.3;
      break;
    case 'idle': {
      // Relaxed, with an occasional real stretch.
      const cycle = (t + ph * 3) % 24;
      const stretch = cycle > 21 ? Math.sin(((cycle - 21) / 3) * Math.PI) : 0;
      const rest = 1 - stretch;
      o.hipZ = -0.03;
      o.lean = -0.18 - stretch * 0.1;
      o.headPitch = -0.05 - stretch * 0.3;
      o.headYaw = s(t * 0.3 + ph) * 0.25;
      o.sLx = -0.2 - stretch * 2.55;
      o.sLz = 0.16 + stretch * 0.3;
      o.tL = 0.9 * rest;
      o.eL = -1.2 + stretch * 0.95;
      o.sRx = -0.2 - stretch * 2.55;
      o.sRz = -0.16 - stretch * 0.3;
      o.tR = 0.9 * rest;
      o.eR = -1.2 + stretch * 0.95;
      break;
    }
    case 'celebrate': {
      const b = Math.abs(s(t * 7 + ph));
      o.hipY = SIT_Y + b * 0.05;
      o.lean = -0.1;
      o.headPitch = -0.25;
      o.sLx = -2.7 - b * 0.2;
      o.sLz = 0.45;
      o.eL = -0.3;
      o.sRx = -2.7 - b * 0.2;
      o.sRz = -0.45;
      o.eR = -0.3;
      break;
    }
    case 'offline':
      sleepAtDesk(o, t, ph, build);
      return;
    case 'talking':
      o.lean = 0.08;
      o.headYaw = s(t * 0.8 + ph) * 0.35;
      o.headPitch = s(t * 1.3 + ph) * 0.05;
      o.sRx = -0.7 + s(t * 2.2 + ph) * 0.25;
      o.eR = -1.3 + s(t * 2.9 + ph) * 0.3;
      o.sRz = -0.2;
      o.tR = 0.2;
      o.sLx = -0.38;
      o.sLz = 0.12;
      o.tL = 0.8;
      o.eL = -1.2;
      break;
    default:
      // 'still' and anything unknown: hands resting in the lap.
      o.sLx = -0.32;
      o.sLz = 0.12;
      o.tL = 0.75;
      o.eL = -1.2;
      o.sRx = -0.32;
      o.sRz = -0.12;
      o.tR = 0.75;
      o.eR = -1.2;
      break;
  }
  // Nobody alive sits perfectly still: breathing, a slowly wandering posture and small head movements.
  const breath = s(t * 1.3 + ph * 1.9);
  o.lean += breath * 0.006 + s(t * 0.13 + ph * 4.1) * 0.014;
  o.shrug += breath * 0.0025;
  o.side += s(t * 0.17 + ph * 2.9) * 0.012;
  o.headPitch += s(t * 0.37 + ph * 2.7) * 0.016 - breath * 0.004;
  o.headYaw += s(t * 0.21 + ph * 1.3) * 0.035 + s(t * 0.53 + ph * 3.1) * 0.018;
  o.headRoll += s(t * 0.29 + ph * 0.7) * 0.012;
}

// ───────────────────────────── locomotion ─────────────────────────────

export const HIP_X = 0.078;
export const THIGH = 0.4;
export const SHIN = 0.4;
/** Height of the ankle joint above the sole; how far the heel is behind it and the front of the sole ahead of it. */
export const ANKLE = 0.08;
export const HEEL = 0.06;
/** A shoe does not bend at the ball of the foot: the foot rolls off the floor over the front of its sole. */
export const TOE = 0.15;
/** The leg is never locked completely straight: the last millimetres of reach are where knees pop. */
const REACH = THIGH + SHIN - 0.0008;
/** The most the hips turn toward the direction of travel when going sideways at a run (the shoulders stay square). */
const FACE_MAX = 0.75;
/** Standing, each foot is this far to the side of the body's centre line; in stride the feet come in under the body. */
const STANCE_X = 0.092;
const TRACK_WALK = 0.058;
const TRACK_RUN = 0.046;
/** Walking, a foot comes down this share of its stride ahead of the hips (and leaves the floor the rest of it behind them). */
const LAND = 0.38;
/** A foot within this distance (and this turn) of where it belongs does not take a step to get there. */
const HOME_NEAR = 0.045;
const HOME_YAW = 0.12;
/** Cadence of the steps that bring the feet back under a body that has stopped, cycles per second. */
const SETTLE_HZ = 1.7;

/** One foot: where it is on the floor. */
interface Step {
  /** The ankle's place on the floor in the body's frame (x to its left, z ahead), and the way the foot points. */
  x: number;
  z: number;
  yaw: number;
  /** Planted — or in the air since it left the floor at (sx, sz, syaw), `w0` of the way into the swing. */
  down: boolean;
  sx: number;
  sz: number;
  syaw: number;
  w0: number;
  /** How far through its swing (0 leaving the floor … 1 landing), and how far through its time on the floor. */
  w: number;
  u: number;
  /** Staying down through this turn to swing: it already stands where it belongs, or it has only just landed. */
  hold: boolean;
}

const newStep = (side: 1 | -1): Step => ({ x: side * STANCE_X, z: 0, yaw: 0, down: true, sx: 0, sz: 0, syaw: 0, w0: 0, w: 0, u: 1, hold: false });

/** The state of one character's gait. */
export interface Loco {
  /** Position in the stride, in cycles. The left foot lands at 0, the right at 0.5. */
  phase: number;
  /** The stride clock runs while the body moves and until both feet are back under it. */
  active: boolean;
  /** The body is being moved or turned (as opposed to standing, perhaps still settling its feet). */
  go: boolean;
  /** How the body really moved this frame (the floor under a planted foot moves exactly the other way) and for how long. */
  mvx: number;
  mvz: number;
  mturn: number;
  dt: number;
  /** Smoothed velocity in the body's frame, a slower copy (their difference is the acceleration), and smoothed turn rate. */
  vx: number;
  vz: number;
  sx: number;
  sz: number;
  turn: number;
  speed: number;
  /** 0 standing … 1 in full stride; 0 walk … 1 run. */
  amp: number;
  run: number;
  /** Yaw of the hips relative to the body, toward the direction of travel. */
  face: number;
  /** Direction of travel in the frame of the hips. */
  dirx: number;
  dirz: number;
  /** Cycles per second, share of a cycle each foot spends on the floor, distance the body travels over a planted foot. */
  freq: number;
  duty: number;
  stride: number;
  lift: number;
  /** A planted foot has been left too far behind: the next step comes sooner. */
  hurry: number;
  /** The body's speed as last given (unsmoothed), and how much further it will travel if it keeps slowing down as it is now. */
  raw: number;
  coast: number;
  /** The body is in the middle of turning back the way it came. */
  about: boolean;
  /** How far the arms have joined in with the stride (they take a moment longer than the legs). */
  arms: number;
  /** Scratch values shared between the body and the feet for the current frame. */
  homeX: number;
  homeZ: number;
  left: Step;
  right: Step;
  /** The feet have not been placed yet (first frame on its feet, or back from a chair). */
  fresh: boolean;
  /** Last world transform seen and how long the frame before this one took, for characters whose motion is measured rather than given. */
  px: number;
  pz: number;
  yaw: number;
  pdt: number;
  has: boolean;
  /** Seconds since this body's jump began (below 0: it is not jumping). Written by whoever draws the body, every frame. */
  air: number;
  /** In a leap, the leg that leads: the one that was in front when the feet left the floor (+1 left, −1 right). */
  lead: number;
}

export const newLoco = (): Loco => ({
  phase: 0.6, active: false, go: false, mvx: 0, mvz: 0, mturn: 0, dt: 0, vx: 0, vz: 0, sx: 0, sz: 0, turn: 0, speed: 0, amp: 0, run: 0, face: 0, dirx: 0, dirz: 1,
  freq: 1, duty: 0.6, stride: 0, lift: 0, hurry: 0, raw: 0, coast: 9, about: false, arms: 0, homeX: STANCE_X, homeZ: 0, left: newStep(1), right: newStep(-1), fresh: true, px: 0, pz: 0, yaw: 0, pdt: 0, has: false, air: -1, lead: 1,
});

/**
 * Advance the gait by `dt` given the body's real motion (as velocities). `run` says the body is setting off at a running pace, so its
 * very first step is a running one (without it the gait breaks into a run by itself once the legs cannot walk the speed).
 *
 * The stride is chosen for the speed and the direction — how far the body travels over a planted foot, and what share
 * of the time a foot is planted — and the cadence follows from the two, so a foot is on the floor exactly as long as
 * the floor needs it. Walking, that is a long time on the floor and both feet down between steps; running, a short push
 * and both feet in the air between steps.
 */
export function stepLoco(L: Loco, dt: number, vx: number, vz: number, turn: number, run: boolean | null, took = dt): void {
  // (A measured motion may have happened over the frame before this one, which took `took`: the floor moves by exactly that much.)
  const k = dt > 1e-6 ? took / dt : 1;
  L.mvx = vx * k;
  L.mvz = vz * k;
  L.mturn = turn * k;
  L.dt = dt;
  const kv = 1 - Math.exp(-dt / 0.06);
  L.vx += (vx - L.vx) * kv;
  L.vz += (vz - L.vz) * kv;
  L.turn += (turn - L.turn) * (1 - Math.exp(-dt / 0.09));
  const ks = 1 - Math.exp(-dt / 0.3);
  L.sx += (L.vx - L.sx) * ks;
  L.sz += (L.vz - L.sz) * ks;
  const speed = Math.hypot(L.vx, L.vz);
  L.speed = speed;
  const turning = Math.abs(L.turn);
  const want = clamp01(Math.max(speed / 0.8, turning / 1.2));
  L.amp += (want - L.amp) * (1 - Math.exp(-dt / (want > L.amp ? 0.07 : 0.14)));
  if (L.amp < 0.0005) L.amp = 0;
  // Braking: a foot in the air is put down where the body will come to rest, so stopping does not take an extra step.
  const raw = Math.hypot(vx, vz);
  const slowing = dt > 1e-4 ? (L.raw - raw) / dt : 0;
  L.coast = slowing > 3 ? Math.min(9, (0.75 * raw * raw) / slowing) : 9;
  L.raw = raw;
  const went = L.go;
  L.go = raw > 0.12 || turning > 0.25;
  // Setting off — from standing, after a pause, or turning back the way it came, which is not one more step of the old stride.
  const about = raw > 0.3 && speed > 0.3 && vx * L.vx + vz * L.vz < 0;
  const setOff = L.go && (!L.active || !went || (about && !L.about));
  L.about = about;
  if (setOff && run) L.run = 1;

  // Going sideways slowly is a sidestep with the hips square. At a run the hips turn toward where the body is going
  // (the chest and the head do not), so the legs can stride out instead of shuffling.
  let face = 0;
  if (speed > 0.25) {
    const ang = L.vz >= -0.12 * speed ? Math.atan2(L.vx, Math.max(L.vz, 0)) : Math.atan2(-L.vx, -L.vz);
    face = clamp(ang * 0.85, -FACE_MAX, FACE_MAX) * smooth(1.1, 2.2, speed);
  }
  L.face += (face - L.face) * (1 - Math.exp(-dt / 0.12));
  if (speed > 0.05) {
    const cp = Math.cos(L.face);
    const sp = Math.sin(L.face);
    L.dirx = (L.vx * cp - L.vz * sp) / speed;
    L.dirz = (L.vx * sp + L.vz * cp) / speed;
  }

  // Legs reach furthest straight ahead, less far behind and least far across: `eff` is the speed straight ahead that
  // would ask as much of them as this speed does in this direction.
  const bz = L.dirz >= 0 ? L.dirz : L.dirz / 0.78;
  const sd = 1 / Math.sqrt(bz * bz + (L.dirx / 0.6) ** 2);
  const eff = speed / sd;
  const auto = smooth(2.15, 2.85, eff);
  L.run += ((run ? 1 : auto) - L.run) * (1 - Math.exp(-dt / 0.1));

  // Walking: the stride lengthens with the pace, most of the time is spent on the floor.
  const strideW = 0.9 * sd * (1 - Math.exp(-eff / 0.65));
  const dutyW = lerp(0.64, 0.58, clamp01(eff / 2.2));
  // Running: the cadence barely changes with the pace, the push gets longer and the time in the air too.
  // Setting off at a run is quick short steps at that same cadence, not one long slow one.
  const cadence = 1.25 + 0.065 * Math.min(eff, 8.5);
  const dutyR = clamp((cadence * sd * Math.min(0.5 + 0.045 * eff, 0.86)) / Math.max(speed, 0.1), 0.2, 0.45);
  const strideR = (speed * dutyR) / cadence;
  let stride = lerp(strideW, strideR, L.run);
  const duty = lerp(dutyW, dutyR, L.run);
  let f = stride > 0.02 ? (speed * duty) / stride : 0;
  // Legs only go so fast: beyond that the stride has to give.
  const fMax = lerp(1.7, 2.1, L.run);
  if (f > fMax) {
    f = fMax;
    stride = (speed * duty) / f;
  }
  // Turning on the spot: small unhurried steps, each foot staying on the floor through about a radian of the turn.
  if (turning > 0.25) f = Math.max(f, clamp((turning * duty) / 1.1, 1, 1.9) * (1 - clamp01(speed / 1.2)));
  // Standing again with a foot left behind: bring it in at an easy pace.
  if (!L.go) f = Math.max(f, SETTLE_HZ);
  f *= 1 + 1.2 * L.hurry;
  L.freq = f;
  L.duty = duty;
  L.stride = stride;
  // Walking, the foot clears the floor by little; running, the heel comes up behind.
  const back = Math.max(0, -L.dirz);
  L.lift = Math.max(0.025, L.amp * lerp(0.04 + 0.015 * clamp01(eff / 2), 0.05 + 0.028 * Math.min(eff, 8), L.run) * (1 - 0.4 * back) * (1 - 0.3 * Math.abs(L.dirx)));
  if (setOff) {
    // The foot that steps first is already part-way through its swing — further still when setting off at a run — and
    // the other is part-way through its time on the floor. First goes a foot that is in the air anyway, else one that
    // the move would leave far behind, else the one on the side the body is heading to.
    L.active = true;
    const l = L.left;
    const r = L.right;
    let rightFirst: boolean;
    if (l.down !== r.down) rightFirst = l.down;
    else if (!l.down) rightFirst = r.w < l.w;
    else {
      const lead = ((l.x - r.x) * vx + (l.z - r.z) * vz) / (raw || 1);
      rightFirst = Math.abs(lead) > 0.25 ? lead > 0 : Math.abs(vx) > 0.4 * Math.abs(vz) ? vx < 0 : turn < -0.2;
    }
    l.hold = r.hold = false;
    const first = rightFirst ? r : l;
    const begun = first.down ? 0 : Math.min(0.9, first.w0 + first.w * (1 - first.w0));
    L.phase = duty + Math.max(run ? 0.6 : 0.35, begun) * (1 - duty) + (rightFirst ? 0.5 : 0);
    L.phase -= Math.floor(L.phase);
  } else if (L.active) {
    L.phase += f * dt;
    L.phase -= Math.floor(L.phase);
  }
}

interface Foot {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}
const FOOT_L: Foot = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
const FOOT_R: Foot = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };

/** How far the ankle moves (forward, up) when the foot tips by `p` about the heel (p < 0, toes up) or the front of the sole (p > 0, heel up). */
let PIVOT_Z = 0;
let PIVOT_Y = 0;
function pivot(p: number): void {
  const c = Math.cos(p);
  const sn = Math.sin(p);
  if (p > 0) {
    PIVOT_Z = TOE * (1 - c) + ANKLE * sn;
    PIVOT_Y = ANKLE * (c - 1) + TOE * sn;
  } else {
    PIVOT_Z = HEEL * (c - 1) + ANKLE * sn;
    PIVOT_Y = ANKLE * (c - 1) - HEEL * sn;
  }
}

/**
 * Set by `footfall` for the foot it just worked out: how far it is from where it stands when the body is at rest
 * (in units of "near enough"), and how free it is of the floor (0 planted … 1 in mid-swing).
 */
let AWAY = 0;
let FREE = 0;

/**
 * Where one ankle is right now, in the body's frame. A planted foot stays exactly where it was put down — the floor
 * carries it back under the body as the body moves and turns — and rolls from heel to toe; a foot in the air swings
 * to where the next step should land for the way the body is moving now, arriving already moving with the floor.
 * Starting, stopping, turning on the spot and changing direction are therefore all just steps.
 */
function footfall(L: Loco, s: Step, side: 1 | -1, f: Foot): void {
  const d = L.duty;
  let ph = L.phase + (side > 0 ? 0 : 0.5);
  ph -= Math.floor(ph);
  const stride = L.stride;
  const run = L.run;
  const fwd = Math.max(0, L.dirz);
  const back = Math.max(0, -L.dirz);
  const across = Math.abs(L.dirx);
  // Where this foot belongs under the hips. When the stride runs across the hips the two tracks are kept apart fore and aft, so the legs pass each other.
  const gap = 0.085 * (1 - Math.abs(L.dirz)) * clamp01(stride / 0.3) * side * (L.dirz >= 0 ? 1 : -1);
  const cf = Math.cos(L.face);
  const sf = Math.sin(L.face);
  const hx0 = side * L.homeX + gap * L.dirz;
  const hz0 = L.homeZ - gap * L.dirx;
  const hx = hx0 * cf + hz0 * sf;
  const hz = -hx0 * sf + hz0 * cf;
  // Where the next step lands: ahead of home along the way the body is going, and turned ahead of a turning body.
  // A runner's foot comes down closer under the body than a walker's.
  const off = Math.max(back, across);
  const land = Math.min(stride * lerp(lerp(LAND, 0.5, off), lerp(0.3, 0.46, off), run), L.coast);
  const ax = hx0 + L.dirx * land;
  const az = hz0 + L.dirz * land;
  const psi = L.go ? clamp((L.turn * LAND * d) / Math.max(L.freq, 0.6), -0.5, 0.5) : 0;
  const ca = Math.cos(L.face + psi);
  const sa = Math.sin(L.face + psi);
  const tx = ax * ca + az * sa;
  const tz = -ax * sa + az * ca;
  const tyaw = L.face + psi;

  if (s.down) {
    // The floor under a planted foot: it turns and slides exactly against the body's own motion.
    const a = -L.mturn * L.dt;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const x = s.x * c + s.z * sn;
    s.z = -s.x * sn + s.z * c - L.mvz * L.dt;
    s.x = x - L.mvx * L.dt;
    s.yaw += a;
    // A leg is only so long, and an ankle only turns so far: past that the foot gives (it pivots or drags) rather than the leg.
    s.yaw = clamp(s.yaw, L.face - 0.8, L.face + 0.8);
    const far = Math.hypot(s.x - hx, s.z - hz);
    if (far > 0.7) {
      s.x = hx + ((s.x - hx) * 0.7) / far;
      s.z = hz + ((s.z - hz) * 0.7) / far;
    }
  }
  // (Half a frame early rather than half a frame late.)
  const swinging = ph + 0.5 * L.freq * L.dt >= d;
  if (!swinging) s.hold = false;
  else if (s.down && !s.hold) {
    // Its turn to step — unless the body is standing and the foot already is where it belongs.
    if (!L.go && Math.hypot(s.x - hx, s.z - hz) < HOME_NEAR && Math.abs(s.yaw - L.face) < HOME_YAW) s.hold = true;
    else {
      s.down = false;
      s.sx = s.x;
      s.sz = s.z;
      s.syaw = s.yaw;
      s.w0 = clamp((ph - d) / (1 - d), 0, 0.7);
      s.w = 0;
    }
  }
  if (!s.down) {
    // A step keeps its own time once it has begun, so a change of gait in the middle of it never moves the foot at once;
    // it is only kept from drifting away from the stride clock, and brought down smartly when its time is up.
    const span = Math.max(0.05, (1 - d) * (1 - s.w0));
    // (A body that is stopping does not leave a foot hanging in the air.)
    let w = s.w + Math.max(((L.freq * L.dt) / span) * (swinging ? 1 : 2.5), L.coast < 0.5 || !L.go ? L.dt / 0.2 : 0);
    if (swinging) w += Math.max(0, ((ph - d) / (1 - d) - s.w0) / (1 - s.w0) - w) * Math.min(1, L.dt * 10);
    if (w >= 1) {
      // It touched down part-way through this frame, and the floor has carried it since.
      const since = (L.dt * (w - 1)) / Math.max(1e-6, w - s.w);
      s.down = true;
      s.hold = swinging;
      s.u = 0;
      s.x = tx - L.mvx * since;
      s.z = tz - L.mvz * since;
      s.yaw = tyaw;
    }
    s.w = w;
  }

  const roll = clamp01(stride / 0.45) * L.amp;
  // Walking forward the heel comes down first; running, the foot lands almost flat; going backward, the toes.
  const pStrike = roll * (-0.34 * fwd * (1 - 0.75 * run) + 0.3 * back);
  /** How far the foot trails behind where it belongs, along the way it points: that, not the clock, lifts the heel. */
  const trail = (hx - s.x) * Math.sin(s.yaw) + (hz - s.z) * Math.cos(s.yaw);
  const heelFrom = lerp(0.16, 0.08, run);
  const heelMax = (1 + 0.15 * run) * (1 - 0.6 * back);
  const pOff = clamp01((trail - heelFrom) / 0.36) * heelMax;
  if (s.down) {
    // Heel first, flat, then up onto the front of the foot as the body leaves it behind.
    s.u += (Math.max(L.freq, 0.5) * L.dt) / Math.max(d, 0.15);
    const pitch = pOff * pOff * (3 - 2 * pOff) * 1.05 + (s.u < 0.24 ? pStrike * (1 - smooth(0, 0.24, s.u)) : 0);
    pivot(pitch);
    f.x = s.x + Math.sin(s.yaw) * PIVOT_Z;
    f.z = s.z + Math.cos(s.yaw) * PIVOT_Z;
    f.y = ANKLE + PIVOT_Y;
    f.yaw = s.yaw;
    f.pitch = pitch;
    FREE = 0;
    AWAY = Math.max(Math.hypot(s.x - hx, s.z - hz) / HOME_NEAR, Math.abs(s.yaw - L.face) / HOME_YAW);
    // Left behind further than a stride should leave it: the cadence picks up until it has been brought forward.
    const lim = 0.7 * Math.max(stride, 0.3) + 0.08;
    L.hurry = Math.max(L.hurry, clamp01((Math.hypot(s.x - hx, s.z - hz) - lim) / 0.12));
    return;
  }
  const w = s.w;
  // Leaving the floor and arriving on it at the speed of the floor (in the body's frame the floor moves backward, and turns against the body).
  const dur = Math.min(0.45, ((1 - d) * (1 - s.w0)) / Math.max(L.freq, 0.3));
  const k0 = -lerp(0.55, 0.2, run) * dur;
  const k1 = -lerp(0.9, 0.75, run) * dur;
  const w2 = w * w;
  const w3 = w2 * w;
  const h0 = 2 * w3 - 3 * w2 + 1;
  const g0 = w3 - 2 * w2 + w;
  const g1 = w3 - w2;
  const h1 = -2 * w3 + 3 * w2;
  const e = w2 * (3 - 2 * w);
  s.x = h0 * s.sx + g0 * k0 * (L.vx + L.turn * s.sz) + h1 * tx + g1 * k1 * (L.vx + L.turn * tz);
  s.z = h0 * s.sz + g0 * k0 * (L.vz - L.turn * s.sx) + h1 * tz + g1 * k1 * (L.vz - L.turn * tx);
  s.yaw = lerp(s.syaw, tyaw, e);
  const pLift = clamp01(((hx - s.sx) * Math.sin(s.syaw) + (hz - s.sz) * Math.cos(s.syaw) - heelFrom) / 0.36) * heelMax;
  const pStart = pLift * pLift * (3 - 2 * pLift) * 1.05;
  // In the air the toes hang down behind the knee (a runner's sole faces backward as the heel comes up), then lift for the landing.
  const pMid = roll * (0.3 + 0.95 * run) * fwd;
  const pitch = lerp(lerp(pStart, pMid, smooth(0, 0.4, w)), pStrike, smooth(0.5, 0.95, w));
  // However the foot is tipped in the air, it is its lowest point that clears the floor (or a first, low step would drag its toes).
  pivot(pitch);
  const low = PIVOT_Y;
  pivot(pStart);
  const z0 = PIVOT_Z;
  pivot(pStrike);
  const dz = lerp(z0, PIVOT_Z, e);
  f.x = s.x + Math.sin(s.yaw) * dz;
  f.z = s.z + Math.cos(s.yaw) * dz;
  // Walking, the foot skims the floor; running, the heel kicks up behind and the knee carries it through.
  // A runner's foot stays off the floor until it is back under the knee, and only then comes down.
  const up = Math.max(Math.sin(Math.PI * Math.pow(w, lerp(0.78, 0.68, run))), 0.42 * run * smooth(0.3, 0.6, w) * (1 - smooth(0.84, 1, w)));
  f.y = ANKLE + low + L.lift * Math.pow(up, 1.15);
  f.yaw = s.yaw;
  f.pitch = pitch;
  FREE = up;
  AWAY = 9;
}

/** Two-bone leg: hip angles and knee bend that put the ankle at (tx, ty, tz) from the hip joint, with the foot turned by `yaw` and pitched by `pitch`. */
function legIK(o: Pose, left: boolean, tx: number, ty: number, tz: number, yaw: number, pitch: number): void {
  let d2 = tx * tx + ty * ty + tz * tz;
  const max = THIGH + SHIN - 0.0006;
  if (d2 > max * max) {
    const k = max / Math.sqrt(d2);
    tx *= k;
    ty *= k;
    tz *= k;
    d2 = max * max;
  } else if (d2 < 0.09) {
    const k = 0.3 / Math.sqrt(Math.max(d2, 1e-6));
    tx *= k;
    ty *= k;
    tz *= k;
    d2 = 0.09;
  }
  const knee = Math.acos(clamp((d2 - THIGH * THIGH - SHIN * SHIN) / (2 * THIGH * SHIN), -1, 1));
  // The ankle in the thigh's frame before the hip turns: straight down, the shin folded back by the knee, swung round by the foot's yaw.
  const ay = -THIGH - SHIN * Math.cos(knee);
  const back = -SHIN * Math.sin(knee);
  const ax = back * Math.sin(yaw);
  const az = back * Math.cos(yaw);
  const yp = -Math.sqrt(Math.max(1e-8, ay * ay + az * az - tz * tz));
  const flex = wrapPi(Math.atan2(tz, yp) - Math.atan2(az, ay));
  const abd = wrapPi(Math.atan2(ty, tx) - Math.atan2(yp, ax));
  if (left) {
    o.hL = flex;
    o.aL = abd;
    o.yL = yaw;
    o.kL = knee;
    o.fL = pitch - flex - knee;
  } else {
    o.hR = flex;
    o.aR = abd;
    o.yR = yaw;
    o.kR = knee;
    o.fR = pitch - flex - knee;
  }
}

/** The whole body of someone on their feet: standing (breathing, shifting weight, looking around) blending into walking and running. */
export function upright(o: Pose, t: number, ph: number, L: Loco): void {
  const s = Math.sin;
  o.wrL = o.wfL = o.wrR = o.wfR = 0;
  const amp = L.amp;
  const rest = 1 - amp;
  const run = L.run;
  const d = L.duty;
  const a = L.phase * TAU;
  /** Share of the travel that is forward (+) or backward (−) for the hips, and the same without its sign. */
  const fw = L.dirz;
  const along = Math.abs(fw);
  const sgn = fw >= 0 ? 1 : -1;
  const back = Math.max(0, -fw);
  const across = Math.abs(L.dirx);
  /** How much of a full stride the legs are taking: all of it walking (`stroll`), or all of it running (`carry`). */
  const gait = amp * clamp01(L.stride / 0.68);
  const carry = run * gait;
  const stroll = gait - carry;
  /** 0 at a jog … 1 at a sprint. */
  const sprint = clamp01((L.speed - 3.6) / 3.6);
  /** +1 in the middle of the left foot's time on the floor, −1 in the middle of the right's. */
  const mid = Math.cos(a - d * Math.PI);
  const breath = s(t * 1.3 + ph * 1.9);
  // Standing: the weight settles on one leg for a while, then moves over to the other.
  const lazy = s(t * 0.37 + ph);
  const shift = rest * (lazy * (1.5 - 0.5 * lazy * lazy) * 0.022 + s(t * 0.83 + ph * 2.1) * 0.004);

  // Hips: the side of the leading leg swings forward, the weight rides over the planted foot, the free side drops a little.
  const osc = -(0.1 * stroll + 0.13 * carry) * fw * Math.cos(a - 0.15);
  L.homeX = lerp(STANCE_X, lerp(TRACK_WALK, TRACK_RUN, run), gait * along) + 0.03 * stroll * across;
  L.homeZ = -0.02 * carry * fw;
  o.hipX = shift + (0.02 * stroll + 0.008 * carry) * mid;
  o.hipZ = 0;
  o.pelYaw = L.face + osc;
  o.pelRoll = (0.045 * stroll + 0.05 * carry) * mid - shift * 1.4;

  // Spine: nearly upright at a walk, forward at a run; it leans into every change of speed, counters the hips, banks
  // into turns, and gives a little as each running foot takes the weight.
  const push = L.vz - L.sz;
  o.lean =
    Math.max(0, fw) * (0.055 * stroll + lerp(0.2, 0.27, sprint) * carry) +
    0.07 * back * gait +
    clamp(push * 0.03, -0.07, 0.09) +
    0.014 * carry * Math.cos(2 * a - TAU * d - 0.5) +
    rest * (s(t * 0.5 + ph) * 0.012 + breath * 0.004);
  o.twist = L.face * 0.22 - osc * lerp(1.25, 1.45, run) + clamp(L.turn * 0.035, -0.1, 0.1);
  o.side = -o.pelRoll * 0.6 - clamp(L.turn * L.speed * 0.013, -0.15, 0.15) - clamp((L.vx - L.sx) * 0.025, -0.08, 0.08);
  o.shrug = breath * 0.003 * rest - 0.006 * carry * Math.cos(2 * a - TAU * d - 0.9);

  // Head: level and facing where the body goes while the body works underneath it, looking into a turn, glancing around when idle.
  o.headYaw = -o.twist * 0.9 + L.face * 0.3 + clamp(L.turn * 0.1, -0.32, 0.32) + rest * (s(t * 0.29 + ph) * 0.16 + s(t * 0.71 + ph * 1.7) * 0.06);
  o.headPitch = -o.lean * 0.75 + rest * s(t * 0.43 + ph * 1.3) * 0.02;
  o.headRoll = -o.side * 0.7;

  // Arms, opposite to the legs. Walking they hang loose, the forearm trailing the upper arm and folding as the hand
  // comes forward. Running they are carried bent and pump: the elbow drives back, the hand comes up in front.
  L.arms += (gait - L.arms) * (1 - Math.exp(-L.dt / 0.2));
  const armsR = run * L.arms;
  const armsW = L.arms - armsR;
  const sw = Math.cos(a - 0.3) * sgn;
  const fore = Math.cos(a - 0.9) * sgn;
  const swingW = 0.44 * armsW * along * (fw >= 0 ? 1 : 0.6);
  const swingR = lerp(0.5, 0.75, sprint) * armsR * along * (fw >= 0 ? 1 : 0.45);
  const swing = swingW + swingR;
  const wide = 0.085 + 0.045 * armsR + 0.06 * L.arms * across;
  const idle = rest * 0.03;
  o.sLx = sw * swing + 0.2 * armsR * (1 - back) - 0.04 * armsW - 0.03 + idle * s(t * 0.6 + ph);
  o.sRx = -sw * swing + 0.2 * armsR * (1 - back) - 0.04 * armsW - 0.03 + idle * s(t * 0.6 + ph + 1.3);
  o.sLz = wide;
  o.sRz = -wide;
  o.tL = 0.22 * armsR;
  o.tR = 0.22 * armsR;
  const hang = 0.2 + 0.16 * armsW;
  const held = lerp(1.5, 1.6, sprint) * (1 - 0.45 * back);
  o.eL = -lerp(hang + swingW * 1.3 * Math.max(0, -fore), held - 0.3 * sw, armsR);
  o.eR = -lerp(hang + swingW * 1.3 * Math.max(0, fore), held + 0.3 * sw, armsR);

  // Feet on the floor, then the hips as high as the planted legs allow, then the legs to fit.
  if (L.fresh) {
    L.fresh = false;
    L.active = false;
    L.left = newStep(1);
    L.right = newStep(-1);
  }
  L.hurry = 0;
  footfall(L, L.left, 1, FOOT_L);
  const awayL = AWAY;
  const freeL = FREE;
  footfall(L, L.right, -1, FOOT_R);
  const awayR = AWAY;
  const freeR = FREE;
  if (!L.go) {
    // Standing: the stride clock stops once both feet are back under the body, and starts again if one is left out of place.
    if (L.active) {
      if (awayL < 1 && awayR < 1) L.active = false;
      else if (L.left.down && L.right.down) {
        // A foot left out of place does not wait for its turn in the stride: once the other has taken the weight, it steps in.
        const lead = awayL >= awayR ? L.left : L.right;
        const other = awayL >= awayR ? L.right : L.left;
        let turnOf = L.phase + (awayL >= awayR ? 0 : 0.5);
        turnOf -= Math.floor(turnOf);
        if (Math.max(awayL, awayR) > 1.6 && other.u > 0.12 && (turnOf < d || lead.hold)) {
          lead.hold = false;
          other.hold = true;
          L.phase = d + (awayL >= awayR ? 0.001 : 0.501);
          L.phase -= Math.floor(L.phase);
        }
      }
    } else if (awayL > 1.6 || awayR > 1.6) {
      L.active = true;
      L.phase = d + (awayL >= awayR ? 0.001 : 0.501);
      L.phase -= Math.floor(L.phase);
    }
  }
  // A jump: the feet go up on their toes for the push, hang and tuck in the air, and reach for the floor again.
  const jumping = L.air >= 0 && L.air < JUMP_SECONDS;
  const fly = jumping ? jumpFeet(L, FOOT_L, FOOT_R) : 0;
  // The legs hang from the hips, which sway and turn over feet that stay where they are.
  const cy = Math.cos(o.pelYaw);
  const sy = Math.sin(o.pelYaw);
  const lx0 = FOOT_L.x - o.hipX;
  const rx0 = FOOT_R.x - o.hipX;
  const lx = lx0 * cy - FOOT_L.z * sy - HIP_X;
  const lz = lx0 * sy + FOOT_L.z * cy;
  const rx = rx0 * cy - FOOT_R.z * sy + HIP_X;
  const rz = rx0 * sy + FOOT_R.z * cy;
  // Walking, the hips are lowest just after a foot takes the weight and highest as the other leg passes it. Running,
  // the body sinks onto the planted leg and rises while both feet are in the air.
  const top = STAND_Y + 0.004 - stroll * (0.028 + 0.02 * Math.cos(2 * a - 0.75)) - carry * (lerp(0.058, 0.064, sprint) + 0.032 * Math.cos(2 * a - TAU * d));
  // Only a foot on the floor holds the hips down (a leg in the air folds as it must), and never by more than a few centimetres:
  // a foot left too far behind comes off the floor rather than dragging the body down.
  const give = lerp(0.056, 0.03, run);
  const hl = Math.max(top - give, FOOT_L.y + Math.sqrt(Math.max(0.01, REACH * REACH - lx * lx - lz * lz)) + freeL * 0.4);
  const hr = Math.max(top - give, FOOT_R.y + Math.sqrt(Math.max(0.01, REACH * REACH - rx * rx - rz * rz)) + freeR * 0.4);
  const lo = Math.min(top, hl, hr);
  // In stride the handover from one leg to the other is rounded off; standing still, the legs are simply straight.
  const K = 0.011 * gait;
  o.hipY = K < 1e-4 ? lo : lo - K * Math.log(Math.exp(-(top - lo) / K) + Math.exp(-(hl - lo) / K) + Math.exp(-(hr - lo) / K));
  if (jumping) {
    // In the air the hips are carried by the jump, not by the legs; on the floor they sink for the push and give for the landing.
    // (A body that is going somewhere lands lighter: it runs on out of the landing rather than stopping in it.)
    const light = lerp(1, 1 - 0.5 * clamp01(L.speed / 3), smooth(JUMP_TOUCH - 0.1, JUMP_TOUCH, L.air));
    o.hipY = lerp(o.hipY, STAND_Y, fly) + jumpSink(L.air) * light;
    jumpBody(o, L.air, light);
  }
  legIK(o, true, lx, FOOT_L.y - o.hipY, lz, FOOT_L.yaw - o.pelYaw, FOOT_L.pitch);
  legIK(o, false, rx, FOOT_R.y - o.hipY, rz, FOOT_R.yaw - o.pelYaw, FOOT_R.pitch);
}

// ───────────────────────────── the jump ─────────────────────────────

/**
 * A jump, from the key to standing again: the body sinks and pushes off (the feet still on the floor), is in the air,
 * and gives at the knees as it lands. Whoever draws the body lifts it by `jumpY`; everything else — the crouch, the
 * arms, the legs in the air, the landing — is the pose, worked out here from the time since the jump began.
 */
export const JUMP_HEIGHT = 0.62;
/** Sinking, then pushing off: the feet leave the floor at their sum. */
const JUMP_DOWN = 0.065;
const JUMP_PUSH = 0.085;
export const JUMP_OFF = JUMP_DOWN + JUMP_PUSH;
export const JUMP_AIR = 0.5;
/** The feet are on the floor again. */
export const JUMP_TOUCH = JUMP_OFF + JUMP_AIR;
const JUMP_LAND = 0.36;
export const JUMP_SECONDS = JUMP_TOUCH + JUMP_LAND;
/** How far the hips sink before the push, and how far above standing the stretched body carries them (it is on its toes). */
const JUMP_DIP = 0.12;
const JUMP_RISE = 0.06;
/** …and coming down, less: the knees are a little bent before the floor comes, ready to give. */
const JUMP_REACH = 0.03;
/** How fast the body comes down onto its feet (m/s), and the share of that the knees take (the ankles take the rest). */
const JUMP_FALL = (4 * JUMP_HEIGHT) / JUMP_AIR;
const JUMP_GIVE = 0.8;
/** The toes point down by this much (rad) as the feet leave the floor, and by this much as they come back to it. */
const TOES_OFF = 0.75;
const TOES_DOWN = 0.42;

/** How high the soles are off the floor, `t` seconds after the jump began (0 before the feet leave it and once they are back). */
export function jumpY(t: number): number {
  if (t <= JUMP_OFF || t >= JUMP_TOUCH) return 0;
  const v = (t - JUMP_OFF) / JUMP_AIR;
  return JUMP_HEIGHT * 4 * v * (1 - v);
}

/**
 * How far the hips are from where they stand (m; below 0 is lower), not counting the lift: down for the push, up on
 * the toes as the feet leave, and down again as the knees take the landing — at first as fast as the body fell.
 */
export function jumpSink(t: number): number {
  if (t <= 0 || t >= JUMP_SECONDS) return 0;
  if (t < JUMP_DOWN) return -JUMP_DIP * smooth(0, JUMP_DOWN, t);
  if (t < JUMP_OFF) {
    const u = (t - JUMP_DOWN) / JUMP_PUSH;
    return -JUMP_DIP + (JUMP_DIP + JUMP_RISE) * u * u;
  }
  if (t < JUMP_TOUCH) return lerp(JUMP_RISE, JUMP_REACH, smooth(JUMP_OFF, JUMP_OFF + 0.6 * JUMP_AIR, t));
  const l = t - JUMP_TOUCH;
  const u = 1 - l / JUMP_LAND;
  return JUMP_REACH * (1 - smooth(0, 0.09, l)) - JUMP_GIVE * JUMP_FALL * l * u * u;
}

/** How far the toes point down (rad): up onto them for the push, loosely in the air, flat again a moment after landing. */
function jumpToes(t: number): number {
  if (t <= JUMP_DOWN) return 0;
  if (t < JUMP_OFF) {
    const u = (t - JUMP_DOWN) / JUMP_PUSH;
    return TOES_OFF * u * u;
  }
  if (t < JUMP_TOUCH) return lerp(TOES_OFF, TOES_DOWN, smooth(JUMP_OFF, JUMP_OFF + 0.6 * JUMP_AIR, t));
  return TOES_DOWN * (1 - smooth(0, 0.09, t - JUMP_TOUCH));
}

/** A smooth curve through the keys `[time, value, time, value, …]` (times rising); level before the first and after the last. */
function through(keys: readonly number[], t: number): number {
  const last = keys.length - 2;
  if (t <= keys[0]!) return keys[1]!;
  if (t >= keys[last]!) return keys[last + 1]!;
  let i = 0;
  while (keys[i + 2]! < t) i += 2;
  const t0 = keys[i]!;
  const v0 = keys[i + 1]!;
  const t1 = keys[i + 2]!;
  const v1 = keys[i + 3]!;
  const h = t1 - t0;
  // The slope at a key is that of the line between its neighbours; the ends are level.
  const m0 = i > 0 ? ((v1 - keys[i - 1]!) / (t1 - keys[i - 2]!)) * h : 0;
  const m1 = i + 2 < last ? ((keys[i + 5]! - v0) / (keys[i + 4]! - t0)) * h : 0;
  const u = (t - t0) / h;
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * v0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * v1 + (u3 - u2) * m1;
}

const APEX = JUMP_OFF + JUMP_AIR / 2;
const END = JUMP_SECONDS;
/** The arms: swung back as the body sinks, thrown forward and up with the push, out to the sides coming down, forward as the knees give. */
const ARM_SWING = [0, 0, 0.08, 0.6, JUMP_OFF, -0.45, JUMP_OFF + 0.16, -2.15, APEX + 0.05, -1.95, JUMP_TOUCH - 0.06, -0.62, JUMP_TOUCH + 0.1, -0.4, END, -0.03];
const ARM_WIDE = [0, 0.085, 0.085, 0.16, JUMP_OFF + 0.14, 0.3, JUMP_TOUCH - 0.1, 0.85, JUMP_TOUCH + 0.1, 0.5, END, 0.085];
const ARM_BEND = [0, -0.2, 0.085, -0.55, JUMP_OFF, -1.0, JUMP_OFF + 0.14, -0.35, APEX + 0.04, -0.5, JUMP_TOUCH - 0.04, -0.95, JUMP_TOUCH + 0.1, -1.1, END, -0.2];
/** The trunk: folded over the knees for the push, stretched (a little past upright) leaving the floor, and folded again over the landing. */
const TRUNK = [0, 0, 0.085, 0.36, JUMP_OFF, 0.1, JUMP_OFF + 0.09, -0.1, APEX + 0.05, 0.03, JUMP_TOUCH - 0.03, 0.17, JUMP_TOUCH + 0.11, 0.42, END, 0];
const SHRUG = [0, 0, JUMP_OFF, 0.01, JUMP_OFF + 0.12, 0.03, JUMP_TOUCH, 0.012, JUMP_TOUCH + 0.1, -0.008, END, 0];

/**
 * The trunk, the head and the arms of a jump, over the body as the gait left it. It grows out of however the body
 * stood (or ran) in the first moments and settles back into it over the last, so nothing is ever put anywhere at once.
 * `light`: how much of the fold over the landing is left (1: all of it; a runner's is less).
 */
function jumpBody(o: Pose, tau: number, light = 1): void {
  const w = smooth(0, 0.1, tau) * (1 - smooth(END - 0.2, END, tau));
  if (w <= 0) return;
  const fold = through(TRUNK, tau) * light;
  o.lean += fold * w;
  // The eyes stay on where the body is going: the head gives back most of what the trunk folds, and lifts with the push.
  o.headPitch += (-0.6 * fold - 0.1 * smooth(JUMP_DOWN, JUMP_OFF, tau) * (1 - smooth(APEX, JUMP_TOUCH, tau))) * w;
  o.shrug += through(SHRUG, tau) * w;
  const swing = through(ARM_SWING, tau);
  const wide = through(ARM_WIDE, tau);
  const bend = through(ARM_BEND, tau);
  o.sLx = lerp(o.sLx, swing, w);
  o.sRx = lerp(o.sRx, swing, w);
  o.sLz = lerp(o.sLz, wide, w);
  o.sRz = lerp(o.sRz, -wide, w);
  o.tL = lerp(o.tL, 0.1, w);
  o.tR = lerp(o.tR, 0.1, w);
  o.eL = lerp(o.eL, bend, w);
  o.eR = lerp(o.eR, bend, w);
}

/**
 * The feet of a jump, changed in place from where the gait has them; returns how far (0…1) they are the air's rather
 * than the floor's. On the floor they only go up on their toes. In the air they hang under the hips with the knees
 * drawn up — and, for a body that is going somewhere, stride out into a leap, the leg that was in front leading.
 */
function jumpFeet(L: Loco, l: Foot, r: Foot): number {
  const tau = L.air;
  const toes = jumpToes(tau);
  // Until the feet leave the floor, the one in front is the one that will lead.
  if (tau < JUMP_OFF) L.lead = l.z >= r.z ? 1 : -1;
  const fly = smooth(JUMP_OFF, JUMP_OFF + 0.1, tau) * (1 - smooth(JUMP_TOUCH - 0.2, JUMP_TOUCH - 0.01, tau));
  const v = clamp01((tau - JUMP_OFF) / JUMP_AIR);
  const tuck = Math.pow(Math.sin(Math.PI * v), 1.5);
  const leap = clamp01(L.speed / 3) * L.dirz;
  pivot(toes);
  const tipY = PIVOT_Y;
  const tipZ = PIVOT_Z;
  for (const side of [1, -1] as const) {
    const f = side > 0 ? l : r;
    if (toes > f.pitch) {
      // Up on the toes, which stay where they are: the ankle goes up and a little forward over them.
      pivot(Math.max(0, f.pitch));
      f.x += Math.sin(f.yaw) * (tipZ - PIVOT_Z);
      f.z += Math.cos(f.yaw) * (tipZ - PIVOT_Z);
      f.y = Math.max(f.y, ANKLE + tipY);
      f.pitch = toes;
    }
    if (fly <= 0) continue;
    const leads = side === L.lead;
    // Standing: both knees drawn up, the heels a little behind. Going somewhere: one leg reaches ahead, the other trails with its heel up.
    const ax = side * STANCE_X * 0.95;
    const az = tuck * (-0.05 * (1 - Math.abs(leap)) + leap * (leads ? 0.3 : -0.34));
    const ay = ANKLE + tipY + tuck * (0.17 * (1 - Math.abs(leap)) + Math.abs(leap) * (leads ? 0.12 : 0.24));
    const cf = Math.cos(L.face);
    const sf = Math.sin(L.face);
    f.x = lerp(f.x, ax * cf + az * sf, fly);
    f.z = lerp(f.z, -ax * sf + az * cf, fly);
    f.y = lerp(f.y, ay, fly);
    f.yaw = lerp(f.yaw, L.face, fly);
    f.pitch = lerp(f.pitch, toes + tuck * Math.abs(leap) * (leads ? -0.5 : 0.45), fly);
  }
  return fly;
}

/**
 * Dozing on one's feet, layered over the standing body: chin on the chest, arms slack, a slow sway — and every few
 * seconds the head sinks until it jerks back up.
 */
export function doze(o: Pose, t: number, ph: number): void {
  const u = (t * 0.14 + ph * 0.37) % 1;
  const nod = smooth(0, 0.78, u) * (1 - smooth(0.8, 0.86, u));
  const breath = Math.sin(t * SLEEP_BREATH + ph * 1.9);
  const sway = Math.sin(t * 0.42 + ph);
  o.lean = 0.07 + 0.07 * nod - breath * 0.008;
  o.side = sway * 0.03;
  o.twist = 0;
  o.shrug = -0.006 + breath * 0.005;
  o.headPitch = 0.5 + 0.3 * nod;
  o.headYaw = 0.1 * Math.sin(t * 0.19 + ph * 2.3);
  o.headRoll = 0.14 * Math.sin(ph * 5.1) + sway * 0.04;
  o.sLx = 0.02 + 0.03 * nod;
  o.sRx = 0.02 + 0.03 * nod;
  o.sLz = 0.07;
  o.sRz = -0.07;
  o.eL = -0.16;
  o.eR = -0.16;
}

// ───────────────────────────── one-shot reactions ─────────────────────────────

/** A struck spring: 0 at rest, 1 at its first peak (~75 ms), then a few quick, shrinking swings. */
const jolt = (tau: number, rate: number, decay: number) => (tau <= 0 ? 0 : (Math.exp(-decay * tau) * Math.sin(rate * tau)) / 0.66);

/** Hit reaction, added on top of the pose the character was in: a sharp flinch, then a springy recovery. */
export function ouch(o: Pose, tau: number): void {
  const j = jolt(tau, 19, 5.5);
  const jh = jolt(tau - 0.03, 17, 5);
  const ja = jolt(tau, 14, 4.6);
  const up = Math.max(0, j) + 0.5 * Math.max(0, ja);
  const hop = tau < 0.24 ? Math.sin((tau / 0.24) * Math.PI) : 0;
  o.hipY += hop * 0.045;
  o.hipZ += j * 0.025;
  o.lean -= j * 0.2;
  o.shrug += up * 0.04;
  o.side += ja * 0.05;
  o.headPitch -= jh * 0.5;
  o.headRoll += ja * 0.08;
  o.sLx -= ja * 0.55;
  o.sRx -= ja * 0.55;
  o.sLz += Math.abs(ja) * 0.6;
  o.sRz -= Math.abs(ja) * 0.6;
  o.eL -= ja * 0.5;
  o.eR -= ja * 0.5;
}

/**
 * A gesture, layered over the standing body: `tau` seconds since it began. It eases in over a fifth of a second and
 * out over the last third, so it grows out of however the person stood and settles back into it. Only the upper
 * body, the head and the sway of the hips are touched: the feet stay where the gait put them.
 */
export function emote(o: Pose, name: EmotePose, tau: number): void {
  const len = EMOTE_SECONDS[name];
  const w = smooth(0, 0.22, tau) * (1 - smooth(len - 0.35, len, tau));
  if (w <= 0) return;
  const s = Math.sin;
  /** Move a joint toward a value by the gesture's weight. */
  const to = (k: keyof Pose, v: number) => {
    o[k] = lerp(o[k], v, w);
  };
  switch (name) {
    case 'wave': {
      // The right arm up beside the head, the forearm swinging from the elbow; a small tilt of the head toward it.
      const wag = s(tau * 9.5);
      to('sRx', -2.55);
      to('sRz', -0.42 + wag * 0.16);
      to('tR', 0);
      to('eR', -0.55 + wag * 0.4);
      o.headRoll += -0.08 * w;
      o.side += -0.04 * w;
      break;
    }
    case 'dance': {
      // Two beats a second: the arms pump in turn, the trunk twists against the hips, the head nods on the beat.
      const b = s(tau * TAU * 1.0);
      const b2 = s(tau * TAU * 2.0);
      to('sLx', -1.15 + b * 0.55);
      to('sLz', 0.3);
      to('tL', 0.35);
      to('eL', -1.5 + b * 0.25);
      to('sRx', -1.15 - b * 0.55);
      to('sRz', -0.3);
      to('tR', 0.35);
      to('eR', -1.5 - b * 0.25);
      o.twist += b * 0.34 * w;
      o.pelYaw += -b * 0.16 * w;
      o.side += b * 0.09 * w;
      o.pelRoll += -b * 0.07 * w;
      o.hipX += b * 0.025 * w;
      o.shrug += Math.abs(b2) * 0.012 * w;
      o.headPitch += (0.05 + b2 * 0.07) * w;
      o.headYaw += -b * 0.2 * w;
      break;
    }
    case 'clap': {
      // Both forearms in front of the chest, the hands meeting six times a second.
      const c = 0.5 + 0.5 * s(tau * TAU * 3.2);
      to('sLx', -1.05);
      to('sLz', -0.02 - c * 0.2);
      to('tL', 0.95);
      to('eL', -1.45);
      to('sRx', -1.05);
      to('sRz', 0.02 + c * 0.2);
      to('tR', 0.95);
      to('eR', -1.45);
      o.headPitch += -0.06 * w;
      o.lean += 0.03 * w;
      break;
    }
    case 'thumbsUp': {
      // The right fist forward at chest height, held; a nod with it.
      const nod = s(Math.min(tau, 1.2) * TAU * 1.2) * (1 - smooth(0.9, 1.3, tau));
      to('sRx', -1.25);
      to('sRz', -0.14);
      to('tR', 0.25);
      to('eR', -0.95);
      o.lean += 0.04 * w;
      o.headPitch += (0.05 + nod * 0.1) * w;
      break;
    }
    case 'shrug': {
      // Shoulders to the ears, forearms out with the palms up, the head to one side.
      const up = smooth(0.1, 0.5, tau) * (1 - smooth(1.2, 1.7, tau));
      o.shrug += 0.055 * up * w;
      to('sLx', -0.35);
      to('sLz', 0.42);
      to('tL', -0.55);
      to('eL', -1.35);
      to('sRx', -0.35);
      to('sRz', -0.42);
      to('tR', -0.55);
      to('eR', -1.35);
      o.headRoll += 0.16 * w;
      o.headPitch += -0.05 * w;
      break;
    }
    case 'point': {
      // The right arm straight out in front, the body turned a little behind it.
      to('sRx', -1.5);
      to('sRz', -0.06);
      to('tR', 0);
      to('eR', -0.06);
      o.twist += 0.14 * w;
      o.lean += 0.05 * w;
      o.headPitch += -0.03 * w;
      break;
    }
    case 'cheer': {
      // Both arms thrown up, pumping.
      const p = Math.abs(s(tau * TAU * 1.8));
      to('sLx', -2.7 - p * 0.18);
      to('sLz', 0.42);
      to('tL', 0);
      to('eL', -0.3 - p * 0.25);
      to('sRx', -2.7 - p * 0.18);
      to('sRz', -0.42);
      to('tR', 0);
      to('eR', -0.3 - p * 0.25);
      o.headPitch += -0.22 * w;
      o.lean += -0.06 * w;
      o.shrug += p * 0.02 * w;
      break;
    }
    case 'bow': {
      // Forward from the hips and up again, arms at the sides.
      const down = smooth(0.15, 0.75, tau) * (1 - smooth(1.35, 2.0, tau));
      o.lean += 0.72 * down * w;
      o.headPitch += 0.28 * down * w;
      o.hipZ += -0.05 * down * w;
      to('sLx', lerp(o.sLx, 0.1, down));
      to('sRx', lerp(o.sRx, 0.1, down));
      break;
    }
  }
}

/**
 * Carrying a box in front, over whatever the legs are doing: both upper arms forward and a little out, the forearms
 * bent up under it, the hands at its sides; the back leaning a little against the weight. `w` 0…1 eases it in and out.
 */
export function carryBox(o: Pose, w: number): void {
  if (w <= 0) return;
  const to = (k: keyof Pose, v: number) => (o[k] += (v - o[k]) * w);
  to('sLx', -0.62);
  to('sLz', -0.2);
  to('tL', 0.55);
  to('eL', -1.2);
  to('sRx', -0.62);
  to('sRz', 0.2);
  to('tR', 0.55);
  to('eR', -1.2);
  to('wrL', 0.5);
  to('wrR', -0.5);
  o.lean += -0.05 * w;
  o.headPitch += 0.04 * w;
}

/**
 * Packing a desk into a box, standing at it: bent over the desk, turning to the things beside the box (to the right),
 * taking one up, turning back and putting it in, again and again — a cycle of `PACK_CYCLE` seconds, over the standing
 * body. `w` 0…1 eases it in and out.
 */
export const PACK_CYCLE = 2.4;
export function packArms(o: Pose, t: number, w: number): void {
  if (w <= 0) return;
  const to = (k: keyof Pose, v: number) => (o[k] += (v - o[k]) * w);
  const c = (t % PACK_CYCLE) / PACK_CYCLE;
  // 0 → 0.45: turned to the things and reaching down for one; 0.45 → 1: back over the box and lowering it in.
  const atThings = c < 0.45 ? Math.sin((c / 0.45) * Math.PI) : 0;
  const atBox = c >= 0.45 ? Math.sin(((c - 0.45) / 0.55) * Math.PI) : 0;
  const reach = Math.max(atThings, atBox);
  o.lean += (0.32 + 0.12 * reach) * w;
  o.twist += -0.42 * atThings * w;
  o.headPitch += (0.25 + 0.1 * reach) * w;
  o.headYaw += -0.35 * atThings * w;
  // Both arms forward and down to the desk; the right one further toward the things, both together over the box.
  to('sLx', -0.55 - 0.45 * reach);
  to('sLz', -0.12 + 0.06 * atThings);
  to('tL', 0.45);
  to('eL', -0.55 - 0.35 * (1 - reach));
  to('sRx', -0.6 - 0.5 * reach);
  to('sRz', 0.12 + 0.12 * atThings);
  to('tR', 0.45);
  to('eR', -0.5 - 0.35 * (1 - reach));
  to('wrL', 0.3);
  to('wrR', -0.3);
}

/** How long one round of making a coffee takes (s): pressing the button, waiting for it to pour, a sip. */
export const COFFEE_CYCLE = 9;
/** Where in the round of making a coffee somebody is (0…1), the same in the figure and the cup in their hand. */
export const coffeeAt = (t: number, ph: number): number => ((t + ph * 3) % COFFEE_CYCLE) / COFFEE_CYCLE;
/** The part of the round in which the cup is up at the mouth. */
export const sipping = (c: number): boolean => c > 0.7 && c < 0.94;

/**
 * Doing something in the break room (`break-room.ts`), over the standing body: at the coffee machine (press the
 * button, wait with the hands on the counter while it pours, a sip); at the sink (both hands at it, washing a cup);
 * at the fridge (one hand holding the door, the other reaching in, looking along the shelves); talking (one hand
 * going with the words, the head too) or listening (a nod now and then). `w` 0…1 eases it in and out.
 */
export function breakArms(o: Pose, t: number, ph: number, act: 'coffee' | 'sink' | 'fridge' | 'chat', speaking: boolean, w: number): void {
  if (w <= 0) return;
  const s = Math.sin;
  const to = (k: keyof Pose, v: number) => (o[k] += (v - o[k]) * w);
  switch (act) {
    case 'coffee': {
      const c = coffeeAt(t, ph);
      if (c < 0.22) {
        // Reaching to the machine: the right hand to its button.
        const r = Math.sin((c / 0.22) * Math.PI);
        to('sRx', -0.55 - 0.5 * r);
        to('sRz', 0.08);
        to('tR', 0.3);
        to('eR', -0.5 - 0.3 * (1 - r));
        to('sLx', -0.05);
        to('eL', -0.25);
        o.headPitch += 0.18 * w;
      } else if (!sipping(c)) {
        // Waiting while it pours: both hands on the edge of the counter, looking at the cup.
        to('sLx', -0.78);
        to('sLz', -0.08);
        to('eL', -0.55);
        to('sRx', -0.78);
        to('sRz', 0.08);
        to('eR', -0.55);
        o.lean += 0.12 * w;
        o.headPitch += (0.28 + s(t * 0.7 + ph) * 0.04) * w;
      } else {
        // A sip: the cup up to the mouth with the right hand, the head back a little.
        to('sRx', -1.05);
        to('sRz', 0.22);
        to('tR', 0.75);
        to('eR', -2.15);
        to('sLx', -0.1);
        to('eL', -0.3);
        o.headPitch += -0.12 * w;
      }
      break;
    }
    case 'sink': {
      // Washing a cup: both hands down in the sink, going round.
      const r = s(t * 4.2 + ph);
      to('sLx', -0.78 + 0.08 * r);
      to('sLz', -0.06);
      to('tL', 0.4);
      to('eL', -0.95 - 0.12 * r);
      to('sRx', -0.78 - 0.08 * r);
      to('sRz', 0.06);
      to('tR', 0.4);
      to('eR', -0.95 + 0.12 * r);
      o.lean += 0.26 * w;
      o.headPitch += 0.38 * w;
      break;
    }
    case 'fridge': {
      // The left hand on the open door, the right reaching in now and then; looking along the shelves.
      const reach = Math.max(0, s(t * 0.9 + ph));
      to('sLx', -0.95);
      to('sLz', -0.42);
      to('tL', 0.2);
      to('eL', -0.35);
      to('sRx', -0.5 - 0.55 * reach);
      to('sRz', 0.12);
      to('eR', -0.75 + 0.35 * reach);
      o.lean += (0.14 + 0.1 * reach) * w;
      o.headPitch += (0.1 + 0.12 * reach) * w;
      o.headYaw += s(t * 0.55 + ph) * 0.3 * w;
      break;
    }
    case 'chat': {
      if (speaking) {
        // The right hand goes with the words, the left a little; the head moves as one talks.
        to('sRx', -0.5 + s(t * 2.3 + ph) * 0.22);
        to('sRz', 0.18);
        to('tR', 0.35);
        to('eR', -1.15 + s(t * 3.1 + ph) * 0.3);
        to('sLx', -0.25 + s(t * 1.7 + ph) * 0.1);
        to('eL', -0.6);
        o.headYaw += s(t * 0.9 + ph) * 0.18 * w;
        o.headPitch += s(t * 2.1 + ph) * 0.05 * w;
      } else {
        // Listening: the arms loose, a hand on the other wrist; a nod now and then.
        to('sLx', -0.3);
        to('sLz', 0.18);
        to('tL', 0.9);
        to('eL', -0.9);
        to('sRx', -0.3);
        to('sRz', -0.18);
        to('tR', 0.9);
        to('eR', -0.9);
        o.headPitch += Math.max(0, s(t * 1.6 + ph)) ** 6 * 0.18 * w;
      }
      break;
    }
  }
}

/** Whip timeline, seconds from the start of the pose: wound up, arm snapped forward, and (a moment later, as the wave reaches the tip) the crack. */
export const WHIP_WIND = 0.15;
export const WHIP_SNAP = 0.25;
export const WHIP_LAG = 0.055;
export const WHIP_CRACK = WHIP_SNAP + WHIP_LAG;
export const WHIP_END = 0.7;

/** Whip crack with the right arm, layered over the current pose: wind up over the shoulder, snap forward, follow through. */
export function whipArm(o: Pose, tau: number): void {
  const w = smooth(0, 0.05, tau) * (1 - smooth(0.5, WHIP_END, tau));
  if (w <= 0) return;
  let sx: number;
  let sz: number;
  let tw: number;
  let el: number;
  let twist: number;
  let lean: number;
  if (tau < WHIP_WIND) {
    const u = smooth(0, WHIP_WIND, tau);
    sx = lerp(-0.3, -2.8, u);
    sz = lerp(-0.12, -0.38, u);
    tw = 0;
    el = lerp(-0.4, -1.8, u);
    twist = -0.34 * u;
    lean = -0.1 * u;
  } else if (tau < WHIP_SNAP) {
    const u = Math.pow((tau - WHIP_WIND) / (WHIP_SNAP - WHIP_WIND), 1.7);
    sx = lerp(-2.8, -1.2, u);
    sz = lerp(-0.38, -0.08, u);
    tw = 0.2 * u;
    el = lerp(-1.8, -0.1, u);
    twist = lerp(-0.34, 0.3, u);
    lean = lerp(-0.1, 0.15, u);
  } else {
    const u = smooth(WHIP_SNAP, 0.5, tau);
    sx = lerp(-1.2, -0.7, u);
    sz = -0.08;
    tw = 0.2;
    el = lerp(-0.1, -0.35, u);
    twist = lerp(0.3, 0.12, u);
    lean = lerp(0.15, 0.06, u);
  }
  o.sRx = lerp(o.sRx, sx, w);
  o.sRz = lerp(o.sRz, sz, w);
  o.tR = lerp(o.tR, tw, w);
  o.eR = lerp(o.eR, el, w);
  o.twist += twist * w;
  o.lean += lean * w;
  o.headYaw -= twist * w * 0.8;
  o.headPitch -= lean * w * 0.6;
  // The free arm swings the other way for balance.
  o.sLx += -twist * w * 0.9;
  o.sLz += Math.abs(twist) * w * 0.4;
}

/** Direction of the lash (angle in the vertical plane, 0 = forward, −π/2 = down) as the swing passes: down, back over the shoulder, over the top, forward. */
function lashAngle(tau: number): number {
  if (tau <= WHIP_WIND) return -Math.PI / 2 - (Math.PI / 2 + 0.55) * smooth(0.02, WHIP_WIND, tau);
  const u = clamp01((tau - WHIP_WIND) / (WHIP_SNAP - WHIP_WIND));
  return lerp(-Math.PI - 0.55, -TAU - 0.07, Math.pow(u, 1.6));
}

const LASH_N = 26;
const LASH_SIDES = 5;
const LASH_RINGS = LASH_N + 3;
const LASH_LEN = 2.0;
export const HANDLE_LEN = 0.17;
const SIDE_COS: number[] = [];
const SIDE_SIN: number[] = [];
for (let j = 0; j < LASH_SIDES; j++) {
  SIDE_COS.push(Math.cos((j / LASH_SIDES) * TAU));
  SIDE_SIN.push(Math.sin((j / LASH_SIDES) * TAU));
}

/** The whip in the hand: a stiff handle and a tapered lash, one tube whose rings are moved in place every frame. */
export function lashGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(LASH_RINGS * LASH_SIDES * 3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(LASH_RINGS * LASH_SIDES * 3), 3));
  const idx: number[] = [];
  for (let i = 0; i < LASH_RINGS - 1; i++) {
    for (let j = 0; j < LASH_SIDES; j++) {
      const a = i * LASH_SIDES + j;
      const b = i * LASH_SIDES + ((j + 1) % LASH_SIDES);
      idx.push(a, b, a + LASH_SIDES, b, b + LASH_SIDES, a + LASH_SIDES);
    }
  }
  g.setIndex(idx);
  return g;
}

function lashRing(pos: Float32Array, nor: Float32Array, i: number, px: number, py: number, pz: number, r: number, ux: number, uy: number, uz: number, vx: number, vy: number, vz: number): void {
  let o = i * LASH_SIDES * 3;
  for (let j = 0; j < LASH_SIDES; j++) {
    const c = SIDE_COS[j]!;
    const s = SIDE_SIN[j]!;
    const nx = c * ux + s * vx;
    const ny = c * uy + s * vy;
    const nz = c * uz + s * vz;
    pos[o] = px + nx * r;
    pos[o + 1] = py + ny * r;
    pos[o + 2] = pz + nz * r;
    nor[o] = nx;
    nor[o + 1] = ny;
    nor[o + 2] = nz;
    o += 3;
  }
}

/**
 * Shape the whip for time `tau` of the swing. (hx, hy, hz) is the hand and (dx, dy, dz) the direction the forearm
 * points, in the character's own frame; `floor` is the lowest the lash may go. Returns the tip through `LASH_TIP`.
 */
export const LASH_TIP = new THREE.Vector3();
export function shapeLash(g: THREE.BufferGeometry, tau: number, hx: number, hy: number, hz: number, dx: number, dy: number, dz: number, floor: number): void {
  const pos = (g.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  const nor = (g.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array;
  // Handle: along the forearm, through the fist.
  let vx = dy * 0 - dz * 0;
  let vy = dz * 1 - dx * 0;
  let vz = dx * 0 - dy * 1;
  const vl = Math.hypot(vx, vy, vz) || 1;
  vx /= vl;
  vy /= vl;
  vz /= vl;
  const ux = vy * dz - vz * dy;
  const uy = vz * dx - vx * dz;
  const uz = vx * dy - vy * dx;
  const bx = hx - dx * 0.035;
  const by = hy - dy * 0.035;
  const bz = hz - dz * 0.035;
  let px = bx + dx * HANDLE_LEN;
  let py = by + dy * HANDLE_LEN;
  let pz = bz + dz * HANDLE_LEN;
  lashRing(pos, nor, 0, bx, by, bz, 0.018, ux, uy, uz, vx, vy, vz);
  lashRing(pos, nor, 1, px, py, pz, 0.017, ux, uy, uz, vx, vy, vz);
  // Lash: every point follows the swing a little later than the one before it, so a loop rolls out to the tip.
  const out = smooth(0.0, 0.13, tau) * (1 - smooth(WHIP_CRACK + 0.08, WHIP_END - 0.02, tau));
  const seg = (LASH_LEN * lerp(0.12, 1, out)) / LASH_N;
  const after = Math.max(0, tau - WHIP_CRACK);
  const x0 = px;
  for (let i = 0; i <= LASH_N; i++) {
    const sN = i / LASH_N;
    const th = lashAngle(tau - WHIP_LAG * sN) - after * 2.6 * sN;
    const c = Math.cos(th);
    const s = Math.sin(th);
    lashRing(pos, nor, i + 2, px, py, pz, lerp(0.017, 0.006, sN), 1, 0, 0, 0, c, -s);
    if (i === LASH_N) break;
    // Seen from above the lash bows out to the right and comes back to the centre line, so it is not hidden behind its owner.
    px = x0 * (1 - 0.85 * sN) - 0.42 * out * Math.sin(Math.PI * Math.min(1, sN * 1.15));
    py = Math.max(floor, py + s * seg);
    pz += c * seg;
  }
  LASH_TIP.set(px, py, pz);
  (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  (g.getAttribute('normal') as THREE.BufferAttribute).needsUpdate = true;
}
