import { test } from 'node:test';
import assert from 'node:assert/strict';
import { doorAllows } from '../src/door.ts';

test("a page employees made opens through the door too (the owner's app comes in through it: the page was a 404 there)", () => {
  assert.equal(doorAllows('/view/GP_hX0abcdefghijklmnopqrstuvwxyz012345/uplatnice.html'), true);
  assert.equal(doorAllows('/view/GP_hX0abcdefghijklmnopqrstuvwxyz012345/Uplatnice%20novembar.html'), true);
  assert.equal(doorAllows('/view/x/../api/state'), false);
  assert.equal(doorAllows('/view/'), false);
  assert.equal(doorAllows('/api/state'), true);
  assert.equal(doorAllows('/server-status'), false);
});
