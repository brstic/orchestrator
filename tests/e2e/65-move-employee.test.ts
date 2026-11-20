import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { Employee } from '@orchestrator/contracts';
import { createHarness, startedWith, waitFor, type Harness } from './harness.ts';

/**
 * Moving an employee to another machine with everything that is theirs (docs/MOVE.md): their folder (git history,
 * `.md` files, all of it but what an install makes again), their Claude conversation and its memory — their next
 * session there continues it — or, on a project others work in too, a copy of it; and back again, their branches
 * into the project they came from.
 */
let h: Harness;
type Box = Awaited<ReturnType<Harness['addHost']>>;
let a: Box;
let b: Box;
const claudeOf = (box: Box) => path.join(box.root, '.claude-home');
const convoDir = (base: string, cwd: string) => path.join(base, 'projects', fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'));

before(async () => {
  h = await createHarness();
  a = await h.addHost('office-box', { claudeHome: path.join(h.tmp, 'a-claude') });
  b = await h.addHost('my-laptop', { claudeHome: path.join(h.tmp, 'b-claude') });
  fs.mkdirSync(a.cfg.claudeHome!, { recursive: true });
  fs.mkdirSync(b.cfg.claudeHome!, { recursive: true });
  void claudeOf;
});
after(async () => h?.cleanup());

/** They have worked on that machine: a session that started, had a conversation, and was stopped. */
async function worked(e: Employee): Promise<{ claudeSessionId: string; cwd: string }> {
  await h.api('POST', `/employees/${e.id}/start`, {});
  const s = await waitFor(async () => {
    const x = await h.session(e.id);
    return x?.status === 'running' && x.lastEventAt ? x : null;
  }, { label: 'their session is up' });
  await h.api('POST', `/employees/${e.id}/stop`, {});
  await waitFor(async () => (['exited', 'lost'].includes((await h.session(e.id))?.status ?? '') ? true : null), { label: 'stopped' }).catch(async (err) => {
    throw new Error(`${err.message}: ${JSON.stringify((await h.state()).sessions.filter((x) => x.employeeId === e.id).map((x) => [x.status, x.activityDetail, x.exitReason]))}`);
  });
  return { claudeSessionId: s.claudeSessionId!, cwd: s.cwd };
}

async function moved(e: Employee): Promise<Employee> {
  return waitFor(async () => {
    const now = (await h.state()).employees.find((x) => x.id === e.id)!;
    if (now.moving?.phase === 'failed') throw new Error(`the move failed: ${now.moving.error}`);
    return !now.moving ? now : null;
  }, { label: 'moved', timeout: 60_000 });
}

test('their own folder goes whole, and their next session there continues their conversation', async () => {
  const folder = path.join(a.root, 'shop');
  fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'README.md'), '# Shop\n');
  fs.writeFileSync(path.join(folder, 'NOTES.md'), 'What Ana decided.\n');
  fs.writeFileSync(path.join(folder, '.env'), 'KEY=1\n');
  fs.mkdirSync(path.join(folder, 'node_modules', 'left'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'node_modules', 'left', 'x.js'), 'x');
  h.git(path.dirname(folder), 'init', '-q', folder);
  h.git(folder, 'add', 'README.md', 'NOTES.md');
  h.git(folder, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'start');
  const ana = await h.employee('Ana', 'backend', { hostId: a.hostId, workingDir: folder });
  const { claudeSessionId, cwd } = await worked(ana);
  // Their conversation, as Claude Code keeps it on the first machine.
  const there = convoDir(a.cfg.claudeHome!, cwd);
  fs.mkdirSync(path.join(there, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(there, `${claudeSessionId}.jsonl`), `${JSON.stringify({ cwd, text: `read ${cwd}/NOTES.md` })}\n`);
  fs.writeFileSync(path.join(there, 'memory', 'MEMORY.md'), '- the shop uses pnpm\n');

  const plan = await h.api('POST', `/employees/${ana.id}/move/plan`, { to: b.hostId });
  assert.equal(plan.why, null, plan.why);
  assert.equal(plan.kind, 'own');
  assert.equal(plan.conversation, true);
  await h.api('POST', `/employees/${ana.id}/move`, { to: b.hostId, parent: b.root });
  const now = await moved(ana);

  assert.equal(now.hostId, b.hostId);
  const project = (await h.state()).projects.find((p) => p.id === now.projectId)!;
  assert.equal(project.hostId, b.hostId, 'her project moved with her');
  const dest = fs.realpathSync(path.join(b.root, 'shop'));
  assert.equal(project.repoPath, dest);
  for (const f of ['README.md', 'NOTES.md', '.env', 'src']) assert.ok(fs.existsSync(path.join(dest, f)), f);
  assert.ok(!fs.existsSync(path.join(dest, 'node_modules')), 'what an install makes again stays behind');
  assert.equal(h.git(dest, 'log', '--format=%s').trim(), 'start');
  assert.ok(fs.existsSync(path.join(folder, 'README.md')), 'the old folder stays, to fall back on');
  const convo = convoDir(b.cfg.claudeHome!, dest);
  assert.equal(JSON.parse(fs.readFileSync(path.join(convo, `${claudeSessionId}.jsonl`), 'utf8')).text, `read ${dest}/NOTES.md`);
  assert.equal(fs.readFileSync(path.join(convo, 'memory', 'MEMORY.md'), 'utf8'), '- the shop uses pnpm\n');
  assert.deepEqual(fs.readdirSync(path.join(b.cfg.claudeHome!, '..')).includes('b-claude'), true);
  assert.equal(fs.existsSync(path.join(b.agent.home, 'moves')) ? fs.readdirSync(path.join(b.agent.home, 'moves')).length : 0, 0, 'nothing of the move is left in the agent');

  // Started there: it is the same conversation, continued.
  await h.api('POST', `/employees/${ana.id}/start`, {});
  const s = await waitFor(async () => {
    const x = await h.session(ana.id);
    return x?.status === 'running' && x.hostId === b.hostId ? x : null;
  }, { label: 'her session on the new machine' });
  assert.equal(s.claudeSessionId, claudeSessionId);
  assert.equal(s.cwd, dest);
  assert.match(startedWith(b.tmux, s.tmuxPane!), new RegExp(`--resume ${claudeSessionId}`));
  await h.api('POST', `/employees/${ana.id}/stop`, {});
});

