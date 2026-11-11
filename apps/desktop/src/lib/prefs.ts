import { create } from 'zustand';
import type { OwnerSettings } from '@orchestrator/contracts';
import { useOffice } from './store.ts';
import { setOutputDevice } from './sound-devices.ts';
import { applyVoiceSettings, voiceHooks } from './voice.ts';
import { GATE_DEFAULT, cleanGate } from './voice-gate.ts';

/**
 * What belongs to this person on this computer, not to the office: how the 3D office is drawn, which keys
 * do what, the optional extras, and how loud they hear the office hi-fi. Everyone may change their own, whatever their role in the office.
 *
 * In the desktop app they live in a file next to the app's other data, so they are the same in every office
 * this computer connects to. In a plain browser tab they live in that page's localStorage.
 */
export interface ClientPrefs {
  quality: 'low' | 'medium' | 'high';
  keybindings: Record<string, string>;
  /** Mark each project's desks on the floor. */
  projectZones: boolean;
  /** Move the camera in closer at an employee's desk. */
  approachZoom: boolean;
  /** How loud this person hears the office hi-fi, 0–1 (the distance to the hi-fi is counted on top of it). */
  radioVolume: number;
  /** This person has switched their own copy of the hi-fi off; the office's hi-fi plays on for the others. */
  radioMuted: boolean;
  /** How loud this person hears other people talking, 0–1 (how near they stand is counted on top of it). */
  voiceVolume: number;
  /** This person does not want to hear the others talk; they are still heard by the others when they hold the talk key. */
  voiceMuted: boolean;
  /** How this person talks: 'hold' the talk key (push to talk), or the microphone is always 'open'. */
  voiceMode: 'hold' | 'open';
  /** With the microphone always open: how loud a sound has to be to be sent (root mean square, 0…1). */
  micGate: number;
  /** The microphone to talk into; '' for the system's own choice. (A device's id belongs to this computer and this page.) */
  micDevice: string;
  /** Where the office's sound comes out — voices, hi-fi, effects; '' for the system's own choice. */
  outputDevice: string;
}

export const DEFAULT_KEYS: Record<string, string> = {
  forward: 'KeyW',
  back: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  strafeLeft: 'KeyQ',
  strafeRight: 'KeyE',
  interact: 'Space',
  talk: 'KeyF',
  whip: 'KeyR',
  voice: 'KeyV',
  emotes: 'KeyB',
  overview: 'Tab',
  map: 'KeyM',
  tasks: 'KeyT',
  projects: 'KeyP',
  notifications: 'KeyN',
  command: 'KeyG',
  camera: 'KeyC',
  exit: 'Escape',
};

export const DEFAULT_PREFS: ClientPrefs = { quality: 'medium', keybindings: DEFAULT_KEYS, projectZones: false, approachZoom: false, radioVolume: 0.6, radioMuted: false, voiceVolume: 1, voiceMuted: false, voiceMode: 'hold', micGate: GATE_DEFAULT, micDevice: '', outputDevice: '' };

export type PrefsPatch = Partial<ClientPrefs>;

interface Bridge {
  get: () => Promise<unknown>;
  set: (prefs: ClientPrefs) => Promise<boolean>;
}
/** Present only in the desktop app. */
const bridge = (): Bridge | null => (window as unknown as { orchestrator?: { prefs?: Bridge } }).orchestrator?.prefs ?? null;

const STORAGE_KEY = 'orch.prefs';

/** Whatever was stored (by an older version, or edited by hand) becomes a complete, valid set; null when it is not one at all. */
function clean(raw: unknown, base: ClientPrefs = DEFAULT_PREFS): ClientPrefs | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const keys: Record<string, string> = { ...DEFAULT_KEYS };
  if (r.keybindings && typeof r.keybindings === 'object') {
    for (const [id, code] of Object.entries(r.keybindings as Record<string, unknown>)) if (typeof code === 'string' && code && id.length <= 40 && code.length <= 40) keys[id] = code;
  }
  return {
    quality: r.quality === 'low' || r.quality === 'medium' || r.quality === 'high' ? r.quality : base.quality,
    keybindings: keys,
    projectZones: typeof r.projectZones === 'boolean' ? r.projectZones : base.projectZones,
    approachZoom: typeof r.approachZoom === 'boolean' ? r.approachZoom : base.approachZoom,
    radioVolume: typeof r.radioVolume === 'number' && Number.isFinite(r.radioVolume) ? Math.min(1, Math.max(0, r.radioVolume)) : base.radioVolume,
    radioMuted: typeof r.radioMuted === 'boolean' ? r.radioMuted : base.radioMuted,
    voiceVolume: typeof r.voiceVolume === 'number' && Number.isFinite(r.voiceVolume) ? Math.min(1, Math.max(0, r.voiceVolume)) : base.voiceVolume,
    voiceMuted: typeof r.voiceMuted === 'boolean' ? r.voiceMuted : base.voiceMuted,
    voiceMode: r.voiceMode === 'hold' || r.voiceMode === 'open' ? r.voiceMode : base.voiceMode,
    micGate: cleanGate(r.micGate, base.micGate),
    micDevice: typeof r.micDevice === 'string' && r.micDevice.length <= 256 ? r.micDevice : base.micDevice,
    outputDevice: typeof r.outputDevice === 'string' && r.outputDevice.length <= 256 ? r.outputDevice : base.outputDevice,
  };
}

