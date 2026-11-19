import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RentLine } from '@orchestrator/contracts';
import { isNew, landOn } from '../src/rent/landing.ts';

const line = (id: string, from: RentLine['from'], ts: string): RentLine => ({ id, clientId: 'c', employeeId: 'e', from, text: 'x', ts });

test('coming in to the Rent portal: the conversation where an employee wrote meanwhile is opened, the newest first', () => {
  const agents = [
    { id: 'kira', last: line('k2', 'client', '2026-11-19T10:00:00Z') },
    { id: 'mila', last: line('m5', 'agent', '2026-11-19T11:00:00Z') },
    { id: 'pm', last: line('p9', 'agent', '2026-11-19T12:00:00Z') },
    { id: 'bob', last: null },
  ];
  // Mila's and the PM's are new; the PM wrote last.
  assert.equal(landOn(agents, {}, null), 'pm');
  assert.equal(landOn(agents, {}, 'kira'), 'pm', 'the one they came back to has nothing new');
  assert.equal(landOn(agents, {}, 'mila'), null, 'the one they came back to has something new itself');
  assert.equal(landOn(agents, { mila: 'm5', pm: 'p9' }, 'kira'), null, 'all seen: they stay where they were');
  assert.equal(landOn(agents, { pm: 'p9' }, null), 'mila');
  // Their own last word is not news.
  assert.equal(isNew(agents[0]!, {}), false);
  assert.equal(isNew(agents[2]!, { pm: 'p8' }), true);
});
