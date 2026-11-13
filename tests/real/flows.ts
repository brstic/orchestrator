/**
 * REAL flows check — actual Claude Code sessions (model: haiku), interactive runtime.
 *
 *   node tests/real/flows.ts
 *
 * The less common paths, with the real model instead of the scripted worker:
 *   1. an approval nobody answers: the held hook times out and Claude Code's own
 *      prompt takes over in the terminal, where it is answered;
 *   2. a message sent while the employee is mid-turn is handed over through the
 *      Stop hook instead of being typed;
 *   3. a failed verification leads to a retrospective in the employee's own session;
 *   4. two employees change the same file: the second merge conflicts, is handed
 *      back to its author, who resolves it and resubmits.
 *
 * The script plays the owner (trusting folders, approving requests, choosing who
 * resolves the conflict) and logs everything it does.
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
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push([name, ok]);
  log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const server = await startServer({ dataDir: path.join(base, 'server'), host: '127.0.0.1', port: 0, quiet: true });
// A short approval wait, so the "nobody answered" path is reached quickly.
const cfg = { ...defaultConfig(), serverUrl: server.url, name: 'this-mac', allowedRoots: [fs.realpathSync(base)], tmuxSocketName: sock, claudeBin: process.env.CLAUDE_BIN ?? 'claude', approvalWaitSeconds: 10 };
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
    await sleep(400);
  }
}
const tmux = (...a: string[]) => execFileSync('tmux', ['-u', '-L', sock, ...a], { encoding: 'utf8' });
const pane = (id: string) => tmux('capture-pane', '-p', '-J', '-S', '-120', '-t', id);
const real = fs.realpathSync(base);
const gitIn = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test' } }).trim();
const idle = (id: string, ms = 240000) => until('idle', (s) => s.sessions.find((x) => x.employeeId === id && x.status === 'running' && x.inTurn === false), ms);

// The owner. `holdApprovals` lets one approval go unanswered on purpose.
let holdApprovals = false;
const handled = new Set<string>();
const ownerActions: string[] = [];
const owner = setInterval(async () => {
  try {
    for (const q of (await state()).questions.filter((x) => x.status === 'open' && !handled.has(x.id))) {
      if (q.kind === 'permission' && holdApprovals) continue;
      handled.add(q.id);
      if (q.kind === 'trust_prompt') {
        ownerActions.push('trusted a folder');
        await api('POST', `/questions/${q.id}/answer`, { answer: 'Trust this folder' });
      } else if (q.kind === 'permission') {
        ownerActions.push(`approved: ${q.tool?.name} ${String((q.tool?.input as any)?.command ?? '').slice(0, 70)}`);
        await api('POST', `/questions/${q.id}/answer`, { decision: 'allow' });
      } else if (q.kind === 'merge_conflict') {
        ownerActions.push(`conflict: chose "${q.options[0]?.label}"`);
        await api('POST', `/questions/${q.id}/answer`, { answer: q.options[0]!.label });
      } else {
        ownerActions.push(`answered: ${q.text.slice(0, 70)}`);
        await api('POST', `/questions/${q.id}/answer`, q.parts.length ? { answers: Object.fromEntries(q.parts.map((p) => [p.question, p.options[0]?.label ?? 'Yes'])) } : { answer: 'Use your best judgement and continue.' });
      }
      log(`owner ${ownerActions[ownerActions.length - 1]}`);
    }
  } catch {
    /* shutting down */
  }
}, 1000);

