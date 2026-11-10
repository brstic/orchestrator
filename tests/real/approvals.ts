/**
 * REAL approval paths — uses the actual `claude` CLI (model: haiku; three short turns).
 *
 *   node tests/real/approvals.ts
 *
 * Verifies with the real CLI that:
 *   1. a PermissionRequest raised by Claude Code is surfaced as an approval and "Allow" from the office runs the tool
 *   2. "Deny" from the office stops the tool and the session continues
 *   3. Claude Code's AskUserQuestion is answered from the office through the hook
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
const log = (msg: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${msg}`);
const tmux = (...a: string[]) => execFileSync('tmux', ['-L', sock, ...a], { encoding: 'utf8' });
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push([name, ok]);
  log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await startServer({ dataDir: path.join(base, 'server'), host: '127.0.0.1', port: 0, quiet: true });
const cfg = { ...defaultConfig(), serverUrl: server.url, name: 'this-mac', allowedRoots: [fs.realpathSync(base)], tmuxSocketName: sock, claudeBin: process.env.CLAUDE_BIN ?? 'claude', approvalWaitSeconds: 120 };
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
async function until<T>(label: string, fn: (s: FullState) => T | undefined | null | false, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = fn(await state());
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(400);
  }
}

let failed: Error | null = null;
let sessionId = '';
try {
  log(`Claude Code ${info.claudeVersion}, model "${MODEL}"`);
  const dir = path.join(fs.realpathSync(base), 'sandbox');
  fs.mkdirSync(dir);
  while (!agent.isConnected) await sleep(100);
  // Supervised = Claude Code's manual permission mode: every edit asks.
  const dana = await api('POST', '/employees', { name: 'Dana', roleKey: 'devops', hostId: en.hostId, workingDir: dir, model: MODEL, autonomy: 'supervised' });
  const session = await api('POST', `/employees/${dana.id}/start`, {});
  sessionId = session.id;
  const first = await until('trust prompt or start', (s) => s.questions.find((q) => q.kind === 'trust_prompt' && q.status === 'open') ?? (s.sessions.find((x) => x.id === session.id)?.lastEventAt ? 'started' : null), 60000);
  if (first !== 'started') await api('POST', `/questions/${(first as any).id}/answer`, { answer: 'Trust this folder' });
  await until('session idle', (s) => s.sessions.find((x) => x.id === session.id && x.inTurn === false), 60000);
  const mode = (await state()).sessions.find((x) => x.id === session.id)!.permissionMode;
  log(`session ready; permission mode reported by Claude Code: ${mode}`);
  const idle = () => until('idle', (s) => s.sessions.find((x) => x.id === session.id && x.inTurn === false), 180000);
  const seen = new Set<string>();
  const nextQuestion = (kind: string) => until(`${kind} question`, (s) => s.questions.find((q) => q.employeeId === dana.id && q.status === 'open' && q.kind === kind && !seen.has(q.id)), 180000);

  // 1. Allow
  await api('POST', `/employees/${dana.id}/message`, { body: 'Use the Write tool to create a file named hello.txt containing exactly the text: hi   — then reply with the single word DONE. Do not use any other tool.' });
  const q1 = await nextQuestion('permission');
  seen.add(q1.id);
  check('a real PermissionRequest was surfaced as an approval', q1.channel === 'permission_hook' && q1.tool?.name === 'Write', `${q1.text}`);
  check('nothing was written before the decision', !fs.existsSync(path.join(dir, 'hello.txt')));
  const during = (await state()).sessions.find((x) => x.id === session.id)!;
  check('the employee is shown as needing approval', during.activity === 'needs_approval', during.activity);
  await api('POST', `/questions/${q1.id}/answer`, { decision: 'allow' });
  await until('file written', () => fs.existsSync(path.join(dir, 'hello.txt')), 60000);
  check('"Allow" from the office made Claude Code run the tool', fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8').trim() === 'hi', JSON.stringify(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8')));
  const a1 = await until('approval confirmed', (s) => s.questions.find((q) => q.id === q1.id && q.status === 'confirmed'), 30000).catch(() => null);
  check('the approval was confirmed by a real PostToolUse hook', !!a1, a1?.deliveryDetail ?? (await state()).questions.find((q) => q.id === q1.id)!.status);
  await idle();

  // 2. Deny
  await api('POST', `/employees/${dana.id}/message`, { body: 'Use the Write tool to create a file named secret.txt containing the text: nope. If you are not allowed to, do not try again or use another tool; just reply with the single word REFUSED.' });
  const q2 = await nextQuestion('permission');
  seen.add(q2.id);
  await api('POST', `/questions/${q2.id}/answer`, { decision: 'deny', answer: 'Not allowed by the boss.' });
  await idle();
  check('"Deny" from the office stopped the tool', !fs.existsSync(path.join(dir, 'secret.txt')));
  const pane2 = tmux('capture-pane', '-p', '-t', session.tmuxPane, '-S', '-80');
  check('the session continued after the denial', /REFUSED|not allowed|denied/i.test(pane2), pane2.split('\n').filter((l) => /REFUSED|denied|not allowed/i.test(l)).slice(-1)[0]?.trim() ?? '');

  // 3. AskUserQuestion answered from the office
  await api('POST', `/employees/${dana.id}/message`, { body: 'Use the AskUserQuestion tool to ask me one question: "Which colour do you prefer?" with exactly two options, Red and Blue. After I answer, reply with exactly: COLOUR=<the option I chose>. Do not use any other tool.' });
  const q3 = await nextQuestion('question');
  seen.add(q3.id);
  check("Claude Code's AskUserQuestion was surfaced as a question", q3.channel === 'ask_user_question_hook' && q3.parts.length === 1, `"${q3.parts[0]?.question}" options: ${q3.parts[0]?.options.map((o) => o.label).join(' | ')}`);
  const part = q3.parts[0]!;
  const blue = part.options.find((o) => /blue/i.test(o.label))?.label ?? part.options[1]?.label ?? 'Blue';
  await api('POST', `/questions/${q3.id}/answer`, { answers: { [part.question]: blue } });
  await idle();
  const pane3 = tmux('capture-pane', '-p', '-t', session.tmuxPane, '-S', '-60');
  check('the answer chosen in the office reached Claude Code', /COLOUR\s*=\s*Blue/i.test(pane3), pane3.split('\n').filter((l) => /COLOU?R/i.test(l)).slice(-2).join(' / ').trim().slice(0, 160));
  const a3 = (await state()).questions.find((q) => q.id === q3.id)!;
  check('the answer was delivered through the hook', a3.status === 'confirmed' || a3.status === 'delivered', `${a3.status}: ${a3.deliveryDetail}`);
} catch (e) {
  failed = e as Error;
  log(`✖ ${failed.message}`);
  try {
    const s = await state();
    const x = s.sessions.find((y) => y.id === sessionId);
    if (x) {
      log(`session: ${x.status} / ${x.activity} / inTurn=${x.inTurn} / ${x.activityDetail}`);
      console.log(tmux('capture-pane', '-p', '-t', x.tmuxPane!, '-S', '-70').split('\n').filter((l) => l.trim()).slice(-45).join('\n'));
    }
    for (const q of s.questions) log(`question ${q.kind}/${q.channel} ${q.status}: ${q.text.slice(0, 110)} — ${q.deliveryDetail ?? ''}`);
    for (const e2 of s.events.filter((ev) => !(ev.data as any).quiet).slice(-14)) log(`   ${e2.type} — ${e2.summary.slice(0, 120)}`);
  } catch {
    /* ignore */
  }
} finally {
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
const bad = checks.filter((c) => !c[1]);
console.log(`\n${checks.length - bad.length}/${checks.length} checks passed${failed ? ` — aborted: ${failed.message}` : ''}`);
process.exit(failed || bad.length ? 1 : 0);
