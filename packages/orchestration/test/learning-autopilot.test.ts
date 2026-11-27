import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AutonomyLevel, Employee, Host, Improvement, ImprovementAction, ImprovementKind, Question, Task } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, sanitizeAutopilot, type AgentLink, type Timings } from '../src/index.ts';
import { AUTOPILOT_TABLE, classify, commandShape } from '../src/learning/autopilot.ts';

/**
 * The autopilot is exercised on an engine whose host runs nothing: everything it decides comes from
 * recorded questions, tasks and events, so no session is needed. Decisions are made through the same
 * `comms.answer` the office uses; outcomes of tasks are written as the records the task manager writes.
 */
const link: AgentLink = { rpc: () => Promise.reject(new Error('this test host runs nothing')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };
const hostOf = (over: Partial<Host> = {}): Host => ({ id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true, ...over });

let serial = 0;
async function office(mode: 'off' | 'safe' | 'trusted', timings: Partial<Timings> = {}) {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0, ...timings } }, { send: () => undefined });
  eng.core.put('host', hostOf());
  eng.core.updateSettings({ selfImprovement: { autopilot: mode } } as any);
  // Each decision schedules an analysis a moment later; here the tests say when the record is read, so nothing depends on timing.
  eng.improver.scheduleAnalyze = () => undefined;
  const shop = await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } });
  const alex = eng.employees.create({ name: 'Alex', roleKey: 'backend', projectId: shop.id, hostId: 'host-1', workingDir: '/tmp/x', autonomy: 'auto' });
  return { eng, shop, alex };
}
type Office = Awaited<ReturnType<typeof office>>;

/** A permission request for a shell command, decided by somebody (or left open). */
async function ask(eng: Engine, employee: Employee, projectId: string, command: string, decision: 'allow' | 'deny' | null, opts: { taskId?: string; actor?: string } = {}): Promise<Question> {
  const q = eng.comms.createQuestion({ kind: 'permission', channel: 'permission_hook', employee, session: null, text: `${employee.name} wants to run: ${command}`, tool: { name: 'Bash', input: { command } }, projectId, taskId: opts.taskId ?? null, quietEvent: true });
  if (decision) await eng.comms.answer(q.id, { decision }, opts.actor ?? 'owner');
  return q;
}
const approve = async (o: Office, command: string, times: number, opts: { tasks?: number; actor?: string } = {}) => {
  for (let i = 0; i < times; i++) await ask(o.eng, o.alex, o.shop.id, `${command} arg${i}`, 'allow', { taskId: `task-${i % (opts.tasks ?? 2)}`, actor: opts.actor });
};
const deny = async (o: Office, command: string, times: number, opts: { actor?: string } = {}) => {
  for (let i = 0; i < times; i++) await ask(o.eng, o.alex, o.shop.id, `${command} arg${i}`, 'deny', opts);
};
/** A proposal as the analyser would have stored it, for kinds it does not produce from a short record. */
function proposal(eng: Engine, kind: ImprovementKind, action: ImprovementAction, over: Partial<Improvement> = {}): Improvement {
  const id = `imp-${++serial}`;
  return eng.core.put('improvement', { id, kind, title: `Proposal ${id}`, rationale: 'because', evidence: [], projectId: 'projectId' in action ? action.projectId : null, employeeId: 'employeeId' in action ? action.employeeId : null, action, status: 'proposed', dedupeKey: `test:${id}`, createdAt: new Date(Date.now() + serial).toISOString(), decidedAt: null, ...over } as Improvement);
}
/** A finished task, written the way the task manager leaves one, with the event it records. */
function finished(o: Office, over: { friction?: Partial<Task['friction']>; reviewed?: boolean; assigneeId?: string; projectId?: string } = {}): Task {
  const t = o.eng.tasks.createTask({ projectId: over.projectId ?? o.shop.id, title: `Work ${++serial}`, assigneeId: over.assigneeId ?? o.alex.id, kind: 'feature', released: false });
  t.status = 'DONE';
  t.completedAt = new Date(Date.now() + serial).toISOString();
  t.evidence.summary = 'done';
  Object.assign(t.friction, over.friction ?? {});
  if (over.reviewed) t.evidence.review = { reviewerId: null, verdict: 'approved', comments: '', ts: t.completedAt, by: 'owner' };
  o.eng.core.put('task', t);
  o.eng.core.event({ type: 'task.completed', source: 'server', summary: `${t.key} completed`, taskId: t.id, projectId: t.projectId, employeeId: t.assigneeId, data: { key: t.key } });
  return t;
}
/** A verification that ran out of time, as the task manager records it. */
const timedOut = (o: Office, projectId = o.shop.id) => o.eng.core.event({ type: 'task.verification_failed', source: 'server', summary: 'failed verification (timeout)', projectId, employeeId: null, data: { command: 'npm test', timedOut: true, outputTail: '' } });
const events = (eng: Engine, type: string) => eng.core.store.queryEvents({ types: [type] });
const imp = (eng: Engine, match: (i: Improvement) => boolean) => eng.core.improvements.find(match)!;
const project = (o: Office) => o.eng.core.projects.require(o.shop.id);

