import type { ArcadeMediaKind, ClientToServer } from '@orchestrator/contracts';
import { fromBase64, toBase64 } from './net.ts';
import { CAST_HEIGHT, CAST_WIDTH } from './protocol.ts';

/**
 * A game shown to others in the office (docs/ARCADE.md, "Playing with somebody in the office"). The host's console
 * hands over what it draws and plays; `Caster` packs it small (VP8 and Opus, through the browser's own encoders) and
 * sends it through the office; `Viewer`, at the other end, unpacks it onto a canvas and into the loudspeaker.
 * Nothing waits for anything: a picture is shown when it arrives, and one that cannot be shown is asked for again.
 */

/** How to read what follows; sent first, and again to whoever sits down later. */
interface CastConfig {
  v: { codec: string; width: number; height: number };
  a: { codec: string; rate: number; channels: number } | null;
}

const VIDEO = { codec: 'vp8', width: CAST_WIDTH, height: CAST_HEIGHT };
/** A picture that stands by itself, this often at least: somebody whose picture broke up is back within it. */
const KEY_EVERY = 240;

/** Whether this browser can show a game to others, and be shown one. */
export const canCast = (): boolean => typeof VideoEncoder === 'function' && typeof VideoDecoder === 'function';

type Send = (m: ClientToServer) => void;

export class Caster {
  private send: Send;
  private video: VideoEncoder | null = null;
  private audio: AudioEncoder | null = null;
  private audioRate = 0;
  private audioAt = 0;
  private frames = 0;
  private wantKey = true;
  private over = false;
  /** Pictures and pieces of sound sent, for whoever wants to know that it is going out. */
  sent = { v: 0, a: 0 };

  constructor(send: Send) {
    this.send = send;
  }

  private put(kind: ArcadeMediaKind, data: Uint8Array, ts: number, key = false): void {
    if (this.over) return;
    this.send({ t: 'arcade.media', kind, ...(key ? { key: true } : {}), ts, data: toBase64(data) });
  }

  private config(): void {
    const cfg: CastConfig = { v: VIDEO, a: this.audio ? { codec: 'opus', rate: this.audioRate, channels: 2 } : null };
    this.put('cfg', new TextEncoder().encode(JSON.stringify(cfg)), 0);
  }

  /** Somebody sat down, or lost the picture: tell them how to read it, and send one that stands by itself. */
  keyframe(): void {
    this.config();
    this.wantKey = true;
  }

  /** A picture of the console's screen. It is ours to close. */
  frame(bitmap: ImageBitmap, ts: number): void {
    if (this.over) return bitmap.close();
    try {
      if (!this.video) {
        this.video = new VideoEncoder({
          output: (chunk) => {
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            this.sent.v++;
            this.put('v', bytes, chunk.timestamp, chunk.type === 'key');
          },
          error: () => {
            // The encoder gave up: the next picture starts a new one.
            this.video = null;
            this.wantKey = true;
          },
        });
        this.video.configure({ ...VIDEO, bitrate: 1_500_000, framerate: 60, latencyMode: 'realtime' });
        this.config();
      }
      // Behind? This picture is not worth waiting for: the next one is newer.
      if (this.video.encodeQueueSize > 2) return bitmap.close();
      const frame = new VideoFrame(bitmap, { timestamp: ts });
      const key = this.wantKey || this.frames % KEY_EVERY === 0;
      this.wantKey = false;
      this.frames++;
      this.video.encode(frame, { keyFrame: key });
      frame.close();
    } catch {
      this.video = null;
      this.wantKey = true;
    } finally {
      bitmap.close();
    }
  }

  /** A piece of the console's sound, both channels. */
  pcm(rate: number, left: ArrayBuffer, right: ArrayBuffer): void {
    if (this.over || typeof AudioEncoder !== 'function') return;
    try {
      if (!this.audio || this.audioRate !== rate) {
        this.audio?.close();
        this.audioRate = rate;
        this.audioAt = 0;
        this.audio = new AudioEncoder({
          output: (chunk) => {
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            this.sent.a++;
            this.put('a', bytes, chunk.timestamp);
          },
          error: () => (this.audio = null),
        });
        this.audio.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 2, bitrate: 96_000 });
        this.config();
      }
      const l = new Float32Array(left);
      const r = new Float32Array(right);
      const both = new Float32Array(l.length * 2);
      both.set(l, 0);
      both.set(r, l.length);
      const data = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: l.length, numberOfChannels: 2, timestamp: Math.round((this.audioAt / rate) * 1e6), data: both });
      this.audioAt += l.length;
      this.audio.encode(data);
      data.close();
    } catch {
      this.audio = null;
    }
  }

  close(): void {
    this.over = true;
    for (const e of [this.video, this.audio]) {
      try {
        e?.close();
      } catch {
        // Closed already.
      }
    }
    this.video = this.audio = null;
  }
}

