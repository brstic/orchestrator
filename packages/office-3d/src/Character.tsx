import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Appearance } from '@orchestrator/contracts';

/**
 * A stylised, fully procedural office worker: no asset files, a small jointed
 * rig, and motion generated at runtime. The pose is chosen by the caller from
 * the employee's real state; this component only knows how to move a body.
 *
 * The body is sculpted in code (lofted torso, lathed limbs, a shaped head with
 * a face, hair shells per style) and every geometry is built once and shared
 * by all characters; materials are cached by colour.
 *
 * Motion has three layers:
 *   - seated poses are functions of time (`poseAt`);
 *   - anyone on their feet is driven by a gait generator (`upright`): feet are
 *     placed on the floor from the body's real velocity and the legs follow by
 *     inverse kinematics, so walking, running, backing up, sidestepping and
 *     turning on the spot are one continuous motion rather than separate clips;
 *   - a change of pose is never a cut: the difference to the new pose is kept
 *     as an offset that decays on a critically damped spring ("inertial"
 *     blending), so the new pose plays at full strength from its first frame
 *     and nothing pops.
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
  | 'whip';

/** How a character on its feet is moving, in its own frame of reference. Written by the owner of the transform, read here every frame. */
export interface Motion {
  /** Velocity in world units per second: +x is the character's left, +z straight ahead. */
  vx: number;
  vz: number;
  /** Turn rate in radians per second, with the sign of `rotation.y` (positive = to its left). */
  turn: number;
  /** Running rather than walking. */
  run: boolean;
}

// ───────────────────────────── poses ─────────────────────────────

