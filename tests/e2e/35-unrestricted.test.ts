/**
 * Unrestricted: an employee who runs in Claude Code's bypass-permissions mode — the owner's default since
 * 2026-11-11 — with a real server, a real host agent, real tmux sessions and scripted workers.
 *
 *  - the session is started in bypass mode, and Claude Code's own warning is the owner's to accept, once per account;
 *  - nothing asks for permission any more — except the office's high-risk list, which is held for the owner's
 *    answer before the command runs, and refused when no answer comes;
 *  - a project's deny rules still hold; it is an owner's level to give; employees who were on Auto on the office's
 *    own machines are moved to it once, and one put back on Auto stays there.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mayCall } from '../../apps/server/src/access.ts';

// A home folder of its own: the "accepted the warning" mark of the scripted worker lives in it.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir().length > 40 ? '/tmp' : os.tmpdir(), 'orch-home-')));
process.env.HOME = home;
const { createHarness, waitFor, sleep } = await import('./harness.ts');
type Harness = Awaited<ReturnType<typeof createHarness>>;

let h: Harness;
let project = '';
const ids: Record<string, string> = {};
const paneOf = async (name: string) => h.tmux('capture-pane', '-p', '-J', '-S', '-200', '-t', (await h.session(ids[name]!))!.tmuxPane!);
const idle = (name: string) => waitFor(async () => (await h.session(ids[name]!))?.inTurn === false, { label: `${name} between turns`, timeout: 30000 });
const say = async (name: string, script: string) => {
  await idle(name);
  await h.api('POST', `/employees/${ids[name]}/message`, { body: `Go on. @@fake: ${script}@@` });
};

before(async () => {
  // The machine waits three seconds for an answer to a held command.
  h = await createHarness({ approvalWaitSeconds: 3 });
  project = (await h.project('Shop', h.makeRepo('shop'), { verifyCommand: null, policy: { deny: ['WebFetch'] } })).id;
  ids.Una = (await h.employee('Una', 'devops', { projectId: project, autonomy: 'unrestricted' })).id;
});
after(async () => {
  await h?.cleanup();
  fs.rmSync(home, { recursive: true, force: true });
});

test('started in bypass mode; Claude Code\'s warning waits for the owner, who accepts it once for that account', async () => {
  await h.api('POST', `/employees/${ids.Una}/start`, {});
  const session = (await h.session(ids.Una!))!;
  assert.match(h.tmux('list-panes', '-a', '-F', '#{session_name} #{pane_start_command}').split('\n').find((l) => l.startsWith(session.tmuxSession!))!, /--permission-mode bypassPermissions/);
  const q = await waitFor(async () => (await h.state()).questions.find((x) => x.employeeId === ids.Una && x.kind === 'trust_prompt' && x.status === 'open'), { label: 'the owner is asked about the warning', timeout: 30000 });
  assert.match(q.text, /accept responsibility before Una can run without permission checks/);
  assert.match(q.context ?? '', /you accept all responsibility/);
  assert.equal((await h.session(ids.Una!))!.activity, 'needs_approval');
  assert.equal(fs.existsSync(path.join(home, '.fake-bypass-accepted')), false, 'not accepted by the office itself');
  await h.api('POST', `/questions/${q.id}/answer`, { answer: 'Yes, I accept' });
  await waitFor(async () => (await h.session(ids.Una!))?.inTurn === false, { label: 'Una is up after the warning', timeout: 12000 }).catch(async (e) => {
    const qq = (await h.state()).questions.find((x) => x.id === q.id)!;
    const ses = await h.session(ids.Una!);
    throw new Error(`${e.message}\n${qq.status} | ${qq.deliveryDetail} | session ${ses?.status} inTurn=${ses?.inTurn} lastEventAt=${ses?.lastEventAt}\n${(await paneOf('Una')).split('\n').filter((l) => l.trim()).slice(-12).join('\n')}`);
  });
  assert.ok(fs.existsSync(path.join(home, '.fake-bypass-accepted')));
  // The next start on the same account is not asked again.
  await h.api('POST', `/employees/${ids.Una}/stop`, {});
  await waitFor(async () => (await h.session(ids.Una!))?.status !== 'running', { label: 'stopped', timeout: 15000 });
  await h.api('POST', `/employees/${ids.Una}/start`, {});
  await idle('Una');
  assert.equal((await h.state()).questions.filter((x) => x.employeeId === ids.Una && x.kind === 'trust_prompt').length, 1);
});

test('nothing asks for permission — commands and edits simply run; the project\'s deny rules still hold', async () => {
  const cwd = (await h.session(ids.Una!))!.cwd;
  await say('Una', 'bash echo built > out.txt; write notes.txt free; bash curl --version > /dev/null; say all-ran');
  await waitFor(async () => /all-ran/.test(await paneOf('Una')), { label: 'the script ran through', timeout: 30000 });
  assert.equal(fs.readFileSync(path.join(cwd, 'out.txt'), 'utf8').trim(), 'built');
  assert.ok(fs.existsSync(path.join(cwd, 'notes.txt')));
  assert.equal((await h.state()).questions.some((x) => x.employeeId === ids.Una && x.kind === 'permission'), false, 'nobody was asked');
  const settings = JSON.parse(fs.readFileSync(path.join(h.agentHome, 'sessions', (await h.session(ids.Una!))!.id, 'settings.json'), 'utf8'));
  assert.ok(settings.permissions.deny.includes('WebFetch'), 'the deny rule is given to Claude Code, which applies it in every mode');
});

test('a high-risk command is held for the owner before it runs: allowed it runs, denied it does not, unanswered it is refused', async () => {
  const cwd = (await h.session(ids.Una!))!.cwd;
  const origin = path.join(h.tmp, 'origin.git');
  h.git(h.tmp, 'init', '-q', '--bare', origin);
  h.git(cwd, 'remote', 'add', 'origin', origin);
  // Allowed.
  await say('Una', 'write a.txt 1; commit a; bash git push -q origin HEAD:refs/heads/one; say pushed-one');
  const q1 = await waitFor(() => h.openQuestion(ids.Una!, 'permission'), { label: 'the push is held', timeout: 30000 });
  assert.match(q1.text, /Una wants to run: .*git push/);
  assert.match(q1.why ?? '', /also for an employee who runs without permission checks/);
  assert.equal(h.git(origin, 'branch', '--list', 'one').trim(), '', 'not run before the answer');
  assert.equal((await h.session(ids.Una!))!.activity, 'needs_approval');
  await h.api('POST', `/questions/${q1.id}/answer`, { decision: 'allow' });
  await waitFor(async () => /pushed-one/.test(await paneOf('Una')), { label: 'went on after the allow', timeout: 20000 });
  assert.match(h.git(origin, 'branch', '--list', 'one'), /one/);
  await waitFor(async () => (await h.state()).questions.find((x) => x.id === q1.id)?.status === 'confirmed', { label: 'confirmed by the push itself', timeout: 15000 });
  // Denied.
  await say('Una', 'bash git push -q origin HEAD:refs/heads/two; say after-the-no');
  const q2 = await waitFor(() => h.openQuestion(ids.Una!, 'permission'), { label: 'the second push is held', timeout: 30000 });
  await h.api('POST', `/questions/${q2.id}/answer`, { decision: 'deny', answer: 'Not that branch.' });
  await waitFor(async () => /denied by hook: Not that branch\./.test(await paneOf('Una')) && /after-the-no/.test(await paneOf('Una')), { label: 'told no, and went on', timeout: 20000 });
  assert.equal(h.git(origin, 'branch', '--list', 'two').trim(), '');
  // Nobody answers: refused — there is no prompt in a terminal to fall back to in this mode.
  await say('Una', 'bash git push -q origin HEAD:refs/heads/three; say after-the-silence');
  const q3 = await waitFor(() => h.openQuestion(ids.Una!, 'permission'), { label: 'the third push is held', timeout: 30000 });
  await waitFor(async () => /needs the owner's approval\. The owner has not answered yet\./.test((await paneOf('Una')).replace(/\s+/g, ' ')) && /after-the-silence/.test(await paneOf('Una')), { label: 'refused for want of an answer', timeout: 20000 });
  assert.equal(h.git(origin, 'branch', '--list', 'three').trim(), '');
  assert.equal((await h.state()).questions.find((x) => x.id === q3.id)!.status, 'superseded');
  assert.ok((await h.state()).notifications.some((n) => /Una was refused a high-risk command: nobody answered/.test(n.title)));
  await sleep(1200);
  assert.equal(await h.openQuestion(ids.Una!, 'permission'), undefined, 'and nothing is asked about a prompt that does not exist');
});

test('an owner\'s level to give; those on Auto on the office\'s machines are moved once, and one put back on Auto stays', async () => {
  const engine = h.server.engine;
  for (const role of ['colleague', 'visitor'] as const) {
    const who = { kind: 'guest' as const, id: 'm1', name: 'M', role };
    assert.equal(mayCall(engine, who, 'PATCH', `/employees/${ids.Una}`, { autonomy: 'unrestricted' }).ok, false, role);
    assert.equal(mayCall(engine, who, 'POST', '/employees', { name: 'X', roleKey: 'backend', hostId: h.hostId, autonomy: 'unrestricted' }).ok, false, role);
  }
  assert.match(mayCall(engine, { kind: 'guest', id: 'm1', name: 'M', role: 'colleague' }, 'PATCH', `/employees/${ids.Una}`, { autonomy: 'unrestricted' }).reason ?? '', /Only an owner/);
  assert.equal(mayCall(engine, { kind: 'guest', id: 'm1', name: 'M', role: 'colleague' }, 'PATCH', `/employees/${ids.Una}`, { autonomy: 'auto' }).ok, true, 'lowering is anybody\'s who may work with them');
  // The one-time move: as on an office that was running before this existed.
  ids.Otto = (await h.employee('Otto', 'backend', { projectId: project, autonomy: 'auto' })).id;
  ids.Sue = (await h.employee('Sue', 'backend', { projectId: project, autonomy: 'standard' })).id;
  engine.core.store.kvSet('autonomy.unrestrictedDefault', 0);
  await h.restartServer();
  const after = (await h.state()).employees;
  assert.equal(after.find((e) => e.id === ids.Otto)!.autonomy, 'unrestricted', 'was on Auto');
  assert.equal(after.find((e) => e.id === ids.Sue)!.autonomy, 'standard', 'a lower level somebody chose is left alone');
  // Put back on Auto by the owner: it stays, also across the next start.
  await h.api('PATCH', `/employees/${ids.Otto}`, { autonomy: 'auto' });
  await h.restartServer();
  assert.equal((await h.state()).employees.find((e) => e.id === ids.Otto)!.autonomy, 'auto');
});

test('a change of level or of Claude account starts the session again: at once when idle, at the end of the turn when not', async () => {
  // A second account on this machine, already accepted for bypass and logged in.
  const second = path.join(home, '.claude-2');
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'second@example.test', organizationName: 'Org' } }));
  fs.writeFileSync(path.join(second, '.fake-bypass-accepted'), 'x');
  const cmd = async (name: string) => {
    const tmuxSession = (await h.session(ids[name]!))!.tmuxSession!;
    return h.tmux('list-panes', '-a', '-F', '#{session_name} #{pane_start_command}').split('\n').find((l) => l.startsWith(tmuxSession)) ?? '';
  };
  const restarted = async (name: string, since: string) => waitFor(async () => {
    const x = await h.session(ids[name]!);
    return x?.status === 'running' && x.startedAt !== since && x.inTurn === false ? x : null;
  }, { label: `${name} was started again`, timeout: 30000 });

  // Idle: put back on Auto → a new session in auto mode, the same conversation, and no message about it.
  await idle('Una');
  let before = (await h.session(ids.Una!))!;
  await h.api('PATCH', `/employees/${ids.Una}`, { autonomy: 'auto' });
  let now = await restarted('Una', before.startedAt!);
  assert.equal(now.resumed, true);
  assert.match(await cmd('Una'), /--permission-mode auto/);
  assert.equal((await h.state()).messages.some((m) => m.toEmployeeId === ids.Una && /started again because/.test(m.body)), false, 'somebody idle is not told');

  // …and on to another Claude account: a new session there.
  before = now;
  await h.api('PATCH', `/employees/${ids.Una}`, { claudeConfigDir: '~/.claude-2' });
  now = await restarted('Una', before.startedAt!);
  assert.match(await cmd('Una'), new RegExp(`CLAUDE_CONFIG_DIR=${home}/\\.claude-2`));

  // In the middle of a task: not cut off — started again when the turn ends, and told to go on.
  const task = await h.task({ projectId: project, title: 'Long work', assigneeId: ids.Una, description: '@@fake: sleep 2500; say end-of-first-turn@@' });
  await waitFor(async () => (await h.getTask(task.id)).delivery.status === 'confirmed' && (await h.session(ids.Una!))?.inTurn === true, { label: 'Una is in a turn', timeout: 30000 });
  before = (await h.session(ids.Una!))!;
  await h.api('PATCH', `/employees/${ids.Una}`, { autonomy: 'unrestricted' });
  assert.equal((await h.session(ids.Una!))!.startedAt, before.startedAt, 'not in the middle of the turn');
  now = await restarted('Una', before.startedAt!);
  assert.match(await cmd('Una'), /--permission-mode bypassPermissions/);
  assert.equal((await h.getTask(task.id)).nudges, 0, 'not nudged while it waited for the new start');
  const told = await waitFor(async () => (await h.state()).messages.find((m) => m.toEmployeeId === ids.Una && /^Your session was started again because your level is now Unrestricted\. Go on with T-\d+ "Long work"/.test(m.body)), { label: 'told to go on', timeout: 20000 });
  assert.ok(told);
  // The office itself restarted between the change and the end of the turn: the change is still carried out, because
  // the session's own mode shows that it no longer fits its employee's level.
  const long2 = await h.task({ projectId: project, title: 'More long work', assigneeId: ids.Una, description: '@@fake: sleep 3500; say end-of-that-turn@@' });
  await h.api('POST', `/tasks/${task.id}/stop`, { then: 'delete' });
  await waitFor(async () => (await h.getTask(long2.id)).delivery.status === 'confirmed' && (await h.session(ids.Una!))?.inTurn === true, { label: 'Una is in a turn again', timeout: 30000 });
  before = (await h.session(ids.Una!))!;
  await h.api('PATCH', `/employees/${ids.Una}`, { autonomy: 'auto' });
  await h.restartServer();
  now = await restarted('Una', before.startedAt!);
  assert.match(await cmd('Una'), /--permission-mode auto/);
  await h.api('POST', `/tasks/${long2.id}/stop`, { then: 'delete' });
  await h.api('PATCH', `/employees/${ids.Una}`, { autonomy: 'unrestricted' });
  await restarted('Una', now.startedAt!);
  // A change that needs no new start does not cause one.
  before = (await h.session(ids.Una!))!;
  await idle('Una');
  await h.api('PATCH', `/employees/${ids.Una}`, { title: 'Senior DevOps Engineer' });
  await sleep(1500);
  assert.equal((await h.session(ids.Una!))!.startedAt, before.startedAt);
});

test('several sessions of one account at the warning: the owner accepts once, and all of them go on', async () => {
  // A third account, not yet accepted; two employees are started on it together.
  const third = path.join(home, '.claude-3');
  fs.mkdirSync(third, { recursive: true });
  fs.writeFileSync(path.join(third, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'third@example.test', organizationName: 'Org' } }));
  for (const name of ['Ann', 'Ben']) {
    ids[name] = (await h.employee(name, 'backend', { projectId: project, autonomy: 'unrestricted' })).id;
    await h.api('PATCH', `/employees/${ids[name]}`, { claudeConfigDir: '~/.claude-3' });
  }
  await Promise.all(['Ann', 'Ben'].map((name) => h.api('POST', `/employees/${ids[name]}/start`, {})));
  const asked = await waitFor(async () => {
    const qs = (await h.state()).questions.filter((x) => (x.employeeId === ids.Ann || x.employeeId === ids.Ben) && x.kind === 'trust_prompt' && x.status === 'open');
    return qs.length === 2 ? qs : null;
  }, { label: 'both stand at the warning', timeout: 12000 }).catch(async (e) => {
    const st = await h.state();
    const out: string[] = [];
    for (const n of ['Ann', 'Ben']) {
      const x = await h.session(ids[n]!);
      out.push(`${n}: ${x?.status} ${x?.activity} lastEventAt=${x?.lastEventAt} | ${x?.tmuxPane ? h.tmux('capture-pane', '-p', '-J', '-S', '-12', '-t', x.tmuxPane).split('\n').filter((l) => l.trim()).slice(-6).join(' ⏎ ') : 'no pane'}`);
    }
    throw new Error(`${e.message}\n${JSON.stringify(st.questions.filter((x) => x.employeeId === ids.Ann || x.employeeId === ids.Ben).map((x) => [x.kind, x.status, x.text.slice(0, 60)]))}\n${out.join('\n')}`);
  });
  await h.api('POST', `/questions/${asked[0]!.id}/answer`, { answer: 'Yes, I accept' });
  await idle('Ann');
  await idle('Ben');
  const other = (await h.state()).questions.find((x) => x.id === asked[1]!.id)!;
  // Answered with the owner's one answer — and confirmed by that session starting.
  assert.ok(['delivered', 'confirmed'].includes(other.status), other.status);
  assert.equal(other.answer, 'Yes, I accept');
  const audit = await h.api<any[]>('GET', '/audit');
  assert.equal(audit.filter((a) => a.action === 'question.answer' && (a.target === asked[0]!.id || a.target === asked[1]!.id)).length, 1, 'the owner answered once');
});

test('a session that continues a conversation in a folder Claude Code does not trust yet: the prompt is seen and answered, as at a first start', async () => {
  // Seen live on 2026-11-11: sessions started again in their own subfolder stood at "Is this a project you trust?"
  // while the office showed nothing — it only looked for that prompt in sessions that had never given a sign of life.
  await idle('Una');
  const cwd = (await h.session(ids.Una!))!.cwd;
  // (Marked before the stop: with work in hand she may be started again by the office before this test does it.)
  // (In every folder she may be started in: the folder of the task she has in hand, or the project's.)
  const folders = [...new Set([cwd, path.join(fs.realpathSync(h.tmp), 'shop')])];
  for (const f of folders) fs.writeFileSync(path.join(f, '.fake-untrusted'), '');
  const answered = () => folders.some((f) => !fs.existsSync(path.join(f, '.fake-untrusted')));
  const before = (await h.session(ids.Una!))!.startedAt;
  await h.api('POST', `/employees/${ids.Una}/stop`, {});
  await h.apiRaw('POST', `/employees/${ids.Una}/start`, {});
  const session = await waitFor(async () => {
    const x = await h.session(ids.Una!);
    return x?.status === 'running' && x.startedAt !== before ? x : null;
  }, { label: 'started again', timeout: 20000 });
  assert.equal(session.resumed, true, 'the same conversation');
  // On Unrestricted (as on Auto) the folder the owner put them in is trusted for them, on the record.
  await waitFor(async () => (await h.session(ids.Una!))?.inTurn === false && answered(), { label: 'past the prompt and up', timeout: 20000 }).catch(async (e) => {
    const x = await h.session(ids.Una!);
    throw new Error(`${e.message}\nmarker in ${cwd} exists=${fs.existsSync(path.join(cwd, '.fake-untrusted'))} session.cwd now=${x?.cwd}\nstatus=${x?.status} inTurn=${x?.inTurn} startedAt=${x?.startedAt} lastEventAt=${x?.lastEventAt} activity=${x?.activity}\n${(await paneOf('Una')).split('\n').filter((l) => l.trim()).slice(-8).join('\n')}`);
  });
  const audit = await h.api<any[]>('GET', '/audit');
  assert.ok(audit.some((a) => a.action === 'trust.auto_accepted' && a.detail?.employee === 'Una'));
  for (const f of folders) fs.rmSync(path.join(f, '.fake-untrusted'), { force: true });
  // Somebody on a lower level is asked instead — and the answer is given in the terminal.
  ids.Stan = (await h.employee('Stan', 'backend', { projectId: project, autonomy: 'standard' })).id;
  await h.api('POST', `/employees/${ids.Stan}/start`, {});
  await idle('Stan');
  const stanCwd = (await h.session(ids.Stan!))!.cwd;
  fs.writeFileSync(path.join(stanCwd, '.fake-untrusted'), '');
  await h.api('POST', `/employees/${ids.Stan}/stop`, {});
  await waitFor(async () => (await h.session(ids.Stan!))?.status !== 'running', { label: 'Stan stopped', timeout: 15000 });
  await h.api('POST', `/employees/${ids.Stan}/start`, {});
  const q = await waitFor(async () => (await h.state()).questions.find((x) => x.employeeId === ids.Stan && x.kind === 'trust_prompt' && x.status === 'open'), { label: 'the owner is asked about the folder', timeout: 30000 });
  await h.api('POST', `/questions/${q.id}/answer`, { answer: 'Trust this folder' });
  await idle('Stan');
});
