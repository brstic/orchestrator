import { create } from 'zustand';
import type { OwnerSettings } from '@orchestrator/contracts';
import { useOffice } from './store.ts';

/**
 * What belongs to this person on this computer, not to the office: how the 3D office is drawn, which keys
 * do what, and the optional extras. Everyone may change their own, whatever their role in the office.
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
  overview: 'Tab',
  map: 'KeyM',
  tasks: 'KeyT',
  projects: 'KeyP',
  notifications: 'KeyN',
  command: 'KeyG',
  camera: 'KeyC',
  exit: 'Escape',
};

export const DEFAULT_PREFS: ClientPrefs = { quality: 'medium', keybindings: DEFAULT_KEYS, projectZones: false, approachZoom: false };

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
  };
}

async function read(): Promise<ClientPrefs | null> {
  try {
    const b = bridge();
    if (b) return clean(await b.get());
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
    if (b) void b.set(prefs).catch(() => undefined);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
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
  const prefs = clean({ quality: office.quality, keybindings: office.keybindings, projectZones: office.projectZones, approachZoom: office.approachZoom }) ?? DEFAULT_PREFS;
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

// For probes and the UI tests, like `window.__office`.
(window as any).__orchPrefs = usePrefs;
