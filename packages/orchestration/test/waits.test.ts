import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession, Host, Task } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { handleMcpPost } from '@orchestrator/integrations';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * An engine whose machines start, stop, interrupt and take pasted text, and do nothing else: enough to see what a
 * tool call that waits for a colleague returns and when — without tmux or a model. What a session's hooks would
 * report (between turns, in a turn) is set on the record by hand.
 */
const calls: Array<{ method: string; params: any }> = [];
const pasted: string[] = [];
const offline = new Set<string>();
/** What the office answered to hooks it was asked to decide (a Stop hook: null = let the turn end). */
const hookAnswers: Array<Record<string, unknown> | null> = [];
const link: AgentLink = {
  rpc: async (_host, rpc) => {
    calls.push(rpc as any);
    const p = (rpc as any).params;
    switch (rpc.method) {
      case 'session.paste':
        pasted.push(String(p.text));
        return { via: 'terminal' } as any;
      case 'session.create':
        return { sessionId: p.sessionId, launchId: p.spec.launchId, origin: 'managed', mode: 'interactive_cli', tmuxSession: `orch-${p.sessionId.slice(0, 6)}`, tmuxPane: '%1', cwd: p.spec.cwd, repoRoot: null, branch: null, pid: 4242, alive: true, command: 'claude', cols: 120, rows: 34, claudeSessionId: p.spec.claudeSessionId, capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false }, permissionMode: p.spec.permissionMode, model: null, startedAt: new Date().toISOString(), exitReason: null } as any;
      case 'session.kill':
      case 'session.interrupt':
        return { ok: true } as any;
      default:
        throw new Error('this test host runs nothing');
    }
  },
  isOnline: (host) => !offline.has(host),
  respondHook: (_host, _request, output) => {
    hookAnswers.push(output);
    return true;
  },
  disconnect: () => undefined,
};
let eng: Engine;
let store: Store;
const id: Record<string, string> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const starts = (who: string) => calls.filter((c) => c.method === 'session.create' && c.params.spec.env?.ORCH_EMPLOYEE === who.toLowerCase()).length;
const emp = (who: string) => eng.core.employees.require(id[who]!);
const sessionOf = (who: string) => eng.core.sessionOf(id[who]!)!;
type Result = { text: string; isError: boolean };

/** Call an MCP tool as an employee, the way the server does once the session token has said who it is. */
async function call(who: string, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal, on: Engine = eng): Promise<Result> {
  const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, on.mcp, { employee: on.core.employees.require(id[who]!), session: on.core.sessionOf(id[who]!)!, signal });
  return { text: res.body.result.content[0].text, isError: res.body.result.isError };
}
/** The same, for a call that is expected to be held: the promise, and whether it has come back yet. */
function held(who: string, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal, on: Engine = eng): { done: () => boolean; result: Promise<Result> } {
  let finished = false;
  // What Claude Code's PreToolUse hook reports while a tool runs: in the middle of a turn.
  const s = on.core.sessionOf(id[who]!)!;
  s.inTurn = true;
  on.core.put('session', s);
  const result = call(who, name, args, signal, on).then((r) => {
    finished = true;
    return r;
  });
  return { done: () => finished, result };
}
/** What a SessionStart or Stop hook leaves behind: between turns, idle. */
function rested(s: AgentSession): AgentSession {
  s.inTurn = false;
  s.lastEventAt = new Date().toISOString();
  eng.sessions.setActivity(s, 'idle', null, { silent: true });
  return eng.core.put('session', s);
}
async function atDesk(who: string): Promise<AgentSession> {
  return rested(await eng.sessions.start(id[who]!));
}
/** Everything queued for them has gone into the session and Claude Code acknowledged it. */
async function delivered(who: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await eng.comms.pump(id[who]!);
    await sleep(3);
    for (const m of eng.core.messages.filter((x) => x.toEmployeeId === id[who] && x.delivery.status === 'sent' && x.delivery.via !== 'mcp_pull')) eng.comms.confirmMarker(id[who]!, 'MSG', m.id);
    if (!eng.comms.queued(id[who]!).length) break;
  }
}
const requestId = (text: string) => /request(?: id)? ([0-9a-f]{8})/.exec(text)?.[1] ?? '';
const lastRequestTo = (who: string) => eng.core.collabs.filter((c) => c.toEmployeeId === id[who]).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]!;
/** A task somebody has that is not finished and that the scheduler leaves alone (it depends on one nobody has). */
function taskFor(who: string, title: string, projectId = id.shop!): Task {
  const blocker = eng.tasks.createTask({ projectId, title: `Before: ${title}` });
  return eng.tasks.createTask({ projectId, title, assigneeId: id[who], dependsOn: [blocker.id] });
}
function move(t: Task, status: Task['status'], more: Partial<Task> = {}): void {
  Object.assign(t, { status, ...more });
  eng.core.put('task', t);
}

