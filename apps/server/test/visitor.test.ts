import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventFor, mayCall, maySee, shownTo, stateFor, type Who } from '../src/access.ts';

/**
 * What a visitor is sent. A visitor is in the office to look at it: who is here, who works on what, how the work
 * stands. Not which Claude runs, where things are on the machines, what is said, or what it costs — and none of that
 * may reach their browser, whatever the page shows.
 */
const table = <T extends { id: string }>(rows: T[]) => ({ get: (id: string) => rows.find((r) => r.id === id), all: () => rows });
const SECRET = 'SECRET';

const host = (id: string, memberId: string | null) => ({
  id, name: id, status: 'online', enrolledAt: 't', lastSeenAt: 't', revokedAt: null, local: false, memberId, memberName: memberId, room: { title: 'Room' }, ownerId: null, ownerName: null,
  info: { hostname: `${SECRET}-box`, user: `${SECRET}-user`, platform: 'linux', arch: 'x64', agentVersion: `${SECRET}-1`, tmuxVersion: '3', claudeVersion: `${SECRET}-2`, cpus: 4, totalMemBytes: 1 },
  resources: { ts: 't', cpuPercent: 1, loadAvg1: 1, memUsedBytes: 1, memTotalBytes: 1, sessionCount: 1, processes: [{ sessionId: 's', pid: 1, alive: true, command: `${SECRET} claude` }] },
  claudeAccounts: [`/home/${SECRET}/.claude-b`],
});
const employee = (id: string, hostId: string, roleKey = 'backend') => ({
  id, name: `Name ${id}`, title: 'Engineer', department: 'Engineering', roleKey, specialization: '', skills: ['ts'], appearance: {}, style: 'concise', hostId, projectId: 'p-shared', alsoProjectIds: [], deskId: 'd1', xp: 3, level: 1, badges: [], stats: {}, createdAt: 't', archived: false, schedule: {}, executionMode: 'interactive',
  model: `${SECRET}-model`, effort: 'high', claudeConfigDir: `/${SECRET}/.claude`, workingDir: `/srv/${SECRET}`, instructions: `${SECRET} instructions`, allowedTools: [`Bash(${SECRET})`], disallowedTools: [`Edit(${SECRET})`], autonomy: 'unrestricted', captureSkills: [{ skill: SECRET }], captureOnboarded: [SECRET],
});
const session = (id: string, hostId: string, employeeId: string) => ({
  id, employeeId, hostId, origin: 'managed', mode: 'interactive', status: 'running', activity: 'working', activityDetail: 'Editing', activitySince: 't', inTurn: true, control: 'AGENT_CONTROLLED', controllerId: null, capabilities: {}, cols: 80, rows: 24, startedAt: 't', endedAt: null, lastEventAt: 't',
  tmuxSession: `orch-${SECRET}`, tmuxPane: `%${SECRET}`, cwd: `/srv/${SECRET}`, repoRoot: `/srv/${SECRET}`, branch: `${SECRET}-branch`, claudeSessionId: SECRET, permissionMode: `${SECRET}-mode`, claudeConfigDir: `/${SECRET}`, model: `${SECRET}-model`, effort: 'high', pid: 4242, usage: { inputTokens: 1, costUsdEstimate: 1, note: SECRET }, exitReason: SECRET,
});
const project = (id: string, hostId: string | null) => ({
  id, name: `Project ${id}`, description: 'What it is', color: '#fff', status: 'active', hostId, milestones: [], deliveredAt: null, createdAt: 't', workspace: 'worktrees', ownerEmployeeId: null, verifyTimeoutSec: 60,
  goals: SECRET, requirements: SECRET, docs: SECRET, repoPath: `/srv/${SECRET}`, baseBranch: `${SECRET}-main`, integrationBranch: `${SECRET}-int`, verifyCommand: `${SECRET} test`, extraRepos: [{ name: 'x', path: `/srv/${SECRET}` }], integration: { lastTest: { outputTail: SECRET } },
  policy: { allow: [SECRET], deny: [SECRET], highRiskPatterns: [SECRET], autoAssign: true, requireReview: true, autoMerge: false },
});
const task = (id: string, projectId: string, assigneeId: string | null) => ({
  id, key: id.toUpperCase(), projectId, title: `Title ${id}`, kind: 'feature', priority: 'normal', status: 'IN_PROGRESS', assigneeId, roleHint: null, dependsOn: [], requiresReview: false, reviewerId: null, reviewOf: null, released: true, nudges: 0, attempts: 1, createdAt: 't', updatedAt: 't', startedAt: 't', completedAt: null, delivery: 'none',
  description: SECRET, acceptance: SECRET, branch: `${SECRET}-b`, worktree: `/srv/${SECRET}`, baseSha: SECRET, repoRoot: `/srv/${SECRET}`, touched: [`${SECRET}.ts`], attachments: [{ id: 'a', name: SECRET }], verifyCommand: SECRET, blockedReason: SECRET, createdBy: `member:${SECRET}`,
  friction: { failedVerifications: 1, reviewRejections: 0, mergeConflicts: 0, blockers: 0, questions: 0, denials: 0 }, progress: { percent: 40, note: SECRET, ts: 't' },
  evidence: { summary: SECRET, reportedTests: SECRET, commits: [{ sha: '1', subject: SECRET, author: SECRET, ts: 't' }], filesChanged: [SECRET], diffStat: SECRET, verification: { outputTail: SECRET }, review: null, merge: null },
  history: [{ ts: 't', note: SECRET }],
  // What is said on a task, and whatever a task is given later: a visitor is sent the fields named for them, not "all but".
  comments: [{ id: 'c', ts: 't', from: { kind: 'employee', id: 'e-shared', name: 'A' }, body: SECRET, kind: 'note', mentions: [] }], waitingFor: { kind: 'answer', commentId: SECRET }, somethingAddedLater: SECRET,
});

