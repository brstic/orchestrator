import fs from 'node:fs';
import path from 'node:path';

/**
 * Which commands could check a project's work, read from what its repository has (`docs/TASKS.md`, "The office checks
 * what it can"). On the live office no project had a verification command for two weeks, so nothing was ever tested by
 * the office; the owner did not know which command to give. This reads the repository and offers what it finds —
 * nothing is run here (`verify.run` tries one when asked).
 */
export interface CheckCandidate {
  command: string;
  /** Where it was read from, in words. */
  why: string;
  /** What it checks: the project's own tests, a type check, or a linter. */
  kind: 'tests' | 'types' | 'lint';
}

const read = (file: string): string | null => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
const has = (file: string) => {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
};

/** npm's placeholder for "no tests" is not a test. */
const realScript = (s: unknown) => typeof s === 'string' && s.trim() && !/no test specified/.test(s);

export function detectChecks(root: string): CheckCandidate[] {
  const out: CheckCandidate[] = [];
  const at = (f: string) => path.join(root, f);

  // JavaScript / TypeScript: the package's own scripts, run with the package manager its lock file names.
  const pkgText = read(at('package.json'));
  if (pkgText) {
    let scripts: Record<string, unknown> = {};
    try {
      scripts = (JSON.parse(pkgText) as { scripts?: Record<string, unknown> }).scripts ?? {};
    } catch {
      scripts = {};
    }
    const pm = has(at('pnpm-lock.yaml')) ? 'pnpm' : has(at('yarn.lock')) ? 'yarn' : has(at('bun.lockb')) || has(at('bun.lock')) ? 'bun' : 'npm';
    const run = (name: string) => (pm === 'npm' ? (name === 'test' ? 'npm test --silent' : `npm run -s ${name}`) : pm === 'yarn' ? `yarn -s ${name}` : pm === 'bun' ? `bun run ${name}` : `pnpm -s ${name}`);
    for (const [name, kind] of [
      ['test', 'tests'],
      ['typecheck', 'types'],
      ['type-check', 'types'],
      ['check', 'types'],
      ['lint', 'lint'],
    ] as const) {
      if (realScript(scripts[name])) out.push({ command: run(name), why: `the "${name}" script in package.json`, kind });
    }
    if (!out.some((c) => c.kind === 'types') && has(at('tsconfig.json')) && has(at('node_modules/.bin/tsc'))) {
      out.push({ command: 'npx --no-install tsc --noEmit -p .', why: 'tsconfig.json, and TypeScript installed in node_modules', kind: 'types' });
    }
  }

  // PHP: composer's test script, or PHPUnit with its settings.
  const composerText = read(at('composer.json'));
  if (composerText) {
    try {
      const scripts = (JSON.parse(composerText) as { scripts?: Record<string, unknown> }).scripts ?? {};
      if (scripts.test) out.push({ command: 'composer test', why: 'the "test" script in composer.json', kind: 'tests' });
    } catch {
      // not JSON: nothing to read from it
    }
  }
  if (!out.some((c) => c.command === 'composer test') && has(at('vendor/bin/phpunit')) && (has(at('phpunit.xml')) || has(at('phpunit.xml.dist')))) {
    out.push({ command: 'vendor/bin/phpunit', why: 'PHPUnit installed, with phpunit.xml', kind: 'tests' });
  }

  // Python: pytest's settings, or a tests folder beside a project file.
  const pyproject = read(at('pyproject.toml'));
  if (has(at('pytest.ini')) || /\[tool\.pytest/.test(pyproject ?? '') || ((pyproject || has(at('setup.py'))) && (has(at('tests')) || has(at('test'))))) {
    out.push({ command: 'python3 -m pytest -q', why: 'pytest settings or a tests folder', kind: 'tests' });
  }

  // Go, Rust, and a Makefile's own test target.
  if (has(at('go.mod'))) out.push({ command: 'go test ./...', why: 'go.mod', kind: 'tests' });
  if (has(at('Cargo.toml'))) out.push({ command: 'cargo test', why: 'Cargo.toml', kind: 'tests' });
  const make = read(at('Makefile'));
  if (make && /^test\s*:/m.test(make)) out.push({ command: 'make test', why: 'a "test" target in the Makefile', kind: 'tests' });

  // Tests first, then types, then lint; each command once.
  const order = { tests: 0, types: 1, lint: 2 };
  const seen = new Set<string>();
  return out.sort((a, b) => order[a.kind] - order[b.kind]).filter((c) => !seen.has(c.command) && seen.add(c.command));
}
