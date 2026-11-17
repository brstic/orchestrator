import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSession, Host } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { handleMcpPost } from '@orchestrator/integrations';
import { Engine, ROUTINE_GUIDE, dedupeKeyOf, sanitizeSleep, type AgentLink } from '../src/index.ts';

/**
 * An engine whose machines start, stop and take pasted text, and do nothing else: enough to see when a routine is
 * handed over, when a session is put to sleep and what it is started with again — without tmux or a model.
 */
const calls: Array<{ method: string; params: any }> = [];
const pasted: string[] = [];
const offline = new Set<string>();
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
        return { ok: true } as any;
      default:
        throw new Error('this test host runs nothing');
    }
  },
  isOnline: (host) => !offline.has(host),
  respondHook: () => false,
  disconnect: () => undefined,
};
const MIN = 60_000;
let eng: Engine;
let store: Store;
const id: Record<string, string> = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const starts = () => calls.filter((c) => c.method === 'session.create');
const kills = () => calls.filter((c) => c.method === 'session.kill');
const routineMessages = (who: string) => eng.core.messages.filter((m) => m.toEmployeeId === id[who] && !!m.routineId);

/** The employee's session is up and Claude Code has said so: between turns, at the prompt. */
async function atDesk(who: string): Promise<AgentSession> {
  const s = await eng.sessions.start(id[who]!);
  return rested(s);
}
/** What a SessionStart or Stop hook leaves behind: between turns, idle. */
function rested(s: AgentSession): AgentSession {
  s.inTurn = false;
  s.lastEventAt = new Date().toISOString();
  eng.sessions.setActivity(s, 'idle', null, { silent: true });
  return eng.core.put('session', s);
}
/** Everything queued for them has gone into the session and Claude Code acknowledged it. */
async function delivered(who: string): Promise<void> {
  await eng.comms.pump(id[who]!);
  await sleep(5);
  for (const m of eng.core.messages.filter((x) => x.toEmployeeId === id[who] && x.delivery.status !== 'confirmed')) eng.comms.confirmMarker(id[who]!, 'MSG', m.id);
}

before(async () => {
  store = new Store(':memory:');
  eng = new Engine({ store, agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0, deliveryConfirmMs: 50, wakeRetryMs: 40 } }, { send: () => undefined });
  const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  eng.core.put('host', { ...host, id: 'pc', name: "Mila's computer", local: false, memberId: 'm1', memberName: 'Mila' } as Host);
  id.host = host.id;
  id.shop = (await eng.tasks.createProject({ name: 'Shop' })).id;
  for (const name of ['Ava', 'Ben', 'Cy', 'Dee']) id[name] = eng.employees.create({ name, roleKey: 'backend', projectId: id.shop, hostId: host.id, workingDir: `/tmp/${name.toLowerCase()}` }).id;
  id.Mil = eng.employees.create({ name: 'Mil', roleKey: 'backend', hostId: 'pc', workingDir: '/tmp/mil' }).id;
});

test('a routine is handed to an employee who is between turns, in the owner\'s words plus what to do with what is found', async () => {
  await atDesk('Ava');
  assert.throws(() => eng.routines.create({ employeeId: id.Ava, instruction: '  ' }), /say what they should do each time/);
  for (const bad of [0, 1441, 2.5, 'soon']) assert.throws(() => eng.routines.create({ employeeId: id.Ava, instruction: 'x', everyMinutes: bad }), /how often/);
  assert.throws(() => eng.routines.create({ employeeId: 'nobody', instruction: 'x' }));

  const t0 = Date.now();
  const r = eng.routines.create({ employeeId: id.Ava, instruction: 'Check the support desk at https://desk.example.test and report new tickets.' });
  assert.equal(r.everyMinutes, 5, 'five minutes unless told otherwise');
  assert.equal(r.enabled, true);
  // Its first run is now.
  await delivered('Ava');
  const [m] = routineMessages('Ava');
  assert.ok(m, 'the run is a recorded message to the employee');
  assert.equal(m.body, 'Routine (every 5 min): Check the support desk at https://desk.example.test and report new tickets.');
  assert.equal(m.routineId, r.id);
  const text = pasted.at(-1)!;
  assert.match(text, /\[ORCH:MSG:[^\]]+\] Routine \(every 5 min\): Check the support desk/);
  assert.ok(text.includes(ROUTINE_GUIDE));
  assert.match(ROUTINE_GUIDE, /propose_tasks[\s\S]*dedupe_key[\s\S]*nothing new/);
  const now = eng.core.routines.require(r.id);
  assert.deepEqual([now.runs, now.lastOutcome, now.lastNote], [1, 'delivered', null]);
  assert.ok(Math.abs(Date.parse(now.nextRunAt!) - (t0 + 5 * MIN)) < 2000, 'the next run is one interval on');
  assert.ok(eng.core.store.queryEvents({ types: ['agent.message'] as any }).some((e) => (e.data as any).routineId === r.id), 'and it is in the feed like any message');

  // Not due yet: nothing happens. Due: the next run.
  eng.routines.tick(t0 + 4 * MIN);
  assert.equal(routineMessages('Ava').length, 1);
  eng.routines.tick(t0 + 5 * MIN + 1000);
  await delivered('Ava');
  assert.equal(routineMessages('Ava').length, 2);
  assert.equal(eng.core.routines.require(r.id).runs, 2);
});

