/**
 * REAL team check — two actual Claude Code sessions working together (model: haiku).
 *
 *   node tests/real/team.ts
 *
 * One employee implements a task; a second, read-only employee reviews the real
 * diff and gives the verdict; the work is merged only after that. Then both sit
 * in a meeting and the facilitator records a decision. Everything they say
 * arrives through the Orchestrator MCP tools from their own sessions.
 *
 * The script plays the owner: it trusts the folders, approves permission
 * requests and answers questions, logging each one.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FullState } from '@orchestrator/contracts';
import { HostAgent, enroll } from '../../apps/host-agent/src/agent.ts';
import { defaultConfig, saveConfig } from '../../apps/host-agent/src/config.ts';
import { startServer } from '../../apps/server/src/server.ts';

const MODEL = process.env.REAL_MODEL ?? 'haiku';
// TEAM_RUNTIME=managed_sdk runs both employees as SDK-managed workers (needs the Agent SDK:
// `orchestrator-agent sdk install`, or ORCH_SDK_PATH).
const RUNTIME = process.env.TEAM_RUNTIME === 'managed_sdk' ? 'managed_sdk' : 'interactive_cli';
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
const server = await startServer({ dataDir: path.join(base, 'server'), host: '127.0.0.1', port: 0, quiet: true, timings: { meetingRoundMs: 180_000 } as any });
const cfg = { ...defaultConfig(), serverUrl: server.url, name: 'this-mac', allowedRoots: [fs.realpathSync(base)], tmuxSocketName: sock, claudeBin: process.env.CLAUDE_BIN ?? 'claude', sdkPath: process.env.ORCH_SDK_PATH ?? path.join(process.env.HOME ?? '', '.orchestrator', 'agent', 'node_modules', '@anthropic-ai', 'claude-agent-sdk') };
const info = await (new HostAgent(cfg, path.join(base, 'agent'), () => undefined) as any).collectInfo();
const en = await enroll(server.url, server.localEnrollToken(), 'this-mac', info);
Object.assign(cfg, { hostId: en.hostId, credential: en.credential });
saveConfig(cfg, path.join(base, 'agent'));
const agent = new HostAgent(cfg, path.join(base, 'agent'), () => undefined);
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
    const v = fn(await state());
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(500);
  }
}
const tmux = (...a: string[]) => execFileSync('tmux', ['-u', '-L', sock, ...a], { encoding: 'utf8' });

// The owner: trusts the folders, approves what is asked, answers questions.
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
        ownerActions.push(`approved: ${q.tool?.name} ${String((q.tool?.input as any)?.command ?? '').slice(0, 70)}`);
        await api('POST', `/questions/${q.id}/answer`, { decision: 'allow' });
      } else {
        ownerActions.push(`answered: ${q.text.slice(0, 70)}`);
        await api('POST', `/questions/${q.id}/answer`, q.parts.length ? { answers: Object.fromEntries(q.parts.map((p) => [p.question, p.options[0]?.label ?? 'Yes'])) } : { answer: 'Use your best judgement and continue.' });
      }
      log(`owner ${ownerActions[ownerActions.length - 1]}`);
    }
  } catch {
    /* shutting down */
  }
}, 1200);

