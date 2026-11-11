#!/usr/bin/env node
/**
 * check:changed — the fast loop for a single change.
 *
 * Runs only what the change touches, in this order:
 *   1. typecheck (the whole `tsc -p tsconfig.json`, only when a typechecked .ts changed)
 *   2. the unit tests *beside* the change — the `test/` folder of each workspace a
 *      changed file belongs to (`packages/<x>` or `apps/<x>`), plus any changed test file
 *   3. changed end-to-end tests under `tests/e2e`, only the files that changed
 *
 * This is a quicker gate than `pnpm test:all`; it is not a replacement for it. It runs the
 * tests of the packages you changed, not of the packages that depend on them, and the root
 * typecheck is whole-project (TypeScript's project graph cannot type a subset reliably). Run
 * the full suites before shipping. The repo has no linter, so there is no lint step.
 *
 * What counts as changed: the working tree by default — staged, unstaged and untracked files.
 * Pass `--base <ref>` to also include everything committed since <ref> (merge-base), e.g.
 * `node scripts/check-changed.mjs --base origin/main` for a whole branch.
 *
 * Flags: --base <ref>, --no-typecheck, --no-e2e, --dry (print the plan and stop), -h/--help.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- arguments -------------------------------------------------------------
const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log(
    [
      'Usage: node scripts/check-changed.mjs [--base <ref>] [--no-typecheck] [--no-e2e] [--dry]',
      '',
      '  --base <ref>    also treat everything committed since <ref> (merge-base) as changed',
      '  --no-typecheck  skip the typecheck step',
      '  --no-e2e        skip changed end-to-end tests',
      '  --dry           print what would run and stop',
    ].join('\n'),
  );
  process.exit(0);
}
const opt = {
  base: readValue('--base'),
  typecheck: !argv.includes('--no-typecheck'),
  e2e: !argv.includes('--no-e2e'),
  dry: argv.includes('--dry'),
};
function readValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// ---- what changed ----------------------------------------------------------
/** Lines of `git`, trimmed, empties dropped. Returns [] when git fails (e.g. not a repo). */
function git(args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

const changed = new Set();
for (const f of git(['diff', '--name-only'])) changed.add(f); // unstaged
for (const f of git(['diff', '--name-only', '--cached'])) changed.add(f); // staged
for (const f of git(['ls-files', '--others', '--exclude-standard'])) changed.add(f); // untracked
if (opt.base) {
  // merge-base so a branch is measured against where it left the base, not the base's tip
  const mb = git(['merge-base', opt.base, 'HEAD'])[0] || opt.base;
  for (const f of git(['diff', '--name-only', `${mb}...HEAD`])) changed.add(f);
}

const files = [...changed].filter((f) => !f.startsWith('node_modules/') && !f.includes('/dist/'));
if (files.length === 0) {
  console.log('check:changed — nothing changed. Nothing to run.');
  process.exit(0);
}

// ---- map changes to what to run --------------------------------------------
/** `packages/orchestration/src/x.ts` -> `packages/orchestration`; null when outside a workspace. */
function workspaceOf(file) {
  const m = /^(packages|apps)\/([^/]+)\//.exec(file);
  return m ? `${m[1]}/${m[2]}` : null;
}

const TS = /\.(ts|tsx|mts|cts)$/;
const anyTsChanged = files.some((f) => TS.test(f));

// Unit tests to run: every test file in the `test/` folder of each touched workspace,
// plus any changed file that is itself a unit test.
const unitTests = new Set();
const workspaces = new Set();
for (const f of files) {
  const ws = workspaceOf(f);
  if (ws) workspaces.add(ws);
  if (/\/test\/.*\.test\.ts$/.test(f) && !f.startsWith('tests/')) unitTests.add(f);
}
for (const ws of workspaces) {
  const dir = path.join(root, ws, 'test');
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.test.ts')) unitTests.add(path.posix.join(ws, 'test', name));
  }
}

// Changed end-to-end tests (only the files that changed; e2e is whole-system and slow).
const e2eTests = files.filter((f) => /^tests\/e2e\/.*\.test\.ts$/.test(f));

// ---- plan ------------------------------------------------------------------
const willTypecheck = opt.typecheck && anyTsChanged;
const unitList = [...unitTests].sort();
const e2eList = opt.e2e ? e2eTests.sort() : [];

console.log(`check:changed — ${files.length} changed file(s), ${workspaces.size} workspace(s) touched`);
if (workspaces.size) console.log(`  workspaces: ${[...workspaces].sort().join(', ')}`);
console.log(`  typecheck:  ${willTypecheck ? 'yes' : anyTsChanged ? 'skipped (--no-typecheck)' : 'no TS changed'}`);
console.log(`  unit tests: ${unitList.length ? unitList.join(', ') : 'none beside the change'}`);
console.log(`  e2e tests:  ${e2eList.length ? e2eList.join(', ') : opt.e2e ? 'none changed' : 'skipped (--no-e2e)'}`);

if (opt.dry) process.exit(0);
if (!willTypecheck && unitList.length === 0 && e2eList.length === 0) {
  console.log('\nNothing to check for these changes (no TS, no tests beside them).');
  process.exit(0);
}

// ---- run -------------------------------------------------------------------
/** Run a step; stream its output; return true on success. */
function run(title, cmd, args) {
  console.log(`\n── ${title} ──`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  return r.status === 0;
}

const failures = [];
if (willTypecheck) {
  if (!run('typecheck', 'pnpm', ['exec', 'tsc', '-p', 'tsconfig.json', '--noEmit'])) failures.push('typecheck');
}
if (unitList.length) {
  if (!run(`unit tests (${unitList.length})`, process.execPath, ['--test', '--test-concurrency=1', ...unitList]))
    failures.push('unit tests');
}
if (e2eList.length) {
  if (!run(`e2e tests (${e2eList.length})`, process.execPath, ['--test', '--test-concurrency=1', ...e2eList]))
    failures.push('e2e tests');
}

console.log('');
if (failures.length) {
  console.log(`check:changed — FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('check:changed — passed. (Run `pnpm test:all` before shipping; this checks only what you changed.)');