const hosts = [host('h-shared', null), host('h-jovan', 'jovan')];
const employees = [employee('e-shared', 'h-shared'), employee('e-jovan', 'h-jovan'), employee('e-foreman', 'h-shared', 'foreman')];
const sessions = [session('s-shared', 'h-shared', 'e-shared'), session('s-jovan', 'h-jovan', 'e-jovan')];
const projects = [project('p-shared', 'h-shared'), project('p-jovan', 'h-jovan')];
const tasks = [task('t-shared', 'p-shared', 'e-shared'), task('t-jovan', 'p-jovan', 'e-jovan')];
const settings = {
  tv: { bookmarks: [] }, radio: { stations: [] }, companyName: 'Acme', ownerName: 'Boss', gamification: true, nlFallback: true, selfImprovement: { enabled: true }, foreman: { enabled: true }, workersInheritMcp: true, employeesManageBoard: true, employeesBrowser: true, longMemory: true,
  whipApproves: true, accountFailover: true, autoAsksHighRisk: false, unrestrictedAsksHighRisk: false, projectZones: true, approachZoom: true, sleepAfterMinutes: 45, quality: 'high', keybindings: { tasks: 'T' }, lastSeenAt: 'yesterday',
};
const event = (over: Record<string, unknown>) => ({ id: 'ev', seq: 1, ts: 't', type: 'agent.message', source: { kind: 'hook', hostId: 'h-shared', detail: SECRET }, correlationId: SECRET, hostId: 'h-shared', sessionId: 's-shared', employeeId: 'e-shared', taskId: 't-shared', projectId: 'p-shared', summary: `${SECRET} said`, data: { text: SECRET, fromEmployeeId: 'e-shared', toEmployeeId: 'e-jovan' }, ...over });

const engine = {
  hosts: { isClosed: () => false, closedMembers: () => [] },
  core: { hosts: table(hosts), employees: table(employees), sessions: table(sessions), projects: table(projects), tasks: table(tasks), questions: table([{ id: 'q-shared', employeeId: 'e-shared' }]), routines: table([{ id: 'r-shared', employeeId: 'e-shared' }]) },
} as any;

