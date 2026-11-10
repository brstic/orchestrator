import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OWNERS_ONLY, allowed, eventFor, mayCall, mayDrive, mayReadMessage, mayReadQuestion, maySee, memberOf, outcomesScopeFor, stateFor, type Who } from '../src/access.ts';

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

test('what is said on a member’s own computer is theirs and the owners’; of the foreman’s rounds everyone gets the outline only', () => {
  const ev = (type: string, employeeId: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id: `${type}-${employeeId}`, seq: 1, ts: '2026-11-10T10:00:00.000Z', type, source: { kind: 'server' }, correlationId: null, hostId: null, sessionId: null, employeeId, taskId: null, projectId: null, summary: `about ${employeeId}`, data, ...extra }) as any;
  const turn = (id: string) => ev('agent.turn_finished', id, { lastMessage: 'secret reply' });
  assert.deepEqual([root, vera, jovan, ana, mila].map((who) => !!eventFor(engine, who, turn('e-jovan'))), [true, true, true, false, false]);
  assert.deepEqual([jovan, ana, mila].map((who) => !!eventFor(engine, who, turn('e-shared'))), [true, true, true]);
  assert.equal(eventFor(engine, ana, ev('host.offline', 'x', {}, { employeeId: null, hostId: 'h-jovan' })), null, 'also by machine');
  // The foreman: where it is, for everyone; what the round is about, for owners.
  const started = ev('foreman.round.started', 'e-foreman', { roundId: 'r1', reason: 'attention', counts: { question: 1 }, items: [{ kind: 'question', text: 'Jovan’s employee asks: which key?' }] });
  assert.equal(eventFor(engine, vera, started), started);
  for (const who of [jovan, ana, mila]) assert.deepEqual(eventFor(engine, who, started)!.data, { roundId: 'r1', reason: 'attention', counts: { question: 1 } });
  const visit = ev('foreman.visit', 'e-foreman', { fromEmployeeId: 'e-foreman', toEmployeeId: 'e-jovan', roundId: 'r1', action: 'answer', answer: 'use the staging key' }, { sessionId: 's-jovan', projectId: 'p-jovan' });
  const seen = eventFor(engine, mila, visit)!;
  assert.deepEqual([seen.data.toEmployeeId, seen.data.action, 'answer' in seen.data, seen.sessionId, seen.projectId], ['e-jovan', 'answer', false, null, null]);
  const finished = ev('foreman.round.finished', 'e-foreman', { roundId: 'r1', summary: 'told Lola the key' });
  assert.ok(!JSON.stringify(eventFor(engine, ana, finished)).includes('told Lola'));
  assert.equal(eventFor(engine, ana, ev('foreman.escalated', 'e-foreman', { text: 'x' })), null, 'the rest of what it does is the owners’');
  // Messages and questions.
  const msg = (to: string, from: { kind: string; id: string | null }) => ({ id: 'm', toEmployeeId: to, from: { ...from, name: 'x' } }) as any;
  const reads = (m: any) => [vera, jovan, ana, mila].map((who) => mayReadMessage(engine, who, m));
  assert.deepEqual(reads(msg('e-jovan', { kind: 'owner', id: null })), [true, true, false, false], 'to a member’s employee');
  assert.deepEqual(reads(msg('e-jovan', { kind: 'employee', id: 'e-foreman' })), [true, true, false, false], 'what the foreman told a member’s employee is that member’s to read');
  assert.deepEqual(reads(msg('e-shared', { kind: 'employee', id: 'e-foreman' })), [true, true, true, true], 'and what it told a shared one is everyone’s');
  assert.deepEqual(reads(msg('e-foreman', { kind: 'owner', id: null })), [true, false, false, false], 'what is said to the foreman is the owners’');
  assert.deepEqual(reads(msg('e-shared', { kind: 'employee', id: 'e-jovan' })), [true, true, false, false], 'a member’s employee writing to a shared one');
  assert.deepEqual([vera, jovan, ana].map((who) => mayReadQuestion(engine, who, { employeeId: 'e-foreman' } as any)), [true, false, false]);
  const state = { events: [turn('e-jovan'), turn('e-shared'), started], messages: [msg('e-jovan', { kind: 'owner', id: null }), msg('e-shared', { kind: 'owner', id: null })], questions: [{ employeeId: 'e-jovan' }, { employeeId: 'e-shared' }], employees: ['kept'] } as any;
  const forAna = stateFor(engine, ana, state);
  assert.deepEqual([forAna.events.length, forAna.messages.length, forAna.questions.length, forAna.employees], [2, 1, 1, ['kept']]);
  assert.equal(stateFor(engine, vera, state), state);
});

test('the hi-fi plays for the whole office: everyone is told what is on, owners and colleagues switch it, the list of stations is the owners’', () => {
  for (const who of [root, vera, jovan, ana, mila]) assert.ok(call(who, 'GET', '/radio') && call(who, 'GET', '/radio/now'), `${who.name} may know what is playing`);
  for (const route of ['/radio/play', '/radio/stop']) assert.deepEqual([root, vera, jovan, ana, mila].map((who) => call(who, 'POST', route, { stationId: 'jazz' })), [true, true, true, true, false], route);
  assert.match(mayCall(engine, mila, 'POST', '/radio/play', { stationId: 'jazz' }).reason ?? '', /You are visiting this office/);
  // Stations are kept in the settings: adding one (an address every window will load) stays an owner's act.
  assert.deepEqual([vera, jovan, mila].map((who) => call(who, 'PATCH', '/settings', { radio: { stations: [] } })), [true, false, false]);
});

