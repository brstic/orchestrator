import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Host } from '@orchestrator/contracts';
import { CONTEXT_HARD_CAP_CHARS, renderContext, renderContextChange } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

/**
 * The central context (`docs/CONTEXT.md`), the office's side: which facts an employee holds, in what order, within the
 * cap; what a change says; proposals; what the office notices. No machine, no model.
 */
const sent: Array<{ method: string; params: any }> = [];
const link: AgentLink = { rpc: async (_h, rpc) => (sent.push(rpc as never), { ok: true } as never), isOnline: () => true, respondHook: () => true, disconnect: () => undefined };
const now = () => new Date().toISOString();
const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: now(), lastSeenAt: null, revokedAt: null, local: true };

function office() {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1', timings: { deliverySettleMs: 0, sleepIdleMs: 1 } }, { send: () => undefined });
  eng.core.put('host', host);
  const shop = eng.core.put('project', { id: 'p-shop', name: 'Shop', description: '', goals: '', requirements: '', docs: '', hostId: host.id, repoPath: '/work/shop', baseBranch: 'main', integrationBranch: 'main', workspace: 'single', ownerEmployeeId: null, verifyCommand: null, verifyTimeoutSec: 0, extraRepos: [], dependsOn: [], color: '#fff', status: 'active', policy: { allow: [], deny: [], highRiskPatterns: [], autoAssign: false, requireReview: false, autoMerge: true }, milestones: [], deliveredAt: null, createdAt: now() } as never) as { id: string };
  const kira = eng.employees.create({ name: 'Kira', roleKey: 'backend', hostId: host.id, workingDir: '/work/kira', projectId: shop.id });
  const lea = eng.employees.create({ name: 'Lea', roleKey: 'frontend', hostId: host.id, workingDir: '/work/lea' });
  return { eng, shop, kira, lea };
}

