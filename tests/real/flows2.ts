/**
 * REAL flows check, part 2 — actual Claude Code sessions (model: haiku), interactive runtime.
 *
 *   node tests/real/flows2.ts
 *
 * More paths with the real model instead of the scripted worker:
 *   1. a dependent task waits for its dependency and then builds on its result;
 *   2. an employee who stops without finishing is nudged and then completes;
 *   3. one employee asks another for something through Orchestrator and gets the answer;
 *   4. a review requests changes, the author reworks, the second review approves, then it merges;
 *   5. the server and then the host agent are restarted in the middle of work, and it carries on.
 *
 * The script plays the owner (trusting folders, approving requests) and logs what it does.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { FullState } from '@orchestrator/contracts';
import { HostAgent, enroll } from '../../apps/host-agent/src/agent.ts';
import { defaultConfig, saveConfig } from '../../apps/host-agent/src/config.ts';
import { startServer } from '../../apps/server/src/server.ts';

const MODEL = process.env.REAL_MODEL ?? 'haiku';
const base = fs.mkdtempSync('/tmp/orch-real-');
const sock = `orch-real-${process.pid}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push([name, ok]);
  log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const port = await new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(p));
  });
});
const serverOpts = { dataDir: path.join(base, 'server'), host: '127.0.0.1', port, quiet: true, timings: { askBossWaitMs: 60_000 } as any };
let server = await startServer(serverOpts);
const agentHome = path.join(base, 'agent');
const cfg = { ...defaultConfig(), serverUrl: server.url, name: 'this-mac', allowedRoots: [fs.realpathSync(base)], tmuxSocketName: sock, claudeBin: process.env.CLAUDE_BIN ?? 'claude' };
const info = await (new HostAgent(cfg, agentHome, () => undefined) as any).collectInfo();
const en = await enroll(server.url, server.localEnrollToken(), 'this-mac', info);
Object.assign(cfg, { hostId: en.hostId, credential: en.credential });
saveConfig(cfg, agentHome);
let agent = new HostAgent(cfg, agentHome, () => undefined);
await agent.start();
const api = async <T = any>(method: string, p: string, body?: unknown): Promise<T> => {
  const r = await fetch(`${server.url}/api${p}`, { method, headers: { authorization: `Bearer ${server.ownerToken}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status}: ${JSON.stringify(j)}`);
  return j as T;
};
const state = () => api<FullState>('GET', '/state');
async function until<T>(label: string, fn: (s: FullState) => T | undefined | null | false, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await state().then(fn, () => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(400);
  }
}
const tmux = (...a: string[]) => execFileSync('tmux', ['-u', '-L', sock, ...a], { encoding: 'utf8' });
const real = fs.realpathSync(base);
const repo = path.join(real, 'lib');
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test' } }).trim();
const idle = (id: string, ms = 240000) => until('idle', (s) => s.sessions.find((x) => x.employeeId === id && x.status === 'running' && x.inTurn === false), ms);
const doneOrBlocked = (id: string, label: string, ms = 420000) => until(label, (s) => s.tasks.find((t) => t.id === id && (t.status === 'DONE' || t.status === 'BLOCKED')), ms);

const handled = new Set<string>();
const ownerActions: string[] = [];
const owner = setInterval(async () => {
  try {
    for (const q of (await state()).questions.filter((x) => x.status === 'open' && !handled.has(x.id))) {
      handled.add(q.id);
      if (q.kind === 'trust_prompt') {
        ownerActions.push('trusted a folder');
        await api('POST', `/questions/${q.id}/answer`, { answer: 'Trust this folder' });
      } else if (q.kind === 'permission') {
        ownerActions.push(`approved: ${q.tool?.name} ${String((q.tool?.input as any)?.command ?? '').slice(0, 60)}`);
        await api('POST', `/questions/${q.id}/answer`, { decision: 'allow' });
      } else {
        ownerActions.push(`answered (${q.kind}): ${q.text.slice(0, 60)}`);
        await api('POST', `/questions/${q.id}/answer`, q.options.length ? { answer: q.options[0]!.label } : { answer: 'Use your best judgement and continue.' });
      }
      log(`owner ${ownerActions[ownerActions.length - 1]}`);
    }
  } catch {
    /* server restarting or shutting down */
  }
}, 1000);

