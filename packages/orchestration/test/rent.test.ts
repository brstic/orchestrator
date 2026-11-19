import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from '@orchestrator/contracts';
import { RENT_PERMS_DEFAULT } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { handleMcpPost } from '@orchestrator/integrations';
import { Engine, type AgentLink } from '../src/index.ts';
import { permsFrom } from '../src/rent.ts';

/**
 * Renting employees out (`docs/RENT.md`), the rules alone: who reaches whom, which of the office's tools a rented
 * employee is given, what their fence on the machine holds, and what may be rented at all. No machine, no model.
 */
const sent: Array<{ method: string; params: any }> = [];
/** Machines that are not connected (a member's computer that is off). */
const off = new Set<string>();
const link: AgentLink = {
  rpc: async (_h, rpc) => {
    sent.push(rpc as { method: string; params: any });
    return { ok: true } as never;
  },
  isOnline: (hostId) => !off.has(hostId),
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
  // Several clients may rent the same employee; one client rents them once.
  const other = eng.rent.create({ name: 'Other', employeeIds: [kira.id] }, 'owner', never);
  assert.deepEqual(eng.rent.rentalsOf(kira.id).map((r) => r.client.name), ['Ana', 'Other']);
  assert.throws(() => eng.rent.rent(other.id, kira.id, {}, 'owner'), /rented to Other already/);
  eng.rent.revoke(other.id, 'owner');
  assert.throws(() => eng.rent.create({ name: 'Other', employeeIds: [own.id] }, 'owner', never), /Mila's own computer: only they can rent them out/);
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

test("an owner rents the employees on their own computer too — not somebody else's — when its app can fence them; while it is off, a client's words wait", async () => {
  const { eng, own, bob } = office();
  // Mila (the member whose computer it is) may; anybody else may not.
  assert.match(eng.rent.rentable(own, 'someone-else')!, /only they can rent them out/);
  assert.equal(eng.rent.rentable(own, 'm-1'), null);
  // A computer whose app is from before Rent cannot keep them to their folders.
  eng.core.put('host', { ...mine, info: { hostname: 'mila-mac', platform: 'darwin', arch: 'arm64', agentVersion: '0.1.0', tmuxVersion: null, claudeVersion: null } as never });
  assert.match(eng.rent.rentable(own, 'm-1')!, /too old to keep a rented employee to their folders/);
  eng.core.put('host', { ...mine, info: { hostname: 'mila-mac', platform: 'darwin', arch: 'arm64', agentVersion: '0.1.0', tmuxVersion: null, claudeVersion: null, rentFence: true } as never });
  const c = eng.rent.create({ name: 'Ana', employeeIds: [own.id, bob.id] }, 'owner', never, 'm-1');
  // Her computer is off: the words are kept, she is told the employee is away, and nothing is started.
  off.add(mine.id);
  try {
    assert.equal(eng.rent.agentView(own, c.rentals[0]!).state, 'away');
    assert.equal(eng.rent.agentView(own, c.rentals[0]!).offline, true);
    const line = await eng.rent.say(c.id, own.id, 'are you there?', [], 'client:x');
    assert.equal(line.from, 'client');
    const lines = eng.rent.lines(c.id, own.id);
    assert.match(lines[lines.length - 1]!.text, /away right now\. They get this as soon as they are back/);
    const m = eng.core.messages.get(line.messageId!)!;
    assert.equal(m.channel, 'rent');
    assert.equal(m.delivery.status, 'queued');
    await assert.rejects(() => eng.rent.say(c.id, own.id, 'a file', ['f1'], 'client:x'), /send the files when they are back/);
  } finally {
    off.delete(mine.id);
  }
  // Her folder is on her computer: the shared colleague's is not hers to reach, and hers is not his.
  assert.deepEqual(eng.rent.fenceFor(own)!.roots, ['/work/own']);
  assert.deepEqual(eng.rent.fenceFor(bob)!.roots, ['/work/bob']);
});

test('"anywhere" and "never waits": the fence opens and nothing waits for the office — and rentals from before both existed take them on only where every switch was on', () => {
  const store = new Store(':memory:');
  // Two rentals written before the two switches existed: one with everything on, one with commands off.
  const mk = () => new Engine({ store, agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0, sleepIdleMs: 1 } }, { send: () => undefined });
  const first = mk();
  first.core.put('host', shared);
  const a = first.employees.create({ name: 'Iso', roleKey: 'backend', hostId: shared.id, workingDir: '/work/iso' });
  const b = first.employees.create({ name: 'Trk', roleKey: 'backend', hostId: shared.id, workingDir: '/work/trk' });
  const all = { commands: true, edit: true, web: true, teamwork: true, files: true, vault: true, memory: true };
  store.kvSet('rent.clients', [
    { id: 'c1', name: 'Lazar', company: null, note: '', createdAt: now(), createdBy: 'owner', revokedAt: null, lastSeenAt: null, rentals: [{ employeeId: a.id, since: now(), perms: all }] },
    { id: 'c2', name: 'Other', company: null, note: '', createdAt: now(), createdBy: 'owner', revokedAt: null, lastSeenAt: null, rentals: [{ employeeId: b.id, since: now(), perms: { ...all, commands: false } }] },
  ]);
  const eng = mk();
  const iso = eng.core.employees.require(a.id);
  const trk = eng.core.employees.require(b.id);
  assert.deepEqual([eng.rent.rentalOf(iso.id)!.rental.perms.anywhere, eng.rent.rentalOf(iso.id)!.rental.perms.autonomous], [true, true]);
  assert.deepEqual([eng.rent.rentalOf(trk.id)!.rental.perms.anywhere, eng.rent.rentalOf(trk.id)!.rental.perms.autonomous], [false, false]);
  // Never waits: nothing asked of the owner; what the switches allow runs unasked; what they do not, does not.
  assert.equal(eng.rent.toolAllowed(iso, 'ask_boss'), false);
  assert.equal(eng.rent.toolAllowed(trk, 'ask_boss'), true);
  assert.equal(eng.rent.mayRunUnasked(iso.id, 'Bash'), true);
  assert.equal(eng.rent.mayRunUnasked(trk.id, 'Bash'), false);
  eng.rent.setPerms('c1', iso.id, { web: false }, 'owner');
  assert.equal(eng.rent.mayRunUnasked(iso.id, 'WebFetch'), false);
  // The fence the machine gets says so.
  assert.equal(eng.rent.fenceFor(iso)!.anywhere, true);
  assert.equal(eng.rent.fenceFor(iso)!.autonomous, true);
  assert.equal(eng.rent.fenceFor(trk)!.anywhere, undefined);
});

test('"office work": a rented employee goes on with the whole office — the board, every colleague both ways, office work — and rentals that had everything on take it', () => {
  const { eng, kira, bob } = office();
  const c = eng.rent.create({ name: 'Support', employeeIds: [kira.id] }, 'owner', never);
  // Walled in by default: no board, no colleague outside.
  assert.equal(eng.rent.toolAllowed(kira, 'propose_tasks'), false);
  assert.equal(eng.comms.resolveTeammate(kira, 'Bob'), undefined);
  assert.equal(eng.rent.isWalled(kira.id), true);
  eng.rent.setPerms(c.id, kira.id, { office: true }, 'owner');
  assert.equal(eng.rent.toolAllowed(kira, 'propose_tasks'), true);
  assert.equal(eng.rent.toolAllowed(kira, 'give_task'), true);
  assert.equal(eng.rent.toolAllowed(kira, 'team_hire'), false, "a lead's own tools stay a lead's");
  assert.equal(eng.rent.toolAllowed(kira, 'assign_task'), false, "the foreman's stay the foreman's");
  assert.equal(eng.rent.toolAllowed(kira, 'vault_list'), false, 'the vault still goes with its own switch');
  assert.equal(eng.comms.resolveTeammate(kira, 'Bob')?.id, bob.id);
  assert.equal(eng.comms.resolveTeammate(bob, 'Kira')?.id, kira.id, 'and colleagues reach them');
  assert.equal(eng.rent.isWalled(kira.id), false);
  // A rental written before the switch, with every other switch on, takes it.
  const store = new Store(':memory:');
  const all = { commands: true, edit: true, web: true, teamwork: true, files: true, vault: true, memory: true, anywhere: true, autonomous: true };
  store.kvSet('rent.clients', [{ id: 'c9', name: 'S', company: null, note: '', createdAt: now(), createdBy: 'owner', revokedAt: null, lastSeenAt: null, rentals: [{ employeeId: 'e1', since: now(), perms: all }, { employeeId: 'e2', since: now(), perms: { ...all, vault: false } }] }]);
  const eng2 = new Engine({ store, agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0, sleepIdleMs: 1 } }, { send: () => undefined });
  const perms = eng2.rent.get('c9')!.rentals.map((r) => r.perms.office);
  assert.deepEqual(perms, [true, false]);
});

