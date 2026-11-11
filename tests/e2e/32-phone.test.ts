/**
 * The office is entered from a computer. A phone — told by what its browser says it is — gets a page that says so,
 * whatever it asks for: the office itself, an invitation link (which is not used up), the door, the API, the live link.
 * Machines are not people: a host agent, an employee's session and a health check are never turned away for it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from './harness.ts';

const PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let h: Harness;
const get = (route: string, ua: string, extra: Record<string, string> = {}, method = 'GET', body?: unknown) =>
  fetch(`${h.url}${route}`, { method, headers: { 'user-agent': ua, ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });

before(async () => {
  h = await createHarness();
});
after(async () => {
  await h?.cleanup();
});

test('a phone asking for the office, or for an invitation, gets a page that says: on a computer', async () => {
  for (const route of ['/', '/join/ABCD-EFGH-JKLM', '/join/ABCD-EFGH-JKLM.0123456789abcdef0123']) {
    const res = await get(route, PHONE);
    assert.equal(res.status, 403, route);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const page = await res.text();
    assert.match(page, /opens on a computer/);
    assert.match(page, /cannot be entered from a phone/);
  }
});

test('a phone gets nothing else either: not the API with a valid token, not the door, not an invitation\'s exchange, not the live link', async () => {
  const auth = { authorization: `Bearer ${h.token}` };
  assert.equal((await get('/api/state', DESKTOP, auth)).status, 200, 'the same token on a computer is fine');
  const api = await get('/api/state', PHONE, auth);
  assert.equal(api.status, 403);
  const told = (await api.json()) as { phone: boolean; error: string };
  assert.equal(told.phone, true);
  assert.match(told.error, /desktop computer only/);
  // Refused before the code is even looked at — so an invitation opened on a phone by mistake still works on a computer.
  const join = await get('/join', PHONE, {}, 'POST', { code: 'ABCD-EFGH-JKLM' });
  assert.deepEqual([join.status, ((await join.json()) as { phone: boolean }).phone], [403, true]);
  const knock = await get('/knock', PHONE, {}, 'POST', { name: 'Someone' });
  assert.deepEqual([knock.status, ((await knock.json()) as { phone: boolean }).phone], [403, true]);
  // The live link: the connection is not made.
  const opened = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`${h.url.replace(/^http/, 'ws')}/ws/client`, { headers: { 'user-agent': PHONE }, protocols: ['orch.v1', `orch.token.${h.token}`] } as any);
    const done = (what: string) => {
      try {
        ws.close();
      } catch {
        /* never opened */
      }
      resolve(what);
    };
    ws.addEventListener('open', () => setTimeout(() => done('open'), 300));
    ws.addEventListener('message', () => done('message'));
    ws.addEventListener('error', () => done('refused'));
    ws.addEventListener('close', () => done('closed'));
  });
  assert.notEqual(opened, 'message', 'nothing of the office reaches a phone');
  assert.notEqual(opened, 'open');
});

test('what is not a person is never turned away for a phone\'s name: health checks, host agents, employees\' sessions', async () => {
  assert.equal((await get('/healthz', PHONE)).status, 200);
  // An employee's session calling the office's tools: judged by its token, as always (here: none, so 401 — not 403).
  const mcp = await get('/mcp', PHONE, {}, 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(mcp.status, 401);
  // A computer is let through to everything as before.
  assert.equal((await get('/healthz', DESKTOP)).status, 200);
  const page = await get('/', DESKTOP);
  assert.notEqual(page.status, 403);
});