let failed: Error | null = null;
try {
  log(`Claude Code ${info.claudeVersion}, tmux ${info.tmuxVersion}, model "${MODEL}", runtime ${RUNTIME}`);
  if (RUNTIME === 'managed_sdk' && !info.runtimes?.includes('managed_sdk')) throw new Error('the Claude Agent SDK was not found: run `orchestrator-agent sdk install` or set ORCH_SDK_PATH');
  const repo = path.join(fs.realpathSync(base), 'calc');
  fs.mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test' } }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'calc', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(repo, 'test.js'), `const assert = require('assert');\nconst { add } = require('./add.js');\nassert.strictEqual(add(2, 3), 5);\nconsole.log('ok');\n`);
  git('add', '-A');
  git('commit', '-q', '-m', 'initial commit');
  while (!agent.isConnected) await sleep(100);

  const project = await api('POST', '/projects', { name: 'Calc', repoPath: repo, hostId: en.hostId, verifyCommand: 'npm test --silent', description: 'A tiny calculator library.' });
  const alex = await api('POST', '/employees', { name: 'Alex', roleKey: 'backend', hostId: en.hostId, projectId: project.id, autonomy: 'standard', model: MODEL, executionMode: RUNTIME });
  const rev = await api('POST', '/employees', { name: 'Rev', roleKey: 'reviewer', hostId: en.hostId, projectId: project.id, model: MODEL, executionMode: RUNTIME });
  const task = await api('POST', '/tasks', {
    projectId: project.id,
    title: 'Implement add()',
    assigneeId: alex.id,
    requiresReview: true,
    reviewerId: rev.id,
    description: 'Create add.js exporting a function add(a, b) that returns a + b (CommonJS: module.exports = { add }). Run `npm test`, commit, and call complete_task. Do not ask questions; just do it.',
    acceptance: 'npm test passes.',
  });
  log(`task ${task.key} for Alex, to be reviewed by Rev (${rev.autonomy} autonomy)`);

  const inReview = await until('implementation verified and sent to review', (s) => s.tasks.find((t) => t.id === task.id && (t.status === 'REVIEW' || t.status === 'DONE' || t.status === 'BLOCKED')), 360000);
  check('the implementer finished and Orchestrator verified it before any review', inReview.status !== 'BLOCKED' && inReview.evidence.verification?.passed === true && inReview.evidence.verification?.provenance === 'measured', `${inReview.status}; ${inReview.evidence.commits.map((c) => c.subject).join('; ')}`);
  const reviewTask = await until('review task for Rev', (s) => s.tasks.find((t) => t.kind === 'review' && t.reviewOf === task.id), 60000);
  check('a review task went to the second employee, in their own session', reviewTask.assigneeId === rev.id, `${reviewTask.key} → Rev`);
  const done = await until('reviewed and done', (s) => s.tasks.find((t) => t.id === task.id && (t.status === 'DONE' || t.status === 'BLOCKED' || (t.status === 'IN_PROGRESS' && !!t.evidence.review))), 420000);
  const review = done.evidence.review;
  check('the verdict came from the reviewer\'s real session through submit_review', !!review && review.reviewerId === rev.id && review.by === 'employee' && (review.verdict === 'approved' || review.verdict === 'changes_requested'), review ? `${review.verdict}: ${String(review.comments).replace(/\s+/g, ' ').slice(0, 140)}` : 'no review recorded');
  const revSession = (await state()).sessions.find((x) => x.employeeId === rev.id)!;
  const revEvents = await api<any[]>('GET', `/events?employeeId=${rev.id}&limit=400`);
  check('the reviewer really looked at the change (tool activity in their session)', revEvents.some((e) => /^agent\.tool/.test(e.type)), revEvents.filter((e) => e.type === 'agent.tool_started').map((e) => e.summary).slice(0, 3).join(' | '));
  // (Until 2026-11-13 a reviewer was hired read-only and this checked it. No level is read-only now: a reviewer is told
  // not to change the code under review, and is on Standard like everyone hired without a level. Not run since.)
  check('the reviewer is on Standard, like everyone hired without a level', rev.autonomy === 'standard', `${rev.autonomy}, ${revSession.permissionMode}`);
  const modes = (await state()).sessions.filter((x) => x.status === 'running').map((x) => x.mode);
  check(`both employees ran in the ${RUNTIME === 'managed_sdk' ? 'SDK-managed' : 'interactive'} runtime`, modes.length === 2 && modes.every((m) => m === RUNTIME), modes.join(', '));
  if (review?.verdict === 'approved') {
    const merged = await until('merged', (s) => s.tasks.find((t) => t.id === task.id && t.status === 'DONE'), 120000);
    check('after approval the work was merged into the integration branch', merged.evidence.merge?.ok === true && /add/.test(git('show', 'orchestrator/integration:add.js')), git('log', '--oneline', '-1', 'orchestrator/integration'));
  } else {
    check('changes were requested, so nothing was merged and the work went back to the author', done.evidence.merge == null || done.evidence.merge.ok !== true, `task is ${done.status}`);
  }
  check("the owner's own checkout was never touched", git('rev-parse', '--abbrev-ref', 'HEAD') === 'main' && git('status', '--porcelain') === '');

  // A meeting between the two real sessions.
  await until('both idle', (s) => [alex, rev].every((e) => s.sessions.find((x) => x.employeeId === e.id && x.status === 'running' && x.inTurn === false)), 240000);
  const meeting = await api('POST', '/meetings', { topic: 'Should add() reject non-numeric arguments?', projectId: project.id, participantIds: [alex.id, rev.id], context: 'Decide yes or no, with one sentence of reasoning. Keep contributions to two sentences.' });
  log(`meeting started (${meeting.id.slice(0, 8)})`);
  const concluded = await until('meeting concluded', (s) => s.meetings.find((m) => m.id === meeting.id && (m.status === 'concluded' || m.status === 'cancelled')), 600000);
  const by = (round: string) => new Set(concluded.contributions.filter((c: any) => c.round === round).map((c: any) => c.employeeId));
  check('both real sessions contributed a proposal through meeting_contribute', by('proposal').has(alex.id) && by('proposal').has(rev.id), concluded.contributions.filter((c: any) => c.round === 'proposal').map((c: any) => `${c.employeeId === alex.id ? 'Alex' : 'Rev'}: ${String(c.body).replace(/\s+/g, ' ').slice(0, 90)}`).join(' || '));
  check('the meeting ran its rounds and the facilitator recorded a decision', concluded.status === 'concluded' && by('response').size >= 1 && !!concluded.decisionDoc && concluded.decisionDoc.length > 40, `${concluded.status}; ${concluded.contributions.length} contributions; decision: ${String(concluded.decisionDoc).replace(/\s+/g, ' ').slice(0, 160)}`);
  check('the decision is kept as an artifact', (await state()).artifacts.some((a) => a.kind === 'decision_doc' && a.meetingId === meeting.id));
  log(`the owner acted ${ownerActions.length} time(s): ${ownerActions.join(' | ').slice(0, 400)}`);
} catch (e) {
  failed = e as Error;
  log(`✖ ${failed.message}`);
  try {
    const s = await state();
    for (const x of s.sessions) {
      log(`session ${x.tmuxSession}: ${x.status} / ${x.activity} / inTurn=${x.inTurn} / ${x.activityDetail}`);
      console.log(tmux('capture-pane', '-p', '-t', x.tmuxPane!, '-S', '-60').split('\n').filter((l) => l.trim()).slice(-35).join('\n'));
    }
    for (const t of s.tasks) log(`task ${t.key} ${t.kind} ${t.status} delivery=${t.delivery.status} blocked=${t.blockedReason}`);
    for (const q of s.questions) log(`question ${q.kind}/${q.channel} ${q.status}: ${q.text.slice(0, 100)}`);
    for (const m of s.meetings) log(`meeting ${m.status}: ${m.contributions.length} contributions`);
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
