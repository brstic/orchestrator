import type { PersonPresence } from '@orchestrator/contracts';
import { ownerOutside, ownerPosition, voiceFalloff } from '@orchestrator/office-3d';
import { apart } from '@orchestrator/contracts';
import { connection } from './api.ts';
import { routeOutput } from './sound-devices.ts';
import { VOICE_FRAME, VOICE_RATE, decodeVoice, encodeVoice, fromBase64, loudness, toBase64 } from './voice-codec.ts';
import { GATE_DEFAULT, makeGate } from './voice-gate.ts';

/**
 * Talking in the office.
 *
 * Two ways, this person's choice (Settings → Sound):
 *   - **hold the key** (push to talk): while the talk key is held, this window's microphone is sent;
 *   - **always on**: the microphone stays open and what is loud enough to be speech is sent by itself (the gate,
 *     `voice-gate.ts`); the talk key then switches the microphone off and on.
 *
 * Either way the sound goes to the office in small frames; the office passes each on to the windows of the people
 * within earshot of this person's character, and to nobody else (a meeting room keeps what is said in it:
 * `apps/server/src/voice.ts`). What arrives here from others is played at once, each voice as loud as its speaker
 * is near: full when they stand together, fading with every step, gone some desks away (`voiceFalloff`). The
 * listener is this person's character, as for the hi-fi.
 *
 * With the key, the microphone is opened the first time it is pressed (the browser asks then; the desktop app does
 * not) and let go of a minute after the last word, so no microphone light stays on in an office nobody is talking
 * in. Always on, it stays open until it is switched off with the key — and is let go of a minute after that.
 * Nothing is recorded or kept, here or in the office.
 */

export interface VoiceSettings {
  /** 'hold': push to talk. 'open': the microphone is always on. */
  mode: 'hold' | 'open';
  /** The microphone to use; '' for the system's own choice. */
  input: string;
  /** With the microphone always on: how loud a frame has to be to be sent (root mean square, 0…1). */
  gate: number;
}

/** What this module needs from the page, set once by the store and the preferences (which this module must not import: they import it). */
export const voiceHooks: {
  people: () => PersonPresence[];
  volume: () => number;
  settings: () => VoiceSettings;
  /** Someone started or stopped being heard here. */
  speaking: (clientId: string, on: boolean) => void;
  /** This window started or stopped sending; `error` when the microphone could not be opened. */
  talking: (on: boolean, error?: string) => void;
  /** How loud the microphone is right now, 0…1 (for the light beside "Talking"). */
  level: (level: number) => void;
  /** The microphone is always on (or no longer), and whether it is switched off for the moment. */
  mic: (open: boolean, off: boolean) => void;
} = {
  people: () => [],
  volume: () => 1,
  settings: () => ({ mode: 'hold', input: '', gate: GATE_DEFAULT }),
  speaking: () => undefined,
  talking: () => undefined,
  level: () => undefined,
  mic: () => undefined,
};

// ───────────────────────────── speaking ─────────────────────────────

interface Mic {
  stream: MediaStream;
  ctx: AudioContext;
  node: ScriptProcessorNode;
  /** The device that was asked for when it was opened ('' for the system's). */
  asked: string;
}
let mic: Mic | null = null;
let opening: Promise<Mic> | null = null;
/** The talk key is down (push to talk). */
let held = false;
/** The microphone is always on… */
let openMode = false;
/** …but switched off for the moment, with the talk key. */
let micOff = false;
/** Always on: the gate is open and frames are going out. */
let sending = false;
/** Always on: the frame before this one, sent first when speech begins so its first sound is not clipped. */
let prev: Float32Array | null = null;
const gate = makeGate();
let wantedInput = '';
let lastLevel = 0;
let seq = 0;
let release: number | null = null;

/** Is the microphone needed right now? */
const needed = (): boolean => held || (openMode && !micOff);

function send(samples: Float32Array): void {
  connection.send({ t: 'voice', seq: seq++, data: toBase64(encodeVoice(samples)) });
}

function endSending(): void {
  if (!sending) return;
  sending = false;
  voiceHooks.level(0);
  voiceHooks.talking(false);
  connection.send({ t: 'voice.end' });
}

