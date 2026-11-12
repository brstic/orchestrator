import { Nostalgist } from 'nostalgist';
import { CAST_HEIGHT, CAST_WIDTH, type FromConsole, type PadButton, type Player, type SoundState, type ToConsole } from './protocol.ts';

/**
 * The console: the page inside the arcade window's frame. It is given a core and a cartridge, shows the game on its
 * one canvas, and takes button presses as messages. It has no keyboard, no network and no storage of its own
 * (docs/ARCADE.md, "The frame"): what it should keep it hands back to the window that owns it.
 */

const CORE = 'genesis_plus_gx';

/** A Mega Drive pad's buttons as the core's "RetroPad" names them. */
const RETRO: Record<PadButton, string> = { up: 'up', down: 'down', left: 'left', right: 'right', a: 'y', b: 'b', c: 'a', x: 'l', y: 'x', z: 'r', start: 'start', mode: 'select' };
/**
 * RetroArch reads pads as keys. Nobody types here, so each player's buttons are given keys of their own that only
 * `pressDown` and `pressUp` ever send.
 */
const KEYS: Record<Player, string> = { 1: 'qwertyuiopas', 2: 'dfghjklzxcvb' };
const ORDER = ['up', 'down', 'left', 'right', 'a', 'b', 'x', 'y', 'l', 'r', 'start', 'select'];

function pads(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const player of [1, 2] as const) ORDER.forEach((name, i) => (out[`input_player${player}_${name}`] = KEYS[player][i]!));
  return out;
}

const say = (m: FromConsole, transfer: Transferable[] = []) => window.parent.postMessage(m, '*', transfer);
const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> => Promise.race([p.catch(() => undefined), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);

const canvas = document.getElementById('screen') as HTMLCanvasElement;
let machine: Nostalgist | null = null;
/** One thing at a time: keeping a state while another is being loaded would hand back half of each. */
let busy: Promise<unknown> = Promise.resolve();
const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
  const next = busy.then(work, work);
  busy = next.catch(() => undefined);
  return next;
};

/** The canvas in the screen's own dots: RetroArch draws for that, and watches the page for when it changes. */
const dots = () => {
  const scale = window.devicePixelRatio || 1;
  return { width: Math.max(64, Math.round(window.innerWidth * scale)), height: Math.max(64, Math.round(window.innerHeight * scale)) };
};
// RetroArch takes the keyboard for its canvas when it starts. This page has no keyboard to take: the keys stay with
// the window that owns the frame.
canvas.focus = () => undefined;
// What was drawn stays on the canvas until the next frame is: a picture of it can then be taken at any moment (to
// show the game to somebody else), not only in the instant between drawing and showing.
{
  const real = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string, attrs?: Record<string, unknown>) {
    return real.call(this, kind, /^webgl/.test(kind) ? { ...attrs, preserveDrawingBuffer: true } : attrs);
  } as typeof real;
}

/**
 * Every sound output the emulator opens, noted as it is made: whichever way this build of RetroArch plays sound, it
 * goes through one of these, and the page may hold each back until it has been clicked.
 */
const outputs: AudioContext[] = [];
{
  const Real = window.AudioContext;
  window.AudioContext = class extends Real {
    constructor(options?: AudioContextOptions) {
      super(options);
      outputs.push(this);
      this.addEventListener('statechange', () => tellSound());
    }
  };
}
const soundState = (): SoundState => (outputs.length === 0 ? 'none' : outputs.every((o) => o.state === 'running') ? 'on' : 'waiting');
let told: SoundState | null = null;
function tellSound(): void {
  const state = soundState();
  if (state === told) return;
  told = state;
  say({ t: 'sound', state });
}
/** A button press is a good moment to ask for held-back sound again. */
function sound(): void {
  for (const o of outputs) if (o.state === 'suspended') void o.resume().catch(() => undefined);
  tellSound();
}

/**
 * Where the emulator's sound goes on its way out. Whatever it connects to an output is connected to a point of ours
 * instead, and from there twice: to the loudspeaker through this window's own volume (sound off here is that volume
 * at nothing — the game itself is never muted), and to a listener that hands the sound over while the game is shown
 * to somebody else, who then hears it whether or not it is heard here.
 */
let muted = false;
let casting = false;
const volumes: GainNode[] = [];
const buses = new WeakMap<BaseAudioContext, AudioNode>();
{
  const connect = AudioNode.prototype.connect as (this: AudioNode, to: AudioNode | AudioParam, output?: number, input?: number) => AudioNode | void;
  const busOf = (ctx: BaseAudioContext): AudioNode => {
    let bus = buses.get(ctx);
    if (bus) return bus;
    bus = ctx.createGain();
    buses.set(ctx, bus);
    const volume = ctx.createGain();
    volume.gain.value = muted ? 0 : 1;
    volumes.push(volume);
    connect.call(bus, volume);
    connect.call(volume, ctx.destination);
    // The listener. It is connected on to the output, silenced: a node that leads nowhere is not run.
    const listen = ctx.createScriptProcessor(2048, 2, 2);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    listen.onaudioprocess = (e) => {
      if (!casting) return;
      const left = e.inputBuffer.getChannelData(0).slice();
      const right = (e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : left).slice();
      say({ t: 'pcm', rate: ctx.sampleRate, left: left.buffer, right: right.buffer }, [left.buffer, right.buffer]);
    };
    connect.call(bus, listen);
    connect.call(listen, silent);
    connect.call(silent, ctx.destination);
    return bus;
  };
  AudioNode.prototype.connect = function (this: AudioNode, to: AudioNode | AudioParam, output?: number, input?: number) {
    if (to instanceof AudioDestinationNode) return connect.call(this, busOf(to.context), output);
    return connect.call(this, to, output, input);
  } as typeof AudioNode.prototype.connect;
}
function setMuted(now: boolean): void {
  muted = now;
  for (const v of volumes) v.gain.value = now ? 0 : 1;
}

