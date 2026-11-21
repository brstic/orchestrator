import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correlationMarker, defaultLayout, deskSeat, levelForXp, matchRole, parseCorrelationMarkers, redactDeep, redactSecrets, slugify } from '../src/index.ts';

test('secrets are redacted before anything is persisted', () => {
  assert.equal(redactSecrets('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 here'), 'key [REDACTED] here');
  assert.equal(redactSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), '[REDACTED]');
  assert.equal(redactSecrets('export API_KEY=supersecretvalue123'), 'export API_KEY=[REDACTED]');
  assert.equal(redactSecrets('DB_PASSWORD: "hunter2hunter2"'), 'DB_PASSWORD:[REDACTED]');
  assert.match(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----'), /^\[REDACTED\]$/);
  assert.equal(redactSecrets('npm test --silent'), 'npm test --silent', 'ordinary commands are untouched');
  assert.deepEqual(redactDeep({ command: 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghij"', token: 'abc', nested: [{ password: 'p' }] }), {
    command: 'curl -H "Authorization: Bearer [REDACTED]"',
    token: '[REDACTED]',
    nested: [{ password: '[REDACTED]' }],
  });
});

test('correlation markers round-trip', () => {
  const m = correlationMarker('TASK', 'abc-123');
  assert.equal(m, '[ORCH:TASK:abc-123]');
  assert.deepEqual(parseCorrelationMarkers(`x ${m} y ${correlationMarker('MSG', 'q_1')}`), [{ kind: 'TASK', id: 'abc-123' }, { kind: 'MSG', id: 'q_1' }]);
  assert.deepEqual(parseCorrelationMarkers('no markers'), []);
});

test('roles, levels, slugs', () => {
  assert.equal(matchRole('an available backend engineer')?.key, 'backend');
  assert.equal(matchRole('QA')?.key, 'qa');
  assert.equal(matchRole('the janitor'), undefined);
  assert.equal(levelForXp(0), 1);
  assert.equal(levelForXp(150), 2);
  assert.equal(levelForXp(399), 2);
  assert.equal(slugify('Sarah O\'Connor — Frontend!'), 'sarah-o-connor-frontend');
  assert.equal(slugify('***'), 'x');
});

test('the default office layout is consistent', () => {
  const layout = defaultLayout();
  assert.ok(layout.desks.length >= 24);
  assert.equal(new Set(layout.desks.map((d) => d.id)).size, layout.desks.length, 'desk ids are unique');
  for (const kind of ['ceo', 'meeting', 'ops', 'server', 'break', 'reception', 'open', 'hall']) assert.ok(layout.rooms.some((r) => r.kind === kind), `room ${kind}`);
  const open = layout.rooms.find((r) => r.kind === 'open')!;
  for (const d of layout.desks) {
    assert.ok(d.x > open.x && d.x < open.x + open.w && d.z > open.z && d.z < open.z + open.d, `desk ${d.id} is on the engineering floor`);
    const seat = deskSeat(d);
    assert.ok(Math.hypot(seat.x - d.x, seat.z - d.z) > 0.5);
  }
});

test('hiding secrets takes time in step with the text: text built to be slow is not, and what was hidden still is', () => {
  const n = 200_000;
  const hostile: Record<string, string> = {
    'one long word': 'a'.repeat(n),
    'a word made of the word token': 'TOKEN'.repeat(n / 5),
    'the same in small letters': 'password'.repeat(n / 8),
    'a name, then nothing but spaces': `API_KEY${' '.repeat(n)}x`,
    'tokens that begin and have no dots': 'eyJaaaaaaaaaa-'.repeat(Math.floor(n / 14)),
    'keys that begin and never end': '-----BEGIN PRIVATE KEY-----'.repeat(Math.floor(n / 27)),
    'a key header that never closes': `-----BEGIN ${'A '.repeat(n / 2)}`,
    'dashes after a prefix': `sk-ant-${'-'.repeat(n)} xoxb-${'-'.repeat(n)} github_pat_${'_'.repeat(n)}`,
    'names with no value': 'TOKEN= '.repeat(Math.floor(n / 7)),
    'a quote that is never closed': `SECRET="${'x '.repeat(n / 2)}`,
  };
  for (const [what, text] of Object.entries(hostile)) {
    const t0 = process.hrtime.bigint();
    redactSecrets(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1500, `${what}: ${Math.round(ms)} ms for ${text.length} characters`);
  }
  assert.equal(redactSecrets(`${'a'.repeat(5000)} --token=abcdef123456 ${'TOKEN'.repeat(500)} MY_DB_PASSWORD: "hunter2hunter2"`), `${'a'.repeat(5000)} --token=[REDACTED] ${'TOKEN'.repeat(500)} MY_DB_PASSWORD:[REDACTED]`);
});

test('choices written into a question ("A) … B) … C) …") are read out of it, to be answered with a click', async () => {
  const { optionsIn } = await import('../src/util.ts');
  // The question the owner was shown on 2026-11-12, as its employee wrote it.
  const asked =
    '@boss Radim još, ali da ne nagađam šta ti ne valja: pogledao sam ponovo dev i evo šta meni samom ne valja.\n\n1) Lista (/websites): svaki red ponavlja naslove, domeni se lome u 2-3 reda.\n2) Prostor sajta, Overview: skoro prazan.\n3) Navigacija u sajtu: 6 kartica gore pa još meni levo, kutija u kutiji. Šta od ovoga da uradim? A) Struktura ostaje (lista + klik na sajt sa 5 sekcija), ali ozbiljno doterujem izgled: Overview postaje pravi dashboard sajta (slika sajta, grafikoni), lista dobija jedno zaglavlje. B) Menjam strukturu: bez kartica i menija, sve o sajtu na jednoj dugoj strani (sekcije jedna ispod druge, sve vidljivo odmah). C) Nešto treće: napiši u par reči šta ti smeta (izgled, raspored, nešto fali, nešto ne radi). Pre gradnje ti pokazujem sliku. Prilozi na tasku su puni (30), pa sliku stavljam kao stranu na dev-u.';
  assert.deepEqual(optionsIn(asked), [
    { label: 'A) Struktura ostaje (lista + klik na sajt sa 5 sekcija), ali ozbiljno doterujem izgled', description: 'Overview postaje pravi dashboard sajta (slika sajta, grafikoni), lista dobija jedno zaglavlje.' },
    { label: 'B) Menjam strukturu', description: 'bez kartica i menija, sve o sajtu na jednoj dugoj strani (sekcije jedna ispod druge, sve vidljivo odmah).' },
    { label: 'C) Nešto treće', description: 'napiši u par reči šta ti smeta (izgled, raspored, nešto fali, nešto ne radi).' },
  ]);
  // On lines of their own, in brackets, short.
  assert.deepEqual(optionsIn('Which database?\n(A) Postgres\n(B) SQLite\n\nI lean towards A.'), [{ label: 'A) Postgres' }, { label: 'B) SQLite' }]);
  assert.deepEqual(optionsIn('Ship it? A) Yes, today. B) No — wait for the review.'), [{ label: 'A) Yes, today' }, { label: 'B) No', description: 'wait for the review.' }]);
  // Not choices: a numbered list, one letter alone, letters out of order, a letter inside a word or a formula.
  for (const not of ['Three things: 1) the list 2) the page 3) the menu.', 'Plan A) is the only one.', 'See B) first and then A) later.', 'f(A) + g(B) = 3', 'The classes AA) and BB) are gone.', '', 'A) only one']) assert.deepEqual(optionsIn(not), [], not);
  assert.deepEqual(optionsIn(undefined), []);
  assert.deepEqual(optionsIn({}), []);
  // A list that only starts again: the later one counts. And a long text costs nothing.
  assert.deepEqual(optionsIn('Plan A) was dropped. Now: A) rebuild B) patch').map((o) => o.label), ['A) rebuild', 'B) patch']);
  const t0 = Date.now();
  optionsIn(`${'A) '.repeat(3000)}B) x`);
  optionsIn('A) ' + 'x'.repeat(15000) + ' B) y');
  assert.ok(Date.now() - t0 < 200, `took ${Date.now() - t0} ms`);
});

test('search words: every word, any case or accent; ranges are of the text as written', async () => {
  const { searchWords, matchesWords, matchRanges, snippetOf } = await import('../src/index.ts');
  assert.deepEqual(searchWords('  Račun  RAČUN novembar '), ['racun', 'novembar']);
  assert.equal(matchesWords('Ćao, evo računa za novembar', searchWords('novembar cao')), true);
  assert.equal(matchesWords('Ćao, evo računa', searchWords('novembar cao')), false);
  assert.equal(matchesWords('anything', []), false);
  const text = 'Đorđe sent the Résumé; résumé again';
  assert.deepEqual(
    matchRanges(text, searchWords('resume dorde')).map(([a, b]) => text.slice(a, b)),
    ['Đorđe', 'Résumé', 'résumé'],
  );
  assert.deepEqual(matchRanges('emoji 😄 then word', ['word']).map(([a, b]) => 'emoji 😄 then word'.slice(a, b)), ['word']);
  const long = `${'x '.repeat(100)}the needle here ${'y '.repeat(100)}`;
  const s = snippetOf(long, ['needle'], 60);
  assert.match(s, /^….*needle.*…$/);
  assert.ok(s.length <= 62);
});
