import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LOOK, cleanAppearance } from '../src/entities.ts';

test('a look from outside is kept only as far as it is a look: right kinds, within range, nothing else', () => {
  const full = { skin: '#AABBCC', hair: '#112233', hairStyle: 'mohawk', shirt: '#445566', pants: '#778899', accessory: 'cap', build: 1.04, outfit: 'suit', glasses: true, facialHair: 'goatee', face: 2, brows: 4, eyes: '#3f78ad', girth: 1.02, shoes: '#4a3122', tie: '#7d55b8' };
  assert.deepEqual(cleanAppearance(full, DEFAULT_LOOK), { ...full, skin: '#aabbcc' });
  // Wrong kinds fall back; out of range is brought within it; what is not part of a look is dropped.
  const odd = cleanAppearance({ skin: 'red', hairStyle: 'dreadlocks', accessory: 'crown', build: 3, face: 9, brows: -2, girth: 0.2, outfit: 'kilt', facialHair: 'muttonchops', eyes: 'javascript:alert(1)', admin: true, script: '<b>' }, DEFAULT_LOOK) as unknown as Record<string, unknown>;
  assert.equal(odd.skin, DEFAULT_LOOK.skin);
  assert.equal(odd.hairStyle, DEFAULT_LOOK.hairStyle);
  assert.equal(odd.accessory, DEFAULT_LOOK.accessory);
  assert.deepEqual([odd.build, odd.face, odd.brows, odd.girth], [1.1, 2, 0, 0.94]);
  assert.deepEqual([odd.outfit, odd.facialHair, odd.eyes], ['polo', 'none', '#5a3a22']);
  assert.ok(!('admin' in odd) && !('script' in odd));
  // Nothing at all: the base look.
  assert.deepEqual(cleanAppearance(null, DEFAULT_LOOK), DEFAULT_LOOK);
  assert.deepEqual(cleanAppearance('a string', DEFAULT_LOOK), DEFAULT_LOOK);
});
