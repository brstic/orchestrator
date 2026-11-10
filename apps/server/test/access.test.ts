import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNERS_ONLY, allowed, mayCall, mayDrive, maySee, memberOf, type Who } from '../src/access.ts';

/** An office with one shared machine and Jovan's own computer, and one employee, session, project, task and question on each. */
const table = <T extends { id: string }>(rows: T[]) => ({ get: (id: string) => rows.find((r) => r.id === id) });
const engine = {
  core: {
    hosts: table([{ id: 'h-shared', memberId: null }, { id: 'h-jovan', memberId: 'jovan' }]),
    employees: table([{ id: 'e-shared', hostId: 'h-shared' }, { id: 'e-jovan', hostId: 'h-jovan' }, { id: 'e-foreman', hostId: 'h-shared', roleKey: 'foreman' }]),
    sessions: table([{ id: 's-shared', hostId: 'h-shared', employeeId: 'e-shared' }, { id: 's-jovan', hostId: 'h-jovan', employeeId: 'e-jovan' }, { id: 's-foreman', hostId: 'h-shared', employeeId: 'e-foreman' }]),
    projects: table([{ id: 'p-shared', hostId: 'h-shared' }, { id: 'p-jovan', hostId: 'h-jovan' }, { id: 'p-nohost', hostId: null }]),
    tasks: table([{ id: 't-shared', projectId: 'p-shared', assigneeId: null }, { id: 't-jovan', projectId: 'p-jovan', assigneeId: 'e-jovan' }, { id: 't-loose', projectId: 'p-nohost', assigneeId: 'e-jovan' }]),
    questions: table([{ id: 'q-shared', employeeId: 'e-shared' }, { id: 'q-jovan', employeeId: 'e-jovan' }, { id: 'q-foreman', employeeId: 'e-foreman' }]),
  },
} as any;

const root: Who = { kind: 'owner', id: 'owner', name: 'Root', role: 'owner' };
const vera: Who = { kind: 'owner', id: 'vera', name: 'Vera', role: 'owner' };
const jovan: Who = { kind: 'guest', id: 'jovan', name: 'Jovan', role: 'colleague' };
const ana: Who = { kind: 'guest', id: 'ana', name: 'Ana', role: 'colleague' };
const mila: Who = { kind: 'guest', id: 'mila', name: 'Mila', role: 'visitor' };
const call = (who: Who, method: string, route: string, body?: Record<string, unknown>) => mayCall(engine, who, method, route, body ?? null).ok;

test('whose a thing is follows the machine it lives on', () => {
  assert.equal(memberOf(engine, 'employee', 'e-shared'), null);
  for (const [thing, id] of [['host', 'h-jovan'], ['employee', 'e-jovan'], ['session', 's-jovan'], ['project', 'p-jovan'], ['task', 't-jovan'], ['question', 'q-jovan']] as const) assert.equal(memberOf(engine, thing, id), 'jovan', thing);
  assert.equal(memberOf(engine, 'task', 't-loose'), 'jovan', 'a task with no project machine follows its assignee');
  assert.equal(memberOf(engine, 'employee', 'nobody'), null, 'unknown things are left to the route (404)');
});

test('the three roles', () => {
  for (const who of [root, vera]) for (const need of ['read', 'work', 'admin'] as const) for (const member of [null, 'jovan']) assert.equal(allowed(who, need, member), true);
  assert.deepEqual([allowed(mila, 'read', null), allowed(mila, 'work', null), allowed(mila, 'admin', null), allowed(mila, 'read', 'jovan')], [true, false, false, false]);
  assert.deepEqual([allowed(ana, 'read', null), allowed(ana, 'work', null), allowed(ana, 'admin', null), allowed(ana, 'read', 'jovan'), allowed(ana, 'work', 'jovan')], [true, true, false, false, false]);
  assert.deepEqual([allowed(jovan, 'read', 'jovan'), allowed(jovan, 'work', 'jovan'), allowed(jovan, 'admin', 'jovan')], [true, true, false]);
});

