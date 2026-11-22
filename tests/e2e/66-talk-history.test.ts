/**
 * Talk's whole conversation (`apps/server/src/talk-history.ts`), in a real office with a real session (the scripted
 * stand-in for Claude Code): what the boss said and what the employee answered is read back a page at a time going
 * back — from where it is kept, not from what the office's state still carries — and searched as a whole.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let kira: { id: string };

before(async () => {
  h = await createHarness();
  kira = await h.employee('Kira', 'backend', { workingDir: h.makeRepo('kira-talk'), autonomy: 'auto' });
  // (The window starts a session that is not running; here it is started by hand.)
  await h.api('POST', `/employees/${kira.id}/start`, {});
  await waitFor(async () => (await h.session(kira.id))?.inTurn === false, { label: 'Kira ready' });
});
after(async () => {
  await h.cleanup();
});

const talk = (query = '') => h.api<{ messages: Array<{ id: string; body: string; said?: string }>; events: Array<{ id: string; type: string; data: any }>; from: string | null; more: boolean }>('GET', `/employees/${kira.id}/talk${query}`);

test('the whole conversation: every word and answer, a page at a time going back, to the very first', async () => {
  for (let i = 1; i <= 4; i++) {
    await h.api('POST', `/employees/${kira.id}/message`, { body: `Question number ${i} about the invoice @@fake: say Answer ${i}: the račun is ready@@` });
    await waitFor(async () => (await talk()).events.find((e) => e.type === 'agent.turn_finished' && e.data.lastMessage === `Answer ${i}: the račun is ready`), { label: `answer ${i}`, timeout: 40_000 });
  }
  const all = await talk();
  assert.equal(all.more, false);
  assert.equal(all.messages.length, 4);
  // Two lines a page: the newest two, then the two before them, and so on to the first question.
  const seen: string[] = [];
  let page = await talk('?limit=2');
  for (let n = 0; n < 10; n++) {
    seen.unshift(...[...page.messages.map((m) => m.said ?? m.body), ...page.events.map((e) => e.data.lastMessage as string)].sort());
    if (!page.more) break;
    page = await talk(`?limit=2&before=${encodeURIComponent(page.from!)}`);
  }
  assert.equal(page.more, false);
  assert.ok(seen.some((t) => /^Question number 1 /.test(t)), JSON.stringify(seen));
  assert.ok(seen.includes('Answer 4: the račun is ready'));
});

test('search: the boss\'s words and the answers, the whole of it, any case or accent, newest first', async () => {
  const r = await h.api<{ hits: Array<{ id: string; ts: string; kind: string; text: string }>; words: string[] }>('POST', `/employees/${kira.id}/talk/search`, { q: 'RACUN ready' });
  assert.deepEqual(r.words, ['racun', 'ready']);
  assert.deepEqual(r.hits.map((x) => x.kind), ['reply', 'boss', 'reply', 'boss', 'reply', 'boss', 'reply', 'boss'].slice(0, r.hits.length));
  assert.equal(r.hits.filter((x) => x.kind === 'reply').length, 4);
  assert.match(r.hits[0]!.text, /Answer 4/);
  // Going to the oldest hit: every line from it to now is read back.
  const oldest = r.hits.at(-1)!;
  const since = await talk(`?since=${encodeURIComponent(oldest.ts)}`);
  assert.ok(since.messages.some((m) => m.id === oldest.id));
  assert.equal(since.events.filter((e) => e.type === 'agent.turn_finished').length, 4);
});
