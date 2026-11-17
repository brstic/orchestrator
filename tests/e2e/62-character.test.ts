/**
 * Each person's own character (docs/CHARACTER.md): made once, kept for them on the server, drawn for them in every
 * window — theirs and everybody else's — and there again the next time they come in.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { Appearance, ServerToClient } from '@orchestrator/contracts';
import { createHarness, waitFor, type Harness } from './harness.ts';

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

/** A request through the door as one of the invited people. */
async function as(who: string, method: string, p: string, body?: unknown) {
  const r = await fetch(`${doorUrl}/api${p}`, { method, headers: { authorization: `Bearer ${tokens[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

async function join(who: string) {
  const ws = new WebSocket(`${doorUrl.replace('https', 'wss')}/ws/client`, ['orch.v1', `orch.token.${tokens[who]}`]);
  const got: ServerToClient[] = [];
  ws.onmessage = (ev) => got.push(JSON.parse(String(ev.data)));
  ws.onerror = () => undefined;
  const ready = (await waitFor(async () => got.find((m) => m.t === 'ready'), { label: `ready for ${who}` })) as Extract<ServerToClient, { t: 'ready' }>;
  return { ws, got, ready, stand: (x: number, z: number) => ws.send(JSON.stringify({ t: 'presence', x, z, rot: 0, moving: false })) };
}

const LOOK: Appearance = { skin: '#8d5524', hair: '#c2185b', hairStyle: 'mohawk', shirt: '#3fd0c9', pants: '#1d2027', accessory: 'headphones', build: 1.06, outfit: 'tee', glasses: true, facialHair: 'goatee', face: 2, brows: 4, eyes: '#4d7a55', girth: 1.03, shoes: '#c0392b' };

before(async () => {
  h = await createHarness();
  const port = await freePort();
  await h.api('POST', '/sharing', { open: true, port });
  doorUrl = `https://127.0.0.1:${port}`;
  for (const [name, role] of [['Ana', 'colleague'], ['Mila', 'visitor']] as const) tokens[name] = decode((await h.api<any>('POST', '/guests', { name, role })).invite).t;
});
after(async () => {
  await h.cleanup();
});

test('a colleague makes a character: it is kept as sent, comes back with their window, and everybody else sees it', async () => {
  assert.equal((await as('Ana', 'GET', '/me/character')).body.look, null, 'none until it is made');
  const mila = await join('Mila');
  const ana = await join('Ana');
  assert.equal(ana.ready.me.look, null);
  assert.equal(typeof ana.ready.me.hue, 'number', 'the colour the office gives them comes with them (the look when they made none)');
  ana.stand(1, 2);
  const saved = await as('Ana', 'PUT', '/me/character', { look: LOOK });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.look, LOOK);
  // Her own window is told; the others see her drawn so.
  await waitFor(async () => ana.got.find((m) => m.t === 'me.look' && JSON.stringify(m.look) === JSON.stringify(LOOK)), { label: 'Ana is told her new look' });
  const seen = await waitFor(async () => {
    const list = [...mila.got].reverse().find((m) => m.t === 'people') as Extract<ServerToClient, { t: 'people' }> | undefined;
    return list?.people.find((p) => p.name === 'Ana' && p.look?.hairStyle === 'mohawk');
  }, { label: 'Mila sees Ana with her new look' });
  assert.deepEqual(seen.look, LOOK);
  // A new window of hers starts with it.
  const again = await join('Ana');
  assert.deepEqual(again.ready.me.look, LOOK);
  for (const w of [mila.ws, ana.ws, again.ws]) w.close();
});

test('a visitor may make their own character too; nobody can make anybody else\'s; what is not a look is not kept', async () => {
  const res = await as('Mila', 'PUT', '/me/character', { look: { ...LOOK, hairStyle: 'afro', build: 7, admin: true, skin: 'not a colour' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.look.hairStyle, 'afro');
  assert.equal(res.body.look.build, 1.1, 'brought within range');
  assert.equal(res.body.look.skin, '#e0ac69', 'what is wrong falls back');
  assert.ok(!('admin' in res.body.look));
  // Hers only: Ana's is as she left it.
  assert.equal((await as('Ana', 'GET', '/me/character')).body.look.hairStyle, 'mohawk');
  assert.equal((await as('Mila', 'PUT', '/me/character', {})).status, 400, 'no look, nothing kept');
  // And back to the office's look.
  assert.equal((await as('Mila', 'DELETE', '/me/character')).body.look, null);
  assert.equal((await as('Mila', 'GET', '/me/character')).body.look, null);
});

test('the owner\'s character is there again after the office restarts', async () => {
  await h.api('PUT', '/me/character', { look: { ...LOOK, outfit: 'suit', tie: '#d4a017' } });
  await h.restartServer();
  const back = await h.api<any>('GET', '/me/character');
  assert.equal(back.look.outfit, 'suit');
  assert.equal(back.look.tie, '#d4a017');
  assert.ok((await h.api<any[]>('GET', '/audit')).some((a) => a.action === 'character.changed'));
});
