import type { RadioStation } from '@orchestrator/contracts';
import { hifiLoudnessAt, ownerPosition } from '@orchestrator/office-3d';
import { api } from './api.ts';
import { setPrefs, usePrefs } from './prefs.ts';
import { routeOutput } from './sound-devices.ts';
import { useOffice } from './store.ts';

/**
 * This window's copy of the office hi-fi. What is on belongs to the office (`hifi` in the store, told by the
 * server to everyone); every window plays that stream itself with one <audio> element — the office relays no
 * sound. How loud it is here = this person's own volume × how far their character stands from the hi-fi.
 * Their volume and their mute are this computer's (the preferences), never the office's.
 *
 * The listener is the person's character (`ownerPosition`), in every camera mode: in the overview, the free
 * camera, the command center and at someone's terminal the character stays where it was left, and that is
 * where the music is heard from.
 */
let el: HTMLAudioElement | null = null;
/** What the element is playing or trying to play: `<station id>|<address>`; null when it is silent. */
let loaded: string | null = null;
/** The element's volume right now; it follows the wanted loudness in small steps (see `ramp`). */
let gain = 0;
let rampTimer: number | null = null;
let poll: { stationId: string; timer: number } | null = null;
let retry: number | null = null;

const keyOf = (s: RadioStation) => `${s.id}|${s.url}`;
const patch = (p: Partial<ReturnType<typeof useOffice.getState>['radio']>) => useOffice.setState((s) => ({ radio: { ...s.radio, ...p } }));

/** How loud the hi-fi should be in this window right now, 0–1. */
function wanted(): number {
  return usePrefs.getState().prefs.radioVolume * hifiLoudnessAt(ownerPosition.x, ownerPosition.z);
}

/**
 * The volume follows the listener: twenty small steps a second, each a fifth of the way to where it should be
 * (about a quarter of a second to catch up), so walking away or moving the slider is never heard as steps.
 */
function ramp(): void {
  if (!el || !loaded) return;
  const target = wanted();
  const next = Math.abs(target - gain) < 0.002 ? target : gain + (target - gain) * 0.2;
  if (next === gain) return;
  gain = next;
  el.volume = Math.min(1, Math.max(0, gain));
}

function element(): HTMLAudioElement {
  if (el) return el;
  el = routeOutput(new Audio());
  el.preload = 'none';
  el.addEventListener('playing', () => loaded && patch({ status: 'playing', error: null }));
  el.addEventListener('waiting', () => loaded && useOffice.getState().radio.status === 'playing' && patch({ status: 'loading' }));
  el.addEventListener('error', () => loaded && failed('This computer could not play the stream. Its address has to be a direct audio stream (for example one ending in .mp3 or .aac).'));
  // A live stream does not end; if it does, the station dropped it.
  el.addEventListener('ended', () => loaded && failed('The station stopped sending.'));
  return el;
}

/** The stream broke here while the office's hi-fi is still on: say so in the Hi-fi window and tune in again by itself. */
function failed(error: string): void {
  if (useOffice.getState().radio.status === 'blocked') return;
  patch({ status: 'error', error });
  if (retry !== null) window.clearTimeout(retry);
  retry = window.setTimeout(() => {
    retry = null;
    if (useOffice.getState().radio.status === 'error') retune();
  }, 15_000);
}

function silence(): void {
  if (retry !== null) window.clearTimeout(retry);
  retry = null;
  if (rampTimer !== null) window.clearInterval(rampTimer);
  rampTimer = null;
  if (!loaded) return;
  loaded = null;
  if (el) {
    el.pause();
    el.removeAttribute('src');
    el.load();
  }
}

