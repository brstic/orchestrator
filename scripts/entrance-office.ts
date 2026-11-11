/**
 * DEVELOPMENT TOOL — a made-up office with its door open, for looking at the entrance page (the page a browser
 * gets at an office's address before anybody is signed in), for trying its sign-in by hand, and for retaking the
 * pictures that page shows (`scripts/entrance-shots.cjs`). See `docs/ENTRANCE-PAGE.md`.
 *
 * It starts `scripts/dev-office.ts` (a real server and host agent whose "employees" are the scripted stand-in, on a
 * tmux socket of its own), gives the office an invented name, opens its door on a spare port, and adds three members:
 * an owner and a colleague with passwords, and a visitor without. `--room` also connects the colleague's "own
 * computer" (a second host agent in this process, on its own tmux socket) with a few employees, so there is a
 * member's room to look at. Nothing here is a real person, company or project, and no Claude usage is spent.
 *
 *   node scripts/entrance-office.ts [--port 4790] [--door 4795] [--room] [--ui <folder with a built UI>]
 *
 * Prints one line of JSON: `door` (the page to open in a browser — its certificate is self-signed, so a browser
 * warns, and Electron needs `ignore-certificate-errors`), `owner` (the office itself, signed in as its owner, on
 * this computer only), `members` with their passwords, and `pid`. Stop it with Ctrl-C or SIGTERM: it stops what it
 * started and removes its folders.
 *
 * The door listens on every network interface of this computer, like any office's door. The passwords are printed
 * and are not secrets; do not leave this running.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { HostAgent, enroll } from '../apps/host-agent/src/agent.ts';
import { defaultConfig, saveConfig } from '../apps/host-agent/src/config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (name: string): string | null => (process.argv.includes(name) ? (process.argv[process.argv.indexOf(name) + 1] ?? null) : null);
const port = Number(arg('--port')) || 4790;
const doorPort = Number(arg('--door')) || 4795;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The invented office. */
const COMPANY = 'Paper Lantern Works';
const MEMBERS = [
  { name: 'Bea', role: 'owner', password: 'lanterns-at-midnight' },
  { name: 'Dan', role: 'colleague', password: 'a-desk-by-the-window' },
  { name: 'Vik', role: 'visitor', password: null },
] as const;

const child = spawn(process.execPath, [path.join(here, 'dev-office.ts'), '--port', String(port), ...(arg('--ui') ? ['--ui', arg('--ui')!] : [])], { stdio: ['ignore', 'pipe', 'inherit'] });
const first = await new Promise<string>((resolve, reject) => {
  readline.createInterface({ input: child.stdout! }).once('line', resolve);
  child.once('exit', (code) => reject(new Error(`the development office stopped (${code})`)));
});
const office = JSON.parse(first) as { url: string; base: string; pid: number };
const serverUrl = new URL(office.url).origin;
const ownerToken = new URL(office.url).searchParams.get('token')!;
const call = async (token: string, method: string, p: string, body?: unknown) => {
  const r = await fetch(`${serverUrl}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (r.status >= 400) throw new Error(`${method} ${p}: ${JSON.stringify(j)}`);
  return j as any;
};
const api = (method: string, p: string, body?: unknown) => call(ownerToken, method, p, body);

let member: { agent: HostAgent; socket: string } | null = null;
const shutdown = async () => {
  await member?.agent.stop().catch(() => undefined);
  if (member) {
    try {
      execFileSync('tmux', ['-L', member.socket, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* none */
    }
    fs.rmSync(path.join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, member.socket), { force: true });
  }
  // The development office stops its own agent and tmux server and removes its folder.
  child.kill('SIGTERM');
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(8000)]);
  process.exit(0);
};
// Whoever read the line this prints may have gone away since: that is a reason to stop, not to fall over.
process.stdout.on('error', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

try {
  await api('PATCH', '/settings', { companyName: COMPANY, ownerName: 'Bea' });
  // With an address of its own the office gives invitations as short links (`…/join/CODE`), as a real one does.
  await api('POST', '/sharing', { open: true, port: doorPort, address: `https://127.0.0.1:${doorPort}` });
  for (const m of MEMBERS) {
    const made = await api('POST', '/guests', { name: m.name, role: m.role });
    if (m.password) await api('POST', `/guests/${made.guest.id}/password`, { password: m.password });
  }

  if (process.argv.includes('--room')) {
    // The colleague's "own computer": enrolled the way their desktop app would, with the scripted worker.
    const dan = MEMBERS.find((m) => m.role === 'colleague')!;
    // Signed in as the colleague, the way they would be from a browser: that session asks for the enrollment.
    const signedIn = await fetch(`${serverUrl}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: dan.name, password: dan.password }) }).then((r) => r.json() as Promise<{ token?: string; error?: string }>);
    if (!signedIn.token) throw new Error(`could not sign in as ${dan.name}: ${signedIn.error}`);
    const root = path.join(fs.realpathSync(office.base), 'dan-laptop');
    fs.mkdirSync(root, { recursive: true });
    const socket = `orch-entrance-${process.pid}`;
    const { token } = await call(signedIn.token, 'POST', '/me/host');
    const info = { hostname: 'dan-laptop', platform: process.platform, arch: process.arch, agentVersion: 'dev', tmuxVersion: 'dev', claudeVersion: '2.1.321', cpus: 8, totalMemBytes: 16e9, user: 'dan' };
    const enrolled = await enroll(serverUrl, token, "Dan's computer", info);
    const cfg = { ...defaultConfig(), serverUrl, name: "Dan's computer", allowedRoots: [root], tmuxSocketName: socket, claudeBin: path.join(office.base, 'fake-claude'), approvalWaitSeconds: 3600, hostId: enrolled.hostId, credential: enrolled.credential };
    const home = path.join(office.base, 'agent-dan');
    saveConfig(cfg, home);
    const agent = new HostAgent(cfg, home, () => undefined);
    member = { agent, socket };
    await agent.start();
    while (!agent.isConnected) await sleep(50);
    const notes = path.join(root, 'field-notes');
    fs.mkdirSync(notes);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: notes, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.test', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.test' } });
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(notes, 'README.md'), '# Field notes\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'initial commit');
    const mine = await api('POST', '/projects', { name: 'Field notes', repoPath: notes, hostId: enrolled.hostId, description: "A folder on a member's own computer." });
    for (const [i, [name, role]] of ([['Juno', 'fullstack'], ['Pip', 'docs'], ['Odo', 'qa']] as const).entries()) {
      const e = await api('POST', '/employees', { name, roleKey: role, projectId: mine.id, hostId: enrolled.hostId });
      if (i < 2) await api('POST', '/tasks', { projectId: mine.id, title: `Field notes, part ${i + 1}`, assigneeId: e.id, description: `@@fake: write part${i + 1}.txt draft; read README.md; progress outline written; sleep 600000@@`, acceptance: 'Written.' });
    }
  }

  console.log(JSON.stringify({ door: `https://127.0.0.1:${doorPort}/`, owner: office.url, company: COMPANY, members: MEMBERS.map(({ name, role, password }) => ({ name, role, password })), pid: process.pid }));
} catch (e) {
  console.error(String((e as Error).message));
  await shutdown();
}
