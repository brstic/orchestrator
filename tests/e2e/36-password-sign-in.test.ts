/**
 * Signing in with a name and a password at the office's address — a member's second way in, beside their invitation.
 * A real office with its door open: what the session is (that member, their role), what is refused and how it is
 * said, what ends a session, who may give whom a password, and that none of it lets the office's own token in from outside.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

// The door's certificate is made on this machine (a real office is behind a name with a trusted certificate).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.removeAllListeners('warning');

const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const GOOD = 'a long enough password';

let h: Harness;
let doorUrl = '';
const ids: Record<string, string> = {};
const invited: Record<string, string> = {};
let from = 0;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const decode = (code: string) => JSON.parse(Buffer.from(code.replace(/^orch-invite-v1\./, ''), 'base64url').toString('utf8'));
const at = async (base: string, method: string, p: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}), ...opts.headers },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as any, cache: r.headers.get('cache-control') };
};
const door = (method: string, p: string, opts: Parameters<typeof at>[3] = {}) => at(doorUrl, method, p, opts);
/** A sign-in at the door, each from an address of its own unless one is given (the door is told it by what stands before it). */
const signIn = (username: unknown, password: unknown, ip = `10.1.${Math.floor(++from / 250)}.${from % 250}`) => door('POST', '/login', { body: { username, password }, headers: { 'x-forwarded-for': ip } });

before(async () => {
  h = await createHarness();
  const port = await freePort();
  await h.api('POST', '/sharing', { open: true, port });
  doorUrl = `https://127.0.0.1:${port}`;
  for (const [name, role] of [['Mila', 'visitor'], ['Jovan', 'colleague'], ['Vera', 'owner'], ['Branko', 'owner']] as const) {
    const made = await h.api<any>('POST', '/guests', { name, role });
    ids[name] = made.guest.id;
    invited[name] = decode(made.invite).t;
  }
});
after(async () => {
  await h.cleanup();
});

test('an owner gives a member a password; the member signs in at the door and is that member, with their role', async () => {
  assert.deepEqual(await h.api('POST', `/guests/${ids.Branko}/password`, { password: GOOD }), { ok: true, hasPassword: true });
  const listed = (await h.api<any>('GET', '/sharing')).guests as Array<{ name: string; hasPassword: boolean }>;
  assert.deepEqual(listed.map((g) => [g.name, g.hasPassword]), [['Mila', false], ['Jovan', false], ['Vera', false], ['Branko', true]]);
  assert.doesNotMatch(JSON.stringify(await h.api('GET', '/sharing')), new RegExp(GOOD), 'the password is never sent back');

  const got = await signIn('branko', GOOD);
  assert.equal(got.status, 200);
  assert.equal(got.cache, 'no-store');
  assert.deepEqual([got.body.name, got.body.role, got.body.days, typeof got.body.office], ['Branko', 'owner', 30, 'string']);
  assert.match(got.body.token, /^orch_guest_/);
  assert.notEqual(got.body.token, h.token, 'it is a session of the member, not the office\'s own token');
  const me = await door('GET', '/api/me', { token: got.body.token });
  assert.deepEqual([me.status, me.body.kind, me.body.role, me.body.name, me.body.id], [200, 'owner', 'owner', 'Branko', ids.Branko]);
  // The office tells a session what it is: made with a password, or the credential a member's app keeps.
  assert.deepEqual([me.body.hasPassword, me.body.passwordSession], [true, true]);
  const app = (await door('GET', '/api/me', { token: invited.Branko })).body;
  assert.deepEqual([app.hasPassword, app.passwordSession], [true, false]);
  const local = await h.api<any>('GET', '/me');
  assert.deepEqual([local.id, local.hasPassword, local.passwordSession], ['owner', false, false]);
  // What an owner may do, this session may do: the list of members is for owners only.
  assert.equal((await door('GET', '/api/sharing', { token: got.body.token })).status, 200);
  assert.equal((await door('GET', '/api/state', { token: got.body.token })).status, 200);

  // A colleague with a password is a colleague.
  await h.api('POST', `/guests/${ids.Jovan}/password`, { password: 'jovan has his own one' });
  const jovan = await signIn('Jovan', 'jovan has his own one');
  assert.deepEqual([jovan.status, jovan.body.role], [200, 'colleague']);
  assert.equal((await door('GET', '/api/me', { token: jovan.body.token })).body.kind, 'guest');
  assert.equal((await door('GET', '/api/sharing', { token: jovan.body.token })).status, 403);
});

