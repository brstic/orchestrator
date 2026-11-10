/**
 * Other people in the office: invitations with a role, the guest door they come in through,
 * what each role may and may not do, seeing and talking to each other, and revoking access.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import type { ServerToClient } from '@orchestrator/contracts';
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
  const ws = new WebSocket(`${doorUrl.replace('https', 'wss')}/ws/client?token=${token}`);
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

test('the office is closed to the network until the owner opens the guest door', async () => {
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

test('an invitation is one string: the addresses, the certificate to trust, and a credential that is not the owner’s', async () => {
  for (const [name, role] of [['Mila', 'visitor'], ['Jovan', 'colleague']] as const) {
    const made = await h.api<any>('POST', '/guests', { name, role });
    invites[name] = decode(made.invite);
    guestIds[name] = made.guest.id;
    assert.deepEqual([invites[name]!.g, invites[name]!.r, invites[name]!.f], [name, role, fingerprint]);
    assert.match(invites[name]!.t, /^orch_guest_/);
    assert.notEqual(invites[name]!.t, h.token);
    assert.ok(invites[name]!.a.every((a) => /^https:\/\/[\d.]+:\d+$/.test(a)), 'the addresses of this machine on its networks');
  }
  assert.ok((await h.apiRaw('POST', '/guests', { name: 'mila' })).status >= 400, 'no two guests with one name');
  // Only hashes of the credentials are stored.
  assert.ok(!JSON.stringify(await h.api('GET', '/sharing')).includes(invites.Mila!.t));
});

test('the door lets through only what a person’s office window needs, and never the owner’s token', async () => {
  assert.equal((await door(null, 'GET', '/healthz')).status, 200);
  assert.equal((await door(null, 'GET', '/api/state')).status, 401, 'no credential, no office');
  assert.equal((await door(h.token, 'GET', '/api/state')).status, 401, 'the owner token is not accepted from the network');
  assert.equal((await door(h.token, 'GET', '/api/sharing')).status, 401);
  for (const p of ['/mcp', '/downloads/orchestrator-agent.mjs', '/install-agent.sh', '/api/../mcp']) assert.equal((await door(invites.Jovan!.t, p === '/mcp' ? 'POST' : 'GET', p)).status, 404, `${p} is not behind the door`);
  // No machine can enrol through the door either: the agent endpoint is not there.
  const agent = await new Promise<string>((resolve) => {
    const ws = new WebSocket(`${doorUrl.replace('https', 'wss')}/ws/agent`);
    ws.onopen = () => resolve('opened');
    ws.onerror = () => resolve('refused');
    ws.onclose = () => resolve('refused');
  });
  assert.equal(agent, 'refused');
  // A caller cannot pretend to be local by sending the door's mark themselves.
  const forged = await fetch(`${doorUrl}/api/state`, { headers: { authorization: `Bearer ${h.token}`, 'x-orch-door': 'anything' } });
  assert.equal(forged.status, 401);
});

test('a visitor sees the office and can change nothing; a colleague can work with employees but not decide for the owner', async () => {
  const mila = invites.Mila!.t;
  const jovan = invites.Jovan!.t;
  assert.deepEqual((await door(mila, 'GET', '/api/me')).body, { kind: 'guest', role: 'visitor', name: 'Mila', office: 'My Company' });
  const state = await door(mila, 'GET', '/api/state');
  assert.equal(state.status, 200);
  assert.ok(state.body.employees.some((e: any) => e.name === 'Alex'));
  for (const [method, p, body] of [
    ['POST', `/api/employees/${alex}/message`, { body: 'hello' }],
    ['POST', '/api/tasks', { projectId: state.body.projects[0].id, title: 'x' }],
    ['GET', `/api/employees/${alex}/docs`, undefined],
    ['GET', '/api/audit', undefined],
    ['PATCH', '/api/settings', { ownerName: 'Mila' }],
    ['POST', '/api/guests', { name: 'Friend' }],
  ] as const) {
    const r = await door(mila, method, p, body);
    assert.equal(r.status, 403, `${method} ${p} as a visitor`);
    assert.match(r.body.error, /Only the owner can do this — you are in this office as a visitor/);
  }
  // The colleague: talks to an employee (who is told it is not the boss), creates a task, reads documents.
  await door(jovan, 'POST', `/api/employees/${alex}/message`, { body: 'Could you look at the README? @@fake: say will-do-for-jovan@@' });
  const delivered = await waitFor(async () => (await h.state()).messages.find((m) => m.toEmployeeId === alex && /README/.test(m.body) && m.delivery.status === 'confirmed'), { label: 'colleague message delivered' });
  assert.match(delivered.from.name, /Jovan \(a colleague the boss invited; not the boss\)/);
  const task = await door(jovan, 'POST', '/api/tasks', { projectId: state.body.projects[0].id, title: 'From a colleague', released: false });
  assert.equal(task.status, 200);
  assert.equal((await door(jovan, 'GET', `/api/employees/${alex}/docs`)).status, 200);
  for (const [method, p, body] of [
    ['PATCH', '/api/settings', { autoAsksHighRisk: false }],
    ['POST', '/api/employees', { name: 'Hired By Guest' }],
    ['POST', `/api/employees/${alex}/stop`, {}],
    ['POST', '/api/ssh-links', { target: 'x@y' }],
    ['POST', '/api/hosts/enroll-token', {}],
    ['PATCH', `/api/projects/${state.body.projects[0].id}`, { policy: { allow: ['Bash'] } }],
    ['POST', '/api/commands/execute', { input: 'x', operations: [] }],
    ['PUT', '/api/layout', {}],
    ['GET', '/api/audit', undefined],
    ['DELETE', `/api/guests/${guestIds.Mila}`, undefined],
  ] as const) assert.equal((await door(jovan, method, p, body)).status, 403, `${method} ${p} as a colleague`);
  // An employee's question may be answered by a colleague; a permission request may not.
  await h.api('POST', `/employees/${alex}/message`, { body: 'Ask and then try. @@fake: ask Tabs or spaces?; bash git push origin main || true; say asked-and-tried@@' });
  const q = await waitFor(() => h.openQuestion(alex, 'question'), { label: 'a question' });
  assert.equal((await door(jovan, 'POST', `/api/questions/${q.id}/answer`, { answer: 'Spaces' })).status, 200);
  const perm = await waitFor(() => h.openQuestion(alex, 'permission'), { label: 'a permission request' });
  const refused = await door(jovan, 'POST', `/api/questions/${perm.id}/answer`, { decision: 'allow' });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /Only the owner can decide a permission request/);
  assert.equal((await h.state()).questions.find((x) => x.id === perm.id)!.status, 'open', 'still waiting for the owner');
  await h.api('POST', `/questions/${perm.id}/answer`, { decision: 'deny' });
  // What guests did is on the record under their names.
  const audit = await h.api<any[]>('GET', '/audit');
  assert.ok(audit.some((a) => a.action === 'guest.invited' && a.detail.name === 'Jovan' && a.detail.role === 'colleague'));
  assert.ok(audit.some((a) => a.actor === 'guest:Jovan' && a.action === 'guest.action' && /\/tasks$/.test(a.target)));
});

test('people see each other in the office and can talk; terminals follow the role', async () => {
  const boss = await h.client();
  const mila = join(invites.Mila!.t);
  const jovan = join(invites.Jovan!.t);
  const ready = await mila.until('ready');
  assert.deepEqual(ready.me, { kind: 'guest', role: 'visitor', name: 'Mila' });
  assert.deepEqual((await jovan.until('ready')).me, { kind: 'guest', role: 'colleague', name: 'Jovan' });
  // Everyone says where they are; everyone sees everyone.
  boss.send({ t: 'presence', x: 1, z: 2, rot: 0.5, moving: false } as any);
  mila.send({ t: 'presence', x: -3, z: 4, rot: 1, moving: true });
  jovan.send({ t: 'presence', x: 9999, z: Number.NaN, rot: 0, moving: false });
  const people = await jovan.until('people', (m) => m.people.length === 3);
  const by = (name: string) => people.people.find((p) => p.name === name)!;
  assert.deepEqual([by('Mila').role, by('Mila').x, by('Mila').z, by('Mila').moving], ['visitor', -3, 4, true]);
  assert.deepEqual([by('Jovan').x, by('Jovan').z], [500, 0], 'positions are kept within bounds');
  assert.equal(people.people.find((p) => p.role === 'owner')!.x, 1);
  assert.equal(new Set(people.people.map((p) => p.hue)).size, 3, 'each person has a colour of their own');
  // Talking: heard by everyone, with who said it; no flooding.
  mila.send({ t: 'say', text: '  Hello from the visitor\u0007  ' });
  const said = await waitFor(async () => boss.messages.find((m: any) => m.t === 'said') as any, { label: 'the owner hears it' });
  assert.deepEqual([said.from.name, said.from.role, said.text], ['Mila', 'visitor', 'Hello from the visitor']);
  for (let i = 0; i < 20; i++) mila.send({ t: 'say', text: `spam ${i}` });
  await sleep(600);
  assert.ok(jovan.got.filter((m) => m.t === 'said' && /^spam/.test((m as any).text)).length <= 8, 'at most eight lines in ten seconds');
  // Terminals: none for a visitor; read-only for a colleague.
  const session = (await h.session(alex))!;
  mila.send({ t: 'term.open', sessionId: session.id });
  assert.match((await mila.until('term.closed')).reason, /Visitors cannot see terminals/);
  assert.ok(!mila.got.some((m) => m.t === 'term.snapshot' || m.t === 'term.output' || m.t === 'term.screen'));
  jovan.send({ t: 'term.open', sessionId: session.id });
  await jovan.until('term.snapshot');
  jovan.send({ t: 'control.acquire', sessionId: session.id });
  jovan.send({ t: 'term.input', sessionId: session.id, data: 'echo typed-by-a-guest\r' });
  assert.match((await jovan.until('error')).message, /Only the owner can (take control of|type into) a terminal/);
  await sleep(500);
  assert.ok(!h.tmux('capture-pane', '-p', '-J', '-S', '-40', '-t', session.tmuxPane!).includes('typed-by-a-guest'), 'nothing reached the real terminal');
  // Someone leaving is gone from the others' view.
  mila.ws.close();
  await waitFor(async () => jovan.got.filter((m) => m.t === 'people').pop()?.t === 'people' && (jovan.got.filter((m) => m.t === 'people').pop() as any).people.length === 2, { label: 'Mila left' });
  jovan.ws.close();
  boss.close();
});

test('revoking a guest ends their session at once; a new invitation replaces the old one; the door survives a restart', async () => {
  const mila = join(invites.Mila!.t);
  await mila.until('ready');
  await h.api('DELETE', `/guests/${guestIds.Mila}`);
  await waitFor(async () => mila.closed() !== null, { label: 'the revoked guest is disconnected' });
  assert.equal((await door(invites.Mila!.t, 'GET', '/api/me')).status, 401);
  const again = await h.api<any>('POST', `/guests/${guestIds.Jovan}/reissue`, {});
  const fresh = decode(again.invite);
  assert.equal((await door(invites.Jovan!.t, 'GET', '/api/me')).status, 401, 'the old invitation no longer works');
  assert.equal((await door(fresh.t, 'GET', '/api/me')).body.role, 'colleague');
  // Changing the role takes effect for what they may do.
  await h.api('PATCH', `/guests/${guestIds.Jovan}`, { role: 'visitor' });
  assert.equal((await door(fresh.t, 'POST', `/api/employees/${alex}/message`, { body: 'x' })).status, 403);
  await h.restartServer();
  await waitFor(async () => (await door(fresh.t, 'GET', '/api/me').catch(() => ({ status: 0, body: null }))).status === 200, { label: 'the door is open again after a restart', timeout: 20000 });
  assert.equal((await h.api<any>('GET', '/sharing')).door.fingerprint, fingerprint, 'the same certificate: invitations stay valid');
  // Closing the door shuts the network out again.
  await h.api('POST', '/sharing', { open: false });
  assert.equal(await fetch(`${doorUrl}/healthz`).then(() => 'reachable', () => 'closed'), 'closed');
});
