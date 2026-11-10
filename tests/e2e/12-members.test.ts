/**
 * Members of the office: invitations with one of three roles, the door they come in through,
 * what each role may and may not do on what is shared, a member's own computer (a personal host)
 * and who may use what is on it, seeing and talking to each other, and revoking access.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import type { ServerToClient } from '@orchestrator/contracts';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

// The door's certificate is made on this machine; guests trust it by its fingerprint (checked below), not by a CA.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.removeAllListeners('warning');

let h: Harness;
let doorUrl = '';
let fingerprint = '';
const invites: Record<string, { n: string; g: string; r: string; t: string; a: string[]; f: string }> = {};
const guestIds: Record<string, string> = {};
let alex = '';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const decode = (code: string) => JSON.parse(Buffer.from(code.replace(/^orch-invite-v1\./, ''), 'base64url').toString('utf8'));
/** A request the way a guest's app makes it: to the door, with their token. */
const door = async (token: string | null, method: string, p: string, body?: unknown) => {
  const r = await fetch(`${doorUrl}${p}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
/** A guest's office window: the client WebSocket through the door. */
function join(token: string) {
  // As the office window does it: the token is a subprotocol, so it is in no address a proxy would log.
  const ws = new WebSocket(`${doorUrl.replace('https', 'wss')}/ws/client`, ['orch.v1', `orch.token.${token}`]);
  const got: ServerToClient[] = [];
  let closed: number | null = null;
  ws.onmessage = (ev) => got.push(JSON.parse(String(ev.data)));
  ws.onclose = (ev) => (closed = ev.code);
  ws.onerror = () => undefined;
  return {
    ws,
    got,
    closed: () => closed,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    until: <T extends ServerToClient['t']>(t: T, pred: (m: Extract<ServerToClient, { t: T }>) => boolean = () => true) => waitFor(async () => got.find((m) => m.t === t && pred(m as any)) as Extract<ServerToClient, { t: T }> | undefined, { label: `${t} message` }),
  };
}

before(async () => {
  h = await createHarness();
  const repo = h.makeRepo('shop');
  const project = await h.project('Shop', repo);
  alex = (await h.employee('Alex', 'backend', { projectId: project.id, autonomy: 'standard' })).id;
  await h.api('POST', `/employees/${alex}/start`, {});
  await waitFor(async () => (await h.session(alex))!.inTurn === false, { label: 'Alex idle' });
});
after(async () => {
  await h.cleanup();
});

let projectId = '';
let jovanHost: Awaited<ReturnType<Harness['addHost']>>;
let lola = '';

test('the office is closed to the network until an owner opens the door', async () => {
  const before = await h.api<any>('GET', '/sharing');
  assert.equal(before.door.open, false);
  assert.ok((await h.apiRaw('POST', '/guests', { name: 'Mila' })).status >= 400, 'no invitations while the door is closed');
  const port = await freePort();
  const opened = await h.api<any>('POST', '/sharing', { open: true, port });
  assert.equal(opened.door.open, true);
  assert.equal(opened.door.port, port);
  assert.match(opened.door.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  fingerprint = opened.door.fingerprint;
  doorUrl = `https://127.0.0.1:${port}`;
  // What a joining app checks: the certificate at the door is exactly the one the invitation names.
  const seen = await new Promise<string>((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      resolve(s.getPeerCertificate().fingerprint256);
      s.end();
    });
    s.on('error', reject);
  });
  assert.equal(seen, fingerprint);
});

test('an invitation is one string: the addresses, the certificate to trust, a role, and a credential that is not the server’s own', async () => {
  for (const [name, role] of [['Mila', 'visitor'], ['Jovan', 'colleague'], ['Ana', 'colleague'], ['Vera', 'owner']] as const) {
    const made = await h.api<any>('POST', '/guests', { name, role });
    invites[name] = decode(made.invite);
    guestIds[name] = made.guest.id;
    assert.deepEqual([invites[name]!.g, invites[name]!.r, invites[name]!.f], [name, role, fingerprint]);
    assert.match(invites[name]!.t, /^orch_guest_/);
    assert.notEqual(invites[name]!.t, h.token);
    assert.ok(invites[name]!.a.every((a) => /^https:\/\/[\d.]+:\d+$/.test(a)), 'the addresses of this machine on its networks');
  }
  assert.ok((await h.apiRaw('POST', '/guests', { name: 'mila' })).status >= 400, 'no two members with one name');
  assert.equal((await h.api<any>('POST', '/guests', { name: 'Odd', role: 'admin' })).guest.role, 'visitor', 'an unknown role is the least one');
  // Only hashes of the credentials are stored.
  assert.ok(!JSON.stringify(await h.api('GET', '/sharing')).includes(invites.Mila!.t));
});

