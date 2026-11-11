/**
 * Asking the desktop app (the part outside the page) to do something, without ever being left waiting.
 *
 * The page is the office's and is new after every deploy and reload; the app on this computer is as old as the
 * moment it was started. When the page asks for something the running app does not know yet, the question is
 * refused with an exception rather than answered — and a button that waited for the answer stayed on "…" for
 * ever, with no word of why. Every question to the app goes through here: a refusal comes back as `{ error }`,
 * in words that say what to do.
 */
export const RESTART_THE_APP = 'The Orchestrator app on this computer was started before this was added to it. Close the app, start it again, and try once more.';

export function explainNative(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e ?? '');
  // Electron's words for "the app has nobody who answers this".
  if (/No handler registered/i.test(text)) return RESTART_THE_APP;
  return text.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '') || 'The Orchestrator app did not answer.';
}

export async function nativeCall<T extends object>(call: () => Promise<T> | T): Promise<T | { error: string }> {
  try {
    const res = await call();
    return res ?? { error: 'The Orchestrator app did not answer.' };
  } catch (e) {
    return { error: explainNative(e) };
  }
}