function onFrame(samples: Float32Array): void {
  lastLevel = loudness(samples);
  if (held) {
    voiceHooks.level(lastLevel);
    send(samples);
    return;
  }
  if (!openMode || micOff) return;
  const step = gate.step(lastLevel, voiceHooks.settings().gate);
  if (step === 'open') {
    sending = true;
    voiceHooks.talking(true);
    if (prev) send(prev);
    send(samples);
  } else if (step === 'on') send(samples);
  else if (step === 'close') endSending();
  if (sending) voiceHooks.level(lastLevel);
  // (A copy: the browser fills the same buffer again for the next frame.)
  prev = step === 'off' ? samples.slice() : null;
}

async function capture(deviceId: string): Promise<MediaStream> {
  const audio = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  if (!deviceId) return navigator.mediaDevices.getUserMedia({ audio, video: false });
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { ...audio, deviceId: { exact: deviceId } }, video: false });
  } catch (e) {
    // The chosen microphone is not connected (any more): the system's own is better than none.
    const name = (e as Error).name;
    if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw e;
    return navigator.mediaDevices.getUserMedia({ audio, video: false });
  }
}

async function openMic(): Promise<Mic> {
  if (mic) return mic;
  if (opening) return opening;
  opening = (async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This page cannot use a microphone: it has to be opened over https, or in the Orchestrator app.');
    const asked = wantedInput;
    const stream = await capture(asked);
    // A context at the rate the office speaks in: the browser does the resampling, well.
    const ctx = new AudioContext({ sampleRate: VOICE_RATE });
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(VOICE_FRAME, 1, 1);
    node.onaudioprocess = (ev) => onFrame(ev.inputBuffer.getChannelData(0));
    // The node only runs while it leads somewhere; what it puts out is silence (its output buffer is never written).
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    mic = { stream, ctx, node, asked };
    return mic;
  })();
  try {
    return await opening;
  } finally {
    opening = null;
  }
}

function closeNow(): void {
  if (!mic) return;
  for (const track of mic.stream.getTracks()) track.stop();
  mic.node.disconnect();
  void mic.ctx.close();
  mic = null;
  lastLevel = 0;
  prev = null;
}

function closeMic(): void {
  if (!needed()) closeNow();
}

const WHY: Record<string, string> = {
  NotAllowedError: 'The microphone is not allowed for this page. Allow it (the icon in the address bar, or your system’s privacy settings) and try again.',
  NotFoundError: 'No microphone was found on this computer.',
  NotReadableError: 'The microphone is in use by another program, or could not be started.',
};

/** A context made before the person touched the page may stand still until they do. */
function wake(ctx: AudioContext): void {
  void ctx.resume();
  if (ctx.state !== 'suspended') return;
  const go = () => {
    window.removeEventListener('pointerdown', go, true);
    window.removeEventListener('keydown', go, true);
    if (ctx.state === 'suspended') void ctx.resume();
  };
  window.addEventListener('pointerdown', go, true);
  window.addEventListener('keydown', go, true);
}

/** Have the microphone open, for as long as it is needed. */
function ensureMic(): void {
  if (release) window.clearTimeout(release);
  release = null;
  void openMic().then(
    (m) => {
      if (m.asked !== wantedInput) {
        // Another microphone was chosen while this one was being opened.
        closeNow();
        if (needed()) ensureMic();
        return;
      }
      if (!needed()) return scheduleRelease(); // let go before the microphone was there
      wake(m.ctx);
      if (held) voiceHooks.talking(true);
    },
    (e: Error) => {
      held = false;
      if (openMode && !micOff) {
        // Nothing is open: show it as switched off, so the talk key tries again.
        micOff = true;
        voiceHooks.mic(true, true);
      }
      voiceHooks.talking(false, WHY[e.name] ?? `The microphone could not be opened: ${e.message}`);
    },
  );
}

function scheduleRelease(): void {
  if (release) window.clearTimeout(release);
  release = window.setTimeout(closeMic, 60_000);
}

/** Always on: switch the microphone off for the moment, or back on. */
export function setMicOff(off: boolean): void {
  if (!openMode || off === micOff) return;
  micOff = off;
  voiceHooks.mic(true, off);
  if (off) {
    gate.reset();
    endSending();
    prev = null;
    scheduleRelease();
  } else ensureMic();
}

/**
 * The talk key went down. Push to talk: open the microphone if need be, and send until the key comes up.
 * With the microphone always on: the key switches it off, and on again.
 */
export function startTalking(): void {
  if (openMode) return setMicOff(!micOff);
  if (held) return;
  held = true;
  ensureMic();
}

/** The talk key came up. */
export function stopTalking(): void {
  if (!held) return;
  held = false;
  voiceHooks.level(0);
  voiceHooks.talking(false);
  connection.send({ t: 'voice.end' });
  scheduleRelease();
}

