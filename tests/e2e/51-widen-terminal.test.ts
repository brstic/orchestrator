/**
 * A watched terminal is made as wide as the window it is watched in: the pane grows, and never shrinks for a
 * watcher. (Somebody at the keyboard sets the size themselves; that is `term.resize`.)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_COLS, SESSION_ROWS } from '@orchestrator/orchestration';
import { WIDEN_MAX } from '@orchestrator/terminal';
import { createHarness, waitFor, sleep, type Harness, type OfficeClient } from './harness.ts';

let h: Harness;
let boss: OfficeClient;
let alex = '';
const size = async () => {
  const s = (await h.session(alex))!;
  return h.tmux('display-message', '-p', '-t', s.tmuxPane!, '#{pane_width}x#{pane_height}').trim();
};

before(async () => {
  h = await createHarness();
  boss = await h.client();
  const project = await h.project('Shop', h.makeRepo('shop'));
  alex = (await h.employee('Alex', 'backend', { projectId: project.id })).id;
  await h.api('POST', `/employees/${alex}/start`, {});
  await waitFor(async () => (await h.session(alex))?.status === 'running', { label: 'Alex at his desk', timeout: 30000 });
});
after(async () => {
  await h.cleanup();
});

test('a session starts wide', async () => {
  assert.deepEqual([SESSION_COLS, SESSION_ROWS], [160, 44]);
  assert.equal(await size(), '160x44');
});

test('watching from a wider window makes the pane wider; a narrower window changes nothing; there is a largest size', async () => {
  const s = (await h.session(alex))!;
  // Not watching it: nothing is this window's to ask.
  boss.send({ t: 'term.widen', sessionId: s.id, cols: 200, rows: 50 });
  await sleep(600);
  assert.equal(await size(), '160x44');
  boss.send({ t: 'term.open', sessionId: s.id });
  await waitFor(() => boss.terminals.has(s.id), { label: 'the terminal open' });
  boss.send({ t: 'term.widen', sessionId: s.id, cols: 212, rows: 58 });
  await waitFor(async () => (await size()) === '212x58', { label: 'the pane as wide as the window', timeout: 10000 });
  // A smaller window does not pull it back: it draws smaller letters instead.
  boss.send({ t: 'term.widen', sessionId: s.id, cols: 100, rows: 30 });
  await sleep(800);
  assert.equal(await size(), '212x58');
  // Wider, but no taller.
  boss.send({ t: 'term.widen', sessionId: s.id, cols: 230, rows: 40 });
  await waitFor(async () => (await size()) === '230x58', { label: 'wider only', timeout: 10000 });
  // Not without end.
  boss.send({ t: 'term.widen', sessionId: s.id, cols: 5000, rows: 5000 });
  await waitFor(async () => (await size()) === `${WIDEN_MAX.cols}x${WIDEN_MAX.rows}`, { label: 'the largest size', timeout: 10000 });
});
