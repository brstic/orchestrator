import type { RadioStation } from '@orchestrator/contracts';
import { api } from './api.ts';
import { useOffice } from './store.ts';

/**
 * The office hi-fi's player: one <audio> element playing an internet radio stream in the
 * owner's own window. Nothing here reaches the employees or the server, except the list of
 * stations and the volume, which are saved in the settings.
 */
let el: HTMLAudioElement | null = null;
let poll: number | null = null;

function element(): HTMLAudioElement {
  if (el) return el;
  el = new Audio();
  el.preload = 'none';
  el.addEventListener('playing', () => useOffice.setState((s) => ({ radio: { ...s.radio, status: 'playing', error: null } })));
  el.addEventListener('waiting', () => useOffice.setState((s) => (s.radio.stationId ? { radio: { ...s.radio, status: 'loading' } } : s)));
  el.addEventListener('error', () => {
    if (!useOffice.getState().radio.stationId) return;
    useOffice.setState((s) => ({ radio: { ...s.radio, status: 'error', error: 'The stream could not be played. Check that the address is a direct audio stream (for example one ending in .mp3 or .aac).' } }));
  });
  // A live stream does not end; if it does, the station dropped it.
  el.addEventListener('ended', () => {
    if (!useOffice.getState().radio.stationId) return;
    stopPolling();
    useOffice.setState((s) => ({ radio: { ...s.radio, status: 'error', error: 'The station stopped sending. Press play to tune in again.' } }));
  });
  return el;
}

/** What is on air, for stations that publish it. */
async function nowPlaying(station: RadioStation): Promise<void> {
  if (!station.nowPlayingUrl) return;
  try {
    // The office server asks the station: this page is only allowed to play audio from outside, not to call addresses.
    const { text } = await api<{ text: string | null }>('GET', `/radio/now?station=${encodeURIComponent(station.id)}`);
    if (useOffice.getState().radio.stationId === station.id) useOffice.setState((s) => ({ radio: { ...s.radio, nowPlaying: text } }));
  } catch {
    /* the station does not say */
  }
}

export function playStation(station: RadioStation): void {
  const a = element();
  stopPolling();
  a.volume = useOffice.getState().settings?.radio?.volume ?? 0.6;
  // A cache-buster makes a live stream start "now" instead of from a stale buffer.
  a.src = `${station.url}${station.url.includes('?') ? '&' : '?'}_=${Date.now()}`;
  useOffice.setState({ radio: { stationId: station.id, name: station.name, status: 'loading', error: null, nowPlaying: null } });
  a.play().catch((e) => {
    if (useOffice.getState().radio.stationId !== station.id) return;
    useOffice.setState((s) => ({ radio: { ...s.radio, status: 'error', error: (e as Error).message || 'Playback was blocked.' } }));
  });
  void nowPlaying(station);
  poll = window.setInterval(() => void nowPlaying(station), 20000);
}

function stopPolling(): void {
  if (poll !== null) window.clearInterval(poll);
  poll = null;
}

export function stopRadio(): void {
  stopPolling();
  if (el) {
    el.pause();
    el.removeAttribute('src');
    el.load();
  }
  useOffice.setState({ radio: { stationId: null, name: null, status: 'idle', error: null, nowPlaying: null } });
}

export function setRadioVolume(volume: number): void {
  if (el) el.volume = Math.min(1, Math.max(0, volume));
}
