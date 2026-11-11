/**
 * A member's own servers, and a member's closed room.
 *
 * A colleague brings a server into the office themselves (their desktop app does the SSH part; here the agent is
 * enrolled the way that part ends: with the one-time token the office gave the member). The server is theirs like
 * their computer until they share it; shared, it is a machine of the office that colleagues work on, and it stays
 * theirs to take back or remove. And a member can close their room: then what is on their own computers is theirs
 * alone — the owners of the office and the foreman are kept out like everyone else.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { ServerToClient } from '@orchestrator/contracts';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

// The door's certificate is made on this machine (the tests reach it by its port, not through a domain).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.removeAllListeners('warning');

let h: Harness;
let doorUrl = '';
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
let laptop: Awaited<ReturnType<Harness['addHost']>>;
let server: Awaited<ReturnType<Harness['addHost']>>;
let lola = ''; // on Jovan's computer
let rex = ''; // on Jovan's server

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const decode = (code: string) => JSON.parse(Buffer.from(code.replace(/^orch-invite-v1\./, ''), 'base64url').toString('utf8'));
const door = async (who: string | null, method: string, p: string, body?: unknown) => {
  const r = await fetch(`${doorUrl}${p}`, { method, headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
function join(who: string) {
  const ws = new WebSocket(`${doorUrl.replace('https', 'wss')}/ws/client`, ['orch.v1', `orch.token.${tokens[who]}`]);
  const got: ServerToClient[] = [];
  ws.onmessage = (ev) => got.push(JSON.parse(String(ev.data)));
  ws.onerror = () => undefined;
  return {
    ws,
    got,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    until: <T extends ServerToClient['t']>(t: T, pred: (m: Extract<ServerToClient, { t: T }>) => boolean = () => true) => waitFor(async () => got.find((m) => m.t === t && pred(m as any)) as Extract<ServerToClient, { t: T }> | undefined, { label: `a ${t} message for ${who}` }),
  };
}
const hostOf = async (id: string) => (await h.state()).hosts.find((x) => x.id === id)!;

before(async () => {
  h = await createHarness();
  const port = await freePort();
  await h.api('POST', '/sharing', { open: true, port });
  doorUrl = `https://127.0.0.1:${port}`;
  for (const [name, role] of [['Jovan', 'colleague'], ['Ana', 'colleague'], ['Vera', 'owner'], ['Mila', 'visitor']] as const) {
    const made = await h.api<any>('POST', '/guests', { name, role });
    tokens[name] = decode(made.invite).t;
    ids[name] = made.guest.id;
  }
  // Jovan's own computer, with someone on it.
  laptop = await h.addHost('jovans-laptop', {}, { serverUrl: doorUrl, enrollToken: (await door('Jovan', 'POST', '/api/me/host', {})).body.token });
  const folder = path.join(laptop.root, 'side-project');
  fs.mkdirSync(folder);
  lola = (await door('Jovan', 'POST', '/api/employees', { name: 'Lola', roleKey: 'backend', hostId: laptop.hostId, workingDir: folder, autonomy: 'autonomous' })).body.id;
});
after(async () => {
  await h.cleanup();
});

test('a member brings a server into the office: it is theirs, by name, and private like their computer', async () => {
  // Not for a visitor, and not from the office's own computer (its servers are the office's from the start).
  assert.equal((await door('Mila', 'POST', '/api/me/servers', { name: 'x' })).status, 403);
  assert.match((await h.apiRaw('POST', '/me/servers', { name: 'x' })).body.error, /office's own computer/);
  const enrollment = await door('Jovan', 'POST', '/api/me/servers', { name: 'build box' });
  assert.equal(enrollment.status, 200);
  assert.match(enrollment.body.token, /^orch_enroll_/);
  // The agent on the server connects through the door by itself — which only a member's machine may do.
  server = await h.addHost('ignored-by-the-office', {}, { serverUrl: doorUrl, enrollToken: enrollment.body.token });
  const host = await hostOf(server.hostId);
  assert.deepEqual([host.name, host.memberId, host.ownerId, host.ownerName, host.local, host.status], ['build box', ids.Jovan, ids.Jovan, 'Jovan', false, 'online']);
  assert.deepEqual((await door('Jovan', 'GET', '/api/me/servers')).body.map((s: any) => [s.name, s.shared, s.status]), [['build box', false, 'online']]);
  assert.deepEqual((await door('Ana', 'GET', '/api/me/servers')).body, [], 'Ana has none');
  // He hires onto it; nobody else can — it is his alone, like his computer.
  const folder = path.join(server.root, 'service');
  fs.mkdirSync(folder);
  const hired = await door('Jovan', 'POST', '/api/employees', { name: 'Rex', roleKey: 'backend', hostId: server.hostId, workingDir: folder, autonomy: 'autonomous' });
  assert.equal(hired.status, 200, JSON.stringify(hired.body));
  rex = hired.body.id;
  assert.equal((await door('Ana', 'POST', '/api/employees', { name: 'Planted', hostId: server.hostId })).status, 403);
  assert.equal((await door('Ana', 'POST', `/api/employees/${rex}/message`, { body: 'hi' })).status, 403);
  assert.equal((await door('Jovan', 'POST', `/api/employees/${rex}/start`, {})).status, 200);
  assert.equal((await door('Jovan', 'POST', `/api/employees/${rex}/message`, { body: 'Leave a note. @@fake: write note.txt from-rex; say noted@@' })).status, 200);
  await waitFor(() => fs.existsSync(path.join(folder, 'note.txt')), { label: 'the work happened on his server', timeout: 30000 });
  await waitFor(async () => (await h.session(rex))?.inTurn === false, { label: 'Rex idle' });
  // Another member cannot share or remove it; neither can a visitor.
  assert.equal((await door('Ana', 'PATCH', `/api/me/servers/${server.hostId}`, { shared: true })).status, 403);
  assert.equal((await door('Ana', 'DELETE', `/api/me/servers/${server.hostId}`)).status, 403);
  assert.equal((await door('Mila', 'PATCH', `/api/me/servers/${server.hostId}`, { shared: true })).status, 403);
  // His computer is not a server: there is nothing to share about it.
  assert.equal((await door('Jovan', 'PATCH', `/api/me/servers/${laptop.hostId}`, { shared: true })).status, 404);
});

test('shared, the server is a machine of the office: colleagues work on it; it stays his to take back', async () => {
  const shared = await door('Jovan', 'PATCH', `/api/me/servers/${server.hostId}`, { shared: true });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  assert.deepEqual([shared.body.shared, shared.body.ownerId], [true, ids.Jovan]);
  const host = await hostOf(server.hostId);
  assert.deepEqual([host.memberId ?? null, host.ownerId, host.ownerName], [null, ids.Jovan, 'Jovan']);
  // Ana works with who is on it, reads what they said, and hires onto it.
  assert.equal((await door('Ana', 'POST', `/api/employees/${rex}/message`, { body: 'From Ana. @@fake: say hello-ana@@' })).status, 200);
  assert.ok((await door('Ana', 'GET', '/api/state')).body.messages.some((m: any) => m.toEmployeeId === rex), 'what is said there is the office\'s now');
  assert.equal((await door('Ana', 'GET', `/api/employees/${rex}/docs`)).status, 200);
  const more = await door('Ana', 'POST', '/api/employees', { name: 'Hired By Ana', roleKey: 'qa', hostId: server.hostId, workingDir: path.join(server.root, 'service') });
  assert.equal(more.status, 200, JSON.stringify(more.body));
  assert.equal((await door('Mila', 'GET', `/api/employees/${rex}/docs`)).status, 200, 'a visitor reads what is shared');
  assert.equal((await door('Mila', 'POST', `/api/employees/${rex}/message`, { body: 'x' })).status, 403);
  // What is on his computer did not become shared with it.
  assert.equal((await door('Ana', 'POST', `/api/employees/${lola}/message`, { body: 'x' })).status, 403);
  // Still his: he sees it among his servers; Ana cannot take it back, an owner of the office can.
  assert.deepEqual((await door('Jovan', 'GET', '/api/me/servers')).body.map((s: any) => [s.name, s.shared]), [['build box', true]]);
  assert.equal((await door('Ana', 'PATCH', `/api/me/servers/${server.hostId}`, { shared: false })).status, 403);
  // It keeps its place in the office across a restart, and its agent — which comes through the door — is let back in.
  await h.restartServer();
  await waitFor(async () => (await door('Jovan', 'GET', '/api/me/servers').catch(() => ({ status: 0, body: null }))).status === 200, { label: 'the door after a restart', timeout: 20000 });
  await waitFor(async () => (await hostOf(server.hostId)).status === 'online', { label: 'the shared server is back', timeout: 20000 });
  const audit = await h.api<any[]>('GET', '/audit');
  assert.ok(audit.some((x) => x.action === 'host.shared' && x.actor === 'member:Jovan'));
  // He takes it back: his alone again, with whoever is on it.
  const back = await door('Jovan', 'PATCH', `/api/me/servers/${server.hostId}`, { shared: false });
  assert.deepEqual([back.status, back.body.shared], [200, false]);
  assert.equal((await hostOf(server.hostId)).memberId, ids.Jovan);
  assert.equal((await door('Ana', 'POST', `/api/employees/${rex}/message`, { body: 'x' })).status, 403);
  assert.equal((await door('Ana', 'GET', '/api/state')).body.messages.filter((m: any) => m.toEmployeeId === rex).length, 0);
  assert.equal((await door('Vera', 'POST', `/api/employees/${rex}/message`, { body: 'From an owner. @@fake: say hello-owner@@' })).status, 200, 'an owner still works with what is a member\'s — until the room is closed');
});

test('a closed room: owners and the office\'s own computer are kept out of the member\'s computers; the member is not', async () => {
  await waitFor(async () => (await hostOf(laptop.hostId)).status === 'online', { label: 'his computer is in the office', timeout: 20000 });
  assert.equal((await door('Jovan', 'POST', `/api/employees/${lola}/start`, {})).status, 200);
  assert.equal((await door('Jovan', 'POST', `/api/employees/${lola}/message`, { body: 'Before closing. @@fake: say before@@' })).status, 200);
  await waitFor(async () => (await h.session(lola))?.inTurn === false, { label: 'Lola idle' });
  const sLola = (await h.session(lola))!;
  const v = join('Vera');
  const j = join('Jovan');
  await Promise.all([v.until('ready'), j.until('ready')]);
  v.send({ t: 'term.open', sessionId: sLola.id });
  await v.until('term.snapshot', (x) => x.snapshot.sessionId === sLola.id);

  const closed = await door('Jovan', 'PUT', '/api/me/room', { title: 'The Lab', locked: true });
  assert.deepEqual(closed.body, { title: 'The Lab', locked: true });
  for (const id of [laptop.hostId, server.hostId]) assert.equal((await hostOf(id)).room?.locked, true, 'everyone can tell the room is closed');

  // Requests: an invited owner and the office's own computer alike.
  for (const [method, p, body] of [
    ['POST', `/employees/${lola}/message`, { body: 'hi' }],
    ['POST', `/employees/${rex}/message`, { body: 'hi' }],
    ['POST', `/employees/${lola}/stop`, {}],
    ['GET', `/employees/${lola}/docs`, undefined],
    ['PATCH', `/employees/${lola}`, { instructions: 'x' }],
    ['GET', `/hosts/${laptop.hostId}/browse`, undefined],
    ['POST', '/employees', { name: 'Planted', hostId: server.hostId }],
    ['GET', `/sessions/${sLola.id}/history`, undefined],
  ] as const) {
    const asOwner = await door('Vera', method, `/api${p}`, body);
    assert.equal(asOwner.status, 403, `${method} ${p} as an owner`);
    assert.match(asOwner.body.error, /room is closed/);
    assert.equal((await h.apiRaw(method, p, body)).status, 403, `${method} ${p} from the office's own computer`);
  }
  // What is said there: not in an owner's state, not in their feed, not live — and the terminal goes quiet.
  const seen = v.got.length;
  assert.equal((await door('Jovan', 'POST', `/api/employees/${lola}/message`, { body: 'Behind the door. @@fake: say a-secret@@' })).status, 200, 'he works as before');
  await waitFor(async () => (await door('Jovan', 'GET', '/api/state')).body.events.some((e: any) => e.employeeId === lola && /a-secret/.test(JSON.stringify(e))), { label: 'it happened, for him', timeout: 30000 });
  await sleep(3200); // long enough for a round of monitor frames
  const after = v.got.slice(seen);
  assert.ok(!after.some((x: any) => (x.t === 'event' && x.event.employeeId === lola) || (x.t === 'entity' && x.kind === 'message' && x.data.toEmployeeId === lola)), 'nothing said there reached the owner\'s window');
  assert.ok(!after.some((x: any) => /^term\./.test(x.t) && ((x as any).sessionId ?? (x as any).snapshot?.sessionId) === sLola.id), 'not one more frame of the terminal the owner had open');
  for (const who of ['Vera'] as const) {
    const state = (await door(who, 'GET', '/api/state')).body;
    assert.equal(state.events.filter((e: any) => e.employeeId === lola || e.employeeId === rex).length + state.messages.filter((m: any) => m.toEmployeeId === lola || m.toEmployeeId === rex).length, 0, `${who} reads nothing of it`);
    assert.ok(state.employees.some((e: any) => e.id === lola), 'that she is there is still for everyone');
    assert.deepEqual((await door(who, 'GET', `/api/events?employeeId=${lola}`)).body, []);
  }
  const root = await h.state();
  assert.equal(root.events.filter((e) => e.employeeId === lola).length + root.messages.filter((m) => m.toEmployeeId === lola).length, 0, 'nor does the office\'s own computer');
  v.send({ t: 'term.input', sessionId: sLola.id, data: 'typed-by-an-owner' });
  await v.until('error', (x) => x.ref === sLola.id);
  assert.ok(!laptop.tmux('capture-pane', '-p', '-J', '-S', '-40', '-t', sLola.tmuxPane!).includes('typed-by-an-owner'));
  // What is shared is as it was, and the owners still run the office.
  assert.equal((await door('Vera', 'GET', '/api/state')).status, 200);
  assert.equal((await h.apiRaw('GET', '/sharing')).status, 200);

  // Open again: as before.
  assert.deepEqual((await door('Jovan', 'PUT', '/api/me/room', { title: 'The Lab' })).body, { title: 'The Lab' });
  assert.equal((await door('Vera', 'POST', `/api/employees/${lola}/message`, { body: 'Welcome back. @@fake: say hi@@' })).status, 200);
  assert.ok((await door('Vera', 'GET', '/api/state')).body.messages.some((m: any) => m.toEmployeeId === lola));
  for (const c of [v, j]) c.ws.close();
});

test('a closed room does not cover a server he shared; removing a server takes it out of the office', async () => {
  await door('Jovan', 'PUT', '/api/me/room', { locked: true });
  await door('Jovan', 'PATCH', `/api/me/servers/${server.hostId}`, { shared: true });
  assert.equal((await door('Ana', 'POST', `/api/employees/${rex}/message`, { body: 'Shared again. @@fake: say ok@@' })).status, 200, 'what he shared is the office\'s, closed room or not');
  assert.equal((await door('Vera', 'POST', `/api/employees/${lola}/message`, { body: 'x' })).status, 403, 'his computer stays closed');
  // An owner of the office can still run it: take a member's server out.
  assert.equal((await door('Vera', 'DELETE', `/api/me/servers/${server.hostId}`)).status, 200);
  await waitFor(async () => (await hostOf(server.hostId)).status === 'revoked', { label: 'the server is out' });
  assert.deepEqual((await door('Jovan', 'GET', '/api/me/servers')).body, []);
  await door('Jovan', 'PUT', '/api/me/room', {});
});

// ── the desktop app's side ──
// What the app does for "Bring a server in…" (apps/desktop/electron/member-servers.cjs), against a stand-in for ssh
// that runs each command on this machine with a home folder and a tmux folder of its own: the scripts are the real ones.
const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps/host-agent/dist/orchestrator-agent.mjs');

test('the app brings a server in over SSH: checks it, installs the agent, enrols it with a token that is on no command line — and takes it out again', { skip: process.platform === 'win32' || !fs.existsSync(bundle) ? 'needs the bundled agent (node scripts/build.mjs) and a Unix shell' : false }, async () => {
  const { memberServers } = createRequire(import.meta.url)('../../apps/desktop/electron/member-servers.cjs');
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fake-server-')));
  fs.mkdirSync(path.join(home, 'code'));
  const calls = path.join(home, 'ssh-calls.log');
  const ssh = path.join(home, 'ssh');
  fs.writeFileSync(ssh, ['#!/bin/sh', '# Stands in for ssh: the last argument is the command; everything before it is options and the destination.', `printf '%s\\n' "$*" >> ${JSON.stringify(calls)}`, 'for a in "$@"; do last="$a"; done', `export HOME=${JSON.stringify(home)} TMUX_TMPDIR=${JSON.stringify(path.join(home, 'tmux'))} NODE_TLS_REJECT_UNAUTHORIZED=0`, 'mkdir -p "$TMUX_TMPDIR"', 'cd "$HOME"', 'exec sh -c "$last"', ''].join('\n'), { mode: 0o755 });
  const fingerprint = (await h.api<any>('GET', '/sharing')).door.fingerprint as string;
  const servers = memberServers({ office: { address: doorUrl, token: tokens.Ana, fingerprint }, file: path.join(home, 'app', 'servers.json'), agentBundle: bundle, ssh });
  let id: string | null = null;
  try {
    // An office reached by address, with a certificate of its own: the server could not tell it is the office. Refused before anything is done.
    await assert.rejects(servers.add({ target: 'ana@build.example.com' }), /certificate computers trust/);
    assert.ok(!fs.existsSync(calls), 'the server was not touched');
    await assert.rejects(servers.add({ target: 'not a server; rm -rf ~' }), /user@host/);
    process.env.ORCH_MEMBER_SERVER_ANY_CERT = '1';
    await assert.rejects(servers.add({ target: 'ana@build.example.com', roots: ['../etc'] }), /not a folder path/);
    const steps: string[] = [];
    const added = await servers.add({ target: 'ana@build.example.com:2222', name: 'ana box', roots: ['~/code'] }, (s: string) => steps.push(s));
    id = added.id;
    assert.deepEqual(steps, ['Checking the server', 'Installing the agent', 'Asking the office for a place', 'Starting the agent', 'Waiting for the server to come into the office']);
    // In the office: Ana's, by the name she gave, online — through the door, by itself.
    const host = await hostOf(added.hostId);
    assert.deepEqual([host.name, host.memberId, host.ownerId, host.ownerName, host.status], ['ana box', ids.Ana, ids.Ana, 'Ana', 'online']);
    assert.deepEqual((await door('Ana', 'GET', '/api/me/servers')).body.map((x: any) => [x.id, x.shared, x.status]), [[added.hostId, false, 'online']]);
    // On the server: the agent beside a launcher, its own folder for this office, the folder she named and no other.
    const agentHome = path.join(home, '.orchestrator', 'member-servers', added.id);
    const cfg = JSON.parse(fs.readFileSync(path.join(agentHome, 'config.json'), 'utf8'));
    assert.deepEqual([cfg.serverUrl, cfg.hostId, cfg.allowedRoots], [doorUrl, added.hostId, [path.join(home, 'code')]]);
    assert.equal(fs.readFileSync(path.join(home, '.orchestrator', 'bin', 'orchestrator-agent.mjs'), 'utf8'), fs.readFileSync(bundle, 'utf8'));
    // The enrolment token and the member's own token were on no command line.
    const said = fs.readFileSync(calls, 'utf8');
    assert.ok(!/orch_enroll_|orch_guest_/.test(said), 'no token among the arguments ssh was given');
    assert.ok(/-o BatchMode=yes/.test(said) && /-p 2222 ana@build\.example\.com/.test(said) && !/StrictHostKeyChecking/.test(said), 'keys only, the port she gave, and an unknown host key is not accepted unasked');
    // This computer remembers how to reach it; the same server is not brought in twice.
    assert.deepEqual(servers.list().map((r: any) => [r.target, r.name, r.hostId, r.error]), [['ana@build.example.com:2222', 'ana box', added.hostId, null]]);
    await assert.rejects(servers.add({ target: 'ana@build.example.com:2222' }), /already one of your servers/);
    // After the server was restarted: the agent is started again and comes back as the same machine.
    process.kill(Number(fs.readFileSync(path.join(agentHome, 'agent.pid'), 'utf8')), 'SIGTERM');
    await waitFor(async () => (await hostOf(added.hostId)).status === 'offline', { label: 'the server is gone', timeout: 20000 });
    assert.deepEqual(await servers.reconnect(added.id), { ok: true });
    assert.equal((await hostOf(added.hostId)).status, 'online');
    // Taken out: the agent is stopped, what was installed for this office is gone, the office forgets the machine.
    assert.deepEqual(await servers.remove(added.id), { ok: true, cleaned: true });
    id = null;
    assert.ok(!fs.existsSync(agentHome));
    await waitFor(async () => (await hostOf(added.hostId)).status === 'revoked', { label: 'the office forgot it' });
    assert.deepEqual(servers.list(), []);
  } finally {
    delete process.env.ORCH_MEMBER_SERVER_ANY_CERT;
    if (id) await servers.remove(id).catch(() => undefined);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
