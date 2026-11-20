import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import type { AgentSession, Employee } from '@orchestrator/contracts';
import { FAKE_AGENT_SDK, createHarness, waitFor, type Harness } from './harness.ts';

// The isolated test door creates a self-signed certificate.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fakeCodex = fileURLToPath(new URL('../fixtures/fake-codex.mjs', import.meta.url));
let h: Harness;
let originalCodexHome: string | undefined;

before(async () => {
  h = await createHarness();
  originalCodexHome = process.env.CODEX_HOME;
  const emptyHome = path.join(h.tmp, 'empty-codex-home');
  fs.mkdirSync(emptyHome);
  process.env.CODEX_HOME = emptyHome;
});

after(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  await h?.cleanup();
});

async function started(employee: Employee): Promise<AgentSession> {
  return waitFor(async () => {
    const s = await h.session(employee.id);
    return s?.status === 'running' && s.inTurn === false && s.codexThreadId ? s : null;
  }, { label: 'Codex thread ready' });
}

async function replyFor(employee: Employee, messageId: string) {
  await waitFor(async () => (await h.state()).messages.find((m) => m.id === messageId && m.delivery.status === 'confirmed' && m.delivery.via === 'codex'), { label: 'structured Codex delivery confirmed' });
  await waitFor(async () => (await h.api('GET', `/events?employeeId=${employee.id}&limit=100`)).find((e: any) => e.type === 'agent.turn_finished' && e.data.lastMessage === 'Codex reached the office tools.'), { label: 'Codex reply' });
}

test('an unavailable Codex worker reports the problem rather than switching providers', async () => {
  const employee = await h.employee('Unavailable Reviewer', 'reviewer', { executionMode: 'codex_managed', workingDir: h.makeRepo('missing-codex') });
  await assert.rejects(h.api('POST', `/employees/${employee.id}/start`, {}), /Codex is unavailable/);
  assert.equal(await h.session(employee.id), undefined);
});

test('a shared Codex worker completes a turn with office tools and resumes its own thread', async () => {
  const box = await h.addHost('codex-box', { codexBin: fakeCodex });
  const employee = await h.employee('Shared Reviewer', 'reviewer', { executionMode: 'codex_managed', hostId: box.hostId, workingDir: box.root });
  await h.api('POST', `/employees/${employee.id}/start`, {});
  const session = await started(employee);
  assert.equal(session.mode, 'codex_managed');
  assert.equal(session.hostId, box.hostId);
  assert.equal(session.claudeSessionId, null);
  const message = await h.api('POST', `/employees/${employee.id}/message`, { body: 'Check in with the office.' });
  await replyFor(employee, message.id);
  await h.api('POST', `/employees/${employee.id}/stop`, {});
  await h.api('POST', `/employees/${employee.id}/start`, {});
  const resumed = await started(employee);
  assert.equal(resumed.id, session.id);
  assert.equal(resumed.codexThreadId, session.codexThreadId);
});

test('a joined colleague hires and talks to Codex on their own enrolled host', async () => {
  const port = await new Promise<number>((resolve) => {
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1', () => {
      const port = (listener.address() as net.AddressInfo).port;
      listener.close(() => resolve(port));
    });
  });
  await h.api('POST', '/sharing', { open: true, port });
  const door = `https://127.0.0.1:${port}`;
  const invitation = await h.api('POST', '/guests', { name: 'A Colleague', role: 'colleague' });
  const { t } = JSON.parse(Buffer.from(invitation.invite.replace(/^orch-invite-v1\./, ''), 'base64url').toString('utf8'));
  const member = async <T>(method: string, endpoint: string, body?: Record<string, unknown>): Promise<T> => {
    const response = await fetch(`${door}/api${endpoint}`, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result as T;
  };
  const enrollment = await member<{ token: string }>('POST', '/me/host', {});
  const box = await h.addHost('colleague-codex', { codexBin: fakeCodex }, { serverUrl: door, enrollToken: enrollment.token });
  const employee = await member<Employee>('POST', '/employees', { name: 'Personal Reviewer', roleKey: 'reviewer', executionMode: 'codex_managed', hostId: box.hostId, workingDir: box.root });
  await member('POST', `/employees/${employee.id}/start`, {});
  const session = await started(employee);
  assert.equal(session.hostId, box.hostId);
  const message = await member<{ id: string }>('POST', `/employees/${employee.id}/message`, { body: 'Check in from my computer.' });
  await replyFor(employee, message.id);
});