interface Pose {
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

const POSE_KEYS: (keyof Pose)[] = [
  'hipX', 'hipY', 'hipZ', 'pelYaw', 'pelRoll', 'lean', 'twist', 'side', 'shrug', 'headPitch', 'headYaw', 'headRoll',
  'sLx', 'sLz', 'tL', 'eL', 'sRx', 'sRz', 'tR', 'eR',
  'hL', 'aL', 'yL', 'kL', 'fL', 'hR', 'aR', 'yR', 'kR', 'fR',
];
const NKEYS = POSE_KEYS.length;

const SIT_Y = 0.56;
const STAND_Y = 0.88;
/** Top of the chair cushion; used to keep small/large builds sitting on the seat. */
const SEAT_TOP = 0.51;

const newPose = (): Pose => ({
  hipX: 0, hipY: SIT_Y, hipZ: 0, pelYaw: 0, pelRoll: 0, lean: 0, twist: 0, side: 0, shrug: 0, headPitch: 0, headYaw: 0, headRoll: 0,
  sLx: 0, sLz: 0, tL: 0, eL: 0, sRx: 0, sRz: 0, tR: 0, eR: 0,
  hL: 0, aL: 0, yL: 0, kL: 0, fL: 0, hR: 0, aR: 0, yR: 0, kR: 0, fR: 0,
});

const TAU = Math.PI * 2;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const wrapPi = (a: number) => {
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
const DESK_TOP = 0.7625;
/** Half the thickness of a forearm lying on the desk. */
const ARM_R = 0.04;
const UPPER_ARM = 0.26;
const FOREARM = 0.225;
const HEAD_Y = 0.585;
const SHOULDER_X = 0.187;
const SHOULDER_Y = 0.44;
/** How fast a sleeper breathes, radians per second (a breath every four seconds). */
const SLEEP_BREATH = TAU * 0.25;

/**
 * Two-bone arm for a seated, leaning body: puts the wrist at (wx, wy, wz) and the elbow at height `ey`, on the outside.
 * Coordinates are relative to the hip centre, in the character's frame; the spine is pitched forward by `lean` and nothing else.
 */
function restArm(o: Pose, left: boolean, lean: number, wx: number, wy: number, wz: number, ey: number): void {
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
  const sp = clamp((ey - cy) / (r * vy || 1e-6), -1, 1);
  const cp = Math.sqrt(1 - sp * sp) * (side * ux >= 0 ? 1 : -1);
  const ex = cx + r * (cp * ux + sp * vx);
  const eY = cy + r * sp * vy;
  const ez = cz + r * (cp * uz + sp * vz);
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
  const headUp = 0.103 * Math.cos(tip) - 0.014 * Math.sin(tip);
  const headOut = 0.103 * Math.sin(tip) + 0.014 * Math.cos(tip);
  const headY = desk + 2 * ARM_R + 0.094;
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

/** A seated pose as a function of time (seconds) and a per-character phase so nobody moves in sync. Writes into `o` (no allocation). `build` is the body scale, for poses that touch the desk. */
function poseAt(name: PoseName, t: number, ph: number, o: Pose, build = 1): void {
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
      // Chin resting on the right hand.
      o.lean = -0.05;
      o.headPitch = -0.1 + s(t * 0.6 + ph) * 0.05;
      o.headRoll = 0.1;
      o.sRx = -0.9;
      o.sRz = -0.1;
      o.tR = 0.9;
      o.eR = -2.32;
      o.sLx = -0.35;
      o.sLz = 0.1;
      o.tL = 1.05;
      o.eL = -1.5;
      break;
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

const HIP_X = 0.078;
const THIGH = 0.4;
const SHIN = 0.4;
/** Height of the ankle joint above the sole; how far the heel is behind it and the ball of the foot ahead of it. */
const ANKLE = 0.08;
const HEEL = 0.06;
const BALL = 0.115;
/** The leg is never locked completely straight: the last millimetres of reach are where knees pop. */
const REACH = THIGH + SHIN - 0.0008;
/** How far the hips turn toward the direction of travel when moving sideways. */
const FACE_MAX = 0.6;
/** Standing, each foot is this far to the side of the body's centre line. */
const STANCE_X = 0.092;
/** A foot comes down this share of its stride ahead of the hips (and leaves the floor the rest of it behind them). */
const LAND = 0.4;
/** A foot within this distance (and this turn) of where it belongs does not take a step to get there. */
const HOME_NEAR = 0.035;
const HOME_YAW = 0.12;
/** Cadence of the steps that bring the feet back under a body that has stopped, cycles per second. */
const SETTLE_HZ = 1.55;

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
  /** Staying down through this turn to swing, because it already stands where it belongs. */
  hold: boolean;
}

const newStep = (side: 1 | -1): Step => ({ x: side * STANCE_X, z: 0, yaw: 0, down: true, sx: 0, sz: 0, syaw: 0, w0: 0, hold: false });

/** The state of one character's gait. */
interface Loco {
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
  /** Scratch values shared between the body and the feet for the current frame. */
  homeX: number;
  homeZ: number;
  left: Step;
  right: Step;
  /** The feet have not been placed yet (first frame on its feet, or back from a chair). */
  fresh: boolean;
  /** Last world transform seen, for characters whose motion is measured rather than given. */
  px: number;
  pz: number;
  yaw: number;
  has: boolean;
}

const newLoco = (): Loco => ({
  phase: 0.6, active: false, go: false, mvx: 0, mvz: 0, mturn: 0, dt: 0, vx: 0, vz: 0, sx: 0, sz: 0, turn: 0, speed: 0, amp: 0, run: 0, face: 0, dirx: 0, dirz: 1,
  freq: 1, duty: 0.6, stride: 0, lift: 0, hurry: 0, homeX: STANCE_X, homeZ: 0, left: newStep(1), right: newStep(-1), fresh: true, px: 0, pz: 0, yaw: 0, has: false,
});

/**
 * Advance the gait by `dt` given the body's real motion. `run` is a hint that the body is setting off at a run (the
 * gait breaks into one by itself above a brisk walk).
 *
 * The stride is chosen for the speed — how far the body travels over a planted foot, and what share of the time a foot
 * is planted — and the cadence follows from the two, so a foot is on the floor exactly as long as the floor needs it.
 */
function stepLoco(L: Loco, dt: number, vx: number, vz: number, turn: number, run: boolean | null): void {
  L.mvx = vx;
  L.mvz = vz;
  L.mturn = turn;
  L.dt = dt;
  const kv = 1 - Math.exp(-dt / 0.075);
  L.vx += (vx - L.vx) * kv;
  L.vz += (vz - L.vz) * kv;
  L.turn += (turn - L.turn) * (1 - Math.exp(-dt / 0.1));
  const ks = 1 - Math.exp(-dt / 0.32);
  L.sx += (L.vx - L.sx) * ks;
  L.sz += (L.vz - L.sz) * ks;
  const speed = Math.hypot(L.vx, L.vz);
  L.speed = speed;
  const turning = Math.abs(L.turn);
  const want = clamp01(Math.max(speed / 0.9, turning / 1.2));
  L.amp += (want - L.amp) * (1 - Math.exp(-dt / (want > L.amp ? 0.08 : 0.14)));
  if (L.amp < 0.0005) L.amp = 0;
  const auto = smooth(2.9, 3.7, speed);
  const runT = run && speed > 1 ? 1 : auto;
  L.run += (runT - L.run) * (1 - Math.exp(-dt / 0.13));
  L.go = speed > 0.06 || turning > 0.25 || Math.hypot(vx, vz) > 0.15;

  // The hips turn toward where the body is going, so a sidestep becomes a crossing stride instead of a shuffle.
  let face = 0;
  if (speed > 0.25) {
    face = L.vz >= -0.12 * speed ? Math.atan2(L.vx, Math.max(L.vz, 0)) : Math.atan2(-L.vx, -L.vz);
    face = clamp(face, -FACE_MAX, FACE_MAX) * clamp01((speed - 0.25) / 0.8);
  }
  L.face += (face - L.face) * (1 - Math.exp(-dt / 0.11));
  if (speed > 0.05) {
    const cp = Math.cos(L.face);
    const sp = Math.sin(L.face);
    L.dirx = (L.vx * cp - L.vz * sp) / speed;
    L.dirz = (L.vx * sp + L.vz * cp) / speed;
  }

  // Stride for this speed and direction: an easy walk lengthening into a brisk one, then a run with both feet off the floor.
  const back = Math.max(0, -L.dirz);
  const along = L.dirz >= 0 ? lerp(0.96, 1.02, L.run) : lerp(0.74, 0.86, L.run);
  const across = lerp(0.66, 0.82, L.run);
  const longest = 1 / Math.sqrt((L.dirz / along) ** 2 + (L.dirx / across) ** 2);
  let stride = longest * (1 - Math.exp(-speed / lerp(0.95, 1.3, L.run)));
  const duty = lerp(lerp(0.64, 0.53, clamp01((speed - 0.5) / 2)), lerp(0.4, 0.27, clamp01((speed - 3) / 3.4)), L.run);
  let f = stride > 0.02 ? (speed * duty) / stride : 0;
  // Legs only go so fast: beyond that the stride has to give.
  const fMax = lerp(1.85, 2.15, L.run);
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
  L.lift = Math.max(0.03, L.amp * lerp(lerp(0.05, 0.075, clamp01((speed - 1) / 2)), 0.27, L.run) * (1 - 0.3 * back));
  if (!L.active && L.go) {
    // Setting off: the foot on the side the body is heading to steps first, and the other is already part-way through its time on the floor.
    L.active = true;
    const rightFirst = vx < -0.2 || (Math.abs(vx) <= 0.2 && turn < -0.2);
    L.phase = LAND * duty + (rightFirst ? 0 : 0.5);
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

/** How far the ankle moves (forward, up) when the foot tips by `p` about the heel (p < 0, toes up) or the ball (p > 0, heel up). */
let PIVOT_Z = 0;
let PIVOT_Y = 0;
function pivot(p: number): void {
  const c = Math.cos(p);
  const sn = Math.sin(p);
  if (p > 0) {
    PIVOT_Z = BALL * (1 - c) + ANKLE * sn;
    PIVOT_Y = ANKLE * (c - 1) + BALL * sn;
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
  const fwd = Math.max(0, L.dirz);
  const back = Math.max(0, -L.dirz);
  // Where this foot belongs under the hips. Tracks of the two feet are kept apart when the stride runs across the hips, so the legs pass each other.
  const gap = Math.max(0, 0.085 - L.homeX * Math.abs(L.dirz)) * clamp01(stride / 0.3) * side * (L.dirz >= 0 ? 1 : -1);
  const cf = Math.cos(L.face);
  const sf = Math.sin(L.face);
  const hx0 = side * L.homeX + gap * L.dirz;
  const hz0 = L.homeZ - gap * L.dirx;
  const hx = hx0 * cf + hz0 * sf;
  const hz = -hx0 * sf + hz0 * cf;
  // Where the next step lands: ahead of home along the way the body is going, and turned ahead of a turning body, so that it is under the hips half-way through its time on the floor.
  const land = stride * lerp(lerp(LAND, 0.5, Math.max(back, Math.abs(L.dirx))), 0.36, L.run * fwd);
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
    if (far > 0.66) {
      s.x = hx + ((s.x - hx) * 0.66) / far;
      s.z = hz + ((s.z - hz) * 0.66) / far;
    }
  }
  // (Half a frame early rather than half a frame late.)
  const swinging = ph + 0.5 * L.freq * L.dt >= d;
  if (!swinging) {
    s.hold = false;
    if (!s.down) {
      s.down = true;
      s.x = tx;
      s.z = tz;
      s.yaw = tyaw;
    }
  } else if (s.down && !s.hold) {
    // Its turn to step — unless the body is standing and the foot already is where it belongs.
    if (!L.go && Math.hypot(s.x - hx, s.z - hz) < HOME_NEAR && Math.abs(s.yaw - L.face) < HOME_YAW) s.hold = true;
    else {
      s.down = false;
      s.sx = s.x;
      s.sz = s.z;
      s.syaw = s.yaw;
      s.w0 = clamp((ph - d) / (1 - d), 0, 0.7);
    }
  }

  const roll = clamp01(stride / 0.45) * L.amp;
  const pStrike = roll * (-0.3 * fwd * (1 - 0.8 * L.run) + 0.28 * back);
  /** How far the foot trails behind where it belongs, along the way it points: that, not the clock, lifts the heel. */
  const trail = (hx - s.x) * Math.sin(s.yaw) + (hz - s.z) * Math.cos(s.yaw);
  const pOff = clamp01((trail - 0.1) / 0.36) * (0.95 + 0.1 * L.run) * (1 - 0.6 * back);
  if (s.down) {
    // Heel first, flat, then up onto the ball of the foot as the body leaves it behind.
    const u = ph / d;
    const pitch = Math.max(pOff * pOff * (3 - 2 * pOff) * 1.05, 0) + (!swinging && u < 0.2 ? pStrike * (1 - smooth(0, 0.2, u)) : 0);
    pivot(pitch);
    f.x = s.x + Math.sin(s.yaw) * PIVOT_Z;
    f.z = s.z + Math.cos(s.yaw) * PIVOT_Z;
    f.y = ANKLE + PIVOT_Y;
    f.yaw = s.yaw;
    f.pitch = pitch;
    FREE = 0;
    AWAY = Math.max(Math.hypot(s.x - hx, s.z - hz) / HOME_NEAR, Math.abs(s.yaw - L.face) / HOME_YAW);
    // Left behind further than a stride should leave it: the cadence picks up until it has been brought forward.
    const lim = 0.6 * Math.max(stride, 0.3) + 0.06;
    L.hurry = Math.max(L.hurry, clamp01((Math.hypot(s.x - hx, s.z - hz) - lim) / 0.12));
    return;
  }
  const w = clamp01(((ph - d) / (1 - d) - s.w0) / (1 - s.w0));
  // Leaving the floor and arriving on it at the speed of the floor (in the body's frame the floor moves backward, and turns against the body).
  const dur = ((1 - d) * (1 - s.w0)) / Math.max(L.freq, 0.3);
  const k0 = -lerp(0.55, 0.4, L.run) * dur;
  const k1 = -lerp(0.9, 0.5, L.run) * dur;
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
  const pLift = clamp01(((hx - s.sx) * Math.sin(s.syaw) + (hz - s.sz) * Math.cos(s.syaw) - 0.1) / 0.36) * (0.95 + 0.1 * L.run) * (1 - 0.6 * back);
  const pStart = pLift * pLift * (3 - 2 * pLift) * 1.05;
  const pMid = roll * (0.3 + 0.55 * L.run) * fwd;
  const pitch = lerp(lerp(pStart, pMid, smooth(0, 0.4, w)), pStrike, smooth(0.55, 0.95, w));
  pivot(pStart);
  const z0 = PIVOT_Z;
  const y0 = PIVOT_Y;
  pivot(pStrike);
  const dz = lerp(z0, PIVOT_Z, e);
  f.x = s.x + Math.sin(s.yaw) * dz;
  f.z = s.z + Math.cos(s.yaw) * dz;
  // Walking, the foot skims the floor; running, the heel kicks up behind and the knee carries it through.
  const up = Math.sin(Math.PI * Math.pow(w, lerp(0.8, 0.62, L.run)));
  f.y = ANKLE + lerp(y0, PIVOT_Y, e) + L.lift * Math.pow(up, 1.15);
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
function upright(o: Pose, t: number, ph: number, L: Loco): void {
  const s = Math.sin;
  const amp = L.amp;
  const rest = 1 - amp;
  const run = L.run;
  const d = L.duty;
  const a = L.phase * TAU;
  const fw = L.dirz;
  const gait = amp * clamp01(L.stride / 0.7);
  const c0 = Math.cos(a);
  /** +1 in the middle of the left foot's time on the floor, −1 in the middle of the right's. */
  const mid = Math.cos(a - d * Math.PI);
  const breath = s(t * 1.3 + ph * 1.9);
  // Standing: the weight drifts slowly from one leg to the other.
  const shift = rest * (s(t * 0.23 + ph) * 0.015 + s(t * 0.61 + ph * 2.1) * 0.005);

  // Hips: the side of the leading leg swings forward, the weight rides over the planted foot.
  const osc = -(0.07 + 0.04 * run) * gait * fw * c0;
  L.homeX = STANCE_X - 0.03 * run * gait;
  L.homeZ = -(0.03 + 0.07 * run) * gait * fw;
  o.hipX = shift + (0.016 - 0.008 * run) * gait * mid;
  o.hipZ = 0;
  o.pelYaw = L.face + osc;
  o.pelRoll = 0.035 * gait * mid - shift * 1.4;

  // Spine: upright at a walk, forward at a run; leans into every change of speed, counters the hips, banks into turns.
  o.lean = gait * fw * lerp(0.05, 0.17, run) + clamp((L.vz - L.sz) * 0.032, -0.09, 0.12) + rest * (s(t * 0.5 + ph) * 0.012 + breath * 0.004);
  o.twist = L.face * 0.5 - osc * 1.25 + clamp(L.turn * 0.035, -0.1, 0.1);
  o.side = -o.pelRoll * 0.5 - clamp(L.turn * L.speed * 0.012, -0.12, 0.12) - clamp((L.vx - L.sx) * 0.022, -0.08, 0.08);
  o.shrug = breath * 0.003 * rest;

  // Head: steady while the body works underneath it, looking into a turn, glancing around when idle.
  o.headYaw = -o.twist * 0.85 + clamp(L.turn * 0.09, -0.3, 0.3) + rest * (s(t * 0.29 + ph) * 0.16 + s(t * 0.71 + ph * 1.7) * 0.06);
  o.headPitch = -o.lean * 0.6 + rest * s(t * 0.43 + ph * 1.3) * 0.02;
  o.headRoll = -o.side * 0.6;

  // Arms: loose and opposite to the legs, the forearm trailing the upper arm and folding on the way forward; pumping when running.
  const sw = Math.cos(a - 0.3);
  const fore = Math.cos(a - 0.85);
  const reach = gait * Math.abs(fw) * lerp(0.36, 0.6, run) * (fw >= 0 ? 1 : 0.6);
  const carry = run * gait;
  const bend = lerp(0.2 + 0.12 * gait, 1.3, carry);
  const wide = 0.085 + 0.05 * carry + 0.07 * gait * Math.abs(L.dirx);
  o.sLx = sw * reach - 0.06 * carry - 0.03 + rest * s(t * 0.6 + ph) * 0.03;
  o.sRx = -sw * reach - 0.06 * carry - 0.03 + rest * s(t * 0.6 + ph + 1.3) * 0.03;
  o.sLz = wide;
  o.sRz = -wide;
  o.tL = 0.3 * carry;
  o.tR = 0.3 * carry;
  // The elbow closes as the hand comes forward and opens as it goes back.
  o.eL = -(bend + reach * (0.6 * Math.max(0, -fore) - 0.45 * carry * Math.max(0, fore)));
  o.eR = -(bend + reach * (0.6 * Math.max(0, fore) - 0.45 * carry * Math.max(0, -fore)));

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
    } else if (awayL > 1.6 || awayR > 1.6) {
      L.active = true;
      L.phase = d + (awayL >= awayR ? 0.001 : 0.501);
      L.phase -= Math.floor(L.phase);
    }
  }
  // The legs hang from the hips, which sway and turn over feet that stay where they are.
  const cy = Math.cos(o.pelYaw);
  const sy = Math.sin(o.pelYaw);
  const lx0 = FOOT_L.x - o.hipX;
  const rx0 = FOOT_R.x - o.hipX;
  const lx = lx0 * cy - FOOT_L.z * sy - HIP_X;
  const lz = lx0 * sy + FOOT_L.z * cy;
  const rx = rx0 * cy - FOOT_R.z * sy + HIP_X;
  const rz = rx0 * sy + FOOT_R.z * cy;
  // Walking, the knees stay soft and the hips ride level; running, the body sinks onto the planted leg and rises while both feet are in the air.
  const top = STAND_Y + 0.006 - amp * 0.003 - gait * (0.005 + 0.034 * run) - gait * (1 - run) * 0.024 + carry * 0.028 * Math.cos(2 * a - TAU * (d + 0.5));
  // Only a foot on the floor holds the hips down (a leg in the air folds as it must), and never by more than a few centimetres:
  // a foot left too far behind comes off the floor rather than dragging the body down.
  const hl = Math.max(top - 0.056, FOOT_L.y + Math.sqrt(Math.max(0.01, REACH * REACH - lx * lx - lz * lz)) + freeL * 0.4);
  const hr = Math.max(top - 0.056, FOOT_R.y + Math.sqrt(Math.max(0.01, REACH * REACH - rx * rx - rz * rz)) + freeR * 0.4);
  const lo = Math.min(top, hl, hr);
  // In stride the handover from one leg to the other is rounded off; standing still, the legs are simply straight.
  const K = 0.011 * gait;
  o.hipY = K < 1e-4 ? lo : lo - K * Math.log(Math.exp(-(top - lo) / K) + Math.exp(-(hl - lo) / K) + Math.exp(-(hr - lo) / K));
  legIK(o, true, lx, FOOT_L.y - o.hipY, lz, FOOT_L.yaw - o.pelYaw, FOOT_L.pitch);
  legIK(o, false, rx, FOOT_R.y - o.hipY, rz, FOOT_R.yaw - o.pelYaw, FOOT_R.pitch);
}

/**
 * Dozing on one's feet, layered over the standing body: chin on the chest, arms slack, a slow sway — and every few
 * seconds the head sinks until it jerks back up.
 */
function doze(o: Pose, t: number, ph: number): void {
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
function ouch(o: Pose, tau: number): void {
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

/** Whip timeline, seconds from the start of the pose: wound up, arm snapped forward, and (a moment later, as the wave reaches the tip) the crack. */
const WHIP_WIND = 0.15;
const WHIP_SNAP = 0.25;
const WHIP_LAG = 0.055;
const WHIP_CRACK = WHIP_SNAP + WHIP_LAG;
const WHIP_END = 0.7;

/** Whip crack with the right arm, layered over the current pose: wind up over the shoulder, snap forward, follow through. */
function whipArm(o: Pose, tau: number): void {
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
const HANDLE_LEN = 0.17;
const SIDE_COS: number[] = [];
const SIDE_SIN: number[] = [];
for (let j = 0; j < LASH_SIDES; j++) {
  SIDE_COS.push(Math.cos((j / LASH_SIDES) * TAU));
  SIDE_SIN.push(Math.sin((j / LASH_SIDES) * TAU));
}

/** The whip in the hand: a stiff handle and a tapered lash, one tube whose rings are moved in place every frame. */
function lashGeometry(): THREE.BufferGeometry {
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
const LASH_TIP = new THREE.Vector3();
function shapeLash(g: THREE.BufferGeometry, tau: number, hx: number, hy: number, hz: number, dx: number, dy: number, dz: number, floor: number): void {
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

// ───────────────────────────── geometry helpers ─────────────────────────────

const spow = (v: number, n: number) => Math.sign(v) * Math.pow(Math.abs(v), 2 / n);

/** Make triangles face away from the mesh centre, then compute smooth normals. */
function orient(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const ix = g.index!;
  const a = ix.array as Uint16Array | Uint32Array;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < p.count; i++) {
    cx += p.getX(i);
    cy += p.getY(i);
    cz += p.getZ(i);
  }
  cx /= p.count;
  cy /= p.count;
  cz /= p.count;
  let sum = 0;
  for (let i = 0; i < a.length; i += 3) {
    const i0 = a[i]!;
    const i1 = a[i + 1]!;
    const i2 = a[i + 2]!;
    const ax = p.getX(i0);
    const ay = p.getY(i0);
    const az = p.getZ(i0);
    const e1x = p.getX(i1) - ax;
    const e1y = p.getY(i1) - ay;
    const e1z = p.getZ(i1) - az;
    const e2x = p.getX(i2) - ax;
    const e2y = p.getY(i2) - ay;
    const e2z = p.getZ(i2) - az;
    sum += (e1y * e2z - e1z * e2y) * (ax - cx) + (e1z * e2x - e1x * e2z) * (ay - cy) + (e1x * e2y - e1y * e2x) * (az - cz);
  }
  if (sum < 0) {
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1]!;
      a[i + 1] = a[i + 2]!;
      a[i + 2] = t;
    }
  }
  g.computeVertexNormals();
  return g;
}

/** Stitch a stack of closed rings (flat xyz arrays of equal length) into a smooth surface. */
function ringGeo(rings: number[][], capStart: boolean, capEnd: boolean, poleStart = false, poleEnd = false): THREE.BufferGeometry {
  const n = rings[0]!.length / 3;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const r of rings) for (const v of r) pos.push(v);
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * n + j;
      const b = i * n + ((j + 1) % n);
      idx.push(a, a + n, b, b, a + n, b + n);
    }
  }
  const cap = (ring: number[], reverse: boolean) => {
    const base = pos.length / 3;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let j = 0; j < n; j++) {
      pos.push(ring[j * 3]!, ring[j * 3 + 1]!, ring[j * 3 + 2]!);
      cx += ring[j * 3]!;
      cy += ring[j * 3 + 1]!;
      cz += ring[j * 3 + 2]!;
    }
    pos.push(cx / n, cy / n, cz / n);
    for (let j = 0; j < n; j++) {
      const a = base + j;
      const b = base + ((j + 1) % n);
      if (reverse) idx.push(base + n, b, a);
      else idx.push(base + n, a, b);
    }
  };
  if (capStart) cap(rings[0]!, false);
  if (capEnd) cap(rings[rings.length - 1]!, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  orient(g);
  // A ring collapsed to a point gets one shared normal, so the pole does not pinch.
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  const fixPole = (row: number) => {
    let x = 0;
    let y = 0;
    let z = 0;
    for (let j = 0; j < n; j++) {
      x += nor.getX(row * n + j);
      y += nor.getY(row * n + j);
      z += nor.getZ(row * n + j);
    }
    const l = Math.hypot(x, y, z) || 1;
    for (let j = 0; j < n; j++) nor.setXYZ(row * n + j, x / l, y / l, z / l);
  };
  if (poleStart) fixPole(0);
  if (poleEnd) fixPole(rings.length - 1);
  return g;
}

/** One cross-section of a loft: height, half width, half depth, z centre, superellipse exponent. */
type Sec = [y: number, hw: number, hd: number, zc: number, n: number];

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function resample(secs: Sec[], sub: number): Sec[] {
  const out: Sec[] = [];
  const at = (i: number) => secs[Math.max(0, Math.min(secs.length - 1, i))]!;
  for (let i = 0; i < secs.length - 1; i++) {
    for (let k = 0; k < sub; k++) {
      const t = k / sub;
      const r = [0, 0, 0, 0, 0] as Sec;
      for (let c = 0; c < 5; c++) r[c] = catmull(at(i - 1)[c]!, at(i)[c]!, at(i + 1)[c]!, at(i + 2)[c]!, t);
      out.push(r);
    }
  }
  out.push(secs[secs.length - 1]!);
  return out;
}

function ellipseRing(sec: Sec, seg: number): number[] {
  const ring: number[] = [];
  for (let j = 0; j < seg; j++) {
    const a = (j / seg) * TAU;
    ring.push(sec[1] * spow(Math.cos(a), sec[4]), sec[0], sec[3] + sec[2] * spow(Math.sin(a), sec[4]));
  }
  return ring;
}

/** A smooth body part swept through elliptical cross-sections along Y. */
function loft(secs: Sec[], sub = 3, seg = 28, capStart = true, capEnd = true): THREE.BufferGeometry {
  return ringGeo(
    resample(secs, sub).map((r) => ellipseRing(r, seg)),
    capStart,
    capEnd,
  );
}

function secAt(rows: Sec[], y: number): Sec {
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i]!;
    const b = rows[i + 1]!;
    if ((y >= a[0] && y <= b[0]) || (y <= a[0] && y >= b[0])) {
      const t = (y - a[0]) / (b[0] - a[0] || 1);
      return [y, lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t), lerp(a[4], b[4], t)];
    }
  }
  return rows[rows.length - 1]!;
}

