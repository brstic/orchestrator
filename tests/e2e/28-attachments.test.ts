/**
 * Files on tasks, and a browser for employees — end to end with a real server, a real host agent, real tmux
 * sessions and scripted workers.
 *
 *  - What a person attaches to a task is kept by the office, copied to the machine of the employee who gets the task
 *    (outside every repository), and named in the hand-over so they can open it.
 *  - An employee leaves a file from their machine on the task as evidence; people open it in the office.
 *  - Where a browser for employees is installed on a machine, a session there is started with it as tools of its own.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mayCall } from '../../apps/server/src/access.ts';

// A stand-in for the browser's MCP server, "installed" before the machine's agent starts: the office only has to
// find it and put it into the session's tool config (the real one is Playwright's; nothing here opens a browser).
const browserDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir().length > 40 ? '/tmp' : os.tmpdir(), 'orch-browser-')));
const browserCli = path.join(browserDir, 'cli.js');
fs.writeFileSync(browserCli, 'process.stdin.resume();\n');
process.env.ORCH_BROWSER_MCP = browserCli;
process.env.ORCH_BROWSER_CHROME = 'none';
const { createHarness, waitFor } = await import('./harness.ts');
type Harness = Awaited<ReturnType<typeof createHarness>>;

let h: Harness;
let project = '';
let repo = '';
const ids: Record<string, string> = {};

// A real (tiny) PNG, and something larger than one piece.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const BIG = crypto.randomBytes(1_300_000);
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Send a file the way the window does: say what it is, then its bytes in pieces. */
async function upload(taskId: string, name: string, data: Buffer, caption?: string): Promise<any> {
  const begun = await h.api('POST', `/tasks/${taskId}/attachments`, { name, size: data.length, caption });
  let last: any = null;
  for (let offset = 0; offset < data.length; offset += 400_000) last = await h.api('POST', `/tasks/${taskId}/attachments/${begun.id}/data`, { offset, dataBase64: data.subarray(offset, offset + 400_000).toString('base64') });
  assert.equal(last.done, true);
  return last.attachment;
}
const download = async (taskId: string, id: string) => {
  const res = await fetch(`${h.url}/api/tasks/${taskId}/attachments/${id}`, { headers: { authorization: `Bearer ${h.token}` } });
  return { status: res.status, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition'), nosniff: res.headers.get('x-content-type-options'), body: Buffer.from(await res.arrayBuffer()) };
};
const pane = async (name: string) => h.tmux('capture-pane', '-p', '-J', '-S', '-300', '-t', (await h.session(ids[name]!))!.tmuxPane!);

before(async () => {
  h = await createHarness();
  repo = h.makeRepo('shop');
  project = (await h.project('Shop', repo)).id;
  for (const [name, role] of [['Alex', 'frontend'], ['Sarah', 'backend']] as const) ids[name] = (await h.employee(name, role, { projectId: project, autonomy: 'auto' })).id;
});
after(async () => {
  await h?.cleanup();
  fs.rmSync(browserDir, { recursive: true, force: true });
});

test('files attached to a task reach the employee with the task: on their machine, outside the repository, named in the hand-over', async () => {
  const task = await h.task({ projectId: project, title: 'Fix the broken header', assigneeId: ids.Alex, released: false, description: '@@fake: saw Attached files; saw header-bug.png (image) — the header overlaps the logo; say looked at them@@' });
  const png = await upload(task.id, '../../header bug?.png'.replace(' bug?', '-bug'), PNG, 'the header overlaps the logo');
  const big = await upload(task.id, 'spec.pdf', BIG);
  assert.deepEqual([png.name, png.mime, png.kind, png.size, png.sha256], ['header-bug.png', 'image/png', 'input', PNG.length, sha(PNG)]);
  assert.deepEqual([big.name, big.mime, big.sha256], ['spec.pdf', 'application/pdf', sha(BIG)]);
  assert.deepEqual(png.addedBy, { kind: 'owner', id: null, name: 'the boss' });
  // The same name twice is two files.
  assert.equal((await upload(task.id, 'spec.pdf', Buffer.from('second'))).name, 'spec-2.pdf');
  // Names in another alphabet stay what they are, and two of them stay two files.
  const slika = await upload(task.id, 'слика.png', PNG);
  const skica = await upload(task.id, 'скица.png', Buffer.from('a different picture'));
  assert.deepEqual([slika.name, skica.name], ['слика.png', 'скица.png']);
  await h.api('POST', '/tasks/release', { ids: [task.id] });
  const started = await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.delivery.status === 'confirmed' ? t : null;
  }, { label: 'the task was handed over', timeout: 30000 });
  const there = (name: string) => started.attachments!.find((a) => a.name === name)!.paths![h.hostId]!;
  assert.notEqual(there('слика.png'), there('скица.png'));
  assert.deepEqual([sha(fs.readFileSync(there('слика.png'))), fs.readFileSync(there('скица.png'), 'utf8')], [sha(PNG), 'a different picture']);
  // On the machine: in the agent's own folder, one folder per task, byte for byte.
  const at = started.attachments!.find((a) => a.name === 'header-bug.png')!.paths![h.hostId]!;
  assert.equal(at, path.join(h.agentHome, 'files', task.key, 'header-bug.png'));
  assert.ok(!at.startsWith(repo) && !at.startsWith(started.worktree!), 'not in the repository');
  assert.deepEqual(fs.readFileSync(at), PNG);
  assert.equal(sha(fs.readFileSync(path.join(h.agentHome, 'files', task.key, 'spec.pdf'))), sha(BIG));
  assert.equal(fs.statSync(at).mode & 0o777, 0o600);
  assert.equal(h.git(started.worktree!, 'status', '--porcelain'), '', 'nothing of it shows in git');
  // The hand-over named them, and the session may read that folder.
  await waitFor(async () => /saw\[Attached files\]=yes/.test(await pane('Alex')) && /saw\[header-bug\.png \(image\) — the header overlaps the logo\]=yes/.test(await pane('Alex')), { label: 'the hand-over named the files', timeout: 15000 });
  const session = (await h.session(ids.Alex!))!;
  assert.match(h.started().split('\n').find((l) => l.startsWith(session.tmuxSession!))!, new RegExp(`--add-dir ${path.join(h.agentHome, 'files')}`));
  ids.task = task.id;
});

