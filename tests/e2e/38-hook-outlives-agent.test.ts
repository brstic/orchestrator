/**
 * A Claude Code hook outlives a restart of the machine's agent.
 *
 * The agent is what answers a session's hooks: it applies the office's high-risk list and holds a request while
 * somebody decides. When the agent was restarted (on a server: at every deploy, together with the office), a hook in
 * flight got no answer at all — and "no answer" means: Claude Code goes on by its own rules. For an employee in
 * bypass mode that is "run it": a high-risk command that was waiting for the owner ran because nobody was there to
 * refuse it. For everybody else the request fell to the prompt in the terminal.
 *
 * Now the hook itself tries again for a while when the agent does not answer, under the same name, so the agent that
 * comes back holds the same request and the office keeps the same question. And where the agent stays away, a
 * command of an employee in bypass mode is refused rather than run unchecked.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A home folder of its own: the "accepted the warning" mark of the scripted worker lives in it.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir().length > 40 ? '/tmp' : os.tmpdir(), 'orch-home-')));
process.env.HOME = home;
fs.writeFileSync(path.join(home, '.fake-bypass-accepted'), 'x');
const { createHarness, waitFor, sleep } = await import('./harness.ts');
type Harness = Awaited<ReturnType<typeof createHarness>>;

let h: Harness;
let project = '';
let origin = '';
const ids: Record<string, string> = {};
const panes: Record<string, string> = {};
const paneOf = (name: string) => h.tmux('capture-pane', '-p', '-J', '-S', '-200', '-t', panes[name]!).replace(/\s+/g, ' ');
const idle = (name: string) => waitFor(async () => (await h.session(ids[name]!))?.inTurn === false, { label: `${name} between turns`, timeout: 30000 });
const say = async (name: string, script: string) => {
  await idle(name);
  await h.api('POST', `/employees/${ids[name]}/message`, { body: `Go on. @@fake: ${script}@@` });
};
const hire = async (name: string, autonomy: string) => {
  ids[name] = (await h.employee(name, 'devops', { projectId: project, autonomy })).id;
  await h.api('POST', `/employees/${ids[name]}/start`, {});
  await idle(name);
  const s = (await h.session(ids[name]!))!;
  panes[name] = s.tmuxPane!;
  if (!fs.existsSync(path.join(s.cwd, '.git', 'refs', 'remotes'))) h.git(s.cwd, 'remote', 'add', 'origin', origin);
  return s;
};

before(async () => {
  // The machine waits twenty seconds for an answer; a hook tries for four seconds to reach an agent that is not there.
  h = await createHarness({ approvalWaitSeconds: 20, timings: { hookRejoinGraceMs: 1500 } });
  h.agentCfg.hookRetrySeconds = 4;
  await h.restartAgent();
  project = (await h.project('Shop', h.makeRepo('shop'), { verifyCommand: null })).id;
  origin = path.join(h.tmp, 'origin.git');
  h.git(h.tmp, 'init', '-q', '--bare', origin);
});
after(async () => {
  await h?.cleanup();
  fs.rmSync(home, { recursive: true, force: true });
});

test('bypass mode: the agent is restarted while a high-risk command waits for the owner — it still waits, and the owner\'s "no" still reaches it', async () => {
  const s = await hire('Una', 'unrestricted');
  assert.equal(s.permissionMode, 'bypassPermissions');
  await say('Una', 'write a.txt 1; commit a; bash git push -q origin HEAD:refs/heads/one; say after-the-restart');
  const q = await waitFor(() => h.openQuestion(ids.Una!, 'permission'), { label: 'the push is held', timeout: 30000 });
  await h.restartAgent();
  await sleep(2500);
  assert.equal(h.git(origin, 'branch', '--list', 'one').trim(), '', 'not run because the agent went away for a moment');
  assert.doesNotMatch(paneOf('Una'), /after-the-restart/);
  assert.deepEqual((await h.state()).questions.filter((x) => x.employeeId === ids.Una && x.status === 'open').map((x) => x.id), [q.id], 'the same request, asked once');
  await h.api('POST', `/questions/${q.id}/answer`, { decision: 'deny', answer: 'Not while I was away.' });
  await waitFor(() => /denied by hook: Not while I was away\./.test(paneOf('Una')) && /after-the-restart/.test(paneOf('Una')), { label: 'told no, and went on', timeout: 20000 });
  assert.equal(h.git(origin, 'branch', '--list', 'one').trim(), '');
});

test('bypass mode: allowed after the restart, it runs — once', async () => {
  await say('Una', 'bash git push -q origin HEAD:refs/heads/two; say pushed-two');
  const q = await waitFor(() => h.openQuestion(ids.Una!, 'permission'), { label: 'the push is held', timeout: 30000 });
  await h.restartAgent();
  await h.api('POST', `/questions/${q.id}/answer`, { decision: 'allow' });
  await waitFor(() => /pushed-two/.test(paneOf('Una')), { label: 'went on after the allow', timeout: 20000 });
  assert.match(h.git(origin, 'branch', '--list', 'two'), /two/);
  await waitFor(async () => (await h.state()).questions.find((x) => x.id === q.id)?.status === 'confirmed', { label: 'confirmed by the push itself', timeout: 15000 });
});

test('bypass mode: the agent stays away — a command is refused, not run unchecked; other tools go on; when the agent is back, so is the work', async () => {
  const cwd = (await h.session(ids.Una!))!.cwd;
  await say('Una', 'say una-at-work; sleep 2500; bash git push -q origin HEAD:refs/heads/three; write b.txt 2; bash echo second > second.txt; say after-the-outage; sleep 6000; say una-turn-ends');
  await waitFor(() => /una-at-work/.test(paneOf('Una')), { label: 'Una is at work', timeout: 30000 });
  await h.stopAgent();
  const from = Date.now();
  await waitFor(() => /after-the-outage/.test(paneOf('Una')), { label: 'the turn went on', timeout: 30000 });
  assert.match(paneOf('Una'), /denied by hook: Orchestrator: the office's agent on this machine cannot be reached/);
  assert.equal(h.git(origin, 'branch', '--list', 'three').trim(), '', 'the push was not run unchecked');
  assert.ok(fs.existsSync(path.join(cwd, 'b.txt')), 'a tool that is not a command went on');
  assert.ok(!fs.existsSync(path.join(cwd, 'second.txt')), 'no command at all is run while nothing can look at it');
  // The first hook waited its four seconds for the agent; those after it did not wait again.
  assert.ok(Date.now() - from < 2500 + 4000 + 5000, `the hooks after the first did not each wait (${Date.now() - from} ms)`);
  assert.ok(fs.existsSync(path.join(h.agentHome, 'agent.sock.away')), 'the mark that says the agent is away');
  await h.startAgent();
  assert.ok(!fs.readdirSync(h.agentHome).some((f) => f.endsWith('.away')), 'the agent took the mark away when it came back');
  await waitFor(() => /una-turn-ends/.test(paneOf('Una')), { label: 'the turn ended', timeout: 30000 });
  await say('Una', 'bash echo back > c.txt; say una-is-back');
  await waitFor(() => /una-is-back/.test(paneOf('Una')), { label: 'works again', timeout: 30000 });
  assert.ok(fs.existsSync(path.join(cwd, 'c.txt')));
});

test('other modes: a permission request and a question are held through a restart of the agent, too', async () => {
  const s = await hire('Dana', 'standard');
  await say('Dana', 'bash touch ci.txt; say dana-wrote');
  const q = await waitFor(() => h.openQuestion(ids.Dana!, 'permission'), { label: 'asked through the hook', timeout: 30000 });
  await h.restartAgent();
  await sleep(2500);
  assert.doesNotMatch(paneOf('Dana'), /Do you want to proceed\?/, 'Claude Code was not left to ask in the terminal');
  assert.deepEqual((await h.state()).questions.filter((x) => x.employeeId === ids.Dana && x.status === 'open').map((x) => [x.id, x.channel]), [[q.id, 'permission_hook']]);
  await h.api('POST', `/questions/${q.id}/answer`, { decision: 'allow' });
  await waitFor(() => /dana-wrote/.test(paneOf('Dana')), { label: 'went on', timeout: 20000 });
  assert.ok(fs.existsSync(path.join(s.cwd, 'ci.txt')));

  await say('Dana', 'askuser Which database?|Postgres|SQLite; say dana-chose');
  const ask = await waitFor(async () => (await h.state()).questions.find((x) => x.employeeId === ids.Dana && x.channel === 'ask_user_question_hook' && x.status === 'open'), { label: 'the question came through the hook', timeout: 30000 });
  await h.restartAgent();
  await sleep(2000);
  await h.api('POST', `/questions/${ask.id}/answer`, { answers: { 'Which database?': 'SQLite' } });
  await waitFor(() => /answer: SQLite/.test(paneOf('Dana')) && /dana-chose/.test(paneOf('Dana')), { label: 'the answer reached the tool', timeout: 20000 });
});

test('other modes: with the agent away for good nothing is refused — Claude Code asks in the terminal, as it always did', async () => {
  await say('Dana', 'say dana-at-work; sleep 2500; bash touch notes.txt; say dana-done');
  await waitFor(() => /dana-at-work/.test(paneOf('Dana')), { label: 'Dana is at work', timeout: 30000 });
  await h.stopAgent();
  await waitFor(() => /Do you want to proceed\?/.test(paneOf('Dana')), { label: 'the prompt is in the terminal', timeout: 30000 });
  assert.doesNotMatch(paneOf('Dana'), /denied by hook/);
  await h.startAgent();
  // Back, the office finds the prompt on her screen and asks about it from there.
  const asked = await waitFor(async () => (await h.state()).questions.find((x) => x.employeeId === ids.Dana && x.channel === 'terminal' && x.status === 'open'), { label: 'found on the screen', timeout: 30000 });
  await h.api('POST', `/questions/${asked.id}/answer`, { decision: 'allow' });
  await waitFor(() => /dana-done/.test(paneOf('Dana')), { label: 'Dana went on', timeout: 20000 });
});

test('a bypass session started with older hooks is started again by the office, once; others are left alone', async () => {
  await idle('Una');
  await idle('Dana');
  const before = { Una: (await h.session(ids.Una!))!, Dana: (await h.session(ids.Dana!))! };
  assert.deepEqual([before.Una.hooksVersion, before.Dana.hooksVersion], [2, 2]);
  // As if both had been started before the update: the agent's own record says so, and it reports that.
  await h.stopAgent();
  const stateFile = path.join(h.agentHome, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  let changed = 0;
  JSON.stringify(state, (_k, v) => {
    if (v && typeof v === 'object' && v.hooksVersion === 2) {
      delete v.hooksVersion;
      changed++;
    }
    return v;
  });
  assert.ok(changed >= 2, 'both sessions are in the agent\'s record');
  fs.writeFileSync(stateFile, JSON.stringify(state));
  await h.startAgent();
  const una = await waitFor(async () => {
    const x = await h.session(ids.Una!);
    return x?.status === 'running' && x.startedAt !== before.Una.startedAt && x.inTurn === false ? x : null;
  }, { label: 'Una is started again', timeout: 30000 });
  assert.deepEqual([una.hooksVersion, una.permissionMode, una.resumed], [2, 'bypassPermissions', true]);
  await sleep(3000);
  assert.equal((await h.session(ids.Una!))!.startedAt, una.startedAt, 'once');
  const dana = (await h.session(ids.Dana!))!;
  assert.deepEqual([dana.startedAt, dana.hooksVersion], [before.Dana.startedAt, 1], 'a session that is asked about what it does is not restarted for this');
});

test('a session is not started again for hooks its machine\'s agent could not better (no endless restarting behind an older agent)', async () => {
  await idle('Una');
  const before = (await h.session(ids.Una!))!;
  assert.equal(before.hooksVersion, 2);
  // Una's session as one with older hooks…
  await h.stopAgent();
  const stateFile = path.join(h.agentHome, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  JSON.stringify(state, (_k, v) => {
    if (v && typeof v === 'object' && v.hooksVersion === 2) delete v.hooksVersion;
    return v;
  });
  fs.writeFileSync(stateFile, JSON.stringify(state));
  await h.startAgent();
  // …on a machine whose agent says it writes no newer ones than those.
  const host = h.server.engine.core.hosts.get(h.hostId)!;
  host.info = { ...host.info!, hooksVersion: 1 };
  await sleep(5000);
  const still = (await h.session(ids.Una!))!;
  assert.deepEqual([still.startedAt, still.hooksVersion, still.status], [before.startedAt, 1, 'running'], 'left alone: starting it again would change nothing');
  assert.equal(h.server.engine.sessions.restartDue(still.id), false);
  // The agent is updated (it now says it writes the current ones): the session is started again, once.
  host.info = { ...host.info!, hooksVersion: 2 };
  assert.equal(h.server.engine.sessions.restartDue(still.id), true);
  await h.server.engine.sessions.restartNow(ids.Una!);
  const again = await waitFor(async () => {
    const x = await h.session(ids.Una!);
    return x?.status === 'running' && x.startedAt !== before.startedAt && x.inTurn === false ? x : null;
  }, { label: 'started again with the newer hooks', timeout: 30000 });
  assert.equal(again.hooksVersion, 2);
});
