/**
 * The autopilot, end to end: with the dial on "trusted" the office adds an allow rule by itself once
 * the owner has approved the same harmless command often enough, and takes it back when the owner
 * later denies a command of that shape. Real server, real host agent, real tmux; the scripted worker
 * stands in for the model. (The thresholds are lowered through injected timings; the defaults are in
 * docs/learning/autopilot.md.)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let projectId = '';
let alex = '';
const RULE = 'Bash(docker build:*)';

const idle = () => waitFor(async () => (await h.session(alex))?.inTurn === false, { label: 'Alex idle', timeout: 20000 });
const policy = async () => (await h.state()).projects.find((p) => p.id === projectId)!.policy;
const suggestion = async () => (await h.state()).improvements.find((x) => x.kind === 'allow_rule');
/** Alex asks to run a `docker build …` command and the owner decides it. */
async function request(n: number, decision: 'allow' | 'deny') {
  await idle();
  await h.api('POST', `/employees/${alex}/message`, { body: `run ${n} @@fake: bash docker build -t app:${n} --help >/dev/null 2>&1 || true@@` });
  const q = await waitFor(() => h.openQuestion(alex, 'permission'), { label: `permission request ${n}` });
  await h.api('POST', `/questions/${q.id}/answer`, { decision, ...(decision === 'deny' ? { answer: 'not this one' } : {}) });
  return q;
}

before(async () => {
  h = await createHarness({ timings: { autopilotAllowApprovals: 3, autopilotAllowSpreadMs: 0 } });
  projectId = (await h.project('Autopilot', h.makeRepo('autopilot'), { verifyCommand: 'npm test --silent' })).id;
  alex = (await h.employee('Alex', 'backend', { projectId, autonomy: 'standard' })).id;
  await h.api('POST', `/employees/${alex}/start`, { resume: false });
  await idle();
});
after(async () => {
  await h.cleanup();
});

test('a new office is on "safe": nothing that widens permissions is applied without the owner', async () => {
  const s = await h.state();
  assert.deepEqual([s.settings.selfImprovement.autopilot, s.settings.selfImprovement.autopilotMaxPerDay], ['safe', 3]);
});

test('"trusted": three approvals of one harmless command shape and the office adds the rule by itself', async () => {
  await h.api('PATCH', '/settings', { selfImprovement: { autopilot: 'trusted' } });
  for (let i = 0; i < 2; i++) await request(i, 'allow');
  await idle();
  await h.api('POST', '/improvements/analyze', {});
  assert.equal(await suggestion(), undefined, 'two approvals are not a pattern yet');
  assert.deepEqual((await policy()).allow, []);

  await request(2, 'allow');
  const imp = await waitFor(async () => {
    const x = await suggestion();
    return x?.status === 'applied' ? x : null;
  }, { label: 'the rule applied by itself' });
  assert.deepEqual(imp.action, { type: 'project.policy.allow', projectId, rule: RULE });
  assert.deepEqual((await policy()).allow, [RULE], 'the real project policy changed');
  const record = imp.autopilot!;
  assert.deepEqual([record.appliedBy, record.auto, record.widening, record.probation?.status], ['autopilot', true, true, 'running']);
  assert.deepEqual(record.undo, { type: 'project.policy.allow', projectId, rule: RULE, added: true });

  const s = await h.state();
  const applied = s.events.find((e) => e.type === 'learning.applied')!;
  assert.equal(applied.summary, `Applied by itself: ${imp.title}`);
  assert.deepEqual([applied.data.auto, applied.data.area, applied.data.improvementId], [true, 'autopilot', imp.id]);
  assert.match(String(applied.data.why), /3 "docker build" commands were approved in Autopilot/);
  assert.equal((applied.data.evidence as unknown[]).length, 3);
  // The owner is told without being asked: nothing about it is left open in the inbox.
  const notes = s.notifications.filter((n) => n.kind === 'improvement');
  assert.ok(notes.some((n) => n.title === `Applied by itself: ${imp.title}`));
  assert.ok(notes.every((n) => !!n.resolvedAt), 'neither the suggestion nor the note about applying it waits for the owner');
  // The audit log names the office itself, through the same entries an owner's click leaves.
  const audit = await h.api<Array<{ actor: string; action: string; target: string }>>('GET', '/audit?limit=50');
  assert.equal(audit.find((a) => a.action === 'improvement.applied' && a.target === imp.id)?.actor, 'autopilot');
});

test('on probation: the owner denies a command of that shape and the office takes the rule back', async () => {
  // Alex's session was started before the rule existed, so it still asks.
  const denied = await request(3, 'deny');
  const imp = await waitFor(async () => {
    const x = await suggestion();
    return x?.status === 'proposed' ? x : null;
  }, { label: 'the rule taken back' });
  assert.deepEqual((await policy()).allow, [], 'exactly the rule that was added is gone');
  const record = imp.autopilot!;
  assert.deepEqual([record.noAuto, record.probation?.status, record.reverted?.by, record.reverted?.restored], [true, 'reverted', 'autopilot', true]);
  assert.deepEqual(record.reverted!.evidence.map((e) => e.id), [denied.id], 'with the denial as its evidence');
  assert.deepEqual(record.history.map((x) => x.what), ['applied', 'reverted']);
  const s = await h.state();
  const reverted = s.events.find((e) => e.type === 'learning.reverted')!;
  assert.deepEqual([reverted.data.auto, reverted.data.improvementId], [true, imp.id]);
  assert.match(String(reverted.data.why), /A "docker build" command was denied while the rule was on probation/);
  assert.ok(s.notifications.some((n) => /^Taken back:/.test(n.title) && !n.resolvedAt), 'this time the owner is asked to look');

  // More approvals do not bring it back by itself: it waits for the owner now.
  await request(4, 'allow');
  await idle();
  await h.api('POST', '/improvements/analyze', {});
  assert.equal((await suggestion())!.status, 'proposed');
  assert.deepEqual((await policy()).allow, []);
});

test('the owner can apply it after all, and undo it again: POST /improvements/:id/revert', async () => {
  const imp = (await suggestion())!;
  // Undoing something that is not applied but was already taken back is a no-op, not an error.
  assert.equal((await h.apiRaw('POST', `/improvements/${imp.id}/revert`, {})).status, 200);
  await h.api('POST', `/improvements/${imp.id}/apply`, {});
  assert.deepEqual((await policy()).allow, [RULE]);
  const back = await h.api('POST', `/improvements/${imp.id}/revert`, {});
  assert.deepEqual([back.status, back.autopilot.reverted.by, back.autopilot.reverted.restored], ['dismissed', 'owner', true]);
  assert.deepEqual((await policy()).allow, []);
  const again = await h.apiRaw('POST', `/improvements/${imp.id}/revert`, {});
  assert.equal(again.status, 200, 'twice is once');
  assert.deepEqual((await policy()).allow, []);
  assert.equal((await h.apiRaw('POST', '/improvements/nope/revert', {})).status, 404);
  const s = await h.state();
  assert.equal(s.events.filter((e) => e.type === 'learning.reverted').length, 2, 'one by the office, one by the owner');
});
