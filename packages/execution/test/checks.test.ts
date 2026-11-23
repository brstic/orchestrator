import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectChecks } from '../src/checks.ts';

/** What could check a project, read from its repository — tests first, then types, then lint; nothing is run. */
function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checks-'));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  return dir;
}

test("a package's own scripts, with the package manager its lock file names; npm's placeholder test is no test", () => {
  const npm = repo({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', typecheck: 'tsc --noEmit', lint: 'next lint', dev: 'next dev' } }) });
  assert.deepEqual(detectChecks(npm).map((c) => c.command), ['npm run -s typecheck', 'npm run -s lint']);
  const pnpm = repo({ 'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }), 'pnpm-lock.yaml': '' });
  assert.deepEqual(detectChecks(pnpm).map((c) => [c.command, c.kind]), [['pnpm -s test', 'tests']]);
  const yarn = repo({ 'package.json': JSON.stringify({ scripts: { test: 'jest' } }), 'yarn.lock': '' });
  assert.equal(detectChecks(yarn)[0]!.command, 'yarn -s test');
});

test('TypeScript without a script: tsc, when it is installed', () => {
  const ts = repo({ 'package.json': JSON.stringify({ scripts: { dev: 'next dev', lint: 'next lint' } }), 'tsconfig.json': '{}', 'node_modules/.bin/tsc': '' });
  assert.deepEqual(detectChecks(ts).map((c) => c.command), ['npx --no-install tsc --noEmit -p .', 'npm run -s lint']);
  const notInstalled = repo({ 'package.json': '{}', 'tsconfig.json': '{}' });
  assert.deepEqual(detectChecks(notInstalled), []);
});

test('PHP, Python, Go, Rust and a Makefile; a plain folder has nothing', () => {
  assert.equal(detectChecks(repo({ 'composer.json': JSON.stringify({ scripts: { test: 'phpunit' } }) }))[0]!.command, 'composer test');
  assert.equal(detectChecks(repo({ 'vendor/bin/phpunit': '', 'phpunit.xml.dist': '<phpunit/>' }))[0]!.command, 'vendor/bin/phpunit');
  assert.equal(detectChecks(repo({ 'pyproject.toml': '[tool.pytest.ini_options]\n' }))[0]!.command, 'python3 -m pytest -q');
  assert.equal(detectChecks(repo({ 'go.mod': 'module x' }))[0]!.command, 'go test ./...');
  assert.equal(detectChecks(repo({ 'Cargo.toml': '[package]' }))[0]!.command, 'cargo test');
  assert.equal(detectChecks(repo({ Makefile: 'build:\n\tcc x.c\n\ntest:\n\t./run-tests\n' }))[0]!.command, 'make test');
  assert.deepEqual(detectChecks(repo({ 'index.php': '<?php', 'README.md': '# x' })), []);
});
