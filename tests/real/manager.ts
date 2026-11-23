/**
 * REAL autonomy check — a project manager drives a request with real Claude Code sessions (spends Claude usage: run it
 * only when asked). The owner, 2026-11-23: "I tell the project manager what I need; it breaks it down, uses the other
 * agents and builds the whole of it by itself, as I asked — it may approve from review itself, and asks me when unsure."
 *
 *   node tests/real/manager.ts            (REAL_PM_MODEL=sonnet, REAL_MODEL=haiku by default)
 *
 * One message from the boss to the manager; then the script only plays the owner's part in the background (trusts
 * folders, allows what is asked, answers what is escalated) and watches. What it checks: the manager put the work on the
 * board for the others; they did it and the office verified it; the manager gave the verdicts in the boss's place; the
 * manager heard how the work went; the result is merged and its test passes; the manager told the boss.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FullState } from '@orchestrator/contracts';
import { HostAgent, enroll } from '../../apps/host-agent/src/agent.ts';
import { defaultConfig, saveConfig } from '../../apps/host-agent/src/config.ts';
import { startServer } from '../../apps/server/src/server.ts';

const PM_MODEL = process.env.REAL_PM_MODEL ?? 'sonnet';
const MODEL = process.env.REAL_MODEL ?? 'haiku';
const LIMIT_MS = Number(process.env.REAL_LIMIT_MIN ?? 30) * 60_000;
const base = fs.mkdtempSync('/tmp/orch-real-pm-');
const sock = `orch-real-pm-${process.pid}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s] ${s}`);
const checks: Array<[string, boolean]> = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push([name, ok]);
  log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await startServer({ dataDir: path.join(base, 'server'), host: '127.0.0.1', port: 0, quiet: true });
const cfg = { ...defaultConfig(), serverUrl: server.url, name: 'this-mac', allowedRoots: [fs.realpathSync(base)], tmuxSocketName: sock, claudeBin: process.env.CLAUDE_BIN ?? 'claude' };
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
const tmux = (...a: string[]) => execFileSync('tmux', ['-u', '-L', sock, ...a], { encoding: 'utf8' });

// The owner's part: trusts folders, allows what is asked, answers what reaches them (and notes it: an escalation).
const handled = new Set<string>();
const ownerActions: string[] = [];
const owner = setInterval(async () => {
  try {
    const s = await state();
    for (const q of s.questions.filter((x) => x.status === 'open' && !handled.has(x.id) && !x.managerId)) {
      handled.add(q.id);
      if (q.kind === 'trust_prompt') await api('POST', `/questions/${q.id}/answer`, { answer: 'Trust this folder' });
      else if (q.kind === 'permission') {
        ownerActions.push(`allowed: ${q.tool?.name} ${String((q.tool?.input as any)?.command ?? '').slice(0, 70)}`);
        await api('POST', `/questions/${q.id}/answer`, { decision: 'allow' });
      } else {
        ownerActions.push(`answered (reached the boss): ${q.text.slice(0, 90)}${q.escalated ? ` — escalated by ${q.escalated.by}: ${q.escalated.why}` : ''}`);
        await api('POST', `/questions/${q.id}/answer`, q.parts.length ? { answers: Object.fromEntries(q.parts.map((p) => [p.question, p.options[0]?.label ?? 'Yes'])) } : { answer: 'Use your best judgement and keep it simple.' });
      }
      if (ownerActions.length) log(`owner ${ownerActions.at(-1)}`);
    }
    // Work that reaches the boss's own verdict (escalated, or nobody to give it): approved, and noted.
    for (const t of s.tasks.filter((x) => x.status === 'REVIEW' && x.reviewStage === 'boss' && !x.approverId && !handled.has(`v:${x.id}:${x.history.length}`))) {
      handled.add(`v:${t.id}:${t.history.length}`);
      ownerActions.push(`approved as the boss: ${t.key} ${t.title}${t.escalated ? ` (escalated: ${t.escalated.why})` : ''}`);
      log(`owner ${ownerActions.at(-1)}`);
      await api('POST', `/tasks/${t.id}/review`, { verdict: 'approve', comments: 'OK.' }).catch(() => undefined);
    }
  } catch {
    /* shutting down */
  }
}, 1500);