test('a run that finds the employee busy is skipped, and missed runs never pile up', async () => {
  const [r] = eng.core.routines.filter((x) => x.employeeId === id.Ava);
  const s = eng.core.runningSessionOf(id.Ava)!;
  const before = routineMessages('Ava').length;
  const due = () => Date.parse(eng.core.routines.require(r!.id).nextRunAt!) + 1000;

  // In the middle of a turn.
  s.inTurn = true;
  eng.core.put('session', s);
  let at = due();
  eng.routines.tick(at);
  let now = eng.core.routines.require(r!.id);
  assert.deepEqual([now.lastOutcome, now.runs], ['skipped_busy', 2]);
  assert.match(now.lastNote!, /Ava was in the middle of something/);
  assert.equal(Date.parse(now.nextRunAt!), at + 5 * MIN, 'looked at again one interval after the look');
  assert.equal(routineMessages('Ava').length, before, 'nothing was queued behind the turn');

  // Waiting for the owner's answer.
  rested(s);
  const q = eng.comms.createQuestion({ kind: 'question', channel: 'mcp_tool', employee: eng.core.employees.require(id.Ava!), session: s, text: 'Which queue?' });
  at = due();
  eng.routines.tick(at);
  now = eng.core.routines.require(r!.id);
  assert.match(now.lastNote!, /waiting for an answer from you/);
  assert.equal(routineMessages('Ava').length, before);
  await eng.comms.answer(q.id, { answer: 'The first.' });
  await delivered('Ava');
  eng.comms.confirmMarker(id.Ava!, 'ANSWER', q.id);

  // Many intervals later: one run, not one per missed slot.
  at = due() + 40 * 5 * MIN;
  eng.routines.tick(at);
  eng.routines.tick(at + 1000);
  assert.equal(routineMessages('Ava').length, before + 1);
  assert.equal(Date.parse(eng.core.routines.require(r!.id).nextRunAt!), at + 5 * MIN, 'counted from the look, not from the slots that were missed');

  // That run is still on its way (not delivered yet): there is no second one behind it.
  at = due();
  eng.routines.tick(at);
  now = eng.core.routines.require(r!.id);
  assert.deepEqual([now.lastOutcome, now.lastNote], ['skipped_busy', 'the run before this one has not been delivered yet']);
  assert.equal(routineMessages('Ava').length, before + 1);
  await delivered('Ava');
});

test('a routine can be paused, given another rhythm, run by hand and removed', async () => {
  const [r] = eng.core.routines.filter((x) => x.employeeId === id.Ava);
  const n = routineMessages('Ava').length;
  eng.routines.update(r!.id, { enabled: false });
  assert.equal(eng.core.routines.require(r!.id).nextRunAt, null);
  eng.routines.tick(Date.now() + 1000 * MIN);
  assert.equal(routineMessages('Ava').length, n, 'paused: it does not run');
  const t = Date.now();
  eng.routines.update(r!.id, { enabled: true, everyMinutes: 30 });
  assert.ok(Math.abs(Date.parse(eng.core.routines.require(r!.id).nextRunAt!) - (t + 30 * MIN)) < 2000, 'switched on again: one interval from now, not at once');
  assert.throws(() => eng.routines.update(r!.id, { everyMinutes: 100000 }), /how often/);
  eng.routines.runNow(r!.id);
  await delivered('Ava');
  assert.equal(routineMessages('Ava').length, n + 1);
  assert.match(routineMessages('Ava').at(-1)!.body, /^Routine \(every 30 min\):/);
  eng.routines.remove(r!.id);
  assert.equal(eng.core.routines.get(r!.id), undefined);
  assert.ok(eng.core.store.recentAudit(50).some((a) => a.action === 'routine.removed'));
});

