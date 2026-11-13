import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DECORATION_KINDS, isWorking, type AgentSession, type Host } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, WorkLog, monthOf, type AgentLink } from '../src/index.ts';

/**
 * The employee of the month: whoever's session spent the most time in a working state this calendar month.
 * The work log is looked at with a clock of its own here (`tick(now)`), so nothing waits for real time.
 */
const link: AgentLink = { rpc: () => Promise.reject(new Error('this test host runs nothing')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };
const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
const MIN = 60_000;
/** The middle of a month, so that a test never crosses into the next one by accident. */
const T0 = Date.parse('2026-11-13T10:00:00.000Z');

function office(store = new Store(':memory:')) {
  const eng = new Engine({ store, agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0, workTickMs: MIN } }, { send: () => undefined });
  eng.core.put('host', host);
  const hire = (name: string, roleKey = 'backend') => eng.employees.create({ name, roleKey, hostId: host.id, workingDir: '/tmp/x' });
  const session = (employeeId: string, activity: AgentSession['activity'], at: number, over: Partial<AgentSession> = {}): AgentSession => {
    const iso = new Date(at).toISOString();
    return eng.core.put('session', {
      id: `s-${employeeId.slice(0, 8)}`, employeeId, hostId: host.id, origin: 'managed', mode: 'interactive_cli', tmuxSession: 'x', tmuxPane: '%1', cwd: '/tmp/x', repoRoot: null, branch: null, claudeSessionId: 'c',
      status: 'running', activity, activityDetail: null, activitySince: iso, inTurn: true, control: 'AGENT_CONTROLLED', controllerId: null,
      capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false },
      permissionMode: null, model: null, cols: 120, rows: 34, pid: 1, usage: null, startedAt: iso, endedAt: null, lastEventAt: iso, exitReason: null, ...over,
    } as AgentSession);
  };
  /** Minutes pass, a look every minute; every session is heard from all along. */
  const pass = (log: WorkLog, from: number, minutes: number): number => {
    for (let i = 1; i <= minutes; i++) {
      for (const s of eng.core.sessions.all()) eng.core.put('session', { ...s, lastEventAt: new Date(from + i * MIN).toISOString() });
      log.tick(from + i * MIN);
    }
    return from + minutes * MIN;
  };
  return { eng, hire, session, pass };
}

test('what counts as work: doing something — not being away, between turns, or waiting for somebody', () => {
  for (const state of ['thinking', 'reading', 'coding', 'testing', 'debugging', 'running_command', 'researching', 'planning', 'reviewing', 'delegating', 'meeting'] as const) assert.equal(isWorking(state), true, state);
  for (const state of ['offline', 'unknown', 'idle', 'waiting_answer', 'needs_approval', 'blocked', 'waiting_input', 'task_complete', 'paused'] as const) assert.equal(isWorking(state), false, state);
  assert.equal(isWorking(null), false);
  assert.ok(DECORATION_KINDS.some((k) => k.kind === 'employee_of_month' && k.label === 'Employee of the month' && !k.unlock), 'it can be placed in any office');
});

test('whoever works the most this month is the employee of the month; waiting and being idle count for nothing', () => {
  const o = office();
  const [alex, sarah, noor] = [o.hire('Alex'), o.hire('Sarah'), o.hire('Noor')];
  const log = new WorkLog(o.eng);
  log.start(T0);
  assert.equal(o.eng.core.company.employeeOfMonth ?? null, null, 'nobody has worked yet');
  o.session(alex.id, 'coding', T0);
  o.session(sarah.id, 'needs_approval', T0);
  o.session(noor.id, 'idle', T0, { inTurn: false });
  let now = o.pass(log, T0, 30);
  assert.deepEqual(o.eng.core.company.employeeOfMonth, { employeeId: alex.id, month: '2026-11', ms: 1 * MIN }, 'the leader from their first minute; the figure moves by whole hours');
  assert.deepEqual([log.workedMs(alex.id), log.workedMs(sarah.id), log.workedMs(noor.id)], [30 * MIN, 0, 0]);
  // Sarah is answered and works for longer than Alex did; Alex is between turns meanwhile.
  o.session(alex.id, 'idle', now, { inTurn: false });
  o.session(sarah.id, 'testing', now);
  now = o.pass(log, now, 29);
  assert.equal(o.eng.core.company.employeeOfMonth!.employeeId, alex.id, 'a minute short');
  now = o.pass(log, now, 2);
  assert.equal(o.eng.core.company.employeeOfMonth!.employeeId, sarah.id);
  assert.equal(o.eng.core.store.recentAudit(20).filter((a) => a.action === 'employee_of_month').length, 2, 'each change of leader is on the record');
  log.stop();
});

test('a session nobody has heard from for a quarter of an hour is not at work, and a stopped clock adds no hours', () => {
  const o = office();
  const alex = o.hire('Alex');
  const log = new WorkLog(o.eng);
  log.start(T0);
  o.session(alex.id, 'thinking', T0);
  // It says "thinking" and nothing has come from it since: the first quarter of an hour is believed, the rest is not.
  for (let i = 1; i <= 60; i++) log.tick(T0 + i * MIN);
  assert.equal(log.workedMs(alex.id), 15 * MIN);
  // The office's process stood still for three hours (a laptop asleep): one look is two ticks at most.
  const later = T0 + 4 * 60 * MIN;
  o.session(alex.id, 'coding', later);
  log.tick(later);
  assert.equal(log.workedMs(alex.id), 17 * MIN);
  log.stop();
});

