import { test } from 'node:test';
import assert from 'node:assert/strict';
import { READ_MAX_BYTES, SHOW_MAX_CHARS, extOf, familyOf, readableAs, shownOf } from '../src/lib/readable.ts';

test('what an employee leaves as text is read in the window; the rest is downloaded', () => {
  // By the name, whatever type it arrived with.
  assert.equal(readableAs('t212-dev-verification-34-keywords.txt', 'application/octet-stream', 4096), 'text');
  assert.deepEqual(['notes.md', 'README.MARKDOWN'].map((n) => readableAs(n, null, 10)), ['markdown', 'markdown']);
  assert.deepEqual(['a.json', 'b.csv', 'c.log', 'd.patch', 'e.tsx', 'f.yml', '.env', 'Dockerfile'].map((n) => readableAs(n, '', 10)), Array(8).fill('text'));
  // By the type, when the name says nothing.
  assert.deepEqual([readableAs('report', 'text/plain; charset=utf-8', 10), readableAs('data', 'application/json', 10), readableAs('blob', 'application/octet-stream', 10)], ['text', 'text', null]);
  // Never: documents and archives, pictures (they have their own viewer), and anything too large to read.
  assert.deepEqual(['a.pdf', 'b.docx', 'c.zip', 'd.png', 'e.xlsx'].map((n) => readableAs(n, 'text/plain', 10)), [null, null, null, 'text', null]);
  assert.equal(readableAs('shot.png', 'image/png', 10), null);
  assert.deepEqual([readableAs('big.log', 'text/plain', READ_MAX_BYTES), readableAs('big.log', 'text/plain', READ_MAX_BYTES + 1)], ['text', null]);
});

test('the extension is the last part of the name, of the file and not of its folder', () => {
  assert.deepEqual(['a.b.TXT', 'dir.v2/readme', '.gitignore', 'Makefile', 'x\\y\\z.Log'].map(extOf), ['txt', 'readme', 'gitignore', 'makefile', 'log']);
});

test('every file has a colour family', () => {
  assert.deepEqual(['a.txt', 'a.md', 'a.json', 'a.ts', 'a.pdf', 'a.zip', 'a.bin'].map((n) => familyOf(n)), ['text', 'text', 'data', 'code', 'doc', 'archive', 'other']);
  assert.deepEqual([familyOf('shot', 'image/png'), familyOf('notes', 'text/plain')], ['picture', 'text']);
});

test('a very long file is drawn up to a limit, and says so', () => {
  assert.deepEqual(shownOf('short'), { text: 'short', cut: false });
  const long = shownOf('x'.repeat(SHOW_MAX_CHARS + 5));
  assert.deepEqual([long.text.length, long.cut], [SHOW_MAX_CHARS, true]);
});
