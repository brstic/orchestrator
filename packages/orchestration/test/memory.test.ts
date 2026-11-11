import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearch } from '../src/memory.ts';

// Exactly what MemPalace 3.11.0 printed on the office's server for a search (2026-11-11).
const REAL = `
============================================================
  Results for: "how many login attempts are allowed"
============================================================

  [1] office / answers
      Source: q-rate-limit.md
      Match:  cosine_sim=0.68  bm25=3.546

      # The boss answered Sarah (Shop, T-12): how many login attempts per minute?
      
      Question: Should the login form limit attempts, and to how many?
      Answer: Yes. Five per minute per address, then a one minute wait. Do not lock accounts.

  --------------------------------------------------------
  [2] office / tasks
      Source: t-12-login.md
      Match:  cosine_sim=0.407  bm25=0.239

      # T-12 Build the login screen (Shop) — done by Sarah on 2026-11-10
      
      The login form posts to /api/session. Sessions last 30 days when "remember me" is ticked.

  --------------------------------------------------------
`;

test('MemPalace\'s search output is read into results: the room, the source, how close, the text as it was filed', () => {
  const hits = parseSearch(REAL);
  assert.deepEqual(hits.map((h) => [h.room, h.source, h.score]), [['answers', 'q-rate-limit.md', 0.68], ['tasks', 't-12-login.md', 0.407]]);
  assert.equal(hits[0]!.text, '# The boss answered Sarah (Shop, T-12): how many login attempts per minute?\n\nQuestion: Should the login form limit attempts, and to how many?\nAnswer: Yes. Five per minute per address, then a one minute wait. Do not lock accounts.');
  assert.match(hits[1]!.text, /^# T-12 Build the login screen[\s\S]*"remember me" is ticked\.$/);
  assert.deepEqual(parseSearch(''), []);
  assert.deepEqual(parseSearch('\n  Results for: "x"\n\n  No results found.\n'), []);
});
