import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession, Host } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { handleMcpPost } from '@orchestrator/integrations';
import { Engine, roundDecision, sanitizeForeman, systemPromptFor, type AgentLink } from '../src/index.ts';

/**
 * An engine whose one host is "online" but runs nothing: pasting into a session succeeds, every
 * other request to the host fails. Enough to exercise what the foreman's rounds decide and what its
 * tools allow, without any session.
 */
const pasted: string[] = [];
const asked: string[] = [];
/** Machines that are not in the office right now (a member's computer whose owner went home). */
const offline = new Set<string>();
const link: AgentLink = {
  rpc: (_host, rpc) => {
    asked.push(rpc.method);
    if (rpc.method !== 'session.paste') return Promise.reject(new Error('this test host runs nothing'));
    pasted.push(String((rpc.params as { text: string }).text));
    return Promise.resolve({ via: 'terminal' } as any);
  },
  isOnline: (host) => !offline.has(host),
  respondHook: () => false,
  disconnect: () => undefined,
};
let eng: Engine;
const id: Record<string, string> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function session(employeeId: string, over: Partial<AgentSession> = {}): AgentSession {
  const now = new Date().toISOString();
  const s: AgentSession = {
    id: `s-${employeeId.slice(0, 8)}`, employeeId, hostId: id.host!, origin: 'managed', mode: 'interactive_cli', tmuxSession: 'x', tmuxPane: '%1', cwd: '/tmp/x', repoRoot: null, branch: null, claudeSessionId: 'c',
    status: 'running', activity: 'idle', activityDetail: null, activitySince: now, inTurn: false, control: 'AGENT_CONTROLLED', controllerId: null,
    capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false },
    permissionMode: null, model: null, cols: 120, rows: 34, pid: 1, usage: null, startedAt: now, endedAt: null, lastEventAt: now, exitReason: null, ...over,
  };
  return eng.core.put('session', s);
}
/** Call an MCP tool as an employee, the way the server does once the session token has said who it is. */
async function call(who: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const employee = eng.core.employees.require(id[who]!);
  const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, eng.mcp, { employee, session: eng.core.sessionOf(employee.id) ?? session(employee.id, { status: 'exited' }) });
  return { text: res.body.result.content[0].text, isError: res.body.result.isError };
}
const roundEvents = (what: string) => eng.core.store.queryEvents({ types: [`foreman.round.${what}`] as any });

before(async () => {
  eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1', timings: { foremanSettleMs: 0, foremanMinGapMs: 1000, deliverySettleMs: 0 } }, { send: () => undefined });
  const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  id.host = host.id;
  // Work is assigned by hand here, so the scheduler leaves unassigned tasks alone.
  id.shop = (await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } })).id;
  for (const [name, role] of [['Alex', 'backend'], ['Sarah', 'frontend'], ['Mira', 'foreman']] as const) id[name] = eng.employees.create({ name, roleKey: role, projectId: role === 'foreman' ? null : id.shop, hostId: host.id, workingDir: '/tmp/x' }).id;
});

test('the foreman role: supervises, cannot edit files, and is never given work by the scheduler', () => {
  const mira = eng.core.employees.require(id.Mira!);
  // Hiring a foreman is asking for its rounds: they are on from then. (Paused again here, for the tests that start from "off".)
  assert.equal(eng.core.settings.foreman.enabled, true);
  eng.core.updateSettings({ foreman: { enabled: false } } as any);
  assert.deepEqual([mira.title, mira.department, mira.autonomy], ['Foreman', 'Management', 'standard']);
  assert.deepEqual(mira.disallowedTools, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  const prompt = systemPromptFor({ ...mira, autonomy: 'auto' }, undefined, 'Acme', true);
  assert.match(prompt, /You never approve permission requests/);
  assert.match(prompt, /office_overview[\s\S]*look_at[\s\S]*answer_question[\s\S]*escalate_to_owner[\s\S]*finish_round/);
  assert.ok(!/complete_task|implement, test, fix, commit|git worktree/.test(prompt), "a foreman is not told to do a worker's job, even on auto");
  // A worker's prompt is unchanged by the foreman's existence.
  assert.ok(!/office_overview/.test(systemPromptFor(eng.core.employees.require(id.Alex!), undefined, 'Acme', true)));
});

test('one foreman for the whole office: on the office\'s own machine, with no desk', () => {
  const mira = eng.core.employees.require(id.Mira!);
  assert.equal(mira.deskId, null, 'a foreman is not seated');
  assert.ok(eng.core.employees.require(id.Alex!).deskId, 'everyone else is');
  assert.throws(() => eng.employees.update(mira.id, { deskId: eng.employees.freeDesk()! }), /a foreman has no desk: it walks the floor/);
  assert.throws(() => eng.employees.create({ name: 'Second', roleKey: 'foreman', hostId: id.host! }), /the office already has a foreman \(Mira\)/);
  assert.throws(() => eng.employees.update(id.Alex!, { roleKey: 'foreman' }), /the office already has a foreman \(Mira\)/);
  assert.equal(eng.core.employees.require(id.Alex!).roleKey, 'backend', 'a refused change leaves them as they were');
  // Rearranging the office seats whoever has no desk — never the foreman.
  eng.updateLayout(structuredClone(eng.core.layout));
  assert.equal(eng.core.employees.require(mira.id).deskId, null);
  // An office from before: a foreman who still sits somewhere gives the desk up when the office starts.
  const desk = eng.employees.freeDesk()!;
  eng.core.put('employee', { ...mira, deskId: desk });
  eng.employees.unseatForemen();
  assert.equal(eng.core.employees.require(mira.id).deskId, null);
  // Not on a member's own computer: it looks after the whole office from the office's machine.
  const other = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  other.core.put('host', { id: 'pc', name: "Jovan's computer", status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: false, memberId: 'm1', memberName: 'Jovan' } satisfies Host);
  assert.throws(() => other.employees.create({ name: 'Mira', roleKey: 'foreman', hostId: 'pc' }), /runs on one of the office's own machines, not on a member's own computer/);
  assert.throws(() => other.employees.create({ name: 'Mira', roleKey: 'foreman', hostId: 'pc', deskId: 'm:pc:1' }), /not on a member's own computer/);
  assert.equal(other.core.settings.foreman.enabled, false, 'a refused hire switches nothing on');
});

test('foreman settings: off until a foreman is hired, and whatever is typed is brought inside sane bounds', () => {
  assert.deepEqual(eng.core.settings.foreman, { enabled: false, minGapSeconds: 120, quietCheckMinutes: 15, answersQuestions: true, idleMinutes: 10 });
  assert.equal(new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined }).core.settings.foreman.enabled, false, 'an office with no foreman: off');
  const d = eng.core.settings.foreman;
  assert.deepEqual(sanitizeForeman({ enabled: 'yes', minGapSeconds: -5, quietCheckMinutes: 2, answersQuestions: 0, idleMinutes: -3 }, d), { enabled: false, minGapSeconds: 30, quietCheckMinutes: 5, answersQuestions: true, idleMinutes: 0 });
  assert.deepEqual(sanitizeForeman({ enabled: true, minGapSeconds: 99999, quietCheckMinutes: 0, answersQuestions: false, idleMinutes: 99999 }, d), { enabled: true, minGapSeconds: 3600, quietCheckMinutes: 0, answersQuestions: false, idleMinutes: 1440 });
  // Settings stored before "idle" existed get the default.
  assert.equal(sanitizeForeman({}, { enabled: true, minGapSeconds: 120, quietCheckMinutes: 15, answersQuestions: true } as any).idleMinutes, 10);
  assert.deepEqual(sanitizeForeman({ minGapSeconds: 'soon', quietCheckMinutes: NaN }, d), d);
  assert.deepEqual(sanitizeForeman('nonsense', d), d);
  assert.deepEqual(sanitizeForeman(null, d), d);
  // Through the settings themselves: a partial patch changes only what it names, and other settings are untouched.
  const before = eng.core.settings.selfImprovement;
  assert.deepEqual(eng.core.updateSettings({ foreman: { quietCheckMinutes: 61.4 } } as any).foreman, { ...d, quietCheckMinutes: 61 });
  assert.deepEqual(eng.core.updateSettings({ companyName: 'Acme' }).foreman, { ...d, quietCheckMinutes: 61 });
  assert.deepEqual(eng.core.updateSettings({ foreman: null } as any).foreman, { ...d, quietCheckMinutes: 61 }, 'a null patch cannot wipe the settings');
  assert.deepEqual(eng.core.settings.selfImprovement, before);
  eng.core.updateSettings({ foreman: { quietCheckMinutes: 15 } } as any);
});