test('held while the project or the employee is paused; it runs once when that is over', async () => {
  await atDesk('Ben');
  const r = eng.routines.create({ employeeId: id.Ben, instruction: 'Look at the queue.', everyMinutes: 10, runNow: false });
  assert.equal(routineMessages('Ben').length, 0, 'not run at once when asked not to');
  const due = Date.parse(r.nextRunAt!) + 1000;
  eng.tasks.updateProject(id.shop!, { status: 'paused' });
  eng.routines.tick(due);
  eng.routines.tick(due + 60 * MIN);
  let now = eng.core.routines.require(r.id);
  assert.deepEqual([now.lastOutcome, now.lastNote, now.runs], ['not_run', 'project Shop is paused', 0]);
  assert.equal(now.nextRunAt, r.nextRunAt, 'nothing is counted down while it is held');
  eng.tasks.updateProject(id.shop!, { status: 'active' });
  eng.core.gateway.setPaused(eng.core.runningSessionOf(id.Ben)!.id, true);
  eng.routines.tick(due + 61 * MIN);
  assert.equal(eng.core.routines.require(r.id).lastNote, 'Ben is paused');
  eng.core.gateway.setPaused(eng.core.runningSessionOf(id.Ben)!.id, false);
  eng.routines.tick(due + 62 * MIN);
  eng.routines.tick(due + 62 * MIN + 500);
  await delivered('Ben');
  now = eng.core.routines.require(r.id);
  assert.deepEqual([now.lastOutcome, now.runs, routineMessages('Ben').length], ['delivered', 1, 1]);
});

test('no session: the routine starts it, as talking to them does; a machine that is away is waited for', async () => {
  // Cy was never started.
  const n = starts().length;
  const r = eng.routines.create({ employeeId: id.Cy, instruction: 'Check the mailbox.', everyMinutes: 15 });
  await sleep(30);
  assert.equal(starts().length, n + 1, 'the session was started for it');
  assert.equal(starts().at(-1)!.params.spec.resume, false, 'there was no conversation to continue');
  assert.match(eng.core.routines.require(r.id).lastNote!, /Cy had no session: it is being started for this/);
  assert.ok(eng.core.store.queryEvents({ types: ['session.woken'] as any }).some((e) => e.employeeId === id.Cy && /was started for a routine that was due — in a new conversation/.test(e.summary)));
  rested(eng.core.runningSessionOf(id.Cy)!);
  await delivered('Cy');
  assert.equal(routineMessages('Cy')[0]!.delivery.status, 'confirmed');

  // Their machine goes away with the session ended: nothing to start, nothing queued, nothing counted down.
  await eng.sessions.stop(id.Cy!);
  offline.add(id.host!);
  const due = Date.parse(eng.core.routines.require(r.id).nextRunAt!) + 1000;
  eng.routines.tick(due);
  eng.routines.tick(due + 90 * MIN);
  let now = eng.core.routines.require(r.id);
  assert.deepEqual([now.lastOutcome, now.lastNote, now.runs], ['skipped_offline', 'box is offline', 1]);
  assert.equal(routineMessages('Cy').length, 1);
  // Back: it runs once, in the folder they were in, continuing the conversation they had.
  offline.delete(id.host!);
  const k = starts().length;
  eng.routines.tick(due + 91 * MIN);
  await sleep(30);
  assert.equal(starts().length, k + 1);
  assert.deepEqual([starts().at(-1)!.params.spec.resume, starts().at(-1)!.params.spec.cwd], [true, '/tmp/cy']);
  now = eng.core.routines.require(r.id);
  assert.deepEqual([now.lastOutcome, now.runs], ['delivered', 2]);
  rested(eng.core.runningSessionOf(id.Cy)!);
  await delivered('Cy');
  eng.routines.remove(r.id);
});

