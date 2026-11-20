/**
 * A member's team lead: one employee on that member's own computer who hands what the member wants to the right one
 * of the member's employees, and may hire — onto the member's machines only, five at most.
 *
 * What a lead may see and do is the office's to enforce, whatever the model in its session decides; so its tools are
 * called here directly, as its session would call them, against a real office with a real second machine.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LEAD_HIRE_LIMIT } from '@orchestrator/contracts';
import { buildMcpServer } from '@orchestrator/orchestration';
import { createHarness, type Harness } from './harness.ts';

let h: Harness;
let mine: Awaited<ReturnType<Harness['addHost']>>;
let shopId = '';
const ids: Record<string, string> = {};
const folder = (name: string) => {
  const dir = path.join(mine.root, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.test' } });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return dir;
};
/** Call one of the office's tools as that employee's session would. */
const call = async (as: string, tool: string, args: Record<string, unknown> = {}) => {
  const engine = h.server.engine;
  const employee = engine.core.employees.require(ids[as]!);
  const out = await engine.lead.handlers()[tool]!(args, { employee, session: { id: `s-${as}` } as any });
  return typeof out === 'string' ? { text: out, isError: false } : { text: out.text, isError: !!out.isError };
};

before(async () => {
  h = await createHarness();
  // The office: one shared project with one shared employee.
  shopId = (await h.project('Shop', h.makeRepo('shop'))).id;
  ids.Alex = (await h.employee('Alex', 'backend', { projectId: shopId })).id;
  // Fenix, a member, with a computer of his own in the office.
  await h.api('POST', '/sharing', { open: true, port: 20000 + Math.floor(Math.random() * 20000) });
  const fenix = await h.api<any>('POST', '/guests', { name: 'Fenix', role: 'colleague' });
  ids.fenix = fenix.guest.id;
  ids.fenixToken = JSON.parse(Buffer.from(String(fenix.invite).replace(/^orch-invite-v1\./, ''), 'base64url').toString('utf8')).t;
  const { token } = h.server.engine.hosts.createMemberEnrollment({ id: fenix.guest.id, name: 'Fenix' });
  mine = await h.addHost('fenix-laptop', {}, { enrollToken: token });
  // Two employees of his, each in a folder of their own (which is their project).
  ids.Ana = (await h.api<any>('POST', '/employees', { name: 'Ana', roleKey: 'backend', hostId: mine.hostId, workingDir: folder('xenon-studio') })).id;
  ids.Bo = (await h.api<any>('POST', '/employees', { name: 'Bo', roleKey: 'frontend', hostId: mine.hostId, workingDir: folder('domains-site') })).id;
});
after(async () => {
  await h.cleanup();
});

test('a lead is a member’s: on their own computer, one each, on the lightest model, and unable to edit', async () => {
  await assert.rejects(h.api('POST', '/employees', { name: 'Lea', roleKey: 'lead', workingDir: h.tmp }), /400: a team lead works for one member and sits on that member's own computer/);
  await assert.rejects(h.api('POST', '/employees', { name: 'Lea', roleKey: 'lead', hostId: mine.hostId, workingDir: mine.root, autonomy: 'unrestricted' }), /400: a team lead hands work on and hires/);
  const projects = (await h.state()).projects.length;
  const lea = await h.api<any>('POST', '/employees', { name: 'Lea', roleKey: 'lead', hostId: mine.hostId, workingDir: mine.root });
  ids.Lea = lea.id;
  assert.deepEqual([lea.title, lea.roleKey, lea.model, lea.effort, lea.autonomy, lea.leadScope, lea.hostId], ['Team Lead', 'lead', 'haiku', 'low', 'standard', 'own', mine.hostId]);
  assert.ok(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].every((t) => lea.disallowedTools.includes(t)));
  assert.equal((await h.state()).projects.length, projects, 'a lead’s folder is where its session runs, not a project');
  await assert.rejects(h.api('POST', '/employees', { name: 'Second', roleKey: 'lead', hostId: mine.hostId, workingDir: mine.root }), /400: Fenix already has a team lead \(Lea\)/);
  // The model is the member's to change; the role's limits are not.
  assert.equal((await h.api<any>('PATCH', `/employees/${lea.id}`, { model: 'sonnet' })).model, 'sonnet');
  await assert.rejects(h.api('PATCH', `/employees/${lea.id}`, { autonomy: 'unrestricted' }), /400: a team lead hands work on and hires/);
  await assert.rejects(h.api('PATCH', `/employees/${ids.Alex}`, { roleKey: 'lead' }), /400: a team lead works for one member/);
});