/** A strip lying on the front of a lofted body (shirt front, tie, placket). */
function frontPatch(rows: Sec[], y0: number, y1: number, halfW: (t: number) => number, off: number, ny = 10, nx = 4): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= ny; i++) {
    const t = i / ny;
    const y = lerp(y0, y1, t);
    const sec = secAt(rows, y);
    const w = halfW(t);
    for (let j = 0; j <= nx; j++) {
      const x = lerp(-w, w, j / nx);
      const u = Math.min(0.999, Math.abs(x / sec[1]));
      pos.push(x, y, sec[3] + sec[2] * Math.pow(1 - Math.pow(u, sec[4]), 1 / sec[4]) + off);
    }
  }
  const up = y1 > y0;
  for (let i = 0; i < ny; i++) {
    for (let j = 0; j < nx; j++) {
      const a = i * (nx + 1) + j;
      const b = a + 1;
      const c = a + nx + 1;
      const d = c + 1;
      if (up) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A limb segment hanging from its joint at the origin down −Y. Both ends are spherical and the taper flattens out
 * where it meets them, so two segments of matching radius join without a step in the shading. `flat` cuts the far
 * end square (a cuff, a trouser hem); `cap` < 1 flattens the top (a sleeve head that does not puff above the shoulder).
 */
function limb(r1: number, r2: number, len: number, o: { flat?: boolean; bulge?: number; seg?: number; cap?: number; rows?: number; capRows?: number } = {}): THREE.BufferGeometry {
  const rows = o.rows ?? 7;
  const capRows = o.capRows ?? 6;
  const pts: THREE.Vector2[] = [];
  if (o.flat) {
    pts.push(new THREE.Vector2(0.0001, -len), new THREE.Vector2(r2 * 0.94, -len), new THREE.Vector2(r2, -len + r2 * 0.08));
  } else {
    for (let k = 0; k <= capRows; k++) {
      const a = (k / capRows) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.max(0.0001, r2 * Math.sin(a)), -len - r2 * Math.cos(a)));
    }
  }
  for (let k = rows; k >= 1; k--) {
    const t = k / (rows + 1);
    pts.push(new THREE.Vector2(lerp(r1, r2, t * t * (3 - 2 * t)) + (o.bulge ?? 0) * Math.sin(Math.PI * t), -len * t));
  }
  for (let k = 0; k <= capRows; k++) {
    const a = (k / capRows) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(0.0001, r1 * Math.cos(a)), r1 * Math.sin(a) * (o.cap ?? 1)));
  }
  return new THREE.LatheGeometry(pts, o.seg ?? 14);
}

/** Distance between the pinstripes of a suit. */
const STRIPE = 0.021;

/**
 * A whole limb as one surface: two segments hanging from the origin down −Y, skinned to two bones so that it bends
 * at the joint without a seam. `r0` → `rj` → `r1` are the radii at the top, the joint and the far end.
 */
function jointed(r0: number, rj: number, r1: number, len0: number, len1: number, zone: number, o: { flat?: boolean; cap?: number; seg?: number; bulge?: number } = {}): THREE.BufferGeometry {
  const total = len0 + len1;
  const radius = (y: number) => {
    const d = -y;
    if (d <= len0) {
      const t = d / len0;
      return lerp(r0, rj, t * t * (3 - 2 * t));
    }
    const t = (d - len0) / len1;
    return lerp(rj, r1, t * t * (3 - 2 * t)) + (o.bulge ?? 0) * Math.sin(Math.PI * t);
  };
  // Rows every few centimetres, closer together where the limb bends.
  const ys: number[] = [];
  let y = -total + (o.flat ? r1 * 0.08 : 0);
  while (y < -0.004) {
    ys.push(y);
    y += Math.abs(y + len0) < zone * 1.6 ? zone / 4 : 0.045;
  }
  const pts: THREE.Vector2[] = [];
  if (o.flat) {
    pts.push(new THREE.Vector2(0.0001, -total), new THREE.Vector2(r1 * 0.94, -total));
  } else {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * (Math.PI / 2);
      pts.push(new THREE.Vector2(Math.max(0.0001, r1 * Math.sin(a)), -total - r1 * Math.cos(a)));
    }
  }
  for (const yy of ys) pts.push(new THREE.Vector2(radius(yy), yy));
  for (let k = 0; k <= 6; k++) {
    const a = (k / 6) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.max(0.0001, r0 * Math.cos(a)), r0 * Math.sin(a) * (o.cap ?? 1)));
  }
  const g = new THREE.LatheGeometry(pts, o.seg ?? 14);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const w: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const lower = smooth(-len0 + zone, -len0 - zone, pos.getY(i));
    w.push(1 - lower, lower, 0, 0);
  }
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4));
  // Cloth texture runs down the limb: a whole number of stripes round it, so the seam does not show.
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const stripes = Math.round((TAU * r0) / STRIPE);
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * stripes);
  return g;
}

/** The same limb bound to a particular pair of bones of the character's skeleton. */
function onBones(src: THREE.BufferGeometry, upper: number, lower: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'skinWeight']) g.setAttribute(name, src.getAttribute(name));
  g.setIndex(src.index);
  const n = src.getAttribute('position').count;
  const idx = new Uint16Array(n * 4);
  for (let i = 0; i < n; i++) {
    idx[i * 4] = upper;
    idx[i * 4 + 1] = lower;
  }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(idx, 4));
  return g;
}

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const P = new THREE.Vector3();
const S = new THREE.Vector3();

/** Bake a transform (scale, then rotate, then translate) into a geometry. */
function xf(g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0, sx = 1, sy = sx, sz = sx): THREE.BufferGeometry {
  g.applyMatrix4(M.compose(P.set(x, y, z), Q.setFromEuler(E.set(rx, ry, rz)), S.set(sx, sy, sz)));
  return g;
}

/** Merge parts that share one material into a single draw call. */
function fuse(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // Texture coordinates survive only if every part has them.
  const textured = parts.every((g) => g.getAttribute('uv'));
  const flat = parts.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    if (!textured) n.deleteAttribute('uv');
    return n;
  });
  return mergeGeometries(flat, false)!;
}

const ball = (seg = 14, rows = 10) => new THREE.SphereGeometry(1, seg, rows);

// ───────────────────────────── head, face, hair ─────────────────────────────

const HEAD = { a: 0.103, b: 0.126, c: 0.113 };

/**
 * A point on the head for a direction given as azimuth (0 = face, +x = the
 * character's left) and polar angle from the crown. `inf` pushes it outward,
 * which is how hair and hats are wrapped around the same skull shape.
 */
function headPt(az: number, pol: number, inf = 0): [number, number, number] {
  const sr = Math.sin(pol);
  const py = Math.cos(pol);
  const px = sr * Math.sin(az);
  const pz = sr * Math.cos(az);
  const t = clamp01(-py);
  const low = t * t * (3 - 2 * t);
  // Fuller cranium, softly narrowing jaw, flatter face than back of the skull.
  const x = (HEAD.a + inf) * px * (1 - 0.2 * low) * (1 + 0.04 * Math.max(0, py));
  const y = (HEAD.b + inf) * (py < 0 ? py * (1 - 0.07 * low) : py);
  const z = pz > 0 ? (HEAD.c * 0.93 + inf) * pz * (1 - 0.06 * low) + 0.012 * low * pz : (HEAD.c * 1.04 + inf) * pz * (1 - 0.28 * low);
  return [x, y, z];
}

const deg = (d: number) => (d * Math.PI) / 180;

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

/** A shell wrapped over the skull from the crown down to a per-azimuth edge, with a rounded lip. */
function shell(polMax: (az: number) => number, thick: (az: number, pol: number) => number, azSeg = 40, rows = 16, base = 0.0015, lipStart = 0.84): THREE.BufferGeometry {
  const rings: number[][] = [];
  for (let i = 0; i <= rows; i++) {
    const v = 1 - Math.pow(1 - i / rows, 1.7);
    const lip = v < lipStart ? 1 : Math.sqrt(Math.max(0, 1 - ((v - lipStart) / (1 - lipStart)) ** 2));
    const ring: number[] = [];
    for (let j = 0; j < azSeg; j++) {
      const az = (j / azSeg) * TAU;
      const pol = v * polMax(az);
      const p = headPt(az, pol, base + lip * thick(az, pol));
      ring.push(p[0], p[1], p[2]);
    }
    rings.push(ring);
  }
  return ringGeo(rings, false, false, true, false);
}

const EYE_AZ = 0.39;
const EYE_POL = Math.PI / 2 + 0.02;
const EYE = headPt(EYE_AZ, EYE_POL);
const EAR_AZ = Math.PI / 2 + 0.14;

function buildHead(): THREE.BufferGeometry {
  const rings: number[][] = [];
  const rows = 26;
  const seg = 36;
  for (let i = 0; i <= rows; i++) {
    const ring: number[] = [];
    for (let j = 0; j < seg; j++) {
      const p = headPt((j / seg) * TAU, (i / rows) * Math.PI);
      ring.push(p[0], p[1], p[2]);
    }
    rings.push(ring);
  }
  const skull = ringGeo(rings, false, false, true, true);
  const parts = [skull];
  for (const side of [1, -1]) {
    const e = headPt(side * EAR_AZ, Math.PI / 2 + 0.06);
    parts.push(xf(ball(10, 8), e[0] + side * 0.002, e[1], e[2], 0, side * 0.35, 0, 0.011, 0.027, 0.018));
  }
  const n = headPt(0, Math.PI / 2 + 0.24);
  parts.push(xf(ball(10, 8), 0, n[1], n[2] + 0.001, -0.25, 0, 0, 0.0125, 0.017, 0.015));
  return fuse(parts);
}

function buildEyes(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [1, -1]) parts.push(xf(ball(12, 8), side * EYE[0], 0, EYE[2] - 0.002, 0, side * EYE_AZ * 0.8, 0, 0.0125, 0.0175, 0.007));
  return fuse(parts);
}

