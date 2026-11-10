/**
 * REAL auto-mode check — uses the actual `claude` CLI (model: haiku; three short turns).
 *
 *   node tests/real/auto.ts
 *
 * An employee on Auto in a folder Claude Code has never seen: they start, write files, run
 * commands and commit without the owner being asked anything — and still come to the owner
 * when they need a decision.
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
async function until<T>(label: string, fn: (s: FullState) => T | undefined | null | false, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn(await api<FullState>('GET', '/state'));
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(400);
  }
}
let failed: Error | null = null;
try {
  const folder = path.join(fs.realpathSync(base), 'auto-app');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'README.md'), '# auto-app\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: folder, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.test' } }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial commit');
  while (!agent.isConnected) await sleep(100);
  const nora = await api('POST', '/employees', { name: 'Nora', roleKey: 'fullstack', hostId: en.hostId, workingDir: folder, model: process.env.REAL_MODEL ?? 'haiku', autonomy: 'auto' });
  const session = await api('POST', `/employees/${nora.id}/start`, {});
  await until('ready without the owner doing anything', (s) => s.sessions.find((x) => x.id === session.id && x.inTurn === false), 90000);
  const started = await api<FullState>('GET', '/state');
  check('she started in a folder Claude Code had never seen, and nobody was asked to trust it', started.questions.length === 0 && started.events.some((e) => (e.data as any)?.trust === 'auto'), started.events.find((e) => (e.data as any)?.trust === 'auto')?.summary ?? `${started.questions.length} question(s) raised`);
  check("the session runs in Claude Code's auto permission mode", started.sessions.find((x) => x.id === session.id)?.permissionMode === 'auto', String(started.sessions.find((x) => x.id === session.id)?.permissionMode));

  const msg = await api('POST', `/employees/${nora.id}/message`, { body: 'Create a file named hello.txt containing exactly the word hello, then run `ls -la` and `git status`, then commit hello.txt with git. Tell me when it is done.' });
  await until('message confirmed', (s) => s.messages.find((m) => m.id === msg.id && m.delivery.status === 'confirmed'), 90000);
  await until('turn finished', (s) => s.sessions.find((x) => x.id === session.id && x.inTurn === false), 240000);
  const afterWork = await api<FullState>('GET', '/state');
  const asked = afterWork.questions.filter((q) => q.kind === 'permission' || q.kind === 'trust_prompt');
  check('she wrote a file, ran commands and committed without one permission question', fs.existsSync(path.join(folder, 'hello.txt')) && /hello/.test(git('log', '--oneline', '-3')) && asked.length === 0, `${asked.length} permission question(s); last commit: ${git('log', '--oneline', '-1')}`);
  const tools = [...new Set((await api<any[]>('GET', `/events?employeeId=${nora.id}&limit=300`)).filter((e) => e.type === 'agent.tool_started').map((e) => String(e.data?.tool ?? '')))].filter(Boolean);
  check('the work is real tool activity reported by hooks', tools.includes('Bash') || tools.includes('Write'), tools.join(', '));

  const ask = await api('POST', `/employees/${nora.id}/message`, { body: 'I want a second file but I have not decided its name. Ask me, with the ask_boss tool, whether it should be called alpha.txt or beta.txt, then create the one I choose containing the word ok.' });
  await until('second message confirmed', (s) => s.messages.find((m) => m.id === ask.id && m.delivery.status === 'confirmed'), 90000);
  const q = await until('a real question', (s) => s.questions.find((x) => x.employeeId === nora.id && x.status === 'open' && x.channel === 'mcp_tool'), 180000);
  check('a decision that is the owner\'s to make still comes to the owner', /alpha|beta/i.test(`${q.text} ${q.options.map((o) => o.label).join(' ')}`), `"${q.text}"`);
  await api('POST', `/questions/${q.id}/answer`, { answer: 'beta.txt' });
  const end = Date.now() + 120000;
  while (!fs.existsSync(path.join(folder, 'beta.txt')) && Date.now() < end) await sleep(300);
  check('and the answer is acted on', fs.existsSync(path.join(folder, 'beta.txt')) && !fs.existsSync(path.join(folder, 'alpha.txt')));
} catch (e) {
  failed = e as Error;
  console.log(`✖ ${failed.message}`);
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
