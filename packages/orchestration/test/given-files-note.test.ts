import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/** Files an employee gives the boss one after another are one line in the Inbox until the boss looked (89 in a week, one each). */
test('files given one after another are one Inbox line until it is read', () => {
  const link: AgentLink = { rpc: () => Promise.reject(new Error('no')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'h', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  const web = eng.employees.create({ name: 'Webber', roleKey: 'frontend', hostId: 'h', workingDir: '/tmp/w' });
  const other = eng.employees.create({ name: 'Ola', roleKey: 'backend', hostId: 'h', workingDir: '/tmp/o' });
  const lines = () => eng.core.notifications.filter((n) => /gave you/.test(n.title) && !n.resolvedAt);
  eng.comms.noteGivenFile(web, 'hero.png', 'The new hero');
  eng.comms.noteGivenFile(web, 'mobile.png', null);
  eng.comms.noteGivenFile(web, 'og.png', 'For sharing');
  eng.comms.noteGivenFile(other, 'report.html', null);
  assert.deepEqual(lines().map((n) => n.title).sort(), ['Ola gave you a file', 'Webber gave you 3 files']);
  assert.equal(lines().find((n) => n.employeeId === web.id)!.body, 'hero.png — The new hero\nmobile.png\nog.png — For sharing');
  // Read: the next file is a new line.
  const first = lines().find((n) => n.employeeId === web.id)!;
  eng.core.put('notification', { ...first, readAt: new Date().toISOString() });
  eng.comms.noteGivenFile(web, 'logo.svg', null);
  assert.equal(eng.core.notifications.filter((n) => n.employeeId === web.id).length, 2);
});