test('a Claude author can hand off an office review to Codex', async () => {
  const box = await h.addHost('mixed-team', { codexBin: fakeCodex, sdkPath: FAKE_AGENT_SDK });
  const repo = path.join(box.root, 'mixed-repo');
  fs.mkdirSync(repo);
  h.git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Mixed team\n');
  h.git(repo, 'add', '-A');
  h.git(repo, 'commit', '-qm', 'Initial commit');
  const project = await h.project('Mixed team', repo, { hostId: box.hostId });
  const author = await h.employee('Claude Author', 'backend', { hostId: box.hostId, projectId: project.id, executionMode: 'managed_sdk' });
  const reviewer = await h.employee('Codex Reviewer', 'reviewer', { hostId: box.hostId, projectId: project.id, executionMode: 'codex_managed' });
  const task = await h.task({
    projectId: project.id, title: 'Add export note', assigneeId: author.id, reviewerId: reviewer.id, reviewBy: 'peer',
    description: 'Add export.txt containing ok. @@fake: write export.txt ok; commit export; complete Added export.txt with ok@@',
  });
  const finished = await waitFor(async () => {
    const current = await h.getTask(task.id);
    return current?.evidence.review?.verdict === 'approved' ? current : null;
  }, { label: 'Codex review verdict', timeout: 30_000 }).catch(async (error: Error) => {
    const state = await h.state();
    const relevant = state.tasks.filter((t) => t.projectId === project.id);
    const panes = state.sessions.filter((s) => s.employeeId === author.id || s.employeeId === reviewer.id);
    const screens = panes.filter((s) => s.tmuxPane && s.status === 'running').map((s) => box.tmux('capture-pane', '-p', '-S', '-50', '-t', s.tmuxPane!));
    throw new Error(`${error.message}
${JSON.stringify(relevant.map((t) => ({ key: t.key, status: t.status, delivery: t.delivery, reason: t.blockedReason, evidence: t.evidence })), null, 2)}
${screens.join(String.fromCharCode(10))}`);
  });
  assert.equal(finished.evidence.review?.reviewerId, reviewer.id);
  const reviewTask = await waitFor(async () => (await h.state()).tasks.find((t) => t.reviewOf === task.id && t.delivery.status === 'confirmed'), { label: 'review delivery' });
  assert.equal(reviewTask.delivery.via, 'codex');
});

test('a rejected start does not confirm prompt delivery', async () => {
  const box = await h.addHost('rejecting-codex', { codexBin: fakeCodex });
  const employee = await h.employee('Rejecting Reviewer', 'reviewer', { executionMode: 'codex_managed', hostId: box.hostId, workingDir: box.root });
  await h.api('POST', `/employees/${employee.id}/start`, {});
  await started(employee);
  const message = await h.api('POST', `/employees/${employee.id}/message`, { body: 'reject this test turn' });
  await waitFor(async () => {
    const session = await h.session(employee.id);
    return session?.status === 'exited' || session?.status === 'lost';
  }, { label: 'worker exit after rejected turn' });
  assert.notEqual((await h.state()).messages.find((m) => m.id === message.id)?.delivery.status, 'confirmed');
});

test('a Codex worker that starts a command anyway is stopped there, and the office is told why', async () => {
  const box = await h.addHost('shell-codex', { codexBin: fakeCodex });
  const employee = await h.employee('Shell Reviewer', 'reviewer', { executionMode: 'codex_managed', hostId: box.hostId, workingDir: box.root });
  await h.api('POST', `/employees/${employee.id}/start`, {});
  await started(employee);
  await h.api('POST', `/employees/${employee.id}/message`, { body: 'Please try a shell command.' });
  await waitFor(async () => {
    const session = await h.session(employee.id);
    return session?.status === 'exited' || session?.status === 'lost';
  }, { label: 'worker stopped at the command' });
  const events = await h.api('GET', `/events?employeeId=${employee.id}&limit=100`);
  assert.ok(events.some((e: any) => e.type === 'session.stopped' && /tried to run a command/.test(e.summary)), JSON.stringify(events.map((e: any) => e.summary)));
  assert.ok(!events.some((e: any) => e.type === 'agent.turn_finished' && e.data?.lastMessage === 'Codex reached the office tools.'));
});

test('a Codex worker writes and reads its folder through the workspace tools, and nothing outside it', async () => {
  const box = await h.addHost('workspace-codex', { codexBin: fakeCodex });
  const folder = path.join(box.root, 'work');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(box.root, 'outside.txt'), 'not theirs\n');
  const employee = await h.employee('Workspace Writer', 'backend', { executionMode: 'codex_managed', hostId: box.hostId, workingDir: folder });
  await h.api('POST', `/employees/${employee.id}/start`, {});
  await started(employee);
  await h.api('POST', `/employees/${employee.id}/message`, { body: 'Please use the workspace.' });
  const done = await waitFor(async () => (await h.api('GET', `/events?employeeId=${employee.id}&limit=100`)).find((e: any) => e.type === 'agent.turn_finished' && /^workspace/.test(e.data?.lastMessage ?? '')), { label: 'workspace turn' });
  assert.equal(done.data.lastMessage, 'workspace ok');
  assert.equal(fs.readFileSync(path.join(folder, 'from-codex.txt'), 'utf8'), 'hello from codex\n');
});