before(async () => {
  store = new Store(':memory:');
  eng = new Engine({ store, agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0, deliveryConfirmMs: 50, wakeRetryMs: 40, colleagueWaitMs: 60_000, waitGoneGraceMs: 30, sleepIdleMs: 60_000 } }, { send: () => undefined });
  const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  eng.core.put('host', { ...host, id: 'host-2', name: 'far box', local: false });
  eng.core.put('host', { ...host, id: 'pc', name: "Mila's computer", local: false, memberId: 'm1', memberName: 'Mila' } as Host);
  // Work is assigned by hand here, so the scheduler leaves unassigned tasks alone.
  id.shop = (await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } })).id;
  id.private = (await eng.tasks.createProject({ name: 'Mila private', hostId: 'pc', policy: { autoAssign: false } })).id;
  for (const name of ['Ava', 'Ben', 'Cy', 'Dee', 'Eve']) id[name] = eng.employees.create({ name, roleKey: 'backend', projectId: id.shop, hostId: host.id, workingDir: `/tmp/${name.toLowerCase()}` }).id;
  id.Far = eng.employees.create({ name: 'Far', roleKey: 'backend', projectId: id.shop, hostId: 'host-2', workingDir: '/tmp/far' }).id;
  id.Mil = eng.employees.create({ name: 'Mil', roleKey: 'backend', projectId: id.private, hostId: 'pc', workingDir: '/tmp/mil' }).id;
  for (const who of ['Ava', 'Ben', 'Cy']) await atDesk(who);
});

test('the tools as a model sees them: wait on the request tools, and one tool to wait or keep waiting', async () => {
  const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, eng.mcp, { employee: emp('Ava'), session: sessionOf('Ava') });
  const tools = new Map<string, any>(res.body.result.tools.map((t: any) => [t.name, t]));
  for (const name of ['request_collaboration', 'request_help']) assert.equal(tools.get(name).inputSchema.properties.wait.type, 'boolean', `${name} takes wait`);
  assert.ok(!tools.get('send_message').inputSchema.properties.wait, 'a message has no answer to wait for');
  const w = tools.get('wait_for_colleague');
  assert.deepEqual(Object.keys(w.inputSchema.properties), ['request_id', 'task']);
  assert.ok(!w.inputSchema.required, 'with no arguments it continues the wait the session was in');
  assert.match(w.description, /call it again to keep waiting/);
});