test('from a project others work in, they take a copy; their open tasks stay on its board; back, their branches land in it', async () => {
  const repo = path.join(a.root, 'platform');
  fs.mkdirSync(repo);
  h.git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Platform\n');
  h.git(repo, 'add', '-A');
  h.git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
  const platform = await h.project('Platform', repo, { hostId: a.hostId });
  const bo = await h.employee('Bo', 'backend', { hostId: a.hostId, projectId: platform.id });
  const cy = await h.employee('Cy', 'frontend', { hostId: a.hostId, projectId: platform.id });
  const open = await h.task({ projectId: platform.id, title: 'Later work', assigneeId: bo.id, status: 'BACKLOG' });

  const plan = await h.api('POST', `/employees/${bo.id}/move/plan`, { to: b.hostId });
  assert.equal(plan.why, null, plan.why);
  assert.equal(plan.kind, 'copy');
  assert.deepEqual(plan.released.map((t: any) => t.key), [open.key]);
  await h.api('POST', `/employees/${bo.id}/move`, { to: b.hostId, parent: b.root });
  const now = await moved(bo);
  const state = await h.state();
  const copy = state.projects.find((p) => p.id === now.projectId)!;
  assert.equal(copy.hostId, b.hostId);
  assert.deepEqual(copy.copiedFrom, { projectId: platform.id, hostId: a.hostId });
  assert.equal(h.git(copy.repoPath!, 'log', '--format=%s').trim(), 'base');
  assert.equal(state.employees.find((e) => e.id === cy.id)!.projectId, platform.id, 'the others stay on the project');
  assert.equal(state.tasks.find((t) => t.id === open.id)!.assigneeId, null, 'their open task went back on the board');

  // Bo works on the copy; moved back, his branch is in the project — the project's own branches untouched.
  fs.writeFileSync(path.join(copy.repoPath!, 'bo.md'), 'from the laptop\n');
  h.git(copy.repoPath!, 'add', '-A');
  h.git(copy.repoPath!, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'bo');
  const mainBefore = h.git(repo, 'rev-parse', 'main').trim();
  const back = await h.api('POST', `/employees/${bo.id}/move/plan`, { to: a.hostId });
  assert.equal(back.why, null, back.why);
  assert.equal(back.kind, 'back');
  await h.api('POST', `/employees/${bo.id}/move`, { to: a.hostId });
  const home = await moved(bo);
  assert.equal(home.hostId, a.hostId);
  assert.equal(home.projectId, platform.id);
  const branches = h.git(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/moved').trim().split('\n');
  assert.ok(branches.length >= 1, branches.join());
  assert.equal(h.git(repo, 'show', `${branches.find((x) => x.endsWith('/main') || x.includes('home')) ?? branches[0]}:bo.md`).trim(), 'from the laptop');
  assert.equal(h.git(repo, 'rev-parse', 'main').trim(), mainBefore);
});

test('one whose session was running goes on there by itself, in the same conversation', async () => {
  const folder = path.join(a.root, 'live-one');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'NOTES.md'), 'live\n');
  const eve = await h.employee('Eve', 'backend', { hostId: a.hostId, workingDir: folder });
  await h.api('POST', `/employees/${eve.id}/start`, {});
  const before = await waitFor(async () => {
    const x = await h.session(eve.id);
    return x?.status === 'running' && x.lastEventAt && x.inTurn !== true ? x : null;
  }, { label: 'her session is up' });
  const there = convoDir(a.cfg.claudeHome!, before.cwd);
  fs.mkdirSync(there, { recursive: true });
  fs.writeFileSync(path.join(there, `${before.claudeSessionId}.jsonl`), '{}\n');
  const plan = await h.api('POST', `/employees/${eve.id}/move/plan`, { to: b.hostId });
  assert.equal(plan.stopsSession, true);
  await h.api('POST', `/employees/${eve.id}/move`, { to: b.hostId, parent: b.root });
  await moved(eve);
  const after = await waitFor(async () => {
    const x = await h.session(eve.id);
    return x?.status === 'running' && x.hostId === b.hostId ? x : null;
  }, { label: 'her session goes on on the new machine' });
  assert.equal(after.claudeSessionId, before.claudeSessionId);
  assert.match(startedWith(b.tmux, after.tmuxPane!), new RegExp(`--resume ${before.claudeSessionId}`));
  await h.api('POST', `/employees/${eve.id}/stop`, {});
});

test('it is refused while they work on a task, while a machine is away, and for whom it cannot be done', async () => {
  const folder = path.join(a.root, 'busy');
  fs.mkdirSync(folder);
  const di = await h.employee('Di', 'backend', { hostId: a.hostId, workingDir: folder });
  const project = (await h.state()).employees.find((e) => e.id === di.id)!.projectId!;
  const t = await h.task({ projectId: project, title: 'Busy', assigneeId: di.id });
  h.server.engine.core.tasks.require(t.id).status = 'IN_PROGRESS';
  assert.match((await h.api('POST', `/employees/${di.id}/move/plan`, { to: b.hostId })).why, /working on/);
  await assert.rejects(h.api('POST', `/employees/${di.id}/move`, { to: b.hostId, parent: b.root }), /working on/);
  h.server.engine.core.tasks.require(t.id).status = 'READY';
  assert.match((await h.api('POST', `/employees/${di.id}/move/plan`, { to: di.hostId })).why, /already/);
  await b.stop();
  assert.match((await h.api('POST', `/employees/${di.id}/move/plan`, { to: b.hostId })).why, /not connected/);
});
