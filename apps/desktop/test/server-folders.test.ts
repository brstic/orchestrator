import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { RESTART_THE_APP, explainNative, nativeCall } from '../src/lib/native-call.ts';

/**
 * Changing and looking through the folders of a member's server: what the page does when the app cannot answer, and
 * what the app makes of a listing. (The reaching itself, with the real scripts: tests/e2e/21-member-servers-lock.test.ts.)
 */
const require = createRequire(import.meta.url);
const { cleanBrowsePath, readListing } = require('../electron/member-servers.cjs') as {
  cleanBrowsePath: (dir: unknown) => string;
  readListing: (out: string) => { path: string; home: string; parent: string | null; folders: string[]; usable: boolean; more: boolean } | null;
};

test('an app that was started before it could do something says so — the page is not left waiting', async () => {
  // What happened: the page (new after a reload) asked the running app (started before the feature) to change a
  // server's folders; Electron refused with an exception, nobody caught it, and the button stayed on "Changing…".
  const refused = () => Promise.reject(new Error("Error invoking remote method 'orch:servers-roots': Error: No handler registered for 'orch:servers-roots'"));
  assert.deepEqual(await nativeCall(refused), { error: RESTART_THE_APP });
  assert.match(RESTART_THE_APP, /start it again/);
  // Anything else that goes wrong on the way is said in its own words, without Electron's wrapping.
  assert.deepEqual(await nativeCall(() => Promise.reject(new Error("Error invoking remote method 'orch:servers-browse': Error: ssh was not found"))), { error: 'ssh was not found' });
  assert.equal(explainNative('boom'), 'boom');
  assert.equal(explainNative(undefined), 'The Orchestrator app did not answer.');
  // A call that throws before it returns a promise, and one that answers nothing, are answers too.
  assert.deepEqual(await nativeCall(() => { throw new Error('not there'); }), { error: 'not there' });
  assert.deepEqual(await nativeCall(() => Promise.resolve(undefined as unknown as object)), { error: 'The Orchestrator app did not answer.' });
  // What the app answers is passed on untouched.
  assert.deepEqual(await nativeCall(() => Promise.resolve({ ok: true, roots: ['/srv/app'] })), { ok: true, roots: ['/srv/app'] });
  assert.deepEqual(await nativeCall(() => Promise.resolve({ error: 'Nothing was changed.' })), { error: 'Nothing was changed.' });
});

test('where to look on a server: the home folder unless a folder is named, and never anything the shell could read otherwise', () => {
  assert.equal(cleanBrowsePath(''), '~/');
  assert.equal(cleanBrowsePath(undefined), '~/');
  assert.equal(cleanBrowsePath('~'), '~/');
  assert.equal(cleanBrowsePath(' /srv/app '), '/srv/app');
  assert.equal(cleanBrowsePath('/'), '/');
  for (const bad of ['srv/app', '/srv/../etc', '/srv/$(id)', '/srv/a;b', "/srv/a'b", '/srv/`id`', '-rf']) assert.throws(() => cleanBrowsePath(bad), /not a folder path/, bad);
});

test('a listing of a server folder: where it is, what is above it, and the folders that can be chosen', () => {
  const out = ['ORCH:PWD=/srv', 'ORCH:HOME=/home/deploy', 'ORCH:DIR=zeta', 'ORCH:DIR=Alpha', 'ORCH:DIR=my app', 'ORCH:DIR=we$ird', 'ORCH:DIR=a..b', 'ORCH:DIR=', 'ORCH:LISTED', ''].join('\n');
  assert.deepEqual(readListing(out), { path: '/srv', home: '/home/deploy', parent: '/', folders: ['Alpha', 'my app', 'zeta'], usable: true, more: false });
  // Deeper: the folder above; at the top: none.
  assert.equal(readListing('ORCH:PWD=/srv/app/src\nORCH:HOME=/root\nORCH:LISTED\n')?.parent, '/srv/app');
  assert.deepEqual(readListing('ORCH:PWD=/\nORCH:HOME=/root\nORCH:DIR=srv\nORCH:MORE\nORCH:LISTED\n'), { path: '/', home: '/root', parent: null, folders: ['srv'], usable: true, more: true });
  // A folder whose own path the office could not use can be looked into, not chosen.
  assert.equal(readListing('ORCH:PWD=/srv/we$ird\nORCH:HOME=/root\nORCH:LISTED\n')?.usable, false);
  // Not a folder, not allowed in, or nothing that looks like an answer.
  assert.equal(readListing('ORCH:NODIR\n'), null);
  assert.equal(readListing(''), null);
  assert.equal(readListing('ORCH:PWD=relative\nORCH:LISTED\n'), null);
});
