/**
 * THE PUBLIC DEMO OFFICE — a showcase anybody can walk into (office-demo.sparkcan.com, `docs/DEMO.md`).
 *
 * A real server and a real host agent — tmux, hooks, MCP, git worktrees, verification, merges are all real — but the
 * "employees" run the scripted stand-in (`tests/fixtures/fake-claude.mjs`) instead of Claude Code: no Claude account is
 * used and nothing is spent. The office is a showcase (`ServerOptions.showcase`): whoever opens its address is let in
 * at once as a visitor who only watches, and every page of it says the employees are scripted.
 *
 * A director keeps it busy: it hands the idle employees tasks from a list (each a script of steps — reading, writing,
 * running the tests, committing, now and then a question, a blocker or a failed check that is fixed), answers their
 * questions and requests after a while the way an owner would, and unblocks what is blocked. Each start is a fresh
 * office: what the folder held is wiped first. It stops by itself at 04:00 UTC so that whatever runs it (systemd,
 * `Restart=always`) starts it again clean.
 *
 *   node demo-office.mjs [--home <folder>] [--port 4620] [--door 4621] [--address https://office-demo.example.com]
 *
 * Bundled into the portable package as `apps/server/dist/orchestrator-demo.mjs` (`scripts/build.mjs`), with the
 * stand-in beside it in `demo/fake-claude.mjs`. The office itself listens on 127.0.0.1 only; its door (TLS) on every
 * interface, like any office's door — on the server only nginx reaches it, through 127.0.0.1.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostAgent, enroll } from '../apps/host-agent/src/agent.ts';
import { defaultConfig, saveConfig } from '../apps/host-agent/src/config.ts';
import { startServer } from '../apps/server/src/server.ts';

const arg = (name: string): string | null => (process.argv.includes(name) ? (process.argv[process.argv.indexOf(name) + 1] ?? null) : null);
const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(arg('--port')) || 4620;
const doorPort = Number(arg('--door')) || 4621;
const address = arg('--address');
const base = path.resolve(arg('--home') ?? process.env.ORCH_DEMO_HOME ?? path.join(os.homedir(), '.orchestrator-demo'));
const sock = 'orch-demo';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);
/** Where a file of the repository or of the package is: beside this one (the package) or in the checkout. */
const find = (...candidates: string[]): string => {
  const hit = candidates.map((c) => path.resolve(here, c)).find((p) => fs.existsSync(p));
  if (!hit) throw new Error(`not found: ${candidates.join(' or ')}`);
  return hit;
};
const fake = find('../../../demo/fake-claude.mjs', '../tests/fixtures/fake-claude.mjs');
const uiDir = find('../../desktop/dist', '../apps/desktop/dist');
const env = { ...process.env, GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.test', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.test' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', env });

// ── a fresh office every time ──
for (const socket of [sock, `${sock}-m0`, `${sock}-m1`]) {
  try {
    execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* none running */
  }
}
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true, mode: 0o700 });
const root = fs.realpathSync(base);

