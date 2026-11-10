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
const link: AgentLink = {
  rpc: (_host, rpc) => {
    asked.push(rpc.method);
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
  assert.deepEqual([mira.title, mira.department, mira.autonomy], ['Foreman', 'Management', 'restricted']);
  assert.deepEqual(mira.disallowedTools, ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  const prompt = systemPromptFor({ ...mira, autonomy: 'auto' }, undefined, 'Acme', true);
  assert.match(prompt, /You never approve permission requests/);
  assert.match(prompt, /office_overview[\s\S]*look_at[\s\S]*answer_question[\s\S]*escalate_to_owner[\s\S]*finish_round/);
  assert.ok(!/complete_task|implement, test, fix, commit|git worktree/.test(prompt), "a foreman is not told to do a worker's job, even on auto");
  // A worker's prompt is unchanged by the foreman's existence.
  assert.ok(!/office_overview/.test(systemPromptFor(eng.core.employees.require(id.Alex!), undefined, 'Acme', true)));
});

test('foreman settings: off by default, and whatever is typed is brought inside sane bounds', () => {
  assert.deepEqual(eng.core.settings.foreman, { enabled: false, minGapSeconds: 120, quietCheckMinutes: 15, answersQuestions: true });
  const d = eng.core.settings.foreman;
  assert.deepEqual(sanitizeForeman({ enabled: 'yes', minGapSeconds: -5, quietCheckMinutes: 2, answersQuestions: 0 }, d), { enabled: false, minGapSeconds: 30, quietCheckMinutes: 5, answersQuestions: true });
  assert.deepEqual(sanitizeForeman({ enabled: true, minGapSeconds: 99999, quietCheckMinutes: 0, answersQuestions: false }, d), { enabled: true, minGapSeconds: 3600, quietCheckMinutes: 0, answersQuestions: false });
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
  const foremanTools = ['office_overview', 'look_at', 'answer_question', 'assign_task', 'create_task', 'escalate_to_owner', 'finish_round'];
  const mine = await names('Mira');
  const theirs = await names('Alex');
  for (const t of foremanTools) {
    assert.ok(mine.includes(t), `the foreman is shown ${t}`);
    assert.ok(!theirs.includes(t), `a backend engineer is not shown ${t}`);
  }
  assert.ok(theirs.includes('ask_boss') && mine.includes('send_message'));
  // Not being shown a tool is not the protection: calling it anyway is refused, and recorded.
  for (const t of foremanTools) {
    const res = await call('Alex', t, { employee: 'Sarah', question_id: id.q, answer: 'x', task: 'T-1', project: 'Shop', title: 't', description: 'd', summary: 's', detail: 'd' });
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
  assert.match(pasted[0]!, /- BLOCKED \/ STALLED: [^\n]*\n- UNASSIGNED: [^\n]*\n- You never approve permission requests/);
  assert.ok(!/- QUESTION:/.test(pasted[0]!), 'no instructions for what is not in this round');
  assert.equal(eng.foreman.status().round!.outcome, 'running');
  // Claude Code acknowledges the prompt (the UserPromptSubmit hook carries the round's marker).
  eng.comms.confirmMarker(mira.id, 'ROUND', String(started!.data.roundId));

  // While it runs — and however often the office looks — there is no second round.
  for (let i = 0; i < 5; i++) await eng.foreman.tick();
  assert.equal(roundEvents('started').length, 1);
  assert.match((await call('Mira', 'look_at', { employee: 'Sarah' })).text, /Sarah — Frontend Engineer/);
  assert.equal((await call('Mira', 'finish_round', { summary: 'Looked at Sarah; the blocked login task needs the owner.' })).text, 'Round recorded. Stop here; you are called again when something needs you.');
  const [finished] = roundEvents('finished');
  assert.deepEqual([finished!.data.outcome, finished!.data.visited, finished!.data.summary], ['finished', 1, 'Looked at Sarah; the blocked login task needs the owner.']);
  const st = eng.foreman.status();
  assert.deepEqual([st.round, st.lastRound!.outcome, st.lastRound!.visited], [null, 'finished', [id.Sarah]]);
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
  assert.match(other.foreman.status().problem!, /Nobody in the office has the Foreman role/);
  assert.equal(other.foreman.status().foreman, null);
});