const state = {
  serverTime: 't', settings, layout: { rooms: [] }, hosts, employees, sessions, projects, tasks,
  questions: [{ id: 'q-shared', employeeId: 'e-shared', text: SECRET }],
  messages: [{ id: 'm', toEmployeeId: 'e-shared', from: { kind: 'owner' }, body: SECRET }],
  collabs: [{ id: 'c', body: SECRET }],
  notifications: [{ id: 'n', title: SECRET, body: `sign-in from ${SECRET}`, employeeId: 'e-jovan' }],
  meetings: [{ id: 'mt', projectId: 'p-shared', topic: 'Planning', context: SECRET, status: 'proposals', facilitatorId: 'e-shared', participantIds: ['e-shared'], absent: [], contributions: [{ id: 'x', body: SECRET }], decisionDoc: SECRET, generatedTaskIds: ['t-shared'], createdAt: 't', roundStartedAt: null, concludedAt: null }],
  artifacts: [{ id: 'a', title: SECRET, content: SECRET }],
  milestones: [{ key: 'first', title: 'First task' }],
  company: { tasksCompleted: 3 },
  lessons: [{ id: 'l', text: SECRET }],
  improvements: [{ id: 'i', title: SECRET }],
  performance: [{ employeeId: 'e-shared', note: SECRET }],
  routines: [{ id: 'r-shared', employeeId: 'e-shared', instruction: SECRET }],
  events: [event({}), event({ id: 'ev2', type: 'account.switched', summary: `switched to ${SECRET}@example.com` }), event({ id: 'ev3', type: 'vault.used', summary: `used ${SECRET}` }), event({ id: 'ev4', hostId: 'h-jovan', employeeId: 'e-jovan', sessionId: 's-jovan' })],
} as any;

const mila: Who = { kind: 'guest', id: 'mila', name: 'Mila', role: 'visitor' };
const ana: Who = { kind: 'guest', id: 'ana', name: 'Ana', role: 'colleague' };
const root: Who = { kind: 'owner', id: 'owner', name: 'Root', role: 'owner' };
const call = (who: Who, method: string, route: string) => mayCall(engine, who, method, route, null).ok;

test('the state a visitor is sent holds nothing of the machines, the Claude that runs, what is said, or the cost', () => {
  const seen = stateFor(engine, mila, state);
  assert.ok(!JSON.stringify(seen).includes(SECRET), `leaks: ${[...JSON.stringify(seen).matchAll(/"([a-zA-Z]+)":[^,{]*SECRET/g)].map((m) => m[1]).join(', ')}`);
  // …and the people who work here still get it all.
  assert.equal(stateFor(engine, root, state), state);
  assert.deepEqual(stateFor(engine, ana, state).employees, employees);
});

test('what a visitor does see: who is here, what they are, what state they are in, and how the shared work stands', () => {
  const seen = stateFor(engine, mila, state);
  // Everyone is in the scene — members' own employees too, and the foreman — as a person at a desk.
  assert.deepEqual(seen.employees.map((e) => [e.id, e.name, e.title, e.roleKey, e.deskId, e.projectId]), employees.map((e) => [e.id, e.name, e.title, e.roleKey, e.deskId, e.projectId]));
  assert.deepEqual(seen.sessions.map((s) => [s.id, s.employeeId, s.hostId, s.status, s.activity]), sessions.map((s) => [s.id, s.employeeId, s.hostId, s.status, s.activity]));
  // Machines only as the rooms they make: whose they are and whether they are there.
  assert.deepEqual(seen.hosts.map((h) => [h.id, h.status, h.memberId, h.memberName, h.room?.title, h.info, h.resources]), hosts.map((h) => [h.id, 'online', h.memberId, h.memberName, 'Room', null, null]));
  // Shared projects by name; a member's own project is theirs.
  assert.deepEqual(seen.projects.map((p) => [p.id, p.name, p.description, p.status, p.repoPath]), [['p-shared', 'Project p-shared', 'What it is', 'active', null]]);
  // Shared tasks: the title and where it stands. A member's own tasks: not at all.
  assert.deepEqual(seen.tasks.map((t) => [t.id, t.key, t.title, t.status, t.assigneeId, t.projectId, t.progress.percent]), [['t-shared', 'T-SHARED', 'Title t-shared', 'IN_PROGRESS', 'e-shared', 'p-shared', 40]]);
  assert.deepEqual(seen.meetings.map((m) => [m.id, m.topic, m.status, m.participantIds, m.contributions]), [['mt', 'Planning', 'proposals', ['e-shared'], []]]);
  for (const k of ['questions', 'messages', 'collabs', 'notifications', 'artifacts', 'lessons', 'improvements', 'performance', 'routines'] as const) assert.deepEqual(seen[k], [], k);
  // The office itself: its name, the scene, the keys — not the switches that say how employees are held.
  assert.deepEqual([seen.settings.companyName, seen.settings.keybindings, seen.settings.quality, seen.settings.lastSeenAt], ['Acme', { tasks: 'T' }, 'high', null]);
  assert.deepEqual([seen.settings.autoAsksHighRisk, seen.settings.unrestrictedAsksHighRisk], [true, true], 'a visitor is not told which gates are off');
  assert.deepEqual([seen.milestones, seen.company, seen.layout], [state.milestones, state.company, state.layout]);
});

