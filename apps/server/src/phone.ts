/**
 * The office is a 3D room with live terminals: it is made for a computer with a keyboard, and on a phone it neither
 * fits nor can be steered. So a phone is told so at the door instead of being let into something that does not work.
 *
 * Recognised by what the browser says it is (its User-Agent). That is a courtesy, not a lock: a browser can claim
 * to be anything, and who may enter is still decided by invitations and tokens (`access.ts`).
 */

/** A phone's browser. Tablets and computers are not: Android tablets do not say "Mobile", iPads say they are Macs. */
export function isPhone(userAgent: unknown): boolean {
  const ua = typeof userAgent === 'string' ? userAgent : '';
  return /\bMobi|\biPhone\b|\biPod\b|Windows Phone|Opera Mini|IEMobile|BlackBerry/i.test(ua);
}

export const PHONE_MESSAGE = 'This office opens on a desktop computer only. Open the same link on a computer — in a browser, or in the Orchestrator app.';

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** What a phone is shown instead of the office (or of an invitation): it works on a computer; nothing was used up. */
export function phonePage(office: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(office)} — on a computer</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; background: #0d1118; color: #e8ecf3; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 26rem; padding: 2rem 1.5rem; text-align: center; }
  .mark { width: 56px; height: 56px; margin: 0 auto 1.25rem; border-radius: 14px; background: #1a2130; border: 1px solid rgba(255,255,255,.16); display: flex; align-items: center; justify-content: center; font-size: 28px; }
  h1 { font-size: 1.25rem; margin: 0 0 .75rem; }
  p { margin: 0 0 .75rem; color: #94a0b4; }
  strong { color: #e8ecf3; }
</style>
</head>
<body>
<main>
  <div class="mark" aria-hidden="true">🖥️</div>
  <h1>${esc(office)} opens on a computer</h1>
  <p>The office is a 3D room with live terminals. It needs a <strong>desktop or laptop computer</strong>; it cannot be entered from a phone.</p>
  <p>Open this same link on a computer — in a browser, or in the Orchestrator app. If it is an invitation, it has <strong>not</strong> been used up: it still works there.</p>
  <p>Talking to an AI employee ${esc(office)} rents you? <a href="/rent" style="color:#ffd166">The Rent portal</a> works on a phone.</p>
</main>
</body>
</html>
`;
}