function buildBrows(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [1, -1]) {
    const p = headPt(side * (EYE_AZ + 0.02), EYE_POL - 0.3, 0.001);
    parts.push(xf(ball(10, 6), p[0], p[1], p[2], -0.12, side * EYE_AZ * 0.85, side * 0.1, 0.02, 0.0042, 0.005));
  }
  return fuse(parts);
}

function buildMouth(): THREE.BufferGeometry {
  const p = headPt(0, Math.PI / 2 + 0.56);
  const arc = 1.25;
  const g = new THREE.TorusGeometry(0.03, 0.0034, 6, 14, arc);
  g.rotateZ(-Math.PI / 2 - arc / 2);
  g.scale(1, 1, 0.6);
  return xf(g, 0, p[1] + 0.03, p[2] + 0.002, 0, 0, 0);
}

type HairStyle = Appearance['hairStyle'];

const SHORT_LINE: [number, number][] = [[0, 50], [30, 53], [56, 66], [73, 97], [84, 97], [98, 80], [113, 101], [132, 122], [180, 128]];
const TIGHT_LINE: [number, number][] = [[0, 45], [34, 50], [58, 66], [74, 94], [84, 94], [98, 80], [113, 100], [132, 118], [180, 124]];
const LONG_LINE: [number, number][] = [[0, 47], [24, 51], [48, 74], [66, 116], [180, 120]];
const CURLY_LINE: [number, number][] = [[0, 50], [40, 56], [64, 78], [82, 90], [98, 82], [116, 104], [180, 124]];

const topness = (pol: number) => Math.pow(Math.max(0, Math.cos(pol)), 0.7);
const quiff = (az: number, pol: number) => Math.exp(-((pol - 0.72) ** 2) / 0.07) * Math.max(0, Math.cos(az - 0.35)) ** 2;

/** Where the longer hair on top ends: above the ears and at the back of the skull. */
const TOP_LINE: [number, number][] = [[0, 50], [30, 53], [56, 64], [76, 84], [100, 82], [130, 101], [180, 109]];
/** Short back and sides under a longer, combed top. The top carries the volume and the strands (ridges running out from the crown). */
const shortTop = () =>
  shell(
    (az) => keyed(TOP_LINE, az),
    (az, pol) => 0.011 + 0.013 * topness(pol) + 0.012 * quiff(az, pol) + 0.0022 * Math.sin(15 * az + 4.5 * pol) * smooth(0.18, 0.6, pol) * (1 - smooth(0.7, 0.95, pol / keyed(TOP_LINE, az))),
    90,
    22,
    0.0015,
    0.5,
  );
const shortFade = () => shell((az) => keyed(SHORT_LINE, az), () => 0.0045, 44, 14);
const tightCap = (line = TIGHT_LINE) => shell((az) => keyed(line, az), (_az, pol) => 0.011 + 0.006 * topness(pol));

function longBack(): THREE.BufferGeometry {
  return loft(
    [
      [0.06, 0.094, 0.083, -0.031, 2],
      [0.0, 0.118, 0.094, -0.04, 2],
      [-0.06, 0.123, 0.085, -0.052, 2.2],
      [-0.12, 0.124, 0.07, -0.064, 2.2],
      [-0.165, 0.114, 0.057, -0.07, 2.2],
      [-0.19, 0.085, 0.04, -0.072, 2],
    ],
    3,
    28,
  );
}

function curls(minPol: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const N = 190;
  for (let i = 0; i < N; i++) {
    const y = 1 - (2 * (i + 0.5)) / N;
    const pol = Math.acos(y);
    const az = (i * 2.399963) % TAU;
    if (pol > keyed(CURLY_LINE, az) - 0.1 || pol < minPol) continue;
    const r1 = Math.abs(Math.sin(i * 12.9898) * 43758.5453) % 1;
    const r2 = Math.abs(Math.sin(i * 78.233) * 12345.678) % 1;
    const p = headPt(az, pol, 0.012 + r1 * 0.012);
    parts.push(xf(ball(8, 6), p[0], p[1], p[2], 0, 0, 0, 0.025 + r2 * 0.01));
  }
  parts.push(shell((az) => keyed(CURLY_LINE, az), () => 0.018));
  return fuse(parts);
}

function buildHair(style: HairStyle, underCap: boolean): THREE.BufferGeometry | null {
  switch (style) {
    case 'bald':
      return null;
    case 'short':
      return underCap ? tightCap() : shortTop();
    case 'long': {
      const top = underCap ? tightCap(LONG_LINE) : shell((az) => keyed(LONG_LINE, az), (az, pol) => 0.017 + 0.008 * topness(pol) + 0.006 * quiff(az, pol));
      return fuse([top, longBack()]);
    }
    case 'bun': {
      const b = underCap ? headPt(Math.PI, deg(112), 0.03) : headPt(Math.PI, deg(46), 0.032);
      return fuse([tightCap(), xf(ball(14, 10), b[0], b[1], b[2], 0, 0, 0, 0.05, 0.046, 0.05)]);
    }
    case 'curly':
      return underCap ? curls(deg(74)) : curls(0);
  }
}

// ───────────────────────────── accessories ─────────────────────────────

function buildGlasses(): THREE.BufferGeometry {
  const zf = EYE[2] + 0.017;
  const y = EYE[1] + 0.001;
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [1, -1]) {
    parts.push(xf(new THREE.TorusGeometry(0.027, 0.0034, 6, 22), side * (EYE[0] + 0.002), y, zf, 0, 0, 0, 1, 0.86, 1));
    // Temple arm from the rim back to the ear.
    const ear = headPt(side * EAR_AZ, Math.PI / 2, 0.004);
    const fx = side * (EYE[0] + 0.029);
    const dx = ear[0] - fx;
    const dz = ear[2] - zf;
    const len = Math.hypot(dx, dz);
    parts.push(xf(new THREE.BoxGeometry(0.004, 0.006, len), (fx + ear[0]) / 2, y + 0.006, (zf + ear[2]) / 2, 0, Math.atan2(dx, dz), 0));
  }
  parts.push(xf(new THREE.CylinderGeometry(0.003, 0.003, 0.03, 6), 0, y + 0.008, zf, 0, 0, Math.PI / 2));
  return fuse(parts);
}

/** Over-ear headphones sized to clear the hair: `top` is the band height above the head centre, `cupX` the ear-cup offset. */
function buildHeadphones(top: number, cupX: number): THREE.BufferGeometry {
  const cy = -0.006;
  const cz = -0.012;
  const band = new THREE.TorusGeometry(1, 0.075, 8, 28, Math.PI);
  const parts = [xf(band, 0, cy, cz, 0, 0, 0, cupX + 0.006, top - cy, 0.19)];
  for (const side of [1, -1]) {
    parts.push(xf(ball(14, 10), side * cupX, cy, cz, 0, 0, 0, 0.024, 0.044, 0.038));
    parts.push(xf(new THREE.CylinderGeometry(0.032, 0.036, 0.02, 16), side * (cupX + 0.016), cy, cz, 0, 0, Math.PI / 2));
  }
  return fuse(parts);
}

const CAP_LINE: [number, number][] = [[0, 63], [60, 75], [100, 84], [180, 87]];

function buildCap(): THREE.BufferGeometry {
  // A structured crown (taller front panel) with a crisp edge, and a flat, slightly curved peak.
  const crown = shell((az) => keyed(CAP_LINE, az), (az, pol) => 0.022 + 0.014 * Math.max(0, Math.cos(az)) ** 2 * Math.sin(pol), 36, 14, 0.004, 0.95);
  const A = deg(58);
  const m = 12;
  const steps = 7;
  const rings: number[][] = [];
  const brimPt = (az: number, r: number, top: boolean, ring: number[]) => {
    const b = headPt(az, keyed(CAP_LINE, az) - 0.05, 0.02);
    const w = Math.cos((az / A) * (Math.PI / 2));
    const ext = 0.118 * r * Math.pow(Math.max(0, w), 0.5);
    const th = 0.0045 * (1 - r * 0.4);
    ring.push(b[0] * (1 + 0.06 * r), b[1] - 0.014 * r - 0.01 * (az / A) ** 2 * r + (top ? th : -th), b[2] + ext);
  };
  for (let k = 0; k <= steps; k++) {
    const r = k / steps;
    const ring: number[] = [];
    for (let j = 0; j <= m; j++) brimPt(lerp(-A, A, j / m), r, true, ring);
    for (let j = m; j >= 0; j--) brimPt(lerp(-A, A, j / m), r, false, ring);
    rings.push(ring);
  }
  const brim = ringGeo(rings, false, true);
  const top = headPt(0, 0, 0.027);
  const button = xf(ball(8, 6), 0, top[1], top[2], 0, 0, 0, 0.012, 0.006, 0.012);
  return xf(fuse([crown, brim, button]), 0, 0.006, -0.002, -0.1, 0, 0);
}

// ───────────────────────────── body ─────────────────────────────

const TORSO_TUCKED: Sec[] = [
  [0.045, 0.15, 0.095, 0.0, 2.5],
  [0.11, 0.144, 0.092, 0.002, 2.5],
  [0.22, 0.15, 0.098, 0.004, 2.5],
  [0.33, 0.165, 0.106, 0.006, 2.5],
  [0.41, 0.175, 0.104, 0.004, 2.4],
  [0.455, 0.177, 0.097, 0.0, 2.4],
  [0.485, 0.158, 0.088, -0.003, 2.3],
  [0.508, 0.112, 0.076, -0.005, 2.1],
  [0.524, 0.072, 0.062, -0.007, 2],
  [0.535, 0.052, 0.052, -0.008, 2],
];
const TORSO_LOOSE: Sec[] = [
  [-0.05, 0.173, 0.113, -0.002, 2.5],
  [0.02, 0.171, 0.111, 0.0, 2.5],
  [0.11, 0.158, 0.103, 0.002, 2.5],
  [0.22, 0.156, 0.102, 0.004, 2.5],
  [0.33, 0.167, 0.108, 0.006, 2.5],
  [0.41, 0.177, 0.105, 0.004, 2.4],
  [0.455, 0.179, 0.098, 0.0, 2.4],
  [0.485, 0.16, 0.089, -0.003, 2.3],
  [0.508, 0.113, 0.076, -0.005, 2.1],
  [0.524, 0.072, 0.062, -0.007, 2],
  [0.535, 0.052, 0.052, -0.008, 2],
];
/** A tailored jacket: flared skirt over the seat, suppressed waist, full chest, square shoulders. */
const JACKET_HEM = -0.105;
const BUTTON_Y = 0.172;
const TORSO_JACKET: Sec[] = [
  [JACKET_HEM, 0.181, 0.124, -0.007, 2.7],
  [-0.03, 0.179, 0.122, -0.006, 2.7],
  [0.07, 0.167, 0.112, -0.003, 2.7],
  [0.17, 0.156, 0.103, 0.001, 2.6],
  [0.27, 0.164, 0.106, 0.004, 2.6],
  [0.36, 0.18, 0.112, 0.004, 2.5],
  [0.43, 0.19, 0.109, 0.002, 2.5],
  [0.468, 0.191, 0.1, -0.001, 2.5],
  [0.492, 0.172, 0.091, -0.003, 2.4],
  [0.51, 0.126, 0.08, -0.005, 2.2],
  [0.524, 0.08, 0.066, -0.007, 2],
  [0.535, 0.054, 0.053, -0.008, 2],
];
/**
 * The seat of the trousers. It swallows the tops of the thighs and closes under the crotch above the point where
 * the legs part, so what shows between the legs is their own inseam, never a panel.
 */
const PELVIS: Sec[] = [
  [-0.085, 0.03, 0.03, 0.0, 2],
  [-0.065, 0.09, 0.05, -0.004, 2.3],
  [-0.035, 0.14, 0.076, -0.006, 2.5],
  [0.0, 0.168, 0.097, -0.004, 2.5],
  [0.04, 0.167, 0.099, -0.001, 2.5],
  [0.068, 0.158, 0.097, 0.0, 2.5],
  [0.095, 0.125, 0.082, 0.0, 2.4],
];

/** Half width of the shirt showing between the lapels at height y. */
const vEdge = (y: number) => 0.003 + 0.064 * clamp01((y - 0.2) / 0.305);

/** A point on the front of a lofted body at (x, y), pushed out by `off`. */
function frontZ(rows: Sec[], x: number, y: number, off: number): number {
  const sec = secAt(rows, y);
  const u = Math.min(0.995, Math.abs(x) / sec[1]);
  return sec[3] + sec[2] * Math.pow(1 - Math.pow(u, sec[4]), 1 / sec[4]) + off;
}

/** Angles around the jacket (0 = the wearer's left, π/2 = front), denser where the front opens and where the back vent runs. */
function jacketAngles(): number[] {
  const out: number[] = [];
  const N = 40;
  for (let j = 0; j < N; j++) out.push((j / N) * TAU);
  const inv = (x: number) => Math.acos(Math.sign(x) * Math.pow(Math.abs(x) / 0.172, 1.3));
  for (const x of [0, 0.007, -0.007, 0.018, -0.018, 0.032, -0.032, 0.048, -0.048, 0.064, -0.064, 0.08, -0.08]) out.push(inv(x));
  for (const x of [0, 0.005, -0.005, 0.011, -0.011, 0.022, -0.022]) out.push(TAU - inv(x));
  out.sort((a, b) => a - b);
  const kept: number[] = [];
  for (const a of out) if (!kept.length || a - kept[kept.length - 1]! > 0.01) kept.push(a);
  return kept;
}

