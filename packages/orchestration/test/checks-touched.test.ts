import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksTouched } from '../src/tasks.ts';

test('a task that changed its own tests, the runner\'s settings or the script it is verified by is noticed', () => {
  const files = ['src/cart.ts', 'src/cart.test.ts', 'tests/e2e/checkout.spec.js', 'package.json', 'README.md', 'scripts/verify.sh', 'jest.config.js', '.github/workflows/ci.yml', 'pkg/cart_test.go', 'tests/test_cart.py'];
  assert.deepEqual(checksTouched(files, 'npm test --silent'), ['src/cart.test.ts', 'tests/e2e/checkout.spec.js', 'package.json', 'scripts/verify.sh', 'jest.config.js', '.github/workflows/ci.yml', 'pkg/cart_test.go', 'tests/test_cart.py']);
  // The file the command itself runs counts; package.json only when the command goes through it.
  assert.deepEqual(checksTouched(['src/a.ts', 'scripts/verify.sh', 'package.json'], 'sh scripts/verify.sh'), ['scripts/verify.sh']);
  assert.deepEqual(checksTouched(['check.js', 'notes.txt'], 'node check.js'), ['check.js']);
  assert.deepEqual(checksTouched(['./check.js'].map((f) => f.replace('./', '')), 'node ./check.js && echo ok'), ['check.js']);
});

test('ordinary work is not: source files, documents, a file that merely has "test" in its name', () => {
  assert.deepEqual(checksTouched(['src/cart.ts', 'docs/testing.md', 'src/latest.ts', 'src/contest/entry.ts', 'attestation.txt'], 'npm test'), []);
  assert.deepEqual(checksTouched([], 'npm test'), []);
  assert.deepEqual(checksTouched(['package.json'], 'make check'), []);
  assert.deepEqual(checksTouched(['check.js', 'scripts/verify.sh', 'src/checkout.js'], 'npm test'), ['check.js', 'scripts/verify.sh'], 'a script named for what it does, behind `npm test`');
  assert.deepEqual(checksTouched(['M src/cart.test.ts', 'A  src/new.ts'], null), ['src/cart.test.ts'], 'status letters in front of a path are read past');
});
