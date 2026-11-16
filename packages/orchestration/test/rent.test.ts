import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from '@orchestrator/contracts';
import { RENT_PERMS_DEFAULT } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';
import { permsFrom } from '../src/rent.ts';

/**
 * Renting employees out (`docs/RENT.md`), the rules alone: who reaches whom, which of the office's tools a rented
 * employee is given, what their fence on the machine holds, and what may be rented at all. No machine, no model.
 */
const sent: Array<{ method: string; params: any }> = [];
const link: AgentLink = {
  rpc: async (_h, rpc) => {
    sent.push(rpc as { method: string; params: any });
    return { ok: true } as never;
  },
  isOnline: () => true,
  respondHook: () => true,
  disconnect: () => undefined,
};
const now = () => new Date().toISOString();
const shared: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: now(), lastSeenAt: null, revokedAt: null, local: true };
const mine: Host = { ...shared, id: 'host-2', name: 'mila-mac', memberId: 'm-1', memberName: 'Mila' };

function office() {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0, sleepIdleMs: 1 } }, { send: () => undefined });
  eng.core.put('host', shared);
  eng.core.put('host', mine);
  const make = (name: string, roleKey = 'backend', hostId = shared.id) => eng.employees.create({ name, roleKey, hostId, workingDir: `/work/${name.toLowerCase()}` });
  return { eng, kira: make('Kira'), lea: make('Lea', 'frontend'), bob: make('Bob', 'qa'), own: make('Own', 'backend', mine.id) };
}
const never = () => false;

