/**
 * The release gate (`docs/RELEASE-GATE.md`), in a real office with a real session (the scripted stand-in for Claude
 * Code) and a real remote: an Unrestricted employee — whom nothing else stops — pushes their own branch freely, but a
 * push to the protected branch is refused by their machine and the office until an owner approves the ticket; the
 * hand-in carries a release plan and goes to the owner; the approval opens the release; reporting it out closes it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let repo = '';
let remote = '';
let ava: any;

const remoteHead = (branch: string) => {
  try {
    return h.git(remote, 'rev-parse', `refs/heads/${branch}`).trim();
  } catch {
    return null;
  }
};
const turn = async (script: string, word: string) => {
  await waitFor(async () => (await h.session(ava.id))?.inTurn === false, { label: 'Ava between turns' });
  await h.api('POST', `/employees/${ava.id}/message`, { body: `@@fake: ${script}; say ${word}@@` });
  await waitFor(async () => (await h.api<any[]>('GET', `/events?employeeId=${ava.id}&limit=200`)).find((e) => e.type === 'agent.turn_finished' && e.data.lastMessage === word), { label: word, timeout: 40_000 });
};

before(async () => {
  h = await createHarness();
  repo = h.makeRepo('shop');
  remote = path.join(path.dirname(repo), 'shop-remote.git');
  h.git(path.dirname(repo), 'init', '-q', '--bare', remote);
  h.git(repo, 'remote', 'add', 'origin', remote);
  h.git(repo, 'push', '-q', 'origin', 'main');
  await h.api('PATCH', '/settings', { releaseGate: { on: true, hosts: ['prod.example.test'] } });
  ava = await h.api('POST', '/employees', { name: 'Ava', roleKey: 'backend', hostId: h.hostId, workingDir: repo, autonomy: 'unrestricted', verifyCommand: 'npm test --silent' });
  await h.api('PATCH', '/settings', { unrestrictedAsksHighRisk: false });
  await h.api('POST', `/employees/${ava.id}/start`, {});
});
after(async () => {
  await h.cleanup();
});

test('before approval: her own branch goes, the protected branch does not — refused in words, and on the record', async () => {
  const before = remoteHead('main');
  await turn('bash git commit -q --allow-empty -m "first change"; bash git push -q origin HEAD:refs/heads/ava/work; bash git push -q origin main', 'tried-to-push');
  assert.equal(remoteHead('main'), before, 'main was not pushed');
  assert.equal(remoteHead('ava/work'), h.git(repo, 'rev-parse', 'HEAD').trim(), 'her own branch was');
  const events = await h.api<any[]>('GET', `/events?employeeId=${ava.id}&limit=300&includeActivity=1`);
  assert.ok(events.some((e) => e.type === 'release.held' && /pushes to main/.test(e.summary)), 'the refusal is in the feed');
});

test('the ticket: handed in with a release plan it goes to the owner; the approval opens the release, which she reports out', async () => {
  await waitFor(async () => (await h.session(ava.id))?.inTurn === false, { label: 'idle' });
  const task = await h.task({
    projectId: ava.projectId,
    title: 'Add the receipt footer',
    assigneeId: ava.id,
    reviewBy: 'none',
    description: '@@fake: write footer.txt thanks; bash git add footer.txt && git commit -q -m "add the receipt footer"; mcp complete_task {"summary":"Footer added.","tests_run":"npm test","release_plan":"Push main to origin, nothing else."}; result handed.txt@@',
  });
  const inReview = await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.status === 'REVIEW' || t.status === 'DONE' || t.status === 'BLOCKED' ? t : null;
  }, { label: 'handed in', timeout: 30_000 });
  assert.equal(inReview.status, 'REVIEW', 'nobody was to review it, but it goes somewhere: the owner approves it');
  assert.equal(inReview.reviewBy, 'boss');
  assert.equal(inReview.release?.plan, 'Push main to origin, nothing else.');
  assert.ok(inReview.history.some((x) => /release gate/.test(x.note)));

  const before = remoteHead('main');
  await h.api('POST', `/tasks/${task.id}/review`, { verdict: 'approve', comments: 'Good.' });
  const approved = await waitFor(async () => {
    const t = await h.getTask(task.id);
    return t.status === 'DONE' && t.release?.openUntil ? t : null;
  }, { label: 'approved' });
  assert.ok(approved.release?.approvedAt);
  const told = (await h.state()).messages.filter((m) => m.toEmployeeId === ava.id && m.from.kind === 'system' && /approved/.test(m.body));
  assert.match(told.at(-1)!.body, /Release it now, as you planned:\nPush main to origin, nothing else\.[\s\S]*report_released/);

  await turn(`bash git push -q origin main; mcp report_released {"task":"${task.key}","note":"Pushed main to origin and checked its head."}`, 'released-it');
  assert.equal(remoteHead('main'), h.git(repo, 'rev-parse', 'main').trim(), 'main is pushed now');
  assert.notEqual(remoteHead('main'), before);
  const done = await h.getTask(task.id);
  assert.equal(done.release?.releasedBy, 'Ava');
  assert.match(done.release?.note ?? '', /Pushed main/);
  // Closed again: the next push to main is refused.
  await turn('bash git commit -q --allow-empty -m "after"; bash git push -q origin main', 'pushed-again');
  assert.notEqual(remoteHead('main'), h.git(repo, 'rev-parse', 'main').trim(), 'closed again after it was reported out');
  assert.ok(fs.existsSync(path.join(repo, 'handed.txt')));
});

test('by hand: an owner lets her release for a while', async () => {
  const r = await h.api<{ until: string }>('POST', `/employees/${ava.id}/release`, { minutes: 30 });
  assert.ok(Date.parse(r.until) > Date.now());
  const open = await h.api<{ passes: Array<{ employeeId: string }> }>('GET', '/release');
  assert.ok(open.passes.some((p) => p.employeeId === ava.id));
  await turn('bash git push -q origin main', 'pushed-by-hand');
  assert.equal(remoteHead('main'), h.git(repo, 'rev-parse', 'main').trim());
  await h.api('DELETE', `/employees/${ava.id}/release`);
  assert.ok(!(await h.api<{ passes: Array<{ employeeId: string }> }>('GET', '/release')).passes.some((p) => p.employeeId === ava.id));
});