/**
 * A desktop app installed before the hi-fi played for the whole office keeps only the fields it knows in its file.
 * So that "my volume" and "mute" still hold there after a restart, they are also kept in this page's own storage —
 * and so is everything about sound that came later (voices, the way of talking, the devices).
 */
const SOUND_FIELDS = ['radioVolume', 'radioMuted', 'voiceVolume', 'voiceMuted', 'voiceMode', 'micGate', 'micDevice', 'outputDevice'] as const;
const soundOf = (from: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(SOUND_FIELDS.filter((f) => from[f] !== undefined).map((f) => [f, from[f]]));
const RADIO_KEY = 'orch.prefs.radio';
function radioFallback(): Record<string, unknown> {
  try {
    const kept = JSON.parse(window.localStorage.getItem(RADIO_KEY) ?? 'null');
    return kept && typeof kept === 'object' ? soundOf(kept) : {};
  } catch {
    return {};
  }
}

async function read(): Promise<ClientPrefs | null> {
  try {
    const b = bridge();
    if (b) {
      const stored = await b.get();
      return stored && typeof stored === 'object' ? clean({ ...radioFallback(), ...(stored as Record<string, unknown>) }) : null;
    }
    const text = window.localStorage.getItem(STORAGE_KEY);
    return text ? clean(JSON.parse(text)) : null;
  } catch {
    // Unreadable is the same as never stored: the office's values are taken again.
    return null;
  }
}

function write(prefs: ClientPrefs): void {
  try {
    const b = bridge();
    if (b) {
      void b.set(prefs).catch(() => undefined);
      window.localStorage.setItem(RADIO_KEY, JSON.stringify(soundOf(prefs as unknown as Record<string, unknown>)));
    } else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* storage is not available (a private window): the choice still holds until the page is closed */
  }
}

interface PrefsState {
  prefs: ClientPrefs;
  /** False until the stored preferences were read (or, on a first run, taken from the office). The office is not drawn before that. */
  ready: boolean;
}

export const usePrefs = create<PrefsState>(() => ({ prefs: DEFAULT_PREFS, ready: false }));

/** Change this computer's preferences. Key bindings are merged, so one action can be rebound on its own. */
export function setPrefs(patch: PrefsPatch): void {
  const now = usePrefs.getState().prefs;
  const next: ClientPrefs = { ...now, ...patch, keybindings: patch.keybindings ? { ...now.keybindings, ...patch.keybindings } : now.keybindings };
  usePrefs.setState({ prefs: next });
  write(next);
}

/** First run on this computer: start from what the office has in its settings, and keep that here from now on. */
function adopt(office: OwnerSettings): void {
  const prefs = clean({ quality: office.quality, keybindings: office.keybindings, projectZones: office.projectZones, approachZoom: office.approachZoom, radioVolume: office.radio?.volume }) ?? DEFAULT_PREFS;
  usePrefs.setState({ prefs, ready: true });
  write(prefs);
}

let started = false;
/** Read the stored preferences once; when there are none, wait for the office's settings and take those. */
export function loadPrefs(): void {
  if (started) return;
  started = true;
  void read().then((stored) => {
    if (stored) {
      usePrefs.setState({ prefs: stored, ready: true });
      return;
    }
    const office = useOffice.getState().settings;
    if (office) {
      adopt(office);
      return;
    }
    const stop = useOffice.subscribe((s) => {
      if (!s.settings || usePrefs.getState().ready) return;
      stop();
      adopt(s.settings);
    });
  });
}

// How loud other people's voices are played here: this computer's own choice.
voiceHooks.volume = () => {
  const p = usePrefs.getState().prefs;
  return p.voiceMuted ? 0 : p.voiceVolume;
};

// How this person talks and through what: the preferences say, `voice.ts` and everything that makes sound follow.
voiceHooks.settings = () => {
  const p = usePrefs.getState().prefs;
  return { mode: p.voiceMode, input: p.micDevice, gate: p.micGate };
};
usePrefs.subscribe((s) => {
  // Not before the stored preferences were read: an open microphone is only ever this person's own choice.
  if (!s.ready) return;
  setOutputDevice(s.prefs.outputDevice);
  applyVoiceSettings();
});

// For probes and the UI tests, like `window.__office`.
(window as any).__orchPrefs = usePrefs;
