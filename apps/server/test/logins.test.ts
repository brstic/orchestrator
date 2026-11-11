import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGIN_LIMITS, Logins, SESSION_DAYS } from '../src/logins.ts';

/** Just enough of an office for the sign-in to stand on: a key-value store, credentials, an audit list, notifications. */
function office() {
  let now = Date.parse('2026-11-11T10:00:00Z');
  const kv = new Map<string, unknown>();
  const creds = new Map<string, { kind: string; refId: string; label: string; revoked: boolean }>();
  const audits: Array<{ actor: string; action: string; target: string; detail: any }> = [];
  const notes: Array<{ kind: string; title: string; body: string }> = [];
  const members = [
    { id: 'm1', name: 'Vera', role: 'owner', createdAt: '', lastSeenAt: null, revokedAt: null as string | null },
    { id: 'm2', name: 'Jovan Jovanović', role: 'colleague', createdAt: '', lastSeenAt: null, revokedAt: null as string | null },
    { id: 'm3', name: 'Gone', role: 'colleague', createdAt: '', lastSeenAt: null, revokedAt: '2026-01-01T00:00:00Z' as string | null },
    { id: 'm4', name: 'Short stay', role: 'visitor', createdAt: '', lastSeenAt: null, revokedAt: null as string | null, expiresAt: '2026-11-11T09:00:00Z' },
  ];
  const store = {
    kvGet: <T>(k: string, d: T): T => (kv.has(k) ? (JSON.parse(JSON.stringify(kv.get(k))) as T) : d),
    kvSet: (k: string, v: unknown) => void kv.set(k, JSON.parse(JSON.stringify(v))),
    addCredential: (kind: string, token: string, o: { refId: string; label: string }) => void creds.set(token, { kind, refId: o.refId, label: o.label, revoked: false }),
    checkCredential: (kind: string, token: string | null) => {
      const c = token ? creds.get(token) : undefined;
      return c && c.kind === kind && !c.revoked ? c : null;
    },
    revokeCredential: (token: string) => void (creds.get(token)!.revoked = true),
    revokeCredentialsWhere: (kind: string, refId: string, prefix: string) => {
      for (const c of creds.values()) if (c.kind === kind && c.refId === refId && c.label.startsWith(prefix)) c.revoked = true;
    },
  };
  const engine = { core: { store, audit: (actor: string, action: string, target: string, detail: any) => void audits.push({ actor, action, target, detail }) }, comms: { notify: (n: any) => void notes.push(n) } };
  const guests = { get: (id: string) => members.find((m) => m.id === id), list: () => members };
  const make = () => new Logins(engine as any, guests as any, () => now);
  return { logins: make(), make, kv, creds, audits, notes, store, tick: (ms: number) => (now += ms) };
}
const fails = (fn: () => unknown, status: number, text?: RegExp) =>
  assert.rejects(async () => fn(), (e: any) => {
    assert.equal(e.status, status, e.message);
    if (text) assert.match(e.message, text);
    return true;
  });

test('a password is kept as a salted hash and lets its member in — under any spelling of the name, with their role', async () => {
  const o = office();
  o.logins.set('m1', 'correct horse battery', 'owner');
  o.logins.set('m2', 'correct horse battery', 'owner');
  const kept = JSON.stringify([...o.kv.values()]);
  assert.doesNotMatch(kept, /correct horse/);
  const stored = o.kv.get('logins') as Record<string, { salt: string; hash: string }>;
  assert.notEqual(stored.m1!.hash, stored.m2!.hash, 'the same password of two members is not the same hash');
  assert.equal(stored.m1!.hash.length, 128);
  const got = (await o.logins.signIn('  vErA ', 'correct horse battery', '1.1.1.1'));
  assert.deepEqual([got.guest.id, got.guest.role], ['m1', 'owner']);
  assert.match(got.token, /^orch_guest_/);
  assert.equal(Date.parse(got.expiresAt) - Date.parse('2026-11-11T10:00:00Z'), SESSION_DAYS * 86_400_000);
  assert.equal(o.store.checkCredential('guest', got.token)?.refId, 'm1');
  assert.equal((await o.logins.signIn('jovan jovanović', 'correct horse battery', '1.1.1.1')).guest.id, 'm2');
  // It is still there after the office starts again.
  assert.equal((await o.make().signIn('Vera', 'correct horse battery', '1.1.1.1')).guest.id, 'm1');
  assert.deepEqual([o.logins.has('m1'), o.logins.has('m3')], [true, false]);
});