test('when a round is due is a plain rule: something new, the previous round over, and the gap passed', () => {
  const base = { now: 1_000_000, inFlight: false, fresh: 0, lastRoundAt: null as number | null, minGapMs: 120_000, quietCheckMs: 15 * 60_000, lastCheckAt: null as number | null, changed: false };
  assert.equal(roundDecision(base), null, 'a quiet office: no round');
  assert.equal(roundDecision({ ...base, fresh: 2 }), 'attention');
  assert.equal(roundDecision({ ...base, fresh: 2, inFlight: true }), null, 'never two rounds at once');
  assert.equal(roundDecision({ ...base, fresh: 2, lastRoundAt: base.now - 119_000 }), null, 'not before the gap has passed');
  assert.equal(roundDecision({ ...base, fresh: 2, lastRoundAt: base.now - 120_000 }), 'attention');
  // Nothing new: at most a quiet check, only if the office changed, and only once per interval.
  const quiet = { ...base, lastRoundAt: base.now - 16 * 60_000, lastCheckAt: base.now - 16 * 60_000 };
  assert.equal(roundDecision({ ...quiet, changed: false }), null, 'nothing changed: nothing to look at');
  assert.equal(roundDecision({ ...quiet, changed: true }), 'quiet_check');
  assert.equal(roundDecision({ ...quiet, changed: true, lastCheckAt: base.now - 14 * 60_000 }), null, 'too soon after the last look');
  assert.equal(roundDecision({ ...quiet, changed: true, quietCheckMs: 0 }), null, 'quiet checks switched off');
  assert.equal(roundDecision({ ...base, changed: true }), null, 'no baseline yet: no quiet check');
});

test('what needs attention is computed from recorded state — and a permission request is never part of it', async () => {
  assert.deepEqual(eng.foreman.attention(), []);
  const alex = eng.core.employees.require(id.Alex!);
  const q = eng.comms.createQuestion({ kind: 'question', channel: 'mcp_tool', employee: alex, session: null, text: 'Which port should the dev server use?' });
  const approval = eng.comms.createQuestion({ kind: 'permission', channel: 'permission_hook', employee: alex, session: null, text: 'Alex wants to run: git push', tool: { name: 'Bash', input: { command: 'git push' } } });
  const decision = eng.comms.createQuestion({ kind: 'decision', channel: 'mcp_tool', employee: alex, session: null, text: 'Rewrite it in Rust?' });
  const own = eng.comms.createQuestion({ kind: 'question', channel: 'mcp_tool', employee: eng.core.employees.require(id.Mira!), session: null, text: 'What is the budget?' });
  const ready = eng.tasks.createTask({ projectId: id.shop!, title: 'Write the changelog' });
  const stuck = eng.tasks.createTask({ projectId: id.shop!, title: 'Fix the login' });
  eng.tasks.updateTask(stuck.id, { status: 'BLOCKED' });
  Object.assign(id, { q: q.id, approval: approval.id, decision: decision.id, own: own.id, ready: ready.id, stuck: stuck.id });

  const items = eng.foreman.attention();
  assert.deepEqual(items.map((i) => i.kind).sort(), ['blocked', 'question', 'unassigned']);
  assert.deepEqual(items.find((i) => i.kind === 'question')!.questionId, q.id, "only the employee's question: not the approval, not the decision for the owner, not the foreman's own");
  assert.match(items.find((i) => i.kind === 'unassigned')!.text, /^T-\d+ "Write the changelog" \[feature, normal\] in Shop is ready and unassigned — free now: Alex \(Senior Backend Engineer\), Sarah \(Frontend Engineer\)$/, 'the foreman is never a candidate');
  assert.match(items.find((i) => i.kind === 'blocked')!.text, /"Fix the login" is blocked: Blocked by the owner/);
  assert.ok(items.every((i) => !i.seen && !i.escalated));

  // Somebody idle with a task in progress counts only once it has lasted (five minutes by default).
  const wip = eng.tasks.createTask({ projectId: id.shop!, title: 'Build the cart' });
  Object.assign(wip, { status: 'IN_PROGRESS', assigneeId: id.Sarah, startedAt: new Date(Date.now() - 20 * 60_000).toISOString(), delivery: { status: 'confirmed', via: 'terminal_paste', ts: null, detail: null } });
  eng.core.put('task', wip);
  const s = session(id.Sarah!, { activity: 'waiting_input', activitySince: new Date(Date.now() - 60_000).toISOString() });
  assert.ok(!eng.foreman.attention().some((i) => i.kind === 'stalled'), 'a minute of quiet is not a stall');
  eng.core.put('session', { ...s, activitySince: new Date(Date.now() - 6 * 60_000).toISOString() });
  assert.match(eng.foreman.attention().find((i) => i.kind === 'stalled')!.text, /^Sarah has been idle for 6m \d+s with T-\d+ "Build the cart" in progress$/);
  eng.core.put('session', { ...s, activity: 'coding', inTurn: true, activitySince: new Date(Date.now() - 6 * 60_000).toISOString() });
  assert.ok(!eng.foreman.attention().some((i) => i.kind === 'stalled'), 'someone who is working is not stalled');
  // Done with that: Sarah is busy from here on, so only Alex is free.
  assert.match(eng.foreman.attention().find((i) => i.kind === 'unassigned')!.text, /free now: Alex \(Senior Backend Engineer\)$/);

  // With answering switched off, questions are the owner's alone.
  eng.core.updateSettings({ foreman: { answersQuestions: false } } as any);
  assert.ok(!eng.foreman.attention().some((i) => i.kind === 'question'));
  assert.match((await call('Mira', 'answer_question', { question_id: q.id, answer: '4000' })).text, /switched off answering by the foreman/);
  assert.equal(eng.core.questions.require(q.id).status, 'open');
  eng.core.updateSettings({ foreman: { answersQuestions: true } } as any);
});

