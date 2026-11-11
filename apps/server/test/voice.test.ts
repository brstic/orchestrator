import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLayout } from '@orchestrator/contracts';
import { VOICE_FRAME_MAX, VOICE_RANGE, hears, soundRoom, validFrame } from '../src/voice.ts';

const layout = defaultLayout();
const meeting = layout.rooms.find((r) => r.kind === 'meeting')!;
const inMeeting = { x: meeting.x + meeting.w / 2, z: meeting.z + meeting.d / 2 };
const alsoInMeeting = { x: meeting.x + 1, z: meeting.z + 1 };
// Just outside the meeting room's door side: the hall below it, a step from the wall.
const atTheDoor = { x: meeting.x + meeting.w / 2, z: meeting.z + meeting.d + 0.6 };
const openFloor = { x: -10, z: 2 };

test('the meeting room is a room for sound; the rest of the office is one open space', () => {
  assert.equal(soundRoom(layout, inMeeting), meeting.id);
  assert.equal(soundRoom(layout, alsoInMeeting), meeting.id);
  assert.equal(soundRoom(layout, atTheDoor), null);
  assert.equal(soundRoom(layout, openFloor), null);
  // Other closed rooms — the server room, the break room, the CEO's office — do not hold sound in: only a meeting room does.
  for (const r of layout.rooms.filter((x) => x.kind !== 'meeting')) assert.equal(soundRoom(layout, { x: r.x + r.w / 2, z: r.z + r.d / 2 }), null, r.kind);
  assert.equal(soundRoom(null, inMeeting), null, 'an office with no layout yet has no rooms');
});

test('what is said in a meeting stays in the meeting — and what is said outside does not come in', () => {
  assert.equal(hears(layout, inMeeting, alsoInMeeting), true, 'the people in the room hear each other');
  assert.equal(hears(layout, inMeeting, atTheDoor), false, 'someone a step outside the door hears nothing');
  assert.equal(hears(layout, atTheDoor, inMeeting), false, 'and is not heard inside');
  assert.ok(Math.hypot(inMeeting.x - atTheDoor.x, inMeeting.z - atTheDoor.z) < 8, 'although they stand a few metres apart');
  assert.equal(hears(layout, openFloor, inMeeting), false);
});

test('in the open office a voice carries as far as its range, and no further', () => {
  const at = (x: number) => ({ x, z: 4 });
  assert.equal(hears(layout, at(-20), at(-20 + VOICE_RANGE - 0.1)), true);
  assert.equal(hears(layout, at(-20), at(-20 + VOICE_RANGE + 0.1)), false);
  assert.equal(hears(layout, openFloor, openFloor), true);
  // Symmetric: who hears is heard.
  for (const [a, b] of [[openFloor, atTheDoor], [inMeeting, alsoInMeeting], [inMeeting, openFloor], [at(-20), at(20)]] as const) assert.equal(hears(layout, a, b), hears(layout, b, a));
});

test('a frame of voice is a short piece of base64 and nothing else', () => {
  assert.equal(validFrame(Buffer.alloc(640, 0x7f).toString('base64')), true, '40 ms at 16 kHz, a byte a sample');
  assert.equal(validFrame('QUJD'), true);
  assert.equal(validFrame('QUI='), true);
  for (const bad of ['', 'not base64!', 'QUJD\n', '=QUJD', 'A'.repeat(VOICE_FRAME_MAX + 1), 12, null, undefined, { data: 'QUJD' }, ['QUJD']]) assert.equal(validFrame(bad), false, JSON.stringify(bad)?.slice(0, 30));
});
