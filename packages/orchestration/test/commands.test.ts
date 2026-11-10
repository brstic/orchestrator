import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '@orchestrator/database';
import { Engine, inferKind, type AgentLink } from '../src/index.ts';

/** An engine with no hosts: enough to exercise planning, validation and queries. */
const offline: AgentLink = { rpc: () => Promise.reject(new Error('offline')), isOnline: () => false, respondHook: () => false, disconnect: () => undefined };
let eng: Engine;
const id: Record<string, string> = {};

before(async () => {
  eng = new Engine({ store: new Store(':memory:'), agents: offline, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  id.a = (await eng.tasks.createProject({ name: 'Project A' })).id;
  id.b = (await eng.tasks.createProject({ name: 'Project B' })).id;
  for (const [name, role, project] of [['Alex', 'backend', 'a'], ['Sarah', 'frontend', 'a'], ['Mike', 'qa', 'a'], ['Ava', 'architect', 'a'], ['Ben', 'backend', 'b']] as const) {
    id[name] = eng.employees.create({ name, roleKey: role, projectId: id[project] }).id;
  }
});

const plan = (s: string) => eng.commands.plan(s);
const op = (s: string) => {
  const p = plan(s);
  assert.deepEqual(p.problems, [], `"${s}" should be understood`);
  return p.operations.map((o) => o.operation);
};

test("the owner's example instructions become explicit operations", () => {
  const fix = op('Assign Alex to fix the authentication bug.')[0] as any;
  assert.deepEqual([fix.op, fix.assigneeId, fix.kind, fix.title, fix.projectId, fix.start], ['task.create', id.Alex, 'bug', 'Fix the authentication bug', id.a, true]);

  const mobile = op('Have Sarah inspect the frontend and improve mobile responsiveness.')[0] as any;
  assert.deepEqual([mobile.op, mobile.assigneeId, mobile.kind], ['task.create', id.Sarah, 'feature']);

  // "everything Alex changed" is resolved against Alex's actual recorded work.
  const done = eng.tasks.createTask({ projectId: id.a!, title: 'Token refresh', assigneeId: id.Alex });
  done.status = 'DONE';
  done.branch = 'orch/alex/t-1-token-refresh';
  done.evidence.filesChanged = ['src/auth.ts'];
  eng.core.put('task', done);
  const testIt = op('Get Mike to test everything Alex changed.')[0] as any;
  assert.deepEqual([testIt.op, testIt.assigneeId, testIt.kind], ['task.create', id.Mike, 'test']);
  assert.match(testIt.description, /Alex's recent work:[\s\S]*Token refresh[\s\S]*orch\/alex\/t-1-token-refresh[\s\S]*src\/auth\.ts/);

  assert.deepEqual(op('Find an available backend engineer.'), [{ op: 'query.available', role: 'backend' }]);
  assert.deepEqual(op('Show me everyone who needs my attention.'), [{ op: 'query.attention' }]);
  assert.equal(op('Summarize what happened while I was away.')[0]!.op, 'query.summary');

  assert.deepEqual(op('Pause work on Project A and move the team to Project B.'), [
    { op: 'project.pause', projectId: id.a },
    { op: 'project.move_team', fromProjectId: id.a, toProjectId: id.b },
  ]);
});

test('other phrasings: messages, pause/resume, reports, navigation, direct address', () => {
  assert.deepEqual(op('Tell Sarah that the API contract changed'), [{ op: 'employee.message', employeeId: id.Sarah, body: 'the API contract changed' }]);
  assert.deepEqual(op('message Alex: ping me when done'), [{ op: 'employee.message', employeeId: id.Alex, body: 'ping me when done' }]);
  assert.deepEqual(op('pause Alex'), [{ op: 'employee.pause', employeeId: id.Alex }]);
  assert.deepEqual(op('resume Alex'), [{ op: 'employee.resume', employeeId: id.Alex }]);
  assert.deepEqual(op('pause Project B'), [{ op: 'project.pause', projectId: id.b }]);
  assert.deepEqual(op('get a status report from Mike'), [{ op: 'employee.report', employeeId: id.Mike }]);
  assert.deepEqual(op('go to Sarah'), [{ op: 'ui.focus', employeeId: id.Sarah }]);
  const direct = op('Alex, implement the new authentication system, add tests, and prepare the changes for review')[0] as any;
  assert.deepEqual([direct.op, direct.assigneeId], ['task.create', id.Alex]);
  const urgent = op('ask Ben to fix the crash on startup asap')[0] as any;
  assert.deepEqual([urgent.priority, urgent.projectId, urgent.kind], ['urgent', id.b, 'bug']);
});

test('planning needs a planner, and instructions that cannot be resolved are refused, not guessed', () => {
  const p = op('Build the customer authentication and management system in Project A. Split the work between backend, frontend, QA, and security. Ask me only when necessary.')[0] as any;
  assert.deepEqual([p.op, p.projectId, p.plannerId], ['project.plan', id.a, id.Ava]);

  for (const bad of ['Assign Zoe to fix the bug', 'pause the moon', 'do the thing', '']) {
    const r = plan(bad);
    assert.equal(r.operations.length, 0, `"${bad}" must not produce operations`);
    assert.ok(r.problems.length > 0);
  }
  // No running sessions → a meeting cannot be held, and the plan says so.
  const meeting = plan('Ask the whole team to review the architecture');
  assert.equal(meeting.operations.length, 0);
  assert.match(meeting.problems[0]!, /at least two employees with running sessions/);
});

test('kind inference', () => {
  assert.equal(inferKind('fix the login crash'), 'bug');
  assert.equal(inferKind('write tests for the parser'), 'test');
  assert.equal(inferKind('investigate why startup is slow'), 'research');
  assert.equal(inferKind('investigate and fix the slow startup'), 'bug');
  assert.equal(inferKind('review the payment module'), 'review');
  assert.equal(inferKind('update the README'), 'docs');
  assert.equal(inferKind('audit the auth flow for security vulnerabilities'), 'security');
  assert.equal(inferKind('add a dark mode toggle'), 'feature');
});

test('queries answer from recorded state only', async () => {
  const attention = eng.commands.attention();
  assert.equal(attention.title, 'Nothing needs your attention right now');
  const t = eng.tasks.createTask({ projectId: id.a!, title: 'Stuck thing', assigneeId: id.Sarah });
  t.status = 'BLOCKED';
  t.blockedReason = 'missing credentials';
  eng.core.put('task', t);
  const after = eng.commands.attention();
  assert.ok(after.lines.some((l) => /BLOCKED — T-\d+ \(Sarah\): missing credentials/.test(l)));
  assert.deepEqual(after.employeeIds, [id.Sarah]);
  // Nobody can take work while every host is offline, and the answer says why.
  const free = eng.commands.available('backend');
  assert.equal(free.employeeIds!.length, 0);
  assert.match(free.lines[0]!, /host offline/);
  const res = await eng.commands.execute(plan('Tell Sarah that standup is at ten'));
  assert.equal(res.executed[0]!.ok, true);
  assert.equal(eng.core.messages.all().at(-1)!.delivery.status, 'queued', 'queued honestly: there is no session to deliver to');
  const summary = eng.commands.summary(null);
  assert.match(summary.lines[0]!, /0 tasks completed/);
  await assert.rejects(eng.commands.execute({ input: 'x', interpretedBy: 'rules', operations: [], problems: ['nope'] }));
});

test('the trust prompt is answered from what is on screen, never blind', async () => {
  const { trustPromptKeys } = await import('../src/index.ts');
  // Claude Code 2.1.x: the default selection is "No, exit".
  assert.deepEqual(trustPromptKeys([' Quick safety check: Is this a project you created or one you trust?', ' \x1b[1m❯ No, exit\x1b[0m', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel']), ['Down', 'Enter']);
  // Older layout: "Yes" first and already selected.
  assert.deepEqual(trustPromptKeys([' Do you trust the files in this folder?', ' ❯ 1. Yes, proceed', '   2. No, exit']), ['Enter']);
  assert.deepEqual(trustPromptKeys(['   Yes, I trust this folder', ' ❯ No, exit']), ['Up', 'Enter']);
  assert.equal(trustPromptKeys(['$ ls', 'README.md']), null, 'not a prompt: press nothing');
  assert.equal(trustPromptKeys([' ❯ No, exit']), null);
});

test('people are seated with their project: colleagues share a pod, another project gets its own', () => {
  const pod = (name: string) => eng.core.employees.require(id[name]!).deskId!.replace(/-[a-z]$/, '');
  // Alex, Sarah, Mike and Ava were hired into project A one after another; Ben into project B.
  assert.deepEqual([...new Set(['Alex', 'Sarah', 'Mike', 'Ava'].map(pod))].length, 1, 'project A fills one pod');
  assert.notEqual(pod('Ben'), pod('Alex'), 'project B does not sit in project A\'s pod');
  // A fifth person on A: their pod is full, so they sit nearby — not among project B.
  const fifth = eng.employees.create({ name: 'Fay', roleKey: 'frontend', projectId: id.a });
  const fayPod = fifth.deskId!.replace(/-[a-z]$/, '');
  assert.notEqual(fayPod, pod('Ben'));
  // Someone moved to another project by the owner goes to sit with the new colleagues…
  const moved = eng.employees.update(id.Ben!, { projectId: id.a });
  assert.equal(moved.deskId!.replace(/-[a-z]$/, ''), fayPod, 'Ben joined the pod where project A still had room');
  // …unless the owner picked the desk.
  const free = eng.core.layout.desks.find((d) => !eng.core.employees.find((e) => e.deskId === d.id) && d.kind !== 'executive')!;
  const placed = eng.employees.update(id.Ben!, { projectId: id.b, deskId: free.id });
  assert.equal(placed.deskId, free.id);
  eng.employees.update(fifth.id, { archived: true });
});