test('what is refused as a password, and for whom', async () => {
  const o = office();
  await fails(() => o.logins.set('m1', 'short', 'owner'), 400, /at least 8/);
  await fails(() => o.logins.set('m1', 'x'.repeat(201), 'owner'), 400, /too long/);
  await fails(() => o.logins.set('m2', 'JOVAN jovanović', 'owner'), 400, /must not be the name/);
  await fails(() => o.logins.set('m1', 12345678, 'owner'), 400);
  await fails(() => o.logins.set('m3', 'a good password', 'owner'), 404);
  await fails(() => o.logins.set('nobody', 'a good password', 'owner'), 404);
  assert.equal(o.kv.has('logins'), false);
});

test('a wrong name, a wrong password, a member with no password, one who left and one whose time is up all get the same answer', async () => {
  const o = office();
  o.logins.set('m1', 'correct horse battery', 'owner');
  const said: string[] = [];
  const tries: Array<[unknown, unknown]> = [['Vera', 'wrong password'], ['Nobody', 'correct horse battery'], ['Jovan Jovanović', 'anything at all'], ['Gone', 'x'], ['Short stay', 'x'], ['', ''], [undefined, undefined], ['Vera', { $ne: '' }], ['Vera', 'x'.repeat(5000)]];
  for (const [i, [name, pw]] of tries.entries()) await fails(() => o.logins.signIn(name, pw, `9.9.9.${i}`), 401, /do not match a member/);
  for (const a of o.audits.filter((x) => x.action === 'login.failed')) said.push(JSON.stringify(a.detail));
  assert.equal(said.length, tries.length);
  assert.doesNotMatch(said.join(), /correct horse|wrong password|anything at all/, 'what was typed as a password is never written down');
  assert.equal(o.creds.size, 0, 'nothing was handed out');
});

test('five wrong passwords close the name — for the right password too — for a while that doubles; the owner is told', async () => {
  const o = office();
  o.logins.set('m1', 'correct horse battery', 'owner');
  for (let i = 0; i < LOGIN_LIMITS.nameTries; i++) await fails(() => o.logins.signIn('Vera', `guess ${i}`, `2.2.2.${i}`), 401);
  await fails(() => o.logins.signIn('Vera', 'correct horse battery', '3.3.3.3'), 429, /Try again in 15 minutes/);
  assert.equal(o.notes.length, 1);
  assert.match(o.notes[0]!.title, /Sign-in for Vera is closed/);
  assert.equal(o.notes[0]!.kind, 'security');
  assert.equal(o.audits.filter((a) => a.action === 'login.locked').length, 1);
  o.tick(LOGIN_LIMITS.nameLockMs - 1000);
  await fails(() => o.logins.signIn('Vera', 'correct horse battery', '3.3.3.3'), 429, /Try again in 1 minutes/);
  o.tick(2000);
  // Open again; one more run of wrong ones closes it for twice as long.
  for (let i = 0; i < LOGIN_LIMITS.nameTries; i++) await fails(() => o.logins.signIn('vera', `guess ${i}`, `4.4.4.${i}`), 401);
  await fails(() => o.logins.signIn('Vera', 'correct horse battery', '3.3.3.3'), 429, /Try again in 30 minutes/);
  o.tick(2 * LOGIN_LIMITS.nameLockMs + 1000);
  assert.equal((await o.logins.signIn('Vera', 'correct horse battery', '3.3.3.3')).guest.id, 'm1');
  // A good sign-in forgets the wrong ones before it: four more wrong ones do not close the name.
  for (let i = 0; i < LOGIN_LIMITS.nameTries - 1; i++) await fails(() => o.logins.signIn('Vera', `guess ${i}`, `5.5.5.${i}`), 401);
  assert.equal((await o.logins.signIn('Vera', 'correct horse battery', '3.3.3.3')).guest.id, 'm1');
  // A name nobody has is closed the same way (so that a closed name does not say "this one exists"), without a notification.
  for (let i = 0; i < LOGIN_LIMITS.nameTries; i++) await fails(() => o.logins.signIn('Nobody', 'whatever', `6.6.6.${i}`), 401);
  await fails(() => o.logins.signIn('Nobody', 'whatever', '6.6.6.9'), 429);
  assert.equal(o.notes.length, 2, 'one for each time Vera was closed, none for a name nobody has');
});

