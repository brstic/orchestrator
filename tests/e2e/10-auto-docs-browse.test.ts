/**
 * Auto mode (no permission questions, only real decisions), an employee's
 * Markdown documents, and choosing a folder by browsing the machine.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

let h: Harness;
let folder = '';
let ivy: any;

const idle = (id: string) => waitFor(async () => (await h.session(id))!.inTurn === false, { label: 'idle' });

before(async () => {
  h = await createHarness();
  folder = h.makeRepo('journal');
  fs.mkdirSync(path.join(folder, 'docs', 'adr'), { recursive: true });
  fs.mkdirSync(path.join(folder, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'CLAUDE.md'), '# Journal\nProject instructions.\n');
  fs.writeFileSync(path.join(folder, 'docs', 'PLAN.md'), '# Plan\n- [ ] first\n');
  fs.writeFileSync(path.join(folder, 'docs', 'adr', '0001.md'), '# ADR 1\n');
  fs.writeFileSync(path.join(folder, 'node_modules', 'pkg', 'README.md'), '# not ours\n');
  fs.writeFileSync(path.join(folder, 'secret.txt'), 'not markdown\n');
  h.git(folder, 'add', '-A');
  h.git(folder, 'commit', '-q', '-m', 'docs');
});
after(async () => {
  await h.cleanup();
});

test('a tmux server whose start directory was deleted still starts workers in their own folder', async () => {
  // What an app update does: the tmux server was started from a directory that is then replaced.
  const doomed = path.join(h.tmp, 'old-app-bundle');
  fs.mkdirSync(doomed);
  execFileSync('tmux', ['-u', '-L', h.tmuxSocket, 'new-session', '-d', '-s', 'keeper', 'sleep 600'], { cwd: doomed });
  fs.rmSync(doomed, { recursive: true });
  const amy = await h.api('POST', '/employees', { name: 'Amy', roleKey: 'backend', hostId: h.hostId, workingDir: folder, autonomy: 'standard' });
  const session = await h.api('POST', `/employees/${amy.id}/start`, {});
  await waitFor(async () => (await h.session(amy.id))!.inTurn === false, { label: 'started despite the dead server directory' });
  assert.equal(h.tmux('display-message', '-p', '-t', session.tmuxPane, '#{pane_current_path}').trim(), folder);
  // The program really runs there: what it writes with a relative path lands in the folder.
  await h.api('POST', `/employees/${amy.id}/message`, { body: 'Leave a mark. @@fake: bash git status --short; write where.txt here; say located@@' });
  await waitFor(() => fs.existsSync(path.join(folder, 'where.txt')), { label: 'worked in the folder' });
  assert.match(h.tmux('capture-pane', '-p', '-J', '-S', '-60', '-t', session.tmuxPane), new RegExp(`cwd: ${folder.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`));
  await h.api('POST', `/employees/${amy.id}/stop`, {});
  fs.rmSync(path.join(folder, 'where.txt'));
});

test('a worker that cannot start says why, and trying again does not pile up sessions', async () => {
  const bad = await h.api('POST', '/employees', { name: 'Bad', roleKey: 'backend', hostId: h.hostId, workingDir: folder, model: 'crash-on-start' });
  for (let i = 0; i < 3; i++) {
    await h.api('POST', `/employees/${bad.id}/start`, {}).catch(() => undefined);
    await waitFor(async () => (await h.state()).sessions.some((s) => s.employeeId === bad.id && s.status === 'exited' && /status 1/.test(s.exitReason ?? '')), { label: `attempt ${i + 1} reported` });
    await sleep(200);
  }
  const sessions = (await h.state()).sessions.filter((s) => s.employeeId === bad.id);
  assert.equal(sessions.length, 1, 'one session record, retried in place');
  assert.match(sessions[0]!.exitReason!, /process exited with status 1: .*Simulated startup failure: this build of the CLI cannot start here\./, 'the reason is what the program itself printed');
  assert.equal(h.tmux('list-sessions', '-F', '#{session_name}').split('\n').filter((n) => /^orch-bad-/.test(n)).length, 1, 'one tmux session, not one per attempt');
  const note = (await h.state()).notifications.filter((n) => n.employeeId === bad.id).pop();
  assert.match(`${note?.title} ${note?.body}`, /Simulated startup failure/);
  await h.api('PATCH', `/employees/${bad.id}`, { archived: true }).catch(() => undefined);
});

test('browsing a machine lists folders inside what it allows, and nothing outside', async () => {
  const top = await h.api('GET', `/hosts/${h.hostId}/browse`);
  assert.equal(top.path, fs.realpathSync(h.tmp));
  assert.equal(top.parent, null, 'cannot go above an allowed root');
  const journal = top.folders.find((f: any) => f.name === 'journal');
  assert.ok(journal, 'the repository folder is listed');
  assert.equal(journal.repo, true);
  assert.equal(journal.claude, true);
  const inside = await h.api('GET', `/hosts/${h.hostId}/browse?path=${encodeURIComponent(folder)}`);
  assert.deepEqual(inside.folders.map((f: any) => f.name), ['docs'], 'hidden folders and node_modules are not offered');
  assert.equal(inside.parent, fs.realpathSync(h.tmp));
  const outside = await h.apiRaw('GET', `/hosts/${h.hostId}/browse?path=${encodeURIComponent('/etc')}`);
  assert.ok(outside.status >= 400);
  assert.match(outside.body.error, /outside this host's allowed roots/);
});

test('a new folder is made on the machine from the office — one level, inside what the machine allows — and somebody is hired into it', async () => {
  const root = fs.realpathSync(h.tmp);
  const made = await h.api('POST', `/hosts/${h.hostId}/folders`, { parent: root, name: '  New Shop  ' });
  assert.deepEqual(made, { path: path.join(root, 'New Shop'), name: 'New Shop' });
  assert.ok(fs.statSync(made.path).isDirectory());
  assert.deepEqual(fs.readdirSync(made.path), [], 'empty');
  assert.ok((await h.api('GET', `/hosts/${h.hostId}/browse`)).folders.some((f: any) => f.path === made.path), 'it is in the list');
  // One name, not a path; not hidden; not over something that is there; not outside the allowed folders.
  for (const [body, why] of [
    [{ parent: root, name: 'New Shop' }, /already exists there/],
    [{ parent: root, name: 'a/b' }, /one name, not a path/],
    [{ parent: root, name: '..' }, /one name, not a path/],
    [{ parent: root, name: '.hidden' }, /starts with a dot/],
    [{ parent: root, name: '-rf' }, /cannot start with a dash/],
    [{ parent: root, name: '   ' }, /give the new folder a name/],
    [{ parent: root, name: 'x'.repeat(101) }, /at most 100 characters/],
    [{ parent: '/etc', name: 'orchestrator-test' }, /outside this host's allowed roots/],
    [{ parent: path.join(root, 'no-such-folder'), name: 'x' }, /does not exist/],
  ] as const) {
    const res = await h.apiRaw('POST', `/hosts/${h.hostId}/folders`, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.error, why);
  }
  assert.ok(!fs.existsSync('/etc/orchestrator-test'));
  assert.ok((await h.api<any[]>('GET', '/audit?limit=20')).some((a) => a.action === 'folder.created' && a.detail?.path === made.path), 'on the record');
  // The folder is one somebody can be hired into: it becomes their project, as an existing one would.
  const nia = await h.api('POST', '/employees', { name: 'Nia', roleKey: 'frontend', hostId: h.hostId, workingDir: made.path });
  assert.equal(nia.workingDir, made.path);
  assert.equal((await h.state()).projects.find((p) => p.id === nia.projectId)?.repoPath, made.path);
  // A folder that is not there says how to make it.
  const none = await h.apiRaw('POST', '/employees', { name: 'Nobody', roleKey: 'frontend', hostId: h.hostId, workingDir: path.join(root, 'not-made-yet') });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /does not exist on that machine yet\. Make it first: "Browse…" → "New folder"/);
});

test('an employee on auto runs in Claude Code\'s auto mode and is not asked for permission', async () => {
  ivy = await h.api('POST', '/employees', { name: 'Ivy', roleKey: 'fullstack', hostId: h.hostId, workingDir: folder, autonomy: 'auto' });
  assert.equal(ivy.autonomy, 'auto');
  const session = await h.api('POST', `/employees/${ivy.id}/start`, {});
  await idle(ivy.id);
  assert.equal((await h.session(ivy.id))!.permissionMode, 'auto');
  assert.match(h.started(session.tmuxPane), /--permission-mode auto/);
  await h.api('POST', `/employees/${ivy.id}/message`, { body: 'Write two files and run something. @@fake: write a.txt one; bash echo hello > b.txt; write c.txt three; say all-done-on-auto@@' });
  await waitFor(() => fs.existsSync(path.join(folder, 'c.txt')), { label: 'work done without approval' });
  await idle(ivy.id);
  const state = await h.state();
  assert.equal(state.questions.filter((q) => q.employeeId === ivy.id && q.kind === 'permission').length, 0, 'no permission question was ever raised');
});

test('on auto, real decisions still come to the owner', async () => {
  await h.api('POST', `/employees/${ivy.id}/message`, { body: 'Decide with me. @@fake: ask Which colour scheme?; say decided@@' });
  const q = await waitFor(() => h.openQuestion(ivy.id, 'question'), { label: 'a real question' });
  assert.equal(q.channel, 'mcp_tool');
  await h.api('POST', `/questions/${q.id}/answer`, { answer: 'Dark' });
  await idle(ivy.id);
});

test('on auto, high-risk commands still ask — unless the owner switches that off', async () => {
  await h.api('POST', `/employees/${ivy.id}/message`, { body: 'Publish it. @@fake: bash git push origin main; say pushed-or-not@@' });
  const q = await waitFor(() => h.openQuestion(ivy.id, 'permission'), { label: 'high-risk approval' });
  assert.match(String((q.tool!.input as any).command), /git push/);
  await h.api('POST', `/questions/${q.id}/answer`, { decision: 'deny', answer: 'Not from here.' });
  await idle(ivy.id);

  await h.api('PATCH', '/settings', { autoAsksHighRisk: false });
  await h.api('POST', `/employees/${ivy.id}/stop`, {});
  await h.api('POST', `/employees/${ivy.id}/start`, {});
  await idle(ivy.id);
  await h.api('POST', `/employees/${ivy.id}/message`, { body: 'Again. @@fake: bash git push origin main || true; say second-push-attempt@@' });
  await waitFor(async () => (await h.api('GET', `/events?employeeId=${ivy.id}&limit=300`)).some((e: any) => e.type === 'agent.turn_finished' && /second-push-attempt/.test(e.data.lastMessage ?? '')), { label: 'ran without asking'  }).catch(async (e) => {
    const st = await h.state();
    const mine = (await h.session(ivy.id))!;
    throw new Error(`${e.message}\nsession: ${mine.status}/${mine.activity} inTurn=${mine.inTurn} ${mine.exitReason ?? ''}\nquestions: ${st.questions.filter((q) => q.employeeId === ivy.id).map((q) => `${q.kind}:${q.status}`).join(', ')}\nmessages: ${st.messages.filter((m) => m.toEmployeeId === ivy.id).slice(-2).map((m) => `${m.body.slice(0, 20)} → ${JSON.stringify(m.delivery)}`).join(' | ')}\ncontrol: ${mine.control}\n${h.tmux('capture-pane', '-p', '-J', '-S', '-30', '-t', mine.tmuxPane!)}`);
  });
  await sleep(300);
  assert.equal((await h.state()).questions.filter((x) => x.employeeId === ivy.id && x.kind === 'permission' && x.status === 'open').length, 0);
  const audited = (await h.api('GET', '/audit')).filter((a: any) => a.action === 'settings.changed');
  assert.ok(audited.some((a: any) => a.detail.changed.includes('autoAsksHighRisk')), 'switching the safeguard off is on the record');
  await h.api('PATCH', '/settings', { autoAsksHighRisk: true });
});

test("an employee's Markdown documents are listed from their folder and can be read", async () => {
  const docs = await h.api('GET', `/employees/${ivy.id}/docs`);
  assert.equal(docs.root, folder);
  assert.deepEqual(docs.files.map((f: any) => f.path).sort(), ['CLAUDE.md', 'README.md', 'docs/PLAN.md', 'docs/adr/0001.md'], 'Markdown only, subfolders included, dependencies skipped');
  const plan = await h.api('GET', `/employees/${ivy.id}/docs/file?path=${encodeURIComponent('docs/PLAN.md')}`);
  assert.equal(plan.content, '# Plan\n- [ ] first\n');
  // Not Markdown, and not inside the folder: both refused.
  assert.ok((await h.apiRaw('GET', `/employees/${ivy.id}/docs/file?path=secret.txt`)).status >= 400);
  const escape = await h.apiRaw('GET', `/employees/${ivy.id}/docs/file?path=${encodeURIComponent('../server/owner-token.md')}`);
  assert.ok(escape.status >= 400);
  fs.symlinkSync('/etc/hosts', path.join(folder, 'link.md'));
  const viaLink = await h.apiRaw('GET', `/employees/${ivy.id}/docs/file?path=link.md`);
  assert.ok(viaLink.status >= 400, 'a link that points out of the folder is not followed');
  assert.ok(!(await h.api('GET', `/employees/${ivy.id}/docs`)).files.some((f: any) => f.path === 'link.md'));
  fs.rmSync(path.join(folder, 'link.md'));
});

test('someone who was never given a folder has no documents, and says so', async () => {
  const nobody = await h.api('POST', '/employees', { name: 'Nobody', roleKey: 'docs', hostId: h.hostId });
  const docs = await h.api('GET', `/employees/${nobody.id}/docs`);
  assert.deepEqual(docs.files, []);
  assert.match(docs.unavailable, /no folder/);
});

test('the office hi-fi keeps its stations in the settings, and only real web streams', async () => {
  const before = (await h.state()).settings;
  assert.equal(before.radio.stations[0]!.id, 'mansionnet', 'one station to begin with');
  assert.match(before.radio.stations[0]!.url, /^https:\/\//);
  assert.equal(before.keybindings.whip, 'KeyR');
  const stations = [
    ...before.radio.stations,
    { id: 'jazz', name: '  Jazz FM  ', url: 'https://example.test/stream.mp3', nowPlayingUrl: null, page: null },
    { id: 'script', name: 'Not a stream', url: 'javascript:alert(1)', nowPlayingUrl: null, page: null },
    { id: 'file', name: 'A local file', url: 'file:///etc/passwd', nowPlayingUrl: null, page: null },
    { id: 'nameless', name: '   ', url: 'https://example.test/x.mp3', nowPlayingUrl: null, page: null },
    { id: 'info', name: 'Bad extras', url: 'http://example.test/y.aac', nowPlayingUrl: 'ftp://example.test/now', page: 'javascript:void(0)' },
  ];
  await h.api('PATCH', '/settings', { radio: { stations, volume: 7, lastStationId: 'jazz' } });
  const radio = (await h.state()).settings.radio;
  assert.deepEqual(radio.stations.map((s) => s.id), ['mansionnet', 'jazz', 'info'], 'anything that is not an http(s) address with a name is dropped');
  assert.equal(radio.stations[1]!.name, 'Jazz FM');
  assert.deepEqual([radio.stations[2]!.nowPlayingUrl, radio.stations[2]!.page], [null, null]);
  assert.equal(radio.volume, 1, 'volume stays between 0 and 1');
  assert.equal(radio.lastStationId, 'jazz');
  // Removing the station that was last played forgets it; the volume alone can be changed.
  await h.api('PATCH', '/settings', { radio: { stations: radio.stations.filter((s) => s.id !== 'jazz') } });
  await h.api('PATCH', '/settings', { radio: { volume: 0.25 } });
  const after = (await h.state()).settings.radio;
  assert.deepEqual(after.stations.map((s) => s.id), ['mansionnet', 'info']);
  assert.equal(after.lastStationId, null);
  assert.equal(after.volume, 0.25);
  const audited = (await h.api('GET', '/audit')).filter((a: any) => a.action === 'settings.changed' && a.detail.changed.includes('radio'));
  assert.ok(audited.length >= 3);
  // What is on air is asked by the server, for saved stations only; only a short title comes back.
  const station = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.url === '/big' ? JSON.stringify({ title: 'x', pad: 'y'.repeat(700_000) }) : JSON.stringify({ now_playing: { song: { text: `Artist - Song\n${'z'.repeat(400)}` } }, secret: 'not passed on' }));
  });
  await new Promise<void>((r) => station.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${(station.address() as any).port}`;
  await h.api('PATCH', '/settings', { radio: { stations: [{ id: 'local', name: 'Local', url: `${at}/stream`, nowPlayingUrl: `${at}/now`, page: null }, { id: 'big', name: 'Big', url: `${at}/stream`, nowPlayingUrl: `${at}/big`, page: null }, { id: 'quiet', name: 'Quiet', url: `${at}/stream`, nowPlayingUrl: null, page: null }] } });
  const now = await h.api('GET', '/radio/now?station=local');
  assert.deepEqual(Object.keys(now), ['text']);
  assert.match(now.text, /^Artist - Song z+$/);
  assert.equal(now.text.length, 200);
  assert.equal((await h.api('GET', '/radio/now?station=big')).text, null, 'an oversized reply is not read');
  assert.equal((await h.api('GET', '/radio/now?station=quiet')).text, null);
  assert.equal((await h.api('GET', `/radio/now?station=${encodeURIComponent(`${at}/now`)}`)).text, null, 'only saved stations are asked, not any address');
  station.close();
  await h.api('PATCH', '/settings', { radio: before.radio });
});
