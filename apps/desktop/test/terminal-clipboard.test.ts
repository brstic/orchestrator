import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectionText } from '../src/terminal/clipboard.ts';

test('a web address printed across several rows is copied as one address', () => {
  const rows = ['https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a   ', 't_uri=https%3A%2F%2Fplatform.claude.com%2Foauth&scope=org%3Acreate_api_key', 'rgs_ZpeSIyY&state=-9UyFfKXgDVNMp70jH26k', '', ''];
  assert.equal(selectionText(rows.join('\n')), rows.slice(0, 3).map((r) => r.trim()).join(''));
  // Indented rows, as inside a box drawn by the program.
  assert.equal(selectionText('  https://example.com/a\r\n  b/c?d=1\r\n'), 'https://example.com/ab/c?d=1');
});

test('anything else is copied as it stands, without the blank ends of rows', () => {
  assert.equal(selectionText('npm test   \n  2 passing  \n\n'), 'npm test\n  2 passing');
  assert.equal(selectionText('https://example.com/docs'), 'https://example.com/docs', 'one row is left alone');
  // An address followed by words is prose, not one address.
  assert.equal(selectionText('https://example.com/a\nthen press Enter'), 'https://example.com/a\nthen press Enter');
  assert.equal(selectionText('See https://example.com/a\nb'), 'See https://example.com/a\nb');
  assert.equal(selectionText('   \n  '), '');
});