// The stand-in's own "Claude login" (a made-up account with made-up limits): nothing of a real one is read.
const home = path.join(root, 'home');
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'demo@example.test', organizationName: 'Demo' } }));
fs.writeFileSync(path.join(home, 'fake-limits.json'), JSON.stringify({ five_hour: { used_percentage: 18, resets_at: Math.floor(Date.now() / 1000) + 3 * 3600 }, seven_day: { used_percentage: 34, resets_at: Math.floor(Date.now() / 1000) + 4 * 86400 } }));
process.env.HOME = home;
// The stand-in runs only scripts signed with this start's own key (`ORCH_FAKE_KEY`): the director's. What anybody who
// walked in writes — a message, a task, keys typed into a terminal — is never run; it gets harmless stand-in work.
const KEY = crypto.randomBytes(12).toString('hex');
const wrapper = path.join(root, 'claude');
fs.writeFileSync(wrapper, `#!/bin/sh\nORCH_FAKE_KEY=${KEY} exec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o700 });
const FAKE = `@@fake#${KEY}:`;
const RETRY = `@@fake-retry#${KEY}:`;

const server = await startServer({ dataDir: path.join(root, 'server'), host: '127.0.0.1', port, quiet: true, uiDir, showcase: true, memoryBin: null, timings: { askBossWaitMs: 3600_000, meetingRoundMs: 600_000 } });
const cfg = { ...defaultConfig(), serverUrl: server.url, name: 'demo-server', allowedRoots: [root], tmuxSocketName: sock, claudeBin: wrapper, approvalWaitSeconds: 3600 };
const info = { hostname: 'demo-server', platform: process.platform, arch: process.arch, agentVersion: 'demo', tmuxVersion: 'demo', claudeVersion: '2.1.321', cpus: os.cpus().length, totalMemBytes: os.totalmem(), user: 'demo' };
const en = await enroll(server.url, server.localEnrollToken(), 'demo-server', info);
Object.assign(cfg, { hostId: en.hostId, credential: en.credential });
saveConfig(cfg, path.join(root, 'agent'));
const agent = new HostAgent(cfg, path.join(root, 'agent'), () => undefined);
await agent.start();
while (!agent.isConnected) await sleep(50);

const api = async <T = any>(method: string, p: string, body?: unknown): Promise<T> => {
  const r = await fetch(`${server.url}/api${p}`, { method, headers: { authorization: `Bearer ${server.ownerToken}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (r.status >= 400) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j as T;
};

// ── the company ──
await api('PATCH', '/settings', { companyName: 'Orchestrator Demo', ownerName: 'Boss', surroundings: 'skyline', reviewDefault: 'none' });
await api('POST', '/sharing', { open: true, port: doorPort, ...(address ? { address } : {}) });

/** A small repository whose test fails while any .txt file says BROKEN — the office's verification runs it. */
function repository(name: string, readme: string): string {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), readme);
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name, private: true, scripts: { test: 'node check.js' } }, null, 2));
  fs.writeFileSync(path.join(repo, 'check.js'), `const fs=require('fs');for(const f of fs.readdirSync('.')){if(f.endsWith('.txt')&&fs.readFileSync(f,'utf8').includes('BROKEN')){console.error('FAIL '+f);process.exit(1)}}console.log('all checks passed');\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial commit');
  return repo;
}
const projects = {
  shop: await api('POST', '/projects', { name: 'Storefront', repoPath: repository('storefront', '# Storefront\nThe online shop: catalogue, cart, checkout.\n'), hostId: en.hostId, verifyCommand: 'npm test --silent', description: 'The online shop: catalogue, cart and checkout.', requirements: 'Customers find products, fill a cart and pay.' }),
  api: await api('POST', '/projects', { name: 'Mobile API', repoPath: repository('mobile-api', '# Mobile API\nWhat the phone app talks to.\n'), hostId: en.hostId, verifyCommand: 'npm test --silent', description: 'The API the mobile app talks to.', requirements: 'Sign-in, orders, notifications.' }),
};
const roster: Array<[string, string, keyof typeof projects]> = [
  ['Ava', 'architect', 'shop'],
  ['Alex', 'backend', 'shop'],
  ['Sarah', 'frontend', 'shop'],
  ['Mike', 'qa', 'shop'],
  ['Noor', 'fullstack', 'shop'],
  ['Emma', 'security', 'api'],
  ['David', 'devops', 'api'],
  ['Liam', 'backend', 'api'],
  ['Zoe', 'frontend', 'api'],
  ['Rev', 'reviewer', 'api'],
];
const team: Array<{ id: string; name: string; role: string; projectId: string }> = [];
for (const [name, roleKey, project] of roster) {
  const e = await api('POST', '/employees', { name, roleKey, projectId: projects[project].id, hostId: en.hostId, autonomy: 'auto' });
  team.push({ id: e.id, name, role: roleKey, projectId: projects[project].id });
}

// ── colleagues who came in with their own computers: a room each, with employees of their own ──
// (As a member's desktop app does: a second host agent, enrolled as that member's own computer.)
const memberAgents: HostAgent[] = [];
for (const [n, [name, role, people]] of ([['Mila', 'colleague', [['Mi-1', 'frontend'], ['Mi-2', 'qa'], ['Mi-3', 'backend']]], ['Vuk', 'owner', [['Vu-1', 'fullstack'], ['Vu-2', 'devops']]]] as const).entries()) {
  const invited = await api('POST', '/guests', { name, role });
  const memberId: string = invited.guest.id;
  const mroot = path.join(root, `member-${n}`);
  fs.mkdirSync(mroot, { recursive: true });
  const { token } = server.engine.hosts.createMemberEnrollment({ id: memberId, name });
  const enrolled = await enroll(server.url, token, `${name}'s computer`, { ...info, hostname: `${name.toLowerCase()}-laptop` });
  const mcfg = { ...cfg, name: `${name}'s computer`, allowedRoots: [mroot], tmuxSocketName: `${sock}-m${n}`, hostId: enrolled.hostId, credential: enrolled.credential };
  const mhome = path.join(root, `agent-m${n}`);
  saveConfig(mcfg, mhome);
  const magent = new HostAgent(mcfg, mhome, () => undefined);
  await magent.start();
  while (!magent.isConnected) await sleep(50);
  memberAgents.push(magent);
  const own = path.join(mroot, 'side-project');
  fs.mkdirSync(own);
  git(own, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(own, 'README.md'), `# ${name}'s side project\n`);
  fs.writeFileSync(path.join(own, 'package.json'), JSON.stringify({ name: 'side-project', private: true, scripts: { test: 'node -e "console.log(\'ok\')"' } }, null, 2));
  git(own, 'add', '-A');
  git(own, 'commit', '-q', '-m', 'initial commit');
  const mine = await api('POST', '/projects', { name: `${name}'s side project`, repoPath: own, hostId: enrolled.hostId, verifyCommand: 'npm test --silent', description: `A project on ${name}'s own computer.` });
  for (const [pname, prole] of people) {
    const e = await api('POST', '/employees', { name: pname, roleKey: prole, projectId: mine.id, hostId: enrolled.hostId, autonomy: 'auto' });
    team.push({ id: e.id, name: pname, role: prole, projectId: mine.id });
  }
}
// Two who keep to Standard: their commands wait for an approval (which the director gives, a little later).
for (const e of team.filter((x) => x.name === 'David' || x.name === 'Mike')) await api('PATCH', `/employees/${e.id}`, { autonomy: 'standard' });
log(`demo office up: ${server.url} (door ${doorPort}), ${team.length} employees`);

// ── what they do: tasks as scripts of steps ──
const pause = () => `sleep ${6000 + Math.floor(Math.random() * 9000)}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 28);
interface Plan {
  title: string;
  kind?: string;
  steps: (file: string) => string;
  retry?: (file: string) => string;
}
const ORDINARY: Record<string, string[]> = {
  backend: ['Add pagination to the orders endpoint', 'Cache product prices for an hour', 'Rate-limit the sign-in endpoint', 'Send the order confirmation email', 'Validate addresses on checkout', 'Add a health check endpoint', 'Store refresh tokens hashed'],
  frontend: ['Build the cart drawer', 'Product page: image gallery', 'Empty states for the order list', 'Dark mode for the account pages', 'Skeleton loading for search results', 'Accessible labels on the checkout form'],
  qa: ['Integration tests for checkout', 'Regression suite for sign-in', 'Test refunds end to end', 'Load test the search endpoint'],
  fullstack: ['Wishlist: save for later', 'Coupon codes at checkout', 'Order tracking page', 'Newsletter sign-up with double opt-in'],
  security: ['Audit token handling', 'Check the uploads for path traversal', 'Review the CORS settings', 'Rotate the signing keys'],
  devops: ['Nightly database backup', 'Zero-downtime deploys', 'Alert when the error rate rises', 'Cache the build in CI'],
  architect: ['Plan the move to event-driven orders', 'Write the API versioning guideline', 'Split the catalogue service'],
  reviewer: ['Review the payment module', 'Review the session handling', 'Review the search ranking change'],
};
function planFor(role: string): Plan {
  const titles = ORDINARY[role] ?? ORDINARY.backend!;
  const title = titles[Math.floor(Math.random() * titles.length)]!;
  const r = Math.random();
  const progress = ['looked at how it is done now', 'first part works', 'wiring it up', 'tests written', 'cleaning up'];
  const p = () => progress[Math.floor(Math.random() * progress.length)];
  // Most: read, write, test, commit, done. Some ask the boss first; some hit a failing check and fix it; a few are blocked.
  if (r < 0.14)
    return {
      title,
      steps: (f) => `read README.md; ${pause()}; ask Should ${title.toLowerCase()} ship behind a feature flag?; write ${f}.txt ${title}; bash npm test --silent; commit ${title}; ${pause()}; complete ${title} — done`,
    };
  if (r < 0.24)
    return {
      title,
      steps: (f) => `read package.json; ${pause()}; write ${f}.txt ${title} BROKEN first draft; progress ${p()}; ${pause()}; commit ${title} (first draft); complete ${title}`,
      retry: (f) => `read ${f}.txt; ${pause()}; write ${f}.txt ${title} — fixed; bash npm test --silent; commit Fix ${title.toLowerCase()}; complete ${title}, fixed after the failed check`,
    };
  if (r < 0.29) return { title, steps: () => `read README.md; ${pause()}; mcp report_status {"status":"Waiting for access"}; block Need access to the staging environment` };
  return {
    title,
    steps: (f) => `read README.md; ${pause()}; progress ${p()}; write ${f}.txt ${title}; ${pause()}; bash npm test --silent; progress ${p()}; ${pause()}; commit ${title}; complete ${title}`,
  };
}

// ── the director ──
const busyWith = new Map<string, { taskId: string; since: number }>();
const restUntil = new Map<string, number>();
const seenQuestion = new Map<string, number>();
const blockedSince = new Map<string, number>();
const stuckRestart = new Map<string, number>();
const ANSWERS = ['Yes — go ahead.', 'Keep it simple, ship it.', 'Behind a flag, please.', 'Good question: yes, do that.'];
async function tick(): Promise<void> {
  const state = await api<any>('GET', '/state');
  const now = Date.now();
  const tasks = new Map<string, any>(state.tasks.map((t: any) => [t.id, t]));
  // Questions and requests: answered after a while, as the boss would.
  for (const q of state.questions as any[]) {
    if (q.status !== 'open') continue;
    const first = seenQuestion.get(q.id) ?? now;
    seenQuestion.set(q.id, first);
    if (now - first < 20_000 + Math.random() * 20_000) continue;
    const decision = q.kind === 'permission' || q.kind === 'approval';
    await api('POST', `/questions/${q.id}/answer`, decision ? { decision: 'allow' } : q.options?.length ? { answer: q.options[0].label ?? q.options[0].id } : { answer: ANSWERS[Math.floor(Math.random() * ANSWERS.length)] }).catch((e) => log(`answer: ${(e as Error).message}`));
  }
  // What is blocked is unblocked after a minute or so.
  for (const t of state.tasks as any[]) {
    if (t.status !== 'BLOCKED') {
      blockedSince.delete(t.id);
      continue;
    }
    const since = blockedSince.get(t.id) ?? now;
    blockedSince.set(t.id, since);
    if (now - since > 70_000) {
      await api('POST', `/tasks/${t.id}/unblock`, { note: 'Access granted — carry on.' }).catch(() => undefined);
      blockedSince.delete(t.id);
    }
  }
  // A session that never got going (the stand-in starts in no time, and its first hook can come before its machine
  // knows the session): started again — once a few minutes have shown it is stuck.
  const sessionOf = new Map<string, any>(state.sessions.filter((x: any) => x.status === 'running' || x.status === 'starting').map((x: any) => [x.employeeId, x]));
  for (const e of team) {
    const cur = busyWith.get(e.id);
    const x = sessionOf.get(e.id);
    if (!cur || !x || x.activity !== 'unknown' || now - cur.since < 3 * 60_000 || (stuckRestart.get(e.id) ?? 0) > now - 5 * 60_000) continue;
    stuckRestart.set(e.id, now);
    log(`${e.name}: the session never got going; starting it again`);
    await api('POST', `/employees/${e.id}/stop`, {}).catch(() => undefined);
    await sleep(3000);
    await api('POST', `/employees/${e.id}/start`, {}).catch(() => undefined);
  }
  // Work for whoever is free (after a short rest), most of the team at work at any time — handed out a couple at a
  // time, so that the sessions do not all start in the same second.
  let handed = 0;
  for (const e of team) {
    const cur = busyWith.get(e.id);
    if (cur) {
      const t = tasks.get(cur.taskId);
      const finished = !t || t.status === 'DONE' || now - cur.since > 20 * 60_000;
      if (!finished) continue;
      busyWith.delete(e.id);
      restUntil.set(e.id, now + 15_000 + Math.random() * 60_000);
      continue;
    }
    if ((restUntil.get(e.id) ?? 0) > now || handed >= 2) continue;
    if (Math.random() < 0.25) {
      restUntil.set(e.id, now + 30_000);
      continue;
    }
    const plan = planFor(e.role);
    const file = `${slug(plan.title)}-${Math.floor(Math.random() * 1000)}`;
    const description = `${FAKE} ${plan.steps(file)}@@${plan.retry ? `\n${RETRY} ${plan.retry(file)}@@` : ''}`;
    try {
      const t = await api('POST', '/tasks', { projectId: e.projectId, title: plan.title, assigneeId: e.id, description, acceptance: 'The checks pass.' });
      busyWith.set(e.id, { taskId: t.id, since: now });
      handed++;
    } catch (err) {
      log(`task for ${e.name}: ${(err as Error).message}`);
      restUntil.set(e.id, now + 60_000);
    }
  }
}
let ticking = false;
const director = setInterval(() => {
  if (ticking) return;
  ticking = true;
  tick()
    .catch((e) => log(`director: ${(e as Error).message}`))
    .finally(() => (ticking = false));
}, 8000);

// ── a fresh start every night ──
const nextFour = new Date();
nextFour.setUTCHours(4, 0, 0, 0);
if (nextFour.getTime() <= Date.now()) nextFour.setUTCDate(nextFour.getUTCDate() + 1);
const nightly = setTimeout(() => {
  log('04:00 UTC: stopping for a fresh start');
  void shutdown(0);
}, nextFour.getTime() - Date.now());

async function shutdown(code = 0): Promise<void> {
  clearInterval(director);
  clearTimeout(nightly);
  await agent.stop().catch(() => undefined);
  for (const a of memberAgents) await a.stop().catch(() => undefined);
  for (const socket of [sock, `${sock}-m0`, `${sock}-m1`]) {
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* none */
    }
  }
  await server.close().catch(() => undefined);
  process.exit(code);
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
