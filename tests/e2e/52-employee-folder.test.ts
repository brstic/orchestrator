/**
 * An employee's folder is changed in their settings the way it is chosen when they are hired: a folder of their own
 * becomes their own project, worked in place (or they join the project that already lives there), and a shared
 * project is the other choice. It takes effect when their session next starts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, waitFor } from './harness.ts';

type Harness = Awaited<ReturnType<typeof createHarness>>;
let h: Harness;
const ids: Record<string, string> = {};
const dirs: Record<string, string> = {};
const employee = async (name: string) => (await h.state()).employees.find((e) => e.id === ids[name])!;
const projectOf = async (name: string) => { const s = await h.state(); const e = s.employees.find((x) => x.id === ids[name])!; return s.projects.find((p) => p.id === e.projectId); };

before(async () => {
  h = await createHarness();
  for (const name of ['blog', 'site', 'notes', 'shop']) dirs[name] = h.makeRepo(name);
  ids.shop = (await h.project('Shop', dirs.shop!)).id;
  // Hired into folders of their own, the way the hire form does it.
  for (const [name, dir] of [['Alex', dirs.blog], ['Sarah', dirs.notes]] as const) ids[name] = (await h.api<any>('POST', '/employees', { name, roleKey: 'backend', hostId: h.hostId, workingDir: dir, autonomy: 'auto' })).id;
});
after(async () => {
  await h?.cleanup();
});

test('another folder in the settings is given the way hiring gives one: it becomes their own project, worked in place', async () => {
  const before = (await projectOf('Alex'))!;
  assert.deepEqual([before.repoPath, before.workspace, before.ownerEmployeeId], [dirs.blog, 'in_place', ids.Alex]);
  const res = await h.api<any>('PATCH', `/employees/${ids.Alex}`, { folder: dirs.site });
  assert.equal(res.workingDir, dirs.site);
  const now = (await projectOf('Alex'))!;
  assert.notEqual(now.id, before.id);
  assert.deepEqual([now.repoPath, now.workspace, now.ownerEmployeeId, now.name], [dirs.site, 'in_place', ids.Alex, 'site']);
  // The project of the folder they left is still there, with what was done in it.
  assert.ok((await h.state()).projects.some((p) => p.id === before.id && p.status !== 'archived'));
  // Their next session starts in the new folder.
  await h.api('POST', `/employees/${ids.Alex}/start`, {});
  const s = await waitFor(async () => { const x = await h.session(ids.Alex!); return x?.status === 'running' ? x : null; }, { label: 'Alex is started', timeout: 30000 });
  assert.equal(s.cwd, dirs.site);
  await h.api('POST', `/employees/${ids.Alex}/stop`, {});
});

test('a folder somebody already lives in is joined, not made twice; one that is not there is refused and nothing changes', async () => {
  const sarahs = (await projectOf('Sarah'))!;
  await h.api('PATCH', `/employees/${ids.Alex}`, { folder: dirs.notes });
  const now = (await projectOf('Alex'))!;
  assert.equal(now.id, sarahs.id);
  assert.equal(now.ownerEmployeeId, ids.Sarah, 'it stays hers');
  assert.equal((await employee('Alex')).workingDir, dirs.notes);
  const missing = path.join(path.dirname(dirs.notes!), 'no-such-folder');
  const bad = await h.apiRaw('PATCH', `/employees/${ids.Alex}`, { folder: missing, name: 'Renamed' });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /does not exist on that machine yet/);
  const still = await employee('Alex');
  assert.deepEqual([still.name, still.workingDir, still.projectId], ['Alex', dirs.notes, sarahs.id], 'a change that names a folder that is not there is not half made');
  assert.ok(!fs.existsSync(missing));
});

test('a shared project is the other choice: a worktree instead of a folder, and back to a folder of their own', async () => {
  await h.api('PATCH', `/employees/${ids.Alex}`, { projectId: ids.shop, workingDir: null });
  assert.deepEqual([(await employee('Alex')).projectId, (await employee('Alex')).workingDir], [ids.shop, null]);
  await h.api('PATCH', `/employees/${ids.Alex}`, { folder: dirs.blog });
  const back = (await projectOf('Alex'))!;
  assert.deepEqual([back.repoPath, back.workspace, (await employee('Alex')).workingDir], [dirs.blog, 'in_place', dirs.blog]);
  // Other fields in the same change are made with it.
  await h.api('PATCH', `/employees/${ids.Alex}`, { folder: dirs.site, title: 'Site Engineer' });
  const e = await employee('Alex');
  assert.deepEqual([e.title, e.workingDir], ['Site Engineer', dirs.site]);
});
