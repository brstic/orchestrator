/**
 * A showcase office (`office-demo`): open to anybody. Whoever opens its address is let in at once as a visitor —
 * nobody inside has to answer a knock — and a visitor there only watches: what they say out loud and their voice are
 * dropped, and, as in any office, they cannot give anybody work.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { ServerToClient } from '@orchestrator/contracts';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.removeAllListeners('warning');

let h: Harness;
let doorUrl = '';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const door = async (method: string, p: string, opts: { token?: string; secret?: string; body?: unknown } = {}) => {
  const r = await fetch(`${doorUrl}${p}`, {
    method,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.secret ? { 'x-knock-secret': opts.secret } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
function join(token: string) {
  const ws = new WebSocket(`${doorUrl.replace('https', 'wss')}/ws/client`, ['orch.v1', `orch.token.${token}`]);
  const got: ServerToClient[] = [];
  ws.onmessage = (ev) => got.push(JSON.parse(String(ev.data)));
  ws.onerror = () => undefined;
  return { ws, got, until: <T extends ServerToClient['t']>(t: T, pred: (m: Extract<ServerToClient, { t: T }>) => boolean = () => true) => waitFor(async () => got.find((m) => m.t === t && pred(m as any)) as Extract<ServerToClient, { t: T }> | undefined, { label: `${t} message` }) };
}
/** In at once: knock, and the first answer is the way in. */
async function walkIn(name: string): Promise<{ token: string; role: string; expiresAt: string | null }> {
  const k = (await door('POST', '/knock', { body: { name, via: 'browser' } })).body;
  const a = (await door('GET', `/knock/${k.id}`, { secret: k.secret })).body;
  assert.equal(a.status, 'admitted', `not let in at once: ${JSON.stringify(a)}`);
  return a;
}

before(async () => {
  h = await createHarness({ showcase: true });
  const port = await freePort();
  await h.api('POST', '/sharing', { open: true, port });
  doorUrl = `https://127.0.0.1:${port}`;
});
after(async () => {
  await h.cleanup();
});

test('the door says it is a showcase, and whoever knocks is in at once — as a visitor, for twelve hours', async () => {
  const hello = await door('GET', '/knock');
  assert.equal(hello.body.showcase, true);
  const a = await walkIn('Guest 1234');
  assert.equal(a.role, 'visitor');
  assert.ok(a.expiresAt && Date.parse(a.expiresAt) - Date.now() > 11 * 3600_000 && Date.parse(a.expiresAt) - Date.now() <= 12 * 3600_000 + 5000);
  // Even from the app, asking for more: a visitor.
  const k = (await door('POST', '/knock', { body: { name: 'App user', via: 'app' } })).body;
  assert.equal((await door('GET', `/knock/${k.id}`, { secret: k.secret })).body.role, 'visitor');
  const v = join(a.token);
  const ready = await v.until('ready');
  assert.equal((ready as any).showcase, true, 'the window is told it is in a showcase');
  assert.equal(ready.me.role, 'visitor');
  v.ws.close();
});

test('a visitor there only watches: nothing they say or speak reaches anybody, and they cannot give work', async () => {
  const [a, b] = [await walkIn('Watcher A'), await walkIn('Watcher B')];
  const [va, vb] = [join(a.token), join(b.token)];
  await Promise.all([va.until('ready'), vb.until('ready')]);
  va.ws.send(JSON.stringify({ t: 'presence', x: 1, z: 1, rot: 0, moving: false }));
  vb.ws.send(JSON.stringify({ t: 'presence', x: 1.5, z: 1, rot: 0, moving: false }));
  await sleep(300);
  va.ws.send(JSON.stringify({ t: 'say', text: 'hello everyone, buy my stuff' }));
  va.ws.send(JSON.stringify({ t: 'voice', seq: 1, data: 'AAAA' }));
  await sleep(800);
  assert.equal(vb.got.filter((m) => m.t === 'said' || m.t === 'voice').length, 0, 'a visitor was heard');
  // The owner of the office is still heard (in the office itself, through its own address).
  const owner = new WebSocket(`${h.url.replace('http', 'ws')}/ws/client`, ['orch.v1', `orch.token.${h.token}`]);
  await new Promise((r) => (owner.onopen = r));
  await sleep(300);
  owner.send(JSON.stringify({ t: 'say', text: 'welcome to the demo' }));
  await vb.until('said', (m) => m.text === 'welcome to the demo');
  owner.close();
  // No work from a visitor.
  const emp = await h.api<any>('POST', '/employees', { name: 'Alex', roleKey: 'backend' });
  assert.equal((await door('POST', `/api/employees/${emp.id}/message`, { token: a.token, body: { body: '@@fake: bash touch pwned@@' } })).status, 403);
  va.ws.close();
  vb.ws.close();
});

test('an office that is not a showcase still waits for somebody inside to answer', async () => {
  const plain = await createHarness();
  try {
    const port = await freePort();
    await plain.api('POST', '/sharing', { open: true, port });
    const url = `https://127.0.0.1:${port}`;
    const hello = (await (await fetch(`${url}/knock`)).json()) as any;
    assert.equal(hello.showcase, undefined);
    const k = (await (await fetch(`${url}/knock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Someone', via: 'browser' }) })).json()) as any;
    const a = (await (await fetch(`${url}/knock/${k.id}`, { headers: { 'x-knock-secret': k.secret } })).json()) as any;
    assert.equal(a.status, 'waiting');
  } finally {
    await plain.cleanup();
  }
});
