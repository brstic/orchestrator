/**
 * Tickets as the owner asked for them on 2026-11-12 (`docs/TASKS.md`): every task is reviewed unless chosen
 * otherwise — by a colleague, then the boss; a ticket has a conversation, where people and employees write, tag each
 * other, and ask instead of blocking (the ticket waits for the answer); a ticket can be sent back, also when it is
 * done; and a ticket can be divided into parts that colleagues work on together.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handleMcpPost } from '@orchestrator/integrations';
import type { Task } from '@orchestrator/contracts';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let shop = '';
const ids: Record<string, string> = {};

/** Call one of the office's tools as this employee's session would. */
const tool = async (who: string, name: string, args: Record<string, unknown> = {}) => {
  const eng = h.server.engine;
  const employee = eng.core.employees.require(ids[who]!);
  const session = eng.core.runningSessionOf(employee.id) ?? eng.core.sessionOf(employee.id) ?? ({ id: `none-${employee.id}`, employeeId: employee.id, hostId: employee.hostId } as any);
  const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, eng.mcp, { employee, session });
  return { text: String(res.body.result?.content?.[0]?.text ?? JSON.stringify(res.body)), isError: res.body.result?.isError === true };
};
const task = async (id: string): Promise<Task> => (await h.state()).tasks.find((t) => t.id === id)!;
const until = (id: string, what: (t: Task) => boolean, label: string, timeout = 40000) => waitFor(async () => (what(await task(id)) ? task(id) : null), { label, timeout });
const kinds = (t: Task) => (t.comments ?? []).map((c) => c.kind);
const messagesTo = async (who: string) => (await h.state()).messages.filter((m) => m.toEmployeeId === ids[who]);
/** A task somebody is at work on and that stays so (nothing in it for the scripted worker to do). */
const inProgress = async (who: string, title: string, extra: Record<string, unknown> = {}) => {
  const t = await h.task({ projectId: shop, title, assigneeId: ids[who], description: 'Wait for what is said on the ticket.', reviewBy: 'boss', ...extra });
  return until(t.id, (x) => x.status === 'IN_PROGRESS' && x.delivery.status !== 'queued', `${title} is with ${who}`).catch(async (e) => {
    const now = await task(t.id);
    const theirs = (await h.state()).tasks.filter((x) => x.assigneeId === ids[who] && x.status !== 'DONE').map((x) => `${x.key} ${x.status} ${x.title}`);
    const ses = h.server.engine.core.runningSessionOf(ids[who]!);
    const pane = ses?.tmuxPane ? h.tmux('capture-pane', '-p', '-J', '-S', '-40', '-t', ses.tmuxPane).split('\n').filter((l) => l.trim()).slice(-14).join(' ⏎ ') : 'no pane';
    throw new Error(`session: ${ses ? `${ses.status} inTurn=${ses.inTurn} ${ses.activity} cwd=${ses.cwd}` : 'none'}; queued: ${h.server.engine.comms.queued(ids[who]!).map((d) => `${d.marker}:${d.attempts}`).join(',')}; pane: ${pane} ;; ${(e as Error).message} — it is ${now.status} (${now.blockedReason ?? now.delivery.detail ?? ''}); ${who} has: ${theirs.join(' | ')}; history: ${now.history.map((x) => x.note).join(' / ')}`);
  });
};
const finish = async (who: string) => {
  const res = await tool(who, 'complete_task', { summary: `${who} finished it`, no_code_changes: true });
  assert.equal(res.isError, false, res.text);
};

before(async () => {
  // The office as it really starts: reviewed by a colleague, then the boss.
  h = await createHarness({ reviewDefault: 'both' });
  shop = (await h.project('Shop', h.makeRepo('shop'), { verifyCommand: null })).id;
  ids.Alex = (await h.employee('Alex', 'backend', { projectId: shop, autonomy: 'autonomous' })).id;
  ids.Sarah = (await h.employee('Sarah', 'frontend', { projectId: shop, autonomy: 'autonomous' })).id;
  ids.Rita = (await h.employee('Rita', 'reviewer', { projectId: shop, autonomy: 'autonomous' })).id;
  ids['Shop Panel Dev'] = (await h.employee('Shop Panel Dev', 'frontend', { projectId: shop, autonomy: 'autonomous' })).id;
});
after(async () => {
  await h?.cleanup();
});

