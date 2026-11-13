/**
 * REAL SDK-managed worker check — uses the actual Claude Agent SDK and the actual
 * `claude` CLI (model: haiku; a handful of short turns).
 *
 *   ORCH_SDK_PATH=/path/to/node_modules/@anthropic-ai/claude-agent-sdk node tests/real/sdk.ts
 *
 * (or install the SDK for the agent first: `orchestrator-agent sdk install`.)
 *
 * An employee driven through the SDK: a prompt handed over as structured input,
 * the real reply back, a real approval decided in the office through the SDK's
 * permission callback, the keyboard fallback when nobody answers, a real
 * interrupt, resuming the same conversation after a restart, and a task that is
 * done in the folder and verified.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FullState } from '@orchestrator/contracts';
import { HostAgent, enroll } from '../../apps/host-agent/src/agent.ts';
import { defaultConfig, saveConfig } from '../../apps/host-agent/src/config.ts';
import { startServer } from '../../apps/server/src/server.ts';

const base = fs.mkdtempSync('/tmp/orch-real-');
const sock = `orch-real-${process.pid}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push([name, ok]);
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const server = await startServer({ dataDir: path.join(base, 'server'), host: '127.0.0.1', port: 0, quiet: true });
const cfg = { ...defaultConfig(), serverUrl: server.url, name: 'this-mac', allowedRoots: [fs.realpathSync(base)], tmuxSocketName: sock, claudeBin: process.env.CLAUDE_BIN ?? 'claude', sdkPath: process.env.ORCH_SDK_PATH ?? null, approvalWaitSeconds: 12 };
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
async function until<T>(label: string, fn: (s: FullState) => T | undefined | null | false, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn(await api<FullState>('GET', '/state'));
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(400);
  }
}
const pane = (id: string) => execFileSync('tmux', ['-u', '-L', sock, 'capture-pane', '-p', '-J', '-S', '-200', '-t', id], { encoding: 'utf8' });
let failed: Error | null = null;
let paneId = '';
try {
  check('this host offers the SDK-managed runtime', !!info.runtimes?.includes('managed_sdk'), JSON.stringify(info.runtimes));
  if (!info.runtimes?.includes('managed_sdk')) throw new Error('the Claude Agent SDK was not found: set ORCH_SDK_PATH or run `orchestrator-agent sdk install`');
  const folder = path.join(fs.realpathSync(base), 'notes-app');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'README.md'), '# notes-app\nA tiny notes application. The secret word for this folder is PINEAPPLE.\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: folder, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test' } }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial commit');
  while (!agent.isConnected) await sleep(100);
  const mira =await api('POST', '/employees', { name: 'Mira', roleKey: 'fullstack', hostId: en.hostId, workingDir: folder, model: process.env.REAL_MODEL ?? 'haiku', executionMode: 'managed_sdk', autonomy: 'standard' });
  // (Adapted on 2026-11-13, when the levels became three, and NOT run since: on Standard an edit is accepted, so what
  // asks is a command outside the routine list — a file written by `node -e`. Run it before relying on it.)
  const session = await api('POST', `/employees/${mira.id}/start`, {});
  paneId = session.tmuxPane;
  check('she runs as an SDK-managed worker, with no fallback', session.mode === 'managed_sdk' && !(await api<FullState>('GET', '/state')).notifications.some((n) => /runtime fallback/.test(n.title)), `mode ${session.mode}, pane ${session.tmuxPane}`);
  await until('ready', (s) => s.sessions.find((x) => x.id === session.id && x.inTurn === false), 90000);
  check('the real Claude Code process came up under the SDK', /SDK-managed Claude worker/.test(pane(paneId)));

  const msg = await api('POST', `/employees/${mira.id}/message`, { body: 'Read README.md in your folder and tell me, in one short sentence, the secret word it mentions. Do not change anything.' });
  const delivered = await until('message confirmed', (s) => s.messages.find((m) => m.id === msg.id && m.delivery.status === 'confirmed'), 90000);
  check('the message was handed over as structured SDK input', delivered.delivery.via === 'sdk', `via ${delivered.delivery.via}, confirmed by UserPromptSubmit`);
  await until('turn finished', (s) => s.sessions.find((x) => x.id === session.id && x.inTurn === false), 180000);
  const events = await api<any[]>('GET', `/events?employeeId=${mira.id}&limit=300`);
  const reply = events.filter((e) => e.type === 'agent.turn_finished' && e.data.lastMessage).pop();
  check('her real reply came back through the SDK Stop hook', !!reply && /PINEAPPLE/i.test(reply.data.lastMessage), reply ? JSON.stringify(reply.data.lastMessage).slice(0, 160) : 'no reply captured');
  const toolEvents = events.filter((e) => /^agent\.tool/.test(e.type));
  check('real tool activity was reported by SDK hooks', toolEvents.length > 0, toolEvents.map((e) => e.summary).slice(0, 3).join(' | '));

  await api('POST', `/employees/${mira.id}/message`, { body: `Run exactly this one shell command with the Bash tool, as it is written, and no other tool: node -e "require('fs').writeFileSync('hello.txt','hello')"   Then say done.` });
  const q = await until('permission request', (s) => s.questions.find((x) => x.employeeId === mira.id && x.kind === 'permission' && x.status === 'open'), 180000);
  check('the SDK permission callback raised a real approval in the office', q.channel === 'permission_hook', `${q.tool?.name} ${JSON.stringify(q.tool?.input).slice(0, 100)}`);
  check('nothing is written before the approval', !fs.existsSync(path.join(folder, 'hello.txt')));
  await api('POST', `/questions/${q.id}/answer`, { decision: 'allow' });
  const end = Date.now() + 120000;
  while (!fs.existsSync(path.join(folder, 'hello.txt')) && Date.now() < end) await sleep(300);
  check('the approved write really happened', fs.existsSync(path.join(folder, 'hello.txt')), fs.existsSync(path.join(folder, 'hello.txt')) ? JSON.stringify(fs.readFileSync(path.join(folder, 'hello.txt'), 'utf8')) : 'no file');
  await until('second turn finished', (s) => s.sessions.find((x) => x.id === session.id && x.inTurn === false), 180000);
  const usage = await until('usage', (s) => s.sessions.find((x) => x.id === session.id)?.usage, 20000);
  check('usage is measured, and the SDK cost estimate is recorded', usage.outputTokens > 0 && typeof usage.costUsdEstimate === 'number', `${usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens} in / ${usage.outputTokens} out, estimate $${usage.costUsdEstimate?.toFixed(4)}`);

  // Nobody answers in the office: after the host's approval wait the runner asks in the pane.
  await api('POST', `/employees/${mira.id}/message`, { body: `Run exactly this one shell command with the Bash tool, as it is written, and no other tool: node -e "require('fs').writeFileSync('second.txt','second')"   Then say done.` });
  await until('second permission request', (s) => s.questions.find((x) => x.employeeId === mira.id && x.kind === 'permission' && x.status === 'open'), 180000);
  let asked = false;
  for (let i = 0; i < 120 && !(asked = /Allow this\? \[y\/N\]/.test(pane(paneId))); i++) await sleep(300);
  check('with no answer from the office, the approval is asked at the workstation', asked && !fs.existsSync(path.join(folder, 'second.txt')));
  execFileSync('tmux', ['-u', '-L', sock, 'send-keys', '-t', paneId, 'y']);
  for (let i = 0; i < 200 && !fs.existsSync(path.join(folder, 'second.txt')); i++) await sleep(300);
  check('"y" at the keyboard let the real write happen', fs.existsSync(path.join(folder, 'second.txt')));
  await until('third turn finished', (s) => s.sessions.find((x) => x.id === session.id && x.inTurn === false), 180000);
  await until('office question closed', (s) => !s.questions.some((x) => x.employeeId === mira.id && x.kind === 'permission' && x.status === 'open'), 30000);

  // A real interrupt through the SDK, in the middle of a long answer.
  const long = await api('POST', `/employees/${mira.id}/message`, { body: 'Without using any tools, write the numbers from 1 to 600 in words, one per line, then write the single word FINISHED-COUNTING.' });
  await until('long turn started', (s) => s.messages.find((m) => m.id === long.id && m.delivery.status === 'confirmed'), 90000);
  await sleep(2500);
  await api('POST', `/employees/${mira.id}/pause`, {});
  let interrupted = false;
  for (let i = 0; i < 60 && !(interrupted = /Interrupted \(office\)/.test(pane(paneId))); i++) await sleep(250);
  await sleep(4000);
  const afterInterrupt = pane(paneId);
  const interruptEvent = (await api<any[]>('GET', `/events?employeeId=${mira.id}&limit=400`)).find((e) => e.type === 'terminal.interrupt');
  // The phrase is in the echoed prompt once; the model never got to write it.
  check('the office interrupt stopped the real turn through the SDK', interrupted && interruptEvent?.data?.via === 'sdk' && afterInterrupt.split('FINISHED-COUNTING').length - 1 <= 1, `event: ${interruptEvent?.summary}`);
  await api('POST', `/employees/${mira.id}/resume`, {});
  const still = (await api<FullState>('GET', '/state')).sessions.find((x) => x.id === session.id)!;
  check('the worker process survived the interrupt', still.status === 'running' && still.pid === session.pid, `pid ${still.pid}`);

  // Stop and start: the same Claude conversation is resumed, with standard autonomy this time.
  await api('PATCH', `/employees/${mira.id}`, { autonomy: 'standard' });
  await api('POST', `/employees/${mira.id}/stop`, {});
  const again = await api('POST', `/employees/${mira.id}/start`, {});
  paneId = again.tmuxPane;
  await until('resumed and ready', (s) => s.sessions.find((x) => x.id === again.id && x.status === 'running' && x.inTurn === false), 90000);
  const recall = await api('POST', `/employees/${mira.id}/message`, { body: 'Without reading any file: what was the secret word you told me about at the start of our conversation? Answer with just the word.' });
  await until('recall delivered', (s) => s.messages.find((m) => m.id === recall.id && m.delivery.status === 'confirmed'), 90000);
  await until('recall turn finished', (s) => s.sessions.find((x) => x.id === again.id && x.inTurn === false), 180000);
  const recalled = (await api<any[]>('GET', `/events?employeeId=${mira.id}&limit=400`)).filter((e) => e.type === 'agent.turn_finished' && e.data.lastMessage).pop();
  check('after a restart the same conversation is resumed (it remembers)', again.id === session.id && again.mode === 'managed_sdk' && /\(resumed\)/.test(pane(paneId)) && /PINEAPPLE/i.test(recalled?.data?.lastMessage ?? ''), JSON.stringify(recalled?.data?.lastMessage ?? '').slice(0, 120));

  // A tracked task: delivered through the SDK, done in the folder, verified by Orchestrator.
  const task = await api('POST', '/tasks', {
    projectId: mira.projectId,
    title: 'Add a version file',
    assigneeId: mira.id,
    verifyCommand: 'test "$(cat VERSION.txt)" = "1.0.0"',
    description: 'Create a file named VERSION.txt in this folder containing exactly 1.0.0 (no other text). Commit it with git. Then call complete_task.',
    acceptance: 'VERSION.txt contains 1.0.0 and is committed.',
  });
  // A real model does not always pick pre-approved commands; approve what it asks for, like an owner would.
  const approved: string[] = [];
  const approver = setInterval(() => {
    void api<FullState>('GET', '/state')
      .then(async (s) => {
        for (const x of s.questions.filter((x) => x.employeeId === mira.id && x.kind === 'permission' && x.status === 'open')) {
          approved.push(`${x.tool?.name} ${JSON.stringify(x.tool?.input ?? {}).slice(0, 80)}`);
          await api('POST', `/questions/${x.id}/answer`, { decision: 'allow' }).catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }, 1500);
  let done: any;
  try {
    done = await until('task done', (s) => s.tasks.find((t) => t.id === task.id && (t.status === 'DONE' || t.status === 'BLOCKED')), 300000);
  } finally {
    clearInterval(approver);
  }
  check(
    'a task was delivered through the SDK, done in the folder and verified by Orchestrator',
    done.status === 'DONE' && done.delivery.via === 'sdk' && done.evidence.verification?.passed === true && done.evidence.verification?.provenance === 'measured' && done.evidence.commits.length > 0,
    `${done.key} ${done.status}${done.blockedReason ? ` (${done.blockedReason})` : ''}; ${done.evidence.commits.map((c: any) => c.subject).join('; ')}${approved.length ? `; approved on the way: ${approved.join(' | ')}` : ''}`,
  );
  check('the commit is really in the folder', fs.readFileSync(path.join(folder, 'VERSION.txt'), 'utf8').trim() === '1.0.0' && git('status', '--porcelain', 'VERSION.txt') === '', git('log', '--oneline', '-1'));
  console.log('\n--- the worker pane ---\n' + pane(paneId).trimEnd().split('\n').slice(-30).join('\n') + '\n-----------------------');
} catch (e) {
  failed = e as Error;
  console.log(`✖ ${failed.message}`);
  if (paneId) {
    try {
      console.log('\n--- the worker pane ---\n' + pane(paneId).trimEnd() + '\n-----------------------');
    } catch {
      /* pane gone */
    }
  }
} finally {
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