test('a lead is shown its own tools and how to ask; nobody else is shown a lead’s', () => {
  const server = buildMcpServer(h.server.engine);
  const shown = (as: string) => server.tools.filter((t) => server.listed!(t, { employee: h.server.engine.core.employees.require(ids[as]!), session: {} as any })).map((t) => t.name);
  assert.deepEqual(shown('Lea').sort(), ['ask_boss', 'check_messages', 'message_person', 'report_status', 'respond_to_request', 'send_message', 'team_assign', 'team_folders', 'team_hire', 'team_look', 'team_overview', 'team_task', 'team_tell', 'wait_for_answer']);
  assert.ok(!shown('Ana').some((t) => t.startsWith('team_')) && shown('Ana').includes('complete_task'));
});

test('it sees its member’s team and nothing else of the office, and nobody else can use its tools', async () => {
  const seen = (await call('Lea', 'team_overview')).text;
  assert.match(seen, /Your team — 2 people/);
  assert.match(seen, /- Ana — Senior Backend Engineer · fenix-laptop|- Ana — .* · Fenix's computer/);
  assert.match(seen, /project: xenon-studio · folder: .*xenon-studio/);
  assert.match(seen, /- domains-site · /);
  assert.ok(!/Alex|Shop/.test(seen), 'the office’s shared employees and projects are not its team');
  assert.match(seen, new RegExp(`You may hire ${LEAD_HIRE_LIMIT} more \\(${LEAD_HIRE_LIMIT} at most at a time\\)`));
  for (const who of ['Ana', 'Alex']) {
    const refused = await call(who, 'team_overview');
    assert.ok(refused.isError && /Only a team lead can use team_overview/.test(refused.text), who);
  }
  assert.ok((await h.api<any[]>('GET', '/audit?limit=50')).some((a) => a.action === 'lead.tool_refused'));
});

test('it hands work to the one whose it is: in words, or as a task on that one’s board — within the team', async () => {
  const told = await call('Lea', 'team_tell', { employee: 'Ana', message: 'From Fenix: look at the open tickets for Xenon Studio and report what is urgent.' });
  assert.ok(!told.isError && /Told Ana/.test(told.text), told.text);
  const msg = (await h.state()).messages.find((m) => m.toEmployeeId === ids.Ana && /open tickets for Xenon Studio/.test(m.body))!;
  assert.deepEqual([msg.from.kind, msg.from.name], ['employee', "Lea (Fenix's lead)"]);
  assert.match((await call('Lea', 'team_tell', { employee: 'Alex', message: 'x' })).text, /Nobody on your team matches "Alex"/);

  const made = await call('Lea', 'team_task', { project: 'domains', title: 'Check the renewal date of the domain', description: 'Look it up and say when it runs out.', assignee: 'Bo' });
  assert.ok(!made.isError && /Created T-\d+ .* in domains-site, assigned to Bo/.test(made.text), made.text);
  const task = (await h.state()).tasks.find((t) => t.title === 'Check the renewal date of the domain')!;
  assert.deepEqual([task.assigneeId, task.createdBy, task.released], [ids.Bo, 'lead:Lea', true]);
  assert.match((await call('Lea', 'team_task', { project: 'Shop', title: 'x', description: 'y' })).text, /No project of yours matches "Shop"/);
  // Work does not cross between the folders of one machine's people either: the office says so, and the lead is told.
  const moved = await call('Lea', 'team_assign', { task: task.key, employee: 'Ana' });
  assert.ok(/is now Ana's/.test(moved.text) || moved.isError, moved.text);
  // A lead is not somebody to give work to.
  await assert.rejects(h.api('PATCH', `/tasks/${task.id}`, { assigneeId: ids.Lea }), /400: Lea is a team lead and does not take tasks/);
  const look = await call('Lea', 'team_look', { employee: 'Bo' });
  assert.ok(!look.isError && /Bo — /.test(look.text), look.text);
  // Each of these is a visit on the record: it is what makes the lead's character walk over to that desk.
  const visits = (await h.api<any[]>('GET', `/events?limit=200&employeeId=${ids.Lea}`)).filter((e) => e.type === 'lead.visit');
  assert.deepEqual(visits.map((e) => `${e.data.fromEmployeeId === ids.Lea}:${e.data.action}:${e.data.toEmployeeId}`).sort(), [`true:assign:${ids.Ana}`, `true:assign:${ids.Bo}`, `true:look:${ids.Bo}`, `true:tell:${ids.Ana}`].sort());
});

test('it finds where things are on its member’s machines, and hires there — never more than five at a time', async () => {
  folder('billing-api');
  const folders = await call('Lea', 'team_folders', {});
  assert.ok(!folders.isError && /- billing-api \[git repository\]/.test(folders.text) && /- xenon-studio \[git repository\]/.test(folders.text), folders.text);
  assert.match((await call('Lea', 'team_folders', { machine: 'no-such' })).text, /No machine of Fenix's matches/);

  for (const [args, said] of [
    [{ name: 'Cy', role: 'backend', why: 'billing work' }, /Say where they work/],
    [{ name: 'Cy', role: 'foreman', folder: path.join(mine.root, 'billing-api'), why: 'x' }, /is not a role you can hire/],
    [{ name: 'Cy', role: 'lead', folder: path.join(mine.root, 'billing-api'), why: 'x' }, /is not a role you can hire/],
    [{ name: 'Cy', role: 'backend', folder: path.join(mine.root, 'billing-api') }, /Say in "why"/],
    [{ name: 'Cy', role: 'backend', project: 'Shop', why: 'x' }, /No project of yours matches "Shop"/],
  ] as const) {
    const out = await call('Lea', 'team_hire', args);
    assert.ok(out.isError && said.test(out.text), out.text);
  }
  const hired = await call('Lea', 'team_hire', { name: 'Cy', role: 'backend', folder: path.join(mine.root, 'billing-api'), why: 'Nobody on the team works on billing.' });
  assert.ok(!hired.isError && /Hired Cy as Senior Backend Engineer on .*, project billing-api\. Fenix has been told\..* You may hire 4 more\./.test(hired.text), hired.text);
  const state = await h.state();
  const cy = state.employees.find((e) => e.name === 'Cy')!;
  assert.deepEqual([cy.hostId, cy.hiredBy, cy.autonomy === 'unrestricted', cy.executionMode, state.projects.find((p) => p.id === cy.projectId)?.name], [mine.hostId, ids.Lea, false, 'interactive_cli', 'billing-api']);
  assert.ok(state.notifications.some((n) => n.title === 'Lea hired Cy (Senior Backend Engineer)' && /Nobody on the team works on billing/.test(n.body)), 'the member is told, with the reason');
  assert.ok((await h.api<any[]>('GET', '/audit?limit=50')).some((a) => a.action === 'lead.hired' && a.actor === 'lead:Lea'));
  // Up to the limit, and not one more — until somebody the lead hired is gone.
  for (let i = 2; i <= LEAD_HIRE_LIMIT; i++) assert.ok(!(await call('Lea', 'team_hire', { name: `Extra ${i}`, role: 'qa', project: 'billing-api', why: 'more hands' })).isError, `hire ${i}`);
  const over = await call('Lea', 'team_hire', { name: 'One too many', role: 'qa', project: 'billing-api', why: 'more hands' });
  assert.ok(over.isError && /You have hired 5 people who are still here .* 5 is the most a lead may have/.test(over.text), over.text);
  assert.equal((await h.state()).employees.filter((e) => e.hiredBy === ids.Lea && !e.archived).length, LEAD_HIRE_LIMIT);
  // The member hires as many as they like themselves: the limit is the lead's.
  ids.Dee = (await h.api<any>('POST', '/employees', { name: 'Dee', roleKey: 'docs', hostId: mine.hostId, projectId: cy.projectId })).id;
  const extra = (await h.state()).employees.find((e) => e.name === 'Extra 2')!;
  await h.api('PATCH', `/employees/${extra.id}`, { archived: true });
  const engine = h.server.engine;
  const host = engine.core.hosts.require(mine.hostId);
  const codexHire = { name: 'In their place', role: 'qa', project: 'billing-api', why: 'a place came free', executionMode: 'codex_managed' };
  const info = host.info!;
  engine.core.put('host', { ...host, info: { ...info, runtimes: ['interactive_cli'] } });
  try {
    const unavailable = await call('Lea', 'team_hire', codexHire);
    assert.ok(unavailable.isError && /does not currently report support for codex_managed/.test(unavailable.text), unavailable.text);
    engine.core.put('host', { ...host, info: { ...info, runtimes: ['interactive_cli', 'codex_managed'] } });
    assert.match((await call('Lea', 'team_overview')).text, /Codex-managed available/);
    const replacement = await call('Lea', 'team_hire', codexHire);
    assert.ok(!replacement.isError, replacement.text);
    assert.equal((await h.state()).employees.find((e) => e.name === codexHire.name)?.executionMode, 'codex_managed');
  } finally {
    engine.core.put('host', host);
  }
});

test('asked to, it directs the office’s shared employees too — on their own projects, as its member may', async () => {
  const lea = await h.api<any>('PATCH', `/employees/${ids.Lea}`, { leadScope: 'office' });
  assert.equal(lea.leadScope, 'office');
  const seen = (await call('Lea', 'team_overview')).text;
  assert.ok(/- Alex — .*\(shared office\)/.test(seen) && /- Shop · .*\(shared office\)/.test(seen), seen);
  assert.ok(seen.indexOf('- Ana') < seen.indexOf('- Alex'), 'the member’s own come first');
  assert.ok(!(await call('Lea', 'team_tell', { employee: 'Alex', message: 'From Fenix: is the Shop build green?' })).isError);
  const made = await call('Lea', 'team_task', { project: 'Shop', title: 'Check the Shop build', description: 'Run it and report.', assignee: 'Alex' });
  assert.ok(!made.isError && /in Shop, assigned to Alex/.test(made.text), made.text);
  // What is on the member's computer still does not cross to the shared office, or back.
  const crossed = await call('Lea', 'team_task', { project: 'Shop', title: 'Across', description: 'x', assignee: 'Ana' });
  assert.ok(crossed.isError && /does not cross|not on this computer|own computer/.test(crossed.text), crossed.text);
  // Hiring stays on the member's own machines.
  const main = (await h.state()).hosts.find((x) => !x.memberId)!;
  const elsewhere = await call('Lea', 'team_hire', { name: 'On the server', role: 'qa', project: 'Shop', machine: main.name, why: 'x' });
  assert.ok(elsewhere.isError, elsewhere.text);
  assert.equal((await h.api<any>('PATCH', `/employees/${ids.Lea}`, { leadScope: 'own' })).leadScope, 'own');
  assert.ok(!/Alex/.test((await call('Lea', 'team_overview')).text));
});

test('a shared employee a member looks after is in that member’s team, and stays everybody’s', async () => {
  const token = (invite: string) => JSON.parse(Buffer.from(invite.replace(/^orch-invite-v1\./, ''), 'base64url').toString('utf8')).t as string;
  const as = async (t: string, method: string, route: string, body: unknown = {}) => {
    const r = await fetch(`${h.url}/api${route}`, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const fenix = ids.fenixToken!;
  const ana = token((await h.api<any>('POST', '/guests', { name: 'Other', role: 'colleague' })).invite);
  const vera = token((await h.api<any>('POST', '/guests', { name: 'Vera', role: 'owner' })).invite);
  const nik = token((await h.api<any>('POST', '/guests', { name: 'Nik', role: 'visitor' })).invite);

  // Not from the office's own computer, not a visitor, not somebody on a member's computer, not a lead.
  await assert.rejects(h.api('POST', `/employees/${ids.Alex}/keep`, {}), /taking someone among one's own is for members/);
  assert.equal((await as(nik, 'POST', `/employees/${ids.Alex}/keep`)).status, 403);
  assert.match((await as(fenix, 'POST', `/employees/${ids.Ana}/keep`)).body.error, /is on a member's own computer: they are that member's already/);
  assert.match((await as(fenix, 'POST', `/employees/${ids.Lea}/keep`)).body.error, /a member's team lead, not somebody to take/);

  assert.ok(!/Alex/.test((await call('Lea', 'team_overview')).text), 'before: not in the team');
  const kept = await as(fenix, 'POST', `/employees/${ids.Alex}/keep`);
  assert.deepEqual([kept.status, kept.body.keptBy], [200, { id: ids.fenix, name: 'Fenix' }]);
  // In the lead's team now, with the shared project he works on — without the whole office coming along.
  const seen = (await call('Lea', 'team_overview')).text;
  assert.match(seen, /- Alex — .*\(shared office, looked after by your boss\) · project: Shop/);
  assert.match(seen, /- Shop · /);
  assert.ok(seen.indexOf('- Ana') < seen.indexOf('- Alex'));
  assert.ok(!(await call('Lea', 'team_tell', { employee: 'Alex', message: 'From Fenix: how is the Shop build?' })).isError);
  const made = await call('Lea', 'team_task', { project: 'Shop', title: 'Look at the Shop tickets', description: 'Say which are urgent.', assignee: 'Alex' });
  assert.ok(!made.isError && /in Shop, assigned to Alex/.test(made.text), made.text);
  // Nothing about who may use him changed: another colleague still works with him.
  assert.equal((await as(ana, 'POST', `/employees/${ids.Alex}/message`, { body: 'hello' })).status, 200);
  // What the lead does in its member's room is that room's: another colleague is not sent its visits.
  assert.equal((await as(ana, 'GET', '/events?limit=500')).body.filter((e: any) => e.type === 'lead.visit').length, 0);
  assert.ok((await as(fenix, 'GET', '/events?limit=500')).body.some((e: any) => e.type === 'lead.visit'));
  // One member at a time: a colleague cannot take him or give him back for Fenix; an owner can move him.
  assert.match((await as(ana, 'POST', `/employees/${ids.Alex}/keep`)).body.error, /is looked after by Fenix/);
  assert.equal((await as(ana, 'POST', `/employees/${ids.Alex}/give-back`)).status, 403);
  assert.deepEqual((await as(vera, 'POST', `/employees/${ids.Alex}/keep`)).body.keptBy.name, 'Vera');
  assert.ok(!/Alex/.test((await call('Lea', 'team_overview')).text), 'no longer Fenix’s to direct');
  assert.equal((await as(vera, 'POST', `/employees/${ids.Alex}/give-back`)).body.keptBy, undefined);
  // The ordinary change of a profile cannot set it.
  assert.equal((await h.api<any>('PATCH', `/employees/${ids.Alex}`, { keptBy: { id: ids.fenix, name: 'Fenix' } })).keptBy, undefined);
  assert.ok((await h.api<any[]>('GET', '/audit?limit=80')).some((a) => a.action === 'employee.kept' && a.actor === 'member:Fenix'));
});
