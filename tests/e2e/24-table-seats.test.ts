/**
 * A table's fifth and sixth seat: they face each other in a third column of the same table, never in a row that
 * runs into the table next door — and a layout an earlier version got wrong is put right when the office starts.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from './harness.ts';

let h: Harness;
before(async () => {
  h = await createHarness();
});
after(async () => {
  await h?.cleanup();
});

const pod = async (p: string) => (await h.state()).layout.desks.filter((d) => d.id.replace(/-[a-z]$/, '') === p).map((d) => [d.id, d.x, d.z, Math.round(d.rot * 100) / 100]);

test('a fifth and a sixth seat go into a third column of their own table, facing each other', async () => {
  assert.deepEqual(await pod('b'), [['b-a', -10.45, -0.7, 0], ['b-b', -8.55, -0.7, 0], ['b-c', -10.45, 0.3, 3.14], ['b-d', -8.55, 0.3, 3.14]]);
  await h.api('POST', '/layout/pods/b/desks', {});
  await h.api('POST', '/layout/pods/b/desks', {});
  const six = await pod('b');
  assert.deepEqual(six.slice(4), [['b-e', -6.65, -0.7, 0], ['b-f', -6.65, 0.3, 3.14]], 'one column further, one seat on each side of the table');
  // Nothing of table b stands in table c (whose nearest desks are at x = -3.45).
  const c = await pod('c');
  for (const [, x, z] of six) for (const [, cx, cz] of c) assert.ok(Math.abs((x as number) - (cx as number)) >= 1.7 + 0.9 || Math.abs((z as number) - (cz as number)) >= 1.9, `a seat of b at ${x},${z} is too close to c at ${cx},${cz}`);
  assert.equal((await h.apiRaw('POST', '/layout/pods/b/desks', {})).status, 400, 'six is the most');
});

test('a seat an earlier version put into the neighbouring table is moved back to its own, with whoever sits there', async () => {
  const project = await h.project('Shop', h.makeRepo('shop'));
  const alex = await h.employee('Alex', 'backend', { projectId: project.id, deskId: 'b-f' });
  // What the earlier version produced: the sixth seat beside the fifth, in the same row, inside table c.
  const layout = (await h.state()).layout;
  await h.api('PUT', '/layout', { ...layout, desks: layout.desks.map((d) => (d.id === 'b-f' ? { ...d, x: -4.75, z: -0.7, rot: 0 } : d)) });
  assert.deepEqual((await pod('b'))[5], ['b-f', -4.75, -0.7, 0]);
  await h.restartServer();
  assert.deepEqual((await pod('b')).slice(4), [['b-e', -6.65, -0.7, 0], ['b-f', -6.65, 0.3, 3.14]]);
  assert.equal((await h.state()).employees.find((e) => e.id === alex.id)!.deskId, 'b-f', 'Alex still sits at that seat');
  // A table nobody added to is left exactly as it was, and a second start changes nothing.
  const before = JSON.stringify((await h.state()).layout.desks);
  await h.restartServer();
  assert.equal(JSON.stringify((await h.state()).layout.desks), before);
});

test('an empty table can be taken off the floor and put back; one somebody sits at cannot', async () => {
  const before = (await h.state()).layout.desks.length;
  const capacity = async () => (await h.api<{ desks: number; freePodSlots: number }>('GET', '/layout/capacity'));
  const free = (await capacity()).freePodSlots;
  // Table d, where nobody sits, with a label on it.
  await h.api('PUT', '/layout/pods/d/label', { label: 'Spare' });
  const d = (await pod('d')).map((x) => x[0] as string);
  assert.equal(d.length, 4);
  const after = await h.api<any>('POST', '/layout/desks/remove', { ids: d });
  assert.equal(after.desks.length, before - 4);
  assert.equal(after.podLabels?.d, undefined, 'its label went with it');
  assert.deepEqual(await pod('d'), []);
  // The place it stood in is free for a table again.
  assert.equal((await capacity()).freePodSlots, free + 1);
  // Somebody sits at table c: the whole request is refused and nothing is removed.
  const project = await h.project('Seats', h.makeRepo('seats'));
  const sam = await h.employee('Sam', 'backend', { projectId: project.id, deskId: 'c-a' });
  const refused = await h.apiRaw('POST', '/layout/desks/remove', { ids: ['c-a', 'c-b'] });
  assert.equal(refused.status, 400);
  assert.match(JSON.stringify(refused.body), /Sam sits there; move them first/);
  assert.equal((await pod('c')).length, 4);
  assert.equal((await h.state()).employees.find((e) => e.id === sam.id)!.deskId, 'c-a');
  // Unknown desks and an empty list are refused too.
  assert.equal((await h.apiRaw('POST', '/layout/desks/remove', { ids: ['nope-a'] })).status, 400);
  assert.equal((await h.apiRaw('POST', '/layout/desks/remove', { ids: [] })).status, 400);
  // "Add a table" fills free places until the one that was emptied has a table again.
  for (let i = 0; i <= free; i++) await h.api('POST', '/layout/pods', {});
  const desks = (await h.state()).layout.desks;
  assert.ok(desks.filter((x) => Math.hypot(x.x - 4.5, x.z + 0.2) < 2.2).length === 4, 'a table stands where table d stood');
  assert.equal((await capacity()).freePodSlots, 0);
});
