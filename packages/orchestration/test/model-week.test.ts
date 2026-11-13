import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelFamily } from '@orchestrator/contracts';
import { resetNamedIn, weekFull } from '../src/registry.ts';

/** The week of one model (Fable's, on a subscription): how a model's name, a full week and a refusal's words are read. */

test('a model is known by its family, however it is written', () => {
  for (const [name, family] of [['fable', 'fable'], ['claude-fable-5-2', 'fable'], ['Fable', 'fable'], ['fable[1m]', 'fable'], ['claude-opus-5-5', 'opus'], ['sonnet', 'sonnet'], ['claude-haiku-5-5', 'haiku'], ['mythos', 'mythos']] as const) assert.equal(modelFamily(name), family, name);
  for (const none of ['', null, undefined, 'glm-5.3', 'default', 'unfabled']) assert.equal(modelFamily(none), '', String(none));
  // In a sentence — the words of a refusal.
  assert.equal(modelFamily("You've reached your weekly limit for Fable. Resets Thursday."), 'fable');
  assert.equal(modelFamily('weekly limit reached — 429 usage limit reached'), '');
});

test('a week is full at its limit until its time comes; with no time named it is believed while it stands', () => {
  const soon = new Date(Date.now() + 3600_000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  assert.equal(weekFull({ usedPercent: 100, resetsAt: soon }), true);
  assert.equal(weekFull({ usedPercent: 99, resetsAt: null }), true);
  assert.equal(weekFull({ usedPercent: 98.9, resetsAt: soon }), false);
  assert.equal(weekFull({ usedPercent: 100, resetsAt: past }), false);
});

test('the time a refusal names is read when it is a time the office can read — and only a believable one', () => {
  const in2 = new Date(Date.now() + 2 * 86_400_000);
  in2.setMilliseconds(0);
  assert.equal(resetNamedIn(`weekly limit for Fable; resets ${in2.toISOString()}`), in2.toISOString());
  assert.equal(resetNamedIn(`limit reached, resets_at: ${Math.floor(in2.getTime() / 1000)}`), in2.toISOString());
  assert.equal(resetNamedIn('weekly limit for Fable; resets Thursday at 9am'), null, 'words are not guessed at');
  assert.equal(resetNamedIn('resets 2020-01-01T00:00:00Z'), null, 'in the past');
  assert.equal(resetNamedIn(`resets ${new Date(Date.now() + 60 * 86_400_000).toISOString()}`), null, 'two months away is not a weekly limit');
  assert.equal(resetNamedIn('rate_limit'), null);
});

test('the refusal as Claude Code words it: one model\'s limit and when it lifts, or the account\'s', async () => {
  const { limitIn } = await import('../src/registry.ts');
  const now = Date.parse('2026-11-13T15:58:53Z');
  assert.deepEqual(limitIn("You've hit your Fable limit · resets Nov 19, 1pm (UTC)", now), { family: 'fable', resetsAt: '2026-11-19T13:00:00.000Z' });
  assert.deepEqual(limitIn("You've hit your Opus limit · resets 5:30pm (UTC)", now), { family: 'opus', resetsAt: '2026-11-13T17:30:00.000Z' });
  // A time already past today is tomorrow's.
  assert.deepEqual(limitIn("You've hit your limit · resets 9am (UTC)", now), { family: '', resetsAt: '2026-11-14T09:00:00.000Z' });
  // In the zone it names.
  assert.equal(limitIn("You've hit your limit · resets Nov 14, 2am (Europe/Belgrade)", now)!.resetsAt, '2026-11-14T01:00:00.000Z');
  assert.deepEqual(limitIn('API Error: Rate limit reached', now), { family: '', resetsAt: null });
  assert.equal(limitIn('Claude can\'t use thinking from another organization', now), null);
  // The words from before, still understood.
  assert.equal(limitIn('You have reached your weekly limit for Fable', now)!.family, 'fable');
  assert.equal(limitIn('Weekly limit reached for Fable, resets 2026-11-15T13:00:00Z', now)!.resetsAt, '2026-11-15T13:00:00.000Z');
});

test('Claude Code\'s menu after a refused turn: "Stop and wait" is chosen — the keys read from the screen', async () => {
  const { menuKeys } = await import('../src/comms.ts');
  const menu = (marked: number) => [
    "  ⎿  You've hit your Fable limit · resets Nov 19, 1pm (UTC)",
    '',
    '❯ /rate-limit-options',
    '─────────────────────────────',
    '  What do you want to do?',
    '',
    ...['Stop and wait for limit to reset', 'Wait here, then continue automatically at Nov 19, 1pm', 'Switch to usage credits'].map((l, i) => `  ${i === marked ? '❯' : ' '} ${i + 1}. ${l}`),
    '',
    '  Enter to confirm · Esc to cancel',
  ];
  const stop = (l: string) => /^Stop and wait/i.test(l);
  assert.deepEqual(menuKeys(menu(0), stop), ['Enter']);
  assert.deepEqual(menuKeys(menu(2), stop), ['Up', 'Up', 'Enter']);
  assert.equal(menuKeys(['  What do you want to do?', '  1. Stop and wait for limit to reset'], stop), null, 'nothing marked, one option: not pressed blind');
});
