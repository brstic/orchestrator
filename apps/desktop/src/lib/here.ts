/**
 * Whether the person is in the office now — this window in front of them and used — told to the office, which then
 * keeps what employees send them off their Telegram (the owner, 2026-11-23: "when I am present in the office, the
 * agents must not send me messages on Telegram"; `docs/TELEGRAM.md`, "While you are in the office"). The app stays
 * open all day, so open is not enough: the window must be visible, in front, and touched in the last minutes.
 */
export const HERE_IDLE_MS = 10 * 60_000;
/** While here, said again this often (the office counts a window as here for a little longer than that). */
export const HERE_EVERY_MS = 60_000;

export function isHere(s: { visible: boolean; focused: boolean; lastInput: number; now: number }): boolean {
  return s.visible && s.focused && s.now - s.lastInput < HERE_IDLE_MS;
}

/** Watch the window and tell the office (`send`) when the person comes and goes, and every minute while here. */
export function startHere(send: (msg: { t: 'here'; active: boolean }) => void, isOnline: () => boolean): () => void {
  let lastInput = Date.now();
  let told: boolean | null = null;
  let toldAt = 0;
  const check = () => {
    if (!isOnline()) {
      told = null;
      return;
    }
    const now = Date.now();
    const here = isHere({ visible: document.visibilityState === 'visible', focused: document.hasFocus(), lastInput, now });
    if (here !== told || (here && now - toldAt >= HERE_EVERY_MS)) {
      send({ t: 'here', active: here });
      told = here;
      toldAt = now;
    }
  };
  const touched = () => {
    const was = Date.now() - lastInput >= HERE_IDLE_MS;
    lastInput = Date.now();
    if (was || told !== true) check();
  };
  const opts = { capture: true, passive: true } as const;
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'pointermove'] as const) window.addEventListener(ev, touched, opts);
  window.addEventListener('focus', check);
  window.addEventListener('blur', check);
  document.addEventListener('visibilitychange', check);
  const timer = window.setInterval(check, 15_000);
  check();
  return () => {
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'pointermove'] as const) window.removeEventListener(ev, touched, opts);
    window.removeEventListener('focus', check);
    window.removeEventListener('blur', check);
    document.removeEventListener('visibilitychange', check);
    window.clearInterval(timer);
  };
}