test('every task is reviewed unless chosen otherwise: a colleague first, then the boss', async () => {
  const made = await h.task({ projectId: shop, title: 'Add the footer', assigneeId: ids.Alex, description: '@@fake: write footer.txt ok; commit footer; complete footer added@@' });
  assert.deepEqual([made.requiresReview, made.reviewBy], [true, 'both']);
  // Work that makes no commits is reviewed as well; a task somebody chose "no review" for is not.
  const research = await h.task({ projectId: shop, title: 'Read up on fonts', kind: 'research', released: false });
  const unreviewed = await h.task({ projectId: shop, title: 'Typo', requiresReview: false, released: false });
  const mine = await h.task({ projectId: shop, title: 'Mine alone', reviewBy: 'boss', released: false });
  assert.deepEqual([research.reviewBy, unreviewed.reviewBy, unreviewed.requiresReview, mine.reviewBy], ['both', 'none', false, 'boss']);

  // Handed in: a colleague is asked first.
  const peer = await until(made.id, (t) => t.status === 'REVIEW' && !!t.reviewerId, 'the footer is with a reviewer');
  assert.deepEqual([peer.reviewStage, peer.reviewerId], ['peer', ids.Rita]);
  // Her approval is the first of two: the task is still in review, now the boss's.
  const boss = await until(made.id, (t) => t.reviewStage === 'boss', 'Rita approved; the boss is next');
  assert.equal(boss.status, 'REVIEW');
  assert.equal(boss.evidence.peerReview?.reviewerId, ids.Rita);
  assert.equal(boss.evidence.review, null);
  const note = (await h.state()).notifications.find((n) => n.kind === 'review' && n.taskId === made.id && !n.resolvedAt);
  assert.match(note?.body ?? '', /Rita approved it/);
  // Her own review is finished by that verdict: she is free again, also while the boss has not looked yet.
  await waitFor(async () => (await h.state()).tasks.find((x) => x.reviewOf === made.id)?.status === 'DONE', { label: 'Rita\'s review is done', timeout: 20000 });
  // A colleague cannot approve it once more in the boss's place.
  const again = await tool('Sarah', 'submit_review', { task: made.key, verdict: 'approve', comments: 'fine by me too' });
  assert.deepEqual([again.isError, /approved by Rita and now waits for the boss/.test(again.text)], [true, true], again.text);
  assert.equal((await task(made.id)).status, 'REVIEW');
  // The boss approves: done, and merged.
  await h.api('POST', `/tasks/${made.id}/review`, { verdict: 'approve', comments: '' });
  const done = await until(made.id, (t) => t.status === 'DONE', 'the footer is done');
  assert.equal(done.evidence.merge?.ok, true);
  assert.deepEqual(kinds(done), ['handed_in', 'approved', 'approved']);
  assert.deepEqual((done.comments ?? []).map((c) => c.from.name), ['Alex', 'Rita', 'The boss']);
});

