/**
 * DEVELOPMENT TOOL — a populated office for working on the UI.
 *
 * Starts a real server and a real host agent, but the "employees" run the
 * fake-claude test fixture instead of Claude Code, so the UI can be exercised
 * (terminals, questions, approvals, meetings, reviews) without spending tokens.
 * Everything else — tmux, hooks, MCP, git worktrees, verification — is real.
 *
 * This is NOT how the product runs. Use `pnpm start` for a real office.
 *
 *   node scripts/dev-office.ts [--port 4611] [--ui <folder with a built UI>] [--review both|boss|peer|none] [--member-room "Mila:3"]...
 *
 * `--review`: who reviews a finished task here when nobody chose (`OwnerSettings.reviewDefault`). This office is
 * set to `none` unless told otherwise — its scripted tasks are then done when they pass, which is what the UI tests
 * that use it count on; `--review both` shows the office as a real one starts (a colleague, then the boss).
 *
 * `--member-room "<name>:<employees>"` (may be repeated) adds a member of the office who is connected from "their
 * own computer": a second host agent in this process, enrolled as that member's personal host, with that many
 * personal employees. Their room is then attached to the office. DEV ONLY: a real member's host is started by
 * their desktop app. `kill -USR1 <pid>` disconnects/reconnects all of these hosts, `kill -USR2 <pid>` only the
 * last one — to watch rooms disappear and come back.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostAgent, enroll } from '../apps/host-agent/src/agent.ts';
import { defaultConfig, saveConfig } from '../apps/host-agent/src/config.ts';
import { startServer } from '../apps/server/src/server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 4611;
const base = fs.mkdtempSync('/tmp/orch-dev-');
// Which built UI to serve: this checkout's, unless another build is named (to compare two builds side by side).
const uiDir = process.argv.includes('--ui') ? path.resolve(process.argv[process.argv.indexOf('--ui') + 1]!) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'desktop', 'dist');
const sock = `orch-dev-${process.pid}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.test', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.test' } });

// This machine's "Claude logins" for the fixture: a home folder of its own with two accounts in it,
// so sessions have limits to report and nothing from the developer's real Claude config is read.
const home = path.join(fs.realpathSync(base), 'home');
const inSeconds = (s: number) => Math.floor(Date.now() / 1000) + s;
for (const [dir, email, org, five, week] of [[home, 'dev@example.test', 'Dev Org', 42, 85], [path.join(home, '.claude-second'), 'second@example.test', 'Second Org', 5, 10]] as const) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, organizationName: org } }));
  fs.writeFileSync(path.join(dir, 'fake-limits.json'), JSON.stringify({ five_hour: { used_percentage: five, resets_at: inSeconds(2 * 3600) }, seven_day: { used_percentage: week, resets_at: inSeconds(3 * 86400) } }));
}
process.env.HOME = home;

const wrapper = path.join(base, 'fake-claude');
fs.writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, '..', 'tests', 'fixtures', 'fake-claude.mjs')}" "$@"\n`, { mode: 0o755 });
const server = await startServer({ dataDir: path.join(base, 'server'), host: '127.0.0.1', port, quiet: true, uiDir, timings: { askBossWaitMs: 3600_000, meetingRoundMs: 600_000 } });
{
  const review = process.argv.includes('--review') ? process.argv[process.argv.indexOf('--review') + 1] : 'none';
  server.engine.core.updateSettings({ reviewDefault: (['both', 'boss', 'peer', 'none'] as const).find((r) => r === review) ?? 'none' });
}
const cfg = { ...defaultConfig(), serverUrl: server.url, name: 'dev-mac', allowedRoots: [fs.realpathSync(base)], tmuxSocketName: sock, claudeBin: wrapper, approvalWaitSeconds: 3600 };
const info = { hostname: 'dev-mac', platform: process.platform, arch: process.arch, agentVersion: 'dev', tmuxVersion: 'dev', claudeVersion: '2.1.321', cpus: 8, totalMemBytes: 16e9, user: 'dev' };
const en = await enroll(server.url, server.localEnrollToken(), 'dev-mac', info);
Object.assign(cfg, { hostId: en.hostId, credential: en.credential });
saveConfig(cfg, path.join(base, 'agent'));
const agent = new HostAgent(cfg, path.join(base, 'agent'), () => undefined);
await agent.start();
while (!agent.isConnected) await sleep(50);

const api = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(`${server.url}/api${p}`, { method, headers: { authorization: `Bearer ${server.ownerToken}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (r.status >= 400) throw new Error(`${p}: ${JSON.stringify(j)}`);
  return j;
};

const repo = path.join(fs.realpathSync(base), 'customer-platform');
fs.mkdirSync(repo);
git(repo, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'customer-platform', scripts: { test: 'node check.js' } }, null, 2));
fs.writeFileSync(path.join(repo, 'check.js'), `const fs=require('fs');for(const f of fs.readdirSync('.')){if(f.endsWith('.txt')&&fs.readFileSync(f,'utf8').includes('BROKEN')){console.error('FAIL '+f);process.exit(1)}}console.log('all checks passed');\n`);
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'initial commit');

await api('PATCH', '/settings', { companyName: 'Northwind Labs', ownerName: 'Boss' });
const project = await api('POST', '/projects', { name: 'Customer Platform', repoPath: repo, hostId: en.hostId, verifyCommand: 'npm test --silent', description: 'Customer authentication and management.', requirements: 'Customers can sign up, log in and manage their profile.' });
const team: Record<string, any> = {};
for (const [name, role, autonomy] of [['Alex', 'backend', 'standard'], ['Sarah', 'frontend', 'standard'], ['Mike', 'qa', 'standard'], ['David', 'devops', 'supervised'], ['Emma', 'security', 'standard'], ['Ava', 'architect', 'standard'], ['Rev', 'reviewer', 'restricted'], ['Noor', 'fullstack', 'autonomous']] as const) {
  team[name] = await api('POST', '/employees', { name, roleKey: role, projectId: project.id, hostId: en.hostId, autonomy });
}
await api('POST', '/employees', { name: 'Zed', roleKey: 'docs', projectId: project.id, hostId: en.hostId }); // never started: offline

const long = 'sleep 600000';
const t = (title: string, who: string, script: string, extra: Record<string, unknown> = {}) => api('POST', '/tasks', { projectId: project.id, title, assigneeId: team[who].id, description: `@@fake: ${script}@@`, acceptance: 'Checks pass.', ...extra });
await t('Implement authentication API', 'Alex', `progress routes scaffolded; write auth.txt login-v1; commit auth routes; read package.json; bash git status; write session.txt tokens; progress sessions done; ${long}`);
await t('Build the login screen', 'Sarah', `write login.txt form; commit login form; ask Should the login form remember the user's email?; ${long}`);
await t('Integration tests for auth', 'Mike', `read package.json; bash npm test --silent; progress suite is green; ${long}`, { kind: 'test' });
await t('Set up the deployment pipeline', 'David', `write pipeline.txt stages; ${long}`, { kind: 'ops' });
await t('Review authentication for vulnerabilities', 'Emma', `read package.json; mcp report_status {"status":"Auditing token handling"}; block Need access to the staging credentials vault`, { kind: 'security' });
const done = await t('Add health endpoint', 'Noor', 'write health.txt ok; commit health; complete health endpoint added');
await api('POST', '/tasks', { projectId: project.id, title: 'Password reset flow', roleHint: 'backend', description: 'Email-based reset.', priority: 'high', dependsOn: [done.id], released: false });
await api('POST', '/tasks', { projectId: project.id, title: 'Profile page', roleHint: 'frontend', description: 'Edit name and avatar.', released: false });
await api('POST', '/employees/' + team.Ava.id + '/start', {});
await api('POST', '/employees/' + team.Rev.id + '/start', {});

// ── DEV ONLY: members connected from their own computers (see the header) ──
const members: Array<{ name: string; hostId: string; socket: string; cfg: typeof cfg; home: string; agent: HostAgent | null }> = [];
const memberArgs = process.argv.flatMap((a, i) => (a === '--member-room' && process.argv[i + 1] ? [process.argv[i + 1]!] : []));
for (const [n, arg] of memberArgs.entries()) {
  const [name = `Member ${n + 1}`, count = '2'] = arg.split(':');
  const root = path.join(fs.realpathSync(base), `member-${n}`);
  fs.mkdirSync(root, { recursive: true });
  const socket = `${sock}-m${n}`;
  // ORCH_DEV_ROOM='{"desks":8,…}': how the first of these members arranged their room (as PUT /api/me/room would).
  // DEV ONLY: these members are made up here and are in nobody's list of people; the office would refuse a computer
  // that says it belongs to somebody it does not know (as it must), so this script vouches for its own.
  if (n === 0) {
    const known = server.engine.hosts.memberInGoodStanding;
    server.engine.hosts.memberInGoodStanding = (id) => id.startsWith('dev-member-') || known(id);
  }
  if (n === 0 && process.env.ORCH_DEV_ROOM) server.engine.hosts.setMemberRoom(`dev-member-${n}`, JSON.parse(process.env.ORCH_DEV_ROOM), 'dev');
  const { token } = server.engine.hosts.createMemberEnrollment({ id: `dev-member-${n}`, name });
  const enrolled = await enroll(server.url, token, `${name}'s computer`, { ...info, hostname: `${name.toLowerCase()}-laptop` });
  const memberCfg = { ...cfg, name: `${name}'s computer`, allowedRoots: [root], tmuxSocketName: socket, hostId: enrolled.hostId, credential: enrolled.credential };
  const memberHome = path.join(base, `agent-m${n}`);
  saveConfig(memberCfg, memberHome);
  const member = { name, hostId: enrolled.hostId, socket, cfg: memberCfg, home: memberHome, agent: new HostAgent(memberCfg, memberHome, () => undefined) as HostAgent | null };
  await member.agent!.start();
  while (!member.agent!.isConnected) await sleep(50);
  members.push(member);
  const own = path.join(root, 'notes');
  fs.mkdirSync(own);
  git(own, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(own, 'README.md'), `# ${name}'s notes\n`);
  git(own, 'add', '-A');
  git(own, 'commit', '-q', '-m', 'initial commit');
  const mine = await api('POST', '/projects', { name: `${name}'s notes`, repoPath: own, hostId: enrolled.hostId, description: 'A folder on a member\'s own computer.' });
  const roles = ['fullstack', 'backend', 'frontend', 'qa', 'docs', 'devops'];
  for (let i = 0; i < Number(count); i++) {
    const e = await api('POST', '/employees', { name: `${name.slice(0, 3)}-${i + 1}`, roleKey: roles[i % roles.length], projectId: mine.id, hostId: enrolled.hostId });
    // Most of them work (a live screen); every third is left without a session (asleep at the desk).
    if (i % 3 !== 2) await api('POST', '/tasks', { projectId: mine.id, title: `Notes, part ${i + 1}`, assigneeId: e.id, description: `@@fake: write part${i + 1}.txt draft; read README.md; progress outline written; ${long}@@`, acceptance: 'Written.' });
  }
}
const toggle = async (which: typeof members) => {
  for (const m of which) {
    if (m.agent) {
      await m.agent.stop().catch(() => undefined);
      m.agent = null;
    } else {
      m.agent = new HostAgent(m.cfg, m.home, () => undefined);
      await m.agent.start();
    }
  }
};
process.on('SIGUSR1', () => void toggle(members));
process.on('SIGUSR2', () => void toggle(members.slice(-1)));

console.log(JSON.stringify({ url: `${server.url}/?token=${server.ownerToken}`, base, tmux: `tmux -L ${sock} attach`, pid: process.pid, members: members.map((m) => ({ name: m.name, hostId: m.hostId })) }));
const shutdown = async () => {
  await agent.stop().catch(() => undefined);
  for (const m of members) {
    await m.agent?.stop().catch(() => undefined);
    try {
      execFileSync('tmux', ['-L', m.socket, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* none */
    }
    fs.rmSync(path.join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, m.socket), { force: true });
  }
  try {
    execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* none */
  }
  await server.close().catch(() => undefined);
  fs.rmSync(base, { recursive: true, force: true });
  // tmux leaves the socket file of a dedicated server behind.
  fs.rmSync(path.join(process.env.TMUX_TMPDIR ?? '/tmp', `tmux-${process.getuid?.() ?? 0}`, sock), { force: true });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
