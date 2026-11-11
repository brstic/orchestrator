import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMOTES } from '@orchestrator/contracts';
// (By file, not through the package: its front door brings the 3D scene with it, which only a browser can load.)
import { EMOTE_SECONDS } from '../../../packages/office-3d/src/character/motion.ts';
import { VOICE_FAR, VOICE_NEAR, voiceFalloff } from '../../../packages/office-3d/src/voice-sound.ts';
import { VOICE_FRAME_MAX, VOICE_FRAMES_PER_SECOND, VOICE_RANGE, validFrame } from '../../server/src/voice.ts';
import { WHEEL_DEAD, personInReach, sliceAt } from '../src/lib/people-acts.ts';
import { VOICE_FRAME, VOICE_RATE, decodeVoice, encodeVoice, fromBase64, loudness, toBase64 } from '../src/lib/voice-codec.ts';

test('the gesture wheel: the direction of the mouse picks a slice, the middle picks nothing', () => {
  const n = EMOTES.length;
  assert.equal(n, 8);
  assert.equal(sliceAt(0, 0, n), null);
  assert.equal(sliceAt(WHEEL_DEAD - 1, 0, n), null, 'still in the middle');
  // Up is the first gesture, then clockwise: right is a quarter of the way round, down half, left three quarters.
  assert.deepEqual([sliceAt(0, -80, n), sliceAt(80, 0, n), sliceAt(0, 80, n), sliceAt(-80, 0, n)], [0, 2, 4, 6]);
  assert.deepEqual([sliceAt(60, -60, n), sliceAt(60, 60, n), sliceAt(-60, 60, n), sliceAt(-60, -60, n)], [1, 3, 5, 7]);
  // Just to either side of straight up is still the first one; every direction is some slice.
  assert.deepEqual([sliceAt(-10, -80, n), sliceAt(10, -80, n)], [0, 0]);
  for (let a = 0; a < 360; a += 7) {
    const i = sliceAt(Math.sin((a * Math.PI) / 180) * 90, -Math.cos((a * Math.PI) / 180) * 90, n);
    assert.ok(i !== null && i >= 0 && i < n, `${a}°`);
  }
  assert.equal(sliceAt(Number.NaN, 5, n), null);
});

test('every gesture of the wheel is one the characters can make, and none lasts for ever', () => {
  for (const name of EMOTES) assert.ok(EMOTE_SECONDS[name] >= 1.5 && EMOTE_SECONDS[name] <= 8, name);
  assert.deepEqual(Object.keys(EMOTE_SECONDS).sort(), [...EMOTES].sort());
});

test('who the whip is for among people: the nearest within reach, not someone behind one\'s back', () => {
  const me = { x: 0, z: 0, rot: 0 }; // facing +z
  const at = (id: string, x: number, z: number) => ({ id, x, z });
  assert.equal(personInReach([at('me', 0, 0)], me, 'me'), null, 'never oneself');
  assert.equal(personInReach([at('me', 0, 0), at('a', 0, 2), at('b', 1, 1)], me, 'me'), 'b', 'the nearer of two');
  assert.equal(personInReach([at('far', 0, 3.6)], me, 'me'), null, 'out of reach');
  assert.equal(personInReach([at('behind', 0, -2)], me, 'me'), null, 'behind the back');
  assert.equal(personInReach([at('beside', 2, 0)], me, 'me'), 'beside');
  assert.equal(personInReach([at('close', 0, -0.5)], me, 'me'), 'close', 'standing on one\'s toes counts, whichever way one faces');
  // Turned round, the one who was behind is in front.
  assert.equal(personInReach([at('behind', 0, -2)], { ...me, rot: Math.PI }, 'me'), 'behind');
});

test('a voice survives the trip: what is sent is close to what was said, a byte a sample', () => {
  const said = new Float32Array(VOICE_FRAME);
  for (let i = 0; i < said.length; i++) said[i] = 0.6 * Math.sin((i / VOICE_RATE) * 2 * Math.PI * 220) + 0.02 * Math.sin(i * 1.7);
  const bytes = encodeVoice(said);
  assert.equal(bytes.length, VOICE_FRAME);
  const text = toBase64(bytes);
  assert.ok(validFrame(text) && text.length <= VOICE_FRAME_MAX, `a frame is what the office accepts (${text.length} characters)`);
  const heard = decodeVoice(fromBase64(text)!);
  assert.equal(heard.length, said.length);
  let worst = 0;
  let noise = 0;
  let signal = 0;
  for (let i = 0; i < said.length; i++) {
    worst = Math.max(worst, Math.abs(heard[i]! - said[i]!));
    noise += (heard[i]! - said[i]!) ** 2;
    signal += said[i]! ** 2;
  }
  assert.ok(worst < 0.03, `no sample far off (${worst.toFixed(4)})`);
  assert.ok(10 * Math.log10(signal / noise) > 30, 'well above the noise of the companding');
  // Quiet speech keeps its shape (that is what µ-law is for), silence stays silent, and too loud is clipped, not wrapped.
  const quiet = decodeVoice(encodeVoice(new Float32Array([0.004, -0.004, 0.001, 0])));
  assert.ok(quiet[0]! > 0.003 && quiet[1]! < -0.003 && Math.abs(quiet[3]!) < 0.0005);
  const loud = decodeVoice(encodeVoice(new Float32Array([5, -5, Number.NaN, 1, -1])));
  assert.ok(loud[0]! > 0.95 && loud[1]! < -0.95 && Math.abs(loud[2]!) < 0.001 && loud[3]! > 0.95 && loud[4]! < -0.95);
  assert.equal(fromBase64('not base64!'), null);
  assert.ok(loudness(said) > 0.3 && loudness(new Float32Array(64)) === 0 && loudness(new Float32Array(0)) === 0);
});

test('frames at the rate they are captured fit under the office\'s limit', () => {
  assert.ok(VOICE_RATE / VOICE_FRAME < VOICE_FRAMES_PER_SECOND, `${(VOICE_RATE / VOICE_FRAME).toFixed(1)} frames a second`);
});

test('how loud a voice is: full when together, quieter with every step, gone before the office stops passing it on', () => {
  assert.equal(voiceFalloff(0), 1);
  assert.equal(voiceFalloff(VOICE_NEAR), 1);
  assert.equal(voiceFalloff(VOICE_FAR), 0);
  assert.equal(voiceFalloff(VOICE_FAR + 50), 0);
  assert.equal(voiceFalloff(Number.NaN), 1, 'a distance that is not known is not a reason for silence');
  let last = 1;
  for (let d = VOICE_NEAR; d <= VOICE_FAR; d += 0.25) {
    const v = voiceFalloff(d);
    assert.ok(v <= last + 1e-9 && v >= 0 && v <= 1, `at ${d} m`);
    last = v;
  }
  assert.ok(voiceFalloff(6) < 0.75 && voiceFalloff(6) > 0.3, `a few desks away it is clearly quieter (${voiceFalloff(6).toFixed(2)})`);
  assert.ok(voiceFalloff(15) < 0.12, `across the floor it is almost gone (${voiceFalloff(15).toFixed(2)})`);
  assert.ok(VOICE_FAR < VOICE_RANGE, 'it fades out inside the range the office passes it on in, so it is never cut off');
});