function buildJacket(): THREE.BufferGeometry {
  const fine = resample(TORSO_JACKET, 4);
  const angles = jacketAngles();
  // The first column is repeated at the end: the cloth's stripes need a seam (it sits under the left arm).
  angles.push(angles[0]! + TAU);
  const n = angles.length;
  const pos: number[] = [];
  const uv: number[] = [];
  // Stripes hang from the chest: each column keeps the stripe it has there.
  const chest = secAt(fine, 0.36);
  const us: number[] = [0];
  for (let j = 1; j < n; j++) {
    const a0 = angles[j - 1]!;
    const a1 = angles[j]!;
    us.push(us[j - 1]! + Math.hypot(chest[1] * (spow(Math.cos(a1), chest[4]) - spow(Math.cos(a0), chest[4])), chest[2] * (spow(Math.sin(a1), chest[4]) - spow(Math.sin(a0), chest[4]))));
  }
  const stripes = Math.round(us[n - 1]! / STRIPE);
  for (const row of fine) {
    for (let j = 0; j < n; j++) {
      const a = angles[j]!;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const x0 = row[1] * spow(c, row[4]);
      let y = row[0];
      if (sn > 0 && y < 0.2) {
        // Below the button the fronts are cut away in a curve, showing the trousers.
        const u = Math.min(1, Math.abs(x0) / 0.078);
        const edge = lerp(BUTTON_Y - 0.014, JACKET_HEM, Math.pow(u, 0.8));
        y = edge + ((y - JACKET_HEM) * (0.2 - edge)) / (0.2 - JACKET_HEM);
      } else if (sn < 0 && y < 0) {
        // The centre vent opens a little at the hem.
        const edge = JACKET_HEM + 0.045 * Math.max(0, 1 - Math.abs(x0) / 0.014);
        y = edge + ((y - JACKET_HEM) * (0 - edge)) / (0 - JACKET_HEM);
      }
      const sec = y === row[0] ? row : secAt(fine, y);
      const x = sec[1] * spow(c, sec[4]);
      let z = sec[3] + sec[2] * spow(sn, sec[4]);
      if (sn < 0) {
        // Vent below the waist, a faint centre seam above it.
        const depth = lerp(0.013, 0.002, smooth(0.06, 0.13, y)) * (1 - smooth(0.38, 0.46, y));
        z += depth * Math.exp(-((x / 0.009) ** 2));
        // One side of the vent laps over the other.
        if (x > 0 && y < 0.1) z -= 0.007 * (1 - smooth(0.04, 0.1, y)) * Math.max(0, 1 - x / 0.04);
      }
      pos.push(x, y, z);
      uv.push((us[j]! / us[n - 1]!) * stripes, row[0]);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < fine.length - 1; i++) {
    for (let j = 0; j < n - 1; j++) {
      const a = i * n + j;
      idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  orient(g);
  // Both sides of the seam share one normal.
  const nor = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let i = 0; i < fine.length; i++) {
    const a = i * n;
    const b = a + n - 1;
    const x = nor.getX(a) + nor.getX(b);
    const y = nor.getY(a) + nor.getY(b);
    const z = nor.getZ(a) + nor.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    nor.setXYZ(a, x / l, y / l, z / l);
    nor.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

/** Give a body part cloth coordinates as seen from the front, so a suit's stripes run down it. */
function striped(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = pos.getX(i) / STRIPE;
    uv[i * 2 + 1] = pos.getY(i);
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** A patch from a grid of points, with its triangles facing (dx, dy, dz). */
function grid(nu: number, nv: number, at: (i: number, j: number, out: number[]) => void, dx: number, dy: number, dz: number, slant = 0): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) at(i, j, pos);
  // Cloth stripes run straight down the patch, or at a slant (a lapel is the jacket's front folded back).
  const uv: number[] = [];
  for (let i = 0; i < pos.length; i += 3) uv.push((pos[i]! * Math.cos(slant) + pos[i + 1]! * Math.sin(slant)) / STRIPE, pos[i + 1]!);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const a = i * (nv + 1) + j;
      const b = a + 1;
      const c = a + nv + 1;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  let dot = 0;
  for (let i = 0; i < n.count; i++) dot += n.getX(i) * dx + n.getY(i) * dy + n.getZ(i) * dz;
  if (dot < 0) {
    const a = g.index!.array as Uint16Array | Uint32Array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1]!;
      a[i + 1] = a[i + 2]!;
      a[i + 2] = t;
    }
    g.computeVertexNormals();
  }
  return g;
}

/** A notch lapel: rolled where it folds back from the shirt, widening to a peak at the chest, stepping in where the collar takes over. */
function buildLapel(rows: Sec[], side: 1 | -1): THREE.BufferGeometry {
  const ys: number[] = [];
  const ws: number[] = [];
  const N = 12;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    ys.push(lerp(0.19, 0.428, t));
    ws.push(0.004 + 0.05 * Math.pow(Math.sin((t * Math.PI) / 2), 0.8));
  }
  ys.push(0.43, 0.45, 0.472, 0.494);
  ws.push(0.03, 0.033, 0.034, 0.03);
  const nx = 4;
  return grid(
    ys.length - 1,
    nx,
    (i, j, out) => {
      const y = ys[i]!;
      const u = j / nx;
      const x = vEdge(y) - 0.004 + ws[i]! * u;
      out.push(side * x, y, frontZ(rows, x, y, lerp(0.0105, 0.0045, Math.pow(u, 0.7))));
    },
    0,
    0,
    1,
    side * 0.42,
  );
}

/** The jacket's own collar: a band standing round the back and sides of the neck, leaving a rim of shirt collar above it. */
function buildJacketCollar(): THREE.BufferGeometry {
  const seg = 30;
  const gap = 0.8;
  const prof: [number, number, number][] = [
    [0.1, 0.088, 0.008],
    [0.09, 0.08, 0.027],
    [0.0775, 0.072, 0.05],
    [0.069, 0.064, 0.044],
  ];
  return grid(
    prof.length - 1,
    seg,
    (i, j, out) => {
      const a = lerp(Math.PI / 2 + gap, Math.PI / 2 - gap + TAU, j / seg);
      const end = smooth(0, 1, Math.min(j, seg - j) / 3);
      const p = prof[i]!;
      out.push(p[0] * Math.cos(a), 0.487 + p[2] * end, -0.005 + p[1] * Math.sin(a));
    },
    0,
    0.3,
    -1,
  );
}

/** A strip lying on a lofted body between two angles and two heights (pocket flaps). */
function wrapPatch(rows: Sec[], a0: number, a1: number, y0: number, y1: number, off: number): THREE.BufferGeometry {
  const am = (a0 + a1) / 2;
  return grid(
    2,
    8,
    (i, j, out) => {
      const y = lerp(y0, y1, i / 2);
      const a = lerp(a0, a1, j / 8);
      const sec = secAt(rows, y);
      const x = sec[1] * spow(Math.cos(a), sec[4]);
      const z = sec[3] + sec[2] * spow(Math.sin(a), sec[4]);
      const r = Math.hypot(x, z) || 1;
      out.push(x * (1 + off / r), y, z * (1 + off / r));
    },
    Math.cos(am),
    0,
    Math.sin(am),
  );
}

function buildCollar(): THREE.BufferGeometry {
  const seg = 28;
  const rings: number[][] = [[], [], []];
  for (let j = 0; j < seg; j++) {
    const a = (j / seg) * TAU;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const d = a - Math.PI / 2;
    const dip = 0.04 * Math.exp(-(d * d) / 0.1);
    rings[0]!.push(0.094 * c, 0.498 - dip * 0.6, -0.004 + 0.078 * s);
    rings[1]!.push(0.064 * c, 0.554 - dip * 1.25, -0.006 + 0.06 * s);
    rings[2]!.push(0.052 * c, 0.534 - dip, -0.006 + 0.05 * s);
  }
  return ringGeo(rings, false, false);
}

function buildCrewNeck(): THREE.BufferGeometry {
  return loft(
    [
      [0.514, 0.08, 0.07, -0.006, 2],
      [0.532, 0.073, 0.066, -0.006, 2],
      [0.541, 0.061, 0.057, -0.006, 2],
      [0.534, 0.053, 0.05, -0.006, 2],
    ],
    2,
    24,
    false,
    false,
  );
}

/** Sole profile along the foot: z, half width, underside, top. The heel is a block; the arch lifts off the floor. */
const SOLE: [number, number, number, number][] = [
  [-0.072, 0.014, -0.08, -0.056],
  [-0.067, 0.033, -0.08, -0.056],
  [-0.04, 0.0415, -0.08, -0.056],
  [-0.014, 0.0415, -0.08, -0.057],
  [-0.006, 0.04, -0.069, -0.058],
  [0.026, 0.042, -0.072, -0.061],
  [0.05, 0.047, -0.08, -0.066],
  [0.09, 0.052, -0.08, -0.067],
  [0.13, 0.05, -0.08, -0.068],
  [0.158, 0.04, -0.079, -0.068],
  [0.172, 0.022, -0.077, -0.068],
  [0.177, 0.007, -0.075, -0.069],
];

function soleTop(z: number): number {
  for (let i = 0; i < SOLE.length - 1; i++) {
    const a = SOLE[i]!;
    const b = SOLE[i + 1]!;
    if (z <= b[0]) return lerp(a[3], b[3], clamp01((z - a[0]) / (b[0] - a[0])));
  }
  return SOLE[SOLE.length - 1]![3];
}

/** The upper of a shoe, relative to the ankle joint: a firm heel counter, a low vamp, an almond toe. */
function buildShoe(): THREE.BufferGeometry {
  // z, half width, top
  const cuts: [number, number, number][] = [
    [-0.067, 0.012, -0.034],
    [-0.063, 0.029, -0.014],
    [-0.046, 0.038, -0.004],
    [-0.016, 0.0405, 0.0],
    [0.014, 0.0415, -0.007],
    [0.044, 0.045, -0.023],
    [0.08, 0.0485, -0.035],
    [0.115, 0.047, -0.044],
    [0.145, 0.038, -0.051],
    [0.162, 0.024, -0.057],
    [0.171, 0.007, -0.062],
  ];
  const seg = 18;
  const rings = cuts.map(([z, w, top]) => {
    const base = soleTop(z) - 0.003;
    const ring: number[] = [];
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * TAU;
      const sn = Math.sin(a);
      ring.push(w * spow(Math.cos(a), 2.7), sn >= 0 ? base + (top - base) * spow(sn, 2.2) : base + 0.004 * sn, z);
    }
    return ring;
  });
  return ringGeo(rings, true, true);
}

/** Sole and heel, plus the sock that fills the ankle between shoe and trouser hem. */
function buildSole(): THREE.BufferGeometry {
  const seg = 16;
  const rings = SOLE.map(([z, w, lo, hi]) => {
    const mid = (lo + hi) / 2;
    const half = (hi - lo) / 2;
    const ring: number[] = [];
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * TAU;
      ring.push(w * 1.05 * spow(Math.cos(a), 5), mid + half * spow(Math.sin(a), 5), z);
    }
    return ring;
  });
  return fuse([ringGeo(rings, true, true), xf(ball(12, 8), 0, 0.002, -0.006, 0, 0, 0, 0.041, 0.046, 0.046)]);
}

/** Mirror a (non-indexed) geometry left to right, keeping its faces outward. */
function mirrorX(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = src.index ? src.toNonIndexed() : src.clone();
  for (const name of ['position', 'normal']) {
    const at = g.getAttribute(name) as THREE.BufferAttribute;
    const a = at.array as Float32Array;
    for (let i = 0; i < a.length; i += 9) {
      a[i] = -a[i]!;
      a[i + 3] = -a[i + 3]!;
      a[i + 6] = -a[i + 6]!;
      for (let k = 0; k < 3; k++) {
        const t = a[i + 3 + k]!;
        a[i + 3 + k] = a[i + 6 + k]!;
        a[i + 6 + k] = t;
      }
    }
  }
  return g;
}

/**
 * A relaxed left hand hanging from the wrist: palm toward the body (−x), thumb forward (+z), four fingers
 * curling in from a row of knuckles. The right hand is its mirror image.
 */
function buildHand(): THREE.BufferGeometry {
  const bone = (r1: number, r2: number, len: number) => limb(r1, r2, len, { seg: 6, rows: 1, capRows: 2 });
  const parts: THREE.BufferGeometry[] = [
    loft(
      [
        [0.008, 0.0165, 0.0225, 0.0, 2.2],
        [-0.012, 0.0158, 0.029, 0.0015, 2.5],
        [-0.032, 0.0142, 0.0345, 0.002, 2.8],
        [-0.05, 0.0125, 0.035, 0.001, 2.8],
        [-0.059, 0.0085, 0.032, 0.0, 2.6],
      ],
      2,
      12,
    ),
    // Heel of the thumb.
    xf(ball(8, 6), -0.005, -0.024, 0.024, 0, 0, 0, 0.0115, 0.021, 0.014),
  ];
  // z across the palm, knuckle height, bone lengths, thickness, curl
  const fingers: [number, number, number, number, number, number][] = [
    [0.0255, -0.052, 0.03, 0.023, 0.0083, 0.22],
    [0.0088, -0.055, 0.033, 0.026, 0.0086, 0.27],
    [-0.0082, -0.0535, 0.031, 0.024, 0.0082, 0.33],
    [-0.0238, -0.049, 0.025, 0.02, 0.0073, 0.4],
  ];
  for (const [z, y, l1, l2, r, curl] of fingers) {
    parts.push(xf(ball(6, 4), 0.0035, y + 0.003, z, 0, 0, 0, r * 1.12));
    parts.push(xf(bone(r, r * 0.92, l1), 0, y, z, 0, 0, -curl));
    parts.push(xf(bone(r * 0.92, r * 0.78, l2), -Math.sin(curl) * l1, y - Math.cos(curl) * l1, z, 0, 0, -curl - 0.6));
  }
  const tl = 0.03;
  parts.push(xf(bone(0.0105, 0.009, tl), -0.004, -0.014, 0.03, -0.8, 0, 0));
  parts.push(xf(bone(0.009, 0.0072, 0.027), -0.004, -0.014 - Math.cos(0.8) * tl, 0.03 + Math.sin(0.8) * tl, -0.42, 0, -0.25));
  return fuse(parts);
}