test('events reach a visitor in outline: that something happened and to whom, so the scene moves — never the words', () => {
  const seen = stateFor(engine, mila, state).events;
  assert.deepEqual(seen.map((e) => e.id), ['ev', 'ev2', 'ev3'], "what happens on a member's own computer stays theirs");
  assert.deepEqual(seen[0], { id: 'ev', seq: 1, ts: 't', type: 'agent.message', source: { kind: 'hook' }, correlationId: null, hostId: 'h-shared', sessionId: 's-shared', employeeId: 'e-shared', taskId: 't-shared', projectId: 'p-shared', summary: '', data: { fromEmployeeId: 'e-shared', toEmployeeId: 'e-jovan' } });
  assert.equal(eventFor(engine, ana, state.events[0]), state.events[0], 'a colleague reads it whole');
});

test('what changes while a visitor is here is sent the same way', () => {
  assert.ok(!JSON.stringify(shownTo(engine, mila, 'employee', employees[0])).includes(SECRET));
  assert.ok(!JSON.stringify(shownTo(engine, mila, 'session', sessions[0])).includes(SECRET));
  assert.ok(!JSON.stringify(shownTo(engine, mila, 'host', hosts[0])).includes(SECRET));
  assert.ok(!JSON.stringify(shownTo(engine, mila, 'task', tasks[0])).includes(SECRET));
  assert.ok(!JSON.stringify(shownTo(engine, mila, 'settings', settings)).includes('yesterday'));
  assert.equal(shownTo(engine, mila, 'task', tasks[1]), null, "a member's own task");
  assert.equal(shownTo(engine, mila, 'project', projects[1]), null, "a member's own project");
  for (const kind of ['notification', 'collab', 'artifact', 'lesson', 'improvement', 'performance', 'question', 'message', 'routine'] as const) assert.equal(shownTo(engine, mila, kind, { id: 'x', employeeId: 'e-shared', toEmployeeId: 'e-shared', from: { kind: 'owner' } }), null, kind);
  // Taking something away is told to everyone: there is nothing in it but which.
  assert.deepEqual(shownTo(engine, mila, 'task', { id: 't-jovan' }, 'remove'), { id: 't-jovan' });
  // Those who work here get things as they are.
  assert.equal(shownTo(engine, ana, 'employee', employees[0]), employees[0]);
  assert.equal(shownTo(engine, root, 'notification', state.notifications[0]), state.notifications[0]);
});

test('requests: a visitor watches the shared terminals; documents, code, accounts and the record are for those who work here', () => {
  // The owners' word (2026-11-12): a visitor may go on watching the shared terminals.
  assert.ok(maySee(engine, mila, 's-shared') && call(mila, 'GET', '/sessions/s-shared/history'));
  assert.ok(!maySee(engine, mila, 's-jovan'));
  for (const r of ['/state', '/me', '/people', '/roles', '/events', '/radio/now', '/layout/capacity', '/employees/e-shared/xp', '/memory']) assert.ok(call(mila, 'GET', r), r);
  for (const r of ['/usage', '/employees/e-shared/docs', '/employees/e-shared/docs/file', '/employees/e-shared/git', '/tasks/t-shared/git', '/tasks/t-shared/attachments/a1', '/projects/p-shared/integration', '/routines', '/growth/outcomes', '/growth/log', '/performance']) {
    assert.ok(!call(mila, 'GET', r), `visitor: ${r}`);
    assert.ok(call(ana, 'GET', r), `colleague: ${r}`);
  }
  assert.match(mayCall(engine, mila, 'GET', '/usage', null).reason ?? '', /for the people who work here/);
});