let failed: Error | null = null;
try {
  log(`Claude Code ${info.claudeVersion}, tmux ${info.tmuxVersion}, model "${MODEL}"`);
  while (!agent.isConnected) await sleep(100);

  // ───────────── 1. an approval nobody answers ─────────────
  const folder = path.join(real, 'scratch');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'README.md'), '# scratch\nPurple elephants dance quietly.\n');
  // (Adapted on 2026-11-13, when the levels became three, and NOT run since: on Standard an edit is accepted, so what
  // asks is a command outside the routine list — a file written by `node -e`. Run it before relying on it.)
  const dana = await api('POST', '/employees', { name: 'Dana', roleKey: 'fullstack', hostId: en.hostId, workingDir: folder, model: MODEL, autonomy: 'standard' });
  const danaSession = await api('POST', `/employees/${dana.id}/start`, {});
  await idle(dana.id, 120000);
  holdApprovals = true;
  await api('POST', `/employees/${dana.id}/message`, { body: `Run exactly this one shell command with the Bash tool, as it is written, and no other tool: node -e "require('fs').writeFileSync('t.txt','x')"   Then say done.` });
  const pending = await until('permission request', (s) => s.questions.find((x) => x.employeeId === dana.id && x.kind === 'permission' && x.status === 'open'), 120000);
  handled.add(pending.id);
  log('a permission request is open; nobody answers it');
  const fallback = await until('held hook gave up', (s) => {
    const q = s.questions.find((x) => x.id === pending.id)!;
    return q.status !== 'open' ? q : null;
  }, 60000);
  let prompt = '';
  for (let i = 0; i < 60 && !/Do you want to/i.test((prompt = pane(danaSession.tmuxPane))); i++) await sleep(300);
  const during = (await state()).sessions.find((x) => x.id === danaSession.id)!;
  check('an unanswered approval is not approved implicitly: the hook gives up and the office says so', fallback.status !== 'open' && fallback.decision == null && !fs.existsSync(path.join(folder, 't.txt')), `question is "${fallback.status}": ${String(fallback.deliveryDetail ?? '').slice(0, 110)}`);
  check("Claude Code's own prompt takes over in the terminal, and the office shows the employee waiting for approval", /Do you want to/i.test(prompt) && during.activity === 'needs_approval', `activity ${during.activity}; pane: ${prompt.split('\n').filter((l) => /Do you want to/i.test(l))[0]?.trim() ?? ''}`);
  // The owner answers it where it now is: in the terminal (Enter accepts the highlighted "Yes").
  tmux('send-keys', '-t', danaSession.tmuxPane, 'Enter');
  for (let i = 0; i < 200 && !fs.existsSync(path.join(folder, 't.txt')); i++) await sleep(300);
  check('answering in the terminal lets the real write happen', fs.existsSync(path.join(folder, 't.txt')));
  holdApprovals = false;
  await idle(dana.id);

  // ───────────── 2. a message sent mid-turn goes through the Stop hook ─────────────
  let viaStop: any = null;
  for (let attempt = 1; attempt <= 4 && !viaStop; attempt++) {
    await idle(dana.id);
    const first = await api('POST', `/employees/${dana.id}/message`, { body: `Attempt ${attempt}: read README.md, then run \`ls -la\`, then tell me how many entries the folder has. Do not change anything.` });
    await until('first message acknowledged', (s) => s.messages.find((m) => m.id === first.id && m.delivery.status === 'confirmed'), 90000);
    const second = await api('POST', `/employees/${dana.id}/message`, { body: `One more thing (${attempt}): what is the third word of the second line of README.md? Answer with just that word.` });
    const settled = await until('second message delivered', (s) => s.messages.find((m) => m.id === second.id && (m.delivery.status === 'confirmed' || m.delivery.status === 'failed')), 180000);
    log(`attempt ${attempt}: the second message went via ${settled.delivery.via}`);
    if (settled.delivery.via === 'stop_hook') viaStop = settled;
  }
  check('a message sent while the employee was mid-turn was handed over through the Stop hook, not typed', !!viaStop && viaStop.delivery.status === 'confirmed', viaStop ? String(viaStop.delivery.detail ?? '').slice(0, 120) : 'every attempt found the session already idle');
  await idle(dana.id);
  const danaEvents = await api<any[]>('GET', `/events?employeeId=${dana.id}&limit=400`);
  const answered = danaEvents.filter((e) => e.type === 'agent.turn_finished' && /dance/i.test(e.data.lastMessage ?? '')).pop();
  check('…and the real model acted on it', !!answered, JSON.stringify(answered?.data?.lastMessage ?? '').slice(0, 100));
  await api('POST', `/employees/${dana.id}/stop`, {});

  // ───────────── a shared project for 3 and 4 ─────────────
  const repo = path.join(real, 'site');
  fs.mkdirSync(repo);
  gitIn(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'BANNER.txt'), 'Welcome\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# site\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'initial commit');
  // A check outside the repository whose first *independent* run fails: it passes when the employee
  // runs it inside their own session (which sets ORCH_SESSION_ID), and fails exactly once when
  // Orchestrator runs it on the host — "it worked for me" meeting a real failed verification.
  const marker = path.join(real, 'checked-once');
  const flaky = path.join(real, 'check.sh');
  fs.writeFileSync(flaky, `#!/bin/sh\nif [ -n "$ORCH_SESSION_ID" ]; then echo "all checks passed"; exit 0; fi\nif [ ! -f "${marker}" ]; then touch "${marker}"; echo "check failed: the link checker could not reach its cache (transient); run the check again"; exit 1; fi\necho "all checks passed"\n`, { mode: 0o755 });
  const project = await api('POST', '/projects', { name: 'Site', repoPath: repo, hostId: en.hostId, verifyCommand: `sh ${flaky}`, description: 'A tiny static site.' });
  const alex = await api('POST', '/employees', { name: 'Alex', roleKey: 'backend', hostId: en.hostId, projectId: project.id, autonomy: 'standard', model: MODEL });
  const sam = await api('POST', '/employees', { name: 'Sam', roleKey: 'frontend', hostId: en.hostId, projectId: project.id, autonomy: 'standard', model: MODEL });

  // ───────────── 3. failed verification → retrospective ─────────────
  const t1 = await api('POST', '/tasks', { projectId: project.id, title: 'Add an about page', assigneeId: alex.id, description: 'Create ABOUT.md containing one short sentence about this site. Commit it and call complete_task. If completion is refused, read why, fix it or retry, and call complete_task again.' });
  const d1 = await until('task 1 done', (s) => s.tasks.find((t) => t.id === t1.id && (t.status === 'DONE' || t.status === 'BLOCKED')), 420000);
  check('the first verification really failed and the task still reached DONE on a later one', d1.status === 'DONE' && d1.friction.failedVerifications >= 1 && d1.evidence.verification?.passed === true, `${d1.status}; failed verifications: ${d1.friction.failedVerifications}`);
  const retro = await until('retrospective requested', (s) => s.events.find((e) => e.type === 'improvement.retrospective_requested' && e.taskId === t1.id), 120000);
  await sleep(1500);
  await idle(alex.id);
  const afterRetro = await state();
  const lesson = afterRetro.lessons.find((l) => l.employeeId === alex.id && l.source === 'retrospective');
  const alexEvents = await api<any[]>('GET', `/events?employeeId=${alex.id}&limit=500`);
  const usedTool = alexEvents.some((e) => /^agent\.tool/.test(e.type) && /record_lesson/.test(`${e.summary} ${JSON.stringify(e.data ?? {})}`) && e.ts >= retro.ts);
  check('a retrospective went into the same real session and it answered through record_lesson', usedTool || !!lesson, lesson ? `lesson: "${lesson.text.slice(0, 130)}" (applies ${lesson.appliesWhen ?? '—'})` : 'the model judged there was nothing reusable to record (none=true)');

  // ───────────── 4. merge conflict handed back to its author ─────────────
  await idle(alex.id);
  const a = await api('POST', '/tasks', { projectId: project.id, title: 'Banner for the sale (Alex)', assigneeId: alex.id, description: 'Replace the entire contents of BANNER.txt with the single line: Summer sale starts Monday\nCommit and call complete_task.' });
  const b = await api('POST', '/tasks', { projectId: project.id, title: 'Banner for the event (Sam)', assigneeId: sam.id, description: 'Replace the entire contents of BANNER.txt with the single line: Join our launch event on Friday\nCommit and call complete_task. If you are later told that your branch conflicts with the integration branch, merge the integration branch into your branch, resolve the conflict by keeping BOTH lines (each on its own line, no conflict markers), commit, and call complete_task again.' });
  const conflict = await until('a merge conflict', (s) => s.questions.find((x) => x.kind === 'merge_conflict' && (x.taskId === a.id || x.taskId === b.id)), 420000);
  const loser = conflict.taskId === a.id ? a : b;
  const winner = conflict.taskId === a.id ? b : a;
  const afterConflict = (await state()).tasks;
  const winnerLine = winner.id === a.id ? 'Summer sale starts Monday' : 'Join our launch event on Friday';
  check('the second merge conflicted, was aborted, and nothing was overwritten', afterConflict.find((t) => t.id === winner.id)!.status === 'DONE' && gitIn(repo, 'show', 'orchestrator/integration:BANNER.txt').trim() === winnerLine, `integration still has only: "${gitIn(repo, 'show', 'orchestrator/integration:BANNER.txt').trim()}"`);
  const resolved = await until('conflict resolved by its author', (s) => s.tasks.find((t) => t.id === loser.id && (t.status === 'DONE' || (t.status === 'BLOCKED' && t.evidence.merge?.ok === false && s.questions.filter((q) => q.kind === 'merge_conflict' && q.taskId === loser.id).length > 1))), 480000);
  const merged = gitIn(repo, 'show', 'orchestrator/integration:BANNER.txt');
  check('the author resolved it in their own real session and the result merged cleanly', resolved.status === 'DONE' && resolved.evidence.merge?.ok === true && /Summer sale starts Monday/.test(merged) && /Join our launch event on Friday/.test(merged) && !/^[<=>]{7}/m.test(merged), `BANNER.txt on integration: ${JSON.stringify(merged)}`);
  check('the hand-back is on the record', resolved.history.some((h) => /resolve the merge conflict/i.test(h.note)) && resolved.friction.mergeConflicts >= 1);
  check("the owner's own checkout was never touched", gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD') === 'main' && gitIn(repo, 'status', '--porcelain') === '' && fs.readFileSync(path.join(repo, 'BANNER.txt'), 'utf8') === 'Welcome\n');
  log(`the owner acted ${ownerActions.length} time(s): ${ownerActions.join(' | ').slice(0, 500)}`);
} catch (e) {
  failed = e as Error;
  log(`✖ ${failed.message}`);
  try {
    const s = await state();
    for (const x of s.sessions.filter((x) => x.status === 'running')) {
      log(`session ${x.tmuxSession}: ${x.status} / ${x.activity} / inTurn=${x.inTurn} / ${x.activityDetail}`);
      console.log(pane(x.tmuxPane!).split('\n').filter((l) => l.trim()).slice(-35).join('\n'));
    }
    for (const t of s.tasks) log(`task ${t.key} ${t.status} delivery=${t.delivery.status} blocked=${t.blockedReason} friction=${JSON.stringify(t.friction)}`);
    for (const q of s.questions) log(`question ${q.kind}/${q.channel} ${q.status}: ${q.text.slice(0, 100)}`);
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