test('nothing but the right name with its password gets in, and every refusal reads the same', async () => {
  const refusals = await Promise.all([signIn('Branko', 'not the password'), signIn('Nobody', GOOD), signIn('Vera', GOOD), signIn('Mila', ''), signIn('', ''), signIn({ a: 1 }, ['x']), signIn('Branko', 'jovan has his own one')]);
  assert.deepEqual(refusals.map((r) => r.status), [401, 401, 401, 401, 401, 401, 401]);
  assert.equal(new Set(refusals.map((r) => r.body.error)).size, 1);
  assert.match(refusals[0]!.body.error, /do not match a member/);
  assert.ok(refusals.every((r) => !r.body.token));
  // Too much to be a sign-in at all.
  assert.equal((await signIn('Branko', 'x'.repeat(5000))).status, 413);
  // Only a POST at the door's /login; nothing to read there.
  assert.equal((await door('GET', '/login')).status, 404);
});

test('the office\'s own token is still not taken from outside, and a phone is still turned away', async () => {
  assert.equal((await door('GET', '/api/me', { token: h.token })).status, 401);
  assert.equal((await door('POST', `/api/guests/${ids.Vera}/password`, { token: h.token, body: { password: GOOD } })).status, 401);
  const phone = await door('POST', '/login', { body: { username: 'Branko', password: GOOD }, headers: { 'user-agent': PHONE } });
  assert.deepEqual([phone.status, phone.body.phone], [403, true]);
});

test('who may give whom a password', async () => {
  const jovan = (await signIn('Jovan', 'jovan has his own one')).body.token as string;
  // A colleague and a visitor: nobody's but their own.
  for (const token of [jovan, invited.Mila!]) {
    assert.equal((await door('POST', `/api/guests/${ids.Vera}/password`, { token, body: { password: GOOD } })).status, 403);
    assert.equal((await door('DELETE', `/api/guests/${ids.Branko}/password`, { token })).status, 403);
  }
  assert.equal((await signIn('Vera', GOOD)).status, 401, 'nothing was set');
  // An owner who is a member may, as from the office's own computer.
  assert.equal((await door('POST', `/api/guests/${ids.Vera}/password`, { token: invited.Branko, body: { password: 'vera gets one from branko' } })).status, 200);
  assert.equal((await signIn('Vera', 'vera gets one from branko')).status, 200);
  // What is refused as a password.
  for (const [password, why] of [['short', /at least 8/], ['VERA', /at least 8/], ['x'.repeat(201), /too long/]] as const) {
    const r = await h.apiRaw('POST', `/guests/${ids.Vera}/password`, { password });
    assert.equal(r.status, 400);
    assert.match(r.body.error, why);
  }
  assert.match((await h.apiRaw('POST', `/guests/${ids.Mila}/password`, { password: 'mila' })).body.error, /at least 8/);
  assert.equal((await h.apiRaw('POST', '/guests/nobody/password', { password: GOOD })).status, 404);
});

test('one\'s own password: changed by knowing the current one; signing out ends that session and nothing else', async () => {
  const first = (await signIn('Jovan', 'jovan has his own one')).body.token as string;
  const second = (await signIn('Jovan', 'jovan has his own one')).body.token as string;
  assert.equal((await door('POST', '/api/logout', { token: first })).body.ok, true);
  assert.equal((await door('GET', '/api/me', { token: first })).status, 401);
  assert.equal((await door('GET', '/api/me', { token: second })).status, 200);
  // The credential a member's app keeps is not such a session: "sign out" does not end it.
  assert.equal((await door('POST', '/api/logout', { token: invited.Jovan })).body.ok, false);
  assert.equal((await door('GET', '/api/me', { token: invited.Jovan })).status, 200);

  const wrong = await door('POST', '/api/me/password', { token: second, body: { current: 'not it', password: 'jovan thought of a new one' } });
  assert.equal(wrong.status, 401);
  const changed = await door('POST', '/api/me/password', { token: second, body: { current: 'jovan has his own one', password: 'jovan thought of a new one' } });
  assert.deepEqual([changed.status, changed.body.ok], [200, true]);
  assert.equal((await door('GET', '/api/me', { token: second })).status, 401, 'what was signed in with the old password is out');
  assert.equal((await door('GET', '/api/me', { token: invited.Jovan })).status, 200, 'the app stays in');
  assert.equal((await signIn('Jovan', 'jovan has his own one')).status, 401);
  assert.equal((await signIn('Jovan', 'jovan thought of a new one')).status, 200);
  // A member with no password yet sets a first one for themselves (they are already in, with their invitation).
  assert.equal((await door('POST', '/api/me/password', { token: invited.Mila, body: { password: 'mila sets her own' } })).status, 200);
  assert.deepEqual([(await signIn('Mila', 'mila sets her own')).body.role], ['visitor']);
  // The office's own computer has no password to set.
  assert.equal((await h.apiRaw('POST', '/me/password', { password: GOOD })).status, 400);
});

