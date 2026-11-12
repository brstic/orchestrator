import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JUMP_AIR, JUMP_HEIGHT, JUMP_OFF, JUMP_SECONDS, JUMP_TOUCH, POSE_KEYS, STAND_Y, jumpSink, jumpY, newLoco, newPose, stepLoco, upright, type Pose } from '../src/character/motion.ts';

/**
 * A jump is a pose worked out from the time since it began (the crouch, the push, the air, the landing) plus a lift
 * of the whole body. What must stay true of it can be checked without a browser: it starts from and returns to how
 * the body stood, nothing is ever put anywhere at once, and the feet are on the floor whenever the body is not lifted.
 */

const DT = 1 / 60;
const APEX = JUMP_OFF + JUMP_AIR / 2;
/** The legs push off and take a landing: they are the fastest thing about a jump (a knee folds in a twentieth of a second). */
const LEG = new Set<string>(['hL', 'kL', 'fL', 'hR', 'kR', 'fR']);

/** A body that jumps `at` seconds in, moving at `speed` (m/s, straight ahead): its pose at every frame, with the jump's clock. */
function run(speed: number, jumpAt: number, seconds: number, jumps = true): Array<{ t: number; air: number; pose: Pose }> {
  const L = newLoco();
  const frames: Array<{ t: number; air: number; pose: Pose }> = [];
  // (The clock that breathing and idle swaying run on stands still, so that what moves is the jump.)
  for (let t = 0; t < seconds; t += DT) {
    const air = jumps && t >= jumpAt && t - jumpAt < JUMP_SECONDS ? t - jumpAt : -1;
    L.air = air;
    stepLoco(L, DT, 0, speed, 0, speed > 4);
    const pose = newPose();
    upright(pose, 0, 0, L);
    frames.push({ t, air, pose });
  }
  return frames;
}
const at = (frames: ReturnType<typeof run>, air: number) => frames.reduce((best, f) => (f.air >= 0 && Math.abs(f.air - air) < Math.abs(best.air - air) ? f : best), frames.find((f) => f.air >= 0)!);

test('the lift: nothing until the feet leave the floor, the full height in the middle of the air, nothing once they are back', () => {
  assert.equal(jumpY(0), 0);
  assert.equal(jumpY(JUMP_OFF), 0, 'the crouch and the push are on the floor');
  assert.ok(Math.abs(jumpY(APEX) - JUMP_HEIGHT) < 1e-9);
  assert.equal(jumpY(JUMP_TOUCH), 0);
  assert.equal(jumpY(JUMP_SECONDS), 0);
  assert.equal(jumpY(-1), 0);
  for (let t = JUMP_OFF + 0.01; t < JUMP_TOUCH - 0.01; t += 0.01) assert.ok(jumpY(t) > 0, `in the air at ${t.toFixed(2)} s`);
  assert.ok(JUMP_OFF <= 0.16, 'the key is answered soon: the feet leave the floor within a sixth of a second');
  assert.ok(JUMP_SECONDS < 1.1, 'and the whole of it is over in about a second');
});

test('the hips: down before the push, up on the toes leaving the floor, down again for the landing — and never moved at once', () => {
  assert.equal(jumpSink(0), 0);
  assert.equal(jumpSink(JUMP_SECONDS), 0);
  assert.equal(jumpSink(-1), 0);
  let low = 0;
  let landing = 0;
  for (let t = 0; t <= JUMP_SECONDS; t += 0.001) {
    const s = jumpSink(t);
    if (t < JUMP_OFF) low = Math.min(low, s);
    if (t > JUMP_TOUCH) landing = Math.min(landing, s);
    assert.ok(Math.abs(jumpSink(t + 0.001) - s) < 0.006, `the hips at ${t.toFixed(3)} s`);
  }
  assert.ok(low < -0.09 && low > -0.2, `the crouch is ${low.toFixed(3)} m`);
  assert.ok(jumpSink(JUMP_OFF - 1e-6) > 0.04, 'stretched, on the toes, as the feet leave');
  assert.ok(landing < -0.15 && landing > -0.28, `the knees give ${landing.toFixed(3)} m on landing`);
  // The landing is taken at about the speed the body fell at, so the hips do not stop dead and then sink.
  const fall = (jumpY(JUMP_TOUCH - 0.001) - 0) / 0.001;
  const give = -(jumpSink(JUMP_TOUCH + 0.003) - jumpSink(JUMP_TOUCH + 0.002)) / 0.001;
  assert.ok(give > 0.5 * fall && give < 1.1 * fall, `falling at ${fall.toFixed(1)} m/s, the knees give at ${give.toFixed(1)} m/s`);
});