function tune(station: RadioStation): void {
  const a = element();
  const key = keyOf(station);
  if (retry !== null) window.clearTimeout(retry);
  retry = null;
  loaded = key;
  gain = wanted();
  a.volume = Math.min(1, Math.max(0, gain));
  // A cache-buster makes a live stream start "now" instead of from a stale buffer.
  a.src = `${station.url}${station.url.includes('?') ? '&' : '?'}_=${Date.now()}`;
  patch({ status: 'loading', error: null });
  if (rampTimer === null) rampTimer = window.setInterval(ramp, 50);
  a.play().catch((e: unknown) => {
    if (loaded !== key) return;
    const name = (e as { name?: string })?.name;
    // The browser does not let sound start before the person has clicked in the page: not an error, a notice to click.
    if (name === 'NotAllowedError') patch({ status: 'blocked', error: null });
    else if (name !== 'AbortError') failed('This computer could not play the stream.');
  });
}

/** What is on air, for stations that publish it. */
async function nowPlaying(station: RadioStation): Promise<void> {
  try {
    // The office server asks the station: this page is only allowed to play audio from outside, not to call addresses.
    const { text } = await api<{ text: string | null }>('GET', `/radio/now?station=${encodeURIComponent(station.id)}`);
    if (useOffice.getState().hifi?.station.id === station.id) patch({ nowPlaying: text });
  } catch {
    /* the station does not say */
  }
}

function follow(station: RadioStation | null): void {
  if (poll && poll.stationId === station?.id) return;
  if (poll) window.clearInterval(poll.timer);
  poll = null;
  if (!station?.nowPlayingUrl) return;
  void nowPlaying(station);
  poll = { stationId: station.id, timer: window.setInterval(() => void nowPlaying(station), 20_000) };
}

/** Bring this window in line with the office's hi-fi and this person's mute. */
function sync(): void {
  if (!usePrefs.getState().ready) return; // whether this computer is muted is not known yet
  const station = useOffice.getState().hifi?.station ?? null;
  const now = useOffice.getState().radio;
  follow(station);
  if (!station) {
    silence();
    if (now.stationId || now.status !== 'idle') useOffice.setState({ radio: { stationId: null, name: null, status: 'idle', error: null, nowPlaying: null } });
    return;
  }
  if (now.stationId !== station.id || now.name !== station.name) patch({ stationId: station.id, name: station.name, ...(now.stationId !== station.id ? { nowPlaying: null } : {}) });
  if (usePrefs.getState().prefs.radioMuted) {
    silence();
    patch({ status: 'idle', error: null });
    return;
  }
  if (loaded !== keyOf(station)) tune(station);
}

let started = false;
/** Start following the office's hi-fi in this window (once). */
export function startRadio(): void {
  if (started) return;
  started = true;
  useOffice.subscribe((s, prev) => {
    if (s.hifi !== prev.hifi) sync();
  });
  usePrefs.subscribe((p, prev) => {
    if (p.ready !== prev.ready || p.prefs.radioMuted !== prev.prefs.radioMuted) sync();
  });
  sync();
}

/** Tune in again from this window: after the browser asked for a click (call it from that click), or after the stream broke. */
export function retune(): void {
  const station = useOffice.getState().hifi?.station;
  if (station && usePrefs.getState().ready && !usePrefs.getState().prefs.radioMuted) tune(station);
}

/** Switch a station on for the whole office (owners and colleagues; the office refuses a visitor). */
export function playStation(station: RadioStation): Promise<unknown> {
  // Switching it on is also wanting to hear it.
  if (usePrefs.getState().prefs.radioMuted) setPrefs({ radioMuted: false });
  return api('POST', '/radio/play', { stationId: station.id, url: station.url });
}

/** Switch the office's hi-fi off, for everyone. */
export function stopHiFi(): Promise<unknown> {
  return api('POST', '/radio/stop', {});
}

/** Switch this computer's own copy off or back on; the office's hi-fi plays on for the others. */
export function setRadioMuted(muted: boolean): void {
  setPrefs({ radioMuted: muted });
}

// For probes and the UI tests, like `window.__office`: what this window's copy is doing.
(window as any).__orchRadio = () => ({ loaded, volume: el && loaded ? el.volume : 0, wanted: wanted(), loudness: hifiLoudnessAt(ownerPosition.x, ownerPosition.z), paused: el ? el.paused : true });
