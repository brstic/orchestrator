/**
 * Handoffs between employees, what the office records about deployments and
 * releases, the steps of Claude Code's own task list, security alerts, and a
 * host that runs out of resources.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

process.env.ORCH_RESOURCE_PRESSURE_MS = '400';

let h: Harness;
let repo = '';
let projectId = '';
const ids: Record<string, string> = {};

const done = (id: string, label: string) =>
  waitFor(async () => ((await h.getTask(id)).status === 'DONE' ? h.getTask(id) : null), { label, timeout: 30000 }).catch(async (e) => {
    const t = await h.getTask(id);
    const s = t.assigneeId ? await h.session(t.assigneeId) : undefined;
    throw new Error(`${e.message}\n${t.key} is ${t.status} (${t.blockedReason ?? 'no blocker'}); delivery ${JSON.stringify(t.delivery)}; history: ${t.history.map((x) => x.note).join(' | ')}\nsession: ${s?.status}/${s?.activity} inTurn=${s?.inTurn}\n${s?.tmuxPane ? h.tmux('capture-pane', '-p', '-J', '-S', '-25', '-t', s.tmuxPane) : ''}`);
  });
const events = (q: string) => h.api<any[]>('GET', `/events?limit=500&${q}`);

before(async () => {
  h = await createHarness();
  repo = h.makeRepo('shop');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'shop', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"', deploy: 'echo deployed-to-staging', release: 'node -e "process.exit(3)"' } }, null, 2));
  h.git(repo, 'add', '-A');
  h.git(repo, 'commit', '-q', '-m', 'scripts');
  projectId = (await h.project('Shop', repo, { verifyCommand: 'npm test --silent' })).id;
  for (const [name, role] of [['Alex', 'backend'], ['Sarah', 'frontend']] as const) ids[name] = (await h.employee(name, role, { projectId, autonomy: 'autonomous' })).id;
});
after(async () => {
  await h.cleanup();
});

test('a technical handoff: committed work and notes go to a teammate, who finishes the task', async () => {
  const notes = 'The API half is done and committed in api.txt. What remains is the page that calls it, and keep the route name /orders.';
  const task = await h.task({
    projectId,
    title: 'Orders end to end',
    assigneeId: ids.Alex,
    description: `@@fake: write api.txt orders-api; mcp hand_off_task ${JSON.stringify({ to: 'Sarah', notes })}; say tried-without-committing; commit api half; mcp hand_off_task ${JSON.stringify({ to: 'Sarah', notes })}; say handed-over@@`,
  });
  // The first attempt is refused (nothing committed yet); the second goes through.
  const handed = await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.assigneeId === ids.Sarah ? t : null;
  }, { label: 'handed to Sarah', timeout: 30000 });
  assert.match(handed.description, /Handoff from Alex .*work so far is on branch orch\/alex\/t-\d+-orders-end-to-end:\n.*The API half is done/s);
  assert.ok(handed.history.some((x) => /Handed off by Alex to Sarah/.test(x.note)));
  const handoff = (await events(`taskId=${task.id}`)).find((e) => e.type === 'task.handoff');
  assert.equal(handoff.data.to, ids.Sarah);
  const state = await h.state();
  const msg = state.messages.find((m) => m.kind === 'handoff' && m.toEmployeeId === ids.Sarah);
  assert.match(msg!.body, /I am handing T-\d+ "Orders end to end" over to you/);
  // Sarah's default behaviour for a task without directives is to do nothing useful, so give her the rest.
  await waitFor(async () => (await h.getTask(task.id)).status === 'IN_PROGRESS', { label: 'Sarah started', timeout: 30000 });
  const sarah = (await h.session(ids.Sarah!))!;
  assert.equal(h.git(sarah.cwd!, 'rev-parse', '--abbrev-ref', 'HEAD'), handed.branch, "the same branch, now checked out in Sarah's worktree");
  assert.equal(fs.readFileSync(path.join(sarah.cwd!, 'api.txt'), 'utf8').trim(), 'orders-api', "Alex's committed work is there");
  await h.api('POST', `/employees/${ids.Sarah}/message`, { body: 'Finish it. @@fake: write page.txt orders-page; commit page half; complete orders done end to end@@' });
  const finished = await done(task.id, 'handed-off task done');
  assert.deepEqual(finished.evidence.filesChanged!.sort(), ['api.txt', 'page.txt'], 'both halves were verified and merged as one task');
  assert.equal(finished.evidence.commits!.length, 2);
  // Alex is off the task branch and free for other work.
  const alex = (await h.session(ids.Alex!))!;
  assert.equal(h.git(alex.cwd!, 'rev-parse', '--abbrev-ref', 'HEAD'), 'orch/alex/home');
});

test('deployments and releases seen in a terminal are recorded with their real outcome', async () => {
  const before = (await h.state()).company;
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: 'Ship it. @@fake: bash npm run deploy; bash npm run release; bash git tag v1.2.0; bash echo "npm publish is only mentioned here"; say shipped@@' });
  // Tagging a version is high-risk, so it waits for the owner even on an autonomous employee.
  const q = await waitFor(() => h.openQuestion(ids.Alex!, 'permission'), { label: 'approval for the tag' });
  assert.match(String((q.tool!.input as any).command), /git tag v1\.2\.0/);
  await h.api('POST', `/questions/${q.id}/answer`, { decision: 'allow' });
  // The approval rule is deliberately stricter than the record: a command that merely mentions a publish still asks.
  const q2 = await waitFor(async () => { const x = await h.openQuestion(ids.Alex!, 'permission'); return x && x.id !== q.id ? x : null; }, { label: 'approval for the echo' });
  assert.match(String((q2.tool!.input as any).command), /^echo /);
  await h.api('POST', `/questions/${q2.id}/answer`, { decision: 'allow' });
  await waitFor(async () => (await events(`employeeId=${ids.Alex}`)).some((e) => e.type === 'agent.turn_finished' && /shipped/.test(e.data.lastMessage ?? '')), { label: 'turn finished' });
  const seen = (await events(`employeeId=${ids.Alex}`)).filter((e) => e.type === 'ops.deployment').map((e) => `${e.data.kind}:${e.data.what}:${e.data.ok}`).sort();
  assert.deepEqual(seen, ['deploy:deploy script:false', 'deploy:deploy script:true', 'release:version tag:true'], 'the echo that only mentions a publish is not a deployment');
  const company = (await h.state()).company;
  assert.equal(company.deployments - before.deployments, 3);
  assert.equal(company.deploymentsFailed - before.deploymentsFailed, 1);
  assert.equal(company.releases - before.releases, 1);
  assert.ok((await h.state()).milestones.find((m) => m.key === 'first_release')!.unlockedAt, 'the first real release is a milestone');
});

test('company figures come from what happened: debt paid, time worked, reviews, reliability', async () => {
  const before = (await h.state()).company;
  const task = await h.task({ projectId, title: 'Refactor the order totals', kind: 'refactor', assigneeId: ids.Alex, description: '@@fake: sleep 600; write totals.txt tidy; commit tidy totals; complete simplified@@' });
  assert.equal(task.kind, 'refactor');
  await done(task.id, 'refactor done');
  const company = (await h.state()).company;
  assert.equal(company.debtReduced - before.debtReduced, 1);
  assert.ok(company.agentWorkMs - before.agentWorkMs >= 500, `time in progress was counted (${company.agentWorkMs - before.agentWorkMs} ms)`);
  assert.ok(company.sessionsStarted >= 2);
  assert.equal(company.infrastructureReliability, (company.sessionsStarted - company.sessionsLost) / company.sessionsStarted);
  assert.equal(company.reviewCompletionRate, company.reviewsRequested ? company.reviewsCompleted / company.reviewsRequested : null);
});

test("the steps of Claude Code's own task list show up as progress, not as finished tasks", async () => {
  const tasksBefore = (await h.state()).tasks.length;
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: 'Plan it. @@fake: step Read the order module; step Sketch the totals function; say planned@@' });
  await waitFor(async () => (await events(`employeeId=${ids.Alex}`)).filter((e) => e.type === 'agent.step_completed').length >= 2, { label: 'two steps' });
  const steps = (await events(`employeeId=${ids.Alex}`)).filter((e) => e.type === 'agent.step_completed').map((e) => e.data.subject);
  assert.deepEqual(steps.sort(), ['Read the order module', 'Sketch the totals function']);
  assert.equal((await h.state()).tasks.length, tasksBefore, 'no office task was created or completed by them');
});

test('security issues reach the owner: a refused action, a secret in a session, a machine turned away, a guessed token', async () => {
  const security = async () => (await h.state()).notifications.filter((n) => n.kind === 'security');
  const start = (await security()).length;
  // 1. Claude Code refuses something the employee tried.
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: 'Try it. @@fake: denied rm -rf /var/lib/shop; say refused@@' });
  const refused = await waitFor(async () => (await security()).find((n) => /Alex was refused an action/.test(n.title)), { label: 'refused action alert' });
  assert.match(refused.body, /rm -rf \/var\/lib\/shop/);
  assert.equal(refused.employeeId, ids.Alex);
  // 2. A credential-shaped value goes through a session: reported, and never stored in the clear.
  const key = `sk-${'a1B2c3D4'.repeat(4)}`;
  // Written into a message, it never gets as far as the session: the office moves it to the vault and delivers its name.
  await h.api('POST', `/employees/${ids.Sarah}/message`, { body: `Use this: ${key} @@fake: say used@@` });
  await waitFor(async () => ((await events(`employeeId=${ids.Sarah}`)).some((e) => e.type === 'agent.prompt_submitted' && /Use this: \{\{vault:openai-api-key\}\}/.test(String(e.data.prompt ?? ''))) ? true : null), { label: 'delivered with the name in its place' });
  assert.ok(!(await security()).some((n) => /looks like a secret/.test(n.title)), 'nothing reached a session, so there is nothing to warn about');
  // Met inside the session — a file with a key in it that the employee reads — it is reported, kept in the vault, and never stored in the clear.
  const found = `sk-${'z9Y8x7W6'.repeat(4)}`;
  const sarahCwd = (await h.session(ids.Sarah!))!.cwd;
  fs.writeFileSync(path.join(sarahCwd, 'old-config.txt'), `OPENAI key in use: ${found}\n`);
  await waitFor(async () => ((await h.session(ids.Sarah!))?.inTurn === false ? true : null), { label: 'Sarah between turns' });
  await h.api('POST', `/employees/${ids.Sarah}/message`, { body: 'Read the old config. @@fake: read old-config.txt; say read@@' });
  const alert = await waitFor(async () => (await security()).find((n) => /looks like a secret appeared in Sarah's session/.test(n.title)), { label: 'secret alert' });
  assert.match(alert.body, /It was put in the vault as "openai-api-key-/);
  for (const value of [key, found]) assert.ok(!JSON.stringify([await events(`employeeId=${ids.Sarah}`), await h.state()]).includes(value), 'the value itself is not in the event log or the office state');
  // 3. A machine with a made-up credential is turned away.
  const reply: any = await new Promise((resolve) => {
    const ws = new WebSocket(`${h.url.replace('http', 'ws')}/ws/agent`);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, hostId: h.hostId, credential: 'orch_host_made-up', name: 'intruder', info: { hostname: 'intruder-box' } }));
    ws.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
    ws.onerror = () => resolve({ t: 'error' });
  });
  assert.equal(reply.t, 'rejected');
  const turnedAway = await waitFor(async () => (await security()).find((n) => /A machine was refused/.test(n.title)), { label: 'refused machine alert' });
  assert.match(turnedAway.body, /intruder-box/);
  assert.equal(turnedAway.severity, 'critical');
  // 4. Someone guesses owner tokens.
  for (let i = 0; i < 6; i++) assert.equal((await fetch(`${h.url}/api/state`, { headers: { authorization: `Bearer orch_owner_guess-${i}` } })).status, 401);
  const guessed = await waitFor(async () => (await security()).find((n) => /wrong owner token/.test(n.title)), { label: 'token guessing alert' });
  assert.match(guessed.body, /\d+ requests in the last minute/);
  // Repeats of the same incident do not flood the queue.
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: 'Again. @@fake: denied rm -rf /var/lib/shop; say refused-again@@' });
  await waitFor(async () => (await events(`employeeId=${ids.Alex}`)).some((e) => e.type === 'agent.turn_finished' && /refused-again/.test(e.data.lastMessage ?? '')), { label: 'second attempt done' });
  assert.equal((await security()).length - start, 4, 'one notification per kind of incident');
  assert.equal((await events('')).filter((e) => e.type === 'security.alert').length, 4);
});

test('a host that runs out of memory is reported, gets no new work, and recovers', async () => {
  const sampler = (h.agent as any).sampler;
  const real = sampler.sample.bind(sampler);
  sampler.sample = async () => ({ ...(await real()), memUsedBytes: 97, memTotalBytes: 100 });
  try {
    const warned = await waitFor(async () => (await h.state()).notifications.find((n) => n.kind === 'host_resources' && !n.resolvedAt), { label: 'resource warning', timeout: 30000 });
    assert.match(warned.body, /memory is 97% used\. No new work will be started on it/);
    assert.ok((await events('')).some((e) => e.type === 'host.resource_warning' && e.hostId === h.hostId && !e.data.recovered));
    const task = await h.task({ projectId, title: 'Wait for the machine', assigneeId: ids.Alex, description: '@@fake: write later.txt ok; commit later; complete waited@@' });
    await sleep(1500);
    assert.equal((await h.getTask(task.id)).status, 'READY', 'nothing new starts on an exhausted host');
    sampler.sample = real;
    await waitFor(async () => (await events('')).some((e) => e.type === 'host.resource_warning' && e.data.recovered === true), { label: 'recovered', timeout: 30000 });
    assert.ok((await h.state()).notifications.find((n) => n.id === warned.id)!.resolvedAt, 'the warning is resolved');
    await done(task.id, 'the waiting task runs after recovery');
  } finally {
    sampler.sample = real;
  }
});

test('terminal output is on the record as an amount, never as content', async () => {
  // Output travels to the office only while someone watches the terminal, so watch it.
  const boss = await h.client();
  const session = (await h.session(ids.Alex!))!;
  boss.send({ t: 'term.open', sessionId: session.id });
  await waitFor(() => boss.terminals.has(session.id), { label: 'terminal open' });
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: 'Print. @@fake: say a-line-nobody-should-store-7731@@' });
  const out = await waitFor(async () => {
    const all = await h.api<any[]>('GET', `/events?limit=1000&includeActivity=1&employeeId=${ids.Alex}`);
    const hits = all.filter((e) => e.type === 'terminal.output');
    return hits.length ? hits : null;
  }, { label: 'a terminal.output summary' });
  assert.ok(out.every((e) => e.data.bytes > 0 && Object.keys(e.data).sort().join() === 'bytes,chunks,quiet,sinceMs'), 'only counts are stored');
  assert.ok(!JSON.stringify(out).includes('7731'), 'no terminal content in the event');
  assert.ok(!(await events(`employeeId=${ids.Alex}`)).some((e) => e.type === 'terminal.output'), 'left out of the normal event feed');
  boss.close();
});

test('integration testing and promotion: work that passes alone but breaks together is caught, and only a green, fast-forward integration reaches the base branch', async () => {
  // The check fails only when a.txt and b.txt are both switched ON.
  const combo = h.makeRepo('combo');
  const check = `sh -c '! (grep -qs ON a.txt && grep -qs ON b.txt)'`;
  const project = await h.project('Combo', combo, { verifyCommand: check });
  const dana = (await h.employee('Dana', 'backend', { projectId: project.id, autonomy: 'autonomous' })).id;
  const eli = (await h.employee('Eli', 'frontend', { projectId: project.id, autonomy: 'autonomous' })).id;
  const integration = () => h.api<any>('GET', `/projects/${project.id}/integration`);
  const lastTest = async () => (await h.state()).projects.find((p) => p.id === project.id)!.integration?.lastTest ?? null;

  // Two employees start from the same base; each change passes on its own branch.
  const a = await h.task({ projectId: project.id, title: 'Add part A', assigneeId: dana, description: '@@fake: sleep 1500; write a.txt ON; commit part a; complete a done@@' });
  const b = await h.task({ projectId: project.id, title: 'Add part B', assigneeId: eli, description: '@@fake: sleep 1500; write b.txt ON; commit part b; complete b done@@' });
  for (const t of [a, b]) assert.equal((await done(t.id, 'part done')).evidence.verification!.passed, true);
  // Together they break: the integration run after the second merge says so.
  const failed = await waitFor(async () => { const t = await lastTest(); return t?.passed === false ? t : null; }, { label: 'integration tests fail', timeout: 30000 });
  assert.match(failed.after, /^after merging T-\d+$/);
  const alarm = await waitFor(async () => (await h.state()).notifications.find((n) => n.kind === 'test_failure' && n.projectId === project.id && /integration branch fails its tests/.test(n.title) && !n.resolvedAt), { label: 'owner is told' });
  assert.equal(alarm.severity, 'critical');
  const st1 = await integration();
  assert.ok(st1.ahead >= 2 && st1.behind === 0, `integration is ahead of main (${st1.ahead}/${st1.behind})`);
  assert.equal(st1.baseCheckout, fs.realpathSync(combo));
  // A red integration branch is not promoted.
  const refused = await h.apiRaw('POST', `/projects/${project.id}/promote`, {});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /failed its tests/);
  assert.ok(!fs.existsSync(path.join(combo, 'a.txt')), 'the base branch is untouched');

  // A fix goes through the normal flow; the integration branch turns green and the alarm clears.
  const fix = await h.task({ projectId: project.id, title: 'Switch part B off', assigneeId: dana, description: '@@fake: write b.txt OFF; commit switch b off; complete fixed@@' });
  await done(fix.id, 'fix done');
  await waitFor(async () => (await lastTest())?.passed === true, { label: 'integration tests pass', timeout: 30000 });
  await waitFor(async () => !!(await h.state()).notifications.find((n) => n.id === alarm.id)!.resolvedAt, { label: 'alarm resolved' });

  // The owner commits on the base branch themselves: promotion would no longer be a fast-forward.
  fs.writeFileSync(path.join(combo, 'owner.txt'), 'by hand\n');
  h.git(combo, 'add', '-A');
  h.git(combo, 'commit', '-q', '-m', 'owner change on main');
  assert.equal((await integration()).behind, 1);
  const notFf = await h.apiRaw('POST', `/projects/${project.id}/promote`, {});
  assert.ok(notFf.status >= 400);
  assert.match(notFf.body.error, /has 1 commit that orchestrator\/integration lacks/);
  // Sync brings it into the integration branch (and tests it again).
  const synced = await h.api<any>('POST', `/projects/${project.id}/integration/sync`, {});
  assert.equal(synced.ok, true);
  assert.equal(synced.lastTest.passed, true);
  assert.match(synced.lastTest.after, /after bringing in main/);
  assert.equal((await integration()).behind, 0);
  // Uncommitted work in the owner's checkout is never run over.
  fs.writeFileSync(path.join(combo, 'README.md'), '# edited by the owner, not committed\n');
  const dirty = await h.apiRaw('POST', `/projects/${project.id}/promote`, {});
  assert.ok(dirty.status >= 400);
  assert.match(dirty.body.error, /uncommitted changes/);
  h.git(combo, 'checkout', '--', 'README.md');
  // Now it is a clean fast-forward.
  const head = h.git(combo, 'rev-parse', 'orchestrator/integration');
  const promoted = await h.api<any>('POST', `/projects/${project.id}/promote`, {});
  assert.equal(promoted.integration.lastPromotion.sha, head);
  assert.equal(h.git(combo, 'rev-parse', 'main'), head, 'main is now exactly the integration branch');
  assert.equal(fs.readFileSync(path.join(combo, 'a.txt'), 'utf8').trim(), 'ON', "the work is in the owner's checkout");
  assert.equal(fs.readFileSync(path.join(combo, 'b.txt'), 'utf8').trim(), 'OFF');
  assert.equal(h.git(combo, 'status', '--porcelain'), '');
  const st2 = await integration();
  assert.deepEqual([st2.ahead, st2.behind], [0, 0]);
  const audit = (await h.api<any[]>('GET', '/audit')).filter((x) => x.action === 'project.promoted' || x.action === 'project.integration_synced').map((x) => x.action);
  assert.deepEqual(audit.sort(), ['project.integration_synced', 'project.promoted']);
  // Nothing to promote twice.
  assert.match((await h.apiRaw('POST', `/projects/${project.id}/promote`, {})).body.error, /already has everything/);
});

test('the planning phase: an objective becomes proposed tasks with roles and dependencies, released by the owner and done in order', async () => {
  const repo2 = h.makeRepo('crm');
  const project = await h.project('CRM', repo2, { verifyCommand: 'test -f README.md', policy: { autoAssign: false } });
  const ava = (await h.employee('Ava', 'architect', { projectId: project.id, autonomy: 'autonomous' })).id;
  const ben = (await h.employee('Ben', 'backend', { projectId: project.id, autonomy: 'autonomous' })).id;
  const quin = (await h.employee('Quin', 'qa', { projectId: project.id, autonomy: 'autonomous' })).id;
  const proposal = {
    rationale: 'API first, then the tests that exercise it.',
    tasks: [
      { title: 'Customer API', description: 'Expose customers over HTTP', acceptance: 'GET /customers answers', kind: 'feature', role: 'backend', priority: 'high' },
      { title: 'Customer API tests', description: 'Cover the customer endpoints', acceptance: 'Tests pass', kind: 'test', role: 'qa', depends_on: [0] },
    ],
  };
  const planning = await h.api<any>('POST', `/projects/${project.id}/plan`, { plannerId: ava, objective: `Build the customer system: an API for customers and the tests that exercise it. @@fake: mcp get_team {}; mcp propose_tasks ${JSON.stringify(proposal)}; complete-nocode plan proposed@@` });
  assert.equal(planning.kind, 'planning');
  assert.equal(planning.assigneeId, ava);
  await done(planning.id, 'planning task done');
  // The plan is real board items, waiting for the owner because this project does not auto-assign.
  const state = await h.state();
  const api = state.tasks.find((t) => t.projectId === project.id && t.title === 'Customer API')!;
  const tests = state.tasks.find((t) => t.projectId === project.id && t.title === 'Customer API tests')!;
  assert.deepEqual([api.status, api.released, api.roleHint, api.priority, api.acceptance], ['BACKLOG', false, 'backend', 'high', 'GET /customers answers']);
  assert.deepEqual([tests.status, tests.released, tests.roleHint, tests.dependsOn], ['BACKLOG', false, 'qa', [api.id]]);
  assert.ok(state.notifications.some((n) => /Ava proposed 2 tasks/.test(n.title)), 'the owner is asked to release them');
  const plan = state.artifacts.find((a) => a.kind === 'plan' && a.projectId === project.id)!;
  assert.match(plan.content, /API first, then the tests[\s\S]*Customer API[\s\S]*Customer API tests/);
  assert.ok(state.projects.find((p) => p.id === project.id)!.goals.includes('Build the customer system: an API for customers'));
  // The planner changed no code.
  assert.equal(h.git(repo2, 'rev-list', '--count', '--all').trim(), '1');

  // The owner says what each task should really do, and releases the plan.
  await h.api('PATCH', `/tasks/${api.id}`, { description: `${api.description} @@fake: write api.txt customers; commit customer api; complete api ready@@` });
  await h.api('PATCH', `/tasks/${tests.id}`, { description: `${tests.description} @@fake: bash ls api.txt; write api.test.txt covered; commit api tests; complete tests ready@@` });
  // …and lets the office route them by the roles in the plan.
  await h.api('PATCH', `/projects/${project.id}`, { policy: { autoAssign: true } });
  await h.api('POST', '/tasks/release', { ids: [api.id, tests.id] });
  // The dependent task does not start before its dependency is done, and then starts from a base that contains it.
  await waitFor(async () => (await h.getTask(api.id)).status === 'IN_PROGRESS' || (await h.getTask(api.id)).status === 'DONE', { label: 'API task started' });
  assert.notEqual((await h.getTask(tests.id)).status, 'IN_PROGRESS');
  const apiDone = await done(api.id, 'API done');
  assert.equal(apiDone.assigneeId, ben, 'routed to the backend engineer by the role in the plan');
  const testsDone = await done(tests.id, 'tests done');
  assert.equal(testsDone.assigneeId, quin, 'routed to QA');
  assert.ok(Date.parse(testsDone.startedAt!) >= Date.parse(apiDone.completedAt!), 'the dependency finished first');
  assert.deepEqual(testsDone.evidence.filesChanged, ['api.test.txt']);
});

test('someone lent to a second project takes its tasks and keeps their own; extra repositories are within reach; dependencies cannot form a circle', async () => {
  const docsRepo = h.makeRepo('handbook');
  const shared = h.makeRepo('shared-ui');
  const docs = await h.project('Handbook', docsRepo, { verifyCommand: 'test -f README.md' });
  // Sarah stays on Shop and is lent to Handbook.
  const sarah = await h.api<any>('PATCH', `/employees/${ids.Sarah}`, { alsoProjectIds: [docs.id, projectId, 'nope'].slice(0, 2) });
  assert.deepEqual(sarah.alsoProjectIds, [docs.id], 'their own project is not listed twice');
  assert.ok((await h.apiRaw('PATCH', `/employees/${ids.Sarah}`, { alsoProjectIds: ['no-such-project'] })).status >= 400);
  const task = await h.task({ projectId: docs.id, title: 'Write the welcome page', roleHint: 'frontend', description: '@@fake: write welcome.md hello; commit welcome page; complete written@@' });
  const finished = await done(task.id, 'lent employee finished the task');
  assert.equal(finished.assigneeId, ids.Sarah, 'routed to the lent employee: nobody else is on that project');
  assert.equal((await h.state()).employees.find((e) => e.id === ids.Sarah)!.projectId, projectId, 'she still belongs to Shop');

  // Another repository of the Shop project: sessions get it as an additional directory.
  const patched = await h.api<any>('PATCH', `/projects/${projectId}`, { extraRepos: [{ path: shared }, { path: `${shared}/` }, { path: repo }] });
  assert.deepEqual(patched.extraRepos, [{ name: 'shared-ui', path: shared }], 'listed once, and never the main repository itself');
  assert.ok((await h.apiRaw('PATCH', `/projects/${projectId}`, { extraRepos: [{ path: 'relative/path' }] })).status >= 400);
  await h.api('POST', `/employees/${ids.Alex}/stop`, {});
  const session = await h.api<any>('POST', `/employees/${ids.Alex}/start`, {});
  await waitFor(async () => (await h.session(ids.Alex!))!.inTurn === false, { label: 'Alex restarted' });
  assert.match(h.started(session.tmuxPane), new RegExp(`--add-dir ${shared.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `));

  // Dependencies: Handbook builds on Shop; the reverse would be a circle.
  await h.api('PATCH', `/projects/${docs.id}`, { dependsOn: [projectId] });
  const circle = await h.apiRaw('PATCH', `/projects/${projectId}`, { dependsOn: [docs.id] });
  assert.ok(circle.status >= 400);
  assert.match(circle.body.error, /circle/);
  assert.ok((await h.apiRaw('PATCH', `/projects/${docs.id}`, { dependsOn: [docs.id] })).status >= 400, 'not on itself');
  // Employees are told what their project builds on and which other repositories they have.
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: 'Look around. @@fake: mcp get_project_context {}; say looked@@' });
  await waitFor(() => /Other repositories of this project[\s\S]*shared-ui/.test(h.tmux('capture-pane', '-p', '-J', '-S', '-80', '-t', session.tmuxPane)), { label: 'context mentions the other repository' });
  await h.api('PATCH', `/projects/${projectId}`, { extraRepos: [] });
});
