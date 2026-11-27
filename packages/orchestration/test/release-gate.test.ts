import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * The release gate (`release.ts`, docs/RELEASE-GATE.md; the owner, 2026-11-23: "review must be the gate — I see what
 * they did, and if it is good I let it go on to where it has to go"): a release their machine held is refused until an
 * owner approved the work; approving opens it for those who release it, and nobody else; reporting it out closes it.
 */
const link: AgentLink = { rpc: async () => ({ ok: true }) as any, isOnline: () => true, respondHook: () => false, disconnect: () => undefined };
let eng: Engine;
let shop = '';
const ids: Record<string, string> = {};

before(async () => {
  eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'box', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  shop = (await eng.tasks.createProject({ name: 'Shop' })).id;
  for (const [name, role] of [['Ava', 'backend'], ['Ops', 'devops'], ['Rita', 'reviewer'], ['Zed', 'frontend']] as const) ids[name] = eng.employees.create({ name, roleKey: role, projectId: shop, hostId: 'box', workingDir: `/tmp/${name}` }).id;
});

const emp = (name: string) => eng.core.employees.get(ids[name]!)!;
const toldTo = (name: string) => eng.core.messages.filter((m) => m.toEmployeeId === ids[name] && m.from.kind === 'system').map((m) => m.body);

test('off: nothing is held, nothing is said', () => {
  assert.equal(eng.release.on(), false);
  assert.equal(eng.release.rulesFor(emp('Ava')), null);
  assert.equal(eng.release.instructions(emp('Ava')), '');
});

test('on: a release before approval is refused, in words that say what to do instead', () => {
  eng.core.updateSettings({ releaseGate: { on: true, hosts: ['64.0.2.10'] } } as any);
  assert.deepEqual(eng.release.rulesFor(emp('Ava')), { on: true, branches: ['main', 'master'], hosts: ['64.0.2.10'] });
  assert.match(eng.release.instructions(emp('Ava')), /nothing reaches main \/ master or the production servers \(64\.0\.2\.10\)/);
  const d = eng.release.decide(emp('Ava'), 'git push origin master', 'it pushes to master');
  assert.equal(d.allow, false);
  assert.match(d.reason, /release gate: this command releases work \(it pushes to master\)/);
  assert.match(d.reason, /hand it in with complete_task|release_plan/);
  assert.ok(eng.core.store.recentAudit(20).some((a) => a.action === 'release.held'));
  // What is free instead, by what was refused.
  assert.match(eng.release.decide(emp('Ava'), "ssh 64.0.2.10 'rm /srv/x'", 'it changes something on 64.0.2.10, a production server').reason, /Reading production is free, and so are probes written into \/tmp there/);
  assert.match(eng.release.decide(emp('Ava'), "ssh 64.0.2.10 'php /dev/stdin' < p.php", 'it runs a program from this machine on 64.0.2.10, a production server (what it does cannot be read here)').reason, /put it in the command itself \(a heredoc to ssh\)/);
  assert.doesNotMatch(d.reason, /Reading production/, 'a push to master is told nothing about production');
});

test('an owner approves: the author and the colleagues on the ticket may release — not its reviewer, not anybody else — and are told', () => {
  const t = eng.tasks.createTask({ projectId: shop, title: 'Fix the checkout', description: 'x', assigneeId: ids.Ava, released: false }, 'owner');
  t.authorId = ids.Ava!;
  t.comments = [
    { id: 'c1', ts: new Date().toISOString(), from: { kind: 'employee', id: ids.Ops!, name: 'Ops' }, body: 'I can pull production when it is approved.', kind: 'note', mentions: [] },
    { id: 'c2', ts: new Date().toISOString(), from: { kind: 'employee', id: ids.Rita!, name: 'Rita' }, body: 'Approved.', kind: 'approved', mentions: [] },
  ];
  t.evidence.peerReview = { reviewerId: ids.Rita!, comments: 'ok', ts: new Date().toISOString() };
  t.release = { plan: 'Push master; Ops pulls production; check /health.' };
  eng.release.approved(t, 'Branko');
  assert.equal(eng.release.decide(emp('Ava'), 'git push origin master', 'it pushes to master').allow, true);
  assert.equal(eng.release.decide(emp('Ops'), "ssh 64.0.2.10 'git pull'", 'production').allow, true);
  assert.equal(eng.release.decide(emp('Rita'), 'git push origin master', 'it pushes to master').allow, false, 'the reviewer judged it; releasing is not hers');
  assert.equal(eng.release.decide(emp('Zed'), 'git push origin master', 'it pushes to master').allow, false);
  assert.match(toldTo('Ava').at(-1)!, /Branko approved T-\d+ .*Release it now, as you planned:\nPush master; Ops pulls production; check \/health\.[\s\S]*Ops may help you[\s\S]*report_released/);
  assert.match(toldTo('Ops').at(-1)!, /Ava releases it/);
  assert.equal(toldTo('Rita').length, 0);
  const stored = eng.core.tasks.get(t.id)!;
  assert.equal(stored.release?.approvedBy, 'Branko');
  assert.ok(stored.release?.openUntil);

  // Reported out: written on the ticket, and the gate closes for it.
  assert.throws(() => eng.release.reported(emp('Ava'), t.key, 'done'), /a sentence at least/);
  assert.match(eng.release.reported(emp('Ava'), t.key, 'Pushed master 1a2b3c4; Ops pulled production; /health answers 200.'), /recorded as released/);
  assert.equal(eng.core.tasks.get(t.id)!.release?.releasedBy, 'Ava');
  assert.ok(eng.core.tasks.get(t.id)!.comments?.some((c) => /^Released\./.test(c.body)));
  assert.equal(eng.release.decide(emp('Ava'), 'git push origin master', 'it pushes to master').allow, false);
  assert.equal(eng.release.decide(emp('Ops'), 'git push origin master', 'it pushes to master').allow, false);
});

test('by hand: an owner lets one employee release for a while, and can close it again', () => {
  const { until } = eng.release.grant(ids.Zed!, 30, 'Branko');
  assert.ok(Date.parse(until) - Date.now() > 29 * 60_000);
  assert.equal(eng.release.decide(emp('Zed'), 'git push origin main', 'it pushes to main').allow, true);
  eng.release.close({ employeeId: ids.Zed! }, 'Branko');
  assert.equal(eng.release.decide(emp('Zed'), 'git push origin main', 'it pushes to main').allow, false);
});

test('a project of worktrees with the gate on: the task says how it is tried (its branch) and released (main moved to integration)', async () => {
  const p = eng.core.put('project', { ...eng.core.projects.require(shop), id: 'p-market', name: 'Market', repoPath: '/work/market', workspace: 'worktrees', baseBranch: 'main', integrationBranch: 'orchestrator/integration' });
  const t = { ...eng.tasks.createTask({ projectId: p.id, title: 'Banner', description: 'x', assigneeId: ids.Ava, released: false }, 'owner'), branch: 'orch/ava/t-9-banner', repoRoot: '/work/market' };
  const text = eng.release.branchRelease(emp('Ava'), t, eng.core.projects.require(p.id));
  assert.match(text, /git push origin orch\/ava\/t-9-banner`, and check that branch out there/);
  assert.match(text, /in \/work\/market \(on main\) `git merge --ff-only orchestrator\/integration` and `git push origin main`/);
  assert.equal(eng.release.branchRelease(emp('Ava'), t, { ...eng.core.projects.require(p.id), workspace: 'in_place' }), '', 'a project worked in place: nothing of it');
  const { systemPromptFor, taskPrompt } = await import('../src/prompts.ts');
  assert.match(systemPromptFor(emp('Ava'), eng.core.projects.require(p.id), 'Co', true, '', false, false, false, false, true, true), /Push only your task branch/);
  assert.match(systemPromptFor(emp('Ava'), eng.core.projects.require(p.id), 'Co', true), /Never push, never switch/);
  assert.match(taskPrompt(t, eng.core.projects.require(p.id), [], null, '', [], [], true), /push only this branch, and do not switch branches/);
});

test('what the gate refused lately, newest first, for an owner to see whether it errs', () => {
  const held = eng.release.recentHeld(10);
  assert.ok(held.length >= 1);
  assert.equal(held[0]!.employee, 'Zed');
  assert.match(held.at(-1)!.why, /pushes to master/);
  assert.ok(held.every((h, i) => i === 0 || h.ts <= held[i - 1]!.ts));
});

test("the boss says yes to a release they were asked about: it goes through (the owner: it would not, even with my permission)", async () => {
  eng.core.updateSettings({ releaseGate: { on: true, hosts: ['64.0.2.10'] } } as any);
  eng.release.close({ employeeId: ids.Zed }, 'test');
  const ask = (options: Array<{ label: string; release?: boolean }>) => eng.comms.createQuestion({ kind: 'deployment', channel: 'mcp_tool', employee: emp('Zed'), session: null, text: 'Push the fix to master and publish 2.0.1?', options });
  assert.match(eng.release.decide(emp('Zed'), 'git push origin master', 'it pushes to master').reason, /ask_boss with kind "deployment"[\s\S]*release: true/, 'the refusal says how to ask');
  // The employee marks the choice that lets it release: the office says on it what choosing it does.
  const q = ask([{ label: 'Yes, publish 2.0.1', release: true }, { label: 'Wait' }]);
  assert.equal(q.options[0]!.releases, true);
  assert.match(q.options[0]!.consequence ?? '', /Opens the release gate for Zed for an hour/);
  assert.equal(q.options[1]!.releases, undefined);
  // "Wait" opens nothing; a colleague's yes opens nothing either.
  const waited = ask([{ label: 'Yes, publish it', release: true }, { label: 'Wait' }]);
  await eng.comms.answer(waited.id, { answer: 'Wait' }, 'owner');
  assert.equal(eng.release.decide(emp('Zed'), 'git push origin master', 'it pushes to master').allow, false);
  const colleague = ask([{ label: 'Yes, ship it', release: true }]);
  await eng.comms.answer(colleague.id, { answer: 'Yes, ship it' }, 'member:Kim', null, { owner: false });
  assert.equal(eng.release.decide(emp('Zed'), 'git push origin master', 'it pushes to master').allow, false);
  // The owner's yes: it goes through, for an hour.
  await eng.comms.answer(q.id, { answer: 'Yes, publish 2.0.1' }, 'member:Branko', null, { owner: true });
  const d = eng.release.decide(emp('Zed'), 'git push origin master', 'it pushes to master');
  assert.equal(d.allow, true, d.reason);
  const until = Date.parse(eng.release.openUntil(ids.Zed!)!);
  assert.ok(until > Date.now() + 55 * 60_000 && until <= Date.now() + 61 * 60_000);
  eng.release.close({ employeeId: ids.Zed }, 'test');
  // Not marked by the employee: the office puts its own choice in, so the yes is still one click.
  const plain = ask([{ label: 'Publish' }, { label: 'Wait' }]);
  const own = plain.options.find((o) => o.releases);
  assert.ok(own && /release/i.test(own.label), JSON.stringify(plain.options));
  // Not held by the gate, or not a deployment: options are left as they are.
  const other = eng.comms.createQuestion({ kind: 'decision', channel: 'mcp_tool', employee: emp('Zed'), session: null, text: 'Blue or green?', options: [{ label: 'Blue', release: true } as any] });
  assert.equal(other.options[0]!.releases, undefined);
});

test("a ticket only to release work not yet approved is refused — its steps belong in that ticket's release plan; releasing approved work together is not", () => {
  eng.core.updateSettings({ releaseGate: { on: true, hosts: [] } } as any);
  const pm = eng.employees.create({ name: 'Pia', roleKey: 'pm', projectId: shop, hostId: 'box', workingDir: '/tmp/Pia' });
  const inReview = eng.tasks.createTask({ projectId: shop, title: 'Sub-account names', description: 'x', released: false }, 'owner');
  eng.core.put('task', { ...eng.core.tasks.require(inReview.id), status: 'REVIEW' } as any);
  const done = eng.tasks.createTask({ projectId: shop, title: 'Footer', description: 'x', released: false }, 'owner');
  eng.core.put('task', { ...eng.core.tasks.require(done.id), status: 'DONE' } as any);
  assert.throws(() => eng.tasks.propose(pm, shop, [{ title: `Release ${inReview.key} (sub-account names)`, description: 'Push master, pull on production.' }], undefined, 'planning'), new RegExp(`release_plan of ${inReview.key}`));
  assert.throws(() => eng.tasks.propose(pm, shop, [{ title: 'Deploy the names fix', description: `Ship ${inReview.key} to production once reviewed.` }], undefined, 'planning'), /release_plan/);
  const ok = eng.tasks.propose(pm, shop, [{ title: `Release: pull master onto production (${done.key}, approved)`, description: 'Guarded pull.' }], undefined, 'planning');
  assert.equal(ok.created.length, 1);
  // Work that is not a release, naming a ticket in review, is not refused.
  assert.equal(eng.tasks.propose(pm, shop, [{ title: `Write the docs for ${inReview.key}`, description: 'x' }], undefined, 'planning').created.length, 1);
});
