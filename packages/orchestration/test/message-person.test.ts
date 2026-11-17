import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from '@orchestrator/contracts';
import { FOR_OWNERS, notificationFor } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { handleMcpPost } from '@orchestrator/integrations';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * An employee writes straight to a person of the office (`message_person`, the owner's wish of 2026-11-18: "a tool
 * with which agents send messages directly to me when something needs my attention — even so that I can tell an agent
 * to send a message to a colleague of mine"). It is a notification addressed to that person only.
 */
const link: AgentLink = { rpc: async () => ({ ok: true }) as any, isOnline: () => true, respondHook: () => false, disconnect: () => undefined };
let eng: Engine;
const id: Record<string, string> = {};
const call = async (who: string, args: Record<string, unknown>) => {
  const employee = eng.core.employees.require(id[who]!);
  const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'message_person', arguments: args } }, eng.mcp, { employee, session: { id: `s-${who}`, employeeId: employee.id, hostId: employee.hostId } as any });
  return { text: String(res.body.result?.content?.[0]?.text ?? JSON.stringify(res.body)), isError: res.body.result?.isError === true };
};
const messages = () => eng.core.notifications.filter((n) => n.kind === 'message');

before(async () => {
  eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'box', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  eng.core.put('host', { ...host, id: 'pc', name: "Ana's computer", local: false, memberId: 'g-ana', memberName: 'Ana Petrović' } as Host);
  const shop = (await eng.tasks.createProject({ name: 'Shop' })).id;
  id.Ava = eng.employees.create({ name: 'Ava', roleKey: 'backend', projectId: shop, hostId: 'box', workingDir: '/tmp/ava' }).id;
  id.Mil = eng.employees.create({ name: 'Mil', roleKey: 'backend', hostId: 'pc', workingDir: '/tmp/mil' }).id;
  // As the server gives it: the root owner, and the owners and colleagues who are in (no visitors).
  eng.comms.people = () => [
    { id: 'owner', name: 'Root', owner: true },
    { id: 'g-ana', name: 'Ana Petrović', owner: false },
    { id: 'g-vera', name: 'Vera', owner: true },
  ];
});

test('to the boss: every owner, and nobody else', async () => {
  const res = await call('Ava', { to: 'boss', message: 'The deploy is ready.\nIt needs your go before 17:00.' });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /^Sent to the boss: it is in their Inbox/);
  const n = messages().at(-1)!;
  assert.deepEqual([n.for, n.severity, n.employeeId, n.title, n.body], [[FOR_OWNERS], 'info', id.Ava, 'Ava: The deploy is ready.', 'The deploy is ready.\nIt needs your go before 17:00.']);
  assert.deepEqual([notificationFor(n, { id: 'owner', owner: true }), notificationFor(n, { id: 'g-vera', owner: true }), notificationFor(n, { id: 'g-ana', owner: false })], [true, true, false]);
  assert.ok(eng.core.store.queryEvents({ types: ['agent.message_to_person'] as any }).some((e) => e.summary === 'Ava wrote to the boss' && !JSON.stringify(e.data).includes('deploy')), 'on the record: who wrote to whom, not what');
});

test('to a colleague by name (whole, or the first name): them only — urgent when it is', async () => {
  const res = await call('Ava', { to: 'ana', message: 'Can you look at the login page today?', urgent: true });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /^Sent to Ana Petrović: .*marked urgent/);
  const n = messages().at(-1)!;
  assert.deepEqual([n.for, n.severity, n.title], [['g-ana'], 'warning', 'Ava · urgent: Can you look at the login page today?']);
  assert.deepEqual([notificationFor(n, { id: 'g-ana', owner: false }), notificationFor(n, { id: 'owner', owner: true })], [true, false], 'not even an owner sees what was written to somebody else');
  assert.equal((await call('Ava', { to: 'Ana Petrović', message: 'Thanks.' })).isError, false);
});

test('nobody of that name, or an employee: refused, with whom one can write to', async () => {
  const before = messages().length;
  const res = await call('Ava', { to: 'Mila', message: 'hi' });
  assert.equal(res.isError, true);
  assert.match(res.text, /Nobody in the office is called "Mila" \(an employee\? use send_message\)\. You can write to: the boss, Ana Petrović, Vera\. Nothing was sent\./);
  assert.equal((await call('Ava', { to: 'boss', message: '   ' })).isError, true);
  assert.equal(messages().length, before);
});

test("on a member's own computer: to that member only, whatever it is called", async () => {
  const toBoss = await call('Mil', { to: 'boss', message: 'Done with the import.' });
  assert.equal(toBoss.isError, false, toBoss.text);
  assert.deepEqual(messages().at(-1)!.for, ['g-ana'], '"the boss" there is the member whose computer it is');
  const toVera = await call('Mil', { to: 'Vera', message: 'psst' });
  assert.equal(toVera.isError, true);
  assert.match(toVera.text, /You work on Ana Petrović's own computer: what you write goes to Ana Petrović only/);
});

test('twenty in an hour, then no more', async () => {
  const before = messages().filter((n) => n.employeeId === id.Ava).length;
  let refused = '';
  for (let i = 0; i < 25 && !refused; i++) {
    const r = await call('Ava', { to: 'Vera', message: `note ${i}` });
    if (r.isError) refused = r.text;
  }
  assert.match(refused, /more than 20 in an hour \(message to a person\)/);
  assert.equal(messages().filter((n) => n.employeeId === id.Ava).length, 20, `${before} were written before this test, the rest up to twenty here`);
});