test('a pack: the office first, then the project, the role and one\'s own notes — what applies to this employee only, and nothing on demand', () => {
  const { eng, shop, kira, lea } = office();
  const c = eng.context;
  c.add({ layer: 'self', scope: kira.id, title: 'Doing', text: 'The cart.' }, 'owner');
  c.add({ layer: 'role', scope: 'backend', title: 'Backend', text: 'Migrations go through review.' }, 'owner');
  c.add({ layer: 'project', scope: shop.id, title: 'Stack', text: 'Next.js.' }, 'owner');
  c.add({ layer: 'office', title: 'Deploy', text: 'From main.' }, 'owner');
  c.add({ layer: 'office', title: 'Archive', text: 'Old stuff.', always: false }, 'owner');
  const pack = c.packFor(kira);
  assert.deepEqual(pack.items.map((i) => i.title), ['The team you can reach', 'Projects', 'Deploy', 'Stack', 'Backend', 'Doing']);
  assert.equal(pack.onDemand, 1);
  assert.match(renderContext(pack), /## The office\n- \*\*The team you can reach\*\* — Lea \(Frontend[^\n]*\n- \*\*Projects\*\* — Shop\n- \*\*Deploy\*\* — From main\.\n\n## Project Shop/);
  assert.deepEqual(c.packFor(lea).items.map((i) => i.title), ['The team you can reach', 'Projects', 'Deploy'], "another's project, role and notes are not theirs");
  // The version follows the content.
  const rev = pack.rev;
  assert.equal(c.packFor(kira).rev, rev);
  c.update(c.list().find((f) => f.title === 'Deploy')!.id, { text: 'From main, by script.' }, 'owner');
  assert.notEqual(c.packFor(kira).rev, rev);
});

test('what a change says: new, changed, gone — and nothing when nothing changed', () => {
  const a = { rev: 'aaaa', onDemand: 0, items: [{ id: '1', layer: 'office' as const, section: 'The office', title: 'Deploy', text: 'From main.' }, { id: '2', layer: 'office' as const, section: 'The office', title: 'Old', text: 'x' }] };
  const b = { rev: 'bbbb', onDemand: 0, items: [{ id: '1', layer: 'office' as const, section: 'The office', title: 'Deploy', text: 'From main, by script.' }, { id: '3', layer: 'office' as const, section: 'The office', title: 'New', text: 'y' }] };
  const said = renderContextChange(a, b)!;
  assert.match(said, /changed \(version aaaa → bbbb\)/);
  assert.match(said, /- Changed \(The office\): \*\*Deploy\*\* — From main, by script\./);
  assert.match(said, /- New \(The office\): \*\*New\*\* — y/);
  assert.match(said, /- No longer holds \(The office\): \*\*Old\*\*/);
  assert.equal(renderContextChange(b, b), null);
  assert.match(renderContextChange(null, b)!, /^# The office's central context/);
});

test('the pack stays within the hard cap: what does not fit is counted on demand', () => {
  const { eng, kira } = office();
  for (let i = 0; i < 20; i++) eng.context.add({ layer: 'office', title: `Fact ${i}`, text: 'x'.repeat(1900) }, 'owner');
  const pack = eng.context.packFor(kira);
  assert.ok(renderContext(pack).length < CONTEXT_HARD_CAP_CHARS + 2000);
  assert.ok(pack.onDemand > 0);
});

test('proposals: one\'s own notes and one\'s project go in at once; the office, a role, a client wait — and a credential never stays', () => {
  const { eng, kira } = office();
  const self = eng.context.propose(kira, { layer: 'self', title: 'Doing', text: 'The cart.' }, null);
  const proj = eng.context.propose(kira, { layer: 'project', title: 'State', text: 'Payments done.' }, null);
  const off = eng.context.propose(kira, { layer: 'office', title: 'Coffee', text: 'Mondays.' }, null);
  assert.deepEqual([self.status, proj.status, off.status], ['active', 'active', 'proposed']);
  assert.ok(eng.core.notifications.filter((n) => /Proposed for the central context by Kira/.test(n.title)).length > 0);
  assert.throws(() => eng.context.propose(kira, { layer: 'client', title: 'x', text: 'y' }, null), /while answering that client/);
  eng.context.accept(off.id, 'owner');
  assert.equal(eng.context.get(off.id)!.status, 'active');
  const key = eng.context.add({ layer: 'office', title: 'API', text: 'The key is sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX1234 for staging.' }, 'owner');
  assert.match(key.text, /\{\{vault:[a-z0-9-]+\}\}/);
});

test('the office notices a meeting\'s decision and offers it — once, as a proposal', () => {
  const { eng, shop } = office();
  eng.context.start();
  const m = { id: 'm1', projectId: shop.id, topic: 'Where artefacts live', status: 'concluded', decisionDoc: '# Decision\nKeep them in /artifacts, one folder per run.', concludedAt: now(), participantIds: [], contributions: [], context: '', generatedTaskIds: [], createdAt: now() };
  eng.core.put('meeting', m as never);
  eng.core.put('meeting', m as never);
  const offered = eng.context.list().filter((f) => f.createdBy === 'meeting:m1');
  assert.equal(offered.length, 1);
  assert.equal(offered[0]!.status, 'proposed');
  assert.equal(offered[0]!.layer, 'project');
  assert.match(offered[0]!.text, /Keep them in \/artifacts/);
});

test("a change reaches every running session's machine once — not again while nothing changes", async () => {
  const { eng, kira } = office();
  eng.core.put('session', { id: 's-k', employeeId: kira.id, hostId: host.id, origin: 'managed', mode: 'interactive_cli', tmuxSession: 'k', tmuxPane: null, cwd: '/work/kira', repoRoot: null, branch: null, claudeSessionId: 'c', status: 'running', activity: 'idle', activityDetail: null, activitySince: now(), inTurn: false, control: 'AGENT_CONTROLLED', controllerId: null, capabilities: { terminal: true, hooks: true, mcp: true, structuredApproval: true, structuredMessaging: true, usage: false }, permissionMode: null, model: null, cols: 1, rows: 1, pid: null, usage: null, startedAt: now(), endedAt: null, lastEventAt: null, exitReason: null } as never);
  sent.length = 0;
  eng.context.add({ layer: 'office', title: 'Deploy', text: 'From main.' }, 'owner');
  eng.context.pushAll();
  eng.context.pushAll();
  const pushes = sent.filter((s) => s.method === 'session.context' && s.params.sessionId === 's-k');
  assert.equal(pushes.length, 1);
  assert.ok(pushes[0]!.params.context.items.some((i: { title: string }) => i.title === 'Deploy'));
});