test('ask and wait: the call stays open until the colleague answers, and returns the answer', async () => {
  const pending = held('Ava', 'request_collaboration', { to: 'Ben', summary: 'Need the orders contract', detail: 'The shape of GET /orders.', wait: true });
  await delivered('Ben');
  assert.equal(pending.done(), false, 'the call is held open');
  // What the waiting session is shown as, and what is on its record.
  const ava = sessionOf('Ava');
  const collab = lastRequestTo('Ben');
  assert.equal(collab.waited, true);
  assert.deepEqual([ava.activity, ava.activityDetail], ['waiting_input', "Waiting for Ben's answer"]);
  assert.deepEqual({ ...ava.waitingOn, since: null }, { employeeId: id.Ben, requestId: collab.id, taskId: null, since: null, held: true });
  assert.ok(eng.core.store.queryEvents({ types: ['agent.waiting'] as any }).some((e) => e.summary === "Ava is waiting for Ben's answer"));
  // What the colleague is told.
  const prompt = pasted.at(-1)!;
  assert.match(prompt, /Request from Ava \(.*\) \(request id [0-9a-f]{8}\): Need the orders contract/);
  assert.match(prompt, /\nAva is waiting for your answer before going on\.\nAnswer before anything else/);
  assert.match((await call('Cy', 'get_team')).text, /- Ava — .* · WAITING · waiting for Ben's answer/);

  const said = await call('Ben', 'respond_to_request', { request_id: collab.id, action: 'incorporated', note: 'GET /orders returns { items: [] }.' });
  assert.equal(said.text, 'Response recorded (incorporated). Ava was waiting for it and has it now: they can go on.');
  const got = await pending.result;
  assert.equal(got.isError, false);
  assert.equal(got.text, 'Ben answered your request "Need the orders contract" — Ben will do it as part of their current task: GET /orders returns { items: [] }.');
  // The answer went back through the tool call: nothing is typed into the terminal of the one who asked.
  assert.equal(eng.comms.queued(id.Ava!).length, 0);
  const reply = eng.core.messages.find((m) => m.threadId === collab.id && m.toEmployeeId === id.Ava)!;
  assert.deepEqual([reply.delivery.status, reply.delivery.via, !!reply.readAt], ['sent', 'mcp_pull', true]);
  eng.comms.confirmBySignal(ava.id, { tool: 'mcp__orchestrator__request_collaboration', orchestratorTool: 'request_collaboration' });
  assert.equal(eng.core.messages.get(reply.id)!.delivery.status, 'confirmed', 'confirmed once the tool call has come back');
  assert.equal((await call('Ava', 'check_messages')).text, 'No new messages.');
  // And the one who asked is no longer waiting.
  assert.equal(sessionOf('Ava').waitingOn, null);
  assert.equal(sessionOf('Ava').activity, 'thinking');
  rested(sessionOf('Ava'));
});

test('a request that became a task: the answer names the task, and that task can be waited for', async () => {
  const pending = held('Ava', 'request_collaboration', { to: 'Ben', summary: 'Export endpoint', wait: true });
  await delivered('Ben');
  const collab = lastRequestTo('Ben');
  await call('Ben', 'respond_to_request', { request_id: collab.id, action: 'new_task', note: 'Too big for today.' });
  const got = await pending.result;
  const created = eng.core.tasks.require(eng.core.collabs.require(collab.id).createdTaskId!);
  assert.deepEqual([created.title, created.assigneeId], ['Export endpoint', id.Ben]);
  assert.match(got.text, new RegExp(`Ben made it a separate task: Too big for today\\. It is ${created.key} on the board: to wait until it is finished, call wait_for_colleague with task "${created.key}"\\.`));
  rested(sessionOf('Ava'));
  // (The scripted host cannot start a task: keep this one out of the way of the next tests.)
  eng.tasks.deleteTask(created.id);
});

test('the bound passes: "not yet", how to keep waiting, and the wait stands until the answer comes', async () => {
  eng.core.timings.colleagueWaitMs = 50;
  // Ben is in the middle of something: the request cannot reach him yet.
  const ben = sessionOf('Ben');
  ben.inTurn = true;
  eng.sessions.setActivity(ben, 'coding', 'Edit api.ts');
  const first = await held('Ava', 'request_collaboration', { to: 'Ben', summary: 'Which port?', wait: true }).result;
  const rid = requestId(first.text);
  assert.equal(first.isError, false);
  assert.match(first.text, /^Ben has not answered yet \(request [0-9a-f]{8}\): your request has not reached them yet; Ben is at work \(coding\)\. Do not guess the answer\./);
  assert.match(first.text, new RegExp(`call wait_for_colleague with request_id "${rid}" to keep waiting\\. If they answer while you are working, the answer is delivered to you\\.`));
  // The wait stands without a call; the session is thinking again.
  let ava = sessionOf('Ava');
  assert.deepEqual([ava.waitingOn?.requestId, ava.waitingOn?.held, ava.activity], [rid, false, 'thinking']);

  // Picked up again with no arguments: the wait the session was in.
  eng.core.timings.colleagueWaitMs = 60_000;
  const since = ava.waitingOn!.since;
  const again = held('Ava', 'wait_for_colleague');
  await sleep(10);
  assert.equal(again.done(), false);
  assert.deepEqual([sessionOf('Ava').waitingOn?.held, sessionOf('Ava').waitingOn?.since], [true, since]);
  rested(ben);
  await delivered('Ben');
  await call('Ben', 'respond_to_request', { request_id: rid, action: 'declined', note: 'Not mine: ask ops.' });
  assert.equal((await again.result).text, 'Ben answered your request "Which port?" — Ben declined it: Not mine: ask ops.');
  // Asked again once it is answered: the answer, at once.
  assert.match((await call('Ava', 'wait_for_colleague', { request_id: rid })).text, /Ben declined it: Not mine: ask ops\./);
  assert.match((await call('Ava', 'wait_for_colleague')).text, /You are not waiting for anything/);
  assert.match((await call('Ava', 'wait_for_colleague', { request_id: 'ffffffff' })).text, /No request "ffffffff" of yours/);
  assert.match((await call('Cy', 'wait_for_colleague', { request_id: rid })).text, /No request ".*" of yours/, "somebody else's request cannot be waited for");
  rested(sessionOf('Ava'));
});

test('an answer that comes after the bound, with no call open, reaches the session as a message', async () => {
  eng.core.timings.colleagueWaitMs = 30;
  const ben = sessionOf('Ben');
  ben.inTurn = true;
  eng.core.put('session', ben);
  const first = await held('Ava', 'request_collaboration', { to: 'Ben', summary: 'Which queue?', wait: true }).result;
  eng.core.timings.colleagueWaitMs = 60_000;
  const rid = requestId(first.text);
  // Ava's turn ends while she waits: shown as waiting for Ben, and kept awake.
  const ava = sessionOf('Ava');
  eng.hooks.onHook(id.host ?? 'host-1', { id: `stop-${rid}`, ts: new Date().toISOString(), hostSeq: 1, sessionId: ava.id, tmuxPane: '%1', payload: { hook_event_name: 'Stop', session_id: 'x', last_assistant_message: 'Waiting for Ben.' } as any });
  assert.deepEqual([ava.inTurn, ava.activity, ava.activityDetail], [false, 'waiting_input', "Waiting for Ben's answer"]);
  assert.equal(eng.sleeper.keptAwake(emp('Ava'), ava, Date.now() + 3600_000), 'they are waiting for a colleague');

  rested(ben);
  await delivered('Ben');
  const said = await call('Ben', 'respond_to_request', { request_id: rid, action: 'incorporated', note: 'The first one.' });
  assert.equal(said.text, 'Response recorded (incorporated) and sent to Ava, who is waiting for it.');
  assert.equal(sessionOf('Ava').waitingOn, null, 'the wait is over');
  assert.deepEqual([sessionOf('Ava').activity, sessionOf('Ava').activityDetail], ['idle', null]);
  await delivered('Ava');
  assert.match(pasted.at(-1)!, /\[ORCH:MSG:[^\]]+\] Message from Ben \(.*\): Re: "Which queue\?" — Ben will handle it as part of their current task\. The first one\./);
});