/** A whip coiled for carrying: three loops of lash, the handle hanging through them. Lies in the YZ plane (against a hip). */
function buildCoil(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    const t = new THREE.TorusGeometry(0.07 - i * 0.006, 0.0075 - i * 0.001, 6, 22);
    parts.push(xf(t, -i * 0.008, 0.005 * i, 0.004 * (i - 1), 0.12 * (i - 1), Math.PI / 2, 0));
  }
  parts.push(xf(new THREE.CylinderGeometry(0.0125, 0.0105, HANDLE_LEN, 8), -0.012, 0.015, 0.012, 0.35, 0, 0));
  parts.push(xf(ball(8, 6), -0.012, 0.015 + Math.cos(0.35) * HANDLE_LEN * 0.5, 0.012 + Math.sin(0.35) * HANDLE_LEN * 0.5, 0, 0, 0, 0.0155));
  return fuse(parts);
}

function buildSpark(): THREE.BufferGeometry {
  const o = () => new THREE.OctahedronGeometry(1, 0);
  return fuse([xf(o(), 0, 0, 0, 0, 0, 0, 1, 0.13, 0.13), xf(o(), 0, 0, 0, 0, 0, 0, 0.13, 1, 0.13), xf(o(), 0, 0, 0, 0, 0, 0.8, 0.7, 0.1, 0.1), xf(o(), 0, 0, 0, 0, 0, -0.8, 0.7, 0.1, 0.1)]);
}

interface Geos {
  head: THREE.BufferGeometry;
  eyes: THREE.BufferGeometry;
  brows: THREE.BufferGeometry;
  mouth: THREE.BufferGeometry;
  neck: THREE.BufferGeometry;
  torsoTucked: THREE.BufferGeometry;
  torsoLoose: THREE.BufferGeometry;
  torsoJacket: THREE.BufferGeometry;
  pelvis: THREE.BufferGeometry;
  belt: THREE.BufferGeometry;
  collar: THREE.BufferGeometry;
  collarPlacket: THREE.BufferGeometry;
  crew: THREE.BufferGeometry;
  suitShirt: THREE.BufferGeometry;
  suitLapels: THREE.BufferGeometry;
  suitButtons: THREE.BufferGeometry;
  sleeveButtons: THREE.BufferGeometry;
  tie: THREE.BufferGeometry;
  sleeveShort: THREE.BufferGeometry;
  /** Skinned limbs, left and right: bare arm, sleeved arm, trouser leg. */
  armL: THREE.BufferGeometry;
  armR: THREE.BufferGeometry;
  sleeveL: THREE.BufferGeometry;
  sleeveR: THREE.BufferGeometry;
  legL: THREE.BufferGeometry;
  legR: THREE.BufferGeometry;
  cuff: THREE.BufferGeometry;
  handL: THREE.BufferGeometry;
  handR: THREE.BufferGeometry;
  shoe: THREE.BufferGeometry;
  sole: THREE.BufferGeometry;
  badge: THREE.BufferGeometry;
  glasses: THREE.BufferGeometry;
  cap: THREE.BufferGeometry;
  coil: THREE.BufferGeometry;
  spark: THREE.BufferGeometry;
}

let GEOS: Geos | null = null;

/** Built once, on first use, and shared by every character. */
function geos(): Geos {
  if (GEOS) return GEOS;
  const tucked = resample(TORSO_TUCKED, 3);
  const jacket = resample(TORSO_JACKET, 4);
  const collar = buildCollar();
  const knotZ = frontZ(jacket, 0, 0.487, 0.0105);
  const tieKnot = xf(ball(8, 6), 0, 0.487, knotZ, 0, 0, 0, 0.0155, 0.0145, 0.008);
  const cuffPts = [new THREE.Vector2(0.0001, -0.236), new THREE.Vector2(0.031, -0.236), new THREE.Vector2(0.0338, -0.231), new THREE.Vector2(0.0348, -0.2)];
  const sleeveButtons: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) sleeveButtons.push(xf(ball(6, 4), 0, -0.168 - i * 0.014, -0.0405, 0, 0, 0, 0.0052, 0.0052, 0.003));
  const hand = buildHand();
  const bareArm = jointed(0.045, 0.0385, 0.031, UPPER_ARM, 0.23, 0.03, { cap: 0.8, bulge: 0.003 });
  const sleeve = jointed(0.055, 0.047, 0.039, UPPER_ARM, 0.214, 0.032, { flat: true, cap: 0.62 });
  const trouser = jointed(0.088, 0.0675, 0.062, THIGH, SHIN - 0.012, 0.045, { flat: true, seg: 18 });
  GEOS = {
    head: buildHead(),
    eyes: buildEyes(),
    brows: buildBrows(),
    mouth: buildMouth(),
    neck: xf(new THREE.CylinderGeometry(0.046, 0.053, 0.14, 14), 0, 0.565, -0.004, 0.06, 0, 0),
    torsoTucked: loft(TORSO_TUCKED),
    torsoLoose: loft(TORSO_LOOSE),
    torsoJacket: buildJacket(),
    pelvis: striped(loft(PELVIS, 3, 32)),
    belt: loft(
      [
        [0.043, 0.172, 0.1045, 0, 2.5],
        [0.076, 0.169, 0.1035, 0, 2.5],
      ],
      1,
      32,
    ),
    collar,
    collarPlacket: fuse([collar.clone(), frontPatch(tucked, 0.06, 0.485, () => 0.011, 0.0025)]),
    crew: buildCrewNeck(),
    // Shirt collar, the shirt front between the lapels, and the shirt at the waist behind the jacket's cut-away fronts.
    suitShirt: fuse([
      collar.clone(),
      frontPatch(jacket, 0.2, 0.532, (t) => Math.min(vEdge(lerp(0.2, 0.532, t)) + 0.004, secAt(jacket, lerp(0.2, 0.532, t))[1] * 0.9), 0.004, 14),
      frontPatch(jacket, 0.06, 0.2, () => 0.09, -0.012),
    ]),
    suitLapels: fuse([
      buildLapel(jacket, 1),
      buildLapel(jacket, -1),
      buildJacketCollar(),
      wrapPatch(jacket, Math.PI / 2 - 1.22, Math.PI / 2 - 0.5, 0.002, 0.034, 0.0035),
      wrapPatch(jacket, Math.PI / 2 + 0.5, Math.PI / 2 + 1.22, 0.002, 0.034, 0.0035),
    ]),
    // The front button, and the shadow inside the back vent.
    suitButtons: fuse([
      xf(ball(10, 6), 0, BUTTON_Y + 0.006, frontZ(jacket, 0, BUTTON_Y + 0.006, 0.003), 0, 0, 0, 0.009, 0.009, 0.0045),
      wrapPatch(jacket, Math.PI * 1.5 - 0.0045, Math.PI * 1.5 + 0.0005, JACKET_HEM + 0.03, 0.07, -0.002),
    ]),
    sleeveButtons: fuse(sleeveButtons),
    tie: fuse([frontPatch(jacket, 0.2, 0.486, (t) => lerp(0.021, 0.0115, t), 0.0075, 10, 2), tieKnot]),
    sleeveShort: limb(0.055, 0.052, 0.12, { flat: true, cap: 0.72 }),
    armL: onBones(bareArm, 4, 5),
    armR: onBones(bareArm, 6, 7),
    sleeveL: onBones(sleeve, 4, 5),
    sleeveR: onBones(sleeve, 6, 7),
    legL: onBones(trouser, 0, 1),
    legR: onBones(trouser, 2, 3),
    cuff: new THREE.LatheGeometry(cuffPts, 14),
    handL: hand,
    handR: mirrorX(hand),
    shoe: buildShoe(),
    sole: buildSole(),
    badge: new RoundedBoxGeometry(0.044, 0.028, 0.012, 2, 0.005),
    glasses: buildGlasses(),
    cap: buildCap(),
    coil: buildCoil(),
    spark: buildSpark(),
  };
  return GEOS;
}

const HAIR_CACHE = new Map<string, THREE.BufferGeometry | null>();
function hairGeo(style: HairStyle, underCap: boolean): THREE.BufferGeometry | null {
  const key = `${style}|${underCap ? 1 : 0}`;
  if (!HAIR_CACHE.has(key)) HAIR_CACHE.set(key, buildHair(style, underCap));
  return HAIR_CACHE.get(key) ?? null;
}

let FADE: THREE.BufferGeometry | null = null;
const fadeGeo = () => (FADE ??= shortFade());

const PHONES_CACHE = new Map<HairStyle, THREE.BufferGeometry>();
function headphonesGeo(style: HairStyle): THREE.BufferGeometry {
  let g = PHONES_CACHE.get(style);
  if (!g) {
    g = style === 'curly' ? buildHeadphones(0.188, 0.118) : style === 'long' ? buildHeadphones(0.166, 0.127) : style === 'bald' ? buildHeadphones(0.134, 0.106) : buildHeadphones(0.16, 0.112);
    PHONES_CACHE.set(style, g);
  }
  return g;
}

// ───────────────────────────── materials ─────────────────────────────

const GREY = new THREE.Color('#6b7280');
const WHITE = new THREE.Color('#ffffff');
const BLACK = new THREE.Color('#000000');
const MATS = new Map<string, THREE.MeshStandardMaterial>();

/** How far someone without a live session is washed toward grey: dimmed, but still plainly themselves. */
const DIM = 0.26;

