/**
 * REAL acceptance run — uses the actual `claude` CLI and your Claude account.
 *
 *   pnpm test:real            (model: haiku, one small task; costs a little usage)
 *   REAL_MODEL=sonnet pnpm test:real
 *
 * It proves, end to end and with no fixture anywhere:
 *   1. a real Claude Code session is started in tmux for an employee
 *   2. Claude Code's own trust prompt is surfaced and answered from the office
 *   3. a task is delivered and acknowledged by a real UserPromptSubmit hook
 *   4. the agent asks the boss a real question through the Orchestrator MCP tool
 *   5. the answer reaches the same session and it continues
 *   6. completion is verified independently (commits, test command) and merged
 *   7. the owner observes the terminal, takes control of that exact session,
 *      types into it, and returns control — same process throughout
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FullState, ServerToClient } from '@orchestrator/contracts';
import { b64decode } from '@orchestrator/contracts';
import { HostAgent, enroll } from '../../apps/host-agent/src/agent.ts';
import { defaultConfig, saveConfig } from '../../apps/host-agent/src/config.ts';
import { startServer } from '../../apps/server/src/server.ts';

const MODEL = process.env.REAL_MODEL ?? 'haiku';
const KEEP = !!process.env.KEEP;
const base = fs.mkdtempSync('/tmp/orch-real-');
const sock = `orch-real-${process.pid}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test' } }).trim();
const tmux = (...a: string[]) => execFileSync('tmux', ['-L', sock, ...a], { encoding: 'utf8' });
const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push([name, ok, detail]);
  log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await startServer({ dataDir: path.join(base, 'server'), host: '127.0.0.1', port: 0, quiet: true });
const cfg = { ...defaultConfig(), serverUrl: server.url, name: 'this-mac', allowedRoots: [fs.realpathSync(base)], tmuxSocketName: sock, claudeBin: process.env.CLAUDE_BIN ?? 'claude', approvalWaitSeconds: 120 };
const probe = new HostAgent(cfg, path.join(base, 'agent'), () => undefined);
const info = await (probe as any).collectInfo();
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
async function until<T>(label: string, fn: (s: FullState) => T | undefined | null | false, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn(await state());
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(500);
  }
}

// A real model does not always pick the same commands. If it reaches for one that is not
// pre-approved, Claude Code asks — and, like an owner sitting in the office, this script
// looks at the request and approves it, logging exactly what was approved.
const approved: string[] = [];
const approver = setInterval(async () => {
  try {
    for (const q of (await state()).questions.filter((x) => x.status === 'open' && x.kind === 'permission')) {
      const what = String((q.tool?.input as any)?.command ?? q.text);
      approved.push(what);
      log(`boss approved a permission request: ${what.slice(0, 120)}`);
      await api('POST', `/questions/${q.id}/answer`, { decision: 'allow' });
    }
  } catch {
    /* server is shutting down */
  }
}, 1500);

