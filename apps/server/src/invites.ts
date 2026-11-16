/**
 * Invitation links: how a member's app gets its credential.
 *
 * An invitation is a short link — the office's address and a code, `https://office.example.com/join/K7QF-M2XP-9TRD`.
 * The code is not the credential. It can be exchanged once, at the office's door, for the member's
 * credential (which their app then keeps); after that, or after a week, it is worth nothing. So a link that
 * leaks later, from a chat history or a mailbox, opens nothing.
 *
 * Only the hash of a code is stored. Wrong codes are counted per address.
 */
import crypto from 'node:crypto';
import { EngineError } from '@orchestrator/orchestration';

export const INVITE_LIMITS = {
  /** How long a link can be used. */
  ttlMs: 7 * 24 * 60 * 60_000,
  /** Wrong codes from one address in ten minutes before it has to wait. */
  wrongPerIp: 10,
  windowMs: 10 * 60_000,
};

/** Letters and digits that are not mistaken for each other when read aloud or retyped (no 0/O, 1/I/L). */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 12;

interface Pending {
  hash: string;
  guestId: string;
  createdAt: string;
  expiresAt: string;
}

interface Kv {
  kvGet<T>(key: string, fallback: T): T;
  kvSet(key: string, value: unknown): void;
}

const KV = 'invites';
const hash = (code: string): string => crypto.createHash('sha256').update(code).digest('hex');

/** A code as typed or pasted ("k7qf m2xp-9trd") → the code itself. */
export const normalizeCode = (raw: unknown): string => String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * What a link carries after the code when the address is this computer's own (an address with a port): the
 * first ten bytes of the fingerprint of the door's certificate. No authority vouches for that certificate, so
 * the joining app accepts only the one the link names.
 */
export const pinOf = (fingerprint: string): string => fingerprint.replace(/:/g, '').toLowerCase().slice(0, 20);

export function inviteLink(address: string, code: string, fingerprint: string | null): string {
  // An address without a port is answered by something in front of the door (a reverse proxy with a certificate
  // for that name): the app checks it the way a browser does, and the link needs nothing more.
  const direct = /:\d{1,5}$/.test(address);
  return `${address}/join/${code}${direct && fingerprint ? `.${pinOf(fingerprint)}` : ''}`;
}

export class Invites {
  private store: Kv;
  private now: () => number;
  private pending: Pending[];
  private wrong = new Map<string, number[]>();
  private kv: string;

  /** `kv`: where these codes are kept — the members' (`invites`), or another set of them (the Rent portal's clients). */
  constructor(store: Kv, now: () => number = Date.now, kv = KV) {
    this.store = store;
    this.now = now;
    this.kv = kv;
    this.pending = store.kvGet<Pending[]>(kv, []);
  }

  private save(): void {
    this.store.kvSet(this.kv, this.pending);
  }

  private sweep(): void {
    const now = this.now();
    const live = this.pending.filter((p) => Date.parse(p.expiresAt) > now);
    if (live.length !== this.pending.length) {
      this.pending = live;
      this.save();
    }
  }

  /** A new code for this member; an earlier one of theirs stops working. */
  create(guestId: string): { code: string; expiresAt: string } {
    this.sweep();
    let raw = '';
    for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[crypto.randomInt(ALPHABET.length)];
    const now = this.now();
    const expiresAt = new Date(now + INVITE_LIMITS.ttlMs).toISOString();
    this.pending = [...this.pending.filter((p) => p.guestId !== guestId), { hash: hash(raw), guestId, createdAt: new Date(now).toISOString(), expiresAt }];
    this.save();
    return { code: raw.match(/.{4}/g)!.join('-'), expiresAt };
  }

  /** The member's link is withdrawn (they were removed, or given a new one). */
  drop(guestId: string): void {
    const rest = this.pending.filter((p) => p.guestId !== guestId);
    if (rest.length === this.pending.length) return;
    this.pending = rest;
    this.save();
  }

  /** Until when this member's link can still be used; null when they have none. */
  expiresAtOf(guestId: string): string | null {
    const p = this.pending.find((x) => x.guestId === guestId);
    return p && Date.parse(p.expiresAt) > this.now() ? p.expiresAt : null;
  }

  /** Whose this code is, without using it up (a page that says whom it was made for). A wrong one counts like one tried. */
  peek(raw: unknown, ip: string): string {
    return this.find(raw, ip).guestId;
  }

  /** Exchange a code for the member it was made for. It works once. */
  redeem(raw: unknown, ip: string): string {
    const found = this.find(raw, ip);
    this.pending = this.pending.filter((p) => p !== found);
    this.save();
    return found.guestId;
  }

  private find(raw: unknown, ip: string): Pending {
    const now = this.now();
    const tries = (this.wrong.get(ip) ?? []).filter((t) => now - t < INVITE_LIMITS.windowMs);
    if (tries.length >= INVITE_LIMITS.wrongPerIp) throw new EngineError('Too many invitation links that did not work were tried from here. Wait a few minutes.', 429);
    this.sweep();
    const code = normalizeCode(raw);
    const found = code.length === CODE_LENGTH ? this.pending.find((p) => p.hash === hash(code)) : undefined;
    if (!found) {
      tries.push(now);
      this.wrong.set(ip, tries);
      for (const [k, v] of this.wrong) if (k !== ip && v.every((t) => now - t >= INVITE_LIMITS.windowMs)) this.wrong.delete(k);
      throw new EngineError('This invitation link has been used already, or it is more than a week old. Ask for a new one.', 410);
    }
    return found;
  }
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** What a browser shows at an invitation link: the link is for the app, and here is what to do with it. Nothing is exchanged. */
export function invitePage(office: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Invitation to ${esc(office)}</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0d1117; color: #e6ebf2; font: 15px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; }
  main { width: min(520px, calc(100vw - 32px)); padding: 28px; box-sizing: border-box; border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; background: rgba(255,255,255,0.04); }
  h1 { margin: 0 0 6px; font-size: 20px; }
  p { margin: 0 0 14px; color: #aab4c3; }
  ol { margin: 0 0 16px; padding-left: 20px; }
  li { margin: 4px 0; }
  .link { display: flex; gap: 8px; }
  input { flex: 1; min-width: 0; padding: 9px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.18); background: #0a0d12; color: inherit; font: 13px ui-monospace, Menlo, monospace; }
  button { padding: 9px 14px; border-radius: 8px; border: 0; background: #3b82f6; color: white; font: inherit; font-weight: 600; cursor: pointer; }
  small { display: block; margin-top: 12px; color: #7f8a9b; }
</style>
</head>
<body>
<main>
  <h1>You are invited to ${esc(office)}</h1>
  <p>This link is for the Orchestrator app. It works once.</p>
  <ol>
    <li>Open <b>Orchestrator</b> on your computer.</li>
    <li>Under <b>Connect to an office</b>, paste this link and press <b>Connect</b>.</li>
  </ol>
  <div class="link"><input id="link" readonly aria-label="Your invitation link"><button id="copy" type="button">Copy link</button></div>
  <small>Opening this page did not use the link up.</small>
</main>
<script>
  var input = document.getElementById('link'), button = document.getElementById('copy');
  input.value = location.origin + location.pathname;
  input.addEventListener('focus', function () { input.select(); });
  button.addEventListener('click', function () {
    var done = function () { button.textContent = 'Copied'; setTimeout(function () { button.textContent = 'Copy link'; }, 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(input.value).then(done, function () { input.select(); });
    else { input.select(); try { document.execCommand('copy'); done(); } catch (e) {} }
  });
</script>
</body>
</html>
`;
}