/** Shared material per colour. `shade` < 0 darkens, > 0 lightens; `toward` blends in a second colour first; offline characters are dimmed slightly toward grey. */
function mat(hex: string, rough: number, offline: boolean, shade = 0, decal = false, toward = '', mix = 0, stripe = false): THREE.MeshStandardMaterial {
  const key = `${hex}|${rough}|${offline ? 1 : 0}|${shade}|${decal ? 1 : 0}|${toward}|${mix}|${stripe ? 1 : 0}`;
  let m = MATS.get(key);
  if (!m) {
    const c = new THREE.Color(hex);
    if (toward) c.lerp(new THREE.Color(toward), mix);
    if (shade < 0) c.lerp(BLACK, -shade);
    else if (shade > 0) c.lerp(WHITE, shade);
    if (offline) c.lerp(GREY, DIM);
    m = new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: 0 });
    if (stripe) {
      // The cloth texture is darker than white between its stripes: lift the colour so the ground stays the colour asked for.
      m.map = stripeTexture();
      m.color.multiplyScalar(1 / 0.584);
    }
    if (decal) {
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
function stripeTexture(): THREE.Texture {
  if (STRIPES) return STRIPES;
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

const BADGE_MATS = new Map<string, THREE.MeshStandardMaterial>();
function badgeMat(level: number, offline: boolean): THREE.MeshStandardMaterial {
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
const sparkMat = () => (SPARK_MAT ??= new THREE.MeshBasicMaterial({ color: '#fff6d8', toneMapped: false }));

let ZZZ: THREE.Texture | null = null;
/** A hand-drawn "Z" (white, dark outline) for the letters that drift up from a sleeper. */
function zTexture(): THREE.Texture {
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
/** How many letters are in the air at once, how long each one lives (seconds) and how far it rises (metres). */
const Z_COUNT = 3;
const Z_LIFE = 3.6;
const Z_RISE = 0.5;
const NO_RAYCAST = () => null;
const Z_LETTERS = Array.from({ length: Z_COUNT }, (_v, i) => i);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

type Outfit = 'polo' | 'tee' | 'shirt' | 'sweater' | 'suit';
const OUTFITS: Outfit[] = ['polo', 'shirt', 'tee', 'sweater'];
const TIES = ['#a8323e', '#2f6fb5', '#3d7f5a', '#7d55b8'];
const SHOES = ['#22252c', '#4a3122', '#2b2f3a', '#e6e3dc'];

// ───────────────────────────── component ─────────────────────────────

interface CharacterProps {
  appearance: Appearance;
  pose: PoseName;
  /** Greyed out: no live session behind this employee. */
  offline?: boolean;
  /** Extra head yaw toward a point of interest (e.g. the boss when asking a question). Read every frame. */
  look?: { current: number };
  level?: number;
  phase?: number;
  /** Skip per-frame animation for characters far from the camera. */
  frozen?: () => boolean;
  /**
   * How the character is moving while on its feet, read every frame. Without it the character measures its own
   * movement through the world, so anything that moves a standing character makes it walk.
   */
  motion?: { current: Motion };
  /** Change this to restart a one-shot pose ('ouch', 'whip') while the pose name stays the same. */
  cue?: number;
  /** Carries a whip: coiled at the right hip, in the right hand during the 'whip' pose. */
  whip?: boolean;
  /** Overrides for details the appearance does not cover. */
  detail?: { tie?: string; shoes?: string };
}

/** The gold pin sits on the left lapel. */
const PIN_Z = frontZ(TORSO_JACKET, 0.079, 0.412, 0.0125);
/** Bones of a character's skeleton, in order: left hip, left knee, right hip, right knee, left shoulder, left elbow, right shoulder, right elbow. */
const BONE_INVERSES = [0, THIGH, 0, THIGH, 0, UPPER_ARM, 0, UPPER_ARM].map((up) => new THREE.Matrix4().makeTranslation(0, up, 0));
const IDENTITY = new THREE.Matrix4();
/** Generous bounds for a skinned limb in any pose (its own are only ever computed for one pose). */
const LIMB_BOUNDS = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1);
const TARGET = newPose();
/** Half-life of the offset left over from a change of pose, seconds. */
const BLEND_HALF = 0.12;
/** Falling asleep and waking up take about a second: the part of the body that leads, and the part that follows. */
const SLEEP_LEAD = 0.17;
const SLEEP_FOLLOW = 0.3;
/** Pose values that belong to the arms (the rest is the trunk, the head and the legs). */
const ARM_KEY = POSE_KEYS.map((k) => k === 'sLx' || k === 'sLz' || k === 'tL' || k === 'eL' || k === 'sRx' || k === 'sRz' || k === 'tR' || k === 'eR');
const sleeping = (p: PoseName | null) => p === 'offline' || p === 'doze';
const TMP_M = new THREE.Matrix4();
const TMP_A = new THREE.Vector3();
const TMP_B = new THREE.Vector3();
const TMP_Q = new THREE.Quaternion();
const TMP_R = new THREE.Quaternion();
const TMP_E = new THREE.Euler();
const X_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * The foot at the end of a leg: whichever way the hip is flexed, spread and turned and the knee bent, the sole ends up
 * pointing where the leg was turned to and tipped only heel-to-toe — flat on the floor, never rolled onto its edge.
 */
function levelFoot(foot: THREE.Group | null, flex: number, abd: number, yaw: number, knee: number, ankle: number): void {
  if (!foot) return;
  TMP_Q.setFromEuler(TMP_E.set(flex, yaw, abd, 'ZXY')).multiply(TMP_R.setFromAxisAngle(X_AXIS, knee)).invert();
  foot.quaternion.copy(TMP_Q.multiply(TMP_R.setFromEuler(TMP_E.set(ankle + flex + knee, yaw, 0, 'YXZ'))));
}

interface Anim {
  cur: Pose;
  off: Float32Array;
  offV: Float32Array;
  vel: Float32Array;
  loco: Loco;
  applied: PoseName | null;
  /** The pose a one-shot reaction is layered over. */
  base: PoseName;
  prevBase: PoseName | null;
  cue: number | undefined;
  /** Seconds since the pose (or the cue) last changed. */
  since: number;
  /** How fast what is left of the previous pose dies away, per pose value (1/s). */
  rate: Float32Array;
  /** 0 awake … 1 asleep, eased: drives the breathing and the letters. */
  sleep: number;
}

export function Character({ appearance, pose, offline = false, look, level = 1, phase = 0, frozen, motion, cue, whip = false, detail }: CharacterProps) {
  const outer = useRef<THREE.Group>(null);
  const root = useRef<THREE.Group>(null);
  const hips = useRef<THREE.Group>(null);
  const pelvis = useRef<THREE.Group>(null);
  const spine = useRef<THREE.Group>(null);
  const chest = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const eyes = useRef<THREE.Mesh>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const sL = useRef<THREE.Group>(null);
  const sR = useRef<THREE.Group>(null);
  const eL = useRef<THREE.Group>(null);
  const eR = useRef<THREE.Group>(null);
  const handL = useRef<THREE.Group>(null);
  const handR = useRef<THREE.Group>(null);
  const hL = useRef<THREE.Group>(null);
  const hR = useRef<THREE.Group>(null);
  const kL = useRef<THREE.Group>(null);
  const kR = useRef<THREE.Group>(null);
  const fL = useRef<THREE.Group>(null);
  const fR = useRef<THREE.Group>(null);
  const legLm = useRef<THREE.SkinnedMesh>(null);
  const legRm = useRef<THREE.SkinnedMesh>(null);
  const armLm = useRef<THREE.SkinnedMesh>(null);
  const armRm = useRef<THREE.SkinnedMesh>(null);
  const coil = useRef<THREE.Mesh>(null);
  const lash = useRef<THREE.Mesh>(null);
  const spark = useRef<THREE.Mesh>(null);
  const zzz = useRef<THREE.Group>(null);
  const anim = useRef<Anim | null>(null);
  const poseRef = useRef(pose);
  poseRef.current = pose;
  const cueRef = useRef(cue);
  cueRef.current = cue;
  const build = appearance.build || 1;

  const look3d = useMemo(() => {
    const g = geos();
    const seed = hash(`${appearance.skin}${appearance.hair}${appearance.shirt}${appearance.pants}${appearance.hairStyle}${appearance.accessory}`);
    const outfit: Outfit = level >= 8 ? 'suit' : OUTFITS[seed % OUTFITS.length]!;
    const longSleeves = outfit === 'shirt' || outfit === 'sweater' || outfit === 'suit';
    const tucked = outfit === 'polo' || outfit === 'shirt';
    const casual = outfit === 'tee' || outfit === 'sweater';
    const cap = appearance.accessory === 'cap';
    const shoeHex = detail?.shoes ?? (outfit === 'suit' ? SHOES[0]! : SHOES[(seed >>> 3) % (casual ? 4 : 3)]!);
    const lightShoe = new THREE.Color(shoeHex).getHSL({ h: 0, s: 0, l: 0 }).l > 0.6;
    return {
      g,
      outfit,
      longSleeves,
      tucked,
      torso: outfit === 'suit' ? g.torsoJacket : tucked ? g.torsoTucked : g.torsoLoose,
      trimGeo: outfit === 'suit' ? g.suitShirt : outfit === 'shirt' ? g.collarPlacket : outfit === 'polo' ? g.collar : g.crew,
      hair: hairGeo(appearance.hairStyle, cap),
      fade: appearance.hairStyle === 'short' && !cap ? fadeGeo() : null,
      phones: appearance.accessory === 'headphones' ? headphonesGeo(appearance.hairStyle) : null,
      skin: mat(appearance.skin, 0.62, offline),
      hairMat: mat(appearance.hair, 0.6, offline),
      fadeMat: mat(appearance.hair, 0.8, offline, 0, false, appearance.skin, 0.14),
      brow: mat(appearance.hair, 0.8, offline, -0.25),
      shirt: outfit === 'suit' ? mat(appearance.shirt, 0.72, offline, 0, false, '', 0, true) : mat(appearance.shirt, 0.82, offline),
      trim: outfit === 'suit' ? mat('#f1f1ee', 0.7, offline, 0, true) : mat(appearance.shirt, 0.8, offline, outfit === 'tee' || outfit === 'sweater' ? -0.2 : 0.1, true),
      lapel: mat(appearance.shirt, 0.62, offline, 0.035, true, '', 0, true),
      tie: mat(detail?.tie ?? TIES[seed % TIES.length]!, 0.5, offline, 0, true),
      pants: outfit === 'suit' ? mat(appearance.pants, 0.74, offline, 0, false, '', 0, true) : mat(appearance.pants, 0.86, offline),
      belt: mat('#2a2622', 0.5, offline),
      shoe: mat(shoeHex, 0.38, offline),
      sole: mat(lightShoe ? '#b9b3a6' : '#0f1013', 0.7, offline),
      dark: mat('#181b22', 0.35, offline),
      eye: mat('#1c1512', 0.2, offline),
      mouth: mat(appearance.skin, 0.6, offline, -0.5),
      capMat: mat(appearance.shirt, 0.8, offline, -0.12),
      leather: mat('#5a3519', 0.55, offline),
      badge: badgeMat(level, offline),
    };
  }, [appearance.skin, appearance.hair, appearance.shirt, appearance.pants, appearance.hairStyle, appearance.accessory, offline, level, detail?.tie, detail?.shoes]);

  // Arms and legs are each one skinned surface; the joints of this rig are their bones.
  useLayoutEffect(() => {
    const bones = [hL, kL, hR, kR, sL, eL, sR, eR].map((r) => r.current) as unknown as THREE.Bone[];
    const skeleton = new THREE.Skeleton(bones, BONE_INVERSES);
    for (const r of [legLm, legRm, armLm, armRm]) {
      const mesh = r.current;
      if (!mesh) continue;
      mesh.bind(skeleton, IDENTITY);
      mesh.boundingSphere = LIMB_BOUNDS;
    }
    return () => skeleton.dispose();
  }, []);

  // The lash is the one geometry that is not shared: its shape changes every frame of a swing.
  const lashGeo = useMemo(() => (whip ? lashGeometry() : null), [whip]);

  useFrame((state, rawDt) => {
    const name = poseRef.current;
    const isFrozen = frozen?.() ?? false;
    let A = anim.current;
    // Far away: hold the last pose, but still snap once if the pose itself changed.
    if (isFrozen && A && A.applied === name && A.cue === cueRef.current) {
      // Nothing hangs in the air over someone who is not being animated.
      if (zzz.current) zzz.current.visible = false;
      return;
    }
    if (!A) A = anim.current = { cur: newPose(), off: new Float32Array(NKEYS), offV: new Float32Array(NKEYS), vel: new Float32Array(NKEYS), loco: newLoco(), applied: null, base: 'still', prevBase: null, cue: undefined, since: 0, rate: new Float32Array(NKEYS).fill(1.386 / BLEND_HALF), sleep: sleeping(name) ? 1 : 0 };
    const dt = Math.min(rawDt, 0.05);
    const t = state.clock.elapsedTime;
    const first = A.applied === null;
    const changed = first || A.applied !== name || A.cue !== cueRef.current;
    A.since = changed ? 0 : A.since + dt;
    const reaction = name === 'ouch' || name === 'whip';
    if (!reaction) A.base = name;
    else if (first) A.base = name === 'whip' ? 'stand' : 'still';
    const base = A.base;
    const L = A.loco;

    // ── the pose this frame ──
    if (base === 'walk' || base === 'stand' || base === 'doze') {
      let vx = 0;
      let vz = 0;
      let turn = 0;
      let run: boolean | null = null;
      if (motion) {
        const m = motion.current;
        vx = m.vx;
        vz = m.vz;
        turn = m.turn;
        run = m.run;
      } else if (outer.current && dt > 1e-4) {
        // Nobody told us how we are moving: read it off our own transform (as rendered last frame).
        const e = outer.current.matrixWorld.elements;
        const wx = e[12]!;
        const wz = e[14]!;
        const yaw = Math.atan2(e[8]!, e[10]!);
        if (L.has) {
          const dx = wx - L.px;
          const dz = wz - L.pz;
          const dyaw = wrapPi(yaw - L.yaw);
          // A jump is a teleport, not a sprint.
          if (dx * dx + dz * dz < 0.3 && Math.abs(dyaw) < 0.3) {
            const sy = Math.sin(yaw);
            const cy = Math.cos(yaw);
            vx = (dx * cy - dz * sy) / dt;
            vz = (dx * sy + dz * cy) / dt;
            turn = dyaw / dt;
          }
        }
        L.px = wx;
        L.pz = wz;
        L.yaw = yaw;
        L.has = true;
      }
      if (isFrozen) {
        L.has = false;
        L.fresh = true;
      }
      stepLoco(L, dt, vx / build, vz / build, turn, run);
      upright(TARGET, t, phase, L);
      if (base === 'doze') doze(TARGET, t, phase);
    } else {
      if (L.amp !== 0 || L.has) {
        L.has = false;
        L.fresh = true;
        L.amp = L.run = L.vx = L.vz = L.sx = L.sz = L.turn = L.face = L.speed = 0;
      }
      poseAt(base, t, phase, TARGET, build);
    }
    if (name === 'ouch') ouch(TARGET, A.since);
    else if (name === 'whip') whipArm(TARGET, A.since);
    if (look) TARGET.headYaw += look.current;

    // ── blend: what is left of the previous pose rides on top of the new one and dies away ──
    const c = A.cur;
    if (first || isFrozen) {
      for (let i = 0; i < NKEYS; i++) {
        c[POSE_KEYS[i]!] = TARGET[POSE_KEYS[i]!];
        A.off[i] = A.offV[i] = A.vel[i] = 0;
      }
    } else {
      if (changed) {
        // A reaction starts from, and returns to, the pose under it: only a real change of pose carries momentum.
        const carry = base !== A.prevBase;
        // Falling asleep, the arms go down on the desk first and the head follows; waking, the back straightens first
        // and the arms come after. Either way it takes about a second, and nothing passes through the desk.
        const toSleep = sleeping(base) && !sleeping(A.prevBase);
        const toWake = !sleeping(base) && sleeping(A.prevBase);
        for (let i = 0; i < NKEYS; i++) {
          const key = POSE_KEYS[i]!;
          A.off[i] = c[key] - TARGET[key];
          if (carry) {
            A.offV[i] = clamp(A.vel[i]!, -4, 4);
            A.rate[i] = 1.386 / (toSleep ? (ARM_KEY[i] ? SLEEP_LEAD : SLEEP_FOLLOW) : toWake ? (ARM_KEY[i] ? SLEEP_FOLLOW : SLEEP_LEAD) : BLEND_HALF);
          }
        }
      }
      for (let i = 0; i < NKEYS; i++) {
        const key = POSE_KEYS[i]!;
        let x = A.off[i]!;
        let v = A.offV[i]!;
        const y = A.rate[i]!;
        const decay = Math.exp(-y * dt);
        const j1 = v + x * y;
        x = decay * (x + j1 * dt);
        v = decay * (v - j1 * y * dt);
        A.off[i] = x;
        A.offV[i] = v;
        const next = TARGET[key] + x;
        if (dt > 1e-4) A.vel[i] = (next - c[key]) / dt;
        c[key] = next;
      }
    }
    A.applied = name;
    A.prevBase = base;
    A.cue = cueRef.current;

    // ── pose → rig ──
    if (root.current) {
      // Legs scale with the build, the chair does not: keep the seat contact fixed.
      const seated = smooth(0.78, 0.62, c.hipY);
      root.current.position.set(c.hipX, c.hipY + seated * SEAT_TOP * (1 / build - 1), c.hipZ);
    }
    if (hips.current) hips.current.rotation.y = c.pelYaw;
    // The seat of the trousers turns with the jacket rather than with the legs, so the two never cut through each other.
    pelvis.current?.rotation.set(c.lean * 0.85, c.twist - c.pelYaw, c.pelRoll, 'YXZ');
    spine.current?.rotation.set(c.lean, c.twist, c.side, 'YXZ');
    if (head.current) head.current.rotation.set(c.headPitch, clamp(c.headYaw, -1.2, 1.2), c.headRoll);
    if (armL.current) armL.current.position.y = SHOULDER_Y + c.shrug;
    if (armR.current) armR.current.position.y = SHOULDER_Y + c.shrug;
    sL.current?.rotation.set(c.sLx, -c.tL, c.sLz, 'XZY');
    sR.current?.rotation.set(c.sRx, c.tR, c.sRz, 'XZY');
    if (eL.current) eL.current.rotation.x = c.eL;
    if (eR.current) eR.current.rotation.x = c.eR;
    // Palms turn down as the elbow bends (keyboard, desk) and forward when the arm is raised.
    if (handL.current) handL.current.rotation.y = -1.45 * Math.max(0.3, smooth(0.4, 1.1, -c.eL), smooth(1.9, 2.6, -c.sLx));
    if (handR.current) handR.current.rotation.y = 1.45 * Math.max(0.3, smooth(0.4, 1.1, -c.eR), smooth(1.9, 2.6, -c.sRx));
    hL.current?.rotation.set(c.hL, c.yL, c.aL, 'ZXY');
    hR.current?.rotation.set(c.hR, c.yR, c.aR, 'ZXY');
    if (kL.current) kL.current.rotation.x = c.kL;
    if (kR.current) kR.current.rotation.x = c.kR;
    levelFoot(fL.current, c.hL, c.aL, c.yL, c.kL, c.fL);
    levelFoot(fR.current, c.hR, c.aR, c.yR, c.kR, c.fR);
    // Asleep: eyes shut, slow deep breaths, and a few letters drifting up. (Someone offline who is walking somewhere is awake.)
    const asleep = sleeping(name);
    A.sleep += ((asleep ? 1 : 0) - A.sleep) * (first || isFrozen ? 1 : 1 - Math.exp(-dt / 0.35));
    if (eyes.current) {
      const blink = (t + phase * 1.7) % 4.6;
      // The eyes close as the head goes down, and open only once it is up again.
      const lids = clamp01((A.sleep - 0.25) / 0.5);
      const open = name === 'ouch' && A.since < 0.45 ? 0.16 : blink < 0.16 ? 1 - 0.9 * Math.sin((blink / 0.16) * Math.PI) : 1;
      eyes.current.scale.y = lerp(open, 0.12, lids);
    }
    if (chest.current) {
      const awake = 0.5 + 0.5 * Math.sin(t * 1.3 + phase * 1.9);
      const deep = 0.5 + 0.5 * Math.sin(t * SLEEP_BREATH + phase * 1.9);
      chest.current.scale.set(1 + lerp(awake * 0.004, deep * 0.012, A.sleep), 1, 1 + lerp(awake * (0.016 + 0.012 * L.run), deep * 0.05, A.sleep));
    }
    if (zzz.current && outer.current && head.current) {
      const show = A.sleep > 0.02 && !isFrozen;
      zzz.current.visible = show;
      if (show) {
        // The letters start beside the head, wherever the pose has put it, and float up and away from the name tag.
        head.current.updateWorldMatrix(true, false);
        TMP_M.copy(outer.current.matrixWorld).invert();
        TMP_A.set(0, 0.1, 0).applyMatrix4(head.current.matrixWorld).applyMatrix4(TMP_M);
        const drift = Math.sin(phase * 12.9898 + 1.3) >= 0 ? -1 : 1;
        const kids = zzz.current.children;
        for (let i = 0; i < kids.length; i++) {
          const sp = kids[i] as THREE.Sprite;
          const u = (((t + phase) / Z_LIFE + i / kids.length) % 1 + 1) % 1;
          const e = 1 - (1 - u) * (1 - u);
          const size = (0.065 + 0.1 * u) / build;
          sp.position.set(TMP_A.x + drift * (0.09 + 0.2 * u + 0.03 * Math.sin(u * 9 + i * 2.1)), TMP_A.y + 0.1 + (Z_RISE * e) / build, TMP_A.z);
          sp.scale.set(size, size, 1);
          sp.material.rotation = drift * -0.25 + 0.2 * Math.sin(u * 5 + i);
          sp.material.opacity = A.sleep * 0.92 * smooth(0, 0.14, u) * (1 - smooth(0.62, 1, u));
        }
      }
    }

    // ── the whip ──
    if (lashGeo && lash.current && coil.current && outer.current && handR.current && eR.current) {
      const swinging = name === 'whip' && A.since < WHIP_END + 0.02;
      lash.current.visible = swinging;
      coil.current.visible = !swinging;
      let crack = false;
      if (swinging) {
        // Hand and forearm in the character's own frame, with this frame's pose.
        handR.current.updateWorldMatrix(true, false);
        TMP_M.copy(outer.current.matrixWorld).invert();
        TMP_A.setFromMatrixPosition(handR.current.matrixWorld).applyMatrix4(TMP_M);
        TMP_B.setFromMatrixPosition(eR.current.matrixWorld).applyMatrix4(TMP_M);
        TMP_B.subVectors(TMP_A, TMP_B).normalize();
        shapeLash(lashGeo, A.since, TMP_A.x, TMP_A.y, TMP_A.z, TMP_B.x, TMP_B.y, TMP_B.z, 0.02);
        const k = (A.since - (WHIP_CRACK - 0.025)) / 0.12;
        if (spark.current && k > 0 && k < 1) {
          crack = true;
          spark.current.position.copy(LASH_TIP);
          spark.current.scale.setScalar(0.06 + 0.26 * Math.sin(k * Math.PI));
          spark.current.rotation.set(k * 2, k * 3, k * 5);
        }
      }
      if (spark.current) spark.current.visible = crack;
    }
  });

  const { g } = look3d;
  const suit = look3d.outfit === 'suit';
  // The letters exist only for someone who is asleep (or was, a moment ago: they fade with the pose).
  const sleepy = sleeping(pose) || offline;

  const arm = (anchor: React.RefObject<THREE.Group | null>, ref: React.RefObject<THREE.Group | null>, elbow: React.RefObject<THREE.Group | null>, hand: React.RefObject<THREE.Group | null>, skin: React.RefObject<THREE.SkinnedMesh | null>, side: 1 | -1) => (
    <group ref={anchor} position={[SHOULDER_X * side, SHOULDER_Y, 0]}>
      <group ref={ref}>
        <skinnedMesh
          ref={skin}
          geometry={look3d.longSleeves ? (side > 0 ? g.sleeveL : g.sleeveR) : side > 0 ? g.armL : g.armR}
          material={look3d.longSleeves ? look3d.shirt : look3d.skin}
          castShadow
        />
        {!look3d.longSleeves && <mesh geometry={g.sleeveShort} material={look3d.shirt} />}
        <group ref={elbow} position={[0, -UPPER_ARM, 0]}>
          {look3d.longSleeves && <mesh geometry={g.cuff} material={look3d.trim} />}
          {suit && <mesh geometry={g.sleeveButtons} material={look3d.dark} />}
          <group ref={hand} position={[0, -0.225, 0]}>
            <mesh geometry={side > 0 ? g.handL : g.handR} material={look3d.skin} castShadow />
          </group>
        </group>
      </group>
    </group>
  );

  const leg = (ref: React.RefObject<THREE.Group | null>, knee: React.RefObject<THREE.Group | null>, ankle: React.RefObject<THREE.Group | null>, skin: React.RefObject<THREE.SkinnedMesh | null>, side: 1 | -1) => (
    <group position={[HIP_X * side, 0, 0]}>
      <group ref={ref}>
        <skinnedMesh ref={skin} geometry={side > 0 ? g.legL : g.legR} material={look3d.pants} castShadow />
        <group ref={knee} position={[0, -THIGH, 0]}>
          <group ref={ankle} name={side > 0 ? 'foot-l' : 'foot-r'} position={[0, -SHIN, 0]}>
            <group rotation={[0, 0.08 * side, 0]}>
              <mesh geometry={g.shoe} material={look3d.shoe} castShadow />
              <mesh geometry={g.sole} material={look3d.sole} />
            </group>
          </group>
        </group>
      </group>
    </group>
  );

  const badgeZ = secAt(TORSO_TUCKED, 0.36)[3] + secAt(TORSO_TUCKED, 0.36)[2] * 0.86 + 0.003;

  return (
    <group ref={outer} scale={build}>
      <group ref={root}>
        <group ref={hips}>
          <group ref={pelvis}>
            <mesh geometry={g.pelvis} material={look3d.pants} castShadow />
            {look3d.tucked && <mesh geometry={g.belt} material={look3d.belt} />}
          </group>
          {leg(hL, kL, fL, legLm, 1)}
          {leg(hR, kR, fR, legRm, -1)}
        </group>
        <group ref={spine}>
          <group ref={chest}>
            <mesh geometry={look3d.torso} material={look3d.shirt} castShadow />
            <mesh geometry={look3d.trimGeo} material={look3d.trim} />
            {suit && <mesh geometry={g.tie} material={look3d.tie} />}
            {suit && <mesh geometry={g.suitLapels} material={look3d.lapel} />}
            {suit && <mesh geometry={g.suitButtons} material={look3d.dark} />}
            {suit ? (
              <mesh geometry={g.badge} material={look3d.badge} position={[0.079, 0.412, PIN_Z]} rotation={[-0.08, 0.3, 0.5]} scale={0.5} />
            ) : (
              <mesh geometry={g.badge} material={look3d.badge} position={[0.088, 0.36, badgeZ]} rotation={[-0.05, 0.38, 0]} />
            )}
          </group>
          {whip && <mesh ref={coil} geometry={g.coil} material={look3d.leather} position={[-0.145, -0.015, -0.112]} rotation={[0, -0.93, 0]} castShadow />}
          <mesh geometry={g.neck} material={look3d.skin} />
          <group ref={head} position={[0, HEAD_Y, -0.002]}>
            <group position={[0, 0.103, 0.014]}>
              <mesh geometry={g.head} material={look3d.skin} castShadow />
              <mesh ref={eyes} geometry={g.eyes} material={look3d.eye} position={[0, EYE[1], 0]} />
              <mesh geometry={g.brows} material={look3d.brow} />
              <mesh geometry={g.mouth} material={look3d.mouth} />
              {look3d.fade && <mesh geometry={look3d.fade} material={look3d.fadeMat} />}
              {look3d.hair && <mesh geometry={look3d.hair} material={look3d.hairMat} castShadow />}
              {appearance.accessory === 'glasses' && <mesh geometry={g.glasses} material={look3d.dark} />}
              {look3d.phones && <mesh geometry={look3d.phones} material={look3d.dark} />}
              {appearance.accessory === 'cap' && <mesh geometry={g.cap} material={look3d.capMat} castShadow />}
            </group>
          </group>
          {arm(armL, sL, eL, handL, armLm, 1)}
          {arm(armR, sR, eR, handR, armRm, -1)}
        </group>
      </group>
      <group ref={zzz} visible={false}>
        {sleepy &&
          Z_LETTERS.map((i) => (
            <sprite key={i} raycast={NO_RAYCAST} renderOrder={5}>
              <spriteMaterial map={zTexture()} transparent opacity={0} depthWrite={false} toneMapped={false} />
            </sprite>
          ))}
      </group>
      {lashGeo && <mesh ref={lash} geometry={lashGeo} material={look3d.leather} visible={false} frustumCulled={false} />}
      {lashGeo && <mesh ref={spark} geometry={g.spark} material={sparkMat()} visible={false} />}
    </group>
  );
}
