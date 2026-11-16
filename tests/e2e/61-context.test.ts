/**
 * The central context (`docs/CONTEXT.md`), in a real office with real sessions (the scripted stand-in reads the
 * `additionalContext` Claude Code's hooks hand it): a fact is in front of an employee when their session starts, again
 * whole after a compaction, and as the change at their next prompt; employees propose facts (their own notes go in at
 * once, the office's wait for a person); get_context finds what is on demand; a rented employee is not given what is
 * kept from clients, and gets their client's facts with that client's messages; the office knows which version each
 * session holds; who may write what.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

let h: Harness;
let kira: { id: string; workingDir: string | null };
let lea: { id: string; workingDir: string | null };
let projectId = '';

const tell = async (who: { id: string }, body: string, done: RegExp) => {
  await h.api('POST', `/employees/${who.id}/message`, { body });
  await waitFor(async () => (await h.api<any[]>('GET', `/events?employeeId=${who.id}&limit=300`)).find((e) => e.type === 'agent.turn_finished' && done.test(String(e.data.lastMessage))), { label: String(done), timeout: 40_000 });
};
const read = (who: { workingDir: string | null }, f: string) => fs.readFileSync(path.join(who.workingDir!, f), 'utf8');
const ctx = () => h.api<any>('GET', '/context');

before(async () => {
  h = await createHarness();
  const repo = h.makeRepo('ctx-shop');
  const project = await h.project('Shop', repo);
  projectId = project.id;
  // Facts that exist before anybody starts.
  await h.api('POST', '/context/facts', { layer: 'office', title: 'How we deploy', text: 'Always from main, with ./deploy.sh — never by hand.' });
  await h.api('POST', '/context/facts', { layer: 'office', title: 'Margins', text: 'Our margin on hosting is 40%.', notForClients: true });
  await h.api('POST', '/context/facts', { layer: 'project', scope: projectId, title: 'Shop stack', text: 'Next.js and PostgreSQL; staging is shop-staging.' });
  await h.api('POST', '/context/facts', { layer: 'office', title: 'Old invoices', text: 'Invoices before 2025 are in the archive folder.', always: false });
  kira = await h.employee('Kira', 'backend', { projectId, workingDir: repo, autonomy: 'auto' });
  lea = await h.employee('Lea', 'frontend', { workingDir: h.makeRepo('ctx-lea'), autonomy: 'auto' });
});
after(async () => {
  await h.cleanup();
});

test('a session starts with the central context in front of it: the office, its project, the team — not what is on demand', async () => {
  await h.api('POST', `/employees/${kira.id}/start`, {});
  await waitFor(async () => (await h.session(kira.id))?.status === 'running', { label: 'Kira at work', timeout: 20_000 });
  await tell(kira, 'What do you know? @@fake: ctx seen-start.txt; say start-seen-1111@@', /start-seen-1111/);
  const seen = read(kira, 'seen-start.txt');
  assert.match(seen, /\[startup\]\n# The office's central context/);
  assert.match(seen, /\*\*How we deploy\*\* — Always from main/);
  assert.match(seen, /## Project Shop\n- \*\*Shop stack\*\*/);
  assert.match(seen, /\*\*The team you can reach\*\* — Lea \(Frontend/);
  assert.doesNotMatch(seen, /Invoices before 2025/, 'an on-demand fact is not in the pack');
  assert.match(seen, /1 more fact on demand: get_context/);
  // The office knows the session holds the current version.
  const s = (await ctx()).sessions.find((x: any) => x.name === 'Kira');
  assert.equal(s.holds, s.current);
});