let failed: Error | null = null;
try {
  log(`Claude Code ${info.claudeVersion}, tmux ${info.tmuxVersion}, model "${MODEL}"`);
  const repo = path.join(fs.realpathSync(base), 'greeter');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'greeter', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2) + '\n');
  fs.writeFileSync(
    path.join(repo, 'test.js'),
    `const assert = require('assert');\nconst { greet } = require('./greet.js');\nconst out = greet('Ada');\nassert.ok(typeof out === 'string' && out.startsWith('Hello, Ada'), 'greet("Ada") should start with "Hello, Ada" but was ' + out);\nconsole.log('ok:', out);\n`,
  );
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial commit');
  while (!agent.isConnected) await sleep(100);

  const project = await api('POST', '/projects', { name: 'Greeter', repoPath: repo, hostId: en.hostId, verifyCommand: 'npm test --silent', description: 'A tiny greeting library.' });
  const alex = await api('POST', '/employees', { name: 'Alex', roleKey: 'backend', hostId: en.hostId, projectId: project.id, autonomy: 'standard', model: MODEL });
  const task = await api('POST', '/tasks', {
    projectId: project.id,
    title: 'Implement greet()',
    assigneeId: alex.id,
    description:
      'Create greet.js exporting a function greet(name) that returns the string "Hello, <name>" followed by one punctuation mark. Before writing any code you MUST ask the boss, using the orchestrator ask_boss tool, which punctuation mark to use, offering "!" and "." as options. Then implement it with exactly that mark, run `npm test`, commit, and call complete_task.',
    acceptance: 'npm test passes; greet("Ada") returns "Hello, Ada" plus the punctuation the boss chose.',
  });
  log(`task ${task.key} created and assigned to Alex`);

  const session = await until('real session started', (s) => s.sessions.find((x) => x.employeeId === alex.id && x.status === 'running'), 60000);
  check('a real Claude Code process runs in tmux for the employee', /claude|node/i.test(tmux('list-panes', '-t', session.tmuxSession, '-F', '#{pane_current_command}')), `tmux session ${session.tmuxSession}, pid ${session.pid}`);
  check('the session runs in an isolated git worktree', session.cwd.includes('.orchestrator-worktrees/greeter/alex'), session.cwd);

  // Claude Code asks whether to trust a folder it has not seen. That prompt is surfaced as a question.
  const first = await until('trust prompt or session start', (s) => s.questions.find((q) => q.kind === 'trust_prompt' && q.status === 'open') ?? (s.sessions.find((x) => x.id === session.id)?.lastEventAt ? 'started' : null), 60000);
  if (first !== 'started') {
    check("Claude Code's own trust prompt was surfaced in the office", true, (first as any).text);
    await api('POST', `/questions/${(first as any).id}/answer`, { answer: 'Trust this folder' });
  }
  await until('SessionStart hook', (s) => s.sessions.find((x) => x.id === session.id && !!x.lastEventAt), 60000);
  check('real SessionStart hook received', true);

  const delivered = await until('task acknowledged by UserPromptSubmit', (s) => s.tasks.find((t) => t.id === task.id && t.delivery.status === 'confirmed'), 90000);
  check('task prompt was typed into the terminal and acknowledged by a real UserPromptSubmit hook', true, `branch ${delivered.branch}`);

  const q = await until('question from ask_boss', (s) => s.questions.find((x) => x.employeeId === alex.id && x.channel === 'mcp_tool' && x.status === 'open'), 240000);
  check('the agent asked the boss through the Orchestrator MCP tool', true, `"${q.text}" options: ${q.options.map((o) => o.label).join(' | ') || '(none)'}`);
  const during = (await state()).sessions.find((x) => x.id === session.id)!;
  check('the employee is shown as waiting for a decision', during.activity === 'waiting_answer', during.activity);
  check('no implementation exists before the answer', !fs.existsSync(path.join(session.cwd, 'greet.js')));

  await api('POST', `/questions/${q.id}/answer`, { answer: 'Use an exclamation mark: "!"' });
  log('boss answered: use "!"');

  const done = await until('task verified and done', (s) => s.tasks.find((t) => t.id === task.id && (t.status === 'DONE' || t.status === 'BLOCKED')), 420000);
  check('task reached DONE after independent verification', done.status === 'DONE', done.status === 'DONE' ? '' : (done.blockedReason ?? ''));
  check('verification was measured by Orchestrator on the host', done.evidence.verification?.provenance === 'measured' && done.evidence.verification?.passed === true, `${done.evidence.verification?.command} → exit ${done.evidence.verification?.exitCode}: ${done.evidence.verification?.outputTail.trim().split('\n').pop()}`);
  check('real commits exist on the task branch', done.evidence.commits.length > 0, done.evidence.commits.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`).join('; '));
  check('the work was merged into the integration branch', done.evidence.merge?.ok === true, git(repo, 'log', '--oneline', '-1', 'orchestrator/integration'));
  const merged = git(repo, 'show', 'orchestrator/integration:greet.js');
  check("the boss's answer shaped the real code", /Hello, .*!/s.test(merged) || merged.includes('!'), merged.replace(/\s+/g, ' ').slice(0, 120));
  check("the owner's own checkout was never touched", git(repo, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main' && git(repo, 'status', '--porcelain') === '');
  const answered = (await state()).questions.find((x) => x.id === q.id)!;
  check('the answer was delivered and confirmed by the runtime', answered.status === 'confirmed' || answered.status === 'delivered', `${answered.status}: ${answered.deliveryDetail}`);

  const final = await state();
  const hookEvents = final.events.filter((e) => e.source.kind === 'hook' && e.sessionId === session.id);
  const tools = [...new Set(hookEvents.filter((e) => e.type === 'agent.tool_started').map((e) => String(e.data.tool)))];
  check('activity came from real tool hooks', tools.length > 0, `tools used: ${tools.join(', ')}`);
  const usage = await until('usage', (s) => s.sessions.find((x) => x.id === session.id)?.usage, 20000).catch(() => null);
  check('token usage was measured from the real transcript', !!usage && usage.outputTokens > 0, usage ? `${usage.inputTokens} in / ${usage.outputTokens} out / ${usage.cacheReadTokens} cache-read tokens over ${usage.turns} turn(s)` : 'unavailable');
  const emp = final.employees.find((e) => e.id === alex.id)!;
  check('XP was awarded for the verified task', emp.xp > 0, `${emp.xp} XP, level ${emp.level}`);

  // ── Observe, take control, type, return control: same tmux session, same process ──
  await until('agent idle', (s) => s.sessions.find((x) => x.id === session.id && x.inTurn === false), 120000);
  const pidBefore = (await state()).sessions.find((x) => x.id === session.id)!.pid;
  const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws/client?token=${server.ownerToken}`);
  let term = '';
  let snapSeq = -1;
  let control = '';
  const pending: Array<{ seq: number; text: string }> = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as ServerToClient;
    if (m.t === 'term.snapshot') {
      term = Buffer.from(b64decode(m.snapshot.data)).toString('utf8');
      snapSeq = m.snapshot.seq;
      for (const p of pending) if (p.seq > snapSeq) term += p.text;
    } else if (m.t === 'term.output') {
      const text = Buffer.from(b64decode(m.data)).toString('utf8');
      pending.push({ seq: m.seq, text });
      if (snapSeq >= 0 && m.seq > snapSeq) term += text;
    } else if (m.t === 'control' && m.sessionId === session.id) control = `${m.control}${m.you ? ':you' : ''}`;
  };
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ t: 'term.open', sessionId: session.id }));
  const waitTerm = async (re: RegExp, label: string, ms = 20000) => {
    const end = Date.now() + ms;
    while (!re.test(term)) {
      if (Date.now() > end) throw new Error(`timed out waiting for terminal: ${label}`);
      await sleep(200);
    }
  };
  await waitTerm(/complete_task|Hello|greet/i, 'snapshot of the real session');
  check("the owner can read the employee's real terminal", true, `${term.length} bytes of live terminal state`);
  const before = term.length;
  ws.send(JSON.stringify({ t: 'term.input', sessionId: session.id, data: 'x' }));
  await sleep(800);
  check('observing does not send keystrokes', !tmux('capture-pane', '-p', '-t', session.tmuxPane!).split('\n').some((l) => /^❯ x\s*$/.test(l.trim())), `terminal grew by ${term.length - before} bytes`);
  ws.send(JSON.stringify({ t: 'control.acquire', sessionId: session.id }));
  while (control !== 'HUMAN_CONTROLLED:you') await sleep(100);
  // "!" puts Claude Code in shell mode: a command the owner runs directly in the employee's environment.
  ws.send(JSON.stringify({ t: 'term.input', sessionId: session.id, data: '!' }));
  await sleep(400);
  ws.send(JSON.stringify({ t: 'term.input', sessionId: session.id, data: 'echo takeover-$((40+2))-ok\r' }));
  await waitTerm(/takeover-42-ok/, 'output of the command typed by the owner', 30000);
  check('the owner took control and worked in the same session', true, 'ran a shell command inside the employee\'s Claude Code session');
  ws.send(JSON.stringify({ t: 'control.release', sessionId: session.id }));
  await sleep(500);
  const after = (await state()).sessions.find((x) => x.id === session.id)!;
  check('control was returned and the process is the same one', after.pid === pidBefore && after.status === 'running' && after.control !== 'HUMAN_CONTROLLED', `pid ${after.pid}, control ${after.control}`);
  ws.close();

  // ── Self-improvement: what did the worker and Orchestrator learn? ──
  const lessons = (await state()).lessons;
  check('the boss\'s decision was kept as project knowledge', lessons.some((l) => l.source === 'owner_answer'), lessons.map((l) => `[${l.scope}] ${l.text}`).join(' || ').slice(0, 200));

  log('');
  log('Office feed (non-quiet events):');
  for (const e of final.events.filter((x) => !(x.data as any).quiet).slice(-28)) log(`   ${e.ts.slice(11, 19)} ${e.summary.slice(0, 130)}`);
} catch (e) {
  failed = e as Error;
  log(`✖ ${failed.message}`);
  try {
    const s = await state();
    for (const x of s.sessions) {
      log(`session ${x.tmuxSession}: ${x.status} / ${x.activity} / inTurn=${x.inTurn} / ${x.activityDetail}`);
      console.log(tmux('capture-pane', '-p', '-t', x.tmuxPane!, '-S', '-60').split('\n').filter((l) => l.trim()).slice(-40).join('\n'));
    }
    for (const t of s.tasks) log(`task ${t.key} ${t.status} delivery=${t.delivery.status} blocked=${t.blockedReason}`);
    for (const q of s.questions) log(`question ${q.kind}/${q.channel} ${q.status}: ${q.text.slice(0, 100)}`);
  } catch {
    /* ignore */
  }
} finally {
  clearInterval(approver);
  if (approved.length) log(`${approved.length} permission request(s) were approved from the office during this run.`);
  if (KEEP) log(`kept: tmux -L ${sock} attach   (data in ${base})`);
  else {
    await agent.stop().catch(() => undefined);
    try {
      tmux('kill-server');
    } catch {
      /* none */
    }
    await server.close().catch(() => undefined);
    fs.rmSync(base, { recursive: true, force: true });
    // tmux leaves the socket file of a dedicated server behind.
    fs.rmSync(path.join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, sock), { force: true });
  }
}
const bad = checks.filter((c) => !c[1]);
console.log(`\n${checks.length - bad.length}/${checks.length} checks passed${failed ? ` — aborted: ${failed.message}` : ''}`);
process.exit(failed || bad.length ? 1 : 0);
