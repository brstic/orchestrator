/**
 * How finished work is reviewed can be set for one project (`ProjectPolicy.review`), so that one team can work with
 * a lighter review while the office's own setting, and every other project, stay as they are.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewUsualOf } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';

const link: AgentLink = { rpc: () => Promise.reject(new Error('this test host runs nothing')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };

async function office() {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const shop = await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } });
  const blog = await eng.tasks.createProject({ name: 'Blog', policy: { autoAssign: false } });
  const make = (projectId: string, over: Record<string, unknown> = {}) => eng.tasks.createTask({ projectId, title: 'Fix the price rounding', kind: 'bug', released: false, ...over });
  return { eng, shop, blog, make };
}

test('a project with its own review: its new tasks start with it; other projects keep the office\'s', async () => {
  const o = await office();
  assert.equal(o.make(o.shop.id).reviewBy, 'both', 'the office\'s usual, before anything is set');

  o.eng.tasks.updateProject(o.shop.id, { policy: { review: 'peer' } });
  const light = o.make(o.shop.id);
  assert.deepEqual([light.reviewBy, light.requiresReview], ['peer', true]);
  assert.equal(o.make(o.blog.id).reviewBy, 'both', 'another project is not touched');
  assert.equal(reviewUsualOf(o.eng.core.settings, o.eng.core.projects.require(o.shop.id)), 'peer');
  assert.equal(reviewUsualOf(o.eng.core.settings, o.eng.core.projects.require(o.blog.id)), 'both');
});

test('what was chosen for a task still wins, and a part is still not reviewed on its own', async () => {
  const o = await office();
  o.eng.tasks.updateProject(o.shop.id, { policy: { review: 'peer' } });
  assert.equal(o.make(o.shop.id, { reviewBy: 'boss' }).reviewBy, 'boss');
  assert.equal(o.make(o.shop.id, { requiresReview: false }).reviewBy, 'none');
  assert.equal(o.make(o.shop.id, { requiresReview: true }).reviewBy, 'peer', '"needs review", with nothing more said: the project\'s way');
  const whole = o.make(o.shop.id);
  assert.equal(o.make(o.shop.id, { parentId: whole.id }).reviewBy, 'none');
});

test('a project set to no review: its tasks are done when their check passes; a review task never asks for one', async () => {
  const o = await office();
  o.eng.tasks.updateProject(o.shop.id, { policy: { review: 'none' } });
  const t = o.make(o.shop.id);
  assert.deepEqual([t.reviewBy, t.requiresReview], ['none', false]);
});

test('cleared, the project follows the office again — also when the office changes its mind', async () => {
  const o = await office();
  o.eng.tasks.updateProject(o.shop.id, { policy: { review: 'peer' } });
  o.eng.tasks.updateProject(o.shop.id, { policy: { review: null } });
  assert.equal(o.make(o.shop.id).reviewBy, 'both');
  o.eng.core.updateSettings({ reviewDefault: 'boss' });
  assert.equal(o.make(o.shop.id).reviewBy, 'boss');
});

test('a review that is not one of the four is refused, and nothing is stored', async () => {
  const o = await office();
  assert.throws(() => o.eng.tasks.updateProject(o.shop.id, { policy: { review: 'everyone' as never } }), /policy\.review/);
  assert.equal(o.eng.core.projects.require(o.shop.id).policy.review ?? null, null);
});