test('one employee, several clients: each conversation its own, told to keep each client\'s words apart; one session under the widest switches; teamwork per client', async () => {
  const { eng, kira, lea, bob } = office();
  const ana = eng.rent.create({ name: 'Ana', employeeIds: [kira.id, lea.id], perms: { web: false } }, 'owner', never);
  const ivo = eng.rent.create({ name: 'Ivo', employeeIds: [kira.id, bob.id], perms: { commands: false } }, 'owner', never);
  // The widest switches of the two: web from Ivo's rental, commands from Ana's.
  const p = eng.rent.perms(kira.id)!;
  assert.deepEqual([p.web, p.commands], [true, true]);
  assert.equal(eng.rent.fenceFor(kira)!.client, 'Ana, Ivo');
  // Teamwork per client: Kira reaches Lea (Ana's) and Bob (Ivo's); Lea and Bob — of different clients — do not reach each other.
  assert.equal(eng.rent.reaches(kira, lea), true);
  assert.equal(eng.rent.reaches(kira, bob), true);
  assert.equal(eng.rent.reaches(lea, bob), false);
  assert.deepEqual(eng.rent.fenceFor(kira)!.roots, ['/work/kira', '/work/lea', '/work/bob']);
  assert.deepEqual(eng.rent.fenceFor(lea)!.roots, ['/work/lea', '/work/kira']);
  // Each client's words go to Kira with the other named, and the line stays in that client's conversation alone.
  eng.core.put('session', { id: 's-k', employeeId: kira.id, hostId: shared.id, origin: 'managed', mode: 'interactive_cli', tmuxSession: 'k', tmuxPane: null, cwd: '/work/kira', repoRoot: null, branch: null, claudeSessionId: 'c', status: 'running', activity: 'idle', activityDetail: null, activitySince: now(), inTurn: false, control: 'AGENT_CONTROLLED', controllerId: null, capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false }, permissionMode: null, model: null, cols: 1, rows: 1, pid: null, usage: null, startedAt: now(), endedAt: null, lastEventAt: null, exitReason: null } as never);
  const line = await eng.rent.say(ana.id, kira.id, 'for Kira, from Ana', [], 'client:a');
  const m = eng.core.messages.get(line.messageId!)!;
  assert.match(m.body, /Other clients rent you too \(Ivo\): what each of them tells you is theirs — do not pass it on to Ana/);
  assert.equal(eng.rent.lines(ana.id, kira.id).length, 1);
  assert.equal(eng.rent.lines(ivo.id, kira.id).length, 0);
  // The answer goes to the client whose message began the turn.
  eng.rent.turnStarted(kira.id, m.id);
  assert.equal(eng.rent.clientOfTurn(kira.id), ana.id);
  // Ana leaves: Kira is still Ivo's, under Ivo's switches alone.
  eng.rent.revoke(ana.id, 'owner');
  assert.deepEqual(eng.rent.rentalsOf(kira.id).map((r) => r.client.name), ['Ivo']);
  assert.equal(eng.rent.perms(kira.id)!.commands, false);
});

