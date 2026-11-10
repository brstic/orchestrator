/**
 * Knocking at the door: someone with no invitation asks to be let in — from the office's page in a
 * browser, or from the desktop app with only the office's address. Nothing is granted by knocking;
 * the people inside see who is there and one of them answers.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { ServerToClient } from '@orchestrator/contracts';
import { KNOCK_LIMITS } from '../../apps/server/src/knocks.ts';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

// The door's certificate is made on this machine (a real office is behind a name with a trusted certificate).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.removeAllListeners('warning');

let h: Harness;
let doorUrl = '';
const tokens: Record<string, string> = {};

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const decode = (code: string) => JSON.parse(Buffer.from(code.replace(/^orch-invite-v1\./, ''), 'base64url').toString('utf8'));
const at = async (base: string, method: string, p: string, opts: { token?: string; secret?: string; body?: unknown } = {}) => {
  const r = await fetch(`${base}${p}`, {
    method,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.secret ? { 'x-knock-secret': opts.secret } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const door = (method: string, p: string, opts: Parameters<typeof at>[3] = {}) => at(doorUrl, method, p, opts);
function join(token: string) {
  const ws = new WebSocket(`${doorUrl.replace('https', 'wss')}/ws/client`, ['orch.v1', `orch.token.${token}`]);
  const got: ServerToClient[] = [];
  let closed: number | null = null;
  ws.onmessage = (ev) => got.push(JSON.parse(String(ev.data)));
  ws.onclose = (ev) => (closed = ev.code);
  ws.onerror = () => undefined;
  return {
    ws,
    got,
    closed: () => closed,
    knocks: () => (got.filter((m) => m.t === 'knocks').pop() as Extract<ServerToClient, { t: 'knocks' }> | undefined)?.knocks ?? null,
    until: <T extends ServerToClient['t']>(t: T, pred: (m: Extract<ServerToClient, { t: T }>) => boolean = () => true) => waitFor(async () => got.find((m) => m.t === t && pred(m as any)) as Extract<ServerToClient, { t: T }> | undefined, { label: `${t} message` }),
  };
}

before(async () => {
  h = await createHarness();
  const port = await freePort();
  await h.api('POST', '/sharing', { open: true, port });
  doorUrl = `https://127.0.0.1:${port}`;
  for (const [name, role] of [['Mila', 'visitor'], ['Jovan', 'colleague'], ['Vera', 'owner']] as const) tokens[name] = decode((await h.api<any>('POST', '/guests', { name, role })).invite).t;
});
after(async () => {
  await h.cleanup();
});

test('the door says which office this is and takes a knock; the office’s own address does not', async () => {
  const hello = await door('GET', '/knock');
  assert.deepEqual([hello.status, hello.body.orchestrator, typeof hello.body.office], [200, true, 'string']);
  assert.equal((await at(h.url, 'GET', '/knock')).status, 404, 'knocking exists only at the door');
  assert.equal((await at(h.url, 'POST', '/knock', { body: { name: 'Someone' } })).status, 404);
  assert.equal((await door('POST', '/knock', { body: { name: ' ' } })).status, 400, 'a knock needs a name');
  assert.equal((await door('GET', '/knocks')).status, 404, 'the list of who is waiting is not at the door for anyone to read');
  assert.equal((await door('GET', '/api/knocks')).status, 401);
});

test('a knock is seen by owners and colleagues inside, not by visitors; a colleague lets a browser in to look, and nothing more', async () => {
  const [vera, jovan, mila] = [join(tokens.Vera!), join(tokens.Jovan!), join(tokens.Mila!)];
  await Promise.all([vera.until('ready'), jovan.until('ready'), mila.until('ready')]);
  const k = (await door('POST', '/knock', { body: { name: '  Petar\u0007 <b>Petrović</b> ', via: 'browser' } })).body;
  assert.match(k.code, /^\d{4}$/);
  assert.equal(k.anyoneIn, true);
  const seen = (await vera.until('knocks', (m) => m.knocks.length === 1)).knocks[0]!;
  assert.deepEqual([seen.id, seen.name, seen.via, seen.code], [k.id, 'Petar b Petrović /b', 'browser', k.code], 'the name is plain text; both sides see the same code');
  assert.ok(!JSON.stringify(seen).includes(k.secret), 'the knocker’s secret is theirs alone');
  await jovan.until('knocks', (m) => m.knocks.length === 1);
  await sleep(150);
  assert.equal(mila.knocks(), null, 'a visitor is not asked');
  assert.equal((await door('GET', '/api/knocks', { token: tokens.Mila })).status, 403);
  assert.equal((await door('POST', `/api/knocks/${k.id}/admit`, { token: tokens.Mila, body: { role: 'visitor' } })).status, 403);
  // Waiting, and only for whoever holds the knock's secret.
  assert.deepEqual((await door('GET', `/knock/${k.id}`, { secret: k.secret })).body, { status: 'waiting', code: k.code, anyoneIn: true });
  assert.equal((await door('GET', `/knock/${k.id}`, { secret: 'guess' })).body.status, 'gone');
  assert.equal((await door('GET', `/knock/${k.id}`)).body.status, 'gone');
  // A colleague cannot let anyone in to work.
  const tooMuch = await door('POST', `/api/knocks/${k.id}/admit`, { token: tokens.Jovan, body: { role: 'colleague' } });
  assert.equal(tooMuch.status, 403);
  assert.match(tooMuch.body.error, /Only an owner/);
  assert.equal((await door('POST', `/api/knocks/${k.id}/admit`, { token: tokens.Jovan, body: { role: 'visitor' } })).status, 200);
  await vera.until('knocks', (m) => m.knocks.length === 0);
  assert.equal((await door('POST', `/api/knocks/${k.id}/admit`, { token: tokens.Vera, body: { role: 'visitor' } })).status, 404, 'answered once');
  const let_in = (await door('GET', `/knock/${k.id}`, { secret: k.secret })).body;
  assert.deepEqual([let_in.status, let_in.role, let_in.name], ['admitted', 'visitor', 'Petar b Petrović /b']);
  assert.ok(Date.parse(let_in.expiresAt) - Date.now() > 11 * 3600_000 && Date.parse(let_in.expiresAt) - Date.now() < 13 * 3600_000, 'a browser visit ends by itself');
  assert.equal((await door('GET', `/knock/${k.id}`, { secret: k.secret })).body.status, 'gone', 'the credential is handed over once');
  // What they got is a visitor's access, and no more.
  const me = await door('GET', '/api/me', { token: let_in.token });
  assert.deepEqual([me.status, me.body.kind, me.body.role], [200, 'guest', 'visitor']);
  assert.equal((await door('GET', '/api/state', { token: let_in.token })).status, 200);
  assert.equal((await door('POST', '/api/employees', { token: let_in.token, body: { name: 'Intruder' } })).status, 403);
  const listed = (await h.api<any>('GET', '/sharing')).guests.find((g: any) => g.name === 'Petar b Petrović /b');
  assert.deepEqual([listed.role, listed.via], ['visitor', 'knock-browser']);
  for (const c of [vera, jovan, mila]) c.ws.close();
});

test('with the desktop app an owner chooses as what; a browser can only ever look; names do not collide; refusing and leaving', async () => {
  const vera = join(tokens.Vera!);
  await vera.until('ready');
  // The app, let in as a colleague: what comes back is an invitation like any other.
  const a = (await door('POST', '/knock', { body: { name: 'Jovan', via: 'app' } })).body;
  await vera.until('knocks', (m) => m.knocks.some((x) => x.id === a.id && x.via === 'app'));
  assert.equal((await door('POST', `/api/knocks/${a.id}/admit`, { token: tokens.Vera, body: { role: 'boss' } })).status, 400);
  assert.equal((await door('POST', `/api/knocks/${a.id}/admit`, { token: tokens.Vera, body: { role: 'colleague' } })).status, 200);
  const got = (await door('GET', `/knock/${a.id}`, { secret: a.secret })).body;
  assert.deepEqual([got.status, got.role, got.name, got.expiresAt], ['admitted', 'colleague', 'Jovan 2', null], 'there is a Jovan already');
  const inv = decode(got.invite);
  assert.deepEqual([inv.g, inv.r, inv.t], ['Jovan 2', 'colleague', got.token]);
  assert.equal((await door('GET', '/api/me', { token: got.token })).body.role, 'colleague');
  assert.equal((await door('POST', '/api/me/host', { token: got.token, body: {} })).status, 200, 'and may bring their own computer');
  // A browser asked to be an owner is still only a visitor.
  const b = (await door('POST', '/knock', { body: { name: 'Sneaky', via: 'browser' } })).body;
  assert.equal((await door('POST', `/api/knocks/${b.id}/admit`, { token: tokens.Vera, body: { role: 'owner' } })).status, 200);
  assert.equal((await door('GET', `/knock/${b.id}`, { secret: b.secret })).body.role, 'visitor');
  // Refused.
  const c = (await door('POST', '/knock', { body: { name: 'Stranger', via: 'app' } })).body;
  assert.equal((await door('POST', `/api/knocks/${c.id}/refuse`, { token: tokens.Vera, body: {} })).status, 200);
  assert.deepEqual((await door('GET', `/knock/${c.id}`, { secret: c.secret })).body, { status: 'refused' });
  // Walked away before anyone answered.
  const d = (await door('POST', '/knock', { body: { name: 'Hasty', via: 'app' } })).body;
  await vera.until('knocks', (m) => m.knocks.some((x) => x.id === d.id));
  assert.equal((await door('DELETE', `/knock/${d.id}`, { secret: 'not mine' })).status, 200);
  assert.equal((await h.api<any[]>('GET', '/knocks')).length, 1, 'only the one who knocked can take the knock back');
  await door('DELETE', `/knock/${d.id}`, { secret: d.secret });
  await vera.until('knocks', (m) => m.knocks.length === 0 && vera.got.indexOf(m) > vera.got.findIndex((x) => x.t === 'knocks' && x.knocks.some((y) => y.id === d.id)));
  assert.equal((await door('POST', `/api/knocks/${d.id}/admit`, { token: tokens.Vera, body: { role: 'visitor' } })).status, 404);
  // Let in, then gone before collecting it: the member that was made is taken back.
  const e = (await door('POST', '/knock', { body: { name: 'Fickle', via: 'app' } })).body;
  await door('POST', `/api/knocks/${e.id}/admit`, { token: tokens.Vera, body: { role: 'owner' } });
  await door('DELETE', `/knock/${e.id}`, { secret: e.secret });
  const fickle = (await h.api<any>('GET', '/sharing')).guests.find((g: any) => g.name === 'Fickle');
  assert.ok(fickle.revokedAt, 'nobody holds that credential, so it does not exist');
  vera.ws.close();
});

test('the doorstep is small: one address cannot fill it, and whoever walks in later still sees who is waiting', async () => {
  // Six knocks from this address in the tests above: the seventh within ten minutes is turned away.
  const tooMany = await door('POST', '/knock', { body: { name: 'Seventh', via: 'browser' } });
  assert.equal(tooMany.status, 429);
  KNOCK_LIMITS.perIpPerWindow = 100;
  const first = (await door('POST', '/knock', { body: { name: 'One', via: 'browser' } })).body;
  const second = await door('POST', '/knock', { body: { name: 'Two', via: 'browser' } });
  assert.equal(second.status, 200);
  const third = await door('POST', '/knock', { body: { name: 'Three', via: 'browser' } });
  assert.equal(third.status, 429);
  assert.match(third.body.error, /knocked several times/);
  const late = join(tokens.Vera!);
  assert.deepEqual((await late.until('knocks')).knocks.map((k) => k.name), ['One', 'Two']);
  late.ws.close();
  await door('DELETE', `/knock/${first.id}`, { secret: first.secret });
  await door('DELETE', `/knock/${second.body.id}`, { secret: second.body.secret });
  assert.equal((await h.api<any[]>('GET', '/knocks')).length, 0);
});
