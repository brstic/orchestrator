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
