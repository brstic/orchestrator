/**
 * Out in the city: the person who jumped out of the office — falling, under a parachute, on foot, at the wheel.
 *
 * One state and one step (`step`), driven by the same keys as in the office; what is solid comes from the city's
 * blocks (`blocks.ts`, `solidsNear`), the very boxes that are drawn. Nothing here draws anything: `Rig.tsx` moves the
 * body, the parachute and the car to where this says, and puts the camera behind.
 *
 * Pure: unit-tested in `packages/office-3d/test/explorer.test.ts`.
 */
import { STREET_Y, blocked, groundAt, type Solid } from './blocks.ts';

export type Phase = 'fall' | 'chute' | 'foot' | 'car';

export interface Explorer {
  phase: Phase;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Which way the body (or the car) faces: 0 is +z, as everywhere in the office. */
  rot: number;
  /** How long it has been in this phase. */
  time: number;
  /** How far the parachute is open, 0–1. */
  chute: number;
  /** On foot: pace forward and to the side. At the wheel: speed (negative: reversing). */
  vf: number;
  vs: number;
  /** The car's paint while driving (0–1 sRGB), and the vehicle of the traffic it was (its index). */
  paint: [number, number, number];
  vehicle: number;
}

export interface Keys {
  /** Forward (1) or back (-1). */
  fwd: number;
  /** Right (1) or left (-1). */
  turn: number;
  /** Sidestep right (1) or left (-1), on foot. */
  strafe: number;
  run: boolean;
  /** The jump key was pressed (this frame). */
  jump: boolean;
}

export const GRAVITY = 9.81;
/** After this long falling — and with room to spare — the parachute opens by itself. */
export const CHUTE_AFTER = 1.2;
/** Under the parachute: how fast one sinks, and glides forward (faster or slower with the keys). */
export const CHUTE_SINK = 5.2;
export const GLIDE = 7;
/** A person on foot is this round; a car this. */
const BODY = 0.35;
const CAR = 1.25;
const WALK = { fwd: 3.8, back: 2.4, side: 2.6 };
const RUN = { fwd: 7.4, back: 3.6, side: 4.4 };
/** At the wheel: the most it does (with Shift more), how fast it gets there, how fast it stops. */
export const CAR_TOP = 24;
export const CAR_BOOST = 40;
const CAR_ACCEL = 8;
const CAR_BRAKE = 18;
const CAR_REVERSE = 8;

const toward = (v: number, goal: number, rate: number, dt: number) => goal + (v - goal) * Math.exp(-rate * dt);

/** Out of the window: a step and a leap off the edge (`x`, `z`), facing away from the building (`rot`). */
export function leap(x: number, z: number, rot: number): Explorer {
  return { phase: 'fall', x, y: 0.6, z, vx: Math.sin(rot) * 4.5, vy: 3.2, vz: Math.cos(rot) * 4.5, rot, time: 0, chute: 0, vf: 0, vs: 0, paint: [1, 1, 1], vehicle: -1 };
}

/** Move horizontally by (dx, dz) at height y, sliding along what is in the way. Says whether something stopped it. */
function slide(e: Explorer, dx: number, dz: number, solids: Solid[], radius: number, step: number): boolean {
  let hit = false;
  if (!blocked(solids, e.x + dx, e.z, e.y, radius, step)) e.x += dx;
  else hit = true;
  if (!blocked(solids, e.x, e.z + dz, e.y, radius, step)) e.z += dz;
  else hit = true;
  return hit;
}

