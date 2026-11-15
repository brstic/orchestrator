import { test } from 'node:test';
import assert from 'node:assert/strict';
import { about } from '../src/tasks.ts';
import { grantKey } from '../../../apps/host-agent/src/agent.ts';

const e = (name: string, extra: Partial<{ title: string; specialization: string; skills: string[]; workingDir: string | null }> = {}) => ({ name, title: 'Full-Stack Engineer', specialization: '', skills: [], workingDir: null, ...extra });

test('a task says whose it is: the part of the product in a colleague\'s name, speciality or folder', () => {
  const task = { title: 'Marketplace Stripe status: push, deploy to dev', description: 'The sell page must show the account status.' };
  assert.ok(about(task, e('Xenon Marketplace')) > about(task, e('Xenon Panel')));
  assert.equal(about(task, e('Xenon Panel')), 0, 'a word they all share ("xenon") is not in the task, and nothing else matches');
  // By folder and by speciality too.
  assert.ok(about({ title: 'Fix the checkout total', description: '' }, e('Dana', { workingDir: '/srv/shop/checkout' })) > 0);
  assert.ok(about({ title: 'Rotate the backups', description: '' }, e('Omar', { specialization: 'Backups and restore' })) > 0);
  // A word in the title weighs more than one in the description.
  assert.ok(about({ title: 'Panel: month graph', description: '' }, e('Xenon Panel')) > about({ title: 'Month graph', description: 'in the panel' }, e('Xenon Panel')));
});

test('what everybody has in common points at nobody, and the weight is bounded', () => {
  const task = { title: 'Senior full-stack engineer work on the project server', description: 'code and tests and docs' };
  assert.equal(about(task, e('Alex', { title: 'Senior Full-Stack Engineer', skills: ['code', 'tests'], workingDir: '/home/users/projects/app' })), 0);
  const loud = { title: 'marketplace marketplace stripe checkout payments invoices', description: '' };
  assert.equal(about(loud, e('Marketplace Stripe Checkout Payments Invoices')), 3, 'never more than 3');
  assert.equal(about({ title: 'x', description: '' }, e('')), 0);
});

test('"the same call" for a one-time grant: a command by its text, anything else by its whole input', () => {
  assert.equal(grantKey('Bash', { command: ' git push origin main ', description: 'push' }), grantKey('Bash', { command: 'git push origin main', description: 'another description' }));
  assert.notEqual(grantKey('Bash', { command: 'git push origin main' }), grantKey('Bash', { command: 'git push origin main --force' }));
  assert.equal(grantKey('Write', { file_path: '/a', content: 'x' }), grantKey('Write', { content: 'x', file_path: '/a' }));
  assert.notEqual(grantKey('Write', { file_path: '/a', content: 'x' }), grantKey('Write', { file_path: '/a', content: 'y' }));
  assert.notEqual(grantKey('Write', { file_path: '/a', content: 'x' }), grantKey('Edit', { file_path: '/a', content: 'x' }));
});
