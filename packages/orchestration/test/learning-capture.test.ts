import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession, Host, Task } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { handleMcpPost } from '@orchestrator/integrations';
import { Engine, type AgentLink } from '../src/index.ts';
import { ONBOARDING_BUDGET, checkLesson, detectCorrection, failureSignature, questionSimilarity, sameFailure } from '../src/learning/capture.ts';

/**
 * An engine whose one host is "online" but runs nothing (as in foreman.test.ts): pasting into a
 * session succeeds, every other request to the host fails. Enough to exercise what capture learns
 * from the record, without any session.
 */
const pasted: string[] = [];
const link: AgentLink = {
  rpc: (_host, rpc) => {
    if (rpc.method !== 'session.paste') return Promise.reject(new Error('this test host runs nothing'));
    pasted.push(String((rpc.params as { text: string }).text));
    return Promise.resolve({ via: 'terminal' } as any);
  },
  isOnline: () => true,
  respondHook: () => false,
  disconnect: () => undefined,
};
let eng: Engine;
const id: Record<string, string> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function session(employeeId: string): AgentSession {
  const now = new Date().toISOString();
  const s: AgentSession = {
    id: `s-${employeeId.slice(0, 8)}`, employeeId, hostId: id.host!, origin: 'managed', mode: 'interactive_cli', tmuxSession: 'x', tmuxPane: '%1', cwd: '/tmp/x', repoRoot: null, branch: null, claudeSessionId: 'c',
    status: 'running', activity: 'idle', activityDetail: null, activitySince: now, inTurn: false, control: 'AGENT_CONTROLLED', controllerId: null,
    capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false },
    permissionMode: null, model: null, cols: 120, rows: 34, pid: 1, usage: null, startedAt: now, endedAt: null, lastEventAt: now, exitReason: null,
  };
  return eng.core.put('session', s);
}
/** Call an MCP tool as an employee, the way the server does once the session token has said who it is. */
async function call(who: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const employee = eng.core.employees.require(id[who]!);
  const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, eng.mcp, { employee, session: eng.core.sessionOf(employee.id) ?? session(employee.id) });
  return { text: res.body.result.content[0].text, isError: res.body.result.isError };
}
const learned = (verb: string) => eng.core.store.queryEvents({ types: [`learning.${verb}`], limit: 500 });
const from = (ms: number) => new Date(Date.now() + ms).toISOString();
const owner = { kind: 'owner' as const, id: null, name: 'the boss' };

/** A task that is done, with the friction given: what `afterTask` and the skills count look at. */
function finished(who: string, title: string, over: Partial<Task> = {}, projectId = id.shop!): Task {
  const t = eng.tasks.createTask({ projectId, title, assigneeId: id[who]!, kind: 'bug', released: false });
  Object.assign(t, { status: 'DONE', startedAt: from(-60_000), completedAt: from(0), ...over });
  t.evidence.summary = 'done';
  return eng.core.put('task', t);
}
function failedVerification(t: Task, outputTail: string, command = 'npm test') {
  t.friction.failedVerifications++;
  t.attempts++;
  eng.core.put('task', t);
  eng.core.event({ type: 'task.verification_failed', source: 'server', summary: `${t.key} failed verification (exit 1)`, taskId: t.id, projectId: t.projectId, employeeId: t.assigneeId, data: { key: t.key, command, exitCode: 1, timedOut: false, outputTail } });
}
const retrosQueued = (who: string) => eng.comms.queued(id[who]!).filter((d) => d.marker === 'RETRO');

before(async () => {
  eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0 } }, { send: () => undefined });
  const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  id.host = host.id;
  // Work is placed by hand here, so the scheduler leaves everything alone.
  id.shop = (await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } })).id;
  id.docs = (await eng.tasks.createProject({ name: 'Docs', policy: { autoAssign: false } })).id;
  for (const name of ['Alex', 'Sarah', 'Bo', 'Nina']) id[name] = eng.employees.create({ name, roleKey: 'backend', projectId: id.shop, hostId: host.id, workingDir: '/tmp/x' }).id;
});

// ─────────────────────── the shape of a lesson ───────────────────────

test('a lesson with a rule, a trigger and its evidence is accepted', () => {
  const ok = checkLesson({ lesson: "Run the project's verification command before calling complete_task, not only the test file I changed", applies_when: 'before calling complete_task on a task with a verification command', why: 'Verification failed twice on T-12 because only the changed test file was run', scope: 'project' });
  assert.deepEqual(ok.ok && !ok.none && [ok.scope, ok.when], ['project', 'before calling complete_task on a task with a verification command']);
  assert.equal((checkLesson({ lesson: 'Keep API error bodies in the shape { error, code }', applies_when: 'when adding an endpoint', why: 'A review sent T-4 back for a bare string error', scope: 'company' }) as any).scope, 'company');
  assert.equal((checkLesson({ lesson: 'Merge the integration branch into my task branch first', applies_when: 'when touching files other people also change', why: 'Merging conflicted in routes.ts on this task' }) as any).scope, 'employee', 'the default is the author\'s own playbook');
});