test('the table: every kind and every action is classified, and anything unknown counts as widening', async () => {
  const o = await office('safe');
  const now = { project: (id: string) => o.eng.core.projects.get(id), employee: (id: string) => o.eng.core.employees.get(id) };
  const kinds: ImprovementKind[] = ['allow_rule', 'deny_rule', 'autonomy', 'review_policy', 'verify_command', 'verify_timeout', 'sequencing', 'acceptance_criteria', 'routing', 'playbook_contradiction', 'revert_improvement', 'task_size', 'dependencies', 'missing_context', 'stall', 'verify_quality', 'machine_load', 'idle_capacity'];
  assert.deepEqual(Object.keys(AUTOPILOT_TABLE.kinds).sort(), [...kinds].sort(), 'every kind of proposal has a row');
  assert.deepEqual(Object.keys(AUTOPILOT_TABLE.actions).sort(), ['advice', 'employee.autonomy', 'project.notes.append', 'project.policy.allow', 'project.policy.deny', 'project.requireReview', 'project.routing', 'project.verifyTimeout', 'task.dependsOn']);
  for (const actions of Object.values(AUTOPILOT_TABLE.kinds)) for (const a of actions) assert.ok(Object.hasOwn(AUTOPILOT_TABLE.actions, a), `${a} is a known action`);

  const p = o.shop.id;
  const widening = (kind: string, action: unknown) => classify({ kind, action } as any, now);
  assert.equal(widening('allow_rule', { type: 'project.policy.allow', projectId: p, rule: 'Bash(x:*)' }).widening, true);
  assert.equal(widening('deny_rule', { type: 'project.policy.deny', projectId: p, rule: 'Bash(x:*)' }).widening, false);
  assert.equal(widening('review_policy', { type: 'project.requireReview', projectId: p, value: true }).widening, false);
  assert.equal(widening('review_policy', { type: 'project.requireReview', projectId: p, value: false }).widening, true);
  assert.equal(widening('verify_timeout', { type: 'project.verifyTimeout', projectId: p, seconds: o.shop.verifyTimeoutSec * 2 }).widening, false);
  assert.equal(widening('verify_timeout', { type: 'project.verifyTimeout', projectId: p, seconds: 5 }).widening, true, 'only "longer" is known to be harmless');
  assert.equal(widening('verify_timeout', { type: 'project.verifyTimeout', projectId: 'gone', seconds: 9999 }).widening, true, 'an unknown project: direction cannot be told');
  // Autonomy: down is not widening; up, sideways and "whose?" are.
  const levels: AutonomyLevel[] = ['standard', 'auto', 'unrestricted'];
  assert.deepEqual(levels.map((level) => widening('autonomy', { type: 'employee.autonomy', employeeId: o.alex.id, level }).widening), [false, true, true], 'Alex is on Auto');
  assert.equal(widening('autonomy', { type: 'employee.autonomy', employeeId: 'nobody', level: 'standard' }).widening, true);
  for (const kind of ['verify_command', 'sequencing', 'acceptance_criteria', 'routing']) assert.equal(widening(kind, { type: 'advice' }).widening, false);

  // Unknown: a new kind, a new action, a pairing nobody expected, and names that only look like rows.
  for (const [kind, action] of [['brand_new', { type: 'advice' }], ['deny_rule', { type: 'project.something_new' }], ['sequencing', { type: 'project.policy.deny', projectId: p, rule: 'Bash(x:*)' }], ['constructor', { type: 'advice' }], ['deny_rule', { type: 'toString' }], ['deny_rule', null]] as const) {
    assert.deepEqual([widening(kind, action).widening, widening(kind, action).known], [true, false], `${kind} / ${JSON.stringify(action)}`);
  }
  // And an unknown one is never applied, on any setting.
  o.eng.core.updateSettings({ selfImprovement: { autopilot: 'trusted' } } as any);
  const odd = proposal(o.eng, 'brand_new' as any, { type: 'project.something_new', projectId: p } as any);
  assert.deepEqual(o.eng.improver.autopilot.run(), []);
  assert.equal(odd.status, 'proposed');
  assert.match((o.eng.improver.autopilot.verdict(odd) as any).why, /not in the autopilot's table/);
});

test('the dial: "safe" by default, also for an office from before, and whatever is typed is brought inside bounds', async () => {
  const fresh = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  assert.deepEqual([fresh.core.settings.selfImprovement.autopilot, fresh.core.settings.selfImprovement.autopilotMaxPerDay], ['safe', 3]);
  // An office whose stored settings predate the dial.
  const store = new Store(':memory:');
  store.kvSet('settings', { selfImprovement: { enabled: true, retrospectives: 'always', autoApproveSharedLessons: true, learnedRouting: false } });
  const old = new Engine({ store, agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  assert.deepEqual(old.core.settings.selfImprovement, { enabled: true, retrospectives: 'always', autoApproveSharedLessons: true, learnedRouting: false, outcomesAutoRetire: true, autopilot: 'safe', autopilotMaxPerDay: 3 });
  const d = old.core.settings.selfImprovement;
  assert.deepEqual(sanitizeAutopilot({ ...d, autopilot: 'yolo' as any, autopilotMaxPerDay: 999 }, d), { ...d, autopilot: 'safe', autopilotMaxPerDay: 20 });
  assert.deepEqual(sanitizeAutopilot({ ...d, autopilot: 'trusted', autopilotMaxPerDay: 0 }, d), { ...d, autopilot: 'trusted', autopilotMaxPerDay: 1 });
  assert.deepEqual(sanitizeAutopilot({ ...d, autopilot: undefined as any, autopilotMaxPerDay: 'many' as any }, d), d);
  // Through the settings themselves: a partial patch changes only what it names; nonsense changes nothing.
  assert.equal(old.core.updateSettings({ selfImprovement: { autopilot: 'trusted' } } as any).selfImprovement.autopilot, 'trusted');
  assert.equal(old.core.updateSettings({ selfImprovement: { autopilot: 'everything' } } as any).selfImprovement.autopilot, 'trusted');
  assert.equal(old.core.updateSettings({ selfImprovement: { autopilotMaxPerDay: 2.6 } } as any).selfImprovement.autopilotMaxPerDay, 3);
  assert.equal(old.core.updateSettings({ companyName: 'Acme' }).selfImprovement.autopilot, 'trusted');
  // With self-improvement as a whole switched off, the autopilot is off whatever the dial says.
  old.core.updateSettings({ selfImprovement: { enabled: false } } as any);
  assert.equal(old.improver.autopilot.mode, 'off');
});

test('"off" changes nothing: every suggestion waits, as before', async () => {
  const o = await office('off');
  await deny(o, 'wget', 3);
  const found = o.eng.improver.analyze();
  assert.deepEqual(found.map((i) => [i.kind, i.status]), [['deny_rule', 'proposed']]);
  assert.deepEqual(project(o).policy.deny, []);
  assert.equal(events(o.eng, 'learning.applied').length, 0);
  assert.equal(found[0]!.autopilot, undefined);
  assert.match((o.eng.improver.autopilot.verdict(found[0]!) as any).why, /autopilot is off/);
  // The owner's click still works, and now keeps what is needed to undo it.
  o.eng.improver.apply(found[0]!.id);
  assert.deepEqual(project(o).policy.deny, ['Bash(wget:*)']);
  assert.deepEqual([found[0]!.autopilot!.appliedBy, found[0]!.autopilot!.auto, found[0]!.autopilot!.probation], ['owner', false, null]);
});

test('"safe" applies a deny rule by itself — recorded, explained, reversible — and never an allow rule', async () => {
  const o = await office('safe');
  await deny(o, 'wget', 3);
  await approve(o, 'docker build', 6);
  const waiting = await ask(o.eng, o.alex, o.shop.id, 'docker build -t pending .', null);
  o.eng.improver.analyze();

  const denyRule = imp(o.eng, (i) => i.kind === 'deny_rule');
  assert.equal(denyRule.status, 'applied');
  assert.deepEqual(project(o).policy.deny, ['Bash(wget:*)'], 'the real policy changed');
  const record = denyRule.autopilot!;
  assert.deepEqual([record.appliedBy, record.auto, record.widening, record.noAuto], ['autopilot', true, false, false]);
  assert.deepEqual(record.undo, { type: 'project.policy.deny', projectId: o.shop.id, rule: 'Bash(wget:*)', added: true });
  assert.equal(record.probation!.status, 'running');
  // Through the same path as the owner's click: the same audit entries, under the autopilot's name.
  const audit = o.eng.core.store.recentAudit(50);
  assert.equal(audit.find((a) => a.action === 'improvement.applied' && a.target === denyRule.id)?.actor, 'autopilot');
  assert.equal(audit.find((a) => a.action === 'project.updated')?.actor, 'autopilot');
  // One event that says what, why, on what evidence, and how to undo it.
  const [e] = events(o.eng, 'learning.applied');
  assert.equal(e!.summary, `Applied by itself: ${denyRule.title}`);
  assert.equal(e!.data.auto, true);
  assert.equal(e!.data.area, 'autopilot');
  assert.match(String(e!.data.why), /3 "wget" commands were denied in Shop and none approved/);
  assert.equal((e!.data.evidence as unknown[]).length, 3);
  assert.deepEqual(e!.data.undo, { improvementId: denyRule.id, route: `POST /api/improvements/${denyRule.id}/revert`, restore: record.undo });
  // The owner is told, but not asked: the note is born resolved, and the "Suggestion" that asked for a decision is settled.
  const notes = o.eng.core.notifications.filter((n) => n.kind === 'improvement');
  assert.ok(notes.find((n) => n.title === `Applied by itself: ${denyRule.title}`)?.resolvedAt, 'does not count as needing the owner');
  assert.ok(notes.find((n) => n.title === `Suggestion: ${denyRule.title}`)?.resolvedAt);

  // The allow rule widens: on "safe" it waits, with its own "Suggestion" still open.
  const allowRule = imp(o.eng, (i) => i.kind === 'allow_rule');
  assert.equal(allowRule.status, 'proposed');
  assert.deepEqual(project(o).policy.allow, []);
  assert.match((o.eng.improver.autopilot.verdict(allowRule) as any).why, /widens what employees may do without asking/);
  assert.equal(notes.find((n) => n.title === `Suggestion: ${allowRule.title}`)?.resolvedAt, null);
  // And nothing answered the request that was pending.
  assert.deepEqual([waiting.status, waiting.decision], ['open', null]);
});

test('"safe" also turns review on and lengthens a timeout; advice, a shorter timeout and a rule that would stop the work wait', async () => {
  const o = await office('safe');
  const p = o.shop.id;
  const review = proposal(o.eng, 'review_policy', { type: 'project.requireReview', projectId: p, value: true });
  const advice = proposal(o.eng, 'sequencing', { type: 'advice' }, { projectId: p });
  const shorter = proposal(o.eng, 'verify_timeout', { type: 'project.verifyTimeout', projectId: p, seconds: 10 });
  const reviewOff = proposal(o.eng, 'review_policy', { type: 'project.requireReview', projectId: p, value: false });
  timedOut(o);
  timedOut(o);
  await deny(o, 'git --version', 3); // reads as the shape "git": blocking it would block every git command
  await deny(o, 'curl', 3);
  await ask(o.eng, o.alex, p, 'curl https://example.test', 'allow'); // …and one "curl" was approved after all
  o.eng.improver.analyze();
  const longer = imp(o.eng, (i) => i.kind === 'verify_timeout' && i.action.type === 'project.verifyTimeout' && i.action.seconds === 480); // the analyser's own, from the two timeouts
  assert.deepEqual([review.status, longer.status], ['applied', 'applied']);
  assert.deepEqual([project(o).policy.requireReview, project(o).verifyTimeoutSec], [true, 480]);
  assert.deepEqual(longer.autopilot!.undo, { type: 'project.verifyTimeout', projectId: p, previous: 240, applied: 480 });
  // The same two timeouts do not raise the limit a second time: it takes two more since the last raise.
  const again = proposal(o.eng, 'verify_timeout', { type: 'project.verifyTimeout', projectId: p, seconds: 960 });
  o.eng.improver.autopilot.run();
  assert.equal(again.status, 'proposed');
  assert.match((o.eng.improver.autopilot.verdict(again) as any).why, /No two verifications have timed out since the limit was last raised/);
  o.eng.improver.dismiss(again.id);
  assert.equal(advice.status, 'proposed', 'marking advice "taken on board" is a statement about a person; the office does not make it');
  assert.match((o.eng.improver.autopilot.verdict(advice) as any).why, /nothing the office could apply/);
  // ("Review off" widens; a shorter timeout counts as widening because only "longer" is known to be harmless.)
  assert.deepEqual([shorter.status, reviewOff.status], ['proposed', 'proposed']);
  const git = imp(o.eng, (i) => i.kind === 'deny_rule' && /git/.test(i.title));
  assert.equal(git.status, 'proposed');
  assert.match((o.eng.improver.autopilot.verdict(git) as any).why, /would stop the work itself/);
  assert.ok(!o.eng.core.improvements.find((i) => i.kind === 'deny_rule' && /curl/.test(i.title)), 'the analyser itself does not propose it once one was approved');
  // A stale proposal — made when the record still said "always no" — is checked against the record as it is now.
  const stale = proposal(o.eng, 'deny_rule', { type: 'project.policy.deny', projectId: p, rule: 'Bash(curl:*)' });
  o.eng.improver.autopilot.run();
  assert.equal(stale.status, 'proposed');
  assert.match((o.eng.improver.autopilot.verdict(stale) as any).why, /has been approved in Shop since/);
  assert.deepEqual(project(o).policy.deny, []);
});

test('"trusted" applies an allow rule only past every threshold', async () => {
  const o = await office('trusted');
  const auto = o.eng.improver.autopilot;
  await approve(o, 'docker build', 4);
  o.eng.improver.analyze();
  const rule = imp(o.eng, (i) => i.kind === 'allow_rule');
  assert.equal(rule.status, 'proposed');
  assert.match((auto.verdict(rule) as any).why, /4 of the 5 approvals needed/);
  // A fifth approval, but everything in one task and one moment: no spread.
  for (const q of o.eng.core.questions.all()) q.taskId = 'task-0';
  await ask(o.eng, o.alex, o.shop.id, 'docker build -t five .', 'allow', { taskId: 'task-0' });
  o.eng.improver.analyze();
  assert.equal(rule.status, 'proposed');
  assert.match((auto.verdict(rule) as any).why, /must span two tasks or at least the set time/);
  // The same five, a day apart: enough.
  const first = o.eng.core.questions.all()[0]!;
  first.answeredAt = new Date(Date.now() - 25 * 3600_000).toISOString();
  assert.equal(auto.verdict(rule).apply, true);
  first.answeredAt = new Date().toISOString();
  assert.equal(auto.verdict(rule).apply, false);
  // Or two tasks.
  await ask(o.eng, o.alex, o.shop.id, 'docker build -t six .', 'allow', { taskId: 'task-1' });
  o.eng.improver.analyze();
  assert.equal(rule.status, 'applied');
  assert.deepEqual(project(o).policy.allow, ['Bash(docker build:*)']);
  assert.deepEqual([rule.autopilot!.auto, rule.autopilot!.widening, rule.autopilot!.probation!.status, rule.autopilot!.probation!.tasksLeft], [true, true, 'running', 5]);
  const [e] = events(o.eng, 'learning.applied');
  assert.match(String(e!.data.why), /6 "docker build" commands were approved in Shop across 2 tasks, none was ever denied, and none matches the high-risk list/);
  assert.equal(e!.data.widening, true);
});

test('"trusted" never applies an allow rule for a high-risk command, a denied shape, a broader rule than was observed, or a command that runs anything', async () => {
  const o = await office('trusted');
  const auto = o.eng.improver.autopilot;
  const p = o.shop.id;
  const why = (i: Improvement) => (auto.verdict(i) as any).why as string;
  // High-risk: approved however often, the analyser does not propose it — and a proposal that exists anyway is refused.
  await approve(o, 'git push origin', 8);
  o.eng.improver.analyze();
  assert.ok(!o.eng.core.improvements.find((i) => i.kind === 'allow_rule'));
  const push = proposal(o.eng, 'allow_rule', { type: 'project.policy.allow', projectId: p, rule: 'Bash(git push:*)' });
  assert.match(why(push), /matches the high-risk list/);
  // A shape of which one instance was high-risk (a project's own pattern here).
  o.eng.tasks.updateProject(p, { policy: { highRiskPatterns: ['--prod\\b'] } });
  await approve(o, 'make ship', 6);
  await ask(o.eng, o.alex, p, 'make ship --prod', null);
  const ship = proposal(o.eng, 'allow_rule', { type: 'project.policy.allow', projectId: p, rule: 'Bash(make ship:*)' });
  assert.match(why(ship), /matches the high-risk list/);
  // One denial, ever, is enough — also when it was only part of a longer command.
  await approve(o, 'docker build', 6);
  await ask(o.eng, o.alex, p, 'cd app && docker build --no-cache .', 'deny');
  const denied = proposal(o.eng, 'allow_rule', { type: 'project.policy.allow', projectId: p, rule: 'Bash(docker build:*)' });
  assert.match(why(denied), /was denied in Shop \(1 time\); one denial is enough/);
  // Broader than what was approved: "docker build" approvals do not carry a rule for all of docker, nor does any rule that is not a plain shape.
  await approve(o, 'cargo test', 6);
  const broad = proposal(o.eng, 'allow_rule', { type: 'project.policy.allow', projectId: p, rule: 'Bash(cargo:*)' });
  assert.match(why(broad), /pre-approve far more than was observed/);
  await approve(o, 'tool check', 6); // reads as the shape "tool"
  const longer = proposal(o.eng, 'allow_rule', { type: 'project.policy.allow', projectId: p, rule: 'Bash(tool check:*)' });
  assert.match(why(longer), /0 of the 5 approvals needed/, 'approvals count only for the shape they read to');
  for (const rule of ['Bash', 'Bash(*)', 'Edit', 'Bash(rm -rf:*)x', 'Bash($(x):*)', 'Bash(a b c:*)']) {
    assert.match(why(proposal(o.eng, 'allow_rule', { type: 'project.policy.allow', projectId: p, rule })), /Only a rule for one command shape/, rule);
  }
  // A word that runs other things: `node -e …` reads as the shape "node"; `npm run <anything>` is as wide as npm itself.
  await approve(o, 'node -e', 6);
  await approve(o, 'npm run', 6);
  o.eng.improver.analyze();
  const node = imp(o.eng, (i) => i.kind === 'allow_rule' && /"node/.test(i.title));
  assert.match(why(node), /pre-approve far more than was observed/);
  assert.match(why(imp(o.eng, (i) => i.kind === 'allow_rule' && /"npm run/.test(i.title))), /pre-approve far more than was observed/);

  o.eng.improver.autopilot.run();
  // Only the two honest ones went through: exactly the shapes that were approved, nothing wider.
  assert.deepEqual([...project(o).policy.allow].sort(), ['Bash(cargo test:*)', 'Bash(tool:*)']);
  assert.deepEqual([push, ship, denied, broad, longer, node].map((i) => i.status), Array(6).fill('proposed'));
});

test('the daily allowance: a few automatic changes per project, the rest wait their turn', async () => {
  const o = await office('safe');
  o.eng.core.updateSettings({ selfImprovement: { autopilotMaxPerDay: 2 } } as any);
  const other = await o.eng.tasks.createProject({ name: 'Blog', policy: { autoAssign: false } });
  for (const tool of ['wget', 'scp', 'telnet', 'nc']) await deny(o, tool, 3);
  for (let i = 0; i < 3; i++) await ask(o.eng, o.alex, other.id, `wget file${i}`, 'deny');
  o.eng.improver.analyze();
  assert.equal(project(o).policy.deny.length, 2, 'two today in Shop');
  assert.deepEqual(o.eng.core.projects.require(other.id).policy.deny, ['Bash(wget:*)'], 'another project has its own allowance');
  assert.deepEqual(project(o).policy.deny, ['Bash(wget:*)', 'Bash(scp:*)'], 'oldest first');
  assert.equal(o.eng.core.improvements.filter((i) => i.projectId === o.shop.id && i.status === 'proposed').length, 2);
  o.eng.improver.analyze();
  assert.equal(project(o).policy.deny.length, 2, 'asking again the same day changes nothing');
  assert.equal(o.eng.improver.autopilot.allowance(o.shop.id), 0);
  // A larger allowance (or the next day) lets the rest through.
  o.eng.core.updateSettings({ selfImprovement: { autopilotMaxPerDay: 3 } } as any);
  o.eng.improver.analyze();
  assert.equal(project(o).policy.deny.length, 3);
});

test('probation: a denial of that shape takes the rule back, and it is never applied automatically again', async () => {
  const o = await office('trusted');
  await approve(o, 'docker build', 5);
  o.eng.improver.analyze();
  const rule = imp(o.eng, (i) => i.kind === 'allow_rule');
  assert.equal(rule.status, 'applied');
  // A denial of something else changes nothing.
  await ask(o.eng, o.alex, o.shop.id, 'docker run --rm app', 'deny');
  assert.equal(rule.status, 'applied');

  const no = await ask(o.eng, o.alex, o.shop.id, 'docker build --no-cache .', 'deny');
  assert.equal(rule.status, 'proposed', 'back to waiting for the owner');
  assert.deepEqual(project(o).policy.allow, [], 'exactly the rule that was added is gone');
  const record = rule.autopilot!;
  assert.deepEqual([record.noAuto, record.probation!.status, record.reverted!.by, record.reverted!.restored], [true, 'reverted', 'autopilot', true]);
  assert.match(record.reverted!.reason, /A "docker build" command was denied while the rule was on probation/);
  assert.deepEqual(record.reverted!.evidence.map((x) => x.id), [no.id]);
  assert.deepEqual(record.history.map((h) => h.what), ['applied', 'reverted'], 'the history is kept with the suggestion');
  const [e] = events(o.eng, 'learning.reverted');
  assert.deepEqual([e!.data.auto, e!.data.area, e!.data.improvementId, e!.data.restored], [true, 'autopilot', rule.id, true]);
  assert.deepEqual((e!.data.evidence as any[]).map((x) => x.id), [no.id]);
  assert.deepEqual(e!.data.undo, { improvementId: rule.id, route: `POST /api/improvements/${rule.id}/apply` });
  assert.equal(o.eng.core.store.recentAudit(20).find((a) => a.action === 'improvement.reverted')?.actor, 'autopilot');
  // This one is for the owner to look at: the note stays open.
  assert.equal(o.eng.core.notifications.find((n) => /^Taken back:/.test(n.title))?.resolvedAt, null);

  // However much more is approved afterwards, the office does not try again by itself…
  await approve(o, 'docker build', 6);
  o.eng.improver.analyze();
  assert.equal(rule.status, 'proposed');
  assert.match((o.eng.improver.autopilot.verdict(rule) as any).why, /taken back once/);
  assert.equal(o.eng.core.improvements.filter((i) => i.kind === 'allow_rule').length, 1, 'and no second proposal appears for it');
  // …but the owner may.
  o.eng.improver.apply(rule.id);
  assert.deepEqual(project(o).policy.allow, ['Bash(docker build:*)']);
  assert.deepEqual([rule.autopilot!.appliedBy, rule.autopilot!.probation, rule.autopilot!.history.map((h) => h.what)], ['owner', null, ['applied', 'reverted', 'applied']]);
  // What a person applied is not on probation: a later denial is theirs to weigh.
  await ask(o.eng, o.alex, o.shop.id, 'docker build again', 'deny');
  assert.equal(rule.status, 'applied');
});

test('probation: a high-risk request of that shape, or a failed verification that names it, takes the rule back too', async () => {
  const o = await office('trusted');
  await approve(o, 'make release', 5);
  await approve(o, 'cargo bench', 5);
  o.eng.improver.analyze();
  const [make, cargo] = [imp(o.eng, (i) => /make release/.test(i.title)), imp(o.eng, (i) => /cargo bench/.test(i.title))];
  assert.deepEqual([make.status, cargo.status], ['applied', 'applied']);
  // Only asked, not even decided: the shape turned out to reach something that must always come to the owner.
  const risky = await ask(o.eng, o.alex, o.shop.id, 'make release production', null);
  assert.equal(make.status, 'proposed');
  assert.match(make.autopilot!.reverted!.reason, /A high-risk "make release" command was requested/);
  assert.deepEqual([risky.status, risky.decision], ['open', null], 'the request itself is still the owner\'s');
  // A verification failure in that project whose output names the shape.
  const t = finished(o);
  o.eng.core.event({ type: 'task.verification_failed', source: 'server', summary: `${t.key} failed verification (exit 1)`, taskId: t.id, projectId: o.shop.id, employeeId: o.alex.id, data: { key: t.key, command: 'npm test', exitCode: 1, timedOut: false, outputTail: 'error: could not compile\n  cargo test exited 101' } });
  assert.equal(cargo.status, 'applied', 'a failure that does not name it is not a counter-signal');
  o.eng.core.event({ type: 'task.verification_failed', source: 'server', summary: `${t.key} failed verification (exit 1)`, taskId: t.id, projectId: o.shop.id, employeeId: o.alex.id, data: { key: t.key, command: 'npm test', exitCode: 1, timedOut: false, outputTail: 'benchmarks regressed: `cargo bench` left target/ in a broken state' } });
  assert.equal(cargo.status, 'proposed');
  assert.match(cargo.autopilot!.reverted!.reason, /failed verification and the output names "cargo bench"/);
  assert.deepEqual(project(o).policy.allow, []);
});

test('probation ends after the set number of finished tasks, or the set time; after that the change simply stands', async () => {
  const o = await office('trusted', { autopilotProbationTasks: 2 });
  await approve(o, 'docker build', 5);
  o.eng.improver.analyze();
  const rule = imp(o.eng, (i) => i.kind === 'allow_rule');
  const first = finished(o);
  assert.deepEqual([rule.autopilot!.probation!.status, rule.autopilot!.probation!.tasksLeft], ['running', 1]);
  o.eng.core.event({ type: 'task.completed', source: 'server', summary: 'again', taskId: first.id, projectId: o.shop.id, employeeId: o.alex.id, data: {} });
  assert.equal(rule.autopilot!.probation!.tasksLeft, 1, 'a task counts once');
  finished(o);
  assert.deepEqual([rule.autopilot!.probation!.status, rule.autopilot!.history.map((h) => h.what)], ['passed', ['applied', 'kept']]);
  assert.equal(events(o.eng, 'learning.kept').length, 1);
  await ask(o.eng, o.alex, o.shop.id, 'docker build .', 'deny');
  assert.equal(rule.status, 'applied', 'after probation a denial is no longer an automatic rollback');
  assert.deepEqual(project(o).policy.allow, ['Bash(docker build:*)']);

  // By time: checked whenever the autopilot wakes (there is no timer).
  const timed = await office('safe', { autopilotProbationMs: 1 });
  await deny(timed, 'wget', 3);
  timed.eng.improver.analyze();
  const denyRule = imp(timed.eng, (i) => i.kind === 'deny_rule');
  assert.equal(denyRule.autopilot!.probation!.status, 'running');
  await new Promise((r) => setTimeout(r, 5));
  timed.eng.improver.autopilot.sweep();
  assert.equal(denyRule.autopilot!.probation!.status, 'passed');
});

test('the office never raises a level by itself, whatever the record says, and proposes none', async () => {
  const o = await office('trusted');
  const auto = o.eng.improver.autopilot;
  o.eng.employees.update(o.alex.id, { autonomy: 'standard' });
  // A record as clean as one can be: everything asked was approved, everything done passed first time.
  for (let i = 0; i < 6; i++) await ask(o.eng, o.alex, o.shop.id, `tool${i} --check`, 'allow');
  for (let i = 0; i < 8; i++) finished(o);
  o.eng.improver.analyze();
  assert.equal(o.eng.core.improvements.find((i) => i.kind === 'autonomy'), undefined, 'nothing offers a higher level');
  // A proposal that names one (an old record, or somebody's script) waits for a person.
  for (const level of ['auto', 'unrestricted'] as const) {
    const up = proposal(o.eng, 'autonomy', { type: 'employee.autonomy', employeeId: o.alex.id, level });
    o.eng.improver.autopilot.run();
    assert.equal(up.status, 'proposed', level);
    assert.match((auto.verdict(up) as any).why, /a person's to give/, level);
  }
  assert.equal(o.eng.core.employees.require(o.alex.id).autonomy, 'standard');
});

test('a change made when there were six levels is not put back onto a level that no longer exists', async () => {
  const o = await office('off');
  // Applied for real, then made to read as a record of that time: "was Supervised, put on Standard".
  const old = proposal(o.eng, 'autonomy', { type: 'employee.autonomy', employeeId: o.alex.id, level: 'standard' });
  o.eng.improver.apply(old.id);
  (old.autopilot!.undo as any).previous = 'supervised';
  o.eng.core.put('improvement', old);
  const back = o.eng.improver.autopilot.revert(old.id);
  assert.equal(back.autopilot!.reverted!.restored, false);
  assert.match(back.autopilot!.reverted!.note, /a level that no longer exists \("supervised"\)/);
  assert.equal(o.eng.core.employees.require(o.alex.id).autonomy, 'standard');
});

test('"trusted" switches review off only after a run of clean reviews, and back on when work needs rework', async () => {
  const o = await office('trusted', { autopilotReviewOffTasks: 3 });
  o.eng.tasks.updateProject(o.shop.id, { policy: { requireReview: true } });
  const off = proposal(o.eng, 'review_policy', { type: 'project.requireReview', projectId: o.shop.id, value: false });
  finished(o, { reviewed: true });
  finished(o, { reviewed: true, friction: { reviewRejections: 1 } });
  finished(o, { reviewed: true });
  o.eng.improver.autopilot.run();
  assert.equal(off.status, 'proposed');
  assert.match((o.eng.improver.autopilot.verdict(off) as any).why, /1 of the last 3 reviewed tasks were sent back/);
  finished(o, { reviewed: true });
  finished(o, { reviewed: true });
  o.eng.improver.autopilot.run();
  assert.equal(off.status, 'applied');
  assert.equal(project(o).policy.requireReview, false);
  // The owner reviews something by hand and sends it back: review is on again.
  const t = o.eng.tasks.createTask({ projectId: o.shop.id, title: 'Unreviewed', assigneeId: o.alex.id, released: false });
  o.eng.core.event({ type: 'task.review_completed', source: 'owner', summary: 'changes requested', taskId: t.id, projectId: o.shop.id, employeeId: o.alex.id, data: { key: t.key, verdict: 'changes_requested' } });
  assert.deepEqual([off.status, project(o).policy.requireReview], ['proposed', true]);
  assert.match(off.autopilot!.reverted!.reason, /needed rework after review had been switched off/);
});

test('the owner\'s undo restores exactly what was there, for every kind of action, and twice is once', async () => {
  const o = await office('off');
  const auto = o.eng.improver.autopilot;
  const p = o.shop.id;
  o.eng.tasks.updateProject(p, { policy: { allow: ['Bash(ls:*)', 'Bash(jq:*)'], deny: ['Bash(nc:*)'] }, verifyTimeoutSec: 90 });
  const made = {
    allow: proposal(o.eng, 'allow_rule', { type: 'project.policy.allow', projectId: p, rule: 'Bash(docker build:*)' }),
    deny: proposal(o.eng, 'deny_rule', { type: 'project.policy.deny', projectId: p, rule: 'Bash(wget:*)' }),
    review: proposal(o.eng, 'review_policy', { type: 'project.requireReview', projectId: p, value: true }),
    timeout: proposal(o.eng, 'verify_timeout', { type: 'project.verifyTimeout', projectId: p, seconds: 180 }),
    autonomy: proposal(o.eng, 'autonomy', { type: 'employee.autonomy', employeeId: o.alex.id, level: 'standard' }),
    advice: proposal(o.eng, 'sequencing', { type: 'advice' }, { projectId: p }),
  };
  const snapshot = () => ({ allow: [...project(o).policy.allow], deny: [...project(o).policy.deny], review: project(o).policy.requireReview, timeout: project(o).verifyTimeoutSec, autonomy: o.eng.core.employees.require(o.alex.id).autonomy });
  const before = snapshot();
  for (const i of Object.values(made)) o.eng.improver.apply(i.id);
  assert.deepEqual(snapshot(), { allow: ['Bash(ls:*)', 'Bash(jq:*)', 'Bash(docker build:*)'], deny: ['Bash(nc:*)', 'Bash(wget:*)'], review: true, timeout: 180, autonomy: 'standard' });
  for (const i of Object.values(made)) {
    const back = auto.revert(i.id, 'member:Vera');
    assert.deepEqual([back.status, back.autopilot!.reverted!.by, back.autopilot!.noAuto], ['dismissed', 'member:Vera', true], i.kind);
    assert.equal(back.autopilot!.reverted!.restored, i.action.type !== 'advice', i.kind);
  }
  assert.deepEqual(snapshot(), before, 'everything is exactly as it was, other rules untouched');
  // On the record, as a person's act.
  const reverted = events(o.eng, 'learning.reverted');
  assert.equal(reverted.length, 6);
  assert.ok(reverted.every((e) => e.data.auto === false && e.data.area === 'autopilot' && e.data.by === 'member:Vera'));
  assert.equal(o.eng.core.store.recentAudit(40).filter((a) => a.action === 'improvement.reverted' && a.actor === 'member:Vera').length, 6);
  // Twice is once.
  const again = auto.revert(made.allow.id);
  assert.equal(again.autopilot!.reverted!.by, 'member:Vera');
  assert.equal(events(o.eng, 'learning.reverted').length, 6);
  assert.deepEqual(snapshot(), before);
  // Something that was never applied has nothing to undo.
  assert.throws(() => auto.revert(proposal(o.eng, 'deny_rule', { type: 'project.policy.deny', projectId: p, rule: 'Bash(x:*)' }).id), /not applied \(proposed\)/);
  assert.throws(() => auto.revert('nope'), /not found/);
});

test('undo only undoes its own change: a rule that was already there stays, a value changed by hand since is left alone', async () => {
  const o = await office('off');
  const auto = o.eng.improver.autopilot;
  const p = o.shop.id;
  // The rule existed before the suggestion was applied: applying added nothing, so undoing removes nothing.
  o.eng.tasks.updateProject(p, { policy: { deny: ['Bash(wget:*)'] } });
  const had = proposal(o.eng, 'deny_rule', { type: 'project.policy.deny', projectId: p, rule: 'Bash(wget:*)' });
  o.eng.improver.apply(had.id);
  assert.equal(had.autopilot!.undo && 'added' in had.autopilot!.undo && had.autopilot!.undo.added, false);
  assert.deepEqual([auto.revert(had.id).autopilot!.reverted!.restored, project(o).policy.deny], [false, ['Bash(wget:*)']]);
  // The owner set another value afterwards: theirs stands.
  const timeout = proposal(o.eng, 'verify_timeout', { type: 'project.verifyTimeout', projectId: p, seconds: 480 });
  const level = proposal(o.eng, 'autonomy', { type: 'employee.autonomy', employeeId: o.alex.id, level: 'standard' });
  o.eng.improver.apply(timeout.id);
  o.eng.improver.apply(level.id);
  o.eng.tasks.updateProject(p, { verifyTimeoutSec: 900 });
  o.eng.employees.update(o.alex.id, { autonomy: 'unrestricted' });
  assert.match(auto.revert(timeout.id).autopilot!.reverted!.note, /changed by hand since/);
  assert.match(auto.revert(level.id).autopilot!.reverted!.note, /changed by hand since/);
  assert.deepEqual([project(o).verifyTimeoutSec, o.eng.core.employees.require(o.alex.id).autonomy], [900, 'unrestricted']);
  // Applied before the office kept undo records: a rule can still be removed exactly; a value cannot be guessed.
  o.eng.tasks.updateProject(p, { policy: { allow: ['Bash(old:*)'] } });
  const oldRule = proposal(o.eng, 'allow_rule', { type: 'project.policy.allow', projectId: p, rule: 'Bash(old:*)' }, { status: 'applied' });
  const oldLevel = proposal(o.eng, 'autonomy', { type: 'employee.autonomy', employeeId: o.alex.id, level: 'auto' }, { status: 'applied' });
  assert.equal(auto.revert(oldRule.id).autopilot!.reverted!.restored, true);
  assert.deepEqual(project(o).policy.allow, []);
  assert.throws(() => auto.revert(oldLevel.id), /cannot be put back exactly/);
  assert.equal(oldLevel.status, 'applied');
});

test("a member's own computer: permissions change only on that member's own decisions", async () => {
  const o = await office('trusted');
  const auto = o.eng.improver.autopilot;
  o.eng.core.put('host', hostOf({ id: 'pc', name: "Jovan's computer", local: false, memberId: 'm-jovan', memberName: 'Jovan' }));
  const notes = await o.eng.tasks.createProject({ name: 'Notes', hostId: 'pc', policy: { autoAssign: false, requireReview: true } });
  const lola = o.eng.employees.create({ name: 'Lola', roleKey: 'fullstack', hostId: 'pc', projectId: notes.id, workingDir: '/tmp/notes', autonomy: 'auto' });
  const mine = { ...o, shop: notes, alex: lola };
  const policy = () => o.eng.core.projects.require(notes.id).policy;

  // An owner approved and denied on Jovan's computer: that is not Jovan's evidence.
  await approve(mine, 'docker build', 6, { actor: 'owner' });
  await deny(mine, 'wget', 3, { actor: 'member:Ana' });
  o.eng.improver.analyze();
  const [allowRule, denyRule] = [imp(o.eng, (i) => i.kind === 'allow_rule'), imp(o.eng, (i) => i.kind === 'deny_rule')];
  assert.deepEqual([allowRule.status, denyRule.status], ['proposed', 'proposed']);
  assert.match((auto.verdict(allowRule) as any).why, /member's own computer: 0 of the 5 approvals needed are that member's own/);
  assert.match((auto.verdict(denyRule) as any).why, /fewer than 3 of the denials are that member's own/);
  assert.deepEqual([policy().allow, policy().deny], [[], []]);
  // Who decided is kept with each request, from the audit entry.
  assert.deepEqual([...new Set(o.eng.core.questions.filter((q) => q.projectId === notes.id).map((q) => q.autopilotDecidedBy))].sort(), ['member:Ana', 'owner']);

  // Jovan's own decisions do count, for his own computer.
  await approve(mine, 'docker build', 5, { actor: 'member:Jovan' });
  await deny(mine, 'wget', 3, { actor: 'member:Jovan' });
  o.eng.improver.analyze();
  assert.deepEqual([allowRule.status, denyRule.status], ['applied', 'applied']);
  assert.deepEqual([policy().allow, policy().deny], [['Bash(docker build:*)'], ['Bash(wget:*)']]);

  // Lower autonomy and "review off" rest on nobody's decision: never automatic there. A longer timeout touches no permission.
  const down = proposal(o.eng, 'autonomy', { type: 'employee.autonomy', employeeId: lola.id, level: 'standard' });
  const reviewOff = proposal(o.eng, 'review_policy', { type: 'project.requireReview', projectId: notes.id, value: false });
  const longer = proposal(o.eng, 'verify_timeout', { type: 'project.verifyTimeout', projectId: notes.id, seconds: 600 });
  timedOut(mine, notes.id);
  timedOut(mine, notes.id);
  o.eng.core.updateSettings({ selfImprovement: { autopilotMaxPerDay: 20 } } as any);
  o.eng.improver.autopilot.run();
  assert.deepEqual([down.status, reviewOff.status, longer.status], ['proposed', 'proposed', 'applied']);
  assert.match((auto.verdict(down) as any).why, /member's own computer/);
  assert.match((auto.verdict(reviewOff) as any).why, /member's own computer/);

});

test('"safe" switches on a lesson that is scoped to one employee — once, and only their own', async () => {
  const o = await office('safe');
  const sarah = o.eng.employees.create({ name: 'Sarah', roleKey: 'frontend', projectId: o.shop.id, hostId: 'host-1', workingDir: '/tmp/x' });
  const own = o.eng.improver.recordFromOwner({ text: 'Run the linter before calling complete_task.', scope: 'employee', employeeId: o.alex.id });
  const shared = o.eng.improver.recordFromOwner({ text: 'Dates are ISO 8601 everywhere in this project.', scope: 'project', projectId: o.shop.id });
  const foreign = o.eng.improver.recordFromOwner({ text: 'Always ask Sarah before touching the stylesheet.', scope: 'employee', employeeId: o.alex.id });
  o.eng.core.put('lesson', { ...foreign, authoredBy: { kind: 'employee', id: sarah.id, name: 'Sarah' } });
  for (const l of [own, shared, foreign]) o.eng.improver.updateLesson(l.id, { status: 'proposed' });
  o.eng.improver.analyze();
  const status = (id: string) => o.eng.core.lessons.require(id).status;
  assert.deepEqual([status(own.id), status(shared.id), status(foreign.id)], ['active', 'proposed', 'proposed'], 'team lessons and lessons written by someone else wait');
  const [e] = events(o.eng, 'learning.applied');
  assert.deepEqual([e!.data.lessonId, e!.data.auto, e!.data.widening], [own.id, true, false]);
  assert.deepEqual(e!.data.undo, { lessonId: own.id, route: `PATCH /api/lessons/${own.id}`, restore: { status: 'proposed' } });
  assert.ok(o.eng.core.notifications.find((n) => /^Applied by itself: a lesson for Alex/.test(n.title))?.resolvedAt);
  // The owner switches it back off: the office does not switch it on a second time.
  o.eng.improver.updateLesson(own.id, { status: 'proposed' });
  o.eng.improver.analyze();
  assert.equal(status(own.id), 'proposed');
  // On "off" nothing of the kind happens.
  const quiet = await office('off');
  const l = quiet.eng.improver.recordFromOwner({ text: 'Run the linter before calling complete_task.', scope: 'employee', employeeId: quiet.alex.id });
  quiet.eng.improver.updateLesson(l.id, { status: 'proposed' });
  quiet.eng.improver.analyze();
  assert.equal(quiet.eng.core.lessons.require(l.id).status, 'proposed');
});

test('command shapes read the way the analyser names its rules', () => {
  assert.deepEqual(['docker build -t x .', 'npm run test:unit', 'git --version', 'wget https://x', 'node -e "1"', '$(whoami)', '  ls   -la  && rm x'].map(commandShape), ['docker build', 'npm run', 'git', 'wget', 'node', null, 'ls']);
  // A program named by its path is no shape to write a rule for: `Bash(/bin/bash:*)` would allow everything, and the list of words never to allow alone does not know paths.
  assert.deepEqual(["/bin/bash -c 'ls'", '/usr/bin/env ls', './run.sh --all', '~/bin/tool x', 'C:\\tools\\x.exe y'].map(commandShape), [null, null, null, null, null]);
  // A variable set before the command is no command (the live office was offered "Pre-approve S=/tmp/…/scratchpad": a
  // rule for one session's folder that would let anything after it run).
  assert.deepEqual(['S=/tmp/claude-1000/x/scratchpad; curl -s https://x', 'FOO=1 npm test', 'export P=x'].map(commandShape), [null, null, 'export']);
});

test('the suggestions name rules by the same reading (it differed: paths and assignments were offered as rules)', () => {
  const eng = new Engine({ store: new Store(':memory:'), agents: { rpc: () => Promise.reject(new Error('no')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined }, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const shape = (c: string) => (eng.improver as any).commandShape(c);
  assert.deepEqual(['S=/tmp/x/scratchpad; curl x', '/bin/bash -c ls', 'npm run build'].map(shape), [null, null, 'npm run']);
  // One offered before, read wrongly, is taken back; a right one stays.
  const now = new Date().toISOString();
  const offer = (id: string, rule: string) => eng.core.put('improvement', { id, kind: 'allow_rule', title: id, rationale: '', evidence: [], projectId: null, employeeId: null, action: { type: 'project.policy.allow', projectId: 'p', rule }, status: 'proposed', dedupeKey: id, createdAt: now, decidedAt: null } as never);
  offer('bad', 'Bash(S=/tmp/claude-1000/x/scratchpad:*)');
  offer('good', 'Bash(cd:*)');
  eng.improver.analyze();
  assert.equal(eng.core.improvements.get('bad')!.status, 'dismissed');
  assert.equal(eng.core.improvements.get('good')!.status, 'proposed');
});
