import type { PersonPresence } from '@orchestrator/contracts';
import { ownerPosition, voiceFalloff } from '@orchestrator/office-3d';
import { connection } from './api.ts';
import { VOICE_FRAME, VOICE_RATE, decodeVoice, encodeVoice, fromBase64, loudness, toBase64 } from './voice-codec.ts';

/**
 * Talking in the office (push to talk).
 *
 * While the talk key is held, this window's microphone is sent to the office in small frames; the office passes
 * each on to the windows of the people within earshot of this person's character, and to nobody else (a meeting
 * room keeps what is said in it: `apps/server/src/voice.ts`). What arrives here from others is played at once, each
 * voice as loud as its speaker is near: full when they stand together, fading with every step, gone some desks
 * away (`voiceFalloff`). The listener is this person's character, as for the hi-fi.
 *
 * The microphone is opened the first time the key is pressed (the browser asks then; the desktop app does not) and
 * let go of a minute after the last word, so no microphone light stays on in an office nobody is talking in.
 * Nothing is recorded or kept, here or in the office.
 */

/** What this module needs from the page, set once by the store (which this module must not import: the store imports it). */
export const voiceHooks: {
  people: () => PersonPresence[];
  volume: () => number;
  /** Someone started or stopped being heard here. */
  speaking: (clientId: string, on: boolean) => void;
  /** This window started or stopped sending; `error` when the microphone could not be opened. */
  talking: (on: boolean, error?: string) => void;
  /** How loud the microphone is right now, 0…1 (for the light beside "Talking"). */
  level: (level: number) => void;
} = { people: () => [], volume: () => 1, speaking: () => undefined, talking: () => undefined, level: () => undefined };

// ───────────────────────────── speaking ─────────────────────────────

interface Mic {
  stream: MediaStream;
  ctx: AudioContext;
  node: ScriptProcessorNode;
}
let mic: Mic | null = null;
let opening: Promise<Mic> | null = null;
let held = false;
let seq = 0;
let release: number | null = null;

async function openMic(): Promise<Mic> {
  if (mic) return mic;
  if (opening) return opening;
  opening = (async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This page cannot use a microphone: it has to be opened over https, or in the Orchestrator app.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    // A context at the rate the office speaks in: the browser does the resampling, well.
    const ctx = new AudioContext({ sampleRate: VOICE_RATE });
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(VOICE_FRAME, 1, 1);
    node.onaudioprocess = (ev) => {
      if (!held) return;
      const samples = ev.inputBuffer.getChannelData(0);
      voiceHooks.level(loudness(samples));
      connection.send({ t: 'voice', seq: seq++, data: toBase64(encodeVoice(samples)) });
    };
    // The node only runs while it leads somewhere; what it puts out is silence (its output buffer is never written).
    const sink = ctx.createGain();
    sink.gain.value = 0;
    source.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    mic = { stream, ctx, node };
    return mic;
  })();
  try {
    return await opening;
  } finally {
    opening = null;
  }
}

function closeMic(): void {
  if (!mic || held) return;
  for (const track of mic.stream.getTracks()) track.stop();
  mic.node.disconnect();
  void mic.ctx.close();
  mic = null;
}

const WHY: Record<string, string> = {
  NotAllowedError: 'The microphone is not allowed for this page. Allow it (the icon in the address bar, or your system’s privacy settings) and hold the key again.',
  NotFoundError: 'No microphone was found on this computer.',
  NotReadableError: 'The microphone is in use by another program, or could not be started.',
};

/** The talk key went down: open the microphone if need be, and send until the key comes up. */
export function startTalking(): void {
  if (held) return;
  held = true;
  if (release) window.clearTimeout(release);
  release = null;
  void openMic().then(
    (m) => {
      if (!held) return scheduleRelease(); // let go before the microphone was there
      void m.ctx.resume();
      voiceHooks.talking(true);
    },
    (e: Error) => {
      held = false;
      voiceHooks.talking(false, WHY[e.name] ?? `The microphone could not be opened: ${e.message}`);
    },
  );
}

function scheduleRelease(): void {
  if (release) window.clearTimeout(release);
  release = window.setTimeout(closeMic, 60_000);
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
  return voiceHooks.volume() * voiceFalloff(Math.hypot(p.x - ownerPosition.x, p.z - ownerPosition.z));
}

/** A frame of someone's voice arrived. */
export function hearVoice(clientId: string, data: string): void {
  const bytes = fromBase64(data);
  if (!bytes || !bytes.length || bytes.length > 4096) return;
  try {
    out ??= new AudioContext();
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
(window as unknown as { __orchVoice?: unknown }).__orchVoice = () => ({ talking: held, mic: !!mic, speakers: [...speakers.keys()].map((id) => ({ id, loudness: loudnessOf(id) })) });
