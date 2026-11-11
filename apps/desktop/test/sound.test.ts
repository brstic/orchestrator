import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeOutput, setOutputDevice, soundChoices } from '../src/lib/sound-devices.ts';
import { GATE_DEFAULT, GATE_HANG, GATE_MAX, GATE_MIN, cleanGate, makeGate } from '../src/lib/voice-gate.ts';
import { VOICE_FRAME, VOICE_RATE } from '../src/lib/voice-codec.ts';
import { VOICE_FRAMES_PER_SECOND } from '../../server/src/voice.ts';

test('an open microphone: only what is loud enough is sent, and the gaps between words are not cut out', () => {
  const gate = makeGate();
  const t = 0.02;
  // Silence and the room's hum: nothing goes out.
  assert.deepEqual([gate.step(0, t), gate.step(0.005, t), gate.step(0.019, t)], ['off', 'off', 'off']);
  // Speech begins, goes on, and a short gap inside it is still sent.
  assert.equal(gate.step(0.05, t), 'open');
  assert.equal(gate.step(0.2, t), 'on');
  for (let i = 0; i < GATE_HANG - 1; i++) assert.equal(gate.step(0.001, t), 'on', `quiet frame ${i + 1}`);
  // A word within the hang keeps it open, without "beginning" again.
  assert.equal(gate.step(0.03, t), 'on');
  // Silence for the whole hang: it closes once, and stays shut.
  const steps = Array.from({ length: GATE_HANG + 2 }, () => gate.step(0, t));
  assert.deepEqual(steps.slice(0, GATE_HANG - 1), Array(GATE_HANG - 1).fill('on'));
  assert.deepEqual(steps.slice(GATE_HANG - 1), ['close', 'off', 'off']);
  // The next word begins anew.
  assert.equal(gate.step(0.02, t), 'open', 'exactly as loud as the mark counts as speech');
});

test('an open microphone: switching it off shuts the gate at once, and says whether anyone has to be told', () => {
  const gate = makeGate();
  assert.equal(gate.reset(), false, 'nothing was going out');
  gate.step(0.5, 0.02);
  assert.equal(gate.reset(), true);
  assert.equal(gate.step(0.001, 0.02), 'off', 'no hang is left over');
  assert.equal(gate.step(0.5, 0.02), 'open');
});

test('an open microphone stays within what the office accepts from one window', () => {
  // Talking without a pause sends every frame, plus one frame kept from before each beginning.
  const perSecond = VOICE_RATE / VOICE_FRAME;
  assert.ok(perSecond + 2 <= VOICE_FRAMES_PER_SECOND, `${perSecond} frames a second`);
  // The gaps that are still sent are short: under a second.
  assert.ok((GATE_HANG * VOICE_FRAME) / VOICE_RATE < 1);
});

test('the mark of the gate is kept within its range, whatever was stored', () => {
  assert.equal(cleanGate(0.03), 0.03);
  assert.equal(cleanGate(0), GATE_MIN);
  assert.equal(cleanGate(5), GATE_MAX);
  assert.equal(cleanGate('loud'), GATE_DEFAULT);
  assert.equal(cleanGate(Number.NaN, 0.05), 0.05);
  assert.ok(GATE_MIN < GATE_DEFAULT && GATE_DEFAULT < GATE_MAX);
});

test('the devices offered in Settings → Sound', () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Default - Headset Microphone' },
    { kind: 'audioinput', deviceId: 'communications', label: 'Communications - Headset Microphone' },
    { kind: 'audioinput', deviceId: 'mic-1', label: 'Headset Microphone' },
    { kind: 'audioinput', deviceId: 'mic-2', label: 'Webcam' },
    { kind: 'audioinput', deviceId: 'mic-2', label: 'Webcam' },
    { kind: 'audiooutput', deviceId: 'default', label: 'Default - Speakers' },
    { kind: 'audiooutput', deviceId: 'out-1', label: 'Speakers' },
    { kind: 'audiooutput', deviceId: 'out-2', label: 'Headphones' },
    { kind: 'videoinput', deviceId: 'cam-1', label: 'Webcam' },
  ];
  // The browser's own "default" entries are left out ("System default" is the settings' own), nothing is listed twice.
  assert.deepEqual(soundChoices(devices, 'audioinput'), { choices: [{ id: 'mic-1', label: 'Headset Microphone' }, { id: 'mic-2', label: 'Webcam' }], named: true });
  assert.deepEqual(soundChoices(devices, 'audiooutput', 'out-2').choices, [{ id: 'out-1', label: 'Speakers' }, { id: 'out-2', label: 'Headphones' }]);
  // Headphones that were chosen and are unplugged stay in the list, marked — the choice is not lost.
  assert.deepEqual(soundChoices(devices, 'audiooutput', 'gone').choices.at(-1), { id: 'gone', label: 'The chosen device — not connected right now', missing: true });
  // Before the microphone was allowed the browser gives no names (and sometimes no ids at all).
  const anonymous = [
    { kind: 'audioinput', deviceId: '', label: '' },
    { kind: 'audiooutput', deviceId: 'a', label: '' },
    { kind: 'audiooutput', deviceId: 'b', label: '' },
  ];
  assert.deepEqual(soundChoices(anonymous, 'audioinput'), { choices: [], named: false });
  assert.deepEqual(soundChoices(anonymous, 'audiooutput'), { choices: [{ id: 'a', label: 'Output 1' }, { id: 'b', label: 'Output 2' }], named: false });
});

test('everything that makes sound follows the chosen output device', async () => {
  const sink = (log: string[]) => ({ setSinkId: async (id: string) => void log.push(id) });
  const early: string[] = [];
  const late: string[] = [];
  const stubborn = { setSinkId: async () => Promise.reject(new Error('unplugged')) };
  // Made before anything was chosen: left on the system's device, not touched.
  routeOutput(sink(early));
  routeOutput({}); // a browser that cannot choose: nothing to call, nothing breaks
  routeOutput(stubborn);
  assert.deepEqual(early, []);
  setOutputDevice('headphones');
  assert.deepEqual(early, ['headphones']);
  // Made afterwards: on the chosen device from the start.
  routeOutput(sink(late));
  assert.deepEqual(late, ['headphones']);
  setOutputDevice('headphones');
  assert.deepEqual(early, ['headphones'], 'the same choice again changes nothing');
  // Back to the system's own: those that were moved are told.
  setOutputDevice('');
  assert.deepEqual([early, late], [['headphones', ''], ['headphones', '']]);
  await new Promise((r) => setTimeout(r, 5)); // the refusal of the unplugged device is swallowed, not thrown
});
