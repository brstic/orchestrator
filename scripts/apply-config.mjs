#!/usr/bin/env node
/**
 * Creates a project and a team from a JSON file (see examples/team.json).
 *
 *   node scripts/apply-config.mjs examples/team.json --repo ~/code/myapp [--host <name>] [--plan]
 *
 * --repo   repository the project lives in (on the chosen host)
 * --host   name of an enrolled machine (default: the first online one)
 * --plan   also hand the config's "objective" to the architect to break down
 * --server / --token  default to the local server and its owner token
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const file = args.find((a) => !a.startsWith('--') && a.endsWith('.json'));
if (!file) {
  console.error('usage: node scripts/apply-config.mjs <config.json> --repo <dir> [--host <name>] [--plan]');
  process.exit(1);
}
const server = value('--server', process.env.ORCH_SERVER_URL ?? 'http://127.0.0.1:4600').replace(/\/+$/, '');
const tokenFile = path.join(process.env.ORCH_SERVER_HOME ?? path.join(os.homedir(), '.orchestrator', 'server'), 'owner-token');
const token = value('--token', process.env.ORCH_TOKEN ?? (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : ''));
if (!token) {
  console.error('No owner token: pass --token or run this on the machine that hosts the server.');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
const api = async (method, p, body) => {
  const res = await fetch(`${server}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p}: ${json.error ?? res.status}`);
  return json;
};

const state = await api('GET', '/state');
const hostName = value('--host');
const host = hostName ? state.hosts.find((h) => h.name === hostName) : state.hosts.find((h) => h.status === 'online');
if (!host) throw new Error(hostName ? `no machine named "${hostName}"` : 'no machine is online; start a host agent first');
if (cfg.company) await api('PATCH', '/settings', cfg.company);
const repo = value('--repo');
let project = state.projects.find((p) => p.name === cfg.project.name);
if (!project) {
  if (!repo) throw new Error('--repo <dir> is required to create the project');
  project = await api('POST', '/projects', { ...cfg.project, repoPath: path.resolve(repo.replace(/^~(?=$|\/)/, os.homedir())), hostId: host.id });
  console.log(`project  ${project.name}  (${project.repoPath})`);
}
const team = {};
for (const e of cfg.employees ?? []) {
  const existing = state.employees.find((x) => x.name === e.name && !x.archived);
  team[e.name] = existing ?? (await api('POST', '/employees', { name: e.name, roleKey: e.role, autonomy: e.autonomy, style: e.style, model: e.model ?? null, instructions: e.instructions ?? '', projectId: project.id, hostId: host.id }));
  console.log(`employee ${e.name.padEnd(8)} ${team[e.name].title}${existing ? ' (already existed)' : ''}`);
}
if (args.includes('--plan') && cfg.objective) {
  const planner = Object.values(team).find((e) => e.roleKey === 'architect') ?? Object.values(team).find((e) => e.roleKey === 'pm');
  if (!planner) throw new Error('--plan needs an architect or project manager in the team');
  const task = await api('POST', `/projects/${project.id}/plan`, { objective: cfg.objective, plannerId: planner.id });
  console.log(`planning ${task.key} handed to ${planner.name}: their real session will inspect the repository and propose tasks.`);
}
console.log('Done. Open the office to watch them work.');