/** One step of `dt` seconds. */
export function step(e: Explorer, keys: Keys, dt: number, solids: Solid[]): void {
  e.time += dt;
  const fx = Math.sin(e.rot);
  const fz = Math.cos(e.rot);
  if (e.phase === 'fall' || e.phase === 'chute') {
    const ground = groundAt(solids, e.x, e.z, e.y, BODY, 0);
    if (e.phase === 'fall') {
      e.vy = Math.max(e.vy - GRAVITY * dt, -55);
      // A little steering in the air; the drift dies away slowly.
      e.rot -= keys.turn * 1.4 * dt;
      e.vx = e.vx * Math.exp(-0.25 * dt) + fx * keys.fwd * 2 * dt;
      e.vz = e.vz * Math.exp(-0.25 * dt) + fz * keys.fwd * 2 * dt;
      // The parachute: by itself after a moment of falling, or at once with the jump key — never too near the ground.
      if ((e.time > CHUTE_AFTER || (keys.jump && e.time > 0.3)) && e.y - ground > 12) {
        e.phase = 'chute';
        e.time = 0;
      }
    } else {
      e.chute = Math.min(1, e.chute + dt / 0.9);
      e.rot -= keys.turn * 1.15 * dt;
      e.vy = toward(e.vy, -CHUTE_SINK * (keys.fwd < 0 ? 0.8 : 1), 2.4, dt);
      const glide = Math.max(2, GLIDE + keys.fwd * 3);
      e.vx = toward(e.vx, fx * glide, 1.2, dt);
      e.vz = toward(e.vz, fz * glide, 1.2, dt);
    }
    if (slide(e, e.vx * dt, e.vz * dt, solids, BODY, 0)) {
      e.vx *= 0.3;
      e.vz *= 0.3;
    }
    const under = groundAt(solids, e.x, e.z, e.y, BODY, 0);
    const ny = e.y + e.vy * dt;
    if (ny <= under) {
      // Down: on the street, or on a roof.
      e.y = under;
      e.vx = e.vy = e.vz = 0;
      e.vf = e.vs = 0;
      e.phase = 'foot';
      e.time = 0;
      e.chute = 0;
    } else e.y = ny;
    return;
  }
  if (e.phase === 'foot') {
    e.rot -= keys.turn * 2.9 * dt;
    const pace = keys.run ? RUN : WALK;
    const len = Math.hypot(keys.fwd, keys.strafe) || 1;
    e.vf = toward(e.vf, (keys.fwd / len) * (keys.fwd > 0 ? pace.fwd : pace.back), 30, dt);
    e.vs = toward(e.vs, (keys.strafe / len) * pace.side, 30, dt);
    const rx = Math.cos(e.rot);
    const rz = -Math.sin(e.rot);
    slide(e, (fx * e.vf - rx * e.vs) * dt, (fz * e.vf - rz * e.vs) * dt, solids, BODY, 0.6);
    const ground = groundAt(solids, e.x, e.z, e.y, 0, 0.6);
    if (ground > e.y) e.y = ground; // a step up
    else if (ground < e.y - 0.3) {
      // Off an edge.
      e.phase = 'fall';
      e.time = 0;
      e.vx = fx * e.vf;
      e.vz = fz * e.vf;
      e.vy = 0;
    }
    if (keys.jump && e.phase === 'foot') {
      e.phase = 'fall';
      e.time = 0;
      e.vy = 4.2;
      e.vx = fx * e.vf;
      e.vz = fz * e.vf;
    }
    return;
  }
  // At the wheel.
  const top = keys.run ? CAR_BOOST : CAR_TOP;
  if (keys.fwd > 0) e.vf = e.vf < 0 ? Math.min(0, e.vf + CAR_BRAKE * dt) : Math.min(top, e.vf + CAR_ACCEL * (keys.run ? 1.5 : 1) * dt);
  else if (keys.fwd < 0) e.vf = e.vf > 0 ? Math.max(0, e.vf - CAR_BRAKE * dt) : Math.max(-CAR_REVERSE, e.vf - CAR_ACCEL * 0.6 * dt);
  else e.vf = Math.sign(e.vf) * Math.max(0, Math.abs(e.vf) - 3 * dt);
  if (e.vf > top) e.vf = Math.max(top, e.vf - CAR_BRAKE * dt);
  // Steering turns the car as fast as it is going (and the other way round when reversing).
  const grip = Math.min(1, Math.abs(e.vf) / 6) * Math.sign(e.vf);
  e.rot -= keys.turn * 1.25 * grip * dt * (1 - Math.min(0.45, Math.abs(e.vf) / 90));
  if (slide(e, Math.sin(e.rot) * e.vf * dt, Math.cos(e.rot) * e.vf * dt, solids, CAR, 0.6)) e.vf *= -0.25;
  e.y = Math.max(STREET_Y, groundAt(solids, e.x, e.z, e.y, 0, 0.6));
}

/** Into a car of the traffic: the driver's seat, its paint, facing the way it does. */
export function board(e: Explorer, car: { x: number; z: number; heading: number; paint: [number, number, number]; index: number }): void {
  e.phase = 'car';
  e.time = 0;
  e.x = car.x;
  e.z = car.z;
  e.rot = car.heading;
  e.vf = e.vs = 0;
  e.paint = car.paint;
  e.vehicle = car.index;
}

/** Out of the car, on the driver's side (left of it), wherever there is room. Says where the car was left. */
export function alight(e: Explorer, solids: Solid[]): { x: number; z: number; rot: number } {
  const car = { x: e.x, z: e.z, rot: e.rot };
  e.phase = 'foot';
  e.time = 0;
  e.vf = e.vs = 0;
  for (const side of [1, -1]) {
    const x = e.x + Math.cos(e.rot) * 2 * side;
    const z = e.z - Math.sin(e.rot) * 2 * side;
    if (!blocked(solids, x, z, e.y, BODY, 0.6)) {
      e.x = x;
      e.z = z;
      break;
    }
  }
  return car;
}