let failed: Error | null = null;
try {
  log(`Claude Code ${info.claudeVersion}, tmux ${info.tmuxVersion}, model "${MODEL}"`);
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# lib\nTest files in this project are named <module>.spec.js.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial commit');
  while (!agent.isConnected) await sleep(100);
  const project = await api('POST', '/projects', { name: 'Lib', repoPath: repo, hostId: en.hostId, verifyCommand: 'true', description: 'A tiny library.' });
  const alex = await api('POST', '/employees', { name: 'Alex', roleKey: 'backend', hostId: en.hostId, projectId: project.id, autonomy: 'standard', model: MODEL });
  const sam = await api('POST', '/employees', { name: 'Sam', roleKey: 'frontend', hostId: en.hostId, projectId: project.id, autonomy: 'standard', model: MODEL });
  const rev = await api('POST', '/employees', { name: 'Rev', roleKey: 'reviewer', hostId: en.hostId, projectId: project.id, model: MODEL });

  // ───────────── 1. a dependent task ─────────────
  const dep = await api('POST', '/tasks', { projectId: project.id, title: 'Create the base file', assigneeId: alex.id, description: 'Create base.txt containing exactly the single line: BASE\nCommit it and call complete_task.' });
  const child = await api('POST', '/tasks', { projectId: project.id, title: 'Derive from the base file', assigneeId: sam.id, dependsOn: [dep.id], description: 'Read base.txt (it already exists in your worktree). Create derived.txt containing exactly the content of base.txt followed immediately by -DERIVED on the same line. Commit it and call complete_task.' });
  await sleep(2500);
  const early = (await state()).tasks.find((t) => t.id === child.id)!;
  check('the dependent task waits while its dependency is in progress', early.status === 'BACKLOG' && early.delivery.status === 'none', `${early.key} is ${early.status}`);
  const depDone = await doneOrBlocked(dep.id, 'dependency done');
  const childDone = await doneOrBlocked(child.id, 'dependent task done');
  const derived = childDone.status === 'DONE' ? git('show', 'orchestrator/integration:derived.txt') : '';
  check('once the dependency was verified and merged, the dependent task ran on top of it', depDone.status === 'DONE' && childDone.status === 'DONE' && derived.trim() === 'BASE-DERIVED' && (childDone.startedAt ?? '') >= (depDone.completedAt ?? '~'), `derived.txt on integration: ${JSON.stringify(derived)}`);

  // ───────────── 2. stopping without finishing → nudge ─────────────
  await idle(alex.id);
  const lazy = await api('POST', '/tasks', {
    projectId: project.id,
    title: 'Add a changelog',
    assigneeId: alex.id,
    description: 'Create CHANGELOG.md containing the single line: - first entry\nCommit it. Then END YOUR TURN by replying only "committed" — do NOT call complete_task or any other Orchestrator tool at that point. (This checks what happens when someone stops early.) If you are later told the task is still in progress, follow that instruction.',
  });
  const nudged = await until('nudge', (s) => s.events.find((e) => e.taskId === lazy.id && /nudged/.test(e.summary)), 300000).catch(() => null);
  const lazyDone = await doneOrBlocked(lazy.id, 'nudged task done');
  check('an employee who stopped without finishing was nudged through the Stop hook and then completed the task', !!nudged && lazyDone.status === 'DONE' && lazyDone.nudges >= 1, nudged ? `${nudged.summary}; task ${lazyDone.status}` : `no nudge was needed or sent; task ${lazyDone.status} (nudges ${lazyDone.nudges})`);

  // ───────────── 3. one employee asks another ─────────────
  await idle(alex.id);
  // The reviewer has had nothing to do yet, so they are not at their desk: a request starts their session.
  if (!(await state()).sessions.some((x) => x.employeeId === rev.id && x.status === 'running')) {
    await api('POST', `/employees/${rev.id}/start`, {});
    await idle(rev.id, 300000);
  }
  await api('POST', `/employees/${alex.id}/message`, { body: 'Use the request_collaboration tool to ask Rev (the code reviewer) how test files should be named in this project. When the answer comes back to you, tell me the naming rule in one sentence.' });
  const collab = await until('collaboration answered', (s) => s.collabs.find((c) => c.fromEmployeeId === alex.id && c.status !== 'open'), 300000);
  check('a request went from one real session to another through Orchestrator and was answered there', collab.toEmployeeId === rev.id && !!collab.response, `"${collab.summary.slice(0, 60)}" → ${collab.status}: ${String(collab.response).replace(/\s+/g, ' ').slice(0, 120)}`);
  const back = await until('answer delivered back', (s) => s.messages.find((m) => m.toEmployeeId === alex.id && m.threadId === collab.id && m.delivery.status === 'confirmed'), 180000).catch(() => null);
  check('the answer was delivered back into the asker\'s session', !!back, back ? `confirmed via ${back.delivery.via}` : 'not confirmed in time');

  // ───────────── 4. review requests changes → rework → approved ─────────────
  await idle(sam.id);
  await idle(rev.id);
  const reviewed = await api('POST', '/tasks', {
    projectId: project.id,
    title: 'Implement mul()',
    assigneeId: sam.id,
    requiresReview: true,
    reviewerId: rev.id,
    description: 'Create mul.js exporting mul(a, b) which returns a * b (CommonJS). Process check: on your FIRST attempt, deliberately leave the line `// TODO: remove before review` as the first line of mul.js, commit and call complete_task. If the review then requests changes, remove that line, commit again and call complete_task again.',
    acceptance: 'mul(2, 3) === 6. No TODO comments may remain anywhere in mul.js — a reviewer must request changes if one does.',
  });
  const rejected = await until('first review verdict', (s) => s.tasks.find((t) => t.id === reviewed.id && (t.friction.reviewRejections >= 1 || t.status === 'DONE' || t.status === 'BLOCKED')), 480000);
  check('the reviewer\'s real session requested changes on the first attempt', rejected.friction.reviewRejections >= 1, rejected.friction.reviewRejections >= 1 ? `recorded: ${rejected.history.filter((h) => /review|change/i.test(h.note)).map((h) => h.note.replace(/\s+/g, ' ').slice(0, 110)).pop() ?? ''}` : `no rejection; task is ${rejected.status} (${rejected.evidence.review?.verdict ?? 'no verdict'})`);
  const reworked = await doneOrBlocked(reviewed.id, 'reworked and approved', 600000);
  const mul = reworked.status === 'DONE' ? git('show', 'orchestrator/integration:mul.js') : '';
  check('the author reworked it, the second review approved, and only then was it merged', reworked.status === 'DONE' && reworked.evidence.review?.verdict === 'approved' && reworked.evidence.merge?.ok === true && !/TODO/.test(mul) && /module\.exports|exports\./.test(mul), `${reworked.status}; review: ${reworked.evidence.review?.verdict}; TODO left: ${/TODO/.test(mul)}`);

  // ───────────── 5. restarts in the middle of work ─────────────
  await idle(alex.id);
  const before = (await state()).sessions.find((x) => x.employeeId === alex.id && x.status === 'running')!;
  const surv = await api('POST', '/tasks', { projectId: project.id, title: 'Survive a restart', assigneeId: alex.id, description: 'Create RECOVERED.md containing the single line: survived\nCommit it and call complete_task. If a tool call to Orchestrator fails, wait a few seconds and try it again.' });
  await until('task acknowledged', (s) => s.tasks.find((t) => t.id === surv.id && t.delivery.status === 'confirmed'), 120000);
  await server.close();
  log('server stopped in the middle of the task');
  await sleep(1500);
  server = await startServer(serverOpts);
  log('server started again on the same data');
  const survDone = await doneOrBlocked(surv.id, 'task done after the server restart', 420000);
  const afterServer = (await state()).sessions.find((x) => x.id === before.id)!;
  check('the server was restarted mid-task: the same session carried on and the task was verified and merged', survDone.status === 'DONE' && afterServer.status === 'running' && afterServer.pid === before.pid && git('show', 'orchestrator/integration:RECOVERED.md').trim() === 'survived', `${survDone.status}; pid ${before.pid} → ${afterServer.pid}`);
  await idle(alex.id);
  await agent.stop();
  log('host agent stopped');
  await until('host shown offline', (s) => s.hosts.find((h) => h.id === en.hostId && h.status === 'offline'), 60000);
  const whileDown = (await state()).sessions.find((x) => x.id === before.id)!;
  agent = new HostAgent(cfg, agentHome, () => undefined);
  await agent.start();
  const reattached = await until('session re-attached', (s) => s.sessions.find((x) => x.id === before.id && x.status === 'running'), 60000);
  check('the host agent was restarted: the office showed the session honestly as unreachable, then picked up the same process', whileDown.status === 'host_offline' && reattached.pid === before.pid && /claude|node/i.test(tmux('list-panes', '-t', reattached.tmuxSession, '-F', '#{pane_current_command}')), `while down: ${whileDown.status}/${whileDown.activity}; pid ${reattached.pid}`);
  const ping = await api('POST', `/employees/${alex.id}/message`, { body: 'Reply with exactly one word: READY' });
  await until('message after restarts confirmed', (s) => s.messages.find((m) => m.id === ping.id && m.delivery.status === 'confirmed'), 120000);
  await idle(alex.id);
  const events = await api<any[]>('GET', `/events?employeeId=${alex.id}&limit=600`);
  const reply = events.filter((e) => e.type === 'agent.turn_finished' && e.data.lastMessage).pop();
  check('after both restarts a message still reaches the real session and its reply comes back', /READY/i.test(reply?.data?.lastMessage ?? ''), JSON.stringify(reply?.data?.lastMessage ?? '').slice(0, 80));
  check("the owner's own checkout was never touched", git('rev-parse', '--abbrev-ref', 'HEAD') === 'main' && git('status', '--porcelain') === '');
  log(`the owner acted ${ownerActions.length} time(s): ${ownerActions.join(' | ').slice(0, 600)}`);
} catch (e) {
  failed = e as Error;
  log(`✖ ${failed.message}`);
  try {
    const s = await state();
    for (const x of s.sessions.filter((x) => x.status === 'running')) {
      log(`session ${x.tmuxSession}: ${x.status} / ${x.activity} / inTurn=${x.inTurn} / ${x.activityDetail}`);
      console.log(tmux('capture-pane', '-p', '-J', '-t', x.tmuxPane!, '-S', '-60').split('\n').filter((l) => l.trim()).slice(-30).join('\n'));
    }
    for (const t of s.tasks) log(`task ${t.key} ${t.kind} ${t.status} delivery=${t.delivery.status} blocked=${t.blockedReason} friction=${JSON.stringify(t.friction)} nudges=${t.nudges}`);
    for (const q of s.questions) log(`question ${q.kind}/${q.channel} ${q.status}: ${q.text.slice(0, 100)}`);
    for (const c of s.collabs) log(`collab ${c.status}: ${c.summary.slice(0, 80)}`);
  } catch {
    /* ignore */
  }
} finally {
  clearInterval(owner);
  await agent.stop().catch(() => undefined);
  try {
    execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* none */
  }
  await server.close().catch(() => undefined);
  fs.rmSync(base, { recursive: true, force: true });
  // tmux leaves the socket file of a dedicated server behind.
  fs.rmSync(path.join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, sock), { force: true });
}
const bad = checks.filter((c) => !c[1]);
console.log(`\n${checks.length - bad.length}/${checks.length} checks passed${failed ? ` — aborted: ${failed.message}` : ''}`);
process.exit(failed || bad.length ? 1 : 0);