test('routines outlive a restart of the office: one that came due meanwhile runs once', async () => {
  const r = eng.routines.create({ employeeId: id.Ben, instruction: 'Sweep the logs.', everyMinutes: 60, runNow: false });
  const again = new Engine({ store, agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0, deliveryConfirmMs: 50 } }, { send: () => undefined });
  const kept = again.core.routines.require(r.id);
  assert.deepEqual([kept.instruction, kept.everyMinutes, kept.nextRunAt], ['Sweep the logs.', 60, r.nextRunAt]);
  const before = again.core.messages.filter((m) => m.routineId === r.id).length;
  const late = Date.parse(r.nextRunAt!) + 7 * 60 * MIN;
  again.routines.tick(late);
  again.routines.tick(late + 1000);
  assert.equal(again.core.messages.filter((m) => m.routineId === r.id).length, before + 1, `once, not once per hour missed (${again.core.routines.require(r.id).lastOutcome}: ${again.core.routines.require(r.id).lastNote})`);
  assert.equal(Date.parse(again.core.routines.require(r.id).nextRunAt!), late + 60 * MIN);
  // Ben's other routine (from the test above) came due in the same look: both were handed over, neither held the other back.
  const other = again.core.routines.find((x) => x.employeeId === id.Ben && x.id !== r.id)!;
  assert.deepEqual([other.lastOutcome, Date.parse(other.nextRunAt!)], ['delivered', late + 10 * MIN]);
  await sleep(10);
  for (const m of eng.core.messages.filter((x) => !!x.routineId && x.toEmployeeId === id.Ben)) again.comms.confirmMarker(id.Ben!, 'MSG', m.id);
  eng.routines.remove(r.id);
  eng.routines.remove(other.id);
});

test('what a repeating check finds is put on the board once, and waits for the owner', async () => {
  const ben = eng.core.employees.require(id.Ben!);
  const call = async (args: Record<string, unknown>) => {
    const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'propose_tasks', arguments: args } }, eng.mcp, { employee: ben, session: eng.core.sessionOf(ben.id)! });
    return String(res.body.result.content[0].text);
  };
  assert.equal(eng.core.projects.require(id.shop!).policy.autoAssign, true, 'this project hands work out by itself');
  const first = await call({ tasks: [{ title: 'Ticket 4411: login fails on Safari', description: 'From the support desk.', dedupe_key: 'Desk#4411' }] });
  assert.match(first, /Created 1 tasks: T-\d+\. They wait in the backlog for the boss to release them\./);
  const task = eng.core.tasks.find((t) => t.dedupeKey === 'desk#4411')!;
  assert.deepEqual([task.status, task.released, task.assigneeId], ['BACKLOG', false, null], 'on the board, proposed, not started');
  assert.ok(eng.core.notifications.find((n) => /Ben proposed a task/.test(n.title)));

  // The next check sees the same ticket (and one new one).
  const second = await call({ tasks: [{ title: 'Ticket 4411 again', description: 'Still open.', dedupe_key: ' desk#4411 ' }, { title: 'Ticket 4412: export is slow', description: 'New.', dedupe_key: 'desk#4412' }] });
  assert.match(second, /Created 1 tasks: T-\d+\./);
  assert.match(second, new RegExp(`Already on the board, so not added again: ${task.key} \\[BACKLOG\\]`));
  assert.equal(eng.core.tasks.filter((t) => t.dedupeKey === 'desk#4411').length, 1);
  // Still one line in the Inbox, counting what waits — not one more for every proposal.
  const lines = eng.core.notifications.filter((n) => n.employeeId === ben.id && / proposed /.test(n.title));
  assert.deepEqual(lines.map((n) => n.title), ['Ben proposed 2 tasks']);
  // Even once that task is long done.
  task.status = 'DONE';
  eng.core.put('task', task);
  assert.match(await call({ tasks: [{ title: 'Ticket 4411', description: 'x', dedupe_key: 'DESK#4411' }] }), /^Nothing new was added\. Already on the board/);
  // A key means that task; the same key in another project is another matter, and a task without a key is as before.
  const other = await eng.tasks.createProject({ name: 'Other' });
  assert.equal(eng.tasks.propose(ben, other.id, [{ title: 'Ticket 4411', description: 'x', dedupe_key: 'desk#4411' }], undefined, 'test').created.length, 1);
  const plain = eng.tasks.propose(ben, other.id, [{ title: 'Plan the thing', description: 'x' }, { title: 'Then build it', description: 'y', depends_on: [0] }], undefined, 'test').created;
  assert.deepEqual(plain.map((t) => t.released), [true, true], 'no key: released as the project\'s policy says');
  assert.deepEqual(plain[1]!.dependsOn, [plain[0]!.id]);
  assert.equal(dedupeKeyOf('  A  b '), 'a b');
  assert.equal(dedupeKeyOf(''), null);
  assert.equal(dedupeKeyOf(7), null);
});

