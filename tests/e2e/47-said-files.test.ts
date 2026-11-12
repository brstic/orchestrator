/**
 * Files that go with what is said to an employee: a pasted screenshot, a document. They reach the employee's machine
 * with the message, the message says where they are, and the conversation can show the picture for a while.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MAX_SAID_FILES, SAID_KEEP_MS } from '@orchestrator/orchestration';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let alex = '';
let colleague = '';
let visitor = '';
// A real (tiny) PNG, and something that is not a picture.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const NOTES = Buffer.from('the staging password is not in this file\n'.repeat(40));

const as = async (token: string, method: string, route: string, body?: unknown) => {
  const r = await fetch(`${h.url}/api${route}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = Buffer.from(await r.arrayBuffer());
  let json: any = null;
  try {
    json = JSON.parse(text.toString('utf8'));
  } catch {
    /* a file */
  }
  return { status: r.status, body: json, bytes: text, type: r.headers.get('content-type'), disposition: r.headers.get('content-disposition') };
};
/** Send a file the way the window does: say what it is, then its bytes in pieces. */
const put = async (token: string, name: string, data: Buffer, piece = 300) => {
  const begun = await as(token, 'POST', `/employees/${alex}/files`, { name, size: data.length });
  assert.equal(begun.status, 200, JSON.stringify(begun.body));
  for (let offset = 0; offset < data.length; offset += piece) {
    const r = await as(token, 'POST', `/employees/${alex}/files/${begun.body.id}/data`, { offset, dataBase64: data.subarray(offset, offset + piece).toString('base64') });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  return begun.body as { id: string; name: string; mime: string; size: number };
};

before(async () => {
  h = await createHarness();
  const project = await h.project('Shop', h.makeRepo('shop'));
  alex = (await h.employee('Alex', 'backend', { projectId: project.id })).id;
  await h.api('POST', '/sharing', { open: true, port: 20000 + Math.floor(Math.random() * 20000) });
  const token = (invite: string) => JSON.parse(Buffer.from(invite.replace(/^orch-invite-v1\./, ''), 'base64url').toString('utf8')).t as string;
  colleague = token((await h.api<any>('POST', '/guests', { name: 'Ana', role: 'colleague' })).invite);
  visitor = token((await h.api<any>('POST', '/guests', { name: 'Nik', role: 'visitor' })).invite);
});
after(async () => {
  await h.cleanup();
});

test('a pasted screenshot goes with the message: it is on the employee’s machine, the message says where, and the conversation shows it', async () => {
  const shot = await put(h.token, '../../etc/screenshot.png', PNG);
  assert.deepEqual([shot.name, shot.mime, shot.size], ['screenshot.png', 'image/png', PNG.length], 'a name is only a name');
  const notes = await put(h.token, 'notes.txt', NOTES);
  const sent = await as(h.token, 'POST', `/employees/${alex}/message`, { body: 'Why does this page look like that?', fileIds: [shot.id, notes.id] });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const m = sent.body;
  // What the person wrote is kept apart from what the office added for the employee.
  assert.equal(m.said, 'Why does this page look like that?');
  assert.deepEqual(m.files, [shot, notes]);
  assert.match(m.body, /^Why does this page look like that\?\n\nFiles that go with this — open each with the Read tool before you answer:\n- .+\n- .+$/);
  const paths = [...m.body.matchAll(/^- (\S+?)( \(an image: you will see it\))?$/gm)].map((x: RegExpMatchArray) => ({ path: x[1]!, image: !!x[2] }));
  assert.deepEqual(paths.map((p) => p.image), [true, false]);
  // On the machine: the agent's own folder (where every session may read), each under a name of its own, the bytes whole.
  assert.match(paths[0]!.path, new RegExp(`/files/said/${shot.id.slice(0, 8)}-screenshot\\.png$`));
  assert.ok(fs.readFileSync(paths[0]!.path).equals(PNG) && fs.readFileSync(paths[1]!.path).equals(NOTES));
  assert.equal(fs.statSync(paths[0]!.path).mode & 0o777, 0o600);
  // The conversation shows the picture; anything else is a download, never a page.
  const pic = await as(h.token, 'GET', `/employees/${alex}/files/${shot.id}`);
  assert.deepEqual([pic.status, pic.type, pic.bytes.equals(PNG)], [200, 'image/png', true]);
  const doc = await as(h.token, 'GET', `/employees/${alex}/files/${notes.id}`);
  assert.deepEqual([doc.status, doc.type, /^attachment;/.test(doc.disposition ?? '')], [200, 'application/octet-stream', true]);
  // The message reached the queue like any other.
  assert.ok((await h.state()).messages.some((x) => x.id === m.id && x.toEmployeeId === alex));
});

test('a picture can be the whole message, and words alone are as they always were', async () => {
  const shot = await put(h.token, 'image.png', PNG);
  const only = (await as(h.token, 'POST', `/employees/${alex}/message`, { fileIds: [shot.id] })).body;
  assert.equal(only.said, 'Look at this.');
  assert.match(only.body, /^Look at this\.\n\nFiles that go with this — open it with the Read tool before you answer:\n- \S+ \(an image: you will see it\)$/);
  const plain = (await as(h.token, 'POST', `/employees/${alex}/message`, { body: 'Thanks.' })).body;
  assert.deepEqual([plain.body, plain.files, plain.said], ['Thanks.', undefined, undefined]);
  assert.equal((await as(h.token, 'POST', `/employees/${alex}/message`, { body: '  ' })).status, 400);
});

test('who may: whoever may talk to the employee; a file is its sender’s until it is said; a visitor has nothing to do with them', async () => {
  // A colleague talks to a shared employee, with a file of their own.
  const theirs = await put(colleague, 'ana.png', PNG);
  // …which nobody else can add to or send for them.
  const mine = await as(h.token, 'POST', `/employees/${alex}/files`, { name: 'big.txt', size: 1000 });
  assert.equal((await as(colleague, 'POST', `/employees/${alex}/files/${mine.body.id}/data`, { offset: 0, dataBase64: 'AAAA' })).status, 404);
  assert.equal((await as(h.token, 'POST', `/employees/${alex}/message`, { body: 'x', fileIds: [theirs.id] })).status, 404);
  // A file that has not arrived whole does not go: the message is not sent without the thing to look at.
  const before = (await h.state()).messages.length;
  const early = await as(h.token, 'POST', `/employees/${alex}/message`, { body: 'look', fileIds: [mine.body.id] });
  assert.deepEqual([early.status, /has not arrived whole yet/.test(early.body.error)], [409, true]);
  assert.equal((await h.state()).messages.length, before, 'nothing was sent');
  assert.equal((await as(colleague, 'POST', `/employees/${alex}/message`, { body: 'From Ana', fileIds: [theirs.id] })).status, 200);
  // Said once: the same file does not go with a second message.
  assert.equal((await as(colleague, 'POST', `/employees/${alex}/message`, { body: 'again', fileIds: [theirs.id] })).status, 404);
  assert.equal((await as(colleague, 'GET', `/employees/${alex}/files/${theirs.id}`)).status, 200);
  for (const [method, route, body] of [['POST', `/employees/${alex}/files`, { name: 'x.png', size: 3 }], ['GET', `/employees/${alex}/files/${theirs.id}`, undefined], ['POST', `/employees/${alex}/message`, { body: 'hi' }]] as const) {
    assert.equal((await as(visitor, method, route, body)).status, 403, `${method} ${route}`);
  }
  // The limits: not empty, not huge, not more than a message carries, and no more bytes than were announced.
  assert.match((await as(h.token, 'POST', `/employees/${alex}/files`, { name: 'x', size: 0 })).body.error, /empty/);
  assert.match((await as(h.token, 'POST', `/employees/${alex}/files`, { name: 'x', size: 26 * 1024 * 1024 })).body.error, /larger than 25 MB/);
  assert.match((await as(h.token, 'POST', `/employees/${alex}/files/${mine.body.id}/data`, { offset: 0, dataBase64: Buffer.alloc(1001).toString('base64') })).body.error, /more was sent than the file was said to hold/);
  assert.match((await as(h.token, 'POST', `/employees/${alex}/message`, { body: 'x', fileIds: Array.from({ length: MAX_SAID_FILES + 1 }, (_, i) => `f${i}`) })).body.error, /at most 10 files go with one message/);
});

test('the office keeps a file that was said for a few days, then no longer; one that was never sent is gone after a restart', async () => {
  const shot = await put(h.token, 'old.png', PNG);
  const unsent = await put(h.token, 'never-sent.png', PNG);
  await as(h.token, 'POST', `/employees/${alex}/message`, { body: 'an old one', fileIds: [shot.id] });
  const files = h.server.engine.saidFiles;
  assert.equal(files.sweep(), 0, 'nothing is old yet, and what waits for its message is left alone');
  assert.equal((await as(h.token, 'GET', `/employees/${alex}/files/${shot.id}`)).status, 200);
  // A week later the office's copy is dropped; the conversation says so instead of showing it.
  assert.ok(files.sweep(Date.now() + SAID_KEEP_MS + 60_000) >= 1);
  const gone = await as(h.token, 'GET', `/employees/${alex}/files/${shot.id}`);
  assert.deepEqual([gone.status, /no longer keeps this file/.test(gone.body.error)], [404, true]);
  // After a restart, what was uploaded and never said is nobody's.
  await h.restartServer();
  assert.equal((await as(h.token, 'POST', `/employees/${alex}/message`, { body: 'x', fileIds: [unsent.id] })).status, 404);
});

test('a message with files is really sent: Claude Code takes such a paste in over a moment, and the Enter is not lost', async () => {
  // What happened on 2026-11-12: a message with four files was pasted into an employee's terminal and stood there
  // unsent — Enter had come while the paste was still being taken in — until the next message pushed it out.
  // (The scripted worker does the same: a paste that names files swallows an Enter for 0.7 s.)
  await h.api('POST', `/employees/${alex}/start`, {});
  await waitFor(async () => (await h.session(alex))?.status === 'running', { label: 'Alex at his desk', timeout: 30000 });
  const shot = await put(h.token, 'bug.png', PNG);
  const sent = (await as(h.token, 'POST', `/employees/${alex}/message`, { body: 'What is wrong here?', fileIds: [shot.id] })).body;
  const delivered = async () => (await h.state()).messages.find((m) => m.id === sent.id)!.delivery;
  await waitFor(async () => (await delivered()).status === 'confirmed', { label: 'the message with a file taken by Claude Code', timeout: 20000 }).catch(async (e) => {
    const s = await h.session(alex);
    throw new Error(`${e.message} — it is "${(await delivered()).status}"; the terminal:\n${s?.tmuxPane ? h.tmux('capture-pane', '-p', '-J', '-t', s.tmuxPane) : ''}`);
  });
  // Sent once: the next message is its own prompt, not glued to this one.
  // (Said when the turn of the first has ended — a message that arrives during a turn is handed over through the Stop
  // hook instead of being typed, and then there is no second paste to count.)
  await waitFor(async () => (await h.session(alex))?.inTurn === false, { label: 'between turns', timeout: 20000 });
  const next = (await as(h.token, 'POST', `/employees/${alex}/message`, { body: 'And one more thing.' })).body;
  await waitFor(async () => (await h.state()).messages.find((m) => m.id === next.id)!.delivery.status === 'confirmed', { label: 'the next message', timeout: 20000 });
  const s = await h.session(alex);
  const pane = h.tmux('capture-pane', '-p', '-J', '-S', '-200', '-t', s!.tmuxPane!);
  assert.ok(pane.split('\n').filter((l) => /^> \[pasted \d+ chars\]\s*$/.test(l)).length >= 2, pane);
});

test('the other way: an employee gives the boss a file — in the conversation when there is no task, on the task when there is one', async () => {
  const { handleMcpPost } = await import('@orchestrator/integrations');
  const path = await import('node:path');
  const eng = h.server.engine;
  const employee = eng.core.employees.require(alex);
  const tool = async (name: string, args: Record<string, unknown>) => {
    const session = eng.core.runningSessionOf(alex) ?? eng.core.sessionOf(alex)!;
    const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, eng.mcp, { employee, session });
    return { text: String(res.body.result?.content?.[0]?.text ?? JSON.stringify(res.body)), isError: res.body.result?.isError === true };
  };
  await h.api('POST', `/employees/${alex}/start`, {}).catch(() => undefined);
  const cwd = await waitFor(async () => (await h.session(alex))?.cwd, { label: 'Alex has a session' });
  fs.writeFileSync(path.join(cwd, 'mockup.png'), PNG);
  fs.writeFileSync(path.join(cwd, 'export.csv'), 'a,b\n1,2\n');
  assert.equal(eng.tasks.currentTask(alex), undefined, 'no task in progress');

  // With no task: into the conversation. A picture is served as a picture, anything else as a download.
  const shown = await tool('attach_file', { path: 'mockup.png', caption: 'The new header' });
  assert.equal(shown.isError, false, shown.text);
  assert.match(shown.text, /mockup\.png \(\d+ bytes\) is in your conversation with the boss, where they see it: The new header/);
  const given = await tool('attach_file', { path: path.join(cwd, 'export.csv') });
  assert.match(given.text, /export\.csv .* is in your conversation with the boss, where they can download it/);
  const events = (await h.api<any[]>('GET', `/events?employeeId=${alex}&limit=50`)).filter((e) => e.type === 'agent.file_given');
  assert.deepEqual(events.map((e) => [e.data.file.name, e.data.file.mime, e.data.caption, e.data.taskId ?? null]), [['mockup.png', 'image/png', 'The new header', null], ['export.csv', 'text/csv', null, null]]);
  const picture = await as(h.token, 'GET', `/employees/${alex}/files/${events[0]!.data.file.id}`);
  assert.deepEqual([picture.status, picture.type, picture.bytes.equals(PNG), /^inline/.test(picture.disposition ?? '')], [200, 'image/png', true, true]);
  const sheet = await as(h.token, 'GET', `/employees/${alex}/files/${events[1]!.data.file.id}`);
  assert.deepEqual([sheet.status, sheet.type, sheet.bytes.toString(), /^attachment/.test(sheet.disposition ?? '')], [200, 'application/octet-stream', 'a,b\n1,2\n', true]);
  assert.equal((await h.state()).notifications.filter((n) => /Alex gave you a file/.test(n.title)).length, 2);
  // A visitor does not get it; a file that is not there is said; a path outside what the machine lets be read is refused.
  assert.ok((await as(visitor, 'GET', `/employees/${alex}/files/${events[0]!.data.file.id}`)).status >= 400);
  assert.equal((await tool('attach_file', { path: 'nothing-here.png' })).isError, true);
  assert.equal((await tool('attach_file', { path: '/etc/passwd' })).isError, true);

  // Kept as long as a file that was said, then no longer.
  assert.equal(eng.saidFiles.sweep(Date.now() + SAID_KEEP_MS - 60_000), 0);
  assert.ok(eng.saidFiles.sweep(Date.now() + SAID_KEEP_MS + 60_000) >= 2);
  assert.equal((await as(h.token, 'GET', `/employees/${alex}/files/${events[0]!.data.file.id}`)).status, 404);

  // On a task: left on the task as evidence, and said in the conversation with the task it is on.
  const t = await h.task({ projectId: employee.projectId!, title: 'Draw the header', assigneeId: alex, description: 'Wait.' });
  await waitFor(async () => (await h.getTask(t.id)).status === 'IN_PROGRESS', { label: 'in progress', timeout: 30000 });
  fs.writeFileSync(path.join((await h.session(alex))!.cwd, 'result.png'), PNG);
  assert.match((await tool('attach_file', { path: 'result.png', caption: 'Done' })).text, /result\.png .* is on T-\d+ as evidence/);
  const onTask = (await h.getTask(t.id)).attachments!;
  assert.deepEqual(onTask.map((a) => [a.name, a.kind]), [['result.png', 'evidence']]);
  const last = (await h.api<any[]>('GET', `/events?employeeId=${alex}&limit=50`)).filter((e) => e.type === 'agent.file_given').pop();
  assert.deepEqual([last.data.file.id, last.data.taskId], [onTask[0]!.id, t.id]);
});
