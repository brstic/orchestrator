/**
 * "My server" is linked to the office over SSH. The office runs here on loopback only; the
 * server is a container that can be reached only through its sshd. Started by run-ssh.sh.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { FullState } from '@orchestrator/contracts';
import { startServer } from '../../apps/server/src/server.ts';

const [tmp, container] = process.argv.slice(2) as [string, string];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const checks: boolean[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  checks.push(ok);
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const onServer = (cmd: string, user = 'dev') => execFileSync('docker', ['exec', '-u', user, container, 'sh', '-lc', cmd], { encoding: 'utf8' }).trim();

const server = await startServer({ dataDir: path.join(tmp, 'office'), host: '127.0.0.1', port: 0, quiet: true, timings: { resourceIntervalMs: 2000 } as any });
const raw = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`${server.url}/api${p}`, { method, headers: { authorization: `Bearer ${server.ownerToken}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const api = async <T = any>(method: string, p: string, body?: unknown): Promise<T> => {
  const r = await raw(method, p, body);
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status}: ${JSON.stringify(r.body)}`);
  return r.body as T;
};
const state = () => api<FullState>('GET', '/state');
const until = async <T>(label: string, fn: () => Promise<T | null | undefined | false>, ms = 60000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(300);
  }
};
const link = async () => (await api<any[]>('GET', '/ssh-links'))[0];

let exit = 1;
try {
  // Things already running on the server before the office knows about it:
  // a Claude Code session inside tmux, and one in a plain terminal (no tmux).
  onServer('mkdir -p ~/shop ~/blog && cd ~/shop && git init -q -b main . && git -c user.name=Dev -c user.email=dev@example.test commit -q --allow-empty -m init');
  onServer('cd ~/shop && tmux new-session -d -s shop-claude -x 160 -y 45 claude');
  onServer('tmux new-session -d -s keeper "sleep 100000"');
  const keeperPid = onServer("tmux list-panes -t keeper -F '#{pane_pid}'");
  onServer('cd ~/blog && (setsid sh -c "sleep 100000 | claude" >/dev/null 2>&1 &)');
  const tmuxClaudePid = onServer("tmux list-panes -t shop-claude -F '#{pane_pid}'");

  // 1. An unknown server is not trusted silently.
  const unknown = await raw('POST', '/ssh-links/probe', { target: 'my-server' });
  check('a server this computer has never seen is not connected to silently', unknown.status >= 400 && /never connected to my-server before/.test(unknown.body?.error ?? ''), String(unknown.body?.error ?? '').slice(0, 90));
  check('nonsense that could be read as an ssh option is refused', (await raw('POST', '/ssh-links/probe', { target: '-oProxyCommand=touch /tmp/x' })).status >= 400 && (await raw('POST', '/ssh-links', { target: 'a b; rm -rf /' })).status >= 400);

  // 2. Looking at the server changes nothing on it.
  const probe = await api<any>('POST', '/ssh-links/probe', { target: 'my-server', trustNewHost: true });
  check('the check reports what is on the server', probe.os === 'Linux' && /^v22\./.test(probe.node) && /^tmux /.test(probe.tmux) && !!probe.claude && probe.user === 'dev' && probe.problems.length === 0, `${probe.os} ${probe.arch}, node ${probe.node}, ${probe.tmux}, claude "${probe.claude}"`);
  check('it sees that Claude Code is already running there', probe.tmuxSessions === 2 && probe.claudeProcesses >= 1, `${probe.tmuxSessions} tmux sessions, ${probe.claudeProcesses} claude processes`);
  check('checking installed nothing', onServer('ls -a ~ | grep -c orchestrator || true') === '0');

  // 3. Linking it: agent copied over SSH, reverse tunnel, enrolment — one request.
  const created = await api<any>('POST', '/ssh-links', { target: 'my-server', name: 'My Server', trustNewHost: true });
  check('the link is created and starts connecting', created.status === 'connecting' && created.name === 'My Server');
  const up = await until('link connected', async () => { const l = await link(); if (l.status === 'error') throw new Error(l.error); return l.status === 'connected' ? l : null; }, 90000).catch(async (e) => { throw new Error(`${e.message}: ${JSON.stringify(await link())}`); });
  const host = (await state()).hosts.find((h) => h.id === up.hostId)!;
  check('the server is a machine of the office, online', host?.status === 'online' && host.name === 'My Server' && host.info?.platform === 'linux' && host.local === false, `${host?.name}: ${host?.info?.platform}/${host?.info?.arch}, claude ${host?.info?.claudeVersion}`);
  const listening = onServer(`ss -ltn | awk '{print $4}' | grep ':${up.remotePort}$' || true`);
  check("the office's port exists on the server only on its loopback interface", listening === `127.0.0.1:${up.remotePort}`, listening);
  const cfg = JSON.parse(onServer(`cat ~/.orchestrator/links/${up.id}/config.json`));
  check('the agent on the server reaches the office through the tunnel, with its own credential', cfg.serverUrl === `http://127.0.0.1:${up.remotePort}` && /^orch_host_/.test(cfg.credential) && cfg.hostId === up.hostId && onServer(`stat -c %a ~/.orchestrator/links/${up.id}/config.json`) === '600');
  const audit = await api<any[]>('GET', '/audit');
  check('linking and enrolment are in the audit log', audit.some((a) => a.action === 'ssh_link.created') && audit.some((a) => a.action === 'host.enrolled') && audit.some((a) => a.action === 'ssh_link.connected'));

  // 4. The Claude Code that was already running in tmux becomes an employee, without being restarted.
  const found = await api<any>('GET', `/hosts/${host.id}/discover`);
  const pane = found.panes.find((p: any) => p.tmuxSession === 'shop-claude');
  check('the running tmux session is found on the server', !!pane && pane.looksLikeClaude === true && pane.cwd === '/home/dev/shop', `${pane?.tmuxSession} in ${pane?.cwd}`);
  const adopted = await api<any>('POST', '/employees', { name: 'Shopkeeper', roleKey: 'backend', hostId: host.id, workingDir: '/home/dev/shop' });
  const attached = await api<any>('POST', '/sessions/attach', { hostId: host.id, tmuxSession: 'shop-claude', employeeId: adopted.id });
  await until('attached session running', async () => (await state()).sessions.find((s) => s.id === attached.id && s.status === 'running'));
  check('it is attached as it is: same process, not restarted', onServer("tmux list-panes -t shop-claude -F '#{pane_pid}'") === tmuxClaudePid && attached.origin === 'attached', `pid ${tmuxClaudePid}`);

  // 5. The one outside tmux cannot be taken over — the office says where it runs, and can continue its conversation.
  const procs = (await api<any>('GET', `/hosts/${host.id}/claude-processes`)).processes;
  check('a Claude Code running outside tmux is listed with its folder (and the tmux one is not)', procs.length === 1 && procs[0].cwd === '/home/dev/blog', JSON.stringify(procs.map((p: any) => `${p.pid} in ${p.cwd}`)));
  const blogger = await api<any>('POST', '/employees', { name: 'Blogger', roleKey: 'docs', hostId: host.id, workingDir: '/home/dev/blog', autonomy: 'auto' });
  const started = await api<any>('POST', `/employees/${blogger.id}/start`, { continueLast: true });
  const running = await until('Blogger running', async () => (await state()).sessions.find((s) => s.id === started.id && s.status === 'running' && s.inTurn === false));
  check('an employee started in that folder continues its last conversation', /--continue/.test(onServer(`tmux display-message -p -t '${running.tmuxPane}' '#{pane_start_command}'`)) && running.cwd === '/home/dev/blog');

  // 6. Real work on the server, and the worker's own line to the office goes through the tunnel too.
  await api('POST', `/employees/${blogger.id}/message`, { body: 'Write the post. @@fake: write post.md hello-from-the-server; mcp report_status {"status":"post written on the server"}; say done-on-server@@' });
  await until('file written on the server', async () => onServer('cat ~/blog/post.md 2>/dev/null || true') === 'hello-from-the-server');
  const reported = await until('status report through the tunnel', async () => (await api<any[]>('GET', `/events?employeeId=${blogger.id}&limit=200`)).find((e) => e.type === 'agent.status_report'));
  check('the employee worked on the server and reported back through the tunnel', /post written on the server/.test(JSON.stringify(reported)), 'post.md written; report_status reached the office');
  const mcp = JSON.parse(onServer(`cat ~/.orchestrator/links/${up.id}/sessions/${started.id}/mcp.json`));
  const mcpUrl = mcp?.mcpServers?.orchestrator?.url ?? '';
  check("the worker's MCP address is the server's end of the tunnel, not this computer's", mcpUrl === `http://127.0.0.1:${up.remotePort}/mcp`, mcpUrl);
  const docs = await api<any>('GET', `/employees/${blogger.id}/docs`);
  check('their documents are readable from the office', docs.files.some((f: any) => f.path === 'post.md'));

  // 7. The connection drops (the tunnel's ssh dies): it comes back on its own, nothing on the server restarted.
  const agentPid = onServer(`cat ~/.orchestrator/links/${up.id}/agent.pid`);
  const workerPid = onServer(`tmux display-message -p -t '${running.tmuxPane}' '#{pane_pid}'`);
  execFileSync('sh', ['-c', `pkill -f -- "-R 127.0.0.1:${up.remotePort}:127.0.0.1:" || true`]);
  await until('host offline', async () => (await state()).hosts.find((h) => h.id === host.id)?.status === 'offline', 30000);
  check('when the tunnel dies the office shows the server offline', true);
  const back = await until('link reconnected', async () => { const l = await link(); return l.status === 'connected' && (await state()).hosts.find((h) => h.id === host.id)?.status === 'online' ? l : null; }, 90000);
  check('it reconnects by itself; the agent and the sessions were never restarted', onServer(`cat ~/.orchestrator/links/${back.id}/agent.pid`) === agentPid && onServer(`tmux display-message -p -t '${running.tmuxPane}' '#{pane_pid}'`) === workerPid, `agent pid ${agentPid}, worker pid ${workerPid}`);
  await api('POST', `/employees/${blogger.id}/message`, { body: 'Again. @@fake: write second.md after-reconnect; say again-done@@' });
  await until('work after reconnect', async () => onServer('cat ~/blog/second.md 2>/dev/null || true') === 'after-reconnect');
  check('work continues after the reconnect', true);

  // 8. Disconnect on purpose, connect again.
  await api('POST', `/ssh-links/${up.id}/disconnect`, {});
  await until('offline after disconnect', async () => (await state()).hosts.find((h) => h.id === host.id)?.status === 'offline', 30000);
  await sleep(4000);
  check('a disconnected link stays disconnected, and the server keeps running its sessions', (await link()).status === 'idle' && onServer(`tmux display-message -p -t '${running.tmuxPane}' '#{pane_pid}'`) === workerPid);
  await api('POST', `/ssh-links/${up.id}/connect`, {});
  await until('online after connect', async () => (await link()).status === 'connected' && (await state()).hosts.find((h) => h.id === host.id)?.status === 'online', 90000);
  check('connecting again brings the same machine back', (await state()).sessions.find((s) => s.id === started.id)?.status === 'running');

  // 9. The attached session is terminal-only; on the owner's word it becomes a full employee.
  const before = (await state()).sessions.find((s) => s.id === attached.id)!;
  check('an attached session is honest about being terminal-only', before.capabilities?.hooks === false && before.capabilities?.terminal === true, JSON.stringify(before.capabilities));
  const adoptedSession = await api<any>('POST', `/sessions/${attached.id}/adopt`, {});
  const full = await until('Shopkeeper running under the office', async () => (await state()).sessions.find((s) => s.id === adoptedSession.id && s.status === 'running' && s.inTurn === false));
  check('Claude Code there exited by its own /exit and was started again by the office, continuing the conversation in the same folder', full.origin === 'managed' && full.cwd === '/home/dev/shop' && /--continue/.test(onServer(`tmux display-message -p -t '${full.tmuxPane}' '#{pane_start_command}'`)) && onServer('tmux has-session -t shop-claude 2>/dev/null && echo yes || echo no') === 'no', `${full.tmuxSession} in ${full.cwd}`);
  await api('POST', `/employees/${adopted.id}/message`, { body: 'Now you can report. @@fake: write shop.txt full-employee; say now-a-full-employee@@' });
  await until('full employee reports its turn', async () => (await api<any[]>('GET', `/events?employeeId=${adopted.id}&limit=200`)).find((e) => e.type === 'agent.turn_finished' && /now-a-full-employee/.test(e.data.lastMessage ?? '')));
  check('as a full employee it reports what it does', onServer('cat ~/shop/shop.txt') === 'full-employee' && (await state()).sessions.find((s) => s.id === adoptedSession.id)?.capabilities?.hooks === true);

  // 10. Removing the link cleans up and revokes.
  const removed = await api<any>('DELETE', `/ssh-links/${up.id}`);
  const after = await state();
  check('removing the link stops the agent, deletes its folder on the server and revokes the machine', removed.cleaned === true && onServer(`ls ~/.orchestrator/links/ | wc -l`) === '0' && after.hosts.find((h) => h.id === host.id)?.status === 'revoked' && (await api<any[]>('GET', '/ssh-links')).length === 0);
  check('tmux sessions on the server are left alone', onServer("tmux list-panes -t keeper -F '#{pane_pid}'") === keeperPid && onServer('tmux list-sessions | wc -l') === '3', onServer('tmux list-sessions -F "#{session_name}" | tr "\\n" " "'));
  const cred = cfg.credential as string;
  const refused: any = await new Promise((resolve) => {
    const ws = new WebSocket(`${server.url.replace('http', 'ws')}/ws/agent`);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, hostId: host.id, credential: cred, name: 'My Server', info: { hostname: 'x' } }));
    ws.onmessage = (ev) => resolve(JSON.parse(String(ev.data)));
    ws.onerror = () => resolve({ t: 'error' });
  });
  check('its old credential no longer works', refused.t === 'rejected', refused.reason ?? '');
  exit = checks.every(Boolean) ? 0 : 1;
} catch (e) {
  console.log(`✖ ${(e as Error).message}`);
  try {
    console.log(JSON.stringify(await link().catch(() => null)));
    console.log(onServer('ss -ltnp 2>/dev/null | head -12; ps -eo pid,etime,args | grep -E "sshd|orchestrator" | grep -v grep | head -12'));
    console.log(onServer('tail -n 15 ~/.orchestrator/links/*/agent.log 2>/dev/null || true'));
  } catch {
    /* the container may be gone */
  }
} finally {
  await server.close();
}
console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(exit);
