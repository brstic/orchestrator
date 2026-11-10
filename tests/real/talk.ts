/**
 * REAL "cubicle" check — uses the actual `claude` CLI (model: haiku; one short turn).
 *
 *   node tests/real/talk.ts
 *
 * Hire someone into a folder, walk up and say something, and get their real reply back.
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
  const folder = path.join(fs.realpathSync(base), 'notes-app');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'README.md'), '# notes-app\nA tiny notes application. The secret word for this folder is PINEAPPLE.\n');
  while (!agent.isConnected) await sleep(100);
  const lena = await api('POST', '/employees', { name: 'Lena', roleKey: 'fullstack', hostId: en.hostId, workingDir: folder, model: process.env.REAL_MODEL ?? 'haiku' });
  const project = (await api<FullState>('GET', '/state')).projects.find((p) => p.id === lena.projectId);
  check('the folder became her own in-place project', project?.workspace === 'in_place' && project?.ownerEmployeeId === lena.id, `${project?.name} @ ${project?.repoPath}`);
  // Talking to someone who is not at their desk yet brings them in.
  const session = await api('POST', `/employees/${lena.id}/start`, {});
  check('her session lives in the folder itself', session.cwd === folder, session.cwd);
  const first = await until('trust prompt or start', (s) => s.questions.find((q) => q.kind === 'trust_prompt' && q.status === 'open') ?? (s.sessions.find((x) => x.id === session.id)?.lastEventAt ? 'started' : null), 60000);
  if (first !== 'started') await api('POST', `/questions/${(first as any).id}/answer`, { answer: 'Trust this folder' });
  await until('ready', (s) => s.sessions.find((x) => x.id === session.id && x.inTurn === false), 60000);
  const msg = await api('POST', `/employees/${lena.id}/message`, { body: 'Read README.md in your folder and tell me, in one short sentence, the secret word it mentions. Do not change anything.' });
  await until('message confirmed', (s) => s.messages.find((m) => m.id === msg.id && m.delivery.status === 'confirmed'), 60000);
  check('what the boss said was delivered into her real session', true, 'confirmed by UserPromptSubmit');
  await until('turn finished', (s) => s.sessions.find((x) => x.id === session.id && x.inTurn === false), 180000);
  const events = await api<any[]>('GET', `/events?employeeId=${lena.id}&limit=200`);
  const reply = events.filter((e) => e.type === 'agent.turn_finished' && e.data.lastMessage).pop();
  check("her real reply came back through Claude Code's Stop hook", !!reply && /PINEAPPLE/i.test(reply.data.lastMessage), reply ? JSON.stringify(reply.data.lastMessage).slice(0, 160) : 'no reply captured');
  check('nothing in the folder was changed', fs.readdirSync(folder).filter((f) => !f.startsWith('.')).join(',') === 'README.md');
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
