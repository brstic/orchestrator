import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Appearance } from '@orchestrator/contracts';
import { lookKey } from '../src/looks.ts';

test('a figure is rebuilt when any part of its look changes — every choice of the character creator shows at once', () => {
  // Every field a look can have (the type's own keys: a new field that is not in this object fails to compile here).
  const full: Required<Appearance> = { skin: '#e0ac69', hair: '#241c17', hairStyle: 'short', shirt: '#2b3c66', pants: '#2b3c66', accessory: 'none', build: 1, outfit: 'polo', glasses: false, facialHair: 'none', face: 0, brows: 0, eyes: '#5a3a22', girth: 1, shoes: '#22252c', tie: '#8f2738' };
  const other: Required<Appearance> = { skin: '#8d5524', hair: '#c2185b', hairStyle: 'afro', shirt: '#3fd0c9', pants: '#1d2027', accessory: 'cap', build: 1.05, outfit: 'suit', glasses: true, facialHair: 'beard', face: 2, brows: 4, eyes: '#3f78ad', girth: 1.06, shoes: '#c0392b', tie: '#d4a017' };
  const stale = (Object.keys(full) as Array<keyof Appearance>).filter((k) => lookKey({ ...full, [k]: other[k] }) === lookKey(full));
  assert.deepEqual(stale, [], `changing these does not rebuild the figure: ${stale.join(', ')}`);
});
