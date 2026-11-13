import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountChoices, accountName, providerName, signInLink } from '../src/lib/accounts.ts';

test('an account is called by who is signed in to it, not by its folder', () => {
  assert.equal(accountName({ configDir: '~/.claude-2', email: 'ana@example.com' }), 'ana@example.com');
  assert.equal(accountName({ configDir: null, email: 'boss@example.com' }), 'boss@example.com');
  assert.equal(accountName({ configDir: '~/.claude-zai', provider: 'zai', endpoint: 'api.z.ai' }), 'Z.AI');
  assert.equal(accountName({ configDir: '~/.claude-other', provider: 'custom', endpoint: 'llm.example.com' }), 'llm.example.com');
  assert.equal(accountName({ configDir: null }, { memberId: 'm1', memberName: 'Mila' }), "Mila's Claude");
  // Only when nothing is known does the folder show — and it says why.
  assert.equal(accountName({ configDir: '~/.claude-3' }), 'Not signed in yet');
  assert.deepEqual(accountChoices([{ hostId: 'h1', configDir: '~/.claude-3' }], 'h1').map((c) => c.label), ['Default login', 'Not signed in yet (~/.claude-3)']);
  assert.equal(accountName({ configDir: null }), 'Default login');
  assert.equal(providerName({ provider: 'anthropic' }), null);
});

test("an employee's account is chosen among those of their machine, by name; the default first", () => {
  const accounts = [
    { hostId: 'h1', configDir: '~/.claude-2', email: 'second@example.com' },
    { hostId: 'h1', configDir: null, email: 'first@example.com' },
    { hostId: 'h1', configDir: '~/.claude-zai', provider: 'zai' as const },
    { hostId: 'h2', configDir: '~/.claude-2', email: 'elsewhere@example.com' },
  ];
  assert.deepEqual(accountChoices(accounts, 'h1'), [
    { value: '', label: 'first@example.com (default)' },
    { value: '~/.claude-2', label: 'second@example.com' },
    { value: '~/.claude-zai', label: 'Z.AI' },
  ]);
  // A machine nobody has asked about yet still has its default login to choose.
  assert.deepEqual(accountChoices(accounts, 'h3'), [{ value: '', label: 'Default login' }]);
  // Two accounts of the same name are told apart by where they are.
  const twins = [{ hostId: 'h1', configDir: '~/.claude-2', email: 'same@example.com' }, { hostId: 'h1', configDir: '~/.claude-3', email: 'same@example.com' }];
  assert.deepEqual(accountChoices(twins, 'h1').map((c) => c.label), ['Default login', 'same@example.com (~/.claude-2)', 'same@example.com (~/.claude-3)']);
});

test('the link of a sign-in is read from its terminal, also when the terminal cut it into lines', () => {
  assert.equal(signInLink(['Welcome', 'nothing here']), null);
  const whole = 'https://claude.ai/oauth/authorize?code=true&client_id=abc-123&response_type=code&redirect_uri=https%3A%2F%2Fconsole.example%2Fcallback&scope=user%3Ainference&state=XyZ';
  assert.equal(signInLink(['Browser did not open? Use the url below to sign in:', '', whole, '', 'Paste code here if prompted >']), whole);
  // Cut at 60 columns by the terminal.
  const cut = [whole.slice(0, 60), whole.slice(60, 120), whole.slice(120)];
  assert.equal(signInLink(['Use the url below to sign in:', ...cut, '', 'Paste code here if prompted >']), whole);
  // What follows the address is not part of it.
  assert.equal(signInLink([`Open ${whole}`, 'and come back.']), whole);
});