test('a fact changes: the next prompt of a running session gets the change — only the change', async () => {
  const fact = (await ctx()).facts.find((f: any) => f.title === 'How we deploy');
  await h.api('PATCH', `/context/facts/${fact.id}`, { text: 'Always from main, with ./deploy.sh — and tell the boss after.' });
  await h.api('POST', '/context/facts', { layer: 'project', scope: projectId, title: 'Shop freeze', text: 'No deploys of the shop on Fridays.' });
  await sleep(600);
  await tell(kira, 'Again @@fake: ctx seen-change.txt; say change-seen-2222@@', /change-seen-2222/);
  const seen = read(kira, 'seen-change.txt');
  assert.match(seen, /\[prompt\]\n# The office's central context changed \(version [0-9a-f]{8} → [0-9a-f]{8}\)/);
  assert.match(seen, /- Changed \(The office\): \*\*How we deploy\*\* — Always from main, with \.\/deploy\.sh — and tell the boss after\./);
  assert.match(seen, /- New \(Project Shop\): \*\*Shop freeze\*\*/);
  assert.doesNotMatch(seen.split('[prompt]').pop()!, /Shop stack/, 'what did not change is not said again');
  // Nothing changed since: the next prompt is given nothing.
  await tell(kira, 'Once more @@fake: ctx seen-same.txt; say same-3333@@', /same-3333/);
  assert.equal(read(kira, 'seen-same.txt').split('[prompt]').length, read(kira, 'seen-change.txt').split('[prompt]').length);
});

test('after a compaction — when a session loses what it was told — the whole context is given again', async () => {
  await tell(kira, 'Compact @@fake: compact; ctx seen-compact.txt; say compacted-4444@@', /compacted-4444/);
  const seen = read(kira, 'seen-compact.txt');
  assert.match(seen, /^\[compact\]\n# The office's central context/);
  assert.match(seen, /Shop freeze/);
  assert.match(seen, /and tell the boss after/);
});

test('get_context finds what is on demand; propose_context: one\'s own notes go in at once, the office\'s wait for a person', async () => {
  await tell(
    kira,
    'Look and note @@fake: mcp get_context {"topic":"invoices"}; result found.txt; mcp propose_context {"layer":"self","title":"In the middle of","text":"Moving the cart to the new API, half done."}; result self.txt; mcp propose_context {"layer":"office","title":"Coffee","text":"The office orders coffee on Mondays."}; result office.txt; say noted-5555@@',
    /noted-5555/,
  );
  assert.match(read(kira, 'found.txt'), /## Old invoices[\s\S]*archive folder/);
  assert.match(read(kira, 'self.txt'), /In the central context now \(self\)/);
  assert.match(read(kira, 'office.txt'), /^Proposed: "Coffee"/);
  const facts = (await ctx()).facts;
  assert.equal(facts.find((f: any) => f.title === 'In the middle of').status, 'active');
  const coffee = facts.find((f: any) => f.title === 'Coffee');
  assert.equal(coffee.status, 'proposed');
  assert.ok((await h.state()).notifications.some((n) => /Proposed for the central context by Kira/.test(n.title)));
  // Taken in by a person (edited on the way): it reaches everyone at their next prompt.
  await h.api('POST', `/context/facts/${coffee.id}/accept`, { text: 'Coffee is ordered on Mondays by whoever is in first.' });
  await sleep(600);
  await tell(kira, 'And now @@fake: ctx seen-accept.txt; say accepted-6666@@', /accepted-6666/);
  assert.match(read(kira, 'seen-accept.txt').split('[prompt]').pop()!, /New \(The office\): \*\*Coffee\*\* — Coffee is ordered on Mondays by whoever is in first\./);
  // One's own notes are one's own: Lea does not hold Kira's.
  const leaPack = await h.api<any>('GET', `/context/pack/${lea.id}`);
  assert.doesNotMatch(leaPack.text, /In the middle of/);
  assert.doesNotMatch(leaPack.text, /Shop stack/, "not on Kira's project");
  assert.match(leaPack.text, /Coffee is ordered/);
});

test("a rented employee holds the office's context but what is kept from clients, and gets their client's facts with that client's words", async () => {
  await h.api('POST', '/sharing', { address: 'https://office.example.test' });
  const made = await h.api<any>('POST', '/rent/clients', { name: 'Ana Client', employeeIds: [lea.id] });
  await h.api('POST', '/context/facts', { layer: 'client', scope: made.client.id, title: 'Ana wants', text: 'Copy in Serbian, always.' });
  const pack = await h.api<any>('GET', `/context/pack/${lea.id}`);
  assert.match(pack.text, /How we deploy/);
  assert.doesNotMatch(pack.text, /margin on hosting/, 'kept from clients');
  assert.doesNotMatch(pack.text, /Copy in Serbian/, "a client's facts come with that client's messages");
  const kiraPack = await h.api<any>('GET', `/context/pack/${kira.id}`);
  assert.match(kiraPack.text, /margin on hosting/, 'an employee nobody rents holds it');
  const joined = await fetch(`${h.url}/rent/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: made.link.split('/r/')[1], password: 'a good password 1' }) }).then((r) => r.json() as Promise<any>);
  await fetch(`${h.url}/rent/api/chats/${lea.id}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${joined.token}` }, body: JSON.stringify({ text: 'Hello @@fake: say hi-ana-7777@@' }) });
  const m = await waitFor(async () => (await h.state()).messages.find((x) => x.channel === 'rent' && /hi-ana-7777/.test(x.body)), { label: "the client's message" });
  assert.match(m.body, /What the office knows about Ana Client \(the central context\):\n- \*\*Ana wants\*\* — Copy in Serbian, always\./);
});

test('who may write what: a colleague writes the office\'s and a project\'s facts, not a client\'s; a visitor reads nothing', async () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const port = 20000 + Math.floor(Math.random() * 20000);
  await h.api('POST', '/sharing', { open: true, port });
  const door = `https://127.0.0.1:${port}`;
  const member = async (name: string, role: string) => {
    const g = await h.api<any>('POST', '/sharing', { address: null }).then(() => h.api<any>('POST', '/guests', { name, role }));
    return JSON.parse(Buffer.from(String(g.invite).replace(/^orch-invite-v1\./, ''), 'base64url').toString('utf8')).t as string;
  };
  const vera = await member('Vera', 'colleague');
  const mila = await member('Mila', 'visitor');
  const as = (t: string, method: string, p: string, b?: unknown) => fetch(`${door}/api${p}`, { method, headers: { authorization: `Bearer ${t}`, ...(b ? { 'content-type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as any }));
  assert.equal((await as(vera, 'POST', '/context/facts', { layer: 'office', title: 'Standup', text: 'At 10.' })).status, 200);
  assert.equal((await as(vera, 'POST', '/context/facts', { layer: 'project', scope: projectId, title: 'Shop tests', text: 'npm test must pass.' })).status, 200);
  const client = (await h.api<any>('GET', '/rent')).clients[0].id;
  assert.equal((await as(vera, 'POST', '/context/facts', { layer: 'client', scope: client, title: 'x', text: 'y' })).status, 403);
  const seen = await as(vera, 'GET', '/context');
  assert.equal(seen.body.facts.some((f: any) => f.layer === 'client'), false, "a client's facts are the owners'");
  assert.equal((await as(mila, 'GET', '/context')).status, 403);
  assert.equal((await as(mila, 'POST', '/context/facts', { layer: 'office', title: 'x', text: 'y' })).status, 403);
});

test('whichever Claude account an employee runs on (another config folder, as a Z.AI account is), the same context reaches them — and whole again after a compaction', async () => {
  // (An account folder lives in the home folder, as the office's own accounts do.)
  const other = fs.mkdtempSync(path.join(os.homedir(), '.claude-ctx-test-'));
  after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.writeFileSync(path.join(other, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'second@example.test', organizationName: 'Org' } }));
  const ben = await h.employee('Ben', 'backend', { projectId, workingDir: h.makeRepo('ctx-ben'), autonomy: 'auto', claudeConfigDir: other });
  await h.api('POST', `/employees/${ben.id}/start`, {});
  await waitFor(async () => (await h.session(ben.id))?.status === 'running', { label: 'Ben at work', timeout: 20_000 });
  await tell(ben, 'Hi @@fake: ctx b-start.txt; compact; ctx b-compact.txt; say ben-7777@@', /ben-7777/);
  const start = read(ben, 'b-start.txt');
  const compacted = read(ben, 'b-compact.txt');
  assert.match(start, /\[startup\][\s\S]*Shop stack/);
  assert.match(compacted, /^\[compact\]\n# The office's central context[\s\S]*Shop stack/);
  const s = (await ctx()).sessions.find((x: any) => x.name === 'Ben');
  assert.equal(s.holds, s.current);
});
