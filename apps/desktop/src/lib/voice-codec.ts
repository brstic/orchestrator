/**
 * How a voice travels through the office: 16 kHz mono, one byte a sample (µ-law, the telephone's own companding:
 * quiet sounds keep their detail, loud ones are squeezed), in frames of a few hundred samples, as base64 inside
 * the office's ordinary messages. About 21 kB a second while someone talks — and nothing while nobody does.
 *
 * Plain arithmetic, no browser needed: the same functions are run by the tests.
 */

/** Samples a second, at capture and in every frame. Speech needs no more; a frame stays small. */
export const VOICE_RATE = 16000;
/** Samples in a frame as it is captured: 32 ms. (The office accepts frames up to 40 ms and a little.) */
export const VOICE_FRAME = 512;

const BIAS = 0x84;
const CLIP = 32635;

/** One 16-bit sample → one µ-law byte (ITU-T G.711). */
function toMuLaw(sample: number): number {
  const sign = sample < 0 ? 0x80 : 0;
  let s = sign ? -sample : sample;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** One µ-law byte → one 16-bit sample. */
function fromMuLaw(byte: number): number {
  const u = ~byte & 0xff;
  const exponent = (u >> 4) & 0x07;
  const s = (((u & 0x0f) << 3) + BIAS) << exponent;
  return u & 0x80 ? BIAS - s : s - BIAS;
}

/** Sound as the browser has it (−1…1) → the bytes of a frame. Anything louder than full scale is clipped, not wrapped. */
export function encodeVoice(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    out[i] = toMuLaw(Math.round((v > 1 ? 1 : v < -1 ? -1 : Number.isFinite(v) ? v : 0) * 32767));
  }
  return out;
}

/** The bytes of a frame → sound for the browser (−1…1). */
export function decodeVoice(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = fromMuLaw(bytes[i]!) / 32768;
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]!);
  return btoa(text);
}

/** null for something that is not base64 (a frame from a window that is not ours). */
export function fromBase64(text: string): Uint8Array | null {
  try {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** How loud a frame is, 0…1 (root mean square): for the light that shows the microphone is picking something up. */
export function loudness(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}
