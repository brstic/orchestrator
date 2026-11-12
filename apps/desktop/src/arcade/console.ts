import coreJs from './core/genesis_plus_gx_libretro.js.gz?url';
import coreWasm from './core/genesis_plus_gx_libretro.wasm.gz?url';
import type { FromConsole, PadButton, Player, SoundState, ToConsole } from './protocol.ts';

/**
 * The arcade window's hold on its console (the frame, `frame.ts`): it hands the console the core and a cartridge,
 * passes on button presses, and asks back what is worth keeping.
 */

/** The emulator core, as it lies beside the app: packed, and unpacked once for as long as the page lives. */
let core: Promise<{ js: ArrayBuffer; wasm: ArrayBuffer }> | null = null;

async function unpacked(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`the console's core could not be fetched (${res.status})`);
  const packed = await res.arrayBuffer();
  const head = new Uint8Array(packed, 0, 2);
  // Whoever served the file may have unpacked it on the way already.
  if (head[0] !== 0x1f || head[1] !== 0x8b) return packed;
  return new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export function loadCore(): Promise<{ js: ArrayBuffer; wasm: ArrayBuffer }> {
  core ??= Promise.all([unpacked(coreJs), unpacked(coreWasm)])
    .then(([js, wasm]) => ({ js, wasm }))
    .catch((e) => {
      core = null;
      throw e;
    });
  return core;
}

export interface KeptNow {
  sram?: ArrayBuffer;
  state?: ArrayBuffer;
  shot?: ArrayBuffer;
}

export class ArcadeConsole {
  private frame: HTMLIFrameElement;
  private on: { running: () => void; failed: (message: string) => void; sound: (state: SoundState) => void };
  private hello: Promise<void>;
  private greeted!: () => void;
  private asked = new Map<number, (kept: KeptNow) => void>();
  private next = 1;
  private gone = false;

  constructor(frame: HTMLIFrameElement, on: ArcadeConsole['on']) {
    this.frame = frame;
    this.on = on;
    this.hello = new Promise((resolve) => (this.greeted = resolve));
    window.addEventListener('message', this.hear);
  }

  private hear = (ev: MessageEvent<FromConsole>): void => {
    // Only the console itself: the frame is no origin at all, so who is speaking is told by the window, not the origin.
    if (ev.source !== this.frame.contentWindow || !ev.data || typeof ev.data !== 'object') return;
    const m = ev.data;
    if (m.t === 'hello') this.greeted();
    else if (m.t === 'running') this.on.running();
    else if (m.t === 'failed') this.on.failed(m.message);
    else if (m.t === 'sound') this.on.sound(m.state);
    else if (m.t === 'kept') {
      this.asked.get(m.id)?.({ sram: m.sram, state: m.state, shot: m.shot });
      this.asked.delete(m.id);
    }
  };

  private tell(m: ToConsole): void {
    if (!this.gone) this.frame.contentWindow?.postMessage(m, '*');
  }

  /** Switch on with a cartridge and what was kept of it. */
  async start(rom: { name: string; bytes: ArrayBuffer }, kept: { sram?: ArrayBuffer; state?: ArrayBuffer }, sound: boolean): Promise<void> {
    const [loaded] = await Promise.all([loadCore(), this.hello]);
    this.tell({ t: 'boot', core: loaded, rom, sram: kept.sram, state: kept.state, sound });
  }

  pad(player: Player, button: PadButton, down: boolean): void {
    this.tell({ t: 'pad', player, button, down });
  }
  pause(): void {
    this.tell({ t: 'pause' });
  }
  resume(): void {
    this.tell({ t: 'resume' });
  }
  reset(): void {
    this.tell({ t: 'reset' });
  }
  sound(on: boolean): void {
    this.tell({ t: 'sound', on });
  }
  restore(state: ArrayBuffer): void {
    this.tell({ t: 'restore', state });
  }

  /** What the console holds that is worth keeping. A console that does not answer keeps nothing, and says so by an empty answer. */
  keep(state: boolean): Promise<KeptNow> {
    if (this.gone) return Promise.resolve({});
    const id = this.next++;
    return new Promise<KeptNow>((resolve) => {
      this.asked.set(id, resolve);
      this.tell({ t: 'keep', id, state });
      setTimeout(() => {
        if (this.asked.delete(id)) resolve({});
      }, 8000);
    });
  }

  dispose(): void {
    this.gone = true;
    window.removeEventListener('message', this.hear);
    for (const resolve of this.asked.values()) resolve({});
    this.asked.clear();
  }
}
