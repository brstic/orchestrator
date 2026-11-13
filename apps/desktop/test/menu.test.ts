import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABOUT, matches } from '../src/lib/menu.ts';

/** The menu's box finds a window by a word of its name, of what it is for, or of what people call it. */
const item = (id: string, label: string) => ({ id, label }) as any;

test('a window is found by its name, by what it is for, and by what people call it', () => {
  assert.ok(matches(item('vault', 'Vault'), 'vau'));
  assert.ok(matches(item('vault', 'Vault'), 'password'));
  assert.ok(matches(item('vault', 'Vault'), 'KEYS employees'));
  assert.ok(matches(item('hosts', 'Machines'), 'ssh'));
  assert.ok(matches(item('team', 'Team'), 'hire'));
  assert.ok(matches(item('tasks', 'Tasks'), 'board'));
  assert.ok(matches(item('reports', 'Reports'), ''));
  assert.ok(!matches(item('vault', 'Vault'), 'radio'));
  // Every word that was typed has to be there.
  assert.ok(!matches(item('team', 'Team'), 'hire radio'));
  // A window the menu has no line for is still found by its name.
  assert.ok(matches(item('something-new', 'Something new'), 'new'));
});

test('every line about a window is short enough to be read at a glance', () => {
  for (const [id, line] of Object.entries(ABOUT)) assert.ok(line!.length <= 44, `${id}: "${line}" is ${line!.length} characters`);
});