test('"the boss alone" asks no colleague, and a ticket is sent back — from review, and when it is done', async () => {
  const t = await h.task({ projectId: shop, title: 'Add the header', assigneeId: ids.Alex, reviewBy: 'boss', description: '@@fake: write header.txt draft; commit header; complete header added@@' });
  const first = await until(t.id, (x) => x.status === 'REVIEW', 'the header is in review');
  assert.equal(first.reviewStage, 'boss');
  assert.equal((await h.state()).tasks.filter((x) => x.reviewOf === t.id).length, 0, 'no review was made for a colleague');
  // Sending back says what should change.
  assert.equal((await h.apiRaw('POST', `/tasks/${t.id}/send-back`, { note: ' ' })).status, 400);
  await h.api('POST', `/tasks/${t.id}/send-back`, { note: 'Make it final. @@fake-retry: write header.txt final; commit final header; complete header is final@@' });
  const second = await until(t.id, (x) => x.status === 'REVIEW' && x.attempts === 1, 'back in review after the rework');
  assert.deepEqual(kinds(second), ['handed_in', 'sent_back', 'handed_in']);
  assert.equal(second.evidence.review, null, 'what was sent back is reviewed anew');
  await h.api('POST', `/tasks/${t.id}/review`, { verdict: 'approve', comments: 'Good.' });
  const done = await until(t.id, (x) => x.status === 'DONE', 'the header is done');
  const branch = done.branch!;

  // Done is not the end: it is opened again for its author, as new work from where the project stands now.
  await h.api('POST', `/tasks/${t.id}/send-back`, { note: 'It also needs a subtitle. @@fake-retry: write subtitle.txt ok; commit subtitle; complete subtitle added@@' });
  const reopened = await task(t.id);
  assert.deepEqual([reopened.reopened, reopened.completedAt, reopened.assigneeId], [1, null, ids.Alex]);
  assert.ok(['READY', 'IN_PROGRESS'].includes(reopened.status), reopened.status);
  const third = await until(t.id, (x) => x.status === 'REVIEW' && x.attempts === 2, 'back in review after it was opened again');
  assert.notEqual(third.branch, branch);
  assert.match(third.branch ?? '', /-r1-/);
  assert.deepEqual(third.evidence.commits.map((c) => c.subject), ['subtitle'], 'only the new work counts as this attempt');
  assert.equal(kinds(third).filter((k) => k === 'sent_back').length, 2);
  await h.api('POST', `/tasks/${t.id}/review`, { verdict: 'approve', comments: '' });
  await until(t.id, (x) => x.status === 'DONE', 'done again');
});

test('a comment reaches who it is for: whoever works on the ticket, and whoever is tagged', async () => {
  const t = await inProgress('Alex', 'Pick the colours');
  // A person's comment on a ticket somebody is working on goes to them.
  await h.api('POST', `/tasks/${t.id}/comments`, { body: 'Use the blue one.' });
  const told = await waitFor(async () => (await messagesTo('Alex')).find((m) => m.kind === 'comment' && m.taskId === t.id && m.body.includes('Use the blue one.')), { label: 'Alex is told' });
  assert.match(told.body, new RegExp(`Comment from the boss on ${t.key} .*which you are working on`));
  assert.equal((await h.apiRaw('POST', `/tasks/${t.id}/comments`, { body: '  ' })).status, 400);

  // An employee tags a colleague and the boss; a name that is nobody's is said, and nobody is told about a comment without tags.
  const tagged = await tool('Alex', 'comment_on_task', { text: '@Sarah which endpoint do you expose? @boss for your information. @Nobody too. Mail joe@Rita.example if needed.' });
  assert.equal(tagged.isError, false, tagged.text);
  assert.match(tagged.text, /Sarah, the boss are told/);
  assert.match(tagged.text, /Nobody here is called "Nobody"/);
  const forSarah = (await messagesTo('Sarah')).find((m) => m.kind === 'comment' && m.taskId === t.id);
  assert.match(forSarah?.body ?? '', new RegExp(`^Alex \\(.*\\) tagged you on ${t.key} `));
  assert.match(forSarah?.body ?? '', new RegExp(`comment_on_task with task "${t.key}"`));
  assert.equal((await messagesTo('Rita')).filter((m) => m.taskId === t.id).length, 0, 'an address is not a tag');
  const mention = (await h.state()).notifications.find((n) => n.kind === 'mention' && n.taskId === t.id);
  assert.match(mention?.title ?? '', new RegExp(`Alex tagged you on ${t.key}`));
  assert.match((await tool('Alex', 'comment_on_task', { text: 'Went with the blue one.' })).text, /nobody was tagged, so nobody is told/);

  // A colleague writes on a ticket somebody else is working on: that somebody reads it.
  const before = (await messagesTo('Alex')).length;
  const reply = await tool('Sarah', 'comment_on_task', { task: t.key, text: 'GET /api/items — it is live.' });
  assert.match(reply.text, /Alex is told/);
  const got = (await messagesTo('Alex')).slice(before).find((m) => m.kind === 'comment');
  assert.match(got?.body ?? '', /Sarah \(.*\) commented on .*which you are working on:\nGET \/api\/items/);
  const now = await task(t.id);
  assert.deepEqual(kinds(now), ['note', 'note', 'note', 'note']);
  assert.deepEqual(now.comments![1]!.mentions.map((m) => (m.kind === 'boss' ? 'boss' : m.name)), ['Sarah', 'boss']);

  // Names with spaces, and the longest one that matches.
  const found = h.server.engine.talk.mentionsIn('ask @Shop Panel Dev, then @Rita. Not sarah@example.com.', ['Alex']);
  assert.deepEqual(found.mentions.map((m) => (m.kind === 'boss' ? 'boss' : m.name)), ['Shop Panel Dev', 'Rita', 'Alex']);
  assert.match((await tool('Rita', 'comment_on_task', { task: 'T-9999', text: 'hello' })).text, /No task "T-9999" that you can see/);
  await finish('Alex');
});