test('a jump from standing: it grows out of how the body stood and settles back into it, with nothing put anywhere at once', () => {
  const still = run(0, 0.5, 2, false);
  const frames = run(0, 0.5, 2);
  const before = frames.find((f) => f.t >= 0.45)!;
  const after = frames[frames.length - 1]!;
  const rest = still[still.length - 1]!.pose;
  for (const k of POSE_KEYS) {
    assert.ok(Math.abs(before.pose[k] - rest[k]) < 1e-6, `${k} before the jump`);
    assert.ok(Math.abs(after.pose[k] - rest[k]) < 1e-3, `${k} after the jump: ${after.pose[k]} against ${rest[k]}`);
  }
  let prev = frames[0]!.pose;
  for (const f of frames) {
    for (const k of POSE_KEYS) assert.ok(Math.abs(f.pose[k] - prev[k]) < (LEG.has(k) ? 0.56 : 0.42), `${k} jumps at ${f.air.toFixed(3)} s into the jump (${(f.pose[k] - prev[k]).toFixed(2)})`);
    prev = f.pose;
  }
});

test('what the body does: crouches with the arms back, throws them up, draws the knees up in the air, and folds over the landing', () => {
  const frames = run(0, 0.5, 2);
  const crouch = at(frames, 0.07);
  assert.ok(crouch.pose.hipY < STAND_Y - 0.08, `the hips are down (${crouch.pose.hipY.toFixed(2)})`);
  assert.ok(crouch.pose.kL > 0.5 && crouch.pose.kR > 0.5, 'the knees are bent, the feet still on the floor');
  assert.ok(crouch.pose.sLx > 0.25 && crouch.pose.sRx > 0.25, `the arms are swung back (${crouch.pose.sLx.toFixed(2)})`);
  assert.ok(crouch.pose.lean > 0.15, 'the trunk is folded forward');

  const off = at(frames, JUMP_OFF);
  assert.ok(off.pose.kL < 0.35, `the legs are stretched as the feet leave (${off.pose.kL.toFixed(2)})`);
  assert.ok(off.pose.hipY > STAND_Y, 'on the toes');

  const top = at(frames, APEX);
  assert.ok(top.pose.sLx < -1.7 && top.pose.sRx < -1.7, `the arms are up (${top.pose.sLx.toFixed(2)})`);
  assert.ok(top.pose.kL > 0.8 && top.pose.kR > 0.8, `the knees are drawn up (${top.pose.kL.toFixed(2)})`);
  assert.ok(Math.abs(top.pose.kL - top.pose.kR) < 0.05, 'both alike: this is a jump on the spot');

  const reach = at(frames, JUMP_TOUCH - 0.01);
  assert.ok(reach.pose.kL > 0.2 && reach.pose.kL < 0.65, `the legs reach for the floor before it comes, the knees not locked (${reach.pose.kL.toFixed(2)})`);

  const land = at(frames, JUMP_TOUCH + 0.12);
  assert.ok(land.pose.hipY < STAND_Y - 0.14, `the knees take the landing (${land.pose.hipY.toFixed(2)})`);
  assert.ok(land.pose.kL > 0.7 && land.pose.lean > 0.25, 'bent over them');
  assert.ok(land.pose.sLz > 0.2 && land.pose.sRz < -0.2, 'arms out for balance');
});

test('a jump while running is a leap: one leg reaches ahead, the other trails, and the run goes on after it', () => {
  const frames = run(6, 1.5, 4);
  const top = at(frames, APEX);
  assert.ok(Math.abs(top.pose.hL - top.pose.hR) > 0.6, `the legs are apart (${top.pose.hL.toFixed(2)} and ${top.pose.hR.toFixed(2)})`);
  let prev = frames[0]!.pose;
  for (const f of frames) {
    for (const k of POSE_KEYS) assert.ok(Number.isFinite(f.pose[k]), `${k} is a number at ${f.t.toFixed(2)} s`);
    // (A runner's legs are fast already — a knee of this one moves 0.54 in a frame with no jump at all; what must not
    // happen is a joint thrown across in one frame.)
    if (f.air >= 0) for (const k of POSE_KEYS) assert.ok(Math.abs(f.pose[k] - prev[k]) < 0.72, `${k} jumps at ${f.air.toFixed(3)} s into the leap (${(f.pose[k] - prev[k]).toFixed(2)})`);
    prev = f.pose;
  }
  // Two seconds on, the body runs as one that never jumped does: the same stride, wherever in it each happens to be.
  const plain = run(6, 1.5, 4, false);
  const swing = (fs: ReturnType<typeof run>) => {
    const tail = fs.filter((f) => f.t > 3);
    return Math.max(...tail.map((f) => f.pose.hL)) - Math.min(...tail.map((f) => f.pose.hL));
  };
  assert.ok(Math.abs(swing(frames) - swing(plain)) < 0.15, `the stride after the leap (${swing(frames).toFixed(2)}) is the runner's (${swing(plain).toFixed(2)})`);
});
