#!/usr/bin/env node
/**
 * Running an office from a terminal on the machine it lives on:  pnpm office <command>
 *
 *   status                               is it open, at which addresses, who is a member
 *   open [--port 4610] [--address <url>] open the door to members (TLS) and remember it
 *   close                                close it
 *   invite <name> [--role owner|colleague|visitor]   make an invitation (printed once)
 *   reinvite <name>                      a new invitation for a member; the old one stops working
 *   role <name> <role>                   change what a member may do
 *   revoke <name>                        take a member's access away
 *   service [--door 4610] [--address <url>]   print a systemd unit that keeps the office running (Linux)
 *
 * It speaks to the office on this machine with the office's own owner token, which never leaves
 * this machine. That is how the first owner gets in: `pnpm office invite Ana --role owner`.
 *
 *   --port-local <n>   the office's local port (default 4600, or ORCH_PORT)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const command = args[0];
const positional = [];
const opts = {};
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--')) opts[args[i].slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
  else positional.push(args[i]);
}
const die = (msg) => {
  console.error(msg);
  process.exit(1);
};
const ROLES = ['owner', 'colleague', 'visitor'];
const WHAT = { owner: 'runs the office: everything', colleague: 'works on everything shared, and on their own computer', visitor: 'looks; changes nothing' };

const serverHome = process.env.ORCH_SERVER_HOME ?? path.join(os.homedir(), '.orchestrator', 'server');
const base = `http://127.0.0.1:${opts['port-local'] ?? process.env.ORCH_PORT ?? 4600}`;

async function api(method, route, body) {
  let token;
  try {
    token = fs.readFileSync(path.join(serverHome, 'owner-token'), 'utf8').trim();
  } catch {
    die(`No office has been started on this machine yet (no ${path.join(serverHome, 'owner-token')}). Start one with: pnpm serve`);
  }
  let res;
  try {
    res = await fetch(`${base}/api${route}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch {
    die(`The office is not running on this machine (${base}). Start it with: pnpm serve`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) die(json.error ?? `the office answered ${res.status}`);
  return json;
}

const member = async (name) => {
  if (!name) die('Which member? Give their name.');
  const { guests } = await api('GET', '/sharing');
  const found = guests.filter((g) => !g.revokedAt && g.name.toLowerCase() === String(name).toLowerCase());
  if (found.length !== 1) die(`There is no member called "${name}". Members: ${guests.filter((g) => !g.revokedAt).map((g) => g.name).join(', ') || 'none'}`);
  return found[0];
};

function printInvite(made) {
  console.log(`\n${made.guest.name} is invited as ${made.guest.role} (${WHAT[made.guest.role]}).`);
  console.log('Send them this. In the Orchestrator app they choose "Connect to an office" and paste it.');
  console.log('Whoever has it can come in as them, so send it privately. It is shown only now.\n');
  console.log(made.invite);
  console.log('');
}

switch (command) {
  case 'status': {
    const s = await api('GET', '/sharing');
    console.log(s.door.open ? `Open to members on port ${s.door.port}` : `Closed to the network${s.door.error ? ` (${s.door.error})` : ''}`);
    if (s.door.open) console.log(`Addresses: ${[s.wanted.address, ...s.door.addresses].filter(Boolean).join('   ') || 'none found'}\nCertificate: ${s.door.fingerprint}`);
    const active = s.guests.filter((g) => !g.revokedAt);
    console.log(active.length ? `\nMembers:` : '\nNo members yet. Invite the first owner:  pnpm office invite <name> --role owner');
    for (const g of active) console.log(`  ${g.name.padEnd(20)} ${g.role.padEnd(10)} ${g.lastSeenAt ? `last here ${g.lastSeenAt}` : 'has not come in yet'}`);
    break;
  }
  case 'open': {
    const s = await api('POST', '/sharing', { open: true, ...(opts.port ? { port: Number(opts.port) } : {}), ...(opts.address ? { address: String(opts.address) } : {}) });
    if (!s.door.open) die(`The door could not be opened: ${s.door.error}`);
    console.log(`Open on port ${s.door.port}: ${[s.wanted.address, ...s.door.addresses].filter(Boolean).join('   ')}`);
    break;
  }
  case 'close':
    await api('POST', '/sharing', { open: false });
    console.log('Closed to the network. Members cannot come in until it is opened again; nobody was removed.');
    break;
  case 'invite': {
    const role = opts.role === true || opts.role === undefined ? 'colleague' : String(opts.role);
    if (!ROLES.includes(role)) die(`A role is one of: ${ROLES.join(', ')}`);
    if (!positional[0]) die('Who? pnpm office invite <name> --role owner|colleague|visitor');
    printInvite(await api('POST', '/guests', { name: positional.join(' '), role }));
    break;
  }
  case 'reinvite':
    printInvite(await api('POST', `/guests/${(await member(positional.join(' '))).id}/reissue`, {}));
    break;
  case 'role': {
    const role = positional.pop();
    if (!ROLES.includes(role)) die(`pnpm office role <name> <${ROLES.join('|')}>`);
    const g = await api('PATCH', `/guests/${(await member(positional.join(' '))).id}`, { role });
    console.log(`${g.name} is now ${g.role}: ${WHAT[g.role]}. They are reconnected with the new role.`);
    break;
  }
  case 'revoke': {
    const g = await api('DELETE', `/guests/${(await member(positional.join(' '))).id}`);
    console.log(`${g.name} can no longer come in. Their invitation and their own computer's place in the office are gone.`);
    break;
  }
  case 'service': {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const door = opts.door === true || opts.door === undefined ? '4610' : String(opts.door);
    const unit = `[Unit]
Description=Orchestrator office
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${process.execPath} ${path.join(root, 'scripts', 'start-local.mjs')} --door ${door}${opts.address ? ` --address ${opts.address}` : ''}
Restart=always
RestartSec=5
# Employees' tmux sessions outlive a restart of the office.
KillMode=process

[Install]
WantedBy=default.target
`;
    console.log(unit);
    console.error(`# Save as ~/.config/systemd/user/orchestrator.service, then:
#   systemctl --user daemon-reload && systemctl --user enable --now orchestrator
#   loginctl enable-linger $USER      # keep it running when you log out
#   journalctl --user -u orchestrator -f`);
    break;
  }
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 17).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
    process.exit(command ? 1 : 0);
}
