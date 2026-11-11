/**
 * A conversation Claude Code no longer has cannot be continued — and the office must not try the same start for ever.
 *
 * Seen in the live office on 2026-11-11: a session stopped thirteen seconds after it began (before its first prompt,
 * so Claude Code had written no conversation) failed at every later start with "No conversation found with session
 * ID", eight times in a minute, with messages for the employee waiting behind it. Claude Code reports the end of
 * such an attempt through its hook, and that sign of life hid the failure from the office.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let id = '';

before(async () => {
  h = await createHarness();
  const project = (await h.project('Shop', h.makeRepo('shop'))).id;
  id = (await h.employee('Nika', 'backend', { projectId: project, autonomy: 'autonomous' })).id;
});
after(async () => {
  await h?.cleanup();
});

test('a start that Claude Code refuses for want of the conversation is followed by a new conversation, once — and what waited is delivered', async () => {
  const first = await h.api('POST', `/employees/${id}/start`, {});
  await waitFor(async () => (await h.session(id))?.inTurn === false, { label: 'the session is up', timeout: 20000 });
  await h.api('POST', `/employees/${id}/stop`, {});
  await waitFor(async () => (await h.session(id))?.status !== 'running', { label: 'stopped', timeout: 15000 });
  // From here on Claude Code has no conversation under that id.
  fs.writeFileSync(path.join(first.cwd, '.fake-no-conversation'), '');
  await h.api('POST', `/employees/${id}/message`, { body: 'Are you there? @@fake: say here-in-a-new-conversation@@' });
  const events = () => h.api<any[]>('GET', `/events?employeeId=${id}&limit=300`);
  // Somebody presses Start: the office tries to continue the conversation, and Claude Code refuses.
  await h.api('POST', `/employees/${id}/start`, {});
  await waitFor(async () => (await events()).some((e) => e.data?.resumeFailed), { label: 'the office saw that it cannot be continued', timeout: 20000 });
  // The next start is a new conversation — however it comes about (the office's own second try, or Start again).
  const up = await waitFor(async () => {
    let s = await h.session(id);
    if (s?.status !== 'running' && s?.status !== 'starting') {
      await h.apiRaw('POST', `/employees/${id}/start`, {});
      s = await h.session(id);
    }
    return s?.status === 'running' && s.inTurn === false ? s : null;
  }, { label: 'running in a new conversation', timeout: 30000, interval: 500 });
  assert.equal(up.resumed, false);
  await waitFor(() => /here-in-a-new-conversation/.test(h.tmux('capture-pane', '-p', '-J', '-S', '-60', '-t', up.tmuxPane!)), { label: 'the message was delivered', timeout: 20000 });
  const all = await events();
  const refused = all.filter((e) => e.type === 'session.lost' && /No conversation found/.test(e.summary));
  assert.equal(refused.length, 1, 'the failing start was tried once, not again and again');
  assert.equal(all.filter((e) => e.data?.resumeFailed).length, 1);
  assert.match(all.find((e) => e.data?.resumeFailed).summary, /earlier conversation could not be continued/);
  assert.doesNotMatch(h.tmux('capture-pane', '-p', '-J', '-S', '-60', '-t', up.tmuxPane!), /\(resumed\)/);
});