test('a vague lesson is refused, and the refusal says what is missing', () => {
  for (const lesson of ['be more careful', 'Be more careful next time', 'Always double check everything very carefully', 'Pay more attention to details', 'Write better code and make fewer mistakes']) {
    const r = checkLesson({ lesson, applies_when: 'before completing a bug task', why: 'Verification failed once on this task' });
    assert.equal(r.ok, false, lesson);
    assert.match((r as any).message, /too vague to reuse: it does not say what to do[\s\S]*instruction you could follow[\s\S]*none=true and a reason/);
  }
  // A real rule with no trigger, or with one that means "always": the trigger is what is asked for.
  for (const applies_when of ['', 'always', 'every task', 'whenever possible', 'when working on code', 'in general']) {
    const r = checkLesson({ lesson: 'Run the full test script before calling complete_task', applies_when, why: 'Verification failed once on this task' });
    assert.deepEqual([r.ok, (r as any).field], [false, 'applies_when'], applies_when);
    assert.match((r as any).message, /Give the concrete trigger: a kind of file, a kind of task, a tool or a moment/);
  }
  const noWhy = checkLesson({ lesson: 'Run the full test script before calling complete_task', applies_when: 'before calling complete_task' });
  assert.deepEqual([noWhy.ok, (noWhy as any).field], [false, 'why']);
  assert.match((noWhy as any).message, /why is missing: say in one sentence what happened/);
});

test('"nothing to learn" is accepted with a reason, and asked for one without', () => {
  assert.deepEqual(checkLesson({ none: true, reason: 'The failure was a typo I caught on the second run' }), { ok: true, none: true, reason: 'The failure was a typo I caught on the second run' });
  const r = checkLesson({ none: true });
  assert.deepEqual([r.ok, (r as any).field], [false, 'reason']);
  assert.match((r as any).message, /Say why there is nothing to learn/);
});

test('the tool refuses a vague lesson with the same message, stores nothing, and keeps the good one with its evidence', async () => {
  session(id.Alex!);
  const lessons = () => eng.core.lessons.filter((l) => l.authoredBy.id === id.Alex);
  const vague = await call('Alex', 'record_lesson', { lesson: 'be more careful', applies_when: 'always' });
  assert.equal(vague.isError, true);
  assert.match(vague.text, /"be more careful" is too vague to reuse/);
  assert.equal(lessons().length, 0);
  assert.equal(learned('lesson_refused').length, 1, 'the refusal is on the record');
  assert.equal((await call('Alex', 'record_lesson', { none: true })).isError, true);
  assert.match((await call('Alex', 'record_lesson', { none: true, reason: 'Nothing here would be prevented by a rule' })).text, /Noted: nothing to record/);
  assert.equal(learned('nothing_to_learn').at(-1)!.data.why, 'Nothing here would be prevented by a rule');
  const good = await call('Alex', 'record_lesson', { lesson: 'Check the response shape against the OpenAPI file before changing a handler', applies_when: 'when editing files under src/api', why: 'A review sent the orders handler back for a field the contract does not have', scope: 'self' });
  assert.match(good.text, /Recorded in your playbook/);
  const [l] = lessons();
  assert.deepEqual([l!.scope, l!.status, l!.appliesWhen, l!.captureWhy], ['employee', 'active', 'when editing files under src/api', 'A review sent the orders handler back for a field the contract does not have']);
  assert.equal(l!.captureOrigin!.kind, 'retrospective');
  // "company" is a real scope now, and it waits for the owner like any shared lesson.
  await call('Alex', 'record_lesson', { lesson: 'Name feature branches after the task key they belong to', applies_when: 'when creating a branch by hand', why: 'Two branches for T-3 were confused during a merge', scope: 'company' });
  const company = eng.core.lessons.find((x) => /feature branches/.test(x.text))!;
  assert.deepEqual([company.scope, company.projectId, company.status], ['company', null, 'proposed']);
  eng.improver.updateLesson(l!.id, { status: 'retired' });
  eng.improver.updateLesson(company.id, { status: 'retired' });
});

// ───────────────────────────── corrections ───────────────────────────