test('asking instead of blocking: the call waits for the answer, which is given on the ticket', async () => {
  const t = await inProgress('Alex', 'Choose the database');
  const asking = tool('Alex', 'comment_on_task', { text: 'Postgres or SQLite?', ask: true });
  const open = await until(t.id, (x) => (x.comments ?? []).some((c) => c.kind === 'question' && !!c.questionId), 'the question is on the ticket');
  const q = open.comments!.find((c) => c.kind === 'question')!;
  // It is one of the office's questions too: the Inbox has it.
  const office = (await h.state()).questions.find((x) => x.id === q.questionId)!;
  assert.deepEqual([office.status, office.taskId, office.text], ['open', t.id, 'Postgres or SQLite?']);
  await h.api('POST', `/tasks/${t.id}/comments`, { body: 'Postgres.' });
  assert.deepEqual(await asking, { text: 'The boss answered: Postgres.', isError: false });
  const after = await task(t.id);
  assert.equal(after.status, 'IN_PROGRESS', 'answered in time: the ticket never stopped');
  assert.deepEqual(kinds(after), ['question', 'answer']);
  assert.equal(after.comments![0]!.answeredBy, after.comments![1]!.id);
  const answered = (await h.state()).questions.find((x) => x.id === q.questionId)!;
  assert.equal(answered.status, 'delivered');
  assert.equal(answered.answer, 'Postgres.');
  // Only on the ticket one is working on.
  const other = await tool('Sarah', 'comment_on_task', { task: t.key, text: 'And the port?', ask: true });
  assert.deepEqual([other.isError, /only ask-and-wait on the ticket you are working on/.test(other.text)], [true, true]);
  await finish('Alex');
});

test('a question that is a choice carries its choices, and a comment carries its pictures', async () => {
  const eng = h.server.engine;
  const t = await inProgress('Alex', 'Pick the layout');
  // Two pictures on Alex's machine: one named, one whose path only stands in the text.
  const cwd = eng.core.runningSessionOf(ids.Alex!)!.cwd;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(cwd, 'layout-a.png'), png);
  fs.writeFileSync(path.join(cwd, 'layout-b.png'), png);
  const asking = tool('Alex', 'comment_on_task', {
    text: `Which layout? B is at ${path.join(cwd, 'layout-b.png')}, and see https://example.com/not-mine.png too.`,
    ask: true,
    options: [{ label: 'Layout A', description: 'One column', consequence: 'Ships today' }, { label: 'Layout B' }, { nonsense: true }],
    why: 'The list is built differently for each.',
    files: ['layout-a.png', 'no-such-file.png'],
  });
  const asked = await until(t.id, (x) => (x.comments ?? []).some((c) => c.kind === 'question' && !!c.questionId), 'the question is on the ticket');
  const q = asked.comments!.find((c) => c.kind === 'question')!;
  assert.deepEqual(q.options, [{ label: 'Layout A', description: 'One column', consequence: 'Ships today' }, { label: 'Layout B' }]);
  // Both pictures are on the ticket and belong to the comment; an address on the web is not a file of his.
  assert.deepEqual((asked.attachments ?? []).map((a) => [a.name, a.kind, a.addedBy.name]), [['layout-a.png', 'evidence', 'Alex'], ['layout-b.png', 'evidence', 'Alex']]);
  assert.deepEqual(q.attachmentIds, asked.attachments!.map((a) => a.id));
  // At the desk and in the Inbox it is the same question, with the same choices to click.
  const office = (await h.state()).questions.find((x) => x.id === q.questionId)!;
  assert.deepEqual([office.kind, office.options.map((o) => o.label), office.why], ['decision', ['Layout A', 'Layout B'], 'The list is built differently for each.']);
  // Clicking a choice is answering with its words.
  await h.api('POST', `/tasks/${t.id}/comments`, { body: 'Layout B' });
  const res = await asking;
  assert.equal(res.isError, false);
  assert.match(res.text, /^The boss answered: Layout B/);
  // (A file that was named and could not be read is said; the question is asked all the same.)
  const plain = await tool('Alex', 'comment_on_task', { text: 'Here is what it looks like now.', files: ['no-such-file.png'] });
  assert.match(plain.text, /no-such-file\.png was not attached/);
  // (The pictures were copies for the office; in the folder they would be uncommitted work.)
  for (const f of ['layout-a.png', 'layout-b.png']) fs.rmSync(path.join(cwd, f));
  await finish('Alex');
});