test('a file attached while the employee is already on the task is sent at once, and they are told where it is', async () => {
  const late = await upload(ids.task!, 'console.log', Buffer.from('TypeError: header is undefined\n'), 'what the console says');
  const told = await waitFor(async () => (await h.state()).messages.find((m) => m.toEmployeeId === ids.Alex && /attached a file to T-\d+: .*console\.log — what the console says/.test(m.body)), { label: 'Alex is told', timeout: 15000 });
  const where = path.join(h.agentHome, 'files', (await h.getTask(ids.task!)).key, 'console.log');
  assert.ok(told.body.includes(where));
  assert.equal(fs.readFileSync(where, 'utf8'), 'TypeError: header is undefined\n');
  assert.equal(late.mime, 'text/plain');
});

test('an employee leaves a screenshot of the result on the task as evidence; people open it in the office', async () => {
  // The "screenshot" is a file the worker made on its machine; attach_file takes it from there.
  await waitFor(async () => (await h.session(ids.Alex!))!.inTurn === false, { label: 'Alex between turns', timeout: 20000 });
  // (Saved where a screenshot tool would save it: in the machine's temp folder, not in the repository.)
  const shot = path.join(fs.realpathSync(os.tmpdir()), `orch-shot-${process.pid}`, 'after.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  fs.writeFileSync(shot, PNG);
  await h.api('POST', `/employees/${ids.Alex}/message`, { body: `Show me. @@fake: mcp attach_file {"path":"${shot}","caption":"the header after the fix"}; write header.txt fixed; commit fix the header; complete header fixed@@` });
  const done = await waitFor(async () => {
    const t = await h.getTask(ids.task!);
    return t.status === 'DONE' ? t : null;
  }, { label: 'done', timeout: 15000 }).catch(async (e) => {
    const t = await h.getTask(ids.task!);
    throw new Error(`${e.message}\n${t.status} ${JSON.stringify(t.attachments?.map((a) => [a.name, a.kind]))}\n${(await pane('Alex')).split('\n').filter((l) => l.trim()).slice(-25).join('\n')}`);
  });
  fs.rmSync(path.dirname(shot), { recursive: true, force: true });
  const ev = done.attachments!.find((a) => a.kind === 'evidence')!;
  assert.deepEqual([ev.name, ev.mime, ev.caption, ev.size, ev.sha256], ['after.png', 'image/png', 'the header after the fix', PNG.length, sha(PNG)]);
  assert.deepEqual(ev.addedBy, { kind: 'employee', id: ids.Alex, name: 'Alex' });
  assert.ok(done.history.some((x) => /Evidence added: after\.png — the header after the fix/.test(x.note)));
  const got = await download(done.id, ev.id);
  assert.deepEqual([got.status, got.type, got.nosniff], [200, 'image/png', 'nosniff']);
  assert.match(got.disposition!, /^inline; filename\*=UTF-8''after\.png$/);
  assert.deepEqual(got.body, PNG);
  // A document is never shown by the browser as what it claims to be: it is a download.
  const pdf = await download(done.id, done.attachments!.find((a) => a.name === 'spec.pdf')!.id);
  assert.equal(pdf.type, 'application/octet-stream');
  assert.match(pdf.disposition!, /^attachment;/);
  assert.equal(sha(pdf.body), sha(BIG));
  const events = await h.api<any[]>('GET', '/events?limit=400');
  assert.ok(events.some((e) => e.type === 'task.attachment_added' && /Alex left after\.png as evidence on T-\d+/.test(e.summary)));
});

test('what may not be attached is refused, in words the employee can act on', async () => {
  const task = await h.task({ projectId: project, title: 'Try to attach what should not be', assigneeId: ids.Sarah, description: '@@fake: say ready@@' });
  await waitFor(async () => (await h.getTask(task.id)).delivery.status === 'confirmed', { label: 'Sarah has it', timeout: 30000 });
  const sarah = (await h.session(ids.Sarah!))!;
  const attempt = async (file: string) => {
    await waitFor(async () => (await h.session(ids.Sarah!))!.inTurn === false, { label: 'Sarah between turns', timeout: 20000 });
    const out = path.join(sarah.cwd, 'attach-result.txt');
    fs.rmSync(out, { force: true });
    await h.api('POST', `/employees/${ids.Sarah}/message`, { body: `Try. @@fake: mcp attach_file {"path":"${file}"}; result attach-result.txt@@` });
    await waitFor(() => fs.existsSync(out), { label: `an answer about ${file}`, timeout: 20000 });
    const text = fs.readFileSync(out, 'utf8');
    fs.rmSync(out, { force: true });
    return text;
  };
  assert.match(await attempt('/etc/hosts'), /^ERROR .*cannot be attached from there\. A file is taken from your working folder/);
  assert.match(await attempt('nothing-here.png'), /^ERROR .*there is no file at/);
  // (The session's own files hold its tokens. In a test the agent's home is in a temporary folder, so it is the name that refuses it.)
  assert.match(await attempt(path.join(h.agentHome, 'sessions', sarah.id, 'mcp.json')), /^ERROR .*(cannot be attached from there|looks like a key or a credential)/);
  assert.match(await attempt(path.join(h.agentHome, 'sessions', sarah.id, 'settings.json')), /^ERROR .*(cannot be attached from there|looks like a key or a credential)/);
  assert.match(await attempt(sarah.cwd), /^ERROR .*is not a file/);
  // "Where this machine lets the office work" is not where evidence comes from: that is usually the whole home
  // folder. Even with /etc among the machine's folders, a file there is not an employee's to put on a task.
  h.agentCfg.allowedRoots.push('/etc');
  assert.match(await attempt('/etc/hosts'), /^ERROR .*cannot be attached from there/);
  h.agentCfg.allowedRoots.pop();
  // Inside the working folder: nothing hidden, and nothing that is a key or a credential by its name.
  fs.writeFileSync(path.join(sarah.cwd, '.env'), 'TOKEN=not-a-real-one\n');
  fs.writeFileSync(path.join(sarah.cwd, 'Deploy.PEM'), 'not a real key\n');
  assert.match(await attempt('.env'), /^ERROR .*hidden file or in a hidden folder/);
  fs.mkdirSync(path.join(sarah.cwd, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(sarah.cwd, '.cache', 'dump.txt'), 'x');
  assert.match(await attempt('.git'), /^ERROR .*hidden file or in a hidden folder/);
  assert.match(await attempt('.cache/dump.txt'), /^ERROR .*hidden file or in a hidden folder/);
  fs.rmSync(path.join(sarah.cwd, '.cache'), { recursive: true });
  assert.match(await attempt('Deploy.PEM'), /^ERROR .*looks like a key or a credential/);
  fs.rmSync(path.join(sarah.cwd, '.env'));
  fs.rmSync(path.join(sarah.cwd, 'Deploy.PEM'));
  // The office's own token on this machine (in a test it lies in a temporary folder, which is otherwise allowed).
  // (Refused before the tool is even called: the office's own files on the machine are fenced off from its sessions.)
  assert.match(await attempt(path.join(path.dirname(h.agentHome), 'server', 'owner-token')), /^ERROR .*(looks like a key or a credential|did not come back)/);
  assert.match(h.tmux('capture-pane', '-p', '-J', '-S', '-60', '-t', sarah.tmuxPane!).replace(/\s+/g, ' '), /denied by hook: Orchestrator policy: that is one of the office's own files on this machine/);
  assert.equal((await h.getTask(task.id)).attachments?.length ?? 0, 0, 'nothing of that reached the task');
  // Somebody else's task is not hers to leave evidence on.
  await waitFor(async () => (await h.session(ids.Sarah!))!.inTurn === false, { label: 'Sarah between turns', timeout: 20000 });
  fs.writeFileSync(path.join(sarah.cwd, 'mine.txt'), 'x');
  const other = (await h.getTask(ids.task!)).key;
  await h.api('POST', `/employees/${ids.Sarah}/message`, { body: `Try. @@fake: mcp attach_file {"path":"mine.txt","task":"${other}"}; result attach-result.txt@@` });
  await waitFor(() => fs.existsSync(path.join(sarah.cwd, 'attach-result.txt')), { label: 'an answer', timeout: 20000 });
  assert.match(fs.readFileSync(path.join(sarah.cwd, 'attach-result.txt'), 'utf8'), /^ERROR .*is not your task/);
  // From people: an empty file, one that is too large, pieces out of order.
  assert.equal((await h.apiRaw('POST', `/tasks/${task.id}/attachments`, { name: 'empty.txt', size: 0 })).status, 400);
  assert.match(JSON.stringify((await h.apiRaw('POST', `/tasks/${task.id}/attachments`, { name: 'huge.bin', size: 101 * 1024 * 1024 })).body), /larger than 100 MB/);
  const begun = await h.api('POST', `/tasks/${task.id}/attachments`, { name: 'a.txt', size: 10 });
  assert.equal((await h.apiRaw('POST', `/tasks/${task.id}/attachments/${begun.id}/data`, { offset: 5, dataBase64: Buffer.from('later').toString('base64') })).status, 409);
  assert.equal((await h.apiRaw('POST', `/tasks/${task.id}/attachments/${begun.id}/data`, { offset: 0, dataBase64: Buffer.from('more than ten bytes').toString('base64') })).status, 400);
  assert.equal((await h.getTask(task.id)).attachments ?? null, null, 'nothing unfinished is on the task');
  ids.sarahTask = task.id;
});

test('who may: whoever works here and sees the task opens its files; adding and removing is for those who may work with it; a removed task takes its files along', async () => {
  const engine = h.server.engine;
  const task = await h.getTask(ids.task!);
  const a = task.attachments![0]!;
  const visitor = { kind: 'guest' as const, id: 'v1', name: 'V', role: 'visitor' as const };
  const colleague = { kind: 'guest' as const, id: 'c1', name: 'C', role: 'colleague' as const };
  assert.equal(mayCall(engine, visitor, 'GET', `/tasks/${task.id}/attachments/${a.id}`, null).ok, false, 'a visitor sees the title of a task, not what is attached to it');
  assert.equal(mayCall(engine, colleague, 'GET', `/tasks/${task.id}/attachments/${a.id}`, null).ok, true);
  assert.equal(mayCall(engine, visitor, 'POST', `/tasks/${task.id}/attachments`, {}).ok, false);
  assert.equal(mayCall(engine, visitor, 'POST', `/tasks/${task.id}/attachments/${a.id}/data`, {}).ok, false);
  assert.equal(mayCall(engine, visitor, 'DELETE', `/tasks/${task.id}/attachments/${a.id}`, null).ok, false);
  for (const [m, p] of [['POST', `/tasks/${task.id}/attachments`], ['DELETE', `/tasks/${task.id}/attachments/${a.id}`]] as const) assert.equal(mayCall(engine, colleague, m, p, {}).ok, true);
  assert.equal((await fetch(`${h.url}/api/tasks/${task.id}/attachments/${a.id}`)).status, 401, 'never without saying who asks');
  // Removing one: off the task and out of the office's folder.
  const stored = path.join(h.tmp, 'server', 'files');
  const dir = fs.existsSync(path.join(stored, task.id)) ? path.join(stored, task.id) : fs.readdirSync(h.tmp, { recursive: true, withFileTypes: true }).filter((e) => e.isDirectory() && e.name === task.id).map((e) => path.join(e.parentPath ?? (e as any).path, e.name))[0]!;
  assert.ok(fs.existsSync(path.join(dir, a.id)));
  await h.api('DELETE', `/tasks/${task.id}/attachments/${a.id}`);
  assert.equal(fs.existsSync(path.join(dir, a.id)), false);
  assert.equal((await h.getTask(task.id)).attachments!.some((x) => x.id === a.id), false);
  assert.equal((await download(task.id, a.id)).status, 404);
  // The files and the list survive a restart; deleting the task removes its folder.
  await h.restartServer();
  const again = await h.getTask(task.id);
  assert.ok(again.attachments!.length >= 3);
  assert.equal((await download(task.id, again.attachments!.find((x) => x.kind === 'evidence')!.id)).status, 200);
  await h.api('DELETE', `/tasks/${task.id}`);
  assert.equal(fs.existsSync(dir), false, 'the task\'s files went with it');
});

test('where a browser for employees is installed, a session is started with it — and without it when the office says no', async () => {
  const host = (await h.state()).hosts.find((x) => x.id === h.hostId)!;
  assert.deepEqual(host.info!.browser, { mcp: 'unknown', engine: 'chromium' });
  const alex = (await h.session(ids.Alex!))!;
  const cfg = JSON.parse(fs.readFileSync(path.join(h.agentHome, 'sessions', alex.id, 'mcp.json'), 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(cfg).sort(), ['browser', 'orchestrator']);
  assert.equal(cfg.browser.type, 'stdio');
  assert.deepEqual(cfg.browser.args, [browserCli, '--headless', '--isolated', '--file-paths', 'absolute', '--output-dir', path.join(h.agentHome, 'sessions', alex.id, 'browser')]);
  const settings = JSON.parse(fs.readFileSync(path.join(h.agentHome, 'sessions', alex.id, 'settings.json'), 'utf8'));
  assert.ok(settings.permissions.allow.includes('mcp__browser') && settings.permissions.allow.includes('mcp__orchestrator'));
  // Switched off: the next start of a session has only the office's own tools.
  await h.api('PATCH', '/settings', { employeesBrowser: false });
  await h.api('POST', `/employees/${ids.Sarah}/stop`, {});
  await waitFor(async () => (await h.session(ids.Sarah!))?.status !== 'running', { label: 'Sarah stopped', timeout: 15000 });
  const sarah = await h.api('POST', `/employees/${ids.Sarah}/start`, {});
  const off = JSON.parse(fs.readFileSync(path.join(h.agentHome, 'sessions', sarah.id, 'mcp.json'), 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(off), ['orchestrator']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.agentHome, 'sessions', sarah.id, 'settings.json'), 'utf8')).permissions.allow.includes('mcp__browser'), false);
});

test('files on their way count towards a task\'s limit, and an upload that was never finished is gone after a restart', async () => {
  const task = await h.task({ projectId: project, title: 'Hold many files', released: false, description: 'nothing to do' });
  const begun: string[] = [];
  for (let i = 0; i < 200; i++) begun.push((await h.api<any>('POST', `/tasks/${task.id}/attachments`, { name: `f${i}.txt`, size: 4 })).id);
  const more = await h.apiRaw('POST', `/tasks/${task.id}/attachments`, { name: 'one-too-many.txt', size: 4 });
  assert.equal(more.status, 400);
  assert.match(more.body.error, /at most 200 files/);
  // Two are finished; the rest are left as they are.
  for (const id of begun.slice(0, 2)) await h.api('POST', `/tasks/${task.id}/attachments/${id}/data`, { offset: 0, dataBase64: Buffer.from('four').toString('base64') });
  const folder = path.join(path.dirname(h.agentHome), 'server', 'files', task.id);
  assert.equal(fs.readdirSync(folder).length, 200);
  await h.restartServer();
  assert.deepEqual(fs.readdirSync(folder).sort(), begun.slice(0, 2).sort(), 'only what is on the task is kept');
  assert.equal((await h.getTask(task.id)).attachments!.length, 2);
});
