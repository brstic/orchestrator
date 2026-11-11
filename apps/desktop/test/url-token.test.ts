import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoptUrlToken } from '../src/lib/url-token.ts';

test('a token in the address is taken by a browser that holds none, and on this computer\'s own address', () => {
  assert.equal(adoptUrlToken('', 'office.example.com'), true, 'the first time in: nothing to replace');
  for (const host of ['localhost', '127.0.0.1', '127.0.0.53', '[::1]']) assert.equal(adoptUrlToken('mine', host), true, host);
});

test('a link does not swap the credential somebody is signed in with for another one', () => {
  for (const host of ['office.example.com', '<server-lan-ip>', 'localhost.example.com', '127.0.0.1.example.com', 'notlocalhost', '']) assert.equal(adoptUrlToken('mine', host), false, host || '(no name)');
});
