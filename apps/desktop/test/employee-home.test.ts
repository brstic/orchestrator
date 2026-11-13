import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeOf, homePatch } from '../src/lib/employee-home.ts';

const projects = {
  own: { id: 'own', repoPath: '/work/blog', workspace: 'in_place' as const, ownerEmployeeId: 'e1' },
  shop: { id: 'shop', repoPath: '/work/shop', workspace: 'worktrees' as const, ownerEmployeeId: null },
  anas: { id: 'anas', repoPath: '/work/notes', workspace: 'in_place' as const, ownerEmployeeId: 'e9' },
};

test('where somebody lives is said as the hire form asks it: a folder of their own, or a shared project', () => {
  // Hired into a folder: their own project, worked in place — shown as the folder, not as a project.
  assert.deepEqual(homeOf({ id: 'e1', projectId: 'own', workingDir: '/work/blog' }, projects), { shared: '', folder: '/work/blog' });
  assert.deepEqual(homeOf({ id: 'e1', projectId: 'own', workingDir: null }, projects), { shared: '', folder: '/work/blog' });
  // On a shared project: a worktree, no folder of their own.
  assert.deepEqual(homeOf({ id: 'e2', projectId: 'shop', workingDir: null }, projects), { shared: 'shop', folder: '' });
  // Living in the same folder as a colleague (their project): still "this folder".
  assert.deepEqual(homeOf({ id: 'e3', projectId: 'anas', workingDir: '/work/notes' }, projects), { shared: '', folder: '/work/notes' });
  // On a colleague's in-place project without living in its folder: that is a project they share.
  assert.deepEqual(homeOf({ id: 'e3', projectId: 'anas', workingDir: null }, projects), { shared: 'anas', folder: '' });
  // Nowhere yet; a folder by hand with no project; a project this window does not know yet.
  assert.deepEqual(homeOf({ id: 'e4', projectId: null, workingDir: null }, projects), { shared: '', folder: '' });
  assert.deepEqual(homeOf({ id: 'e4', projectId: null, workingDir: '/tmp/x' }, projects), { shared: '', folder: '/tmp/x' });
  assert.deepEqual(homeOf({ id: 'e4', projectId: 'new', workingDir: '/work/new' }, projects), { shared: '', folder: '/work/new' });
});

test('what the office is asked when the form says something else', () => {
  const blogger = { id: 'e1', projectId: 'own', workingDir: '/work/blog' };
  const onShop = { id: 'e2', projectId: 'shop', workingDir: null };
  // Nothing changed: nothing asked (also when only spaces were typed around the folder).
  assert.deepEqual(homePatch(blogger, projects, { shared: '', folder: ' /work/blog ' }), {});
  assert.deepEqual(homePatch(onShop, projects, { shared: 'shop', folder: '' }), {});
  // Another folder: given to them the way hiring gives one.
  assert.deepEqual(homePatch(blogger, projects, { shared: '', folder: '/work/site' }), { folder: '/work/site' });
  // From their folder onto a shared project: the folder is let go of.
  assert.deepEqual(homePatch(blogger, projects, { shared: 'shop', folder: '/work/blog' }), { projectId: 'shop', workingDir: null });
  // From a shared project into a folder of their own; or off it with nowhere to go yet.
  assert.deepEqual(homePatch(onShop, projects, { shared: '', folder: '/work/alone' }), { folder: '/work/alone' });
  assert.deepEqual(homePatch(onShop, projects, { shared: '', folder: '' }), { projectId: null });
  // The folder emptied: no folder and no project.
  assert.deepEqual(homePatch(blogger, projects, { shared: '', folder: '' }), { projectId: null, workingDir: null });
  assert.deepEqual(homePatch({ id: 'e4', projectId: null, workingDir: null }, projects, { shared: '', folder: '' }), {});
});
