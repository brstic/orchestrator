/**
 * Small synthesized sound effects (Web Audio, no files): the crack of the owner's whip and the
 * "jao!" of whoever it was aimed at. A joke with no effect on anyone's work.
 */
import { routeOutput } from './sound-devices.ts';

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= routeOutput(new (window.AudioContext || (window as any).webkitAudioContext)() as AudioContext);
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** A short, bright crack: a burst of filtered noise with a fast swoosh before it. */
export function playWhip(volume = 0.7): void {
  const ac = audio();
  if (!ac) return;
  const now = ac.currentTime;
  const noise = (seconds: number) => {
    const buf = ac.createBuffer(1, Math.ceil(ac.sampleRate * seconds), ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    return src;
  };
  // Swoosh: band-passed noise sweeping upward.
  const swoosh = noise(0.22);
  const sf = ac.createBiquadFilter();
  sf.type = 'bandpass';
  sf.Q.value = 1.2;
  sf.frequency.setValueAtTime(500, now);
  sf.frequency.exponentialRampToValueAtTime(5200, now + 0.2);
  const sg = ac.createGain();
  sg.gain.setValueAtTime(0.0001, now);
  sg.gain.exponentialRampToValueAtTime(0.25 * volume, now + 0.15);
  sg.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
  swoosh.connect(sf).connect(sg).connect(ac.destination);
  swoosh.start(now);
  // Crack: a very short high-passed click with a snappy tail.
  const at = now + 0.2;
  const crack = noise(0.12);
  const cf = ac.createBiquadFilter();
  cf.type = 'highpass';
  cf.frequency.value = 1800;
  const cg = ac.createGain();
  cg.gain.setValueAtTime(volume, at);
  cg.gain.exponentialRampToValueAtTime(0.0001, at + 0.11);
  crack.connect(cf).connect(cg).connect(ac.destination);
  crack.start(at);
  const thump = ac.createOscillator();
  thump.type = 'triangle';
  thump.frequency.setValueAtTime(900, at);
  thump.frequency.exponentialRampToValueAtTime(140, at + 0.06);
  const tg = ac.createGain();
  tg.gain.setValueAtTime(0.5 * volume, at);
  tg.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
  thump.connect(tg).connect(ac.destination);
  thump.start(at);
  thump.stop(at + 0.08);
}

/**
 * "Jao!" — a voice-like yelp: a buzzy source through two moving formant filters, gliding from
 * an open "a" to a round "o" while the pitch falls. `seed` (0–1) gives each employee their own voice.
 */
export function playOuch(seed = 0.5, delay = 0.24, volume = 0.6): void {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + delay;
  const dur = 0.42 + seed * 0.12;
  const pitch = 150 + seed * 170;
  const src = ac.createOscillator();
  src.type = 'sawtooth';
  src.frequency.setValueAtTime(pitch * 1.5, t);
  src.frequency.exponentialRampToValueAtTime(pitch * 1.75, t + 0.07);
  src.frequency.exponentialRampToValueAtTime(pitch * 0.85, t + dur);
  // A little vibrato makes it a voice rather than a buzzer.
  const vib = ac.createOscillator();
  vib.frequency.value = 6.5;
  const vibGain = ac.createGain();
  vibGain.gain.value = pitch * 0.03;
  vib.connect(vibGain).connect(src.frequency);
  const formant = (from: number, to: number, q: number, gain: number) => {
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    f.frequency.exponentialRampToValueAtTime(to, t + dur * 0.8);
    const g = ac.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(env);
  };
  const env = ac.createGain();
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(volume, t + 0.03);
  env.gain.setValueAtTime(volume, t + dur * 0.55);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  // "a" (F1≈800, F2≈1250) → "o" (F1≈430, F2≈820); a third formant keeps it from sounding hollow.
  formant(820, 430, 6, 1);
  formant(1250, 820, 8, 0.7);
  formant(2600, 2400, 9, 0.25);
  env.connect(ac.destination);
  src.start(t);
  vib.start(t);
  src.stop(t + dur + 0.02);
  vib.stop(t + dur + 0.02);
}

/** Three knocks on a wooden door: someone is asking to be let in. */
export function playKnock(volume = 0.5): void {
  const ac = audio();
  if (!ac) return;
  const start = ac.currentTime + 0.02;
  for (let i = 0; i < 3; i++) {
    const t = start + i * 0.17;
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(190, t);
    osc.frequency.exponentialRampToValueAtTime(70, t + 0.09);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(volume, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    osc.connect(g).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.14);
  }
}

/** Two soft rising notes: someone you asked has answered. */
export function playReply(volume = 0.22): void {
  const ac = audio();
  if (!ac) return;
  const start = ac.currentTime + 0.02;
  [660, 880].forEach((hz, i) => {
    const t = start + i * 0.13;
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = hz;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(volume, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    osc.connect(g).connect(ac.destination);
    osc.start(t);
    osc.stop(t + 0.35);
  });
}