test('no answer in time: the ticket waits by itself, the employee is free, and the answer brings it back', async () => {
  const eng = h.server.engine;
  const usual = eng.core.timings.askBossWaitMs;
  eng.core.timings.askBossWaitMs = 700;
  try {
    const t = await inProgress('Alex', 'Choose the region');
    const res = await tool('Alex', 'comment_on_task', { text: 'Which region do we deploy to?', ask: true });
    assert.match(res.text, new RegExp(`No answer from the boss yet\\. ${t.key} now waits for it`));
    const parked = await task(t.id);
    assert.equal(parked.status, 'BLOCKED');
    assert.equal(parked.waitingFor?.kind, 'answer');
    assert.match(parked.blockedReason ?? '', /^Waiting for an answer from the boss: Which region/);
    assert.equal(eng.tasks.currentTask(ids.Alex), undefined, 'Alex is free for other work');
    assert.equal((await h.state()).notifications.filter((n) => n.kind === 'blocked' && n.taskId === t.id).length, 0, 'a question is not an alarm');
    // Answered where the office's questions are answered: the ticket goes back to Alex with it, once.
    const q = parked.comments!.find((c) => c.kind === 'question')!;
    const before = (await messagesTo('Alex')).length;
    await h.api('POST', `/questions/${q.questionId}/answer`, { answer: 'eu-west' });
    const back = await until(t.id, (x) => x.status === 'IN_PROGRESS', 'back with Alex');
    assert.equal(back.waitingFor ?? null, null);
    assert.deepEqual(kinds(back), ['question', 'answer']);
    const news = (await messagesTo('Alex')).slice(before);
    assert.deepEqual(news.map((m) => m.body), [`The boss answered on ${t.key}: eu-west\nGo on with the task with this.`]);
    assert.match((await h.state()).questions.find((x) => x.id === q.questionId)!.deliveryDetail ?? '', /Given back with the task that waited for it/);
    await finish('Alex');
  } finally {
    eng.core.timings.askBossWaitMs = usual;
  }
});

