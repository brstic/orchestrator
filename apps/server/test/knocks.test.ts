import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KNOCK_LIMITS, Knocks, type Admission } from '../src/knocks.ts';

const admission = (memberId: string): Admission => ({ role: 'visitor', name: 'X', token: 't', invite: 'i', expiresAt: null, memberId });

test('a knocker who stops asking has walked away; one who keeps asking stays until the longest wait', () => {
  let now = 1_000_000;
  let changes = 0;
  const knocks = new Knocks({ onChange: () => changes++, takeBack: () => assert.fail('nothing to take back'), now: () => now });
  const a = knocks.knock({ name: 'Ana', via: 'browser', ip: '1.1.1.1' });
  const b = knocks.knock({ name: 'Bora', via: 'app', ip: '2.2.2.2' });
  assert.deepEqual(knocks.list().map((k) => [k.name, k.via]), [['Ana', 'browser'], ['Bora', 'app']]);
  now += KNOCK_LIMITS.silentMs - 1000;
  assert.equal(knocks.poll(b.id, b.secret).status, 'waiting');
  now += 2000;
  knocks.sweep();
  assert.deepEqual(knocks.list().map((k) => k.name), ['Bora'], 'Ana stopped asking');
  assert.equal(knocks.poll(a.id, a.secret).status, 'gone');
  for (let t = 0; t < KNOCK_LIMITS.maxWaitMs; t += 10_000) {
    now += 10_000;
    knocks.poll(b.id, b.secret);
  }
  knocks.sweep();
  assert.deepEqual(knocks.list(), [], 'nobody stands at a door for ever');
  assert.ok(changes >= 4);
  knocks.close();
});

test('an answer nobody collects is taken back', () => {
  let now = 5_000_000;
  const taken: string[] = [];
  const knocks = new Knocks({ onChange: () => undefined, takeBack: (id) => taken.push(id), now: () => now });
  const a = knocks.knock({ name: 'Ana', via: 'app', ip: '1.1.1.1' });
  const b = knocks.knock({ name: 'Bora', via: 'app', ip: '2.2.2.2' });
  knocks.admit(a.id, () => admission('member-a'));
  knocks.admit(b.id, () => admission('member-b'));
  assert.throws(() => knocks.admit(a.id, () => admission('twice')), /no longer at the door/);
  assert.throws(() => knocks.refuse(a.id), /no longer at the door/);
  assert.equal(knocks.poll(b.id, b.secret).status, 'admitted');
  now += KNOCK_LIMITS.uncollectedMs + 1;
  knocks.sweep();
  assert.deepEqual(taken, ['member-a'], 'only the one that was never collected');
  knocks.close();
});

test('names are plain and short; the secret is compared, not looked up', () => {
  const knocks = new Knocks({ onChange: () => undefined, takeBack: () => undefined });
  assert.throws(() => knocks.knock({ name: 'x', via: 'app', ip: '1.1.1.1' }), /at least two letters/);
  assert.throws(() => knocks.knock({ name: { toString: () => '' }, via: 'app', ip: '1.1.1.1' }), /at least two letters/);
  const k = knocks.knock({ name: `<img src=x>${'n'.repeat(80)}`, via: 'nonsense', ip: '1.1.1.1' });
  const seen = knocks.list()[0]!;
  assert.equal(seen.via, 'browser');
  assert.ok(seen.name.length <= 40 && !/[<>]/.test(seen.name));
  assert.equal(knocks.poll(k.id, '').status, 'gone');
  assert.equal(knocks.poll(k.id, k.secret.slice(0, -1)).status, 'gone');
  assert.equal(knocks.poll(k.id, k.secret).status, 'waiting');
  knocks.close();
});
