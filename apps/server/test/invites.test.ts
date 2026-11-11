import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INVITE_LIMITS, Invites, inviteLink, invitePage, normalizeCode, pinOf } from '../src/invites.ts';

const kv = () => {
  const data = new Map<string, unknown>();
  return { kvGet: <T>(k: string, fallback: T): T => (data.has(k) ? (JSON.parse(JSON.stringify(data.get(k))) as T) : fallback), kvSet: (k: string, v: unknown) => void data.set(k, v), data };
};
const status = (fn: () => unknown): number => {
  try {
    fn();
    return 200;
  } catch (e) {
    return (e as { status: number }).status;
  }
};

test('a code is short, unambiguous, works once, and only its hash is kept', () => {
  const store = kv();
  const invites = new Invites(store);
  const { code, expiresAt } = invites.create('guest-1');
  assert.match(code, /^[2-9A-HJ-KM-NP-Z]{4}-[2-9A-HJ-KM-NP-Z]{4}-[2-9A-HJ-KM-NP-Z]{4}$/, 'twelve characters, none of 0 O 1 I L');
  assert.ok(Math.abs(Date.parse(expiresAt) - Date.now() - INVITE_LIMITS.ttlMs) < 5000);
  assert.ok(!JSON.stringify([...store.data.values()]).includes(normalizeCode(code)), 'the code itself is not stored');
  assert.equal(invites.expiresAtOf('guest-1'), expiresAt);
  // As retyped by a person: lower case, spaces instead of dashes.
  assert.equal(invites.redeem(code.toLowerCase().replace(/-/g, ' '), '1.1.1.1'), 'guest-1');
  assert.equal(invites.expiresAtOf('guest-1'), null);
  assert.equal(status(() => invites.redeem(code, '1.1.1.1')), 410, 'a second time it is worth nothing');
});

test('a new code for the same member replaces the old one; a withdrawn one is gone; codes survive a restart', () => {
  const store = kv();
  const invites = new Invites(store);
  const first = invites.create('g').code;
  const second = invites.create('g').code;
  const other = invites.create('h').code;
  assert.equal(status(() => invites.redeem(first, 'a')), 410);
  invites.drop('h');
  assert.equal(status(() => invites.redeem(other, 'a')), 410);
  assert.equal(new Invites(store).redeem(second, 'a'), 'g', 'read back from the store by a new office process');
});

test('a code is good for a week', () => {
  let now = Date.parse('2026-11-11T10:00:00Z');
  const invites = new Invites(kv(), () => now);
  const early = invites.create('g').code;
  now += INVITE_LIMITS.ttlMs - 60_000;
  assert.equal(invites.redeem(early, 'a'), 'g');
  const late = invites.create('g').code;
  now += INVITE_LIMITS.ttlMs + 1000;
  assert.equal(invites.expiresAtOf('g'), null);
  assert.equal(status(() => invites.redeem(late, 'a')), 410);
});

test('wrong codes are counted per address, and that address then waits', () => {
  let now = 1_000_000;
  const invites = new Invites(kv(), () => now);
  const code = invites.create('g').code;
  for (let i = 0; i < INVITE_LIMITS.wrongPerIp; i++) assert.equal(status(() => invites.redeem('AAAA-BBBB-CCCC', '9.9.9.9')), 410);
  assert.equal(status(() => invites.redeem(code, '9.9.9.9')), 429, 'even the right code is not looked at');
  assert.equal(status(() => invites.redeem('nonsense', '8.8.8.8')), 410, 'someone else is not held up');
  now += INVITE_LIMITS.windowMs + 1000;
  assert.equal(invites.redeem(code, '9.9.9.9'), 'g', 'the code was not used up by being refused');
});

test('a link names the certificate only where no authority vouches for it; the page for browsers shows the office safely', () => {
  const fp = 'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89';
  assert.equal(pinOf(fp), 'abcdef0123456789abcd');
  assert.equal(inviteLink('https://office.example.com', 'K7QF-M2XP-9TRD', fp), 'https://office.example.com/join/K7QF-M2XP-9TRD');
  assert.equal(inviteLink('https://192.168.0.5:4610', 'K7QF-M2XP-9TRD', fp), 'https://192.168.0.5:4610/join/K7QF-M2XP-9TRD.abcdef0123456789abcd');
  const page = invitePage('Acme <script>alert(1)</script> & Co');
  assert.ok(!page.includes('<script>alert(1)'), 'the office name is escaped');
  assert.match(page, /You are invited to Acme &#60;script&#62;/);
});