test('a colleague is asked the same way — and answers on the ticket', async () => {
  const eng = h.server.engine;
  const t = await inProgress('Alex', 'Wire the endpoint');
  const asking = tool('Alex', 'comment_on_task', { text: '@Sarah what is the path of the items endpoint?', ask: true });
  const forSarah = await waitFor(async () => (await messagesTo('Sarah')).find((m) => m.taskId === t.id && /cannot go on without your answer/.test(m.body)), { label: 'Sarah is asked' });
  assert.match(forSarah.body, new RegExp(`^Alex \\(.*\\) asks you on ${t.key} `));
  assert.equal((await h.state()).questions.filter((x) => x.taskId === t.id).length, 0, 'not a question for the boss');
  const said = await tool('Sarah', 'comment_on_task', { task: t.key, text: 'GET /api/items' });
  assert.match(said.text, new RegExp(`Your answer is on ${t.key}`));
  assert.deepEqual(await asking, { text: 'Sarah answered: GET /api/items', isError: false });
  assert.equal((await task(t.id)).status, 'IN_PROGRESS');

  // Not answered in time: parked on Sarah's answer, and her answer brings it back to Alex.
  const usual = eng.core.timings.askBossWaitMs;
  eng.core.timings.askBossWaitMs = 600;
  try {
    const res = await tool('Alex', 'comment_on_task', { text: 'And which version?', to: ['Sarah'], ask: true });
    assert.match(res.text, new RegExp(`No answer from Sarah yet\\. ${t.key} now waits for it`));
    assert.match((await task(t.id)).blockedReason ?? '', /^Waiting for an answer from Sarah: And which version/);
    const before = (await messagesTo('Alex')).length;
    const answer = await tool('Sarah', 'comment_on_task', { task: t.key, text: 'v2' });
    assert.match(answer.text, /the ticket is back with Alex/);
    const back = await until(t.id, (x) => x.status === 'IN_PROGRESS', 'back with Alex');
    assert.deepEqual(kinds(back), ['question', 'answer', 'question', 'answer']);
    assert.deepEqual((await messagesTo('Alex')).slice(before).map((m) => m.body), [`Sarah answered on ${t.key}: v2\nGo on with the task with this.`]);
  } finally {
    eng.core.timings.askBossWaitMs = usual;
  }
  await finish('Alex');
});

test('a reported blocker is said on the ticket, and the boss\'s reply there is what unblocks it', async () => {
  const t = await inProgress('Alex', 'Deploy the shop');
  await tool('Alex', 'report_blocker', { reason: 'I have no access to the server', needs: 'an SSH key' });
  const blocked = await task(t.id);
  assert.equal(blocked.status, 'BLOCKED');
  assert.deepEqual(kinds(blocked), ['question']);
  assert.match(blocked.comments![0]!.body, /I cannot go on: I have no access to the server\nWhat I need: an SSH key/);
  await h.api('POST', `/tasks/${t.id}/comments`, { body: 'The key is in the vault now.' });
  const back = await until(t.id, (x) => x.status === 'IN_PROGRESS', 'unblocked by the reply');
  assert.deepEqual(kinds(back), ['question', 'answer']);
  assert.equal(back.description, 'Wait for what is said on the ticket.', 'the reply is in the conversation, not appended to the task');
  // The old button still works, and closes the question the same way.
  await tool('Alex', 'report_blocker', { reason: 'the server is down' });
  await h.api('POST', `/tasks/${t.id}/unblock`, { note: 'It is up again.' });
  const again = await until(t.id, (x) => x.status === 'IN_PROGRESS', 'unblocked by the button');
  assert.deepEqual(kinds(again), ['question', 'answer', 'question', 'answer']);
  assert.equal(again.comments![3]!.body, 'It is up again.');
  await finish('Alex');
});

