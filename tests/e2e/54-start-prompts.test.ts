/**
 * Claude Code's own questions at the start of a session are answered by the office itself (the owner, 2026-11-13:
 * "say yes and trust the folder by itself instead of getting stuck", and of the warning about running without
 * permission checks: "this too should pass by itself") — on the record, and switched off with one switch.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A home folder of its own: the bypass warning is remembered per Claude config folder.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir().length > 40 ? '/tmp' : os.tmpdir(), 'orch-home-')));
process.env.HOME = home;
const { createHarness, waitFor, sleep } = await import('./harness.ts');
type Harness = Awaited<ReturnType<typeof createHarness>>;

let h: Harness;
let project = '';
let repo = '';
const ids: Record<string, string> = {};
const asked = async (name: string) => (await h.state()).questions.filter((x) => x.employeeId === ids[name] && x.kind === 'trust_prompt');
const audit = async (action: string, name: string) => (await h.api<any[]>('GET', '/audit')).filter((a) => a.action === action && a.detail?.employee === name);
const up = (name: string) => waitFor(async () => { const s = await h.session(ids[name]!); return s?.status === 'running' && s.inTurn === false ? s : null; }, { label: `${name} is up and between turns`, timeout: 30000 });

before(async () => {
  h = await createHarness();
  repo = h.makeRepo('shop');
  project = (await h.project('Shop', repo, { verifyCommand: null })).id;
});
after(async () => {
  await h?.cleanup();
  fs.rmSync(home, { recursive: true, force: true });
});

test('a folder Claude Code does not trust yet is trusted by the office for whoever was put there — also on Standard — and nobody is asked', async () => {
  assert.notEqual((await h.state()).settings.acceptStartPrompts, false, 'on unless switched off');
  fs.writeFileSync(path.join(repo, '.fake-untrusted'), '');
  ids.Stan = (await h.employee('Stan', 'backend', { projectId: project, autonomy: 'standard' })).id;
  await h.api('POST', `/employees/${ids.Stan}/start`, {});
  await up('Stan');
  assert.ok(!fs.existsSync(path.join(repo, '.fake-untrusted')), '"Yes, I trust this folder" was chosen');
  assert.deepEqual(await asked('Stan'), []);
  assert.equal((await audit('trust.auto_accepted', 'Stan')).length, 1);
  assert.ok((await h.api<any[]>('GET', '/events?limit=200')).some((e) => /was trusted for Claude Code without asking you/.test(e.summary) && e.employeeId === ids.Stan));
});

test('the warning about running without permission checks is accepted for somebody an owner put on Unrestricted, and it is on the record', async () => {
  ids.Una = (await h.employee('Una', 'devops', { projectId: project, autonomy: 'unrestricted' })).id;
  await h.api('POST', `/employees/${ids.Una}/start`, {});
  const s = await up('Una');
  assert.equal(s.permissionMode, 'bypassPermissions');
  assert.ok(fs.existsSync(path.join(home, '.fake-bypass-accepted')), '"Yes, I accept" was chosen');
  assert.deepEqual(await asked('Una'), []);
  const said = await audit('bypass.auto_accepted', 'Una');
  assert.equal(said.length, 1);
  assert.deepEqual([said[0]!.actor, said[0]!.detail.account], ['system', 'default']);
  assert.ok((await h.api<any[]>('GET', '/events?limit=200')).some((e) => /warning about running without permission checks was accepted/.test(e.summary) && e.employeeId === ids.Una));
});

test('the question about a folder added to the session, caught while Claude Code is still drawing it, is answered by the office when its answers appear — nobody is asked', async () => {
  // Seen on the live office: the words were on the screen a moment before "❯ No, exit / Yes, add it", the office
  // could not read the answers yet, and asked the owner — every time a session started.
  fs.writeFileSync(path.join(repo, '.fake-untrusted-dir'), '2500');
  ids.Dora = (await h.employee('Dora', 'backend', { projectId: project, autonomy: 'standard' })).id;
  await h.api('POST', `/employees/${ids.Dora}/start`, {});
  await up('Dora');
  assert.ok(!fs.existsSync(path.join(repo, '.fake-untrusted-dir')), '"Yes, add it" was chosen');
  assert.deepEqual(await asked('Dora'), []);
  const said = await audit('trust.auto_accepted', 'Dora');
  assert.equal(said.length, 1);
  assert.equal(said[0]!.detail.cwd, path.join(h.agentHome, 'files'), 'the added folder is the one on the record');
});

test('answers that are slow to appear: the owner is asked after a moment, and the question goes away when the office can answer it after all', async () => {
  await h.api('POST', `/employees/${ids.Dora}/stop`, {});
  fs.writeFileSync(path.join(repo, '.fake-untrusted-dir'), '7000');
  await h.api('POST', `/employees/${ids.Dora}/start`, {});
  const q = await waitFor(async () => (await asked('Dora')).find((x) => x.status === 'open'), { label: 'the owner is asked', timeout: 15000 });
  assert.match(q.text, new RegExp(`trust the folder ${path.join(h.agentHome, 'files').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `));
  await up('Dora');
  assert.ok(!fs.existsSync(path.join(repo, '.fake-untrusted-dir')), '"Yes, add it" was chosen');
  assert.equal((await asked('Dora')).find((x) => x.id === q.id)?.status, 'superseded');
  assert.equal((await audit('trust.auto_accepted', 'Dora')).length, 2);
});

test('switched off, the owner is asked as before: about the folder for somebody on Standard, and about the warning', async () => {
  await h.api('PATCH', '/settings', { acceptStartPrompts: false });
  // The folder, for somebody on Standard.
  await h.api('POST', `/employees/${ids.Stan}/stop`, {});
  fs.writeFileSync(path.join(repo, '.fake-untrusted'), '');
  await h.api('POST', `/employees/${ids.Stan}/start`, {});
  const q = await waitFor(async () => (await asked('Stan')).find((x) => x.status === 'open'), { label: 'the owner is asked about the folder', timeout: 30000 });
  assert.match(q.text, /whether to trust the folder/);
  assert.ok(fs.existsSync(path.join(repo, '.fake-untrusted')), 'nothing was answered for them');
  await h.api('POST', `/questions/${q.id}/answer`, { answer: 'Trust this folder' });
  await up('Stan');
  // The warning, for a new account in bypass mode.
  await h.api('POST', `/employees/${ids.Una}/stop`, {});
  fs.rmSync(path.join(home, '.fake-bypass-accepted'), { force: true });
  await h.api('POST', `/employees/${ids.Una}/start`, {});
  const w = await waitFor(async () => (await asked('Una')).find((x) => x.status === 'open' && x.tool?.name === 'bypass_warning'), { label: 'the owner is asked about the warning', timeout: 30000 });
  await sleep(800);
  assert.ok(!fs.existsSync(path.join(home, '.fake-bypass-accepted')), 'not accepted for them');
  assert.equal((await audit('bypass.auto_accepted', 'Una')).length, 1, 'only the one from before');
  await h.api('POST', `/questions/${w.id}/answer`, { answer: 'Yes, I accept' });
  await up('Una');
  // Only an owner changes the switch.
  const { mayCall } = await import('../../apps/server/src/access.ts');
  assert.equal(mayCall(h.server.engine, { kind: 'guest', id: 'm1', name: 'M', role: 'colleague' }, 'PATCH', '/settings', { acceptStartPrompts: true }).ok, false);
});
