import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorOf, hasOwn, madeByMe, mineFirst, scoped, taskIsMine, whoseEmployee, whoseLabel, whoseProject, whoseTask } from '../src/lib/mine.ts';
import { mayOpenPanel, VISITOR_PANELS } from '../src/lib/visitor-panels.ts';

/** Whose a thing is for the person at the window, and what the lists make of it. */
const hosts = {
  office: { id: 'office', memberId: null, status: 'online' },
  mine: { id: 'mine', memberId: 'fenix', memberName: 'Fenix', status: 'online' },
  myServer: { id: 'myServer', memberId: 'fenix', memberName: 'Fenix', ownerId: 'fenix', status: 'offline' },
  lent: { id: 'lent', memberId: null, ownerId: 'fenix', status: 'online' },
  janca: { id: 'janca', memberId: 'janca', memberName: 'Janca', status: 'online' },
} as any;
const fenix = { kind: 'owner', role: 'owner', name: 'Fenix', id: 'fenix' } as any;
const lazar = { kind: 'guest', role: 'colleague', name: 'Lazar', id: 'lazar' } as any;
const root = { kind: 'owner', role: 'owner', name: 'Branko', id: 'owner' } as any;
const visitor = { kind: 'guest', role: 'visitor', name: 'Nikola', id: 'nikola' } as any;
const employees = { a: { id: 'a', hostId: 'mine' }, b: { id: 'b', hostId: 'office' }, c: { id: 'c', hostId: 'janca' }, d: { id: 'd', hostId: 'myServer' } } as any;
const projects = { pm: { id: 'pm', hostId: 'mine' }, po: { id: 'po', hostId: 'office' }, pj: { id: 'pj', hostId: 'janca' }, loose: { id: 'loose', hostId: null } } as any;

test('whose a thing is follows the machine: mine, shared, or another member’s', () => {
  assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => whoseLabel(whoseEmployee(hosts, fenix, employees[id]))), ['yours', 'shared', 'Janca', 'yours']);
  assert.deepEqual(['pm', 'po', 'pj', 'loose'].map((id) => whoseLabel(whoseProject(hosts, fenix, projects[id]))), ['yours', 'shared', 'Janca', 'shared']);
  // A server I brought in and gave to the office is the office's now.
  assert.equal(whoseEmployee(hosts, fenix, { hostId: 'lent' }).kind, 'shared');
  // To someone else, my things are mine by name.
  assert.deepEqual(whoseEmployee(hosts, lazar, employees.a), { kind: 'member', name: 'Fenix' });
  assert.equal(whoseEmployee(hosts, null, employees.a).kind, 'member');
});

test('having something of one’s own: a member with a machine in the office — not the office’s own computer, not a visitor', () => {
  assert.deepEqual([fenix, lazar, root, visitor, null].map((me) => hasOwn(hosts, me)), [true, false, false, false, false]);
  assert.equal(hasOwn({ gone: { id: 'gone', memberId: 'lazar', status: 'revoked' } } as any, lazar), false, 'a machine taken away is not one');
});

test('a task is mine when it is on my machines, with my employee, or made by me', () => {
  const t = (projectId: string, assigneeId: string | null, createdBy = 'owner') => ({ projectId, assigneeId, createdBy });
  assert.equal(whoseTask(hosts, fenix, t('pm', null), projects, employees).kind, 'mine');
  assert.equal(whoseTask(hosts, fenix, t('loose', 'a'), projects, employees).kind, 'mine', 'no machine for the project: the assignee decides');
  assert.equal(whoseTask(hosts, fenix, t('po', 'b'), projects, employees).kind, 'shared');
  assert.deepEqual(whoseTask(hosts, fenix, t('pj', 'c'), projects, employees), { kind: 'member', name: 'Janca' });
  // Made by me on shared ground: still shared, and still one of mine to find.
  assert.deepEqual([taskIsMine(hosts, fenix, t('po', 'b', 'member:Fenix'), projects, employees), taskIsMine(hosts, fenix, t('po', 'b', 'member:Janca'), projects, employees), taskIsMine(hosts, fenix, t('po', 'b'), projects, employees)], [true, false, false]);
  // The office writes the root owner down as `owner`, a member by name; an employee's task is nobody's "made by me".
  assert.deepEqual([actorOf(root), actorOf(fenix), actorOf(null)], ['owner', 'member:Fenix', null]);
  assert.deepEqual([madeByMe(root, { createdBy: 'owner' }), madeByMe(fenix, { createdBy: 'owner' }), madeByMe(fenix, { createdBy: 'employee:Ava' }), madeByMe(visitor, { createdBy: 'member:Nikola' })], [true, false, false, false]);
});

test('the lists: mine alone, or everyone’s with mine first — and unchanged for someone with nothing of their own', () => {
  const rows = ['b', 'a', 'c', 'd'];
  const mine = (id: string) => whoseEmployee(hosts, fenix, employees[id]).kind === 'mine';
  assert.deepEqual(mineFirst(rows, mine), ['a', 'd', 'b', 'c']);
  assert.deepEqual(scoped(rows, 'mine', true, mine), ['a', 'd']);
  assert.deepEqual(scoped(rows, 'all', true, mine), ['a', 'd', 'b', 'c']);
  assert.deepEqual(scoped(rows, 'mine', false, mine), rows, 'nothing of one’s own: the list as it is');
});

test('a visitor’s windows are the ones the office sends them something for', () => {
  for (const p of ['tasks', 'team', 'employee', 'people', 'map', 'wall', 'radio', 'tv', 'settings', 'help']) assert.ok(mayOpenPanel('visitor', p), p);
  for (const p of ['overview', 'ceo', 'notifications', 'hosts', 'vault', 'growth', 'reports', 'meetings', 'projects', 'task', 'question', 'talk', 'docs', 'myroom', 'mine', 'office', 'seat']) assert.ok(!mayOpenPanel('visitor', p), p);
  for (const role of ['colleague', 'owner', undefined, null]) for (const p of ['overview', 'vault', 'mine', ...VISITOR_PANELS]) assert.ok(mayOpenPanel(role, p), `${role} ${p}`);
});