test('measured outcomes: everyone may ask, and what is on a member’s own computer is counted only for that member and the owners', async () => {
  const { outcomesReport } = await import('@orchestrator/orchestration');
  for (const who of [root, vera, jovan, ana, mila]) assert.ok(call(who, 'GET', '/growth/outcomes'), who.name);
  assert.ok(!call(mila, 'POST', '/growth/outcomes') && !call(ana, 'POST', '/growth/outcomes'));
  // Finished tasks as the office keeps them: one shared, two of Jovan's (one in his project, one that follows him by its assignee).
  const done = (id: string, projectId: string, assigneeId: string, day: number, failed = 0) => ({
    id, key: id.toUpperCase(), projectId, assigneeId, kind: 'bug', status: 'DONE', nudges: 0, attempts: failed, title: `Private title of ${id}`,
    friction: { failedVerifications: failed, reviewRejections: 0, mergeConflicts: 0, blockers: 0, questions: 0, denials: 0 },
    evidence: { summary: 'done', verification: null }, startedAt: `2026-11-0${day}T09:00:00.000Z`, completedAt: `2026-11-0${day}T11:00:00.000Z`, updatedAt: `2026-11-0${day}T11:00:00.000Z`,
  }) as any;
  const tasks = [done('t-shared', 'p-shared', 'e-shared', 2), done('t-jovan', 'p-jovan', 'e-jovan', 3, 2), done('t-loose', 'p-nohost', 'e-jovan', 4, 1)];
  const lesson = (id: string, scope: string, employeeId: string | null, projectId: string | null) => ({ id, scope, employeeId, projectId, text: employeeId || projectId === 'p-jovan' ? `Use the staging key from the vault (${id})` : `Run the tests before completing (${id})`, appliesWhen: '', source: 'retrospective', evidence: [], status: 'active', authoredBy: { kind: 'employee', id: employeeId, name: 'x' }, appliedCount: 0, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }) as any;
  const lessons = [lesson('l-company', 'company', null, null), lesson('l-shared', 'project', null, 'p-shared'), lesson('l-jovan-project', 'project', null, 'p-jovan'), lesson('l-jovan-own', 'employee', 'e-jovan', null), lesson('l-foreman', 'employee', 'e-foreman', null)];
  const applied = (id: string, projectId: string | null, employeeId: string | null, action: any) => ({ id, kind: 'allow_rule', title: `Change ${id}`, rationale: '', evidence: [], projectId, employeeId, action, status: 'applied', dedupeKey: id, createdAt: '2026-11-01T00:00:00.000Z', decidedAt: '2026-11-01T12:00:00.000Z' }) as any;
  const improvements = [applied('i-shared', 'p-shared', null, { type: 'project.policy.allow', projectId: 'p-shared', rule: 'Bash(ls:*)' }), applied('i-jovan', 'p-jovan', null, { type: 'project.policy.allow', projectId: 'p-jovan', rule: 'Bash(ls:*)' }), applied('i-jovan-autonomy', null, 'e-jovan', { type: 'employee.autonomy', employeeId: 'e-jovan', level: 'standard' })];
  const names = { project: (id: string) => id, employee: (id: string) => id };
  const reportFor = (who: Who) => outcomesReport({ tasks, questions: [], lessons, improvements, names, scope: outcomesScopeFor(engine, who), now: Date.parse('2026-11-10T00:00:00.000Z') });
  const seen = (who: Who) => {
    const r = reportFor(who);
    return { tasks: r.tasks, employees: r.trends.byEmployee.map((x) => x.key).sort(), projects: r.trends.byProject.map((x) => x.key).sort(), lessons: r.lessons.map((l) => l.lessonId), improvements: r.improvements.map((i) => i.improvementId), firstPassRate: r.trends.overall.firstPassRate };
  };
  const everything = { tasks: 3, employees: ['e-jovan', 'e-shared'], projects: ['p-jovan', 'p-nohost', 'p-shared'], lessons: ['l-company', 'l-shared', 'l-jovan-project', 'l-jovan-own', 'l-foreman'], improvements: ['i-shared', 'i-jovan', 'i-jovan-autonomy'], firstPassRate: 0.333 };
  assert.equal(outcomesScopeFor(engine, root), null);
  assert.equal(outcomesScopeFor(engine, vera), null);
  assert.deepEqual(seen(vera), everything);
  // Jovan sees the office's and his own — everything here except what is the foreman's.
  assert.deepEqual(seen(jovan), { ...everything, lessons: everything.lessons.filter((l) => l !== 'l-foreman') });
  // A colleague and a visitor: only what is shared. Jovan's failures are not in their figures, his lessons and changes not in their lists.
  for (const who of [ana, mila]) {
    assert.deepEqual(seen(who), { tasks: 1, employees: ['e-shared'], projects: ['p-shared'], lessons: ['l-company', 'l-shared'], improvements: ['i-shared'], firstPassRate: 1 }, who.name);
    const text = JSON.stringify(reportFor(who));
    assert.ok(!/e-jovan|p-jovan|p-nohost|t-jovan|t-loose|l-jovan|i-jovan|e-foreman|vault|Private title/i.test(text), `${who.name}: nothing of Jovan's computer leaks`);
  }
  // The company lesson is judged, for Ana, from the one task she may see.
  assert.deepEqual([reportFor(ana).lessons[0]!.given, reportFor(vera).lessons[0]!.given], [1, 3]);
});
