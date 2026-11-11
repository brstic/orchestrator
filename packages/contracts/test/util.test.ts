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
