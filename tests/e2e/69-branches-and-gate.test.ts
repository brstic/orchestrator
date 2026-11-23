/**
 * A project of worktrees with the release gate on (`docs/plans/BRANCHES-FOR-A-TEAM-IN-PLACE.md`; the owner's choices of
 * 2026-11-23): the employee works on a branch of their own and pushes it to try it (free); the base branch is refused
 * before approval; the approval merges the work into the integration branch; the author then moves the base branch
 * to it and pushes — the release — and reports it out. A real session (the scripted stand-in) and a real remote.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let repo = '';
let remote = '';
let ava: any;
let project: any;

const head = (r: string, ref: string) => {
  try {
    return h.git(r, 'rev-parse', ref).trim();
  } catch {
    return null;
  }
};
const turn = async (script: string, word: string) => {
  await waitFor(async () => (await h.session(ava.id))?.inTurn === false, { label: 'Ava between turns' });
  await h.api('POST', `/employees/${ava.id}/message`, { body: `@@fake: ${script}; say ${word}@@` });
  await waitFor(async () => (await h.api<any[]>('GET', `/events?employeeId=${ava.id}&limit=200`)).find((e) => e.type === 'agent.turn_finished' && e.data.lastMessage === word), { label: word, timeout: 40_000 }).catch(async (e) => {
    const ev = await h.api<any[]>('GET', `/events?employeeId=${ava.id}&limit=60&includeActivity=1`);
    console.log(ev.slice(-40).map((x) => `${x.type} ${x.summary}`.slice(0, 220)).join('\n'));
    throw e;
  });
};

before(async () => {
  h = await createHarness();
  repo = h.makeRepo('market');
  remote = path.join(path.dirname(repo), 'market-remote.git');
  h.git(path.dirname(repo), 'init', '-q', '--bare', remote);
  h.git(repo, 'remote', 'add', 'origin', remote);
  h.git(repo, 'push', '-q', 'origin', 'main');
  await h.api('PATCH', '/settings', { releaseGate: { on: true, hosts: ['prod.example.test'] }, unrestrictedAsksHighRisk: false });
  project = await h.project('Market', repo, { baseBranch: 'main' });
  assert.equal(project.workspace, 'worktrees');
  ava = await h.api('POST', '/employees', { name: 'Ava', roleKey: 'backend', hostId: h.hostId, projectId: project.id, autonomy: 'unrestricted' });
});
after(async () => {
  await h.cleanup();
});

test('her own branch is pushed to try it; main is refused; approved, it is merged into integration and she releases it', async () => {
  const task = await h.task({
    projectId: project.id,
    title: 'Add the offer banner',
    assigneeId: ava.id,
    reviewBy: 'none',
    description: '@@fake: write offer.txt banner; bash git add offer.txt && git commit -q -m "offer banner"; bash git push -q origin HEAD; bash git push -q origin HEAD:main; mcp complete_task {"summary":"Banner added.","tests_run":"none","release_plan":"Fast-forward main to orchestrator/integration and push it."}; result handed.txt@@',
  });
  const inReview = await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.status === 'REVIEW' ? t : null;
  }, { label: 'handed in', timeout: 40_000 });
  assert.match(inReview.branch ?? '', /^orch\/ava\//);
  assert.ok(head(remote, `refs/heads/${inReview.branch}`), 'her task branch is on the remote: pushed to try it');
  assert.equal(head(remote, 'refs/heads/main'), head(repo, 'main'), 'main was not pushed before approval');
  const held = await h.api<any[]>('GET', `/events?employeeId=${ava.id}&limit=300&includeActivity=1`);
  assert.ok(held.some((e) => e.type === 'release.held' && /pushes to main/.test(e.summary)));

  await h.api('POST', `/tasks/${task.id}/review`, { verdict: 'approve', comments: 'Good.' });
  await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.status === 'DONE' && t.release?.openUntil ? t : null;
  }, { label: 'approved and merged' });
  assert.equal(h.git(repo, 'show', 'orchestrator/integration:offer.txt').trim(), 'banner', 'the office merged it into integration');

  await turn(`bash git -C ${repo} merge -q --ff-only orchestrator/integration && git -C ${repo} push -q origin main; mcp report_released {"task":"${task.key}","note":"Main fast-forwarded to integration and pushed, offer.txt is on origin/main."}`, 'released-banner');
  assert.equal(h.git(remote, 'show', 'main:offer.txt').trim(), 'banner', 'released: main on the remote has it');
  assert.equal((await h.getTask(task.id)).release?.releasedBy, 'Ava');
});
