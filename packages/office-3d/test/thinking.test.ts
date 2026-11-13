import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { body } from '../src/character/body.ts';
import { headPt } from '../src/character/head.ts';
import { HEAD_SCALE, HEAD_Y, POSE_KEYS, SHOULDER_X, SHOULDER_Y, UPPER_ARM, handTurn, newLoco, newPose, poseAt, upright, type Pose } from '../src/character/motion.ts';

/**
 * Somebody thinking: one forearm across the waist, the other elbow resting on that hand, the chin in the raised hand
 * (the owner, 2026-11-13: the old pose "looks bad" — a hand waving in front of the chest, the other forearm stuck out
 * in the air). Measured on the real hand, placed the way the rig places it, against the surface the head is sculpted on:
 * the hand touches the face at the chin and does not go into it, wherever the head turns while the thoughts wander.
 */
const B = body();

/**
 * How far a point is outside the skull (negative: inside), in metres at the drawn size; the point in the skull's own
 * frame. The skull is the surface the head is sculpted on (`headPt`); the face adds a few millimetres of relief.
 */
function outside(p: THREE.Vector3): number {
  const r = p.length();
  const s = headPt(Math.atan2(p.x, p.z), Math.acos(Math.max(-1, Math.min(1, p.y / r))));
  return (r - Math.hypot(...s)) * HEAD_SCALE;
}

/** The rig of `Character.tsx`, from the spine up: the spine, the head, both arms with their hands. */
function rig(o: Pose) {
  const spine = new THREE.Group();
  spine.rotation.set(o.lean, o.twist, o.side, 'YXZ');
  const head = new THREE.Group();
  head.position.set(0, HEAD_Y, -0.002);
  head.rotation.set(o.headPitch, Math.max(-1.2, Math.min(1.2, o.headYaw)), o.headRoll);
  const skull = new THREE.Group();
  skull.position.set(0, 0.103 * HEAD_SCALE, 0.014 * HEAD_SCALE);
  skull.scale.setScalar(HEAD_SCALE);
  head.add(skull);
  spine.add(head);
  const arm = (left: boolean) => {
    const side = left ? 1 : -1;
    const anchor = new THREE.Group();
    anchor.position.set(SHOULDER_X * side, SHOULDER_Y + o.shrug, 0);
    const shoulder = new THREE.Group();
    shoulder.rotation.set(left ? o.sLx : o.sRx, left ? -o.tL : o.tR, left ? o.sLz : o.sRz, 'XZY');
    const elbow = new THREE.Group();
    elbow.position.set(0, -UPPER_ARM, 0);
    elbow.rotation.x = left ? o.eL : o.eR;
    const hand = new THREE.Group();
    hand.position.set(0, -0.225, 0);
    handTurn(hand.rotation, o, left);
    elbow.add(hand);
    shoulder.add(elbow);
    anchor.add(shoulder);
    spine.add(anchor);
    return { elbow, hand };
  };
  const L = arm(true);
  const R = arm(false);
  spine.updateMatrixWorld(true);
  return { skull, L, R };
}

/** The vertices of a mesh where an object puts them. */
function placed(g: THREE.BufferGeometry, at: THREE.Object3D): THREE.Vector3[] {
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  const out: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(at.matrixWorld));
  return out;
}

const at = (o: THREE.Object3D) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);

/** Who holds the chin with which hand, and what the measurements are, at one moment of one person. */
function measure(t: number, ph: number) {
  const o = newPose();
  poseAt('thinking', t, ph, o);
  const r = rig(o);
  // Which hand is up: the one nearer the head.
  const head = at(r.skull);
  const left = at(r.L.hand).distanceTo(head) < at(r.R.hand).distanceTo(head);
  const chinArm = left ? r.L : r.R;
  const other = left ? r.R : r.L;
  const toSkull = r.skull.matrixWorld.clone().invert();
  const d = placed(left ? B.handL : B.handR, chinArm.hand).map((p) => outside(p.applyMatrix4(toSkull)));
  // The hand lies on the face: its nearest point is at the skin (`touch`), and none of it is deep under it (`inside`).
  return { o, left, touch: Math.max(0, Math.min(...d)), inside: Math.max(0, -Math.min(...d)), elbow: at(chinArm.elbow), support: at(other.hand), head };
}

test('the chin rests in the hand — it touches, and nothing of the hand is inside the head — however the head turns', () => {
  let lefts = 0;
  for (const ph of [0, 1.7, 3.4, 5.1, 6.8, 8.5]) {
    for (let t = 0; t < 40; t += 2.3) {
      const m = measure(t, ph);
      if (m.left) lefts++;
      assert.ok(m.touch < 0.01, `ph ${ph}, ${t.toFixed(1)} s: the hand is ${(m.touch * 100).toFixed(1)} cm away from the face`);
      assert.ok(m.inside < 0.008, `ph ${ph}, ${t.toFixed(1)} s: the hand is ${(m.inside * 100).toFixed(1)} cm inside the head`);
      // The raised arm comes up in front of the body, not through it; the other hand holds that elbow.
      assert.ok(m.elbow.z > 0.18, `ph ${ph}: the elbow is ${(m.elbow.z * 100).toFixed(0)} cm ahead of the spine — inside the chest`);
      assert.ok(m.support.distanceTo(m.elbow) < 0.09, `ph ${ph}: the supporting hand is ${(m.support.distanceTo(m.elbow) * 100).toFixed(0)} cm from the elbow it holds`);
    }
  }
  assert.ok(lefts > 0 && lefts < 6 * 18, 'some people hold their chin with the left hand, some with the right');
});

test('the thoughts wander smoothly: the head settles into different looks, and nothing jumps from one frame to the next', () => {
  for (const ph of [0, 2.2, 4.9]) {
    const prev = newPose();
    const now = newPose();
    poseAt('thinking', 0, ph, prev);
    const yaws: number[] = [];
    for (let t = 1 / 60; t < 60; t += 1 / 60) {
      poseAt('thinking', t, ph, now);
      for (const k of POSE_KEYS) assert.ok(Math.abs(now[k] - prev[k]) < 0.06, `${k} jumps at ${t.toFixed(2)} s (${(now[k] - prev[k]).toFixed(3)})`);
      Object.assign(prev, now);
      if (Math.round(t * 60) % 60 === 0) yaws.push(now.headYaw);
    }
    // In a minute the head has looked one way and another, by a visible amount.
    assert.ok(Math.max(...yaws) - Math.min(...yaws) > 0.2, `ph ${ph}: the head hardly moves (${(Math.max(...yaws) - Math.min(...yaws)).toFixed(2)} rad)`);
  }
});

test('what the thinking hands ask of the wrists is not left on them in any other pose', () => {
  const o = newPose();
  poseAt('thinking', 3, 1.7, o);
  assert.ok(o.wrL !== 0 || o.wrR !== 0, 'thinking turns a hand');
  poseAt('typing', 3, 1.7, o);
  assert.deepEqual([o.wrL, o.wfL, o.wrR, o.wfR], [0, 0, 0, 0]);
  poseAt('thinking', 3, 1.7, o);
  upright(o, 3, 1.7, newLoco());
  assert.deepEqual([o.wrL, o.wfL, o.wrR, o.wfR], [0, 0, 0, 0]);
});