test('only a foreman sees and can use the foreman tools', async () => {
  const names = async (who: string) => {
    const employee = eng.core.employees.require(id[who]!);
    const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, eng.mcp, { employee, session: eng.core.sessionOf(employee.id)! });
    return res.body.result.tools.map((t: any) => t.name) as string[];
  };
  const foremanTools = ['office_overview', 'look_at', 'answer_question', 'assign_task', 'create_task', 'tell_employee', 'escalate_to_owner', 'finish_round'];
  const mine = await names('Mira');
  const theirs = await names('Alex');
  for (const t of foremanTools) {
    assert.ok(mine.includes(t), `the foreman is shown ${t}`);
    assert.ok(!theirs.includes(t), `a backend engineer is not shown ${t}`);
  }
  assert.ok(theirs.includes('ask_boss') && mine.includes('send_message'));
  // Not being shown a tool is not the protection: calling it anyway is refused, and recorded.
  for (const t of foremanTools) {
    const res = await call('Alex', t, { employee: 'Sarah', question_id: id.q, answer: 'x', task: 'T-1', project: 'Shop', title: 't', description: 'd', summary: 's', detail: 'd', message: 'm' });
    assert.deepEqual([res.isError, res.text], [true, `Only the foreman can use ${t}. You are Senior Backend Engineer; use ask_boss, send_message or request_collaboration instead.`]);
  }
  assert.equal(eng.core.store.recentAudit(200).filter((a) => a.actor === 'employee:Alex' && a.action === 'foreman.tool_refused').length, foremanTools.length);
  assert.equal(eng.core.questions.require(id.q!).status, 'open');
  assert.equal(eng.core.notifications.filter((n) => /^Foreman /.test(n.title)).length, 0);
});

test('the foreman answers a question, but can never decide an approval or a decision that is the owner\'s', async () => {
  for (const [qid, why] of [[id.approval, /Only the owner can decide a permission request/], [id.decision, /This is a decision for the owner/]] as const) {
    const res = await call('Mira', 'answer_question', { question_id: qid, answer: 'allow' });
    assert.equal(res.isError, true);
    assert.match(res.text, why);
    const q = eng.core.questions.require(qid!);
    assert.deepEqual([q.status, q.answer, q.decision], ['open', null, null]);
  }
  // The engine holds the same line itself, whoever calls it.
  await assert.rejects(eng.comms.answer(id.approval!, { decision: 'allow' }, 'foreman:Mira', { kind: 'foreman', id: id.Mira!, name: 'Mira' }), /Only the owner can decide this/);
  assert.equal(eng.core.questions.require(id.approval!).status, 'open');
  assert.match((await call('Mira', 'answer_question', { question_id: id.own, answer: 'plenty' })).text, /your own question/);
  assert.match((await call('Mira', 'answer_question', { question_id: 'nope', answer: 'x' })).text, /No question "nope"/);

  const lessons = eng.core.lessons.size;
  const ok = await call('Mira', 'answer_question', { question_id: id.q, answer: 'Use 4000.' });
  assert.deepEqual([ok.isError, ok.text], [false, "Answered Alex's question on the owner's behalf. It is on the record as answered by you."]);
  const q = eng.core.questions.require(id.q!);
  assert.deepEqual([q.answer, q.answeredBy], ['Use 4000.', { kind: 'foreman', id: id.Mira, name: 'Mira' }]);
  assert.equal(eng.core.lessons.size, lessons, "a foreman's answer is not recorded as a decision by the boss");
  assert.match((await call('Mira', 'answer_question', { question_id: id.q, answer: 'Use 5000.' })).text, /no longer open/);
  assert.equal(eng.core.questions.require(id.q!).answer, 'Use 4000.', 'whoever answered first counts');
});