export const isTalking = (): boolean => held;

/** How loud the open microphone is right now (root mean square, 0…1; 0 when it is not open): for the meter in the settings. */
export const micLevel = (): number => (mic ? lastLevel : 0);

/** This person's settings changed (or were read): another microphone, or another way of talking. */
export function applyVoiceSettings(): void {
  const s = voiceHooks.settings();
  if (s.input !== wantedInput) {
    wantedInput = s.input;
    if (mic) {
      closeNow();
      if (needed()) ensureMic();
    }
  }
  const want = s.mode === 'open';
  if (want === openMode) return;
  if (want) {
    stopTalking();
    openMode = true;
    micOff = false;
    ensureMic();
  } else {
    openMode = false;
    micOff = false;
    gate.reset();
    endSending();
    prev = null;
    scheduleRelease();
  }
  voiceHooks.mic(openMode, micOff);
}

// ───────────────────────────── hearing ─────────────────────────────

interface Speaker {
  gain: GainNode;
  /** When (in the context's time) the sound scheduled so far ends. */
  next: number;
  /** When the last frame arrived (ms): someone whose frames stop without a word has stopped. */
  last: number;
}
let out: AudioContext | null = null;
const speakers = new Map<string, Speaker>();
let tending: number | null = null;

/** A little sound is kept in hand before playing, so frames that arrive unevenly do not crackle. */
const LEAD = 0.09;
/** More than this in hand means the window fell behind (it was in the background): skip ahead to now. */
const BEHIND = 0.6;

/** How loud this speaker is for the person at this window: by the distance between the two characters, times their own volume. */
function loudnessOf(clientId: string): number {
  const p = voiceHooks.people().find((x) => x.id === clientId);
  if (!p) return 0;
  // In the office by where the two stand; out in the city by where they are there (and not at all between the two).
  return voiceHooks.volume() * voiceFalloff(apart(p, { x: ownerPosition.x, z: ownerPosition.z, out: ownerOutside.at }));
}

/** A frame of someone's voice arrived. */
export function hearVoice(clientId: string, data: string): void {
  const bytes = fromBase64(data);
  if (!bytes || !bytes.length || bytes.length > 4096) return;
  try {
    // On the device this person chose for the office's sound (their headphones, say).
    out ??= routeOutput(new AudioContext());
  } catch {
    return; // no sound on this computer
  }
  // A page that nobody has clicked or typed in yet may not make sound; it starts with the first key or click.
  if (out.state === 'suspended') void out.resume();
  let s = speakers.get(clientId);
  if (!s) {
    const gain = out.createGain();
    gain.gain.value = loudnessOf(clientId);
    gain.connect(out.destination);
    speakers.set(clientId, (s = { gain, next: 0, last: 0 }));
    voiceHooks.speaking(clientId, true);
  }
  s.last = Date.now();
  const samples = decodeVoice(bytes);
  const buffer = out.createBuffer(1, samples.length, VOICE_RATE);
  buffer.getChannelData(0).set(samples);
  const source = out.createBufferSource();
  source.buffer = buffer;
  source.connect(s.gain);
  const now = out.currentTime;
  if (s.next < now + 0.01 || s.next > now + BEHIND) s.next = now + LEAD;
  source.start(s.next);
  s.next += buffer.duration;
  tending ??= window.setInterval(tend, 100);
}

/** They let go of the key (or went away). */
export function heardEnd(clientId: string): void {
  const s = speakers.get(clientId);
  if (!s) return;
  speakers.delete(clientId);
  voiceHooks.speaking(clientId, false);
  // What is already scheduled plays out (a fraction of a second); then the node is taken away.
  window.setTimeout(() => s.gain.disconnect(), 800);
}

/** Ten times a second: every voice as loud as its speaker is near right now, and whoever fell silent is let go. */
function tend(): void {
  const now = Date.now();
  for (const [id, s] of speakers) {
    if (now - s.last > 700) {
      heardEnd(id);
      continue;
    }
    if (out) s.gain.gain.setTargetAtTime(loudnessOf(id), out.currentTime, 0.06);
  }
  if (!speakers.size && tending) {
    window.clearInterval(tending);
    tending = null;
  }
}

// For the UI tests and for looking at it by hand.
(window as unknown as { __orchVoice?: unknown }).__orchVoice = () => ({ talking: held || sending, mic: !!mic, open: openMode, off: micOff, level: lastLevel, speakers: [...speakers.keys()].map((id) => ({ id, loudness: loudnessOf(id) })) });