test('a window that is open with a sign-in is closed when that sign-in ends; the app\'s own window is not', async () => {
  const live = (token: string) => {
    const ws = new WebSocket(`${doorUrl.replace('https', 'wss')}/ws/client`, ['orch.v1', `orch.token.${token}`]);
    const seen = { ready: false, closed: null as number | null };
    ws.onmessage = (ev) => void (JSON.parse(String(ev.data)).t === 'ready' && (seen.ready = true));
    ws.onclose = (ev) => (seen.closed = ev.code);
    ws.onerror = () => undefined;
    return { ws, seen, up: () => waitFor(() => seen.ready, { label: 'the window is in' }), gone: () => waitFor(() => seen.closed, { label: 'the window was closed' }) };
  };
  const a = (await signIn('Branko', GOOD)).body.token as string;
  const b = (await signIn('Branko', GOOD)).body.token as string;
  const windows = { a: live(a), b: live(b), app: live(invited.Branko!) };
  await Promise.all(Object.values(windows).map((w) => w.up()));
  // Signing out ends that one session — and its window.
  assert.equal((await door('POST', '/api/logout', { token: a })).body.ok, true);
  assert.equal(await windows.a.gone(), 4003);
  await sleep(300);
  assert.deepEqual([windows.b.seen.closed, windows.app.seen.closed], [null, null]);
  // A new password ends every session made with the old one; the app, which came in with its own credential, stays.
  await h.api('POST', `/guests/${ids.Branko}/password`, { password: GOOD });
  assert.equal(await windows.b.gone(), 4003);
  await sleep(300);
  assert.equal(windows.app.seen.closed, null);
  windows.app.ws.close();
  // A window opened with a session that has ended is not let in at all.
  const late = live(b);
  assert.equal(await late.gone(), 4003);
});

test('a window that is open with a sign-in is closed when that sign-in runs out', async () => {
  // A session that lasts two seconds instead of thirty days, made the way a sign-in makes one.
  const token = `orch_guest_${'short-lived-session'.padEnd(32, 'x')}`;
  h.server.engine.core.store.addCredential('guest', token, { refId: ids.Branko, label: 'login\tBranko', ttlMs: 2000 });
  const seen = { ready: false, closed: null as number | null };
  const ws = new WebSocket(`${doorUrl.replace('https', 'wss')}/ws/client`, ['orch.v1', `orch.token.${token}`]);
  ws.onmessage = (ev) => void (JSON.parse(String(ev.data)).t === 'ready' && (seen.ready = true));
  ws.onclose = (ev) => (seen.closed = ev.code);
  ws.onerror = () => undefined;
  await waitFor(() => seen.ready, { label: 'the window is in' });
  assert.equal((await door('GET', '/api/me', { token })).body.passwordSession, true);
  const code = await waitFor(() => seen.closed, { label: 'closed when the session ran out', timeout: 8000 });
  assert.equal(code, 4003);
  assert.equal((await door('GET', '/api/me', { token })).status, 401);
});

test('five wrong passwords close the name for a while — for the right one too — and the office says so', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await signIn('Vera', `guess number ${i}`)).status, 401);
  const closed = await signIn('Vera', 'vera gets one from branko');
  assert.equal(closed.status, 429);
  assert.match(closed.body.error, /Too many wrong passwords for this name\. Try again in 15 minutes/);
  const notes = (await h.state()).notifications.filter((n) => /Sign-in for Vera is closed/.test(n.title));
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.kind, 'security');
  // Her invitation's credential is not touched by it, and neither is anyone else's sign-in.
  assert.equal((await door('GET', '/api/me', { token: invited.Vera })).status, 200);
  assert.equal((await signIn('Branko', GOOD)).status, 200);
  // A new password from an owner opens the name again.
  await h.api('POST', `/guests/${ids.Vera}/password`, { password: 'vera starts over now' });
  assert.equal((await signIn('Vera', 'vera starts over now')).status, 200);
});

