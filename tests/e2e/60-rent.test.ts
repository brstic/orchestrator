/**
 * Renting employees out (`docs/RENT.md`), in a real office with real sessions (the scripted stand-in for Claude Code):
 * the owner makes a client and a link; the client sets a password with it and talks to the employees they rent on the
 * Rent portal; the answer comes back to that conversation and not to the owner's; the owner's own conversation stays
 * apart; a rented employee reaches only the colleagues the same client rents and only their folders, and does only
 * what the owner allows — changed live; and when the client is no longer a client, all of it ends.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

let h: Harness;
let kira: { id: string; workingDir: string | null };
let mila: { id: string; workingDir: string | null };
let bob: { id: string };
let clientId = '';
let token = '';
let link = '';
const outside = fs.mkdtempSync(path.join(os.homedir(), '.orch-rent-outside-'));
fs.writeFileSync(path.join(outside, 'secret.txt'), 'not for clients\n');

const raw = async (method: string, pathname: string, body?: unknown, bearer?: string) => {
  const res = await fetch(`${h.url}${pathname}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};
const portal = (method: string, pathname: string, body?: unknown) => raw(method, `/rent/api${pathname}`, body, token);
const linesOf = async (employeeId: string) => (await portal('GET', `/chats/${employeeId}`)).body.lines as Array<{ from: string; text: string; files?: Array<{ id: string; name: string }> }>;
const said = (employeeId: string, re: RegExp, timeout = 40_000) => waitFor(async () => (await linesOf(employeeId)).find((l) => l.from === 'agent' && re.test(l.text)), { label: `an answer ${re}`, timeout });
const codeOf = (url: string) => url.split('/r/')[1]!;

before(async () => {
  h = await createHarness();
  await h.api('POST', '/sharing', { address: 'https://office.example.test' });
  const kiraDir = h.makeRepo('kira-shop');
  const milaDir = h.makeRepo('mila-api');
  kira = await h.employee('Kira', 'backend', { workingDir: kiraDir, autonomy: 'auto' });
  mila = await h.employee('Mila', 'frontend', { workingDir: milaDir, autonomy: 'auto' });
  bob = await h.employee('Bob', 'qa', { workingDir: h.makeRepo('bob-ops'), autonomy: 'auto' });
});
after(async () => {
  await h.cleanup();
  fs.rmSync(outside, { recursive: true, force: true });
});

test('the owner makes a client who rents two employees, and gets a link that works once', async () => {
  const r = await h.api<any>('POST', '/rent/clients', { name: 'Ana Client', company: 'Acme', employeeIds: [kira.id, mila.id] });
  clientId = r.client.id;
  link = r.link;
  assert.match(link, /^https:\/\/office\.example\.test\/r\/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.deepEqual(r.client.agents.map((a: any) => a.name).sort(), ['Kira', 'Mila']);
  assert.equal(r.client.hasPassword, false);
  // One client per employee; and the names people sign in with are their own.
  assert.match((await h.apiRaw('POST', '/rent/clients', { name: 'Other', employeeIds: [kira.id] })).body.error, /rented to Ana Client already/);
  assert.match((await h.apiRaw('POST', '/rent/clients', { name: 'ana client' })).body.error, /taken/);
  // The list the owner's window reads: whom they can rent, and to whom each one is rented.
  const all = await h.api<any>('GET', '/rent');
  assert.equal(all.employees.find((e: any) => e.name === 'Kira').rentedTo, 'Ana Client');
  assert.equal(all.employees.find((e: any) => e.name === 'Bob').rentedTo, null);
});

test('the link: whose it is, then a password of their own — and it is used up', async () => {
  const code = codeOf(link);
  const info = await raw('GET', `/rent/join/${code}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.name, 'Ana Client');
  assert.deepEqual(info.body.agents.map((a: any) => a.name).sort(), ['Kira', 'Mila']);
  assert.match((await raw('POST', '/rent/join', { code, password: 'short' })).body.error, /at least 8/);
  const joined = await raw('POST', '/rent/join', { code, password: 'a good password 42' });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  token = joined.body.token;
  assert.equal((await raw('POST', '/rent/join', { code, password: 'another password 42' })).status, 410);
  // Signing in at the door with the client's name is a client's sign-in.
  const signed = await raw('POST', '/login', { username: 'ana client', password: 'a good password 42' });
  assert.equal(signed.body.kind, 'client');
  assert.ok(signed.body.token);
  assert.equal((await raw('POST', '/login', { username: 'Ana Client', password: 'wrong password!!' })).status, 401);
});

test('a client reaches the portal and nothing else of the office', async () => {
  const me = await portal('GET', '/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.agents.map((a: any) => a.name).sort(), ['Kira', 'Mila']);
  assert.equal(JSON.stringify(me.body).includes('workingDir'), false, 'no folders');
  for (const p of ['/api/state', '/api/me', '/api/events', '/api/rent']) assert.equal((await raw('GET', p, undefined, token)).status, 401, p);
  assert.equal((await portal('GET', `/chats/${bob.id}`)).status, 404, 'an employee they do not rent');
  assert.equal((await raw('GET', '/rent/api/me')).status, 401);
});

test('what the client writes reaches the session, and the answer comes back to their conversation — not to the owner', async () => {
  const sent = await portal('POST', `/chats/${kira.id}`, { text: 'Hello Kira, how is the shop? @@fake: say client-answer-1188@@' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await said(kira.id, /client-answer-1188/);
  const st = await h.state();
  const m = st.messages.find((x) => x.channel === 'rent' && /client-answer-1188/.test(x.body))!;
  assert.equal(m.clientId, clientId);
  assert.match(m.body, /^On the Rent portal, Ana Client \(Acme\) writes/);
  assert.match(m.body, /Your reply goes to Ana Client on the portal/);
  assert.match(m.body, /in those of Mila/);
  // The end of that turn carries the client: the owner's Talk leaves it out.
  const events = await h.api<any[]>('GET', `/events?employeeId=${kira.id}&limit=200`);
  assert.ok(events.some((e) => e.type === 'agent.turn_finished' && e.data.rentClientId === clientId && /client-answer-1188/.test(e.data.lastMessage)));
  // The owner talks to Kira: that answer is the owner's, and the client's conversation does not get it.
  await h.api('POST', `/employees/${kira.id}/message`, { body: 'Kira, a word from the office @@fake: say owner-answer-2277@@' });
  await waitFor(async () => (await h.api<any[]>('GET', `/events?employeeId=${kira.id}&limit=200`)).find((e) => e.type === 'agent.turn_finished' && /owner-answer-2277/.test(e.data.lastMessage) && !e.data.rentClientId), { label: "the owner's answer", timeout: 40_000 });
  await sleep(500);
  assert.equal((await linesOf(kira.id)).some((l) => /owner-answer-2277/.test(l.text)), false, "the owner's conversation reached the client");
  // The owner reads the client's conversation in Access → Rent.
  const theirs = await h.api<any>('GET', `/rent/clients/${clientId}/chats/${kira.id}`);
  assert.deepEqual(theirs.lines.map((l: any) => l.from), ['client', 'agent']);
});

test('a rented employee works with the colleagues the same client rents, and nobody else', async () => {
  await portal('POST', `/chats/${kira.id}`, { text: 'Ask the others @@fake: mcp send_message {"to":"Bob","message":"hi Bob"}; result to-bob.txt; mcp send_message {"to":"Mila","message":"hi Mila"}; result to-mila.txt; mcp vault_list; result vault.txt; say asked-around-3366@@' });
  await said(kira.id, /asked-around-3366/);
  const read = (f: string) => fs.readFileSync(path.join(kira.workingDir!, f), 'utf8');
  assert.match(read('to-bob.txt'), /^ERROR No teammate matches "Bob"/);
  assert.doesNotMatch(read('to-mila.txt'), /^ERROR/);
  assert.match(read('vault.txt'), /^ERROR .*not yours to use/);
  // And the other way: Bob, who nobody rents, does not reach Kira.
  await h.api('POST', `/employees/${bob.id}/start`, {});
  await waitFor(async () => (await h.session(bob.id))?.status === 'running', { label: 'Bob at work', timeout: 20_000 });
  await h.api('POST', `/employees/${bob.id}/message`, { body: 'go @@fake: mcp send_message {"to":"Kira","message":"hi"}; result to-kira.txt; say bob-done-4455@@' });
  await waitFor(async () => (await h.api<any[]>('GET', `/events?employeeId=${bob.id}&limit=100`)).find((e) => e.type === 'agent.turn_finished' && /bob-done-4455/.test(e.data.lastMessage)), { label: "Bob's turn", timeout: 40_000 });
  const bobDir = (await h.state()).employees.find((e) => e.id === bob.id)!.workingDir!;
  assert.match(fs.readFileSync(path.join(bobDir, 'to-kira.txt'), 'utf8'), /^ERROR No teammate matches "Kira"/);
});

test('the fence: their folders only, and only what the owner allows — changed live, without a restart', async () => {
  const kiraDir = kira.workingDir!;
  const milaDir = mila.workingDir!;
  await portal('POST', `/chats/${kira.id}`, { text: `Look around @@fake: bash cat ${path.join(outside, 'secret.txt')} > leak.txt; bash ls ${milaDir} > mila-ls.txt; bash echo inside > inside.txt; say fenced-5544@@` });
  await said(kira.id, /fenced-5544/);
  assert.equal(fs.existsSync(path.join(kiraDir, 'leak.txt')), false, 'a file outside their folders was read');
  assert.equal(fs.existsSync(path.join(kiraDir, 'mila-ls.txt')), true, "a co-rented colleague's folder");
  assert.equal(fs.readFileSync(path.join(kiraDir, 'inside.txt'), 'utf8').trim(), 'inside');
  // The owner takes commands and changing files away: at once, in the session that is running.
  const session = await h.session(kira.id);
  await h.api('PATCH', `/rent/clients/${clientId}/agents/${kira.id}`, { perms: { commands: false, edit: false } });
  await sleep(300);
  await portal('POST', `/chats/${kira.id}`, { text: 'Again @@fake: bash echo no > cmd.txt; write written.txt nope; say limited-6633@@' });
  await said(kira.id, /limited-6633/);
  assert.equal(fs.existsSync(path.join(kiraDir, 'cmd.txt')), false, 'a command ran');
  assert.equal(fs.existsSync(path.join(kiraDir, 'written.txt')), false, 'a file was written');
  assert.equal((await h.session(kira.id))?.id, session?.id, 'the session was restarted');
  await h.api('PATCH', `/rent/clients/${clientId}/agents/${kira.id}`, { perms: { commands: true, edit: true } });
});

test('a file the employee gives goes to the client, and the client downloads it from their conversation only', async () => {
  fs.writeFileSync(path.join(kira.workingDir!, 'report.txt'), 'the report\n');
  await portal('POST', `/chats/${kira.id}`, { text: 'Send me the report @@fake: mcp attach_file {"path":"report.txt","caption":"Here it is"}; say file-sent-7722@@' });
  await said(kira.id, /file-sent-7722/);
  const line = (await linesOf(kira.id)).find((l) => l.files?.some((f) => f.name === 'report.txt'))!;
  assert.ok(line, 'the file is in the conversation');
  const res = await fetch(`${h.url}/rent/api/chats/${kira.id}/files/${line.files![0]!.id}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'the report\n');
  assert.equal((await raw('GET', `/rent/api/chats/${mila.id}/files/${line.files![0]!.id}`, undefined, token)).status, 404, "another conversation's file");
});

test('when the client is no longer a client, everything they came in with ends, and their employees are the office\'s again', async () => {
  await h.api('DELETE', `/rent/clients/${clientId}`);
  assert.equal((await portal('GET', '/me')).status, 401);
  assert.equal((await raw('POST', '/login', { username: 'Ana Client', password: 'a good password 42' })).status, 401);
  const all = await h.api<any>('GET', '/rent');
  assert.equal(all.employees.find((e: any) => e.name === 'Kira').rentedTo, null);
  // Kira reaches Bob again, and works outside her folder again.
  await h.api('POST', `/employees/${kira.id}/message`, { body: 'Back @@fake: mcp send_message {"to":"Bob","message":"hello again"}; result to-bob-2.txt; say free-8811@@' });
  await waitFor(async () => (await h.api<any[]>('GET', `/events?employeeId=${kira.id}&limit=200`)).find((e) => e.type === 'agent.turn_finished' && /free-8811/.test(e.data.lastMessage)), { label: 'free again', timeout: 40_000 });
  assert.doesNotMatch(fs.readFileSync(path.join(kira.workingDir!, 'to-bob-2.txt'), 'utf8'), /^ERROR/);
});