test('an address that keeps trying names is turned away, others are not', async () => {
  const o = office();
  o.logins.set('m1', 'correct horse battery', 'owner');
  for (let i = 0; i < LOGIN_LIMITS.ipTries; i++) await fails(() => o.logins.signIn(`name ${i}`, 'whatever', '7.7.7.7'), 401);
  await fails(() => o.logins.signIn('Vera', 'correct horse battery', '7.7.7.7'), 429, /Too many attempts from here/);
  assert.equal((await o.logins.signIn('Vera', 'correct horse battery', '8.8.8.8')).guest.id, 'm1');
  o.tick(LOGIN_LIMITS.ipWindowMs + 1000);
  assert.equal((await o.logins.signIn('Vera', 'correct horse battery', '7.7.7.7')).guest.id, 'm1');
});

test('a new password, or none, ends what was signed in with the old one — and only that', async () => {
  const o = office();
  o.store.addCredential('guest', 'the-app-token', { refId: 'm1', label: 'Vera' });
  o.logins.set('m1', 'correct horse battery', 'owner');
  const a = (await o.logins.signIn('Vera', 'correct horse battery', '1.1.1.1')).token;
  const b = (await o.logins.signIn('Vera', 'correct horse battery', '1.1.1.2')).token;
  // Signing out ends that session; the app's own credential is not a session and is not ended by it.
  assert.equal(o.logins.signOut(a), true);
  assert.equal(o.logins.signOut(a), false);
  assert.equal(o.logins.signOut('the-app-token'), false);
  assert.equal(o.logins.signOut(null), false);
  assert.deepEqual([o.store.checkCredential('guest', a), !!o.store.checkCredential('guest', b), !!o.store.checkCredential('guest', 'the-app-token')], [null, true, true]);
  o.logins.set('m1', 'another good password', 'member:Vera');
  assert.equal(o.store.checkCredential('guest', b), null);
  await fails(() => o.logins.signIn('Vera', 'correct horse battery', '1.1.1.1'), 401);
  const c = (await o.logins.signIn('Vera', 'another good password', '1.1.1.1')).token;
  o.logins.clear('m1', 'owner');
  assert.equal(o.store.checkCredential('guest', c), null);
  assert.ok(o.store.checkCredential('guest', 'the-app-token'), 'the app is still in');
  await fails(() => o.logins.signIn('Vera', 'another good password', '1.1.1.9'), 401);
  assert.deepEqual(o.audits.filter((x) => /password/.test(x.action)).map((x) => [x.actor, x.action]), [['owner', 'login.password_set'], ['member:Vera', 'login.password_set'], ['owner', 'login.password_removed']]);
});

test('checking a password alone hands nothing out', async () => {
  const o = office();
  o.logins.set('m1', 'correct horse battery', 'owner');
  assert.equal((await o.logins.check('Vera', 'correct horse battery', '1.1.1.1')).id, 'm1');
  await fails(() => o.logins.check('Vera', 'not it', '1.1.1.1'), 401);
  assert.equal(o.creds.size, 0);
});

test('a flood from many addresses is turned away as a whole, and checks are not computed without end', async () => {
  const o = office();
  o.logins.set('m1', 'correct horse battery', 'owner');
  // More at once than are computed side by side: the ones over the mark are told "later", at once.
  const burst = await Promise.allSettled(Array.from({ length: LOGIN_LIMITS.busy + 3 }, (_, i) => o.logins.signIn(`someone ${i}`, 'whatever', `11.0.0.${i}`)));
  assert.deepEqual(burst.map((r) => (r as PromiseRejectedResult).reason.status).sort(), [...Array(LOGIN_LIMITS.busy).fill(401), 429, 429, 429]);
  // Everybody's attempts within a minute have a ceiling too, whatever addresses and names they come with.
  for (let i = LOGIN_LIMITS.busy; i < LOGIN_LIMITS.allTries; i++) await fails(() => o.logins.signIn(`name ${i}`, 'whatever', `12.${i >> 8}.${i & 255}.1`), 401);
  await fails(() => o.logins.signIn('Vera', 'correct horse battery', '13.1.1.1'), 429, /Too many people are signing in/);
  o.tick(LOGIN_LIMITS.allWindowMs + 1000);
  assert.equal((await o.logins.signIn('Vera', 'correct horse battery', '13.1.1.1')).guest.id, 'm1');
});

test('a password changed while a check is being computed: the old one does not get in', async () => {
  const o = office();
  o.logins.set('m1', 'correct horse battery', 'owner');
  const pending = o.logins.signIn('Vera', 'correct horse battery', '1.1.1.1');
  o.logins.set('m1', 'another good password', 'owner');
  await fails(() => pending, 401);
  assert.equal(o.creds.size, 0);
});
