/**
 * Which of this computer's sound devices the office uses: where its sound comes out (the voices, the hi-fi, the
 * small effects — all on the one device this person chose, their headphones for instance), and what the Sound
 * settings offer to choose from.
 *
 * This module knows nothing of the preferences (they call `setOutputDevice`), so everything that makes sound can
 * import it.
 */

/** An `AudioContext` or an `<audio>` element: both can be told which device to play on, where the browser can do that at all. */
interface Sink {
  setSinkId?: (id: string) => Promise<void>;
}

const sinks = new Set<Sink>();
/** Those that were moved off the system's default once, and so have to be told when it is chosen again. */
const moved = new WeakSet<Sink>();
/** The chosen device; '' is whatever the system plays on. */
let output = '';

function apply(sink: Sink): void {
  if (typeof sink.setSinkId !== 'function') return; // this browser plays on the system's device only
  if (!output && !moved.has(sink)) return;
  moved.add(sink);
  // A device that is not there any more (unplugged headphones) is refused: the sound stays where it was.
  void sink.setSinkId(output).catch(() => undefined);
}

/** Everything that makes sound passes through here once, when it is made: it plays on the chosen device from then on. */
export function routeOutput<T extends object>(sink: T): T {
  sinks.add(sink as Sink);
  apply(sink as Sink);
  return sink;
}

/** The person chose where the office's sound comes out ('' for the system's own choice). */
export function setOutputDevice(id: string): void {
  if (id === output) return;
  output = id;
  for (const sink of sinks) apply(sink);
}

/** Can this browser play on a device other than the system's? (Chromium and the desktop app can.) */
export const canChooseOutput = (): boolean => typeof AudioContext !== 'undefined' && typeof (AudioContext.prototype as Sink).setSinkId === 'function';

export interface SoundChoice {
  id: string;
  label: string;
  /** The device that was chosen is not connected right now. */
  missing?: boolean;
}

/**
 * What to offer for one kind of device, from what the browser lists. The browser's own "default" entries are left
 * out (the settings have "System default" of their own); a device without a name — the browser gives names only
 * once the microphone was allowed — gets a number; a chosen device that is not in the list is kept, marked.
 */
export function soundChoices(devices: ReadonlyArray<{ kind: string; deviceId: string; label: string }>, kind: 'audioinput' | 'audiooutput', chosen = ''): { choices: SoundChoice[]; named: boolean } {
  const choices: SoundChoice[] = [];
  let named = false;
  for (const d of devices) {
    if (d.kind !== kind || !d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') continue;
    if (choices.some((c) => c.id === d.deviceId)) continue;
    if (d.label) named = true;
    choices.push({ id: d.deviceId, label: d.label || `${kind === 'audioinput' ? 'Microphone' : 'Output'} ${choices.length + 1}` });
  }
  if (chosen && !choices.some((c) => c.id === chosen)) choices.push({ id: chosen, label: 'The chosen device — not connected right now', missing: true });
  return { choices, named };
}