export class Viewer {
  private canvas: HTMLCanvasElement;
  private draw: CanvasRenderingContext2D;
  private askKey: () => void;
  private video: VideoDecoder | null = null;
  private audio: AudioDecoder | null = null;
  private cfg: CastConfig | null = null;
  private waitingForKey = true;
  private out: AudioContext | null = null;
  private volume: GainNode | null = null;
  private playAt = 0;
  private soundOn: boolean;
  private over = false;
  /** Pictures shown and pieces of sound played. */
  shown = { v: 0, a: 0 };
  /** Called with the first picture, and never again. */
  onFirst: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, askKey: () => void, sound: boolean) {
    this.canvas = canvas;
    canvas.width = CAST_WIDTH;
    canvas.height = CAST_HEIGHT;
    this.draw = canvas.getContext('2d')!;
    this.askKey = askKey;
    this.soundOn = sound;
  }

  /** A piece from the host, as the office passed it on. */
  hear(kind: ArcadeMediaKind, key: boolean, ts: number, data: string): void {
    if (this.over) return;
    try {
      if (kind === 'cfg') return this.configure(JSON.parse(new TextDecoder().decode(fromBase64(data))) as CastConfig);
      if (!this.cfg) return this.askKey();
      if (kind === 'v') {
        // A picture is built on the one before: after a gap, nothing can be shown until one comes that stands by itself.
        if (this.waitingForKey && !key) return;
        if (!this.video) this.openVideo();
        this.waitingForKey = false;
        this.video!.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts, data: fromBase64(data) }));
      } else if (kind === 'a' && this.cfg.a && typeof AudioDecoder === 'function') {
        if (!this.audio) this.openAudio();
        this.audio!.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, data: fromBase64(data) }));
      }
    } catch {
      this.lost();
    }
  }

  private configure(cfg: CastConfig): void {
    const same = JSON.stringify(cfg) === JSON.stringify(this.cfg);
    this.cfg = cfg;
    if (same) return;
    // A new way of reading: what was open reads the old one.
    this.closeDecoders();
    this.waitingForKey = true;
  }

  private lost(): void {
    this.closeDecoders();
    this.waitingForKey = true;
    this.askKey();
  }

  private openVideo(): void {
    this.video = new VideoDecoder({
      output: (frame) => {
        if (!this.over) {
          this.draw.imageSmoothingEnabled = false;
          this.draw.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
          if (this.shown.v++ === 0) this.onFirst?.();
        }
        frame.close();
      },
      error: () => this.lost(),
    });
    this.video.configure({ codec: this.cfg!.v.codec, codedWidth: this.cfg!.v.width, codedHeight: this.cfg!.v.height, optimizeForLatency: true });
  }

  private openAudio(): void {
    const a = this.cfg!.a!;
    this.audio = new AudioDecoder({ output: (data) => this.play(data), error: () => (this.audio = null) });
    this.audio.configure({ codec: a.codec, sampleRate: a.rate, numberOfChannels: a.channels });
  }

  /** A piece of sound, played right behind the one before it — or a moment from now, when nothing is waiting. */
  private play(data: AudioData): void {
    try {
      if (this.over) return;
      if (!this.out) {
        this.out = new AudioContext();
        this.volume = this.out.createGain();
        this.volume.gain.value = this.soundOn ? 1 : 0;
        this.volume.connect(this.out.destination);
      }
      const ctx = this.out;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
      const frames = data.numberOfFrames;
      const buffer = ctx.createBuffer(data.numberOfChannels, frames, data.sampleRate);
      for (let ch = 0; ch < data.numberOfChannels; ch++) {
        const plane = new Float32Array(frames);
        data.copyTo(plane, { planeIndex: ch, format: 'f32-planar' });
        buffer.copyToChannel(plane, ch);
      }
      const now = ctx.currentTime;
      // Too much waiting to be played is sound that lags behind the picture: this piece is let go, and the rest catches up.
      if (this.playAt - now > 0.25) return;
      const at = Math.max(now + 0.04, this.playAt);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.volume!);
      src.start(at);
      this.playAt = at + buffer.duration;
      this.shown.a++;
    } finally {
      data.close();
    }
  }

  sound(on: boolean): void {
    this.soundOn = on;
    if (this.volume) this.volume.gain.value = on ? 1 : 0;
    if (on && this.out?.state === 'suspended') void this.out.resume().catch(() => undefined);
  }

  private closeDecoders(): void {
    for (const d of [this.video, this.audio]) {
      try {
        d?.close();
      } catch {
        // Closed already.
      }
    }
    this.video = this.audio = null;
  }

  close(): void {
    this.over = true;
    this.closeDecoders();
    void this.out?.close().catch(() => undefined);
    this.out = null;
  }
}
