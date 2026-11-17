/**
 * An employee writes straight to a person (`message_person`): what is written to the boss reaches every owner and no
 * colleague, what is written to a colleague reaches only them — in the state their window is given, as it happens,
 * and in what "Mark all read" in somebody else's Inbox touches.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { Notification, ServerToClient } from '@orchestrator/contracts';
import { handleMcpPost } from '@orchestrator/integrations';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.removeAllListeners('warning');

let h: Harness;
let doorUrl = '';
let alex = '';
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
async function as(who: string, method: string, p: string, body?: unknown) {
  const r = await fetch(`${doorUrl}/api${p}`, { method, headers: { authorization: `Bearer ${tokens[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}
async function join(who: string) {
  const ws = new WebSocket(`${doorUrl.replace('https', 'wss')}/ws/client`, ['orch.v1', `orch.token.${tokens[who]}`]);
  const got: ServerToClient[] = [];
  ws.onmessage = (ev) => got.push(JSON.parse(String(ev.data)));
  ws.onerror = () => undefined;
  await waitFor(async () => got.find((m) => m.t === 'ready'), { label: `ready for ${who}` });
  return { ws, heard: (re: RegExp) => got.some((m) => m.t === 'entity' && m.kind === 'notification' && re.test((m.data as Notification).body)) };
}
const write = async (args: Record<string, unknown>) => {
  const eng = h.server.engine;
  const employee = eng.core.employees.require(alex);
  const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'message_person', arguments: args } }, eng.mcp, { employee, session: eng.core.sessionOf(employee.id) ?? ({ id: 'none', employeeId: employee.id, hostId: employee.hostId } as any) });
  return { text: String(res.body.result?.content?.[0]?.text ?? ''), isError: res.body.result?.isError === true };
};
const sees = async (who: string, re: RegExp) => ((await as(who, 'GET', '/state')).body.notifications as Notification[]).some((n) => re.test(n.body));
const rootSees = async (re: RegExp) => (await h.state()).notifications.some((n) => re.test(n.body));

before(async () => {
  h = await createHarness();
  const port = await freePort();
  await h.api('POST', '/sharing', { open: true, port });
  doorUrl = `https://127.0.0.1:${port}`;
  for (const [name, role] of [['Ana', 'colleague'], ['Vera', 'owner'], ['Mila', 'visitor']] as const) tokens[name] = decode((await h.api<any>('POST', '/guests', { name, role })).invite).t;
  const project = await h.project('Shop', h.makeRepo('shop'));
  alex = (await h.employee('Alex', 'backend', { projectId: project.id })).id;
});
after(async () => {
  await h.cleanup();
});

test('to the boss: every owner sees it, as it happens and in their state; a colleague and a visitor do not', async () => {
  const ana = await join('Ana');
  const vera = await join('Vera');
  const res = await write({ to: 'boss', message: 'The staging server is full: 97 % of the disk.', urgent: true });
  assert.equal(res.isError, false, res.text);
  await waitFor(async () => vera.heard(/staging server is full/), { label: 'Vera (an owner) is told at once' });
  assert.ok(await rootSees(/staging server is full/), 'the root owner has it');
  assert.ok(await sees('Vera', /staging server is full/));
  await sleep(300);
  assert.equal(ana.heard(/staging server is full/), false, 'not sent to a colleague');
  assert.equal(await sees('Ana', /staging server is full/), false);
  assert.deepEqual((await as('Mila', 'GET', '/state')).body.notifications, []);
  ana.ws.close();
  vera.ws.close();
});

test('to a colleague: only they see it — not the owners — and an owner\'s "Mark all read" leaves it unread for them', async () => {
  const ana = await join('Ana');
  const res = await write({ to: 'Ana', message: 'The boss asked me to tell you: the review of the login page is yours today.' });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /^Sent to Ana:/);
  await waitFor(async () => ana.heard(/review of the login page/), { label: 'Ana is told at once' });
  assert.ok(await sees('Ana', /review of the login page/));
  assert.equal(await sees('Vera', /review of the login page/), false);
  assert.equal(await rootSees(/review of the login page/), false);
  await h.api('POST', '/notifications/read', {});
  const hers = ((await as('Ana', 'GET', '/state')).body.notifications as Notification[]).find((n) => /review of the login page/.test(n.body))!;
  assert.equal(hers.readAt, null, 'still new for her');
  // Nobody else can dismiss it for her either.
  await h.api('POST', `/notifications/${hers.id}/resolve`, {});
  assert.equal(((await as('Ana', 'GET', '/state')).body.notifications as Notification[]).find((n) => n.id === hers.id)!.resolvedAt, null);
  await as('Ana', 'POST', '/notifications/read', {});
  assert.ok(((await as('Ana', 'GET', '/state')).body.notifications as Notification[]).find((n) => n.id === hers.id)!.readAt, 'read when she reads it');
  ana.ws.close();
});

test('a visitor is nobody to write to; the answer says who is', async () => {
  const res = await write({ to: 'Mila', message: 'hello' });
  assert.equal(res.isError, true);
  assert.match(res.text, /You can write to: the boss, Ana, Vera\./);
});