test('a new invitation takes the password away with everything else the member came in with', async () => {
  // Whoever held Vera's credential could have given her account a password of their own (a first one needs no proof)…
  assert.equal((await door('POST', '/api/me/password', { token: invited.Vera, body: { current: 'vera starts over now', password: 'set by whoever held it' } })).status, 200);
  const held = (await signIn('Vera', 'set by whoever held it')).body.token as string;
  assert.equal((await door('GET', '/api/me', { token: held })).status, 200);
  // …so when the owner issues a new invitation, that way in is closed as well.
  const again = await h.api<any>('POST', `/guests/${ids.Vera}/reissue`, {});
  assert.equal((await door('GET', '/api/me', { token: held })).status, 401);
  assert.equal((await door('GET', '/api/me', { token: invited.Vera })).status, 401);
  assert.equal((await signIn('Vera', 'set by whoever held it')).status, 401);
  assert.equal(((await h.api<any>('GET', '/sharing')).guests as Array<{ name: string; hasPassword: boolean }>).find((g) => g.name === 'Vera')!.hasPassword, false);
  invited.Vera = again.invite ? decode(again.invite).t : invited.Vera;
});

test('an address that keeps guessing names is turned away; another address is not', async () => {
  for (let i = 0; i < 20; i++) assert.equal((await signIn(`somebody ${i}`, 'whatever it is', '203.0.113.9')).status, 401);
  const away = await signIn('Branko', GOOD, '203.0.113.9');
  assert.equal(away.status, 429);
  assert.match(away.body.error, /Too many attempts from here/);
  assert.equal((await signIn('Branko', GOOD, '203.0.113.10')).status, 200);
});

test('passwords outlive a restart, are stored only as hashes, and go with the member', async () => {
  const before = (await signIn('Branko', GOOD)).body.token as string;
  await h.restartServer();
  const port = Number(new URL(doorUrl).port);
  await h.api('POST', '/sharing', { open: true, port }).catch(() => undefined);
  assert.equal((await door('GET', '/api/me', { token: before })).status, 200, 'a session is still a session');
  assert.equal((await signIn('Branko', GOOD)).status, 200);
  // Nothing on disk holds a password as it was typed.
  const dataDir = path.join(path.dirname(h.agentHome), 'server');
  const files = fs.readdirSync(dataDir).filter((n) => fs.statSync(path.join(dataDir, n)).isFile());
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dataDir, f)).toString('latin1');
    for (const secret of [GOOD, 'vera starts over now', 'jovan thought of a new one', 'mila sets her own', 'guess number', 'not the password']) assert.ok(!text.includes(secret), `${f} holds a password`);
  }
  // Taking the password away ends the sessions made with it; removing the member ends everything.
  const session = (await signIn('Mila', 'mila sets her own')).body.token as string;
  assert.deepEqual(await h.api('DELETE', `/guests/${ids.Mila}/password`), { ok: true, hasPassword: false });
  assert.equal((await door('GET', '/api/me', { token: session })).status, 401);
  assert.equal((await signIn('Mila', 'mila sets her own')).status, 401);
  assert.equal((await door('GET', '/api/me', { token: invited.Mila })).status, 200);
  const jovan = (await signIn('Jovan', 'jovan thought of a new one')).body.token as string;
  await h.api('DELETE', `/guests/${ids.Jovan}`);
  assert.equal((await door('GET', '/api/me', { token: jovan })).status, 401);
  assert.equal((await signIn('Jovan', 'jovan thought of a new one')).status, 401);
  const audit = await h.api<Array<{ action: string }>>('GET', '/audit?limit=500');
  for (const action of ['login.password_set', 'login.signed_in', 'login.failed', 'login.locked', 'login.password_removed']) assert.ok(audit.some((a) => a.action === action), action);
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(`${GOOD}|guess number|not the password`), 'what was typed is never written to the audit log');
});