/**
 * The picture for others: the screen as it is, at a size of its own, about sixty times a second and never faster
 * than they are taken.
 */
let taking = false;
let lastTaken = 0;
function cast(): void {
  if (!casting) return;
  requestAnimationFrame(cast);
  const now = performance.now();
  if (taking || now - lastTaken < 15) return;
  taking = true;
  lastTaken = now;
  createImageBitmap(canvas, { resizeWidth: CAST_WIDTH, resizeHeight: CAST_HEIGHT, resizeQuality: 'pixelated' })
    .then((bitmap) => (casting ? say({ t: 'frame', bitmap, ts: Math.round(now * 1000) }, [bitmap]) : bitmap.close()))
    .catch(() => undefined)
    .finally(() => (taking = false));
}

async function boot(m: Extract<ToConsole, { t: 'boot' }>): Promise<void> {
  setMuted(!m.sound);
  const config: Record<string, string | number | boolean> = {
    ...pads(),
    // No key of RetroArch's own does anything: its shortcuts ask for a key held that is never sent.
    input_enable_hotkey: 'scroll_lock',
    input_menu_toggle: 'nul',
    // Nothing of RetroArch's own is written over the picture: the moment is kept every half minute, and "state
    // saved" each time would be in the way. The window says what was kept.
    video_font_enable: false,
    menu_enable_widgets: false,
    notification_show_save_state: false,
    notification_show_screenshot: false,
    video_smooth: false,
    savestate_thumbnail_enable: true,
  };
  machine = await Nostalgist.launch({
    element: canvas,
    core: { name: CORE, js: new Blob([m.core.js], { type: 'application/javascript' }), wasm: new Blob([m.core.wasm], { type: 'application/wasm' }) },
    rom: { fileName: m.rom.name, fileContent: new Blob([m.rom.bytes]) },
    ...(m.sram ? { sram: new Blob([m.sram]) } : {}),
    ...(m.state ? { state: new Blob([m.state]) } : {}),
    cache: false,
    size: dots(),
    // (The library's own list of settings does not know every name RetroArch reads.)
    retroarchConfig: config as never,
  });
  // RetroArch measures the canvas again on a resize; one is sent so that what it draws for and what the library set agree.
  window.dispatchEvent(new Event('resize'));
  say({ t: 'running' });
  sound();
  // (An output opened a moment after the first frame is told of too.)
  setTimeout(tellSound, 1500);
}

async function keep(id: number, withState: boolean): Promise<void> {
  if (!machine) return say({ t: 'kept', id });
  const out: Extract<FromConsole, { t: 'kept' }> = { t: 'kept', id };
  // A cartridge without a battery writes nothing, and that is not worth waiting long for.
  // (Where there is one it is written at once and read back within 150 ms.)
  const sram = await within(machine.saveSRAM(), 450);
  if (sram?.size) out.sram = await sram.arrayBuffer();
  if (withState) {
    const kept = await within(machine.saveState(), 5000);
    if (kept?.state) {
      out.state = await kept.state.arrayBuffer();
      if (kept.thumbnail) out.shot = await kept.thumbnail.arrayBuffer();
    }
  }
  say(out, [out.sram, out.state, out.shot].filter((b): b is ArrayBuffer => !!b));
}

window.addEventListener('message', (ev: MessageEvent<ToConsole>) => {
  if (ev.source !== window.parent || !ev.data || typeof ev.data !== 'object') return;
  const m = ev.data;
  if (m.t === 'boot') {
    if (machine) return;
    void inTurn(() => boot(m)).catch((e: unknown) => say({ t: 'failed', message: e instanceof Error ? e.message : String(e) }));
    return;
  }
  if (!machine) return;
  const on = machine;
  if (m.t === 'pad') {
    if (m.down) {
      on.pressDown({ button: RETRO[m.button], player: m.player });
      sound();
    } else on.pressUp({ button: RETRO[m.button], player: m.player });
  } else if (m.t === 'pause') on.pause();
  else if (m.t === 'resume') on.resume();
  else if (m.t === 'reset') on.restart();
  else if (m.t === 'sound') {
    setMuted(!m.on);
    if (m.on) sound();
  } else if (m.t === 'cast') {
    const was = casting;
    casting = m.on;
    if (m.on && !was) cast();
  } else if (m.t === 'keep') void inTurn(() => keep(m.id, m.state));
  else if (m.t === 'restore') void inTurn(() => on.loadState(new Blob([m.state])));
});
window.addEventListener('error', (ev) => !machine && say({ t: 'failed', message: ev.message }));

say({ t: 'hello' });