test('a client rents employees on the office\'s own machines — one client at a time — and not the foreman or a member\'s own', () => {
  const { eng, kira, lea, own } = office();
  const c = eng.rent.create({ name: 'Ana', company: 'Acme', employeeIds: [kira.id, lea.id] }, 'owner', never);
  assert.deepEqual(eng.rent.agentsOf(c).map((e) => e.name), ['Kira', 'Lea']);
  assert.equal(eng.rent.rentalOf(kira.id)?.client.id, c.id);
  assert.throws(() => eng.rent.create({ name: 'Other', employeeIds: [kira.id] }, 'owner', never), /rented to Ana already/);
  assert.throws(() => eng.rent.create({ name: 'Other', employeeIds: [own.id] }, 'owner', never), /member's own computer/);
  assert.throws(() => eng.rent.create({ name: 'ana' }, 'owner', never), /taken/);
  assert.throws(() => eng.rent.create({ name: 'Somebody' }, 'owner', (n) => n === 'Somebody'), /taken/, 'a member has that name');
  // A name cannot carry what would make it something else in a prompt.
  assert.equal(eng.rent.create({ name: 'Eve <b>[x]</b>​' }, 'owner', never).name, 'Eve b x /b');
});

test('the wall: a rented employee reaches only the colleagues the same client rents; nobody else reaches them, but the foreman', () => {
  const { eng, kira, lea, bob } = office();
  const foreman = eng.employees.create({ name: 'Boss', roleKey: 'foreman', hostId: shared.id });
  const other = eng.employees.create({ name: 'Zed', roleKey: 'backend', hostId: shared.id });
  const ana = eng.rent.create({ name: 'Ana', employeeIds: [kira.id, lea.id] }, 'owner', never);
  eng.rent.create({ name: 'Ivo', employeeIds: [other.id] }, 'owner', never);
  assert.equal(eng.rent.reaches(kira, lea), true);
  assert.equal(eng.rent.reaches(kira, bob), false);
  assert.equal(eng.rent.reaches(bob, kira), false);
  assert.equal(eng.rent.reaches(kira, other), false, "another client's employee");
  assert.equal(eng.rent.reaches(foreman, kira), true);
  assert.equal(eng.rent.reaches(kira, foreman), false);
  assert.equal(eng.rent.reaches(bob, foreman), true, 'nobody rented: as ever');
  assert.match(eng.rent.wall(kira, bob)!, /not one of the colleagues you work with for Ana/);
  // Resolving a teammate by name goes through the wall.
  assert.equal(eng.comms.resolveTeammate(kira, 'Bob'), undefined);
  assert.equal(eng.comms.resolveTeammate(kira, 'Lea')?.id, lea.id);
  assert.equal(eng.comms.resolveTeammate(bob, 'Kira'), undefined);
  // Teamwork off for one of them: the two do not reach each other either.
  eng.rent.setPerms(ana.id, lea.id, { teamwork: false }, 'owner');
  assert.equal(eng.rent.reaches(kira, lea), false);
  // Released: the office's again.
  eng.rent.release(ana.id, kira.id, 'owner');
  assert.equal(eng.rent.reaches(kira, bob), true);
});

test("the office's tools a rented employee is given follow the rental", () => {
  const { eng, kira, bob } = office();
  const ana = eng.rent.create({ name: 'Ana', employeeIds: [kira.id] }, 'owner', never);
  assert.equal(eng.rent.toolAllowed(bob, 'vault_list'), null, 'not rented: not decided here');
  assert.equal(eng.rent.toolAllowed(kira, 'send_message'), true);
  assert.equal(eng.rent.toolAllowed(kira, 'ask_boss'), true);
  assert.equal(eng.rent.toolAllowed(kira, 'attach_file'), true);
  assert.equal(eng.rent.toolAllowed(kira, 'vault_list'), false);
  assert.equal(eng.rent.toolAllowed(kira, 'recall'), false);
  assert.equal(eng.rent.toolAllowed(kira, 'propose_tasks'), false);
  assert.equal(eng.rent.toolAllowed(kira, 'record_lesson'), false);
  assert.equal(eng.rent.toolAllowed(kira, 'team_hire'), false);
  assert.equal(eng.rent.toolAllowed(kira, 'some_new_tool'), false, 'anything new stays out until named');
  eng.rent.setPerms(ana.id, kira.id, { vault: true, memory: true, files: false, teamwork: false }, 'owner');
  assert.equal(eng.rent.toolAllowed(kira, 'vault_read'), true);
  assert.equal(eng.rent.toolAllowed(kira, 'remember'), true);
  assert.equal(eng.rent.toolAllowed(kira, 'attach_file'), false);
  assert.equal(eng.rent.toolAllowed(kira, 'send_message'), false);
  // The tool list Claude Code is shown is cut the same way.
  const listed = eng.mcp.tools.filter((t) => eng.mcp.listed?.(t, { employee: kira, session: null as never }) ?? true).map((t) => t.name);
  assert.ok(listed.includes('ask_boss') && !listed.includes('send_message') && !listed.includes('propose_tasks'));
});

test('the fence: their folder and their co-rented colleagues\' (with teamwork), what they may do — and it reaches the running session at once', async () => {
  const { eng, kira, lea } = office();
  assert.equal(eng.rent.fenceFor(kira), null, 'not rented: no fence');
  const ana = eng.rent.create({ name: 'Ana', employeeIds: [kira.id, lea.id], perms: { web: false } }, 'owner', never);
  assert.deepEqual(eng.rent.fenceFor(kira, '/work/kira/.worktrees/t-1'), { roots: ['/work/kira', '/work/kira/.worktrees/t-1', '/work/lea'], commands: true, edit: true, web: false, client: 'Ana' });
  assert.deepEqual(eng.rent.denyRulesFor(kira), ['WebFetch', 'WebSearch']);
  assert.deepEqual(eng.rent.extraDirsFor(kira), ['/work/lea']);
  // A running session is sent its new fence when the rental changes.
  eng.core.put('session', { id: 's-kira', employeeId: kira.id, hostId: shared.id, origin: 'managed', mode: 'interactive_cli', tmuxSession: 'k', tmuxPane: null, cwd: '/work/kira', repoRoot: null, branch: null, claudeSessionId: 'c', status: 'running', activity: 'idle', activityDetail: null, activitySince: now(), inTurn: false, control: 'AGENT_CONTROLLED', controllerId: null, capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false }, permissionMode: null, model: null, cols: 1, rows: 1, pid: null, usage: null, startedAt: now(), endedAt: null, lastEventAt: null, exitReason: null } as never);
  sent.length = 0;
  eng.rent.setPerms(ana.id, kira.id, { commands: false, teamwork: false }, 'owner');
  await new Promise((r) => setTimeout(r, 10));
  const pushed = sent.find((s) => s.method === 'session.fence' && s.params.sessionId === 's-kira');
  assert.deepEqual(pushed?.params.fence, { roots: ['/work/kira'], commands: false, edit: true, web: false, client: 'Ana' });
  eng.rent.revoke(ana.id, 'owner');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.filter((s) => s.method === 'session.fence').pop()?.params.fence, null, 'the client is gone: the fence is taken down');
});

test('permissions are read from what is sent: only known switches, only booleans', () => {
  assert.deepEqual(permsFrom({ commands: false, edit: 'no', nonsense: true }), { ...RENT_PERMS_DEFAULT, commands: false });
  assert.deepEqual(permsFrom(null), RENT_PERMS_DEFAULT);
});

test('a turn is a client\'s when the message that began it was theirs; anything else is the office\'s', () => {
  const { eng, kira } = office();
  const ana = eng.rent.create({ name: 'Ana', employeeIds: [kira.id] }, 'owner', never);
  const m = eng.comms.sendMessage({ from: { kind: 'owner', id: null, name: 'Ana (a client who rents you)' }, toEmployeeId: kira.id, body: 'hi', channel: 'rent', clientId: ana.id });
  const o = eng.comms.sendMessage({ from: { kind: 'owner', id: null, name: 'the boss' }, toEmployeeId: kira.id, body: 'hello' });
  eng.rent.turnStarted(kira.id, m.id);
  assert.equal(eng.rent.clientOfTurn(kira.id), ana.id);
  eng.rent.turnStarted(kira.id, o.id);
  assert.equal(eng.rent.clientOfTurn(kira.id), null);
  eng.rent.turnStarted(kira.id, m.id);
  eng.rent.turnStarted(kira.id, null);
  assert.equal(eng.rent.clientOfTurn(kira.id), null, 'a task, or a person at the keyboard');
});