let failed: Error | null = null;
try {
  log(`Claude Code ${info.claudeVersion}; manager on "${PM_MODEL}", the others on "${MODEL}"; at most ${LIMIT_MS / 60_000} minutes`);
  const repo = path.join(fs.realpathSync(base), 'shop-site');
  fs.mkdirSync(repo);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test' } }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'shop-site', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2) + '\n');
  fs.writeFileSync(path.join(repo, 'test.js'), "// The site's checks go here.\nconsole.log('ok');\n");
  fs.writeFileSync(path.join(repo, 'README.md'), '# Shop site\n\nA small static site.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial commit');
  while (!agent.isConnected) await sleep(100);

  await api('PATCH', '/settings', { reviewDefault: 'boss', managersApprove: true, employeesManageBoard: true });
  const project = await api('POST', '/projects', { name: 'Shop site', repoPath: repo, hostId: en.hostId, verifyCommand: 'npm test --silent', description: 'A small static site for a shop.' });
  const mia = await api('POST', '/employees', { name: 'Mia', roleKey: 'pm', hostId: en.hostId, projectId: project.id, autonomy: 'auto', model: PM_MODEL });
  const alex = await api('POST', '/employees', { name: 'Alex', roleKey: 'frontend', hostId: en.hostId, projectId: project.id, autonomy: 'auto', model: MODEL });
  const bo = await api('POST', '/employees', { name: 'Bo', roleKey: 'qa', hostId: en.hostId, projectId: project.id, autonomy: 'auto', model: MODEL });
  const request =
    'I need a small static site for the shop, in this project: a home page (index.html) with the heading "Acme Shop" and a link to an about page (about.html) whose heading is "About us"; and test.js extended to check that both pages exist, have those headings, and that the home page links to about.html — `npm test` must pass. Break it down, give the parts to Alex and Bo, see it through to the end, and tell me when it is done.';
  await api('POST', `/employees/${mia.id}/message`, { body: request });
  log('the boss told Mia what they need');

  // Watch until the manager tells the boss it is delivered, or the time is up.
  const deadline = Date.now() + LIMIT_MS;
  let lastLine = '';
  let told: string | null = null;
  for (;;) {
    const s = await state();
    const mine = s.tasks.filter((t) => t.createdBy === 'employee:Mia' && !t.reviewOf);
    const line = mine.map((t) => `${t.key}:${t.status}${t.approverId ? '(Mia)' : ''}`).join(' ') || 'no tasks yet';
    if (line !== lastLine) log(`board: ${(lastLine = line)}`);
    const note = s.notifications.find((n) => n.kind === 'message' && n.employeeId === mia.id);
    if (note) told = note.body;
    if (told && mine.length && mine.every((t) => t.status === 'DONE')) break;
    if (Date.now() > deadline) throw new Error('time is up');
    await sleep(5000);
  }
  const s = await state();
  const mine = s.tasks.filter((t) => t.createdBy === 'employee:Mia' && !t.reviewOf);
  check('Mia broke the request down and put it on the board', mine.length >= 2, mine.map((t) => `${t.key} ${t.title}`).join(' | '));
  check('the work went to the others, not to Mia', mine.every((t) => t.assigneeId === alex.id || t.assigneeId === bo.id), mine.map((t) => s.employees.find((e) => e.id === t.assigneeId)?.name).join(', '));
  check('the office verified each piece itself', mine.every((t) => t.evidence.verification?.provenance === 'measured' && t.evidence.verification.passed === true));
  const inPlace = mine.filter((t) => t.history.some((h) => /in the boss's place/.test(h.note)));
  check("Mia gave the verdicts in the boss's place", inPlace.length >= 1, `${inPlace.length} of ${mine.length}; the rest: ${mine.filter((t) => !inPlace.includes(t)).map((t) => t.history.at(-2)?.note).join(' | ')}`);
  const followUps = s.messages.filter((m) => m.toEmployeeId === mia.id && m.from.kind === 'system' && /which you put on the board, is (done|blocked)/.test(m.body));
  check('Mia heard how each piece went', followUps.length >= 1, `${followUps.length} message(s)`);
  let testOut = '';
  try {
    const integ = path.join(path.dirname(repo), '.orchestrator-worktrees', 'shop-site', '_integration');
    testOut = execFileSync('npm', ['test', '--silent'], { cwd: integ, encoding: 'utf8' }).trim();
    const files = git('ls-tree', '--name-only', 'orchestrator/integration');
    check('the whole of it is merged, and its test passes', /index\.html/.test(files) && /about\.html/.test(files), `${files.replace(/\n/g, ' ')}; npm test: ${testOut.split('\n').at(-1)}`);
  } catch (e) {
    check('the whole of it is merged, and its test passes', false, (e as Error).message.slice(0, 300));
  }
  check('Mia told the boss it is done', !!told, (told ?? '').replace(/\s+/g, ' ').slice(0, 300));
  log(`owner did: ${ownerActions.length ? ownerActions.join(' · ') : 'nothing but trusting folders'}`);
  const usage = s.sessions.filter((x) => x.usage).map((x) => `${s.employees.find((e) => e.id === x.employeeId)?.name}: ${JSON.stringify(x.usage).slice(0, 120)}`);
  if (usage.length) log(`usage: ${usage.join(' | ')}`);
} catch (e) {
  failed = e as Error;
  log(`stopped: ${failed.message}`);
  try {
    const s = await state();
    for (const t of s.tasks) log(`  ${t.key} ${t.status} ${t.title} — ${t.history.slice(-3).map((h) => h.note).join(' / ')}`);
    for (const x of s.sessions) log(`  session ${s.employees.find((e) => e.id === x.employeeId)?.name}: ${x.status} ${x.activity} inTurn=${x.inTurn} ${x.exitReason ?? ''}`);
    for (const q of s.questions.filter((y) => y.status === 'open')) log(`  open question (${q.kind}) from ${s.employees.find((e) => e.id === q.employeeId)?.name}: ${q.text.slice(0, 160)}`);
    for (const e of (await api<any[]>('GET', '/events?limit=60&includeActivity=1')).slice(-40)) log(`  event ${e.type}: ${String(e.summary).slice(0, 180)}`);
    for (const x of s.sessions.filter((y) => y.status === 'running' && y.tmuxPane)) log(`  ${s.employees.find((e) => e.id === x.employeeId)?.name} pane:\n${tmux('capture-pane', '-p', '-J', '-S', '-25', '-t', x.tmuxPane!).split('\n').filter((l) => l.trim()).slice(-15).join('\n')}`);
  } catch {
    /* nothing more to show */
  }
} finally {
  clearInterval(owner);
  for (const x of (await state().catch(() => ({ sessions: [] }) as any)).sessions) await api('POST', `/employees/${x.employeeId}/stop`, {}).catch(() => undefined);
  await sleep(1500);
  await agent.stop?.();
  await server.close?.();
  try {
    execFileSync('tmux', ['-L', sock, 'kill-server']);
  } catch {
    /* already gone */
  }
}
const bad = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - bad.length}/${checks.length} checks passed${failed ? ` — stopped early: ${failed.message}` : ''}`);
process.exit(bad.length || failed ? 1 : 0);
