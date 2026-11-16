/**
 * REAL check of the central context (`docs/CONTEXT.md`) — uses the actual `claude` CLI (model: haiku; a few short turns
 * and one /compact). Run only when the owner asks: it spends their Claude usage.
 *
 *   node tests/real/context.ts
 *
 * A fact is in the office's context before the session starts; the employee knows it without reading anything. The
 * fact changes; the employee knows the new one at the next prompt. The conversation is compacted; the context is given
 * again (seen in Claude Code's own transcript after the compaction), and the employee still knows it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FullState } from '@orchestrator/contracts';
import { HostAgent, enroll } from '../../apps/host-agent/src/agent.ts';
import { defaultConfig, saveConfig } from '../../apps/host-agent/src/config.ts';
import { startServer } from '../../apps/server/src/server.ts';

const base = fs.mkdtempSync('/tmp/orch-real-ctx-');
const sock = `orch-real-ctx-${process.pid}`;
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
    await sleep(500);
  }
}
let failed: Error | null = null;
try {
  const folder = path.join(fs.realpathSync(base), 'ctx-app');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'README.md'), '# ctx-app\nNothing about any codeword here.\n');
  while (!agent.isConnected) await sleep(100);
  const fact = await api('POST', '/context/facts', { layer: 'office', title: 'The office codeword', text: 'The codeword of this office is MARIGOLD.' });
  const lena = await api('POST', '/employees', { name: 'Lena', roleKey: 'fullstack', hostId: en.hostId, workingDir: folder, model: process.env.REAL_MODEL ?? 'haiku' });
  const session = await api('POST', `/employees/${lena.id}/start`, {});
  const first = await until('trust prompt or start', (s) => s.questions.find((q) => q.kind === 'trust_prompt' && q.status === 'open') ?? (s.sessions.find((x) => x.id === session.id)?.lastEventAt ? 'started' : null), 90000);
  if (first !== 'started') await api('POST', `/questions/${(first as any).id}/answer`, { answer: 'Trust this folder' });
  await until('ready', (s) => s.sessions.find((x) => x.id === session.id && x.inTurn === false), 90000);

  /** Ask, and the reply that comes back. */
  const ask = async (body: string) => {
    const before = (await api<any[]>('GET', `/events?employeeId=${lena.id}&limit=400`)).filter((e) => e.type === 'agent.turn_finished').length;
    await api('POST', `/employees/${lena.id}/message`, { body });
    for (const end = Date.now() + 180000; Date.now() < end; await sleep(800)) {
      const done = (await api<any[]>('GET', `/events?employeeId=${lena.id}&limit=400`)).filter((e) => e.type === 'agent.turn_finished');
      if (done.length > before) return String(done[done.length - 1].data.lastMessage ?? '');
    }
    throw new Error('no reply');
  };
  const q = 'Without reading or running anything: according to the office\'s central context, what is the codeword of this office? Answer with the word alone.';
  const a1 = await ask(q);
  check('at the start: she knows the fact from the context alone', /MARIGOLD/i.test(a1), JSON.stringify(a1.slice(0, 80)));

  await api('PATCH', `/context/facts/${fact.id}`, { text: 'The codeword of this office is SAFFRON (it was changed).' });
  await sleep(1500);
  const a2 = await ask(q);
  check('after a change: she knows the new one at her next prompt', /SAFFRON/i.test(a2), JSON.stringify(a2.slice(0, 80)));

  // A real compaction: /compact typed at her prompt, as a person would.
  const tmuxName = (await api<FullState>('GET', '/state')).sessions.find((s) => s.id === session.id)!.tmuxSession;
  execFileSync('tmux', ['-L', sock, 'send-keys', '-t', tmuxName, '/compact', 'Enter']);
  const transcriptOf = () => {
    const root = path.join(os.homedir(), '.claude', 'projects');
    const dirs = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => d.includes(path.basename(base))) : [];
    const files = dirs.flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(root, d, f)));
    return files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  };
  let after = '';
  for (const end = Date.now() + 240000; Date.now() < end; await sleep(1500)) {
    const t = transcriptOf();
    const at = t.lastIndexOf('compact_boundary');
    if (at >= 0 && t.indexOf('central context', at) > at) {
      after = t.slice(at);
      break;
    }
  }
  check('after a real compaction: the context is given again (in Claude Code\'s own transcript, after the compaction)', !!after, after ? 'seen after compact_boundary' : 'not seen');
  await until('ready after the compaction', (s) => s.sessions.find((x) => x.id === session.id && x.inTurn === false), 120000);
  const a3 = await ask(q);
  check('after the compaction: she still knows the fact', /SAFFRON/i.test(a3), JSON.stringify(a3.slice(0, 80)));
  const held = (await api<any>('GET', '/context')).sessions.find((s: any) => s.name === 'Lena');
  check('the office knows she holds the current version', !!held && held.holds === held.current, JSON.stringify(held));
} catch (e) {
  failed = e as Error;
  console.log(`✖ ${failed.message}`);
  // What was on her screen, to see why.
  try {
    for (const name of execFileSync('tmux', ['-L', sock, 'list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' }).trim().split('\n')) console.log(`--- ${name}\n${execFileSync('tmux', ['-L', sock, 'capture-pane', '-p', '-t', name], { encoding: 'utf8' }).split('\n').filter((l) => l.trim()).slice(-30).join('\n')}`);
  } catch (err) {
    console.log(`(no screen: ${(err as Error).message.split('\n')[0]})`);
  }
  try {
    const st = await api<FullState>('GET', '/state');
    console.log(JSON.stringify(st.sessions.map((x) => ({ status: x.status, activity: x.activity, detail: x.activityDetail, lastEventAt: x.lastEventAt, exitReason: x.exitReason }))));
    console.log(JSON.stringify(st.questions.map((x) => ({ kind: x.kind, status: x.status, text: x.text.slice(0, 100) }))));
  } catch {
    /* gone */
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
  fs.rmSync(path.join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, sock), { force: true });
}
const bad = checks.filter((c) => !c[1]);
console.log(`\n${checks.length - bad.length}/${checks.length} checks passed${failed ? ` — aborted: ${failed.message}` : ''}`);
process.exit(failed || bad.length ? 1 : 0);
