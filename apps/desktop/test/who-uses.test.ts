import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pending, pendingWords, setForMany, useOf, usePatch } from '../src/lib/who-uses.ts';

const alex = { id: 'a', claudeConfigDir: null, model: 'fable', effort: null };
const sarah = { id: 's', claudeConfigDir: '~/.claude-2', model: null, effort: 'high' as const };
const noor = { id: 'n', claudeConfigDir: null, model: null, effort: null };
const all = [alex, sarah, noor];

test('what somebody is on, and what is asked when the table says something else — only what differs', () => {
  assert.deepEqual(useOf(alex), { account: '', model: 'fable', effort: '' });
  assert.deepEqual(useOf(sarah), { account: '~/.claude-2', model: '', effort: 'high' });
  assert.deepEqual(usePatch(alex, undefined), {});
  assert.deepEqual(usePatch(alex, useOf(alex)), {});
  assert.deepEqual(usePatch(alex, { account: '~/.claude-2', model: 'fable', effort: '' }), { claudeConfigDir: '~/.claude-2' });
  // Back to the default login, the account's own model and the default effort are said as "none".
  assert.deepEqual(usePatch(sarah, { account: '', model: '', effort: '' }), { claudeConfigDir: null, effort: null });
  assert.deepEqual(usePatch(alex, { account: '', model: ' ', effort: 'max' }), { model: null, effort: 'max' });
});

test('one thing is set for many at once, and the rest of each stays as it was', () => {
  let drafts = setForMany({}, all, ['a', 'n'], { model: 'sonnet' });
  assert.deepEqual(drafts, { a: { account: '', model: 'sonnet', effort: '' }, n: { account: '', model: 'sonnet', effort: '' } });
  // On top of what was already changed by hand for one of them.
  drafts = setForMany({ ...drafts, s: { account: '', model: '', effort: 'high' } }, all, ['a', 's'], { effort: 'low' });
  assert.deepEqual(drafts.s, { account: '', model: '', effort: 'low' });
  assert.deepEqual(drafts.a, { account: '', model: 'sonnet', effort: 'low' });
  assert.deepEqual(drafts.n, { account: '', model: 'sonnet', effort: '' });
  const changes = pending(drafts, all);
  assert.deepEqual(changes, [
    { id: 'a', patch: { model: 'sonnet', effort: 'low' } },
    { id: 's', patch: { claudeConfigDir: null, effort: 'low' } },
    { id: 'n', patch: { model: 'sonnet' } },
  ]);
  assert.equal(pendingWords(changes), '3 employees: account, model, effort');
  assert.equal(pendingWords(pending(setForMany({}, all, ['n'], { effort: 'max' }), all)), '1 employee: effort');
  // Set to what they already have: nothing is pending.
  assert.deepEqual(pending(setForMany({}, all, ['a'], { model: 'fable' }), all), []);
  assert.equal(pendingWords([]), '');
});