test('overview, a look at a desk with no session, assigning, creating and escalating all act on real state', async () => {
  const overview = (await call('Mira', 'office_overview')).text;
  assert.match(overview, /^Office overview — 2 employees, 1 project\./);
  assert.match(overview, /- Alex — Senior Backend Engineer · Shop · .* · no task in progress.* · open approval request \(the boss decides\) /);
  assert.match(overview, /- Shop \(active, work is assigned by hand\): BACKLOG 0 · READY 1 · IN_PROGRESS 1 · REVIEW 0 · BLOCKED 1 · DONE 0/);
  assert.match(overview, /Ready and unassigned: T-\d+ \[feature, normal\] "Write the changelog"/);
  assert.match(overview, /Blocked: T-\d+ "Fix the login" \(unassigned\): Blocked by the owner/);
  assert.ok(!/Mira/.test(overview), 'the foreman is not in its own overview');

  // Alex has no running session: the foreman is told so; no screen is made up.
  const seq = eng.core.store.queryEvents({ types: ['foreman.visit'] }).length;
  const look = (await call('Mira', 'look_at', { employee: 'alex' })).text;
  assert.match(look, /^Alex — Senior Backend Engineer · Shop\nSession: (none yet|not running)/);
  assert.match(look, /Their terminal screen: not available \(no session is running\)\.$/);
  const visit = eng.core.store.queryEvents({ types: ['foreman.visit'] }).slice(seq)[0]!;
  assert.deepEqual([visit.employeeId, visit.data.fromEmployeeId, visit.data.toEmployeeId, visit.data.screen], [id.Mira, id.Mira, id.Alex, false]);
  // With a session and a captured screen, the foreman sees its real last lines — and nothing that looks like a secret.
  const sarah = eng.core.sessionOf(id.Sarah!)!;
  eng.core.gateway.screens.set(sarah.id, { cols: 120, rows: 34, lines: ['\x1b[36m⏺ Bash\x1b[0m npm test', '  ⎿ 12 passing', 'export API_KEY=sk-ant-abcdefghijklmnopqrstuvwx', '', ''], cursor: { x: 0, y: 0, visible: true }, ts: new Date(Date.now() - 3000).toISOString(), hash: 'h' });
  const sarahLook = (await call('Mira', 'look_at', { employee: 'Sarah' })).text;
  assert.match(sarahLook, /Their terminal screen, captured 3s ago \(last 3 lines\):\n```\n⏺ Bash npm test\n {2}⎿ 12 passing\nexport API_KEY=\[REDACTED\]\n```$/);
  assert.match(sarahLook, /Current task: T-\d+ \[IN_PROGRESS\] Build the cart/);
  assert.match((await call('Mira', 'look_at', { employee: 'Nobody' })).text, /No employee matches "Nobody"/);

  // Assigning goes through the task board's own rules.
  const key = eng.core.tasks.require(id.ready!).key;
  assert.match((await call('Mira', 'assign_task', { task: key, employee: 'Mira' })).text, /A foreman supervises and does not take tasks/);
  assert.match((await call('Mira', 'assign_task', { task: 'T-999', employee: 'Alex' })).text, /No task "T-999"/);
  const wip = eng.core.tasks.find((t) => t.title === 'Build the cart')!;
  const moved = await call('Mira', 'assign_task', { task: wip.key, employee: 'Alex' });
  assert.deepEqual([moved.isError, moved.text], [true, `Error: ${wip.key} is in progress; block or finish it before reassigning`]);
  assert.equal(eng.core.tasks.require(wip.id).assigneeId, id.Sarah);
  const assigned = await call('Mira', 'assign_task', { task: key, employee: 'Alex' });
  assert.equal(assigned.isError, false);
  const task = eng.core.tasks.require(id.ready!);
  assert.equal(task.assigneeId, id.Alex);
  assert.ok(task.history.some((h) => h.note === 'Assigned to Alex' && h.by === 'foreman:Mira'));
  // (This test host cannot run it, so it goes back to the backlog before the scheduler tries to start it.)
  eng.tasks.updateTask(task.id, { status: 'BACKLOG' });

  const created = await call('Mira', 'create_task', { project: 'shop', title: 'Add a smoke test', description: 'One request against the health endpoint.', priority: 'high', kind: 'test' });
  assert.match(created.text, /^Created T-\d+ "Add a smoke test" in Shop, unassigned \(READY\)\.$/);
  const made = eng.core.tasks.find((t) => t.title === 'Add a smoke test')!;
  assert.deepEqual([made.createdBy, made.priority, made.kind, made.released], ['foreman:Mira', 'high', 'test', true]);
  assert.match((await call('Mira', 'create_task', { project: 'Nowhere', title: 't', description: 'd' })).text, /No project matches "Nowhere"\. Projects: Shop\./);

  // Escalating: a notification for the owner, the question left open, and no way back for the foreman.
  const esc = await call('Mira', 'escalate_to_owner', { summary: 'Rewrite in Rust?', detail: 'Alex wants to rewrite the service. That is a direction call.', question_id: id.decision });
  assert.match(esc.text, /The owner has been notified\. Alex's question stays open for them/);
  const note = eng.core.notifications.find((n) => n.questionId === id.decision && /^Foreman Mira needs you: Rewrite in Rust\?$/.test(n.title))!;
  assert.match(note.body, /Alex asked: "Rewrite it in Rust\?"\n\nAlex wants to rewrite the service/);
  assert.equal(eng.core.questions.require(id.decision!).status, 'open');
  assert.equal((await call('Mira', 'escalate_to_owner', { summary: 'The CI box is slow', detail: 'Verification takes four minutes.' })).text, 'The owner has been notified.');
  assert.equal((await call('Mira', 'finish_round', { summary: 'nothing' })).text, 'No round is in progress, so there is nothing to record.');
  assert.deepEqual(
    eng.core.store.recentAudit(300).filter((a) => a.actor === 'foreman:Mira').map((a) => a.action).sort().filter((a, i, all) => all.indexOf(a) === i),
    ['foreman.escalated', 'foreman.refused', 'question.answer'],
  );
});

test('rounds: none while switched off; then exactly one for what is new, none for what was already seen', async () => {
  const mira = eng.core.employees.require(id.Mira!);
  session(mira.id); // the foreman's session is up and between turns
  // Left over from the tests above: a blocked task, and the smoke test, ready and unassigned next to Alex, who is free.
  assert.ok(eng.foreman.attention().length >= 2);
  await eng.foreman.tick();
  assert.equal(roundEvents('started').length, 0, 'switched off: nothing is delivered');
  assert.equal(pasted.length, 0);
  assert.equal(eng.foreman.status().round, null);

  eng.core.updateSettings({ foreman: { enabled: true, minGapSeconds: 1 } } as any);
  await eng.foreman.tick();
  const [started] = roundEvents('started');
  assert.equal(roundEvents('started').length, 1);
  assert.deepEqual([started!.data.reason, (started!.data.counts as any).blocked, (started!.data.counts as any).unassigned, started!.employeeId], ['attention', 1, 1, mira.id]);
  await sleep(50); // the delivery queue hands it to the session
  assert.equal(pasted.length, 1, 'one prompt, delivered through the ordinary queue');
  assert.match(pasted[0]!, /^\[ORCH:ROUND:[0-9a-f]{8}\] Foreman round — 2 things need your attention\.\n\nNeeds attention now:\n1\. BLOCKED T-\d+ "Fix the login" is blocked: Blocked by the owner — for \d+s\n2\. UNASSIGNED T-\d+ "Add a smoke test" \[test, high\] in Shop is ready and unassigned — free now: Alex \(Senior Backend Engineer\) — for \d+s\n/);
  assert.match(pasted[0]!, /The team right now:\n- Alex \(Senior Backend Engineer\) — no session · no task\n- Sarah \(Frontend Engineer\) — CODING · T-\d+ "Build the cart"/);
  assert.match(pasted[0]!, /- BLOCKED \/ STALLED: look_at the employee, then tell them what to do with tell_employee[^\n]*\n- UNASSIGNED: [^\n]*\n- You never approve permission requests/);
  assert.ok(!/- IDLE:/.test(pasted[0]!));
  assert.ok(!/- QUESTION:/.test(pasted[0]!), 'no instructions for what is not in this round');
  assert.equal(eng.foreman.status().round!.outcome, 'running');
  // Claude Code acknowledges the prompt (the UserPromptSubmit hook carries the round's marker).
  eng.comms.confirmMarker(mira.id, 'ROUND', String(started!.data.roundId));

  // While it runs — and however often the office looks — there is no second round.
  for (let i = 0; i < 5; i++) await eng.foreman.tick();
  assert.equal(roundEvents('started').length, 1);
  assert.equal(eng.foreman.status().visiting, null, 'with nobody yet');
  assert.match((await call('Mira', 'look_at', { employee: 'Sarah' })).text, /Sarah — Frontend Engineer/);
  assert.equal(eng.foreman.status().visiting, id.Sarah, 'while the round runs, the office knows who the foreman is with');
  assert.equal((await call('Mira', 'finish_round', { summary: 'Looked at Sarah; the blocked login task needs the owner.' })).text, 'Round recorded. Stop here; you are called again when something needs you.');
  const [finished] = roundEvents('finished');
  assert.deepEqual([finished!.data.outcome, finished!.data.visited, finished!.data.summary], ['finished', 1, 'Looked at Sarah; the blocked login task needs the owner.']);
  const st = eng.foreman.status();
  assert.deepEqual([st.round, st.visiting, st.lastRound!.outcome, st.lastRound!.visited], [null, null, 'finished', [id.Sarah]]);
  assert.ok(st.attention.length >= 2 && st.attention.every((i) => i.seen), 'still open, but the foreman has seen it');

  // The gap passes; the same open items do not call the foreman again.
  await sleep(1100);
  for (let i = 0; i < 3; i++) await eng.foreman.tick();
  assert.equal(roundEvents('started').length, 1, 'nothing new: no round, however long it stays open');
  assert.equal(pasted.length, 1);

  // Something new does — once.
  const q = eng.comms.createQuestion({ kind: 'question', channel: 'mcp_tool', employee: eng.core.employees.require(id.Alex!), session: null, text: 'Tabs or spaces?' });
  await eng.foreman.tick();
  assert.equal(roundEvents('started').length, 2);
  await sleep(50);
  assert.match(pasted[1]!, new RegExp(`Foreman round — 1 thing needs your attention\\.\\n\\nNeeds attention now:\\n1\\. QUESTION ${q.id} from Alex \\(Senior Backend Engineer\\): "Tabs or spaces\\?" — waiting`));
  assert.match(pasted[1]!, /Already seen in earlier rounds and still open \(leave them unless something changed\):\n- BLOCKED /);
  // A foreman who just stops (no finish_round): the end of its turn ends the round.
  eng.foreman.onTurnFinished(id.Alex!);
  assert.equal(eng.foreman.status().round!.outcome, 'running', "somebody else's turn ending is not the foreman's");
  eng.comms.confirmMarker(mira.id, 'ROUND', String(roundEvents('started')[1]!.data.roundId));
  eng.foreman.onTurnFinished(mira.id);
  assert.deepEqual([eng.foreman.status().round, eng.foreman.status().lastRound!.outcome], [null, 'turn_ended']);

  // The quiet check, seen from a quarter of an hour later: nothing new is waiting.
  const later = Date.now() + 16 * 60_000;
  await eng.foreman.tick(later);
  assert.equal(roundEvents('started').length, 2, 'nothing changed since the foreman last looked: no quiet check either');
  // A task is finished meanwhile: the office is not as the foreman left it, so it takes one look — and only one.
  eng.tasks.updateTask(eng.core.tasks.find((t) => t.title === 'Add a smoke test')!.id, { status: 'DONE' });
  assert.ok(eng.foreman.attention().every((i) => i.seen));
  await eng.foreman.tick(later);
  await eng.foreman.tick(later + 60_000);
  assert.equal(roundEvents('started').length, 3);
  assert.deepEqual([roundEvents('started')[2]!.data.reason, roundEvents('started')[2]!.data.fresh], ['quiet_check', 0]);
  await sleep(50);
  assert.match(pasted[2]!, /^\[ORCH:ROUND:[0-9a-f]{8}\] Foreman round — a quiet check: nothing is waiting for you, but the office has changed since you last looked\.\n\nAlready seen in earlier rounds and still open/);
  assert.match(pasted[2]!, /- Call office_overview, look_at anyone who seems stuck/);
  assert.equal((await call('Mira', 'finish_round', { summary: 'All quiet.' })).isError, false);
  eng.core.updateSettings({ foreman: { quietCheckMinutes: 0 } } as any);
  eng.tasks.updateTask(id.stuck!, { status: 'BACKLOG' });
  await eng.foreman.tick(later + 40 * 60_000);
  assert.equal(roundEvents('started').length, 3, 'with quiet checks switched off (0), a change alone starts nothing');
});

test('someone who has stopped and is doing nothing is put in front of the foreman — once per spell, and it can tell them how to continue', async () => {
  const mira = eng.core.employees.require(id.Mira!);
  const base = roundEvents('started').length;
  const since = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  // Nina: a running session between turns, no task in progress, for three minutes: not long enough (ten by default).
  id.Nina = eng.employees.create({ name: 'Nina', roleKey: 'backend', projectId: id.shop, hostId: id.host!, workingDir: '/tmp/x' }).id;
  const s = session(id.Nina!, { status: 'running', activity: 'idle', inTurn: false, activitySince: since(3) });
  const idle = () => eng.foreman.attention().filter((i) => i.kind === 'idle');
  assert.deepEqual(idle(), []);
  eng.core.put('session', { ...s, activitySince: since(11) });
  const [item] = idle();
  assert.match(item!.text, /^Nina \(Senior Backend Engineer\) has been doing nothing for 11m \d+s: no task in progress/);
  assert.deepEqual([item!.employeeId, item!.key, item!.seen], [id.Nina, `idle:${id.Nina}:${eng.core.sessionOf(id.Nina!)!.activitySince}`, false]);
  // Not while they are in a turn, not someone with a task in progress (that is "stalled"), not with the setting at 0.
  eng.core.put('session', { ...s, activity: 'coding', inTurn: true, activitySince: since(11) });
  assert.deepEqual(idle(), []);
  eng.core.put('session', { ...s, activitySince: since(11) });
  assert.ok(!idle().some((i) => i.employeeId === id.Sarah), 'Sarah has a task in progress');
  eng.core.updateSettings({ foreman: { idleMinutes: 0 } } as any);
  assert.deepEqual(idle(), []);
  eng.core.updateSettings({ foreman: { idleMinutes: 10 } } as any);

  // One round for it; the prompt says what to do with someone idle.
  const before = pasted.length;
  // (Claude Code acknowledges the previous round's prompt; until then nothing else is typed into that session.)
  eng.comms.confirmMarker(mira.id, 'ROUND', String(roundEvents('started')[base - 1]!.data.roundId));
  await sleep(1100); // the gap after the previous round
  await eng.foreman.tick();
  assert.equal(roundEvents('started').length, base + 1);
  const started = roundEvents('started')[base]!;
  assert.equal((started.data.counts as any).idle, 1);
  assert.match(started.summary, /starts a round: 1 idle$/);
  await sleep(50);
  const prompt = pasted.slice(before).find((t) => t.startsWith('[ORCH:ROUND:'))!;
  assert.match(prompt, /1\. IDLE Nina \(Senior Backend Engineer\) has been doing nothing for 11m \d+s: no task in progress\n/);
  assert.match(prompt, /- IDLE: look_at them\. [^\n]*tell_employee what to do next[^\n]*leave them be and say so in your summary\./);
  eng.comms.confirmMarker(mira.id, 'ROUND', String(started.data.roundId));

  // The foreman tells them how to continue: an ordinary message under its name, delivered through the ordinary queue.
  const visits = eng.core.store.queryEvents({ types: ['foreman.visit'] }).length;
  const told = await call('Mira', 'tell_employee', { employee: 'Nina', message: 'The tests still fail on the cart page: carry on with that and report when they pass.' });
  assert.deepEqual([told.isError, told.text], [false, 'Told Nina. It is delivered to their session when they can read it.']);
  const msg = eng.core.messages.find((m) => m.toEmployeeId === id.Nina && /carry on with that/.test(m.body))!;
  assert.deepEqual([msg.from.kind, msg.from.id, msg.from.name], ['employee', mira.id, 'Mira (the foreman)']);
  const visit = eng.core.store.queryEvents({ types: ['foreman.visit'] }).slice(visits)[0]!;
  assert.deepEqual([visit.data.toEmployeeId, visit.data.action, visit.summary], [id.Nina, 'tell', 'Mira told Nina what to do next']);
  assert.equal(eng.foreman.status().visiting, id.Nina);
  assert.equal(eng.foreman.status().round!.actions.messaged, 1);
  assert.match((await call('Mira', 'tell_employee', { employee: 'Nina', message: '  ' })).text, /"message" is empty/);
  assert.match((await call('Mira', 'tell_employee', { employee: 'Mira', message: 'x' })).text, /That is you/);
  assert.match((await call('Mira', 'tell_employee', { employee: 'Nobody', message: 'x' })).text, /No employee matches "Nobody"/);
  assert.equal((await call('Mira', 'finish_round', { summary: 'Nina had stopped; told him to carry on.' })).isError, false);

  // The same spell of doing nothing does not call the foreman again, however long it lasts.
  await sleep(1100);
  for (let i = 0; i < 3; i++) await eng.foreman.tick();
  assert.equal(roundEvents('started').length, base + 1, 'left alone: not asked about again');
  eng.core.put('session', { ...s, activitySince: eng.core.sessionOf(id.Nina!)!.activitySince });
  assert.deepEqual(eng.foreman.attention(Date.now() + 30 * 60_000).filter((i) => i.kind === 'idle').map((i) => i.seen), [true]);
  // Nina did what she was told and stopped again. Only the foreman has spoken to her since, so she is left alone
  // for twice as long this time (and four times after that): the two never talk in circles.
  eng.core.put('session', { ...s, activitySince: since(11) });
  assert.deepEqual(idle(), [], 'eleven minutes is no longer enough');
  eng.core.put('session', { ...s, activitySince: since(21) });
  assert.deepEqual(idle().map((i) => i.seen), [false], 'twenty is: a new spell, shown once more');
  // Something from anyone else — the owner writes to her — and the ordinary ten minutes count again.
  eng.core.put('session', { ...s, activitySince: since(11) });
  assert.deepEqual(idle(), []);
  eng.comms.sendMessage({ from: { kind: 'owner', id: null, name: 'the boss' }, toEmployeeId: id.Nina!, body: 'Also update the README.' });
  assert.deepEqual(idle().map((i) => i.seen), [false]);
  // Someone waiting for the owner (an open approval request) is not "doing nothing".
  const wait = eng.comms.createQuestion({ kind: 'permission', channel: 'permission_hook', employee: eng.core.employees.require(id.Nina!), session: null, text: 'Nina wants to run: npm publish', tool: { name: 'Bash', input: { command: 'npm publish' } } });
  assert.deepEqual(idle(), []);
  await eng.comms.answer(wait.id, { decision: 'deny' });
  // (Nina goes back to work, so the tests below start from a quiet office.)
  eng.core.put('session', { ...s, activity: 'coding', inTurn: true });
});

test('the whole office is the foreman\'s: employees on members\' own computers too — but work stays on the computer its project is on', async () => {
  const mira = eng.core.employees.require(id.Mira!);
  const pc: Host = { id: 'pc-jovan', name: "Jovan's computer", status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: false, memberId: 'm-jovan', memberName: 'Jovan' };
  eng.core.put('host', pc);
  const notes = await eng.tasks.createProject({ name: 'Notes', hostId: pc.id, policy: { autoAssign: false } });
  const lola = eng.employees.create({ name: 'Lola', roleKey: 'fullstack', hostId: pc.id, projectId: notes.id, workingDir: '/tmp/notes' });
  id.Lola = lola.id;
  session(lola.id, { hostId: pc.id, status: 'running', activity: 'coding', inTurn: true });

  // Her question is one the foreman is called for — while Jovan's computer is in the office.
  const q = eng.comms.createQuestion({ kind: 'question', channel: 'mcp_tool', employee: lola, session: null, text: 'Markdown or plain text?' });
  assert.ok(eng.foreman.attention().some((i) => i.kind === 'question' && i.questionId === q.id));
  offline.add(pc.id);
  assert.ok(!eng.foreman.attention().some((i) => i.employeeId === lola.id || i.projectId === notes.id), 'a computer that is away is passed by: nothing can be delivered there');
  assert.match((await call('Mira', 'tell_employee', { employee: 'Lola', message: 'Carry on.' })).text, /Lola is on a member's own computer that is not in the office right now/);
  offline.delete(pc.id);

  // Jovan closes his room: what is on his computer is his alone, and the foreman is kept out like everyone else —
  // it is not called for her question, does not look at her screen, answer her, tell her anything or give her work.
  eng.hosts.setMemberRoom('m-jovan', { locked: true }, 'member:Jovan');
  assert.ok(!eng.foreman.attention().some((i) => i.employeeId === lola.id || i.projectId === notes.id), 'a closed room is passed by');
  eng.core.gateway.screens.set(eng.core.sessionOf(lola.id)!.id, { cols: 120, rows: 34, lines: ['a private screen'], cursor: { x: 0, y: 0, visible: true }, ts: new Date().toISOString() } as any);
  const closedLook = await call('Mira', 'look_at', { employee: 'Lola' });
  assert.deepEqual([closedLook.isError, /closed their room/.test(closedLook.text), /private screen/.test(closedLook.text)], [true, true, false]);
  for (const [tool, args] of [['tell_employee', { employee: 'Lola', message: 'Carry on.' }], ['answer_question', { question_id: q.id, answer: 'Markdown.' }]] as const) {
    const refused = await call('Mira', tool, args);
    assert.deepEqual([refused.isError, /closed their room/.test(refused.text)], [true, true], tool);
  }
  assert.equal(eng.core.questions.require(q.id).status, 'open', 'her question waits for Jovan');
  assert.ok(!eng.core.messages.find((m) => m.toEmployeeId === lola.id && m.from.id === mira.id));
  // That she is there is still for everyone — the foreman's overview included. What she works on, has in hand and
  // has asked is not: none of it is in the overview while the room is closed.
  const behindTheDoor = (await call('Mira', 'office_overview')).text;
  assert.match(behindTheDoor, /- Lola — Full-Stack Engineer · on Jovan's own computer, whose room is closed/);
  assert.match(behindTheDoor, /- Notes \(on Jovan's own computer, whose room is closed\)/);
  assert.doesNotMatch(behindTheDoor, /Markdown or plain text|CODING for[^\n]*\n- Notes|Lola[^\n]*(CODING|open question)/);
  // A routine somebody else set for her does not run into the closed room; one her member set does.
  const byOwner = eng.routines.create({ employeeId: lola.id, instruction: 'Report what you are working on.', everyMinutes: 60 }, 'owner');
  const byJovan = eng.routines.create({ employeeId: lola.id, instruction: 'Check the notes for typos.', everyMinutes: 60 }, 'member:Jovan');
  eng.routines.runNow(byOwner.id);
  eng.routines.runNow(byJovan.id);
  const outcome = (id: string) => eng.routines.list().find((r) => r.id === id)!;
  assert.deepEqual([outcome(byOwner.id).lastOutcome, outcome(byOwner.id).lastNote], ['not_run', "Lola's room is closed"]);
  assert.notEqual(outcome(byJovan.id).lastNote, "Lola's room is closed");
  eng.routines.remove(byOwner.id);
  eng.routines.remove(byJovan.id);
  eng.hosts.setMemberRoom('m-jovan', {}, 'member:Jovan');
  assert.ok(eng.foreman.attention().some((i) => i.kind === 'question' && i.questionId === q.id), 'open again: as before');

  // Seen like everyone else, and marked as being on Jovan's computer.
  const overview = (await call('Mira', 'office_overview')).text;
  assert.match(overview, /- Lola — Full-Stack Engineer · Notes · CODING for [^\n]* · no task in progress · on Jovan's own computer/);
  assert.match(overview, /- Notes \(active, work is assigned by hand, on Jovan's own computer: only employees there work on it\)/);
  eng.core.gateway.screens.set(eng.core.sessionOf(lola.id)!.id, { cols: 120, rows: 34, lines: ['writing notes.md'], cursor: { x: 0, y: 0, visible: true }, ts: new Date().toISOString() } as any);
  const look = (await call('Mira', 'look_at', { employee: 'Lola' })).text;
  assert.match(look, /^Lola — Full-Stack Engineer · Notes · on Jovan's own computer\n/);
  assert.match(look, /```\nwriting notes\.md\n```$/, 'the foreman sees her real screen, as an owner would');
  const answered = await call('Mira', 'answer_question', { question_id: q.id, answer: 'Markdown.' });
  assert.deepEqual([answered.isError, eng.core.questions.require(q.id).answeredBy?.name], [false, 'Mira']);
  const told = await call('Mira', 'tell_employee', { employee: 'Lola', message: 'Use Markdown and carry on.' });
  assert.equal(told.isError, false);
  assert.ok(eng.core.messages.find((m) => m.toEmployeeId === lola.id && m.from.id === mira.id));

  // A shared project's task never goes to her; a task of the project on Jovan's computer goes to nobody else.
  const shared = eng.tasks.createTask({ projectId: id.shop!, title: 'Shared work' });
  const own = eng.tasks.createTask({ projectId: notes.id, title: 'Tidy the notes' });
  const toLola = await call('Mira', 'assign_task', { task: shared.key, employee: 'Lola' });
  assert.deepEqual([toLola.isError, toLola.text], [true, `Lola works on a member's own computer and only takes tasks of projects on that computer; "Shop" is not one of them.`]);
  const toSarah = await call('Mira', 'assign_task', { task: own.key, employee: 'Sarah' });
  assert.deepEqual([toSarah.isError, toSarah.text], [true, `"Notes" is on a member's own computer; only employees on that computer can work on it, and Sarah is not one of them.`]);
  assert.match((await call('Mira', 'create_task', { project: 'Notes', title: 'x', description: 'd', assignee: 'Sarah' })).text, /only employees on that computer can work on it/);
  assert.deepEqual([eng.core.tasks.require(shared.id).assigneeId, eng.core.tasks.require(own.id).assigneeId], [null, null]);
  assert.equal(eng.core.store.recentAudit(400).filter((a) => a.actor === 'foreman:Mira' && a.action === 'foreman.refused' && /assign_task|create_task/.test(JSON.stringify(a))).length, 3, 'each refusal is on the record');
  // The digest offers the right people for each: nobody from the other side.
  eng.core.put('session', { ...eng.core.sessionOf(lola.id)!, activity: 'idle', inTurn: false });
  eng.core.put('session', { ...eng.core.sessionOf(id.Nina!)!, activity: 'idle', inTurn: false, activitySince: new Date().toISOString() });
  const unassigned = eng.foreman.attention().filter((i) => i.kind === 'unassigned');
  assert.match(unassigned.find((i) => i.taskId === own.id)!.text, /free now: Lola \(Full-Stack Engineer\)$/);
  const forShared = unassigned.find((i) => i.taskId === shared.id)!.text;
  assert.ok(/free now: .*Nina/.test(forShared) && !/Lola/.test(forShared), forShared);
  const ok = await call('Mira', 'assign_task', { task: own.key, employee: 'Lola' });
  assert.equal(ok.isError, false);
  assert.equal(eng.core.tasks.require(own.id).assigneeId, lola.id);
  eng.tasks.updateTask(own.id, { status: 'BACKLOG' });
  eng.tasks.updateTask(shared.id, { status: 'BACKLOG' });
});

test('a foreman who cannot be reached is a reported problem, not a loop of attempts', async () => {
  // A second office: a foreman with no session, on a host that cannot start one.
  const other = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1', timings: { foremanSettleMs: 0, foremanMinGapMs: 1000 } }, { send: () => undefined });
  other.core.put('host', { id: 'h', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true } satisfies Host);
  const shop = await other.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } });
  other.employees.create({ name: 'Alex', roleKey: 'backend', projectId: shop.id, hostId: 'h' });
  const boss = other.employees.create({ name: 'Mira', roleKey: 'foreman', hostId: 'h' });
  other.tasks.createTask({ projectId: shop.id, title: 'Anything' });
  other.core.updateSettings({ foreman: { enabled: true } } as any);
  await other.foreman.tick();
  assert.match(other.foreman.status().problem!, /Mira has no folder to run in/);
  assert.equal(other.foreman.status().available, false);
  other.employees.update(boss.id, { workingDir: '/tmp/x' });
  asked.length = 0;
  for (let i = 0; i < 4; i++) await other.foreman.tick();
  assert.deepEqual(asked.filter((m) => m === 'session.create'), ['session.create'], 'one attempt to start the session, not one per look');
  const st = other.foreman.status();
  assert.match(st.problem!, /could not start Mira's session on box: this test host runs nothing/);
  assert.equal(other.core.store.queryEvents({ types: ['foreman.round.started'] }).length, 0, 'no round is claimed to have started');
  assert.equal(other.core.notifications.filter((n) => n.title === 'The foreman could not start a round').length, 1, 'the owner is told once, not on every attempt');
  assert.ok(st.attention.every((i) => !i.seen), 'what needed attention still does');
  // No foreman at all: said plainly.
  other.employees.update(boss.id, { archived: true });
  assert.match(other.foreman.status().problem!, /The office has no foreman\. Hire one/);
  assert.equal(other.foreman.status().foreman, null);
});

test("a person's own session is left alone: the foreman does not ask about it when idle, and the scheduler gives it no work", async () => {
  const me = eng.employees.create({ name: 'Boss at desk', roleKey: 'fullstack', projectId: id.shop!, hostId: id.host!, selfDriven: true });
  assert.equal(eng.core.employees.require(me.id).selfDriven, true);
  // Idle for an hour: an ordinary employee would be put in front of the foreman; this one is not.
  session(me.id, { status: 'running', activity: 'idle', inTurn: false, activitySince: new Date(Date.now() - 3600_000).toISOString() });
  assert.ok(!eng.foreman.attention().some((i) => i.kind === 'idle' && i.text.startsWith('Boss at desk')), 'the foreman leaves a person\'s own session alone');
  assert.ok(!eng.foreman.attention().some((i) => i.kind === 'unassigned' && /Boss at desk/.test(i.text)), 'and does not offer it as free hands');
  // A project that assigns by itself: its ready task goes to nobody rather than to the person's session.
  const own = await eng.tasks.createProject({ name: 'Own corner', policy: { autoAssign: true } });
  const only = eng.employees.create({ name: 'Only me here', roleKey: 'fullstack', projectId: own.id, hostId: id.host!, selfDriven: true });
  const t = eng.tasks.createTask({ projectId: own.id, title: 'Nobody should take this', description: 'x', acceptance: 'x' });
  await sleep(50);
  eng.tasks.schedule();
  await sleep(50);
  assert.equal(eng.core.tasks.require(t.id).assigneeId ?? null, null, 'the scheduler did not hand it to the person\'s own session');
  assert.ok(only.id);
  // The same set-up with an ordinary employee: the scheduler does hand the task out (so the check above means something).
  const other = await eng.tasks.createProject({ name: 'Other corner', policy: { autoAssign: true } });
  const worker = eng.employees.create({ name: 'Ordinary worker', roleKey: 'fullstack', projectId: other.id, hostId: id.host! });
  const t2 = eng.tasks.createTask({ projectId: other.id, title: 'Someone takes this', description: 'x', acceptance: 'x' });
  await sleep(50);
  eng.tasks.schedule();
  await sleep(50);
  assert.equal(eng.core.tasks.require(t2.id).assigneeId, worker.id);
});