test('a session with no work for long enough is put to sleep — and only when nothing can be lost by it', async () => {
  const dee = eng.core.employees.require(id.Dee!);
  let s = await atDesk('Dee');
  assert.equal(eng.core.settings.sleepAfterMinutes, 30);
  const later = () => Date.now() + 31 * MIN;
  assert.equal(eng.sleeper.keptAwake(dee, s, Date.now() + 29 * MIN), 'it has not been idle long enough');
  assert.equal(eng.sleeper.keptAwake(dee, s, later()), null);

  // Every reason to leave it running.
  const keeps = async (why: RegExp, set: () => unknown | Promise<unknown>, undo: () => unknown | Promise<unknown>) => {
    await set();
    const k = kills().length;
    assert.match(String(eng.sleeper.keptAwake(dee, eng.core.runningSessionOf(dee.id)!, later())), why);
    assert.equal(await eng.sleeper.tick(later()), 0);
    assert.equal(kills().length, k);
    await undo();
    assert.equal(eng.sleeper.keptAwake(dee, eng.core.runningSessionOf(dee.id)!, later()), null, `after undoing "${why.source}"`);
  };
  // (Everyone else is left out of these looks by a setting of their own: they are busy elsewhere in this file.)
  for (const who of ['Ava', 'Ben', 'Cy']) {
    const other = eng.core.runningSessionOf(id[who]!);
    if (other) eng.core.put('session', { ...other, inTurn: true });
  }
  await keeps(/middle of a turn/, () => eng.core.put('session', { ...s, inTurn: true }), () => eng.core.put('session', { ...s, inTurn: false }));
  s = eng.core.runningSessionOf(dee.id)!;
  await keeps(/it is thinking/, () => eng.sessions.setActivity(s, 'thinking', null, { silent: true }), () => { eng.sessions.setActivity(s, 'idle', null, { silent: true }); s.activitySince = new Date(Date.now() - 1000).toISOString(); });
  await keeps(/someone is at its terminal/, () => eng.core.put('session', { ...s, control: 'HUMAN_OBSERVING' }), () => eng.core.put('session', { ...s, control: 'AGENT_CONTROLLED' }));
  s = eng.core.runningSessionOf(dee.id)!;
  await keeps(/the owner paused it/, () => eng.core.gateway.setPaused(s.id, true), () => eng.core.gateway.setPaused(s.id, false));
  let q = eng.comms.createQuestion({ kind: 'permission', channel: 'permission_hook', employee: dee, session: s, text: 'Dee wants to run: curl https://desk.example.test', tool: { name: 'Bash', input: { command: 'curl https://desk.example.test' } } });
  await keeps(/a question of theirs is open/, () => undefined, () => eng.comms.supersede(q.id, 'test'));
  const task = eng.tasks.createTask({ projectId: id.shop!, title: 'Something in hand', assigneeId: dee.id, released: false });
  await keeps(/a task in hand/, () => eng.core.put('task', { ...task, status: 'IN_PROGRESS' }), () => eng.core.put('task', { ...task, status: 'BACKLOG' }));
  await keeps(/sleep is switched off/, () => eng.core.updateSettings({ sleepAfterMinutes: 0 }), () => eng.core.updateSettings({ sleepAfterMinutes: 30 }));
  await keeps(/member's own computer/, () => eng.core.put('session', { ...s, hostId: 'pc' }), () => eng.core.put('session', { ...s, hostId: id.host! }));
  s = eng.core.runningSessionOf(dee.id)!;
  await keeps(/did not start this session/, () => eng.core.put('session', { ...s, origin: 'attached' }), () => eng.core.put('session', { ...s, origin: 'managed' }));
  s = eng.core.runningSessionOf(dee.id)!;

  // Nothing of that: asleep. Stopped on the machine, kept as it was, nobody alarmed.
  const lost = eng.core.company.sessionsLost;
  const k = kills().length;
  assert.equal(await eng.sleeper.tick(later()), 1);
  assert.equal(kills().length, k + 1);
  assert.equal(kills().at(-1)!.params.sessionId, s.id, 'the same stop as "Stop session": the process and its tmux session end');
  s = eng.core.sessions.require(s.id);
  assert.deepEqual([s.status, s.exitReason, s.activity], ['exited', 'asleep after 30 min without work', 'offline']);
  assert.ok(s.asleepSince && s.claudeSessionId && s.lastEventAt, 'what is needed to continue the conversation is kept');
  assert.equal(eng.core.runningSessionOf(dee.id), undefined);
  assert.equal(eng.sessions.asleep(dee.id), true);
  assert.equal(eng.sessions.present(dee.id), true, 'asleep is not absent');
  assert.equal(eng.core.company.sessionsLost, lost, 'not counted as a lost session');
  assert.ok(!eng.core.notifications.find((n) => n.kind === 'session_lost' && n.employeeId === dee.id && !n.resolvedAt), 'and nobody is told that she "went offline"');
  assert.ok(eng.core.store.queryEvents({ types: ['session.asleep'] as any }).some((e) => e.employeeId === dee.id && /Dee is asleep after 30 min without work/.test(e.summary)));
  // The machine confirming that the session ended changes nothing about why.
  eng.sessions.onHostReportedGone(id.host!, s.id, 'the tmux session ended', s.launchId);
  assert.equal(eng.core.sessions.require(s.id).exitReason, 'asleep after 30 min without work');
  assert.equal(eng.core.company.sessionsLost, lost);
});

test('whatever a sleeping employee is needed for wakes them, where they left off — once', async () => {
  const dee = eng.core.employees.require(id.Dee!);
  const before = eng.core.sessions.require(eng.core.sessionOf(dee.id)!.id);
  const n = starts().length;
  // Two things at once: a teammate's message and a meeting invitation.
  eng.comms.sendMessage({ from: { kind: 'employee', id: id.Ben!, name: 'Ben (Backend Engineer)' }, toEmployeeId: dee.id, body: 'Can you look at the export?' });
  rested(eng.core.runningSessionOf(id.Ben)!);
  const meeting = eng.meetings.create({ topic: 'Where do exports live?', participantIds: [id.Ben!, dee.id] });
  assert.deepEqual(meeting.absent, [], 'someone asleep is invited, not recorded as absent');
  await sleep(40);
  assert.equal(starts().length, n + 1, 'one start for both');
  const spec = starts().at(-1)!.params.spec;
  assert.equal(spec.resume, true, 'continuing the conversation');
  assert.equal(spec.claudeSessionId, before.claudeSessionId);
  assert.equal(spec.cwd, before.cwd, 'in the folder they were in');
  const woken = eng.core.store.queryEvents({ types: ['session.woken'] as any }).filter((e) => e.employeeId === dee.id);
  assert.equal(woken.length, 1);
  assert.match(woken[0]!.summary, /Dee was woken for a message from Ben \(Backend Engineer\) — continuing where they left off/);
  const s = eng.core.runningSessionOf(dee.id)!;
  assert.deepEqual([s.id, s.asleepSince, s.resumed], [before.id, null, true]);
  // Once Claude Code says it is up, what woke them is delivered.
  const p = pasted.length;
  rested(s);
  await delivered('Dee');
  await sleep(80);
  await eng.comms.pump(dee.id);
  await sleep(10);
  assert.ok(pasted.slice(p).some((t) => /Message from Ben \(Backend Engineer\): Can you look at the export\?/.test(t)));
  eng.meetings.cancel(meeting.id);

  // Someone who was never started is not started by a teammate's message: that is as it was.
  const never = eng.employees.create({ name: 'Eve', roleKey: 'backend', projectId: id.shop, hostId: id.host, workingDir: '/tmp/eve' });
  const k = starts().length;
  eng.comms.sendMessage({ from: { kind: 'employee', id: id.Ben!, name: 'Ben (Backend Engineer)' }, toEmployeeId: never.id, body: 'Welcome.' });
  await sleep(30);
  assert.equal(starts().length, k);
  assert.equal(eng.sessions.present(never.id), false);
  assert.throws(() => eng.meetings.create({ topic: 'x', participantIds: [never.id, eve2()] }), /none of the invited employees has a running session/);
  function eve2(): string {
    return eng.employees.create({ name: 'Eve Two', roleKey: 'backend', projectId: id.shop, hostId: id.host, workingDir: '/tmp/eve2' }).id;
  }
});

test('a conversation that cannot be continued is said so, and the next start is a new one', async () => {
  const dee = eng.core.employees.require(id.Dee!);
  let s = rested(eng.core.runningSessionOf(dee.id)!);
  s.activitySince = new Date(Date.now() - 1000).toISOString();
  eng.core.put('session', s);
  // What was handed to her a moment ago is still waiting to be acknowledged: not the moment to stop the session.
  if (eng.comms.pending(dee.id)) assert.equal(eng.sleeper.keptAwake(dee, s, Date.now() + 31 * MIN), 'something is on its way to them');
  await sleep(80);
  await eng.comms.pump(dee.id);
  await sleep(80);
  assert.equal(eng.sleeper.keptAwake(dee, s, Date.now() + 31 * MIN), null);
  assert.ok((await eng.sleeper.tick(Date.now() + 31 * MIN)) >= 1);
  assert.equal(eng.sessions.asleep(dee.id), true);
  const conversation = eng.core.sessions.require(s.id).claudeSessionId;
  const n = starts().length;
  eng.comms.sendMessage({ from: { kind: 'employee', id: id.Ben!, name: 'Ben' }, toEmployeeId: dee.id, body: 'Still there?' });
  await sleep(30);
  assert.equal(starts().length, n + 1);
  assert.equal(starts().at(-1)!.params.spec.resume, true);
  // Claude Code ends at once, without a single sign of life: it could not continue that conversation.
  s = eng.core.runningSessionOf(dee.id)!;
  eng.sessions.onHostReportedGone(id.host!, s.id, 'process exited (1)', s.launchId);
  const said = eng.core.store.queryEvents({ types: ['session.stopped'] as any }).filter((e) => e.employeeId === dee.id && (e.data as any).resumeFailed);
  assert.equal(said.length, 1);
  assert.match(said[0]!.summary, /Dee's earlier conversation could not be continued[\s\S]*The next start begins a new conversation/);
  // What they were woken for is still waiting: one more start, clean.
  await sleep(450);
  assert.equal(starts().length, n + 2);
  const fresh = starts().at(-1)!.params.spec;
  assert.equal(fresh.resume, false);
  assert.notEqual(fresh.claudeSessionId, conversation);
  rested(eng.core.runningSessionOf(dee.id)!);
  await delivered('Dee');
  assert.equal(eng.core.messages.find((m) => m.body === 'Still there?')!.delivery.status, 'confirmed');
});

test('the sleep setting: minutes, off at zero, never less than five', () => {
  assert.equal(sanitizeSleep(0, 30), 0);
  assert.equal(sanitizeSleep(-4, 30), 0);
  assert.equal(sanitizeSleep(2, 30), 5);
  assert.equal(sanitizeSleep(44.6, 30), 45);
  assert.equal(sanitizeSleep(1e9, 30), 1440);
  assert.equal(sanitizeSleep('soon', 30), 30);
  assert.equal(eng.core.updateSettings({ sleepAfterMinutes: 3 }).sleepAfterMinutes, 5);
  assert.equal(eng.core.updateSettings({ companyName: 'Acme' }).sleepAfterMinutes, 5, 'other changes leave it alone');
  assert.equal(eng.core.updateSettings({ sleepAfterMinutes: 30 }).sleepAfterMinutes, 30);
  assert.equal(new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined }).core.settings.sleepAfterMinutes, 30, 'on by default: half an hour');
});