test('a foreman, a team lead and somebody archived are not in it; a tie stays with whoever leads', () => {
  const o = office();
  const [mira, alex, sarah] = [o.hire('Mira', 'foreman'), o.hire('Alex'), o.hire('Sarah')];
  const log = new WorkLog(o.eng);
  log.start(T0);
  o.session(mira.id, 'reviewing', T0);
  let now = o.pass(log, T0, 120);
  assert.equal(o.eng.core.company.employeeOfMonth ?? null, null, 'the foreman keeps others working');
  o.session(mira.id, 'idle', now, { inTurn: false });
  o.session(alex.id, 'coding', now);
  now = o.pass(log, now, 10);
  o.session(alex.id, 'idle', now, { inTurn: false });
  o.session(sarah.id, 'coding', now);
  now = o.pass(log, now, 10);
  assert.equal(o.eng.core.company.employeeOfMonth!.employeeId, alex.id, 'ten minutes each: whoever led stays');
  // Alex leaves the team: the place goes to who is next.
  o.session(sarah.id, 'idle', now, { inTurn: false });
  o.eng.core.put('session', { ...o.eng.core.sessions.require(`s-${alex.id.slice(0, 8)}`), status: 'ended' });
  o.eng.employees.update(alex.id, { archived: true });
  o.session(sarah.id, 'coding', now);
  now = o.pass(log, now, 1);
  assert.equal(o.eng.core.company.employeeOfMonth!.employeeId, sarah.id);
  log.stop();
});

test('the count is kept through a restart, and a new month starts from nothing — last month\'s stays up until somebody works', () => {
  const store = new Store(':memory:');
  const o = office(store);
  const [alex, sarah] = [o.hire('Alex'), o.hire('Sarah')];
  const log = new WorkLog(o.eng);
  log.start(T0);
  o.session(alex.id, 'coding', T0);
  const now = o.pass(log, T0, 90);
  log.stop();
  assert.deepEqual(o.eng.core.company.employeeOfMonth, { employeeId: alex.id, month: '2026-11', ms: 60 * MIN }, 'said in whole hours');

  // The office is started again in the same month: nothing is lost.
  const again = office(store);
  const log2 = new WorkLog(again.eng);
  log2.start(now + MIN);
  assert.equal(log2.workedMs(alex.id), 90 * MIN);
  assert.equal(again.eng.core.company.employeeOfMonth!.employeeId, alex.id);

  // December comes while nobody works: November's employee of the month is still on the wall.
  const dec = Date.parse('2026-12-01T00:00:30.000Z');
  assert.equal(monthOf(dec), '2026-12');
  for (const s of again.eng.core.sessions.all()) again.eng.core.put('session', { ...s, activity: 'idle', inTurn: false });
  log2.tick(dec);
  assert.equal(log2.workedMs(alex.id), 0);
  assert.deepEqual([again.eng.core.company.employeeOfMonth!.employeeId, again.eng.core.company.employeeOfMonth!.month], [alex.id, '2026-11']);
  // Sarah is the first to work in December.
  again.session(sarah.id, 'coding', dec);
  again.pass(log2, dec, 2);
  assert.deepEqual([again.eng.core.company.employeeOfMonth!.employeeId, again.eng.core.company.employeeOfMonth!.month], [sarah.id, '2026-12']);
  log2.stop();
});

test('an office that has never counted reads the month so far from its record of what each session was doing', () => {
  const o = office();
  const [alex, sarah] = [o.hire('Alex'), o.hire('Sarah')];
  const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();
  const was = (employeeId: string, minutes: number, state: string) => o.eng.core.event({ type: 'session.activity', source: 'server', summary: `→ ${state}`, sessionId: `s-${employeeId.slice(0, 8)}`, employeeId, hostId: host.id, data: { state, detail: null, quiet: true }, ts: at(minutes) } as any);
  // Alex: ten minutes of coding, then waiting for an approval for an hour, then five minutes of testing.
  was(alex.id, 0, 'coding');
  was(alex.id, 10, 'needs_approval');
  was(alex.id, 70, 'testing');
  was(alex.id, 75, 'idle');
  // Sarah: a state that nothing followed for two hours — a quarter of an hour of it is believed.
  was(sarah.id, 0, 'thinking');
  was(sarah.id, 120, 'idle');
  // Last month's work is not this month's.
  o.eng.core.event({ type: 'session.activity', source: 'server', summary: 'old', sessionId: 's-old', employeeId: sarah.id, hostId: host.id, data: { state: 'coding' }, ts: '2026-10-30T10:00:00.000Z' } as any);
  o.eng.core.event({ type: 'session.activity', source: 'server', summary: 'old', sessionId: 's-old', employeeId: sarah.id, hostId: host.id, data: { state: 'idle' }, ts: '2026-10-30T10:14:00.000Z' } as any);
  const log = new WorkLog(o.eng);
  log.start(T0 + 180 * MIN);
  const stored = o.eng.core.store.queryEvents({ types: ['session.activity'], limit: 50 });
  // (Only meaningful if the store keeps the time an event says it happened at.)
  if (stored.some((e) => e.ts === at(10))) {
    assert.deepEqual([log.workedMs(alex.id), log.workedMs(sarah.id)], [15 * MIN, 15 * MIN]);
    assert.ok(o.eng.core.company.employeeOfMonth, 'somebody leads from the first moment');
  } else {
    assert.fail('the test could not write events with a time of their own: rewrite it for how this store stamps events');
  }
  log.stop();
});
