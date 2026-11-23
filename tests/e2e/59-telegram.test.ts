/**
 * An employee's own Telegram bot (`docs/TELEGRAM.md`), against a stand-in for Telegram's Bot API: a token checked and
 * kept out of sight, a private bot that lets in only who paired with a one-time link, talking into the employee's real
 * session and the answer coming back, their questions and permission requests answered with a reply or a button, and
 * a group the bot was added to — where it answers when it is talked to, and keeps quiet when it is not.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';
import { fakeTelegram, type FakeTelegram } from './fake-telegram.ts';

const TOKEN = '123456789:AAFakeTokenForTheTestsOnly_abcdefghij';
const OTHER = '987654321:AAAnotherFakeTokenForTheTests_klmnopq';
const THIRD = '555555555:AAAThirdFakeTokenForTheTests_rstuvwxy';
const ME = { id: 501, first_name: 'Owner', username: 'owner_tg' };
const STRANGER = { id: 777, first_name: 'Stranger' };
const FRIEND = { id: 502, first_name: 'Dana' };
const GROUP = { id: -100500, type: 'group' as const, title: 'Launch team' };

let h: Harness;
let tg: FakeTelegram;
let kira: { id: string };
let pairLink = '';

const codeOf = (link: string) => new URL(link).searchParams.get('start') ?? new URL(link).searchParams.get('startgroup')!;
const textTo = (chat: number, re: RegExp) => (s: { method: string; body: Record<string, any> }) => s.method === 'sendMessage' && s.body.chat_id === chat && re.test(String(s.body.text));

before(async () => {
  tg = await fakeTelegram();
  tg.bot(TOKEN, 9001, 'kira_office_bot', true);
  tg.bot(OTHER, 9002, 'other_office_bot', false);
  tg.bot(THIRD, 9003, 'third_office_bot', true);
  h = await createHarness({ telegramApi: tg.url });
  const repo = h.makeRepo('tg-shop');
  const project = await h.project('Shop', repo);
  kira = await h.employee('Kira', 'backend', { projectId: project.id, autonomy: 'auto' });
});
after(async () => {
  await h.cleanup();
  await tg.close();
});

test('a token is checked with Telegram and kept out of sight; a wrong one is refused in words', async () => {
  assert.match((await h.apiRaw('PUT', `/employees/${kira.id}/telegram`, { token: 'not a token' })).body.error, /does not look like a bot token/);
  assert.match((await h.apiRaw('PUT', `/employees/${kira.id}/telegram`, { token: '111111111:AAUnknownTokenUnknownTokenUnknownTok' })).body.error, /Telegram does not know this token/);
  const r = await h.api<any>('PUT', `/employees/${kira.id}/telegram`, { token: TOKEN });
  assert.equal(r.connected, true);
  assert.equal(r.bot.username, 'kira_office_bot');
  assert.equal(r.hearsAll, true);
  assert.match(r.link, /^https:\/\/t\.me\/kira_office_bot\?start=[A-Za-z0-9_-]{20,}$/);
  assert.match(r.groupLink, /^https:\/\/t\.me\/kira_office_bot\?startgroup=/);
  pairLink = r.link;
  // The token is nowhere a window, an event or the state could show it.
  const everywhere = JSON.stringify([await h.api('GET', `/employees/${kira.id}/telegram`), await h.state(), await h.api('GET', '/events?limit=200')]);
  assert.ok(!everywhere.includes(TOKEN.split(':')[1]!), 'the token leaked');
  // One bot, one employee.
  const ana = await h.employee('Ana', 'frontend');
  assert.match((await h.apiRaw('PUT', `/employees/${ana.id}/telegram`, { token: TOKEN })).body.error, /already belongs to Kira/);
});

test('the bot is private: a stranger is told so and nothing reaches the employee; a used or wrong link does not pair', async () => {
  tg.message(TOKEN, STRANGER, 'hello there @@fake: say should-never-run@@');
  await tg.waitSent(textTo(STRANGER.id, /belongs to an office and is private/));
  tg.message(TOKEN, STRANGER, '/start not-the-code');
  await tg.waitSent(textTo(STRANGER.id, /used or is too old/));
  assert.ok(!(await h.state()).messages.some((m) => m.toEmployeeId === kira.id), 'a stranger reached the employee');
});

test('pairing with the link: the person is in, and what they write goes into the real session — the answer comes back', async () => {
  tg.message(TOKEN, ME, `/start ${codeOf(pairLink)}`);
  await tg.waitSent(textTo(ME.id, /^Connected\. You are talking to Kira/));
  const view = await h.api<any>('GET', `/employees/${kira.id}/telegram`);
  assert.deepEqual(view.people.map((p: any) => [p.tgId, p.username, p.as]), [[ME.id, 'owner_tg', (await h.state()).settings.ownerName || 'the boss']].map(([a, b]) => [a, b, view.people[0].as]));
  // The same link does not work twice.
  tg.message(TOKEN, STRANGER, `/start ${codeOf(pairLink)}`);
  await tg.waitSent((s) => textTo(STRANGER.id, /used or is too old/)(s) && tg.sent.filter(textTo(STRANGER.id, /used or is too old/)).length >= 2);
  // Talking: Kira had no session — she is brought in, shows "typing…", and her answer comes back.
  tg.message(TOKEN, ME, 'How is the shop going? @@fake: sleep 1500; say telegram-answer-4411@@');
  await tg.waitSent(textTo(ME.id, /telegram-answer-4411/), 40_000);
  assert.ok(tg.sent.some((s) => s.method === 'sendChatAction' && s.body.chat_id === ME.id && s.body.action === 'typing'), 'no "typing…" while she worked');
  const msg = (await h.state()).messages.find((m) => m.toEmployeeId === kira.id && /How is the shop going/.test(m.body))!;
  assert.equal(msg.channel, 'telegram');
  // /status says what she is doing.
  tg.message(TOKEN, ME, '/status');
  await tg.waitSent(textTo(ME.id, /^Kira/));
});

test('a picture sent to the bot goes to the employee with the message', async () => {
  tg.message(TOKEN, ME, 'Look at the banner @@fake: say got-the-picture-9031@@', { photo: true });
  await tg.waitSent(textTo(ME.id, /got-the-picture-9031/), 30_000);
  const msg = (await h.state()).messages.find((m) => m.toEmployeeId === kira.id && /Look at the banner/.test(m.body))!;
  assert.equal(msg.files?.length, 1);
  assert.match(msg.files![0]!.name, /^photo-\d+\.jpg$/);
});

test('her question comes to Telegram, and a reply to it answers it', async () => {
  tg.message(TOKEN, ME, 'Plan the release @@fake: ask Should the release go out on Friday?; say asked-about-friday@@');
  const asked = await tg.waitSent(textTo(ME.id, /Kira asks:\nShould the release go out on Friday\?/), 30_000);
  tg.message(TOKEN, ME, 'Yes, Friday morning.', { replyTo: { message_id: asked.messageId!, from: { id: 9001 } } });
  await tg.waitSent(textTo(ME.id, /✓ Answered/));
  const q = (await h.state()).questions.find((x) => x.employeeId === kira.id && /Friday/.test(x.text))!;
  assert.equal(q.status === 'open', false);
  assert.match(q.answer ?? '', /Friday morning/);
  // The message in Telegram now says how it was answered.
  await tg.waitSent((s) => s.method === 'editMessageText' && s.body.message_id === asked.messageId && /Answered: Yes, Friday morning/.test(s.body.text));
});

test('what she writes to the boss (message_person) comes to Telegram as well, from her own bot', async () => {
  tg.message(TOKEN, ME, 'Tell me when the notes are ready @@fake: mcp message_person {"to":"boss","message":"The release notes are ready for you to read.","urgent":true}; say wrote-to-the-boss@@');
  await tg.waitSent(textTo(ME.id, /^❗ The release notes are ready for you to read\.$/), 30_000);
  const n = (await h.state()).notifications.find((x) => x.kind === 'message' && x.employeeId === kira.id)!;
  assert.deepEqual([n.for, n.severity, n.title], [['#owners'], 'warning', 'Kira · urgent: The release notes are ready for you to read.']);
  await tg.waitSent(textTo(ME.id, /wrote-to-the-boss/));
  // Read in the office, it is not sent again.
  const before = tg.sent.filter(textTo(ME.id, /release notes are ready/)).length;
  await h.api('POST', '/notifications/read', { ids: [n.id] });
  await sleep(500);
  assert.equal(tg.sent.filter(textTo(ME.id, /release notes are ready/)).length, before);
});

test('while the boss is in the office nothing of hers goes to their Telegram; once they leave, what is still open or unread does', async () => {
  const office = await h.client();
  assert.equal((await h.api<{ here: boolean }>('GET', `/employees/${kira.id}/telegram`)).here, false, 'no window of theirs says so yet');
  office.send({ t: 'here', active: true });
  await sleep(300);
  assert.equal((await h.api<{ here: boolean }>('GET', `/employees/${kira.id}/telegram`)).here, true, 'the tab says they count as here');
  tg.message(TOKEN, ME, 'Ask me in the office @@fake: mcp message_person {"to":"boss","message":"The beta build is ready."}; ask Ship the beta to everyone?; say asked-in-office@@');
  const q = await waitFor(async () => (await h.state()).questions.find((x) => x.employeeId === kira.id && /Ship the beta/.test(x.text) && x.status === 'open'), { label: 'her question', timeout: 30_000 });
  await sleep(1500);
  assert.equal(tg.sent.filter(textTo(ME.id, /Ship the beta|beta build is ready/)).length, 0, 'kept off Telegram while the boss is in the office');
  // The boss goes away from the window: what is still open, and unread, comes now.
  office.send({ t: 'here', active: false });
  await waitFor(async () => (await h.api<{ here: boolean }>('GET', `/employees/${kira.id}/telegram`)).here === false, { label: 'no longer here' });
  const asked = await tg.waitSent(textTo(ME.id, /Kira asks:\nShip the beta to everyone\?/), 10_000);
  await tg.waitSent(textTo(ME.id, /The beta build is ready\./), 10_000);
  tg.message(TOKEN, ME, 'Not yet.', { replyTo: { message_id: asked.messageId!, from: { id: 9001 } } });
  await waitFor(async () => (await h.state()).questions.find((x) => x.id === q.id)?.status !== 'open', { label: 'answered' });
  office.close();
});

test('work that waits for the boss is told on Telegram while they are away — through a colleague\'s bot on the project when its author has none', async () => {
  const state = await h.state();
  const shop = state.employees.find((e) => e.id === kira.id)!.projectId!;
  const bo = await h.employee('Bo', 'frontend', { projectId: shop });
  const rita = await h.employee('Rita', 'reviewer', { projectId: shop });
  const t = await h.task({ projectId: shop, title: 'Add the receipt footer', assigneeId: bo.id, reviewBy: 'both', reviewerId: rita.id, description: '@@fake: write footer.txt ok; commit footer; complete footer added@@' });
  const said = await tg.waitSent(textTo(ME.id, new RegExp(`🔎 ${t.key} needs your review\\n[^\\n]*Rita approved it[\\s\\S]*Checked: Read the diff`)), 60_000);
  assert.equal(said.body.chat_id, ME.id);
  assert.equal(tg.sent.filter(textTo(ME.id, new RegExp(`${t.key} needs your review`))).length, 1, 'once');
});

test('a permission request comes with Allow and Deny; a button decides it, as the person who paired', async () => {
  const project = (await h.state()).projects.find((p) => p.name === 'Shop')!;
  const standard = await h.employee('Lio', 'devops', { autonomy: 'standard', projectId: project.id });
  const r = await h.api<any>('PUT', `/employees/${standard.id}/telegram`, { token: OTHER });
  tg.message(OTHER, ME, `/start ${codeOf(r.link)}`);
  await tg.waitSent((s) => s.token === OTHER && textTo(ME.id, /^Connected/)(s));
  tg.message(OTHER, ME, 'Set it up @@fake: bash touch pipeline-from-telegram.txt; say pipeline-done@@');
  const ask = await tg.waitSent((s) => s.token === OTHER && textTo(ME.id, /Lio asks to run Bash/)(s), 40_000);
  const allow = ask.body.reply_markup.inline_keyboard[0].find((b: any) => /Allow/.test(b.text));
  assert.ok(allow, JSON.stringify(ask.body.reply_markup));
  // A stranger's button press decides nothing.
  tg.press(OTHER, STRANGER, allow.callback_data);
  await tg.waitSent((s) => s.method === 'answerCallbackQuery' && /private/.test(s.body.text));
  tg.press(OTHER, ME, allow.callback_data);
  await tg.waitSent((s) => s.token === OTHER && textTo(ME.id, /pipeline-done/)(s), 40_000);
  const q = (await h.state()).questions.find((x) => x.employeeId === standard.id && x.kind === 'permission')!;
  assert.equal(q.decision, 'allow');
});

test('somebody who cannot start says so in Telegram, instead of typing for ever', async () => {
  const nowhere = await h.employee('Noa', 'qa');
  const r = await h.api<any>('PUT', `/employees/${nowhere.id}/telegram`, { token: THIRD });
  tg.message(THIRD, ME, `/start ${codeOf(r.link)}`);
  await tg.waitSent((s) => s.token === THIRD && textTo(ME.id, /^Connected/)(s));
  tg.message(THIRD, ME, 'hello?');
  await tg.waitSent((s) => s.token === THIRD && textTo(ME.id, /Noa cannot start: /)(s));
  await h.api('DELETE', `/employees/${nowhere.id}/telegram`);
});

test('in a group: connected with the link, it answers when it is talked to — by name, by mention, a reply, a follow-up — and not otherwise', async () => {
  const fresh = await h.api<any>('POST', `/employees/${kira.id}/telegram/pair`, {});
  tg.message(TOKEN, ME, `/start@kira_office_bot ${codeOf(fresh.groupLink)}`, { chat: GROUP });
  await tg.waitSent(textTo(GROUP.id, /connected to this group by/));
  assert.deepEqual((await h.api<any>('GET', `/employees/${kira.id}/telegram`)).groups.map((g: any) => [g.title, g.mode]), [['Launch team', 'addressed']]);
  const before = (await h.state()).messages.filter((m) => m.toEmployeeId === kira.id).length;
  // Not for her: nothing is handed over.
  tg.message(TOKEN, FRIEND, 'Who is bringing the cake on Friday?', { chat: GROUP });
  await sleep(2500);
  assert.equal((await h.state()).messages.filter((m) => m.toEmployeeId === kira.id).length, before, 'a message not for her was handed over');
  // Her name: handed over with the conversation so far, and her answer is an ordinary message in the group.
  const asked = tg.message(TOKEN, FRIEND, 'kira, can you check the checkout? @@fake: say group-answer-5520@@', { chat: GROUP });
  const answered = await tg.waitSent(textTo(GROUP.id, /group-answer-5520/), 40_000);
  assert.equal(answered.body.reply_parameters, undefined, 'answered as a reply although she did not choose to');
  const msg = (await h.state()).messages.filter((m) => m.toEmployeeId === kira.id).pop()!;
  assert.match(msg.body, /^On Telegram, in the group "Launch team"/);
  assert.match(msg.body, /Earlier in the chat:\n#\d+ Dana: Who is bringing the cake on Friday\?/, 'the conversation so far was not given');
  // A window (Talk) shows what was said, not the prompt around it; and from which group.
  assert.equal(msg.said, 'Dana: kira, can you check the checkout? @@fake: say group-answer-5520@@');
  assert.equal(msg.chat, 'Launch team');
  assert.match(msg.from.name, /Dana in the Telegram group "Launch team"/);
  // A follow-up from the person she just answered: for her too.
  tg.message(TOKEN, FRIEND, 'and the totals too please @@fake: say follow-up-answer-6630@@', { chat: GROUP });
  await tg.waitSent(textTo(GROUP.id, /follow-up-answer-6630/), 40_000);
  // In the same conversation of hers, what she was given already is not given again — nor her own answer.
  const followUp = (await h.state()).messages.filter((m) => m.toEmployeeId === kira.id).pop()!;
  assert.doesNotMatch(followUp.body, /cake|group-answer-5520|Earlier in the chat/, 'the chat she had seen was given again');
  // A mention, and a reply to her message.
  tg.message(TOKEN, ME, '@kira_office_bot status of the release? @@fake: say mention-answer-7740@@', { chat: GROUP });
  const mentioned = await tg.waitSent(textTo(GROUP.id, /mention-answer-7740/), 40_000);
  tg.message(TOKEN, STRANGER, 'thanks! one more thing @@fake: say reply-answer-8850@@', { chat: GROUP, replyTo: { message_id: mentioned.messageId!, from: { id: 9001 } } });
  await tg.waitSent(textTo(GROUP.id, /reply-answer-8850/), 40_000);
  // When she chooses to answer one message in particular: `[reply #id]` makes it a reply to it, and the mark is not shown.
  const cake = tg.message(TOKEN, { id: 603, first_name: 'Lea' }, 'and who brings the cake?', { chat: GROUP });
  await sleep(300);
  tg.message(TOKEN, ME, `kira, answer Lea please @@fake: say [reply #${cake}] chosen-reply-9960@@`, { chat: GROUP });
  const chosen = await tg.waitSent(textTo(GROUP.id, /chosen-reply-9960/), 40_000);
  assert.equal(chosen.body.reply_parameters?.message_id, cake);
  assert.doesNotMatch(chosen.body.text, /\[reply/);
});

test('a group that sends everything: what is said is handed over once it pauses, and NO_REPLY posts nothing', async () => {
  await h.api('PATCH', `/employees/${kira.id}/telegram/groups/${GROUP.id}`, { mode: 'all' });
  const count = () => tg.sent.filter((s) => s.token === TOKEN && s.method === 'sendMessage' && s.body.chat_id === GROUP.id).length;
  const posted = count();
  const n = (await h.state()).messages.filter((m) => m.toEmployeeId === kira.id).length;
  // (Two who have not talked to her: nothing here is a follow-up.)
  tg.message(TOKEN, { id: 601, first_name: 'Ivo' }, 'lunch at noon?', { chat: GROUP });
  tg.message(TOKEN, { id: 602, first_name: 'Mia' }, 'sure, the usual place @@fake: say NO_REPLY@@', { chat: GROUP });
  await waitFor(async () => (await h.state()).messages.filter((m) => m.toEmployeeId === kira.id).length > n, { label: 'the gathered messages handed over', timeout: 20_000 });
  const gathered = (await h.state()).messages.find((m) => m.toEmployeeId === kira.id && /lunch at noon/.test(m.body))!;
  assert.match(gathered.body, /lunch at noon\?[\s\S]*the usual place/);
  assert.match(gathered.body, /reply exactly NO_REPLY/);
  await waitFor(async () => !(await h.session(kira.id))?.inTurn, { label: 'her turn over', timeout: 30_000 });
  await sleep(1500);
  assert.equal(count(), posted, 'NO_REPLY was posted in the group');
  await h.api('PATCH', `/employees/${kira.id}/telegram/groups/${GROUP.id}`, { mode: 'addressed' });
});

test('a group nobody connected is told the bot is private, and the bot leaves', async () => {
  const other = { id: -100777, type: 'group' as const, title: 'Random chat' };
  tg.message(TOKEN, STRANGER, 'hi bot', { chat: other });
  await tg.waitSent(textTo(other.id, /belongs to an office and is private/));
  await tg.waitSent((s) => s.method === 'leaveChat' && s.body.chat_id === other.id);
});

test('a colleague who pairs loses the chat with their access; taking people, groups and the bot away', async () => {
  // A colleague, through the office's door, makes a link for their own phone: it speaks as them.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const port = 20000 + Math.floor(Math.random() * 20000);
  await h.api('POST', '/sharing', { open: true, port });
  const invite = await h.api<any>('POST', '/guests', { name: 'Vera', role: 'colleague' });
  const token = JSON.parse(Buffer.from(String(invite.invite).replace(/^orch-invite-v1\./, ''), 'base64url').toString('utf8')).t as string;
  const door = `https://127.0.0.1:${port}`;
  const made = await (await fetch(`${door}/api/employees/${kira.id}/telegram/pair`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).json() as any;
  tg.message(TOKEN, FRIEND, `/start ${codeOf(made.link)}`);
  await tg.waitSent(textTo(FRIEND.id, /^Connected\. You are talking to Kira.* as Vera/));
  tg.message(TOKEN, FRIEND, 'Hi from Vera @@fake: say vera-answer-1212@@');
  await tg.waitSent(textTo(FRIEND.id, /vera-answer-1212/), 40_000);
  const veraMsg = (await h.state()).messages.find((m) => m.toEmployeeId === kira.id && /Hi from Vera/.test(m.body))!;
  assert.match(veraMsg.from.name, /^Vera \(a colleague/);
  // Vera is let go: her phone is let go with her.
  await h.api('DELETE', `/guests/${invite.guest.id}`);
  tg.message(TOKEN, FRIEND, 'still me @@fake: say should-not-run-after-revoke@@');
  await tg.waitSent(textTo(FRIEND.id, /can no longer work with Kira/));
  assert.ok(!tg.sent.some(textTo(FRIEND.id, /should-not-run-after-revoke/)));
  // Unpair the owner's phone: told, and no longer let in.
  const view = await h.api<any>('DELETE', `/employees/${kira.id}/telegram/people/${ME.id}`);
  assert.ok(!view.people.some((p: any) => p.tgId === ME.id));
  await tg.waitSent(textTo(ME.id, /You are disconnected from Kira/));
  tg.message(TOKEN, ME, 'still there? @@fake: say should-not-run-after-unpair@@');
  await sleep(2500);
  assert.ok(!tg.sent.some(textTo(ME.id, /should-not-run-after-unpair/)));
  // Leave the group, then disconnect the bot.
  await h.api('DELETE', `/employees/${kira.id}/telegram/groups/${GROUP.id}`);
  await tg.waitSent((s) => s.method === 'leaveChat' && s.body.chat_id === GROUP.id);
  const gone = await h.api<any>('DELETE', `/employees/${kira.id}/telegram`);
  assert.equal(gone.connected, false);
  // After a restart nothing comes back.
  await h.restartServer();
  assert.equal((await h.api<any>('GET', `/employees/${kira.id}/telegram`)).connected, false);
});
