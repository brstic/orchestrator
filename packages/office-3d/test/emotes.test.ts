import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMOTES } from '@orchestrator/contracts';
import { EMOTE_SECONDS, POSE_KEYS, STAND_Y, emote, isEmotePose, newPose, type EmotePose, type Pose } from '../src/character/motion.ts';

/** Someone standing with their arms at their sides: what a gesture is laid over. */
const standing = (): Pose => ({ ...newPose(), hipY: STAND_Y, sLz: 0.07, sRz: -0.07, eL: -0.16, eR: -0.16 });
const LEGS: (keyof Pose)[] = ['hL', 'aL', 'yL', 'kL', 'fL', 'hR', 'aR', 'yR', 'kR', 'fR'];
const differs = (a: Pose, b: Pose) => POSE_KEYS.filter((k) => Math.abs(a[k] - b[k]) > 1e-9);

test('the gestures the office passes around are the ones the characters know', () => {
  for (const name of EMOTES) assert.ok(isEmotePose(name), name);
  for (const name of ['walk', 'whip', 'ouch', 'jump', '', 'constructor']) assert.equal(isEmotePose(name), false, name);
});

test('a gesture grows out of how the person stood and settles back into it', () => {
  for (const name of EMOTES as readonly EmotePose[]) {
    const len = EMOTE_SECONDS[name];
    const before = standing();
    emote(before, name, 0);
    assert.deepEqual(differs(before, standing()), [], `${name}: nothing yet at the very start`);
    const after = standing();
    emote(after, name, len + 0.01);
    assert.deepEqual(differs(after, standing()), [], `${name}: nothing left when it is over`);
    const mid = standing();
    emote(mid, name, len * 0.5);
    assert.ok(differs(mid, standing()).length >= 2, `${name}: it is visibly something in the middle`);
    // No jump anywhere: from one frame to the next (a sixtieth of a second) no joint moves by more than a fast arm does.
    let prev = standing();
    for (let t = 0; t <= len + 0.05; t += 1 / 60) {
      const now = standing();
      emote(now, name, t);
      for (const k of POSE_KEYS) assert.ok(Math.abs(now[k] - prev[k]) < 0.42, `${name}: ${k} jumps at ${t.toFixed(2)} s (${(now[k] - prev[k]).toFixed(2)})`);
      prev = now;
    }
  }
});

test('gestures are made with the arms, the trunk and the head: the legs and the height of the hips are the gait\'s', () => {
  for (const name of EMOTES as readonly EmotePose[]) {
    for (let t = 0; t <= EMOTE_SECONDS[name]; t += 0.05) {
      const p = standing();
      emote(p, name, t);
      for (const k of LEGS) assert.equal(p[k], 0, `${name}: ${k} at ${t.toFixed(2)} s`);
      assert.equal(p.hipY, STAND_Y, `${name}: the feet stay on the floor`);
      for (const k of POSE_KEYS) assert.ok(Number.isFinite(p[k]) && Math.abs(p[k]) < 3.2, `${name}: ${k} = ${p[k]}`);
    }
  }
});

test('each gesture is itself: the arm that waves is up, the one who bows leans, the one who shrugs lifts the shoulders', () => {
  const at = (name: EmotePose, t: number) => {
    const p = standing();
    emote(p, name, t);
    return p;
  };
  assert.ok(at('wave', 1.2).sRx < -2 && Math.abs(at('wave', 1.2).sLx) < 0.2, 'wave: the right arm up, the left at rest');
  assert.ok(at('cheer', 1.2).sRx < -2.3 && at('cheer', 1.2).sLx < -2.3, 'cheer: both arms up');
  assert.ok(at('bow', 1.0).lean > 0.5 && at('bow', 0.05).lean < 0.1, 'bow: forward from the hips, and not at once');
  assert.ok(at('shrug', 0.8).shrug > 0.03 && at('shrug', 0.8).sLz > 0.3 && at('shrug', 0.8).sRz < -0.3, 'shrug: shoulders up, forearms out');
  assert.ok(Math.abs(at('point', 1).sRx + 1.5) < 0.1 && at('point', 1).eR > -0.2, 'point: the right arm straight out');
  assert.ok(at('clap', 1).sLx < -0.8 && at('clap', 1).sRx < -0.8, 'clap: both forearms up in front');
  assert.ok(at('thumbsUp', 1).sRx < -1 && at('thumbsUp', 1).eR < -0.6, 'thumbs up: the right fist forward');
  // The dance moves from side to side: over a beat the twist changes sign.
  const twists = Array.from({ length: 40 }, (_x, i) => at('dance', 1 + i * 0.03).twist);
  assert.ok(Math.max(...twists) > 0.15 && Math.min(...twists) < -0.15, 'dance: the trunk swings both ways');
});