test('message_client: a rented employee writes to a client of theirs when not answering them — the line is in that conversation at once; nobody else is reachable', async () => {
  const { eng, kira, lea, bob } = office();
  const call = async (who: typeof kira, args: Record<string, unknown>) => {
    const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'message_client', arguments: args } }, eng.mcp, { employee: who, session: { id: `s-${who.id}`, employeeId: who.id, hostId: who.hostId } as any });
    return { text: String(res.body.result?.content?.[0]?.text ?? JSON.stringify(res.body)), isError: res.body.result?.isError === true };
  };
  const listed = (who: typeof kira) => eng.mcp.tools.filter((t) => eng.mcp.listed?.(t, { employee: who, session: null as never }) ?? true).map((t) => t.name);
  const ana = eng.rent.create({ name: 'Ana Client', company: 'Acme', employeeIds: [kira.id] }, 'owner', never);
  const heard: string[] = [];
  eng.core.bus.on('event', (e) => e.type === 'rent.agent_wrote' && heard.push(e.summary));

  // Shown only to somebody a client rents; anybody else is told there is nobody to write to.
  assert.ok(listed(kira).includes('message_client'));
  assert.ok(!listed(bob).includes('message_client'));
  assert.match((await call(bob, { message: 'hi' })).text, /No client rents you/);

  // One client: "to" may be left out. The boss asked on Telegram (an office turn): the line is in Ana's conversation, from the employee.
  eng.rent.turnStarted(kira.id, eng.comms.sendMessage({ from: { kind: 'owner', id: null, name: 'the boss' }, toEmployeeId: kira.id, body: 'ask them where the idea came from', channel: 'telegram' }).id);
  const r = await call(kira, { message: 'One question from the boss: where did this come from?' });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Sent to Ana Client/);
  assert.deepEqual(
    eng.rent.lines(ana.id, kira.id).map((l) => [l.from, l.text]),
    [['agent', 'One question from the boss: where did this come from?']],
  );
  assert.deepEqual(heard, ['Kira wrote to Ana Client on the Rent portal']);

  // While answering Ana herself, the reply goes to her anyway: no second copy.
  eng.rent.turnStarted(kira.id, eng.comms.sendMessage({ from: { kind: 'owner', id: null, name: 'Ana Client (a client who rents you)' }, toEmployeeId: kira.id, body: 'hi', channel: 'rent', clientId: ana.id }).id);
  assert.match((await call(kira, { message: 'again' })).text, /answering Ana Client right now/);
  eng.rent.turnStarted(kira.id, null);

  // Several clients: by name, first name or company; a client not theirs is refused with whom they can write to.
  const ivo = eng.rent.create({ name: 'Ivo', employeeIds: [kira.id, lea.id] }, 'owner', never);
  assert.match((await call(kira, { message: 'x' })).text, /Several clients rent you.*Ana Client, Ivo/);
  assert.equal((await call(kira, { to: 'acme', message: 'For Acme.' })).isError, false);
  assert.equal((await call(kira, { to: 'ivo', message: 'For Ivo.' })).isError, false);
  assert.match((await call(kira, { to: 'Zed', message: 'x' })).text, /No client of yours is called "Zed". You can write to: Ana Client, Ivo/);
  assert.match((await call(lea, { to: 'Ana', message: 'x' })).text, /No client of yours/, "Lea is not rented to Ana");
  assert.deepEqual(eng.rent.lines(ivo.id, kira.id).map((l) => l.text), ['For Ivo.']);
  assert.equal(eng.rent.lines(ana.id, kira.id).at(-1)!.text, 'For Acme.');
  assert.match((await call(kira, { to: 'Ivo', message: '  ' })).text, /Write the message/);

  // The employee is told of it in every client message.
  const told = (eng.rent as any).body(ana, kira, ana.rentals[0], 'hello') as string;
  assert.match(told, /To write to Ana Client later, not in answer to them .* use message_client/);
});