test('the call is closed by the session before an answer: nobody is listening, the wait stands', async () => {
  const gone = new AbortController();
  const pending = held('Ava', 'request_collaboration', { to: 'Ben', summary: 'Which region?', wait: true }, gone.signal);
  await sleep(5);
  gone.abort();
  assert.equal((await pending.result).isError, true);
  const rid = lastRequestTo('Ben').id;
  assert.deepEqual([sessionOf('Ava').waitingOn?.requestId, sessionOf('Ava').waitingOn?.held], [rid, false]);
  await delivered('Ben');
  assert.match((await call('Ben', 'respond_to_request', { request_id: rid, action: 'declined', note: 'No.' })).text, /sent to Ava, who is waiting for it/);
  await delivered('Ava');
  rested(sessionOf('Ava'));
});

test('no deadlocks: oneself, and a circle through one or more colleagues, are refused before anything is sent', async () => {
  const avaWaits = held('Ava', 'request_collaboration', { to: 'Ben', summary: 'A needs B', wait: true });
  await delivered('Ben');
  const first = lastRequestTo('Ben');
  const before = eng.core.collabs.size;

  // Ben, asked by Ava who waits, may not wait for Ava.
  const no = await call('Ben', 'request_collaboration', { to: 'Ava', summary: 'B needs A', wait: true });
  assert.equal(no.isError, true);
  assert.equal(no.text, `Ava is waiting for your answer to request ${first.id} ("A needs B"). Waiting for Ava now would leave you both stuck. Deal with what is wanted from you first (respond_to_request), or carry on without waiting. Nothing was sent. If they only need to know, send it without wait.`);
  assert.equal(eng.core.collabs.size, before, 'nothing was sent');
  assert.equal(sessionOf('Ben').waitingOn ?? null, null);

  // Through others: Ava waits for Ben, Ben for Cy — Cy may not wait for Ava.
  const benWaits = held('Ben', 'request_collaboration', { to: 'Cy', summary: 'B needs C', wait: true });
  await delivered('Cy');
  const second = lastRequestTo('Cy');
  const ring = await call('Cy', 'request_collaboration', { to: 'Ava', summary: 'C needs A', wait: true });
  assert.match(ring.text, new RegExp(`^Ava is waiting for Ben, and Ben is waiting for your answer to request ${second.id} \\("B needs C"\\)\\. Waiting for Ava now would leave you all stuck\\.`));
  // Without wait it is an ordinary request, as before.
  assert.match((await call('Cy', 'request_collaboration', { to: 'Ava', summary: 'C tells A' })).text, /^Request [0-9a-f]{8} sent to Ava/);
  // One wait at a time.
  assert.match((await call('Ava', 'wait_for_colleague', { request_id: first.id })).text, /^You are already waiting for Ben's answer in another call\. Wait for one thing at a time\./);

  await call('Cy', 'respond_to_request', { request_id: second.id, action: 'declined', note: 'no' });
  await benWaits.result;
  await call('Ben', 'respond_to_request', { request_id: first.id, action: 'declined', note: 'no' });
  await avaWaits.result;

  // One's own task.
  const mine = taskFor('Ava', 'Ava builds the importer');
  assert.equal((await call('Ava', 'wait_for_colleague', { task: mine.key })).text, `${mine.key} is your own task: there is nobody to wait for.`);
  for (const who of ['Ava', 'Ben', 'Cy']) {
    await delivered(who);
    rested(sessionOf(who));
  }
});

test('nobody to wait for: archived, paused, on a machine that is away', async () => {
  const before = eng.core.collabs.size;
  // Paused by the owner.
  await eng.sessions.pause(id.Cy!);
  assert.equal((await call('Ava', 'request_collaboration', { to: 'Cy', summary: 'x', wait: true })).text, 'Cy is paused by the owner and will not answer until they are resumed. Nothing was sent. If they only need to know, send it without wait.');
  await eng.sessions.resume(id.Cy!);
  // On a machine that is not there.
  offline.add('host-2');
  assert.match((await call('Ava', 'request_collaboration', { to: 'Far', summary: 'x', wait: true })).text, /^Far cannot be reached right now: far box is offline\. Nothing was sent\./);
  const theirs = taskFor('Far', 'Far builds the exporter');
  assert.match((await call('Ava', 'wait_for_colleague', { task: theirs.key })).text, /^Far cannot be reached right now: far box is offline\.$/);
  offline.delete('host-2');
  assert.equal(eng.core.collabs.size, before, 'nothing was sent');

  // A task nobody has, one the boss has not released, and one that does not exist.
  const loose = eng.tasks.createTask({ projectId: id.shop!, title: 'Nobody has this' });
  assert.match((await call('Ava', 'wait_for_colleague', { task: loose.key })).text, new RegExp(`^${loose.key} "Nobody has this" is READY and nobody has it, so there is nobody to wait for\\.`));
  const unreleased = eng.tasks.createTask({ projectId: id.shop!, title: 'Proposed', assigneeId: id.Ben, released: false });
  assert.match((await call('Ava', 'wait_for_colleague', { task: unreleased.key })).text, new RegExp(`^${unreleased.key} has not been released by the boss yet`));
  assert.match((await call('Ava', 'wait_for_colleague', { task: 'T-9999' })).text, /^No task "T-9999" that you can see\./);
  assert.match((await call('Ava', 'wait_for_colleague', { task: 'T-1', request_id: 'abcd' })).text, /not both/);
  eng.tasks.deleteTask(loose.id);
  eng.tasks.deleteTask(unreleased.id);
});

test('the awaited colleague is paused, stops or leaves while someone waits: the call returns saying so', async () => {
  // Paused.
  let pending = held('Ava', 'request_collaboration', { to: 'Ben', summary: 'While paused', wait: true });
  await delivered('Ben');
  await eng.sessions.pause(id.Ben!);
  let got = await pending.result;
  let rid = lastRequestTo('Ben').id;
  assert.equal(got.text, `Ben was paused by the owner and will not answer until they are resumed. Your request ${rid} stays open; if an answer comes, it is delivered to you. Carry on with what does not depend on it, or tell the boss (ask_boss).`);
  assert.equal(sessionOf('Ava').waitingOn, null);
  assert.ok(eng.core.store.queryEvents({ types: ['agent.waiting'] as any }).some((e) => /^Ava stopped waiting for Ben's answer: Ben was paused by the owner/.test(e.summary)));
  await eng.sessions.resume(id.Ben!);
  rested(sessionOf('Ben'));

  // Their session stops (the owner stops it, or it dies): not at once — it may only be moving — but after a moment.
  pending = held('Ava', 'request_collaboration', { to: 'Ben', summary: 'While stopping', wait: true });
  await delivered('Ben');
  rid = lastRequestTo('Ben').id;
  await eng.sessions.stop(id.Ben!, { reason: 'stopped by the owner' });
  assert.equal(pending.done(), false, 'a session that is gone for a moment is given that moment');
  got = await pending.result;
  assert.equal(got.text, `Ben's session stopped (stopped by the owner) before they answered. Your request ${rid} stays open; if an answer comes, it is delivered to you. Carry on with what does not depend on it, or tell the boss (ask_boss).`);
  await atDesk('Ben');

  // A session that only moved (stopped and started again within the moment) does not end the wait.
  const task = taskFor('Ben', 'Ben moves folders');
  move(task, 'IN_PROGRESS', { startedAt: new Date().toISOString() });
  pending = held('Ava', 'wait_for_colleague', { task: task.key });
  await eng.sessions.stop(id.Ben!, { reason: 'moving to another working directory' });
  await atDesk('Ben');
  await sleep(60);
  assert.equal(pending.done(), false);

  move(task, 'DONE', { completedAt: new Date().toISOString() });
  await pending.result;

  // They are let go (someone with no session: a running one has to be stopped first, which is the case above).
  const theirs = taskFor('Far', 'Far builds the exporter');
  pending = held('Ava', 'wait_for_colleague', { task: theirs.key });
  await sleep(5);
  assert.equal(pending.done(), false);
  eng.employees.update(id.Far!, { archived: true });
  got = await pending.result;
  assert.equal(got.text, `Far no longer works here, so nothing will come from them. ${theirs.key} is BACKLOG. Carry on with what does not depend on it, or tell the boss (ask_boss).`);

  // Their machine drops off for a moment and comes back: the wait goes on. It stays away: the wait is cut short.
  pending = held('Ava', 'request_collaboration', { to: 'Ben', summary: 'While the link flaps', wait: true });
  await delivered('Ben');
  const ben = sessionOf('Ben');
  offline.add('host-1');
  eng.sessions.hostWentOffline(ben);
  await sleep(10);
  offline.delete('host-1');
  ben.status = 'running';
  eng.core.put('session', ben);
  await sleep(60);
  assert.equal(pending.done(), false, 'a machine that is back within the moment changes nothing');
  offline.add('host-1');
  eng.sessions.hostWentOffline(ben);
  got = await pending.result;
  assert.match(got.text, /^Ben cannot be reached any more: box is offline\. Your request [0-9a-f]{8} stays open/);
  offline.delete('host-1');
  ben.status = 'running';
  eng.core.put('session', ben);
  rested(ben);
  eng.employees.update(id.Far!, { archived: false });
  eng.tasks.deleteTask(theirs.id);
  for (const who of ['Ava', 'Ben']) {
    await delivered(who);
    rested(sessionOf(who));
  }
});

test('waiting for a task: returned when it is done or blocked, and at once when it already is', async () => {
  const task = taskFor('Ben', 'Build the importer');
  const pending = held('Ava', 'wait_for_colleague', { task: task.key.toLowerCase() });
  await sleep(5);
  assert.equal(pending.done(), false);
  let ava = sessionOf('Ava');
  assert.deepEqual([ava.activity, ava.activityDetail, ava.waitingOn?.taskId, ava.waitingOn?.employeeId, ava.waitingOn?.held], ['waiting_input', `Waiting for Ben (${task.key})`, task.id, id.Ben, true]);
  // It moves along: still not finished.
  move(task, 'IN_PROGRESS', { startedAt: new Date().toISOString() });
  move(task, 'REVIEW');
  assert.equal(pending.done(), false);
  assert.deepEqual([sessionOf('Ava').waitingOn?.employeeId, sessionOf('Ava').activityDetail], [null, `Waiting for ${task.key} (in review)`], 'in review with no reviewer among the employees: it waits for the owner');
  move(task, 'DONE', { completedAt: new Date().toISOString(), evidence: { ...task.evidence, summary: 'Importer reads CSV and JSON.', merge: { ts: new Date().toISOString(), ok: true, sha: 'abc', into: 'orchestrator/integration', detail: '' } } });
  const got = await pending.result;
  assert.equal(got.text, `${task.key} "Build the importer" is DONE (Ben). It is merged into orchestrator/integration.\nTheir summary: Importer reads CSV and JSON.`);
  assert.equal(sessionOf('Ava').waitingOn, null);

  // Already finished: at once, with what happened.
  assert.equal((await call('Ava', 'wait_for_colleague', { task: task.key })).text, got.text);
  const byHand = taskFor('Ben', 'Tidy the readme');
  eng.tasks.updateTask(byHand.id, { status: 'DONE' });
  assert.match((await call('Ava', 'wait_for_colleague', { task: byHand.key })).text, /is DONE \(Ben\)\. It was marked done by hand, not verified by the office\.$/);

  // Blocked: what happened, not "done" — also when it happens while waiting.
  const stuck = taskFor('Ben', 'Wire the payment gateway');
  move(stuck, 'IN_PROGRESS', { startedAt: new Date().toISOString() });
  const second = held('Ava', 'wait_for_colleague', { task: stuck.key });
  await sleep(5);
  eng.tasks.blockFromAgent(emp('Ben'), 'No sandbox credentials', 'a test account');
  const blocked = await second.result;
  assert.equal(blocked.text, `${stuck.key} "Wire the payment gateway" is BLOCKED, not finished (Ben): No sandbox credentials — needs: a test account. The boss has been told. Do not wait for it: carry on with what does not depend on it, or say what you need with ask_boss.`);
  assert.equal((await call('Ava', 'wait_for_colleague', { task: stuck.key })).text, blocked.text);
  rested(sessionOf('Ben'));

  // The bound passes: where it stands, and how to keep waiting. When it then ends with no call open, a message says so.
  eng.core.timings.colleagueWaitMs = 30;
  const slow = taskFor('Ben', 'Slow one');
  move(slow, 'IN_PROGRESS', { startedAt: new Date().toISOString(), progress: { percent: 40, note: 'Half the parsers are in', ts: new Date().toISOString() } });
  const notYet = await held('Ava', 'wait_for_colleague', { task: slow.key }).result;
  eng.core.timings.colleagueWaitMs = 60_000;
  assert.equal(notYet.text, `${slow.key} is not finished yet: it is IN_PROGRESS; Ben is between turns. Last progress report: Half the parsers are in. Either carry on with work that does not depend on it, or call wait_for_colleague with task "${slow.key}" to keep waiting. When it ends you are told.`);
  assert.deepEqual([sessionOf('Ava').waitingOn?.taskId, sessionOf('Ava').waitingOn?.held], [slow.id, false]);
  rested(sessionOf('Ava'));
  move(slow, 'DONE', { completedAt: new Date().toISOString() });
  assert.equal(sessionOf('Ava').waitingOn, null);
  await delivered('Ava');
  assert.ok(pasted.some((t) => new RegExp(`Message from The office: About the task you were waiting for: ${slow.key} "Slow one" is DONE \\(Ben\\)\\.`).test(t)), 'told by a message');
  rested(sessionOf('Ava'));
});

test('work does not cross between the shared office and a member\'s own computer, and what is there is not confirmed', async () => {
  await atDesk('Mil');
  const before = eng.core.collabs.size;
  const no = await call('Ava', 'request_collaboration', { to: 'Mil', summary: 'Need your numbers', wait: true });
  assert.equal(no.isError, true);
  assert.equal(no.text, "Mil works on Mila's own computer. Work does not cross between the shared office and a member's own computer, so you cannot wait for them. Ask the boss (ask_boss) if you need something from there. Nothing was sent. If they only need to know, send it without wait.");
  assert.equal(eng.core.collabs.size, before);
  assert.match((await call('Mil', 'request_collaboration', { to: 'Ava', summary: 'Need yours', wait: true })).text, /^You work on a member's own computer and Ava in the shared office\. Work does not cross/);

  // A task on the member's computer: the same answer as for one that does not exist.
  const theirs = taskFor('Mil', 'Private report', id.private!);
  const shared = taskFor('Ben', 'Shared report');
  assert.equal((await call('Ava', 'wait_for_colleague', { task: theirs.key })).text, `No task "${theirs.key}" that you can see. Use get_project_context to see the tasks of your project.`);
  assert.equal((await call('Mil', 'wait_for_colleague', { task: shared.key })).text, `No task "${shared.key}" that you can see. Use get_project_context to see the tasks of your project.`);
  // On the same computer it works like anywhere else.
  move(theirs, 'DONE', { completedAt: new Date().toISOString() });
  id.Mel = eng.employees.create({ name: 'Mel', roleKey: 'backend', projectId: id.private, hostId: 'pc', workingDir: '/tmp/mel' }).id;
  await atDesk('Mel');
  assert.match((await call('Mel', 'wait_for_colleague', { task: theirs.key })).text, /"Private report" is DONE \(Mil\)\./);
  move(shared, 'DONE', { completedAt: new Date().toISOString() });
});

test('a request someone waits for wakes the colleague: asleep, or never started', async () => {
  // Dee has never been started: an ordinary request waits for her; one that is waited for starts her session.
  assert.equal(starts('Dee'), 0);
  await call('Ava', 'request_collaboration', { to: 'Dee', summary: 'When you are in' });
  await eng.comms.pump(id.Dee!);
  await sleep(10);
  assert.equal(starts('Dee'), 0, 'as before: a message does not start someone the owner never started');
  const forDee = held('Ava', 'request_collaboration', { to: 'Dee', summary: 'Now, please', wait: true });
  await sleep(20);
  assert.equal(starts('Dee'), 1, 'started for the request that is waited for');
  assert.ok(eng.core.store.queryEvents({ types: ['session.woken'] as any }).some((e) => /^Dee was started for a request from Ava \(.*\), who is waiting for the answer/.test(e.summary)));
  rested(sessionOf('Dee'));
  await delivered('Dee');
  await call('Dee', 'respond_to_request', { request_id: lastRequestTo('Dee').id, action: 'declined', note: 'no' });
  await forDee.result;
  rested(sessionOf('Ava'));

  // Eve was put to sleep by the office: the request wakes her, where she left off.
  await atDesk('Eve');
  const eve = sessionOf('Eve');
  await eng.sessions.stop(id.Eve!, { actor: 'office', asleep: true, reason: 'asleep after 30 min without work' });
  assert.equal(eng.sessions.asleep(id.Eve!), true);
  const forEve = held('Ava', 'request_collaboration', { to: 'Eve', summary: 'Wake up', wait: true });
  await sleep(20);
  assert.equal(starts('Eve'), 2);
  assert.equal(calls.filter((c) => c.method === 'session.create' && c.params.sessionId === eve.id).at(-1)!.params.spec.resume, true, 'continuing her conversation');
  assert.equal(forEve.done(), false);
  rested(sessionOf('Eve'));
  await delivered('Eve');
  assert.match(pasted.at(-1)!, /Request from Ava [\s\S]*Wake up[\s\S]*Ava is waiting for your answer before going on\./);
  await call('Eve', 'respond_to_request', { request_id: lastRequestTo('Eve').id, action: 'incorporated', note: 'awake' });
  assert.match((await forEve.result).text, /^Eve answered your request "Wake up"/);
  rested(sessionOf('Ava'));
});

test('a session that waits is not put to sleep, gets no routine run, and is not nudged', async () => {
  const pending = held('Ava', 'request_collaboration', { to: 'Ben', summary: 'Hold on', wait: true });
  await delivered('Ben');
  const ava = sessionOf('Ava');
  const long = Date.now() + 3600_000;
  assert.equal(eng.sleeper.keptAwake(emp('Ava'), ava, long), 'it may be in the middle of a turn', 'a held call is the middle of a turn');
  // A routine that comes due finds her waiting: skipped, as for anyone busy.
  const r = eng.routines.create({ employeeId: id.Ava, instruction: 'Check the queue.', everyMinutes: 5 });
  assert.deepEqual([r.lastOutcome, r.lastNote, r.runs], ['skipped_busy', "Ava is waiting for Ben's answer", 0]);
  // Hooks of other tool calls that arrive while the call is held do not change what is shown.
  const hook = (n: string, payload: Record<string, unknown>) => eng.hooks.onHook('host-1', { id: `h-${n}-${Date.now()}`, ts: new Date().toISOString(), hostSeq: 1, sessionId: ava.id, tmuxPane: '%1', payload: { session_id: 'x', ...payload } as any });
  hook('post', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {} });
  hook('pre', { hook_event_name: 'PreToolUse', tool_name: 'mcp__orchestrator__request_collaboration', tool_input: { wait: true } });
  assert.deepEqual([ava.activity, ava.activityDetail], ['waiting_input', "Waiting for Ben's answer"]);

  // The bound passes and her turn ends: she stands waiting. Still awake, still no routine, and at the prompt she is shown waiting for Ben.
  eng.core.timings.colleagueWaitMs = 1;
  const again = held('Cy', 'request_collaboration', { to: 'Ben', summary: 'Me too', wait: true });
  await again.result;
  eng.core.timings.colleagueWaitMs = 60_000;
  const cy = sessionOf('Cy');
  const cyHook = (n: string, payload: Record<string, unknown>) => eng.hooks.onHook('host-1', { id: `c-${n}-${Date.now()}`, ts: new Date().toISOString(), hostSeq: 1, sessionId: cy.id, tmuxPane: '%1', payload: { session_id: 'y', ...payload } as any });
  cyHook('stop', { hook_event_name: 'Stop', last_assistant_message: 'I will wait.' });
  cyHook('idle', { hook_event_name: 'Notification', notification_type: 'idle_prompt' });
  assert.deepEqual([cy.inTurn, cy.activity, cy.activityDetail, cy.waitingOn?.held], [false, 'waiting_input', "Waiting for Ben's answer", false]);
  assert.equal(eng.sleeper.keptAwake(emp('Cy'), cy, long), 'they are waiting for a colleague');
  const r2 = eng.routines.create({ employeeId: id.Cy, instruction: 'Check the queue.', everyMinutes: 5 });
  assert.deepEqual([r2.lastOutcome, r2.lastNote], ['skipped_busy', "Cy is waiting for Ben's answer"]);
  // With a task in hand he would be nudged to keep working when he stops — not while he waits for a colleague.
  const his = taskFor('Cy', 'Cy builds the feed');
  move(his, 'IN_PROGRESS', { startedAt: new Date().toISOString(), delivery: { status: 'confirmed', via: 'terminal_paste', ts: new Date().toISOString(), detail: null } });
  const stop = (n: string) => {
    const raw = { id: `c-stop-${n}`, ts: new Date().toISOString(), hostSeq: 1, sessionId: cy.id, tmuxPane: '%1', payload: { session_id: 'y', hook_event_name: 'Stop', last_assistant_message: 'I will wait.' } as any };
    eng.hooks.markRequest(raw);
    eng.hooks.onHookRequest('host-1', `req-${n}`, raw);
    return hookAnswers.at(-1);
  };
  assert.equal(stop('waiting'), null, 'the turn is left to end');
  assert.deepEqual([cy.activity, cy.activityDetail], ['waiting_input', "Waiting for Ben's answer"]);

  for (const c of eng.core.collabs.filter((x) => x.toEmployeeId === id.Ben && x.status === 'open')) await call('Ben', 'respond_to_request', { request_id: c.id, action: 'declined', note: 'no' });
  await pending.result;
  // The answer is there: the ordinary rule is back.
  await delivered('Cy');
  assert.match(String((stop('answered') as any)?.reason), /is still in progress and you stopped without finishing it/);
  move(his, 'DONE', { completedAt: new Date().toISOString() });
  eng.routines.remove(r.id);
  eng.routines.remove(r2.id);
  for (const who of ['Ava', 'Ben', 'Cy']) {
    await delivered(who);
    rested(sessionOf(who));
  }
});

test('after a restart of the office the held call is gone, the wait is on record, and the continuation picks it up', async () => {
  const pending = held('Ava', 'request_collaboration', { to: 'Ben', summary: 'Across a restart', wait: true });
  await delivered('Ben');
  const rid = lastRequestTo('Ben').id;
  assert.equal(sessionOf('Ava').waitingOn?.held, true);

  // A new office over the same database: nothing is assumed to run until its machine says so.
  const next = new Engine({ store, agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0, deliveryConfirmMs: 50, colleagueWaitMs: 60_000, waitGoneGraceMs: 30 } }, { send: () => undefined });
  next.sessions.restore();
  next.waits.restore();
  const ava = next.core.sessionOf(id.Ava!)!;
  assert.deepEqual([ava.status, ava.waitingOn?.requestId, ava.waitingOn?.held], ['host_offline', rid, false], 'the wait stands; no call is held');
  for (const who of ['Ava', 'Ben']) {
    const s = next.core.sessionOf(id[who]!)!;
    s.status = 'running';
    s.inTurn = who === 'Ben' ? false : true;
    next.core.put('session', s);
  }
  // The session, whose call failed, asks again without knowing the request's id.
  const again = held('Ava', 'wait_for_colleague', {}, undefined, next);
  await sleep(10);
  assert.deepEqual([again.done(), next.core.sessionOf(id.Ava!)!.waitingOn?.held], [false, true]);
  const said = await call('Ben', 'respond_to_request', { request_id: rid, action: 'incorporated', note: 'Still here.' }, undefined, next);
  assert.match(said.text, /Ava was waiting for it and has it now/);
  assert.match((await again.result).text, /^Ben answered your request "Across a restart" — Ben will do it as part of their current task: Still here\./);
  void pending;
});