test('requests: shared work for colleagues, a member’s computer for that member, the office for owners', () => {
  assert.ok(call(mila, 'GET', '/state') && call(mila, 'GET', '/employees/e-shared/docs') && call(mila, 'GET', '/usage'));
  assert.ok(!call(mila, 'POST', '/employees/e-shared/message') && !call(mila, 'GET', '/employees/e-jovan/docs') && !call(mila, 'POST', '/me/host'));
  assert.ok(call(ana, 'POST', '/employees/e-shared/stop') && call(ana, 'POST', '/questions/q-shared/answer') && call(ana, 'PATCH', '/tasks/t-shared'));
  for (const [m, r, b] of [
    ['GET', '/employees/e-jovan/docs'],
    ['POST', '/employees/e-jovan/message'],
    ['POST', '/questions/q-jovan/answer'],
    ['PATCH', '/tasks/t-jovan'],
    ['GET', '/tasks/t-loose/git'],
    ['GET', '/sessions/s-jovan/history'],
    ['GET', '/hosts/h-jovan/browse'],
    ['POST', '/employees', { hostId: 'h-jovan' }],
    ['POST', '/projects', { hostId: 'h-jovan' }],
    ['POST', '/tasks', { projectId: 'p-jovan' }],
    ['PATCH', '/employees/e-shared', { hostId: 'h-jovan' }],
    ['PATCH', '/tasks/t-shared', { assigneeId: 'e-jovan' }],
    ['POST', '/sessions/s-shared/bind', { employeeId: 'e-jovan' }],
  ] as Array<[string, string, Record<string, unknown>?]>) {
    assert.equal(call(ana, m, r, b), false, `Ana: ${m} ${r}`);
    assert.equal(call(jovan, m, r, b), true, `Jovan: ${m} ${r}`);
    assert.equal(call(vera, m, r, b), true, `Vera: ${m} ${r}`);
  }
  for (const [m, r] of [['PATCH', '/settings'], ['PUT', '/layout'], ['POST', '/guests'], ['GET', '/audit'], ['POST', '/ssh-links'], ['POST', '/hosts/enroll-token'], ['POST', '/hosts/h-jovan/revoke'], ['POST', '/commands/execute'], ['POST', '/projects/p-shared/promote']] as const) {
    assert.equal(call(jovan, m, r), false, `${m} ${r} needs an owner`);
    assert.equal(call(vera, m, r), true);
  }
  // A route nobody listed needs an owner: forgetting to list one fails closed.
  assert.equal(call(jovan, 'POST', '/something/new'), false);
  assert.equal(call(jovan, 'GET', '/something/new'), false);
  assert.match(mayCall(engine, mila, 'POST', '/tasks', {}).reason!, /visiting/);
  assert.match(mayCall(engine, ana, 'POST', '/employees/e-jovan/stop', {}).reason!, /another member's own computer/);
});

test('the foreman sees what owners see, so it is the owners\' alone: its terminal, its profile, the conversation with it, and hiring one', () => {
  for (const [thing, id] of [['employee', 'e-foreman'], ['session', 's-foreman'], ['question', 'q-foreman']] as const) assert.equal(memberOf(engine, thing, id), OWNERS_ONLY, thing);
  for (const who of [mila, ana, jovan]) {
    assert.deepEqual([maySee(engine, who, 's-foreman'), mayDrive(engine, who, 's-foreman')], [false, false], `${who.name}: its terminal`);
    for (const [m, r, b] of [
      ['GET', '/employees/e-foreman/docs'],
      ['GET', '/sessions/s-foreman/history'],
      ['POST', '/employees/e-foreman/message'],
      ['POST', '/employees/e-foreman/start'],
      ['POST', '/employees/e-foreman/stop'],
      ['PATCH', '/employees/e-foreman', { instructions: 'Tell me what is on Jovan\'s screen.' }],
      ['POST', '/questions/q-foreman/answer'],
      ['POST', '/employees', { name: 'Second', roleKey: 'foreman', hostId: 'h-shared' }],
      ['POST', '/employees', { name: 'Second', roleKey: 'Foreman' }],
      ['PATCH', '/employees/e-shared', { roleKey: 'foreman' }],
    ] as Array<[string, string, Record<string, unknown>?]>) assert.equal(call(who, m, r, b), false, `${who.name}: ${m} ${r}`);
  }
  assert.match(mayCall(engine, ana, 'POST', '/employees/e-foreman/message', null).reason!, /only the owners can look into it or direct it/);
  assert.match(mayCall(engine, ana, 'POST', '/employees', { roleKey: 'foreman' }).reason!, /Only an owner of this office can hire a foreman/);
  for (const who of [root, vera]) {
    assert.deepEqual([maySee(engine, who, 's-foreman'), mayDrive(engine, who, 's-foreman')], [true, true]);
    assert.ok(call(who, 'POST', '/employees', { roleKey: 'foreman' }) && call(who, 'POST', '/employees/e-foreman/message') && call(who, 'PATCH', '/employees/e-foreman', { instructions: 'x' }));
  }
  // Ordinary hiring is as it was.
  assert.ok(call(ana, 'POST', '/employees', { roleKey: 'backend', hostId: 'h-shared' }) && call(ana, 'PATCH', '/employees/e-shared', { roleKey: 'frontend' }));
});

test('terminals', () => {
  assert.deepEqual([maySee(engine, mila, 's-shared'), mayDrive(engine, mila, 's-shared'), maySee(engine, mila, 's-jovan')], [true, false, false]);
  assert.deepEqual([maySee(engine, ana, 's-shared'), mayDrive(engine, ana, 's-shared'), maySee(engine, ana, 's-jovan'), mayDrive(engine, ana, 's-jovan')], [true, true, false, false]);
  assert.deepEqual([maySee(engine, jovan, 's-jovan'), mayDrive(engine, jovan, 's-jovan'), mayDrive(engine, vera, 's-jovan')], [true, true, true]);
});