test('several employees on one ticket: it is divided into parts, waits for them, and comes back to whoever leads it', async () => {
  const eng = h.server.engine;
  const t = await inProgress('Alex', 'Build the checkout', { helperIds: [ids.Sarah], reviewBy: 'both' });
  assert.deepEqual(t.helperIds, [ids.Sarah]);
  assert.match(eng.talk.promptLines(t, eng.core.employees.require(ids.Alex)).join('\n'), /The boss put Sarah \(.*\) on this ticket with you; you lead it\. Divide the work with split_task/);
  // A part needs a real description; and nobody gives a part to somebody who cannot take it.
  assert.match((await tool('Alex', 'split_task', { parts: [{ title: 'Form', description: 'do it' }] })).text, /needs a real description/);
  assert.match((await tool('Alex', 'split_task', { parts: [{ title: 'Form', description: 'Build the payment form in form.txt', assignee: 'Nobody' }] })).text, /No colleague matches "Nobody"/);
  assert.equal(eng.talk.partsOf(await task(t.id)).length, 0, 'a split that is refused leaves nothing behind');

  const split = await tool('Alex', 'split_task', {
    parts: [
      { title: 'Build the payment form', description: 'Build the payment form in form.txt. @@fake: write form.txt ok; commit form; complete the form is built@@' },
      { title: 'Check the totals', description: 'Go through the totals by hand and say what is wrong.', assignee: 'Rita' },
    ],
  });
  assert.equal(split.isError, false, split.text);
  const parts = eng.talk.partsOf(await task(t.id));
  assert.deepEqual(parts.map((p) => [p.parentId, p.reviewBy, p.requiresReview, p.assigneeId]), [[t.id, 'none', false, ids.Sarah], [t.id, 'none', false, ids.Rita]], 'the colleague put on the ticket gets the part nobody was named for');
  assert.deepEqual(kinds(await task(t.id)), ['split']);
  // What the colleague is told with their part: what it is a part of, and where to talk.
  assert.match(eng.talk.promptLines(parts[0]!, eng.core.employees.require(ids.Sarah)).join('\n'), new RegExp(`This is one part of ${t.key} "Build the checkout", which Alex leads\\..*tagging @Alex`));

  // The lead's own part is finished first: the ticket waits for the others.
  const early = await tool('Alex', 'complete_task', { summary: 'The cart is wired.', no_code_changes: true });
  assert.match(early.text, new RegExp(`${t.key} is not complete yet: .*still open`));
  const waiting = await task(t.id);
  assert.deepEqual([waiting.status, waiting.waitingFor?.kind], ['BLOCKED', 'parts']);
  // A part is not split again.
  await until(parts[1]!.id, (x) => x.status === 'IN_PROGRESS', 'Rita has her part').catch(async (e) => {
    const now = await task(parts[1]!.id);
    const ses = eng.core.runningSessionOf(ids.Rita!);
    const theirs = (await h.state()).tasks.filter((x) => x.assigneeId === ids.Rita && x.status !== 'DONE').map((x) => `${x.key} ${x.status} ${x.title}`);
    throw new Error(`${(e as Error).message} — it is ${now.status} (${now.blockedReason ?? ''}); Rita: ${ses ? `${ses.status} inTurn=${ses.inTurn} ${ses.activity}` : 'no session'}; has ${theirs.join(' | ')}; history: ${now.history.map((x) => x.note).join(' / ')}`);
  });
  assert.match((await tool('Rita', 'split_task', { parts: [{ title: 'Half', description: 'Half of the totals, the first half.' }] })).text, /parts are not split again/);

  // Sarah's part is done by her (scripted) session; it is said on the ticket, which still waits for Rita's.
  await until(parts[0]!.id, (x) => x.status === 'DONE', 'the form is done');
  const one = await until(t.id, (x) => kinds(x).includes('part_done'), 'said on the ticket');
  assert.equal(one.status, 'BLOCKED');
  assert.match(one.blockedReason ?? '', new RegExp(`^Waiting for its parts: ${parts[1]!.key} \\(Rita\\)$`));
  // The last part brings the ticket back to its lead…
  const before = (await messagesTo('Alex')).length;
  assert.equal((await tool('Rita', 'complete_task', { summary: 'The totals add up.', no_code_changes: true })).isError, false);
  await until(parts[1]!.id, (x) => x.status === 'DONE', 'the totals are done');
  const back = await until(t.id, (x) => x.status === 'IN_PROGRESS', 'back with Alex');
  assert.equal(back.waitingFor ?? null, null);
  const news = (await messagesTo('Alex')).slice(before).map((m) => m.body).join('\n');
  assert.match(news, new RegExp(`All parts of ${t.key} are done:`));
  assert.match(news, /The totals add up\./);
  // …who hands in the whole — and the whole is what is reviewed.
  assert.equal((await tool('Alex', 'complete_task', { summary: 'Checkout works end to end.', no_code_changes: true })).isError, false);
  const review = await until(t.id, (x) => x.status === 'REVIEW', 'the whole is in review');
  assert.equal(review.reviewBy, 'both');
});
