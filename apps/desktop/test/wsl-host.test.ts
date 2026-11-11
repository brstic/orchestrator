import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/**
 * The Windows side of a member's own computer (electron/wsl-host.cjs). What needs Windows and WSL — starting
 * `wsl.exe` — is not run here; what is run is everything it sends into WSL: the script that writes the host's
 * files, finds Node.js and hands the rest of its input to the host. bash is the same on every machine the suite runs on.
 */
const require = createRequire(import.meta.url);
const { toWslPath, windowsRoots, bootstrap } = require('../electron/wsl-host.cjs') as { toWslPath: (p: string) => string | null; windowsRoots: () => string[]; bootstrap: (files: Record<string, string>) => string };

test('Windows folders as WSL sees them', () => {
  assert.equal(toWslPath('D:\\Work'), '/mnt/d/Work');
  assert.equal(toWslPath('C:\\Users\\Mila\\'), '/mnt/c/Users/Mila');
  assert.equal(toWslPath('c:/code/my app'), '/mnt/c/code/my app');
  assert.equal(toWslPath('E:\\'), '/mnt/e');
  assert.equal(toWslPath('/home/mila/code'), '/home/mila/code', 'a WSL path is kept');
  assert.equal(toWslPath('\\\\server\\share'), null, 'a network share has no place under /mnt');
  assert.equal(toWslPath('relative\\folder'), null);
  assert.equal(toWslPath(''), null);
});

test('folders named in ORCH_PERSONAL_ROOTS are added to the profile folder, once each', () => {
  const before = process.env.ORCH_PERSONAL_ROOTS;
  process.env.ORCH_PERSONAL_ROOTS = 'D:\\Work; /srv/code ;D:\\Work;not a path';
  try {
    const roots = windowsRoots();
    assert.deepEqual(roots.slice(-2), ['/mnt/d/Work', '/srv/code']);
    assert.equal(new Set(roots).size, roots.length);
  } finally {
    if (before === undefined) delete process.env.ORCH_PERSONAL_ROOTS;
    else process.env.ORCH_PERSONAL_ROOTS = before;
  }
});

const hasBash = spawnSync('bash', ['-c', 'true']).status === 0;
/** bash by its full path: one test runs it with a PATH that has almost nothing on it. */
const bashPath = hasBash ? spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim() : 'bash';

test('the script writes the files as they are, finds a Node.js that is new enough, and the host reads what follows on the same input', { skip: !hasBash }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wslhost-'));
  try {
    // Text that would break a careless here-document or a quoted command line.
    const tricky = ['const a = `${process.env.HOME}` + "$(whoami)" + \'single\';', 'EOF', 'ORCH_EOF_', '\\n \\\\ $HOME `date`', '#!/bin/bash', ''].join('\n');
    const files = {
      'personal-host.cjs': tricky,
      'orchestrator-agent.mjs': 'export const windows = "line one\r\nline two";\r\n',
      // Stands in for the host: says which Node.js runs it and repeats the one line it is given.
      'personal-host-cli.cjs': "require('node:readline').createInterface({ input: process.stdin }).once('line', (l) => { console.log(JSON.stringify({ node: process.versions.node, cwd: process.cwd(), line: l })); process.exit(0); });\n",
    };
    const said = { address: 'https://office.example.com', token: 'orch_guest_"quoted" $HOME', fingerprint: 'AA:BB' };
    const child = spawn('bash', ['-s'], { env: { ...process.env, HOME: home, ORCH_NODE: process.execPath }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.stdin.write(bootstrap(files));
    child.stdin.write(`${JSON.stringify(said)}\n`);
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 0, err);
    const dir = path.join(home, '.orchestrator', 'desktop-host');
    assert.equal(fs.readFileSync(path.join(dir, 'personal-host.cjs'), 'utf8'), tricky);
    assert.equal(fs.readFileSync(path.join(dir, 'orchestrator-agent.mjs'), 'utf8'), 'export const windows = "line one\nline two";\n', 'Windows line ends are not carried into WSL');
    if (process.platform !== 'win32') assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'the folder is the person\'s alone');
    const reply = JSON.parse(out.trim().split('\n').pop()!);
    assert.equal(reply.node, process.versions.node);
    assert.equal(fs.realpathSync(reply.cwd), fs.realpathSync(home), 'the host starts in the home folder');
    assert.deepEqual(JSON.parse(reply.line), said, 'the office and the token arrive on the input, untouched');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('without a Node.js that is new enough the host says so in words, and nothing else runs', { skip: !hasBash }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wslhost-'));
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  // An old Node.js on PATH (as a distribution ships it), and the tools the script itself uses.
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  for (const tool of ['mkdir', 'chmod', 'cat', 'dirname', 'printf']) {
    const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found.startsWith('/')) fs.symlinkSync(found, path.join(bin, tool));
  }
  try {
    const child = spawn(bashPath, ['-s'], { env: { HOME: home, PATH: bin }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stdin.write(bootstrap({ 'personal-host-cli.cjs': 'process.exit(7)\n' }));
    child.stdin.end('{}\n');
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.equal(code, 0);
    const state = JSON.parse(out.trim().split('\n').pop()!);
    assert.equal(state.state, 'unavailable');
    assert.match(state.reason, /Node\.js 22\.18/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