test('the door lets through what a member’s app and own computer need, and never the server’s own owner token', async () => {
  assert.equal((await door(null, 'GET', '/healthz')).status, 200);
  assert.equal((await door(null, 'GET', '/api/state')).status, 401, 'no credential, no office');
  assert.equal((await door(h.token, 'GET', '/api/state')).status, 401, 'the root owner token is not accepted from the network');
  assert.equal((await door(h.token, 'GET', '/api/sharing')).status, 401);
  for (const p of ['/downloads/orchestrator-agent.mjs', '/install-agent.sh', '/ws/other']) assert.equal((await door(invites.Jovan!.t, 'GET', p)).status, 404, `${p} is not behind the door`);
  // The worker endpoint is there, and answers only to a worker session's own token.
  assert.equal((await door(invites.Vera!.t, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  // A caller cannot pretend to be local by sending the door's mark themselves.
  const forged = await fetch(`${doorUrl}/api/state`, { headers: { authorization: `Bearer ${h.token}`, 'x-orch-door': 'anything' } });
  assert.equal(forged.status, 401);
  // A shared machine cannot be enrolled from outside: an ordinary enrollment token is refused at the door.
  const ordinary = (await h.api<any>('POST', '/hosts/enroll-token', { label: 'box' })).token;
  await assert.rejects(h.addHost('intruder', {}, { serverUrl: doorUrl, enrollToken: ordinary }), /only a member's own computer/);
  assert.ok(!(await h.state()).hosts.some((x) => x.name === 'intruder'));
});

test('a visitor reads what is shared and changes nothing', async () => {
  const mila = invites.Mila!.t;
  const me = (await door(mila, 'GET', '/api/me')).body;
  assert.deepEqual(me, { kind: 'guest', role: 'visitor', name: 'Mila', id: guestIds.Mila, office: 'My Company' });
  const state = await door(mila, 'GET', '/api/state');
  assert.equal(state.status, 200);
  projectId = state.body.projects[0].id;
  // Read-only really is reading: documents and diffs of shared employees too.
  for (const p of [`/api/employees/${alex}/docs`, `/api/employees/${alex}/git`, '/api/events', '/api/people']) assert.equal((await door(mila, 'GET', p)).status, 200, `GET ${p} as a visitor`);
  for (const [method, p, body] of [
    ['POST', `/api/employees/${alex}/message`, { body: 'hello' }],
    ['POST', '/api/tasks', { projectId, title: 'x' }],
    ['POST', `/api/employees/${alex}/stop`, {}],
    ['POST', '/api/me/host', {}],
    ['GET', `/api/hosts/${h.hostId}/browse`, undefined],
  ] as const) {
    const r = await door(mila, method, p, body);
    assert.equal(r.status, 403, `${method} ${p} as a visitor`);
    assert.match(r.body.error, /You are visiting this office: you can look, not change anything/);
  }
  for (const [method, p, body] of [['GET', '/api/audit', undefined], ['PATCH', '/api/settings', { ownerName: 'Mila' }], ['POST', '/api/guests', { name: 'Friend' }]] as const) assert.equal((await door(mila, method, p, body)).status, 403, `${method} ${p} as a visitor`);
});

test('a colleague works on everything shared, and does not run the office', async () => {
  const jovan = invites.Jovan!.t;
  // Talks to an employee (who is told it is not the boss), creates a task, reads documents, browses the shared machine.
  await door(jovan, 'POST', `/api/employees/${alex}/message`, { body: 'Could you look at the README? @@fake: say will-do-for-jovan@@' });
  const delivered = await waitFor(async () => (await h.state()).messages.find((m) => m.toEmployeeId === alex && /README/.test(m.body) && m.delivery.status === 'confirmed'), { label: 'colleague message delivered' });
  assert.match(delivered.from.name, /Jovan \(a colleague the boss invited; not the boss\)/);
  assert.equal((await door(jovan, 'POST', '/api/tasks', { projectId, title: 'From a colleague', released: false })).status, 200);
  assert.equal((await door(jovan, 'GET', `/api/employees/${alex}/docs`)).status, 200);
  assert.equal((await door(jovan, 'GET', `/api/hosts/${h.hostId}/browse?path=${encodeURIComponent(h.tmp)}`)).status, 200);
  // Hires on the shared machine, and stops and starts a shared session.
  const hired = await door(jovan, 'POST', '/api/employees', { name: 'Hired By Jovan', roleKey: 'qa', projectId });
  assert.equal(hired.status, 200);
  assert.equal(hired.body.hostId, h.hostId);
  assert.ok(hired.body.deskId, 'a shared employee gets a desk in the office');
  assert.equal((await door(jovan, 'POST', `/api/employees/${alex}/pause`, {})).status, 200);
  assert.equal((await door(jovan, 'POST', `/api/employees/${alex}/resume`, {})).status, 200);
  // Running the office stays with owners.
  for (const [method, p, body] of [
    ['PATCH', '/api/settings', { autoAsksHighRisk: false }],
    ['POST', '/api/ssh-links', { target: 'x@y' }],
    ['POST', '/api/hosts/enroll-token', {}],
    ['POST', `/api/hosts/${h.hostId}/revoke`, {}],
    ['POST', '/api/commands/execute', { input: 'x', operations: [] }],
    ['PUT', '/api/layout', {}],
    ['GET', '/api/audit', undefined],
    ['POST', `/api/projects/${projectId}/promote`, {}],
    ['DELETE', `/api/guests/${guestIds.Mila}`, undefined],
    ['POST', '/api/guests', { name: 'Friend', role: 'owner' }],
  ] as const) {
    const r = await door(jovan, method, p, body);
    assert.equal(r.status, 403, `${method} ${p} as a colleague`);
    assert.match(r.body.error, /Only an owner of this office can do this/);
  }
  // An employee's question, and a shared employee's permission request, may be decided by a colleague; the record says who did.
  await h.api('POST', `/employees/${alex}/message`, { body: 'Ask and then try. @@fake: ask Tabs or spaces?; bash git push origin main || true; say asked-and-tried@@' });
  const q = await waitFor(() => h.openQuestion(alex, 'question'), { label: 'a question' });
  assert.equal((await door(jovan, 'POST', `/api/questions/${q.id}/answer`, { answer: 'Spaces' })).status, 200);
  const perm = await waitFor(() => h.openQuestion(alex, 'permission'), { label: 'a permission request' });
  assert.equal((await door(invites.Mila!.t, 'POST', `/api/questions/${perm.id}/answer`, { decision: 'allow' })).status, 403, 'not a visitor');
  assert.equal((await door(jovan, 'POST', `/api/questions/${perm.id}/answer`, { decision: 'deny' })).status, 200);
  const audit = await h.api<any[]>('GET', '/audit');
  assert.ok(audit.some((a) => a.action === 'guest.invited' && a.detail.name === 'Jovan' && a.detail.role === 'colleague'));
  assert.ok(audit.some((a) => a.actor === 'member:Jovan' && a.action === 'member.action' && /\/tasks$/.test(a.target)));
  assert.ok(audit.some((a) => a.actor === 'member:Jovan' && JSON.stringify(a).includes(perm.id)), 'who decided the request is on the record');
});

test('an owner who was invited does everything, from outside', async () => {
  const vera = invites.Vera!.t;
  assert.deepEqual((await door(vera, 'GET', '/api/me')).body, { kind: 'owner', role: 'owner', name: 'Vera', id: guestIds.Vera, office: 'My Company' });
  assert.equal((await door(vera, 'GET', '/api/audit')).status, 200);
  assert.equal((await door(vera, 'PATCH', '/api/settings', { companyName: 'Shared Office' })).status, 200);
  assert.equal((await h.state()).settings.companyName, 'Shared Office');
  const made = await door(vera, 'POST', '/api/guests', { name: 'Zoran', role: 'visitor' });
  assert.equal(made.status, 200);
  assert.equal((await door(vera, 'DELETE', `/api/guests/${made.body.guest.id}`)).status, 200);
  await door(vera, 'POST', `/api/employees/${alex}/message`, { body: 'Status? @@fake: say fine-for-vera@@' });
  const msg = await waitFor(async () => (await h.state()).messages.find((m) => m.toEmployeeId === alex && /Status\?/.test(m.body)), { label: 'owner member message' });
  assert.match(msg.from.name, /Vera \(an owner of this office\)/);
});

test('a member’s own computer joins through the door; what is on it is theirs', async () => {
  const jovan = invites.Jovan!.t;
  const enrollment = await door(jovan, 'POST', '/api/me/host', {});
  assert.equal(enrollment.status, 200);
  assert.match(enrollment.body.token, /^orch_enroll_/);
  jovanHost = await h.addHost('jovans-laptop', {}, { serverUrl: doorUrl, enrollToken: enrollment.body.token });
  const host = (await h.state()).hosts.find((x) => x.id === jovanHost.hostId)!;
  assert.deepEqual([host.memberId, host.memberName, host.local, host.status, host.name], [guestIds.Jovan, 'Jovan', false, 'online', "Jovan's computer"]);
  await assert.rejects(h.addHost('again', {}, { serverUrl: doorUrl, enrollToken: enrollment.body.token }), /already used|invalid/);
  // He adds a folder on his computer as an employee there. No desk in the shared office: his room is where they sit.
  const folder = path.join(jovanHost.root, 'side-project');
  fs.mkdirSync(folder);
  const hired = await door(jovan, 'POST', '/api/employees', { name: 'Lola', roleKey: 'backend', hostId: jovanHost.hostId, workingDir: folder, autonomy: 'autonomous' });
  assert.equal(hired.status, 200);
  lola = hired.body.id;
  assert.equal(hired.body.deskId, null);
  assert.equal((await door(jovan, 'POST', `/api/employees/${lola}/start`, {})).status, 200);
  assert.equal((await door(jovan, 'POST', `/api/employees/${lola}/message`, { body: 'Make a note. @@fake: write note.txt from-lola; say noted@@' })).status, 200);
  await waitFor(() => fs.existsSync(path.join(folder, 'note.txt')), { label: 'the work happened on his computer', timeout: 30000 }).catch(async (e) => {
    const x = await h.session(lola);
    const st = await h.state();
    throw new Error(`${e.message}\nsession ${JSON.stringify(x && { status: x.status, activity: x.activity })}\nmessages ${JSON.stringify(st.messages.filter((m) => m.toEmployeeId === lola).map((m) => m.delivery))}\n${x?.tmuxPane ? jovanHost.tmux('capture-pane', '-p', '-J', '-S', '-20', '-t', x.tmuxPane) : ''}`);
  });
  assert.equal(fs.readFileSync(path.join(folder, 'note.txt'), 'utf8').trim(), 'from-lola');
  // Her session talked to the office through the door (the worker endpoint), as herself.
  await waitFor(async () => (await h.session(lola))?.inTurn === false, { label: 'Lola idle' });
  // What is shared does not leak onto his computer, and the other way round.
  assert.match((await door(jovan, 'PATCH', `/api/employees/${lola}`, { projectId })).body.error, /is not on this computer/);
  const shared = (await h.state()).employees.find((e) => e.name === 'Hired By Jovan')!;
  assert.match((await h.apiRaw('PATCH', `/employees/${shared.id}`, { hostId: jovanHost.hostId })).body.error, /is not on this computer/);
  const personalProject = await door(jovan, 'POST', '/api/projects', { name: 'Side', hostId: jovanHost.hostId, repoPath: null });
  assert.equal(personalProject.status, 200);
  assert.match((await h.apiRaw('PATCH', `/employees/${alex}`, { alsoProjectIds: [personalProject.body.id] })).body.error, /on a member's own computer/);
  // A shared task that anyone free may take is not routed to her.
  const open = await h.task({ projectId, title: 'Anyone', description: '@@fake: complete ok@@' });
  await sleep(800);
  assert.notEqual((await h.getTask(open.id)).assigneeId, lola);
});

test('a member arranges their own room; it is kept by the office and shown on their computer for everyone', async () => {
  const jovan = invites.Jovan!.t;
  const set = await door(jovan, 'PUT', '/api/me/room', { title: '  The   Lab ', color: '#8A5FBF', desks: 7, extraDepth: 6.2, furniture: ['sofa', 'aquarium', 'plant'], anything: 'else' });
  assert.equal(set.status, 200);
  const wanted = { title: 'The Lab', color: '#8a5fbf', desks: 8, extraDepth: 6, furniture: ['plant', 'sofa'] };
  assert.deepEqual(set.body, wanted);
  assert.deepEqual((await h.state()).hosts.find((x) => x.id === jovanHost.hostId)!.room, wanted, 'everyone sees it on his computer');
  assert.deepEqual((await door(jovan, 'GET', '/api/me/room')).body, wanted);
  // Out of range is brought into range; nonsense is dropped.
  assert.deepEqual((await door(jovan, 'PUT', '/api/me/room', { desks: 999, extraDepth: 999, color: 'purple', title: 42 })).body, { desks: 20, extraDepth: 12 });
  await door(jovan, 'PUT', '/api/me/room', wanted);
  // Only one's own: a visitor has no room, and the office's own computer has none either.
  assert.equal((await door(invites.Mila!.t, 'PUT', '/api/me/room', { desks: 4 })).status, 403);
  assert.match((await h.apiRaw('PUT', '/me/room', { desks: 4 })).body.error, /no room of its own/);
  assert.deepEqual((await door(invites.Ana!.t, 'GET', '/api/me/room')).body, {}, 'Ana has not arranged hers');
  // It survives the office restarting, and a computer he enrolls later gets the same room.
  await h.restartServer();
  await waitFor(async () => (await door(jovan, 'GET', '/api/me/room').catch(() => ({ status: 0, body: null }))).status === 200, { label: 'the door after a restart', timeout: 20000 });
  assert.deepEqual((await door(jovan, 'GET', '/api/me/room')).body, wanted);
  await waitFor(async () => (await h.state()).hosts.find((x) => x.id === jovanHost.hostId)!.status === 'online', { label: 'his computer is back', timeout: 20000 });
  assert.deepEqual((await h.state()).hosts.find((x) => x.id === jovanHost.hostId)!.room, wanted);
  const audit = await h.api<any[]>('GET', '/audit');
  assert.ok(audit.some((x) => x.action === 'member.room_changed' && x.actor === 'member:Jovan'));
});

test('another colleague sees that she is there and nothing more; an owner can work with her', async () => {
  const ana = invites.Ana!.t;
  const state = (await door(ana, 'GET', '/api/state')).body;
  assert.ok(state.employees.some((e: any) => e.id === lola), 'listed, with her state');
  for (const [method, p, body] of [
    ['GET', `/api/employees/${lola}/docs`, undefined],
    ['GET', `/api/employees/${lola}/git`, undefined],
    ['POST', `/api/employees/${lola}/message`, { body: 'hi' }],
    ['POST', `/api/employees/${lola}/stop`, {}],
    ['PATCH', `/api/employees/${lola}`, { instructions: 'x' }],
    ['GET', `/api/hosts/${jovanHost.hostId}/browse`, undefined],
    ['POST', '/api/employees', { name: 'Planted', hostId: jovanHost.hostId }],
    ['POST', '/api/projects', { name: 'Planted', hostId: jovanHost.hostId }],
    ['POST', '/api/sessions/attach', { hostId: jovanHost.hostId, tmuxSession: 'x' }],
  ] as const) {
    const r = await door(ana, method, p, body);
    assert.equal(r.status, 403, `${method} ${p} as another colleague`);
    assert.match(r.body.error, /another member's own computer/);
  }
  assert.equal((await door(invites.Mila!.t, 'GET', `/api/employees/${lola}/docs`)).status, 403, 'nor a visitor');
  // Terminals: hers is shown to Jovan and to owners, not to Ana or a visitor; the shared one to everyone, to type in for colleagues.
  const sLola = (await h.session(lola))!;
  const sAlex = (await h.session(alex))!;
  const a = join(ana);
  const m = join(invites.Mila!.t);
  const j = join(invites.Jovan!.t);
  const v = join(invites.Vera!.t);
  await Promise.all([a.until('ready'), m.until('ready'), j.until('ready'), v.until('ready')]);
  for (const c of [a, m]) {
    c.send({ t: 'term.open', sessionId: sLola.id });
    assert.match((await c.until('term.closed', (x) => x.sessionId === sLola.id)).reason, /another member's own computer/);
  }
  j.send({ t: 'term.open', sessionId: sLola.id });
  v.send({ t: 'term.open', sessionId: sLola.id });
  await j.until('term.snapshot', (x) => x.snapshot.sessionId === sLola.id);
  await v.until('term.snapshot', (x) => x.snapshot.sessionId === sLola.id);
  await sleep(3200); // long enough for a round of monitor frames
  for (const c of [a, m]) assert.ok(!c.got.some((x) => /^term\./.test(x.t) && x.t !== 'term.closed' && ((x as any).sessionId ?? (x as any).snapshot?.sessionId) === sLola.id), 'not one frame of her terminal reached them');
  // The visitor watches the shared terminal and cannot type; the colleague can.
  m.send({ t: 'term.open', sessionId: sAlex.id });
  await m.until('term.snapshot', (x) => x.snapshot.sessionId === sAlex.id);
  m.send({ t: 'control.acquire', sessionId: sAlex.id });
  m.send({ t: 'term.input', sessionId: sAlex.id, data: 'echo typed-by-a-visitor\r' });
  assert.match((await m.until('error')).message, /You are visiting this office: you cannot (take control of|type into) a terminal/);
  a.send({ t: 'term.open', sessionId: sAlex.id });
  await a.until('term.snapshot', (x) => x.snapshot.sessionId === sAlex.id);
  a.send({ t: 'control.acquire', sessionId: sAlex.id });
  await sleep(300);
  a.send({ t: 'term.input', sessionId: sAlex.id, data: 'typed-by-ana' });
  await waitFor(() => h.tmux('capture-pane', '-p', '-J', '-S', '-40', '-t', sAlex.tmuxPane!).includes('typed-by-ana'), { label: 'a colleague types into a shared terminal' });
  assert.ok(!h.tmux('capture-pane', '-p', '-J', '-S', '-40', '-t', sAlex.tmuxPane!).includes('typed-by-a-visitor'));
  a.send({ t: 'term.input', sessionId: sAlex.id, data: '\u0015' });
  a.send({ t: 'control.release', sessionId: sAlex.id });
  // Ana cannot type into Lola's; the owner can talk to Lola.
  a.send({ t: 'term.input', sessionId: sLola.id, data: 'nope\r' });
  assert.match((await a.until('error', (x) => /own computer/.test(x.message))).message, /another member's own computer/);
  assert.equal((await door(invites.Vera!.t, 'POST', `/api/employees/${lola}/message`, { body: 'From an owner. @@fake: say hello-owner@@' })).status, 200);
  assert.equal((await door(invites.Vera!.t, 'GET', `/api/employees/${lola}/docs`)).status, 200);
  for (const c of [a, m, j, v]) c.ws.close();
});

test('the foreman and the office’s own alerts leave a member’s computer alone; when the member goes, the computer is offline, not an incident', async () => {
  const before = (await h.state()).notifications.length;
  await jovanHost.stop();
  await waitFor(async () => (await h.state()).hosts.find((x) => x.id === jovanHost.hostId)!.status === 'offline', { label: 'his computer is offline' });
  await sleep(300);
  assert.ok(!(await h.state()).notifications.slice(before).some((n) => n.kind === 'host_disconnected'), 'no alarm for a member leaving');
  assert.equal((await h.session(lola))!.status, 'host_offline');
});

test('a window’s token is not in its address; a wrong one is turned away either way', async () => {
  const outcome = (ws: WebSocket) =>
    new Promise<string>((resolve) => {
      ws.onmessage = (ev) => JSON.parse(String(ev.data)).t === 'ready' && resolve(`ready with protocol "${ws.protocol}"`);
      ws.onclose = (ev) => resolve(`closed ${ev.code}`);
      ws.onerror = () => undefined;
    });
  const base = `${doorUrl.replace('https', 'wss')}/ws/client`;
  const good = new WebSocket(base, ['orch.v1', `orch.token.${invites.Vera!.t}`]);
  assert.equal(await outcome(good), 'ready with protocol "orch.v1"');
  good.close();
  assert.equal(await outcome(new WebSocket(base, ['orch.v1', 'orch.token.orch_guest_nope'])), 'closed 4003');
  assert.equal(await outcome(new WebSocket(base, ['orch.v1'])), 'closed 4003');
  // Older clients put it in the address; that still works.
  const old = new WebSocket(`${base}?token=${invites.Vera!.t}`);
  assert.match(await outcome(old), /^ready/);
  old.close();
});

test('people see each other in the office and can talk', async () => {
  const boss = await h.client();
  const mila = join(invites.Mila!.t);
  const jovan = join(invites.Jovan!.t);
  const ready = await mila.until('ready');
  assert.deepEqual(ready.me, { kind: 'guest', role: 'visitor', name: 'Mila', id: guestIds.Mila });
  assert.deepEqual((await jovan.until('ready')).me, { kind: 'guest', role: 'colleague', name: 'Jovan', id: guestIds.Jovan });
  boss.send({ t: 'presence', x: 1, z: 2, rot: 0.5, moving: false } as any);
  mila.send({ t: 'presence', x: -3, z: 4, rot: 1, moving: true });
  jovan.send({ t: 'presence', x: 9999, z: Number.NaN, rot: 0, moving: false });
  const people = await jovan.until('people', (m) => m.people.length === 3);
  const by = (name: string) => people.people.find((p) => p.name === name)!;
  assert.deepEqual([by('Mila').role, by('Mila').x, by('Mila').z, by('Mila').moving, by('Mila').memberId], ['visitor', -3, 4, true, guestIds.Mila]);
  assert.deepEqual([by('Jovan').x, by('Jovan').z], [500, 0], 'positions are kept within bounds');
  assert.equal(people.people.find((p) => p.memberId === 'owner')!.x, 1);
  assert.equal(new Set(people.people.map((p) => p.hue)).size, 3, 'each person has a colour of their own');
  mila.send({ t: 'say', text: '  Hello from the visitor\u0007  ' });
  const said = await waitFor(async () => boss.messages.find((m: any) => m.t === 'said') as any, { label: 'the owner hears it' });
  assert.deepEqual([said.from.name, said.from.role, said.text], ['Mila', 'visitor', 'Hello from the visitor']);
  for (let i = 0; i < 20; i++) mila.send({ t: 'say', text: `spam ${i}` });
  await sleep(600);
  assert.ok(jovan.got.filter((m) => m.t === 'said' && /^spam/.test((m as any).text)).length <= 8, 'at most eight lines in ten seconds');
  mila.ws.close();
  await waitFor(async () => (jovan.got.filter((m) => m.t === 'people').pop() as any)?.people.length === 2, { label: 'Mila left' });
  jovan.ws.close();
  boss.close();
});

test('revoking ends a member’s session and their computer’s place in the office; roles change; the door survives a restart', async () => {
  // Jovan comes back with his computer, then is made a visitor: a visitor has no computer in the office.
  const mila = join(invites.Mila!.t);
  await mila.until('ready');
  await h.api('DELETE', `/guests/${guestIds.Mila}`);
  await waitFor(async () => mila.closed() !== null, { label: 'the revoked member is disconnected' });
  assert.equal((await door(invites.Mila!.t, 'GET', '/api/me')).status, 401);
  const again = await h.api<any>('POST', `/guests/${guestIds.Jovan}/reissue`, {});
  const fresh = decode(again.invite);
  assert.equal((await door(invites.Jovan!.t, 'GET', '/api/me')).status, 401, 'the old invitation no longer works');
  assert.equal((await door(fresh.t, 'GET', '/api/me')).body.role, 'colleague');
  await h.api('PATCH', `/guests/${guestIds.Jovan}`, { role: 'visitor' });
  assert.equal((await door(fresh.t, 'POST', `/api/employees/${alex}/message`, { body: 'x' })).status, 403);
  assert.equal((await h.state()).hosts.find((x) => x.id === jovanHost.hostId)!.status, 'revoked', 'his computer can no longer connect');
  // Promoted to owner, he runs the office.
  await h.api('PATCH', `/guests/${guestIds.Jovan}`, { role: 'owner' });
  assert.equal((await door(fresh.t, 'GET', '/api/audit')).status, 200);
  await h.restartServer();
  await waitFor(async () => (await door(fresh.t, 'GET', '/api/me').catch(() => ({ status: 0, body: null }))).status === 200, { label: 'the door is open again after a restart', timeout: 20000 });
  assert.equal((await h.api<any>('GET', '/sharing')).door.fingerprint, fingerprint, 'the same certificate: invitations stay valid');
  await h.api('POST', '/sharing', { open: false });
  assert.equal(await fetch(`${doorUrl}/healthz`).then(() => 'reachable', () => 'closed'), 'closed');
});

test('the office is run from a terminal on its own machine: open, invite the first owner, change a role, revoke', async () => {
  // The office runs in this very process, so the command must not block it.
  const admin = (...args: string[]) =>
    new Promise<string>((resolve) =>
      execFile(process.execPath, ['scripts/office-admin.mjs', ...args, '--port-local', new URL(h.url).port], { encoding: 'utf8', env: { ...process.env, ORCH_SERVER_HOME: path.join(h.tmp, 'server') } }, (err, stdout, stderr) => resolve(err ? `FAILED ${stdout}${stderr}` : stdout)),
    );
  assert.match(await admin('status'), /Closed to the network/);
  assert.match(await admin('invite', 'Too', 'Early'), /FAILED[\s\S]*open the office/);
  const port = await freePort();
  assert.match(await admin('open', '--port', String(port), '--address', 'https://office.example.test:4610'), new RegExp(`Open on port ${port}: https://office\\.example\\.test:4610`));
  const out = await admin('invite', 'Petra', 'Petrovic', '--role', 'owner');
  assert.match(out, /Petra Petrovic is invited as owner \(runs the office: everything\)/);
  const invite = decode(/orch-invite-v1\.\S+/.exec(out)![0]);
  assert.deepEqual([invite.g, invite.r, invite.a[0]], ['Petra Petrovic', 'owner', 'https://office.example.test:4610']);
  // The invitation works from outside, as an owner.
  doorUrl = `https://127.0.0.1:${port}`;
  assert.equal((await door(invite.t, 'GET', '/api/audit')).status, 200);
  assert.match(await admin('invite', 'X', '--role', 'boss'), /FAILED[\s\S]*A role is one of/);
  assert.match(await admin('role', 'petra', 'petrovic', 'visitor'), /Petra Petrovic is now visitor/);
  assert.equal((await door(invite.t, 'GET', '/api/audit')).status, 403);
  assert.match(await admin('status'), /Petra Petrovic\s+visitor/);
  const again = decode(/orch-invite-v1\.\S+/.exec(await admin('reinvite', 'Petra', 'Petrovic'))![0]);
  assert.equal((await door(invite.t, 'GET', '/api/me')).status, 401);
  assert.equal((await door(again.t, 'GET', '/api/me')).status, 200);
  assert.match(await admin('revoke', 'Petra', 'Petrovic'), /can no longer come in/);
  assert.equal((await door(again.t, 'GET', '/api/me')).status, 401);
  assert.match(await admin('revoke', 'Nobody'), /FAILED[\s\S]*no member called "Nobody"/);
  assert.match(await admin('service', '--address', 'https://office.example.test:4610'), /ExecStart=.*start-local\.mjs --door 4610 --address https:\/\/office\.example\.test:4610/);
  assert.match(await admin('close'), /Closed to the network/);
});