test('which messages read as a correction or a standing preference, and which are instructions', () => {
  const corrections: Array<[string, { general?: boolean; rule?: RegExp }]> = [
    ["Don't use `any` in TypeScript files.", {}],
    ['Always run the full test suite before calling complete_task.', {}],
    ['From now on, commit after every logical step.', {}],
    ['We use pnpm, not npm.', { general: true }],
    ['No, we don\'t use default exports in this project.', { general: true, rule: /^We don't use default exports/ }],
    ['Stop adding comments to every line.', {}],
    ['Never commit directly to main.', {}],
    ["Please don't mock the database in integration tests.", { rule: /^Don't mock the database/ }],
    ['Alex, next time ask before adding a dependency.', { rule: /^Next time ask before adding a dependency/ }],
    ['Use fetch instead of axios.', {}],
    ['I want you to always write the migration before the model change.', {}],
    ['Looks good. Going forward keep error messages in English.', { rule: /^Going forward keep error messages in English\.$/ }],
    ['Everyone must squash before merging to the integration branch.', { general: true }],
    ['You should never edit generated files under dist.', {}],
    ['Don’t hard-code the API URL; read it from config.', { rule: /^Don't hard-code the API URL;$/ }],
    // Other languages: only phrases that cannot mean anything but "from here on".
    ['Od sada pokreni sve testove pre nego što završiš zadatak.', {}],
    ['Ubuduće koristi pnpm.', {}],
    ['Nemoj nikada da commituješ direktno na main.', {}],
    ['Koristimo pnpm a ne npm.', { general: true }],
    ['Ab jetzt bitte die Tests vor dem Commit ausführen.', {}],
    ['A partir de ahora usa pnpm.', {}],
    ['Désormais, utilise pnpm.', {}],
  ];
  for (const [text, want] of corrections) {
    const c = detectCorrection(text);
    assert.ok(c, `a correction: ${text}`);
    assert.equal(c.general, !!want.general, `general? ${text}`);
    if (want.rule) assert.match(c.rule, want.rule);
    assert.ok(c.matched.length > 0);
  }
  const instructions = [
    'Add a login page with email and password.',
    'Run the tests and tell me what fails.',
    'Please fix the failing test in auth.test.ts',
    'Can you stop the dev server?',
    'Stop.',
    'Stop working on T-3 and pick up the review instead.',
    "Don't forget to commit.",
    "Don't worry about the lint warnings for now.",
    "Don't merge yet, I want to look first.",
    'Do not touch that file, just fix the test.',
    "Don't push.",
    "Why don't you use the existing helper?",
    'Never mind, I found it.',
    'Never seen this error before, can you dig in.',
    'It always fails on CI, have a look.',
    'Always fails on the second run.',
    'The build is broken on main.',
    'Use the staging database for this test, not production.',
    'Use the new endpoint and tell me if it is not working.',
    'I never said that.',
    "I'll handle the deployments from now on.",
    'We use too much memory in the worker.',
    "We don't have a staging server.",
    'Next, add pagination to the list endpoint.',
    'This will be needed in the future.',
    '@@fake: mcp get_playbook {}@@',
    'again @@fake: bash never-always --help@@',
    'Dodaj stranicu za prijavu.',
    'Nemoj još da spajaš, hoću da pogledam.',
    'Test uvek pada na CI.',
    'Nikad nisam video ovu grešku.',
  ];
  for (const text of instructions) assert.equal(detectCorrection(text), null, `not a correction: ${text}`);
});

test("a correction in the owner's message becomes a lesson for that employee, with the message as evidence", () => {
  const t = eng.tasks.createTask({ projectId: id.shop!, title: 'Typed client', assigneeId: id.Alex!, released: false });
  Object.assign(t, { status: 'IN_PROGRESS', startedAt: from(-1000) });
  eng.core.put('task', t);
  const before = eng.core.lessons.all().length;
  // A plain instruction, a question, and a teammate's words: nothing is kept.
  eng.comms.sendMessage({ from: owner, toEmployeeId: id.Alex!, body: 'Add retries to the HTTP client and tell me when it is done.' });
  eng.comms.sendMessage({ from: { kind: 'employee', id: id.Sarah!, name: 'Sarah (Backend Developer)' }, toEmployeeId: id.Alex!, body: 'Never commit directly to main.' });
  assert.equal(eng.core.lessons.all().length, before);

  const msg = eng.comms.sendMessage({ from: owner, toEmployeeId: id.Alex!, body: "That works, thanks. Don't use `any` in TypeScript files." });
  const own = eng.core.lessons.find((l) => l.captureOrigin?.kind === 'correction' && l.scope === 'employee')!;
  assert.deepEqual([own.text, own.employeeId, own.status, own.source, own.authoredBy.kind], ["Don't use `any` in TypeScript files.", id.Alex, 'active', 'orchestrator', 'orchestrator']);
  assert.deepEqual(own.evidence.map((e) => [e.kind, e.id]), [['message', msg.id], ['task', t.id]]);
  assert.deepEqual([own.captureOrigin!.from, own.captureOrigin!.taskKey, own.captureOrigin!.matched, own.captureOrigin!.quote], ['the boss', t.key, "don't", "That works, thanks. Don't use `any` in TypeScript files."]);
  assert.match(eng.improver.playbookBlock(eng.core.employees.require(id.Alex!), id.shop!, false), /Don't use `any` in TypeScript files\./, 'their own playbook takes it as it takes their own lessons');

  // Phrased for everybody: proposed for the project, waiting for the owner.
  eng.comms.sendMessage({ from: owner, toEmployeeId: id.Alex!, body: 'We use pnpm, not npm.' });
  const shared = eng.core.lessons.find((l) => l.captureOrigin?.kind === 'correction' && l.scope === 'project')!;
  assert.deepEqual([shared.projectId, shared.employeeId, shared.status], [id.shop, null, 'proposed']);
  assert.doesNotMatch(eng.improver.playbookBlock(eng.core.employees.require(id.Sarah!), id.shop!, false), /pnpm/);

  // Each is on the record as something the office did by itself, with how to take it back.
  const ev = learned('captured').filter((e) => e.data.origin === 'correction');
  assert.equal(ev.length, 2);
  assert.deepEqual([ev[0]!.data.auto, ev[0]!.data.area, ev[0]!.data.undo], [true, 'capture', { lessonId: own.id, status: 'retired' }]);
  // Said again: the same lesson, not a second one.
  eng.comms.sendMessage({ from: owner, toEmployeeId: id.Alex!, body: "Don't use `any` in TypeScript files." });
  assert.equal(eng.core.lessons.filter((l) => l.captureOrigin?.kind === 'correction').length, 2);
  // Learning switched off: nothing is kept.
  eng.core.updateSettings({ selfImprovement: { enabled: false } } as any);
  eng.comms.sendMessage({ from: owner, toEmployeeId: id.Alex!, body: 'Never edit files under vendor.' });
  eng.core.updateSettings({ selfImprovement: { enabled: true } } as any);
  assert.equal(eng.core.lessons.filter((l) => l.captureOrigin?.kind === 'correction').length, 2);
  t.status = 'DONE';
  eng.core.put('task', t);
});

test("the owner's review rejection becomes a candidate with its evidence", async () => {
  const review = async (title: string, comments: string) => {
    const t = eng.tasks.createTask({ projectId: id.shop!, title, assigneeId: id.Sarah!, released: false });
    t.status = 'REVIEW';
    eng.core.put('task', t);
    await eng.tasks.submitReview('owner', t.id, 'request_changes', comments);
    // (Kept off the scheduler: nothing runs on this host.)
    Object.assign(t, { status: 'BACKLOG', released: false });
    return eng.core.put('task', t);
  };
  const t = await review('Orders page', 'The empty state is missing on the orders page, and the totals are not right-aligned.');
  const l = eng.core.lessons.find((x) => x.captureOrigin?.kind === 'review_rejection' && x.captureOrigin.taskId === t.id)!;
  // Not evidently a rule, so it waits for the owner — even though it is for one employee only.
  assert.deepEqual([l.scope, l.employeeId, l.status], ['employee', id.Sarah, 'proposed']);
  assert.match(l.text, /^Review feedback from the boss on feature work — "The empty state is missing on the orders page/);
  assert.equal(l.appliesWhen, `before feature work like ${t.key} goes to review`);
  assert.deepEqual(l.evidence.map((e) => [e.kind, e.id]), [['review', t.id], ['task', t.id]]);
  assert.match(l.evidence[0]!.note, /The boss requested changes on T-\d+: "The empty state is missing/);
  assert.equal(l.captureOrigin!.quote, 'The empty state is missing on the orders page, and the totals are not right-aligned.');
  // A comment that reads as a standing rule is the rule itself, active in the author's playbook.
  const t2 = await review('Checkout', 'Never leave TODO markers in code you hand in.');
  const rule = eng.core.lessons.find((x) => x.captureOrigin?.kind === 'review_rejection' && x.captureOrigin.taskId === t2.id)!;
  assert.deepEqual([rule.text, rule.status, rule.captureOrigin!.matched], ['Never leave TODO markers in code you hand in.', 'active', 'never']);
  // A teammate's review is not the owner's word: it reaches the author through the retrospective instead.
  const t3 = eng.tasks.createTask({ projectId: id.shop!, title: 'Cart', assigneeId: id.Sarah!, released: false });
  Object.assign(t3, { status: 'REVIEW', reviewerId: id.Bo });
  eng.core.put('task', t3);
  await eng.tasks.submitReview(eng.core.employees.require(id.Bo!), t3.id, 'request_changes', 'Never leave console.log calls in handlers.');
  Object.assign(t3, { status: 'BACKLOG', released: false });
  eng.core.put('task', t3);
  assert.equal(eng.core.lessons.filter((x) => x.captureOrigin?.taskId === t3.id).length, 0);
  // Turned down by the owner, the same words are not proposed again.
  eng.improver.updateLesson(l.id, { status: 'retired' });
  await review('Orders page again', 'The empty state is missing on the orders page, and the totals are not right-aligned.');
  assert.equal(eng.core.lessons.filter((x) => x.captureOrigin?.kind === 'review_rejection' && x.status === 'proposed').length, 0);
});

test('a denied approval with a note becomes a candidate; without a note there is nothing to learn from', async () => {
  const ask = (command: string) => eng.comms.createQuestion({ kind: 'permission', channel: 'permission_hook', employee: eng.core.employees.require(id.Bo!), session: null, text: `Bo wants to run: ${command}`, tool: { name: 'Bash', input: { command } } });
  await eng.comms.answer(ask('rm -rf build').id, { decision: 'deny' });
  await eng.comms.answer(ask('npm test').id, { decision: 'allow', answer: 'go ahead' });
  assert.equal(eng.core.lessons.filter((l) => l.captureOrigin?.kind === 'denial').length, 0);
  const q = ask('wget https://example.com/install.sh');
  await eng.comms.answer(q.id, { decision: 'deny', answer: 'no downloads from the internet on this machine' });
  const l = eng.core.lessons.find((x) => x.captureOrigin?.kind === 'denial')!;
  assert.deepEqual([l.scope, l.employeeId, l.status, l.appliesWhen], ['employee', id.Bo, 'proposed', 'before asking to run "wget"']);
  assert.equal(l.text, 'The boss denied "wget https://example.com/install.sh" with the note: "no downloads from the internet on this machine"');
  assert.deepEqual(l.evidence.map((e) => [e.kind, e.id]), [['approval', q.id]]);
});

// ─────────────────────────────── repeats ─────────────────────────────

test('a question asked again is shown with the earlier answer, flags the knowledge that was missed, and is not answered', async () => {
  assert.ok(questionSimilarity('Which date format do we use?', 'What date format should we use for timestamps?') >= 0.6);
  assert.ok(questionSimilarity('Which date format do we use?', 'Which database do we use?') < 0.6);
  const alex = eng.core.employees.require(id.Alex!);
  const sarah = eng.core.employees.require(id.Sarah!);
  const first = eng.comms.createQuestion({ kind: 'question', channel: 'mcp_tool', employee: alex, session: null, text: 'Which date format do we use?' });
  assert.equal(first.captureAnsweredBefore, undefined, 'nothing to compare with yet');
  await eng.comms.answer(first.id, { answer: 'ISO 8601 everywhere' });
  const knowledge = eng.core.lessons.find((l) => l.source === 'owner_answer' && l.evidence[0]!.id === first.id)!;
  assert.equal(knowledge.captureMustInclude, undefined);

  const again = eng.comms.createQuestion({ kind: 'question', channel: 'mcp_tool', employee: sarah, session: null, text: 'What date format should we use for timestamps?' });
  assert.deepEqual([again.status, again.answer, again.answeredAt], ['open', null, null], 'the question is left for a person');
  assert.deepEqual([again.captureAnsweredBefore!.questionId, again.captureAnsweredBefore!.answer, again.captureAnsweredBefore!.askedBy, again.captureAnsweredBefore!.lessonId], [first.id, 'ISO 8601 everywhere', 'Alex', knowledge.id]);
  const note = eng.core.notifications.find((n) => n.questionId === again.id)!;
  assert.match(note.body, /What date format should we use for timestamps\?\nAnswered before \(asked by Alex\), by the boss: "ISO 8601 everywhere" — this is project knowledge already/);
  // The knowledge existed and did not reach the session: flagged for retrieval, on the record, reversible.
  assert.equal(eng.core.lessons.require(knowledge.id).captureMustInclude, 1);
  const missed = learned('knowledge_missed');
  assert.equal(missed.length, 1);
  assert.deepEqual([missed[0]!.data.auto, missed[0]!.data.area, missed[0]!.data.undo], [true, 'capture', { lessonId: knowledge.id, captureMustInclude: 0 }]);
  assert.deepEqual((missed[0]!.data.evidence as any[]).map((e) => e.id), [first.id, again.id]);
  assert.equal(eng.core.questions.filter((q) => q.status === 'open' && q.id === again.id).length, 1);

  // A different question, the same question in another project, and an approval: no match.
  assert.equal(eng.comms.createQuestion({ kind: 'question', channel: 'mcp_tool', employee: sarah, session: null, text: 'Which database do we use?' }).captureAnsweredBefore, undefined);
  assert.equal(eng.comms.createQuestion({ kind: 'question', channel: 'mcp_tool', employee: sarah, session: null, text: 'Which date format do we use?', projectId: id.docs }).captureAnsweredBefore, undefined);
  assert.equal(eng.comms.createQuestion({ kind: 'permission', channel: 'permission_hook', employee: sarah, session: null, text: 'Which date format do we use?', tool: { name: 'Bash', input: { command: 'date' } } }).captureAnsweredBefore, undefined);
  assert.equal(learned('knowledge_missed').length, 1);
});

// ─────────────────────────────── failures ────────────────────────────

const JEST_A = `FAIL src/cart/total.test.ts (4.211 s)
  ● cart total › applies the discount once

    expect(received).toBe(expected) // Object.is equality

    Expected: 90
    Received: 81

      at Object.<anonymous> (/Users/dev/work/shop/.orch/alex/src/cart/total.test.ts:42:19)

Tests:       1 failed, 37 passed, 38 total
Time:        5.731 s`;
const JEST_B = `\x1b[31mFAIL\x1b[0m src/cart/total.test.ts (6.02 s)
  ● cart total › applies the discount once

    expect(received).toBe(expected) // Object.is equality

    Expected: 190
    Received: 171

      at Object.<anonymous> (/home/ci/builds/7f3a9c21/shop/.orch/sarah/src/cart/total.test.ts:57:21)

Tests:       1 failed, 41 passed, 42 total
Time:        7.004 s`;
const TSC = `src/api/orders.ts(18,7): error TS2322: Type 'string' is not assignable to type 'number'.
Found 1 error in src/api/orders.ts:18`;

test('the failure signature ignores paths, numbers and timings: two runs of one failure group, a different failure does not', () => {
  const a = failureSignature('npm test', JEST_A);
  const b = failureSignature('npm test', JEST_B);
  const c = failureSignature('npm test', TSC);
  assert.equal(sameFailure(a, b), true);
  assert.equal(sameFailure(a, c), false);
  assert.equal(sameFailure(b, c), false);
  assert.equal(sameFailure(a, failureSignature('npm run lint', JEST_A)), false, 'another command is another failure');
  assert.equal(a.headline, 'FAIL src/cart/total.test.ts (4.211 s)');
  // What is left of a line once the run-specific parts are out: the same for both runs.
  assert.deepEqual(a.lines, ['fail <path>/total.test.ts (#)', 'expect(received).tobe(expected) // object.is equality', 'expected: #', 'tests: # failed, # passed, # total']);
  assert.deepEqual(b.lines, a.lines);
  assert.equal(failureSignature('npm test', 'boom\n  at run (/Users/dev/work/shop/src/a.ts:42:19)\n  at C:\\ci\\shop\\src\\a.ts:7:1 after 1.2s, id 7f3a9c21').lines.join(' | '), 'boom | at run (<path>/a.ts:#) | at <path>/a.ts:# after #, id <hex>');
});

test('the same verification failure on two tasks of a project becomes proposed project knowledge citing both', async () => {
  const project = eng.core.projects.require(id.shop!);
  const fail = (t: Task, out: string) => {
    failedVerification(t, out);
    return eng.improver.capture.onVerificationFailed(t, project, 'npm test', { outputTail: out });
  };
  const t1 = finished('Alex', 'Discount rounding', { status: 'IN_PROGRESS' });
  const t2 = finished('Sarah', 'Coupon stacking', { status: 'IN_PROGRESS' });
  const t3 = finished('Bo', 'Order types', { status: 'IN_PROGRESS' });
  for (const t of [t1, t2]) t.evidence.filesChanged = ['src/cart/total.ts', t === t1 ? 'src/cart/round.ts' : 'README.md'];
  assert.equal(fail(t1, JEST_A), null, 'once is an incident');
  assert.equal(fail(t1, JEST_B), null, 'twice on the same task is still one task');
  assert.equal(fail(t3, TSC), null, 'a different failure is not a repeat');
  const l = fail(t2, JEST_B)!;
  assert.deepEqual([l.scope, l.projectId, l.status, l.source], ['project', id.shop, 'proposed', 'orchestrator']);
  assert.equal(l.text, `"npm test" fails with "FAIL src/cart/total.test.ts (6.02 s)" when src/cart/total.ts changes — seen in ${t1.key}, ${t2.key}.`);
  assert.deepEqual(l.evidence.map((e) => [e.kind, e.id]), [['task', t1.id], ['task', t2.id]]);
  assert.equal(l.captureOrigin!.kind, 'repeat_failure');
  assert.match(l.captureWhy!, /failed the same way on 2 tasks of Shop[\s\S]*not what causes it/);
  // A third task with it: the same record gains the task; nothing new is proposed.
  const t4 = finished('Bo', 'Bundle prices', { status: 'IN_PROGRESS' });
  assert.equal(fail(t4, JEST_A)!.id, l.id);
  const now = eng.core.lessons.require(l.id);
  assert.deepEqual(now.evidence.map((e) => e.id), [t1.id, t2.id, t4.id]);
  assert.match(now.text, new RegExp(`— seen in ${t1.key}, ${t2.key}, ${t4.key}\\.$`));
  assert.equal(eng.core.lessons.filter((x) => x.captureOrigin?.kind === 'repeat_failure').length, 1);
  // A timeout is a different finding (the limit), not knowledge about the code.
  assert.equal(eng.improver.capture.onVerificationFailed(t3, project, 'npm test', { timedOut: true, outputTail: JEST_A }), null);
  for (const t of [t1, t2, t3, t4]) eng.core.put('task', Object.assign(t, { status: 'DONE' }));
});

// ────────────────────────────── onboarding ───────────────────────────

test('the onboarding digest is given once, within its budget, and repeats nothing the prompt already has', async () => {
  const docs = eng.core.projects.require(id.docs!);
  const nina = () => eng.core.employees.require(id.Nina!);
  // More project knowledge than a playbook holds (12 lessons), each a long sentence.
  for (let i = 1; i <= 20; i++) eng.improver.recordFromOwner({ scope: 'project', projectId: docs.id, text: `Docs rule ${i}: every page in section ${i} carries a "last verified" line with the release it was checked against, and a link to the source file it describes` });
  const inPlaybook = eng.improver.lessonsFor(nina(), docs.id);
  assert.equal(inPlaybook.length, 12);
  eng.core.event({ type: 'task.merge_conflict', source: 'server', summary: 'conflict', projectId: docs.id, data: { conflicts: ['docs/index.md'] } });

  const first = eng.tasks.createTask({ projectId: docs.id, title: 'Write the install page', assigneeId: id.Nina!, released: false });
  Object.assign(first, { status: 'IN_PROGRESS', startedAt: from(0) });
  eng.core.put('task', first);
  const block = eng.improver.capture.onboardingBlock(nina(), docs);
  assert.match(block, /^What this team has learned on Docs so far \(given once, because this is your first task here\):\n- /);
  assert.ok(block.length <= ONBOARDING_BUDGET, `${block.length} characters`);
  assert.ok(block.split('\n').length >= 3, 'it holds more than one thing');
  for (const l of inPlaybook) assert.ok(!block.includes(l.text), 'what the playbook block carries is not repeated');
  assert.ok(eng.core.lessons.filter((l) => l.projectId === docs.id && !inPlaybook.includes(l)).some((l) => block.includes(l.text.slice(0, 60))), 'knowledge that did not fit the playbook is what it is for');
  const ev = learned('onboarded');
  assert.deepEqual([ev.length, ev[0]!.employeeId, ev[0]!.data.undo], [1, id.Nina, { employeeId: id.Nina, captureOnboarded: [] }]);
  assert.ok((ev[0]!.data.omitted as number) > 0, 'what did not fit the budget is counted, not squeezed in');
  // Once: the same task delivered again, and every later task, get nothing.
  assert.equal(eng.improver.capture.onboardingBlock(nina(), docs), '');
  assert.equal(learned('onboarded').length, 1);
  // Someone who already worked on a project is not new to it, and a project with nothing to tell says nothing.
  finished('Alex', 'An old shop task');
  const more = eng.tasks.createTask({ projectId: id.shop!, title: 'Another', assigneeId: id.Alex!, released: false });
  Object.assign(more, { status: 'IN_PROGRESS', startedAt: from(0) });
  eng.core.put('task', more);
  assert.equal(eng.improver.capture.onboardingBlock(eng.core.employees.require(id.Alex!), eng.core.projects.require(id.shop!)), '');
  eng.core.put('task', Object.assign(more, { status: 'DONE' }));
  const empty = await eng.tasks.createProject({ name: 'Empty', policy: { autoAssign: false } });
  assert.equal(eng.improver.capture.onboardingBlock(nina(), empty), '');
  eng.core.put('task', Object.assign(first, { status: 'DONE' }));
});

// ───────────────────────────── retrospectives ────────────────────────

test('a retrospective carries the recorded facts in a structured form and is never sent more often than the setting allows', async () => {
  const proj = (await eng.tasks.createProject({ name: 'Retro', policy: { autoAssign: false } })).id;
  id.Rae = eng.employees.create({ name: 'Rae', roleKey: 'backend', projectId: proj, hostId: id.host!, workingDir: '/tmp/x' }).id;
  session(id.Rae!);
  const requested = () => eng.core.store.queryEvents({ types: ['improvement.retrospective_requested'], employeeId: id.Rae!, limit: 100 });
  const set = (retrospectives: 'off' | 'friction' | 'always') => eng.core.updateSettings({ selfImprovement: { retrospectives } } as any);
  const out = "1 failing: cart.txt is broken\n    at check (/Users/dev/shop/check.js:12:3)";

  // off: never, whatever happened.
  set('off');
  const a = finished('Rae', 'Failed while off', {}, proj);
  failedVerification(a, out);
  eng.improver.afterTask(a);
  assert.equal(requested().length, 0);
  // friction: not after a clean task.
  set('friction');
  eng.improver.afterTask(finished('Rae', 'Clean', {}, proj));
  assert.equal(requested().length, 0);
  assert.equal(retrosQueued('Rae').length, 0);

  // friction: once after a task that had some, with the facts.
  const b = finished('Rae', 'Cart totals', {}, proj);
  failedVerification(b, out);
  failedVerification(b, out.replace('12:3', '14:9'));
  const asked = eng.comms.createQuestion({ kind: 'question', channel: 'mcp_tool', employee: eng.core.employees.require(id.Rae!), session: null, text: 'Round half up or half even?', taskId: b.id });
  await eng.comms.answer(asked.id, { answer: 'Half even, like the invoices' });
  eng.core.put('message', { ...eng.comms.sendMessage({ from: owner, toEmployeeId: id.Rae!, body: 'The totals must match the invoice service to the cent.' }), createdAt: from(-30_000) });
  eng.improver.afterTask(eng.core.tasks.require(b.id));
  assert.equal(requested().length, 1);
  assert.deepEqual(requested()[0]!.data.kinds, ['attempts', 'verification', 'question', 'told']);
  const [retro] = retrosQueued('Rae');
  assert.match(retro!.text, /^\[ORCH:RETRO:[^\]]+\] Retrospective for T-\d+ "Cart totals" \(verified and done\)\./);
  assert.match(retro!.text, /- \[attempts\] It took 3 attempts: 2 times your completed work was sent back \(2 failed verifications\)\./);
  assert.match(retro!.text, /- \[verification\] Verification \("npm test"\) failed 2 times before it passed \(exit code 1\)\. The end of its output, exactly:\n {4}1 failing: cart\.txt is broken\n {8}at check \(\/Users\/dev\/shop\/check\.js:14:9\)/);
  assert.match(retro!.text, /- \[question\] You asked "Round half up or half even\?" and the boss answered: "Half even, like the invoices"/);
  assert.match(retro!.text, /- \[told\] While you worked on it, the boss told you: "The totals must match the invoice service to the cent\."/);
  assert.match(retro!.text, /- lesson: the rule[\s\S]*- applies_when: the concrete trigger[\s\S]*- why: the evidence[\s\S]*- scope: "self"[\s\S]*none=true and a reason/);

  // The session answers in the shape asked for: the lesson knows which friction it is about.
  const rec = await call('Rae', 'record_lesson', { lesson: 'Run npm test and read its whole output before calling complete_task', applies_when: 'before calling complete_task on the Retro project', why: 'Verification failed twice with "cart.txt is broken" before it passed', scope: 'self' });
  assert.match(rec.text, /Recorded in your playbook/);
  const lesson = eng.core.lessons.find((l) => l.employeeId === id.Rae)!;
  assert.deepEqual([lesson.captureOrigin!.kind, lesson.captureOrigin!.taskKey, lesson.evidence[0]!.id], ['retrospective', b.key, b.id]);
  assert.ok(lesson.captureOrigin!.signatures!.some((s) => s.startsWith('verify|npm test\n')));

  // The same friction on a task that began before that lesson existed: they could not have used it. Not asked again.
  const c = finished('Rae', 'Cart taxes', { startedAt: from(-120_000) }, proj);
  failedVerification(c, out.replace('12:3', '31:5'));
  eng.improver.afterTask(c);
  assert.equal(requested().length, 1, 'no second retrospective for what they already recorded');
  const skipped = learned('retro_skipped');
  assert.deepEqual([skipped.length, skipped[0]!.taskId, skipped[0]!.data.lessonId, skipped[0]!.data.auto], [1, c.id, lesson.id, true]);

  // The same friction on a task that began with the lesson in the prompt: it did not prevent a repeat. Asked what to change.
  await sleep(5);
  const d = finished('Rae', 'Cart shipping', { startedAt: from(0), completedAt: from(1000) }, proj);
  failedVerification(d, out.replace('12:3', '8:1'));
  eng.improver.afterTask(d);
  assert.equal(requested().length, 2);
  assert.equal(requested()[1]!.data.revises, lesson.id);
  const revise = retrosQueued('Rae').at(-1)!;
  assert.match(revise.text, new RegExp(`You already recorded a lesson about this \\(id ${lesson.id}\\): "Run npm test and read its whole output before calling complete_task" — applies before calling complete_task on the Retro project\\. It was in your prompt for this task, and the same thing happened again\\.\\nAnything to change\\?[\\s\\S]*replaces="${lesson.id}"`));
  const sharper = await call('Rae', 'record_lesson', { lesson: 'Run npm test from the repository root and fix every "is broken" line before calling complete_task', applies_when: 'before calling complete_task on the Retro project', why: 'The same "cart.txt is broken" failure came back with the earlier lesson in the prompt', scope: 'self', replaces: lesson.id });
  assert.match(sharper.text, new RegExp(`It replaces your earlier lesson ${lesson.id}, which is retired\\.`));
  assert.equal(eng.core.lessons.require(lesson.id).status, 'retired');
  const revised = learned('lesson_revised');
  assert.deepEqual([revised.length, revised[0]!.data.undo], [1, { lessonId: lesson.id, status: 'active' }]);
  // Somebody else's lesson cannot be replaced this way.
  const other = eng.improver.recordFromOwner({ scope: 'employee', employeeId: id.Alex!, text: 'Keep handlers under forty lines' });
  assert.match((await call('Rae', 'record_lesson', { lesson: 'Split handlers that grow past forty lines into helpers', applies_when: 'when editing files under src/api', why: 'A review asked for the orders handler to be split', replaces: other.id })).text, /replaces=".*" was ignored: it is not an active lesson of your own playbook/);
  assert.equal(eng.core.lessons.require(other.id).status, 'active');

  // A different friction is a different matter: asked, in the ordinary form.
  const e = finished('Rae', 'Cart merge', { startedAt: from(2000), completedAt: from(3000) }, proj);
  e.friction.mergeConflicts = 1;
  eng.core.put('task', e);
  eng.core.event({ type: 'task.merge_conflict', source: 'server', summary: 'conflict', taskId: e.id, projectId: proj, data: { conflicts: ['src/cart.ts'] } });
  eng.improver.afterTask(e);
  assert.equal(requested().length, 3);
  assert.match(retrosQueued('Rae').at(-1)!.text, /- \[merge\] Merging your branch conflicted in src\/cart\.ts\.[\s\S]*Is there a concrete, reusable lesson here/);
  // always: a clean task is asked about too — once.
  set('always');
  eng.improver.afterTask(finished('Rae', 'Clean again', { startedAt: from(4000), completedAt: from(5000) }, proj));
  assert.equal(requested().length, 4);
  assert.match(retrosQueued('Rae').at(-1)!.text, /It went through without recorded problems\./);
  set('friction');
  // In all: six finished tasks, four of them with friction or under "always", and never more than one prompt each.
  assert.ok(requested().length <= 6);
  assert.equal(new Set(requested().map((x) => x.taskId)).size, requested().length);
});

// ──────────────────────────────── skills ─────────────────────────────

test("skills are counted from finished work, and the declared ones are left as the owner's", async () => {
  const proj = (await eng.tasks.createProject({ name: 'Skills', policy: { autoAssign: false } })).id;
  id.Kim = eng.employees.create({ name: 'Kim', roleKey: 'backend', projectId: proj, hostId: id.host!, workingDir: '/tmp/x' }).id;
  const declared = [...eng.core.employees.require(id.Kim!).skills];
  assert.equal(eng.core.employees.require(id.Kim!).captureSkills, undefined, 'nothing measured before any work');
  const done = (title: string, kind: Task['kind'], files: string[], failed = 0) => {
    const t = finished('Kim', title, { kind }, proj);
    t.evidence.filesChanged = files;
    t.friction.failedVerifications = failed;
    eng.core.put('task', t);
    eng.improver.afterTask(t);
  };
  eng.core.updateSettings({ selfImprovement: { retrospectives: 'off' } } as any);
  done('Fix totals', 'bug', ['src/api/orders.ts', 'src/api/orders.test.ts']);
  done('Fix taxes', 'bug', ['src/api/tax.ts', 'README.md'], 1);
  done('Add export', 'feature', ['src/api/export.ts', 'migrations/004_export.sql', 'Dockerfile']);
  for (const tool of ['Bash', 'Bash', 'Edit']) eng.core.event({ type: 'agent.tool_finished', source: 'hook', summary: 'tool', employeeId: id.Kim!, data: { tool } });
  eng.improver.capture.refreshSkills(id.Kim!);
  eng.core.updateSettings({ selfImprovement: { retrospectives: 'friction' } } as any);
  const kim = eng.core.employees.require(id.Kim!);
  const of = (kind: string) => kim.captureSkills!.filter((s) => s.kind === kind).map((s) => [s.label, s.count, ...(s.firstPass === undefined ? [] : [s.firstPass])]);
  assert.deepEqual(of('task_kind'), [['bug', 2, 1], ['feature', 1, 1]]);
  assert.deepEqual(of('file_type'), [['.ts', 3], ['.md', 1], ['.sql', 1], ['Dockerfile', 1]]);
  assert.deepEqual(of('directory'), [['src/api', 3], ['migrations', 1]]);
  assert.deepEqual(of('tool'), [['Bash', 2], ['Edit', 1]]);
  assert.deepEqual(kim.skills, declared, 'what was declared at hiring is untouched');
  assert.equal(eng.improver.capture.skillsLine(kim), 'delivered: bug 1/2 first pass, feature 1/1 first pass; mostly in src/api, migrations, .ts, .md');
  // A colleague deciding whom to ask sees the record, not the job title alone.
  session(id.Alex!);
  assert.match((await call('Alex', 'get_team')).text, /- Kim — [^·]+ · project Skills(?: · folder \S+)? · OFFLINE · delivered: bug 1\/2 first pass, feature 1\/1 first pass; mostly in src\/api/);
});
