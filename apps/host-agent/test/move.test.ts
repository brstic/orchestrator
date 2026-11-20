import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeProjectDir, drop, fetchBack, moveList, pack, readPiece, unpack, writePiece, PIECE } from '../src/move.ts';
import type { MoveFile } from '@orchestrator/contracts';

/**
 * The machine's half of moving an employee (`move.ts`): what is packed on one machine arrives whole on the other —
 * their folder without what an install makes again, their project as a repository with every branch, their
 * conversation where that machine's Claude Code looks for it, with the old paths made the new ones.
 */
const here = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-move-')));
const a = { home: path.join(here, 'a-agent'), claude: path.join(here, 'a-claude'), work: path.join(here, 'a-work') };
const b = { home: path.join(here, 'b-agent'), claude: path.join(here, 'b-claude'), work: path.join(here, 'b-work') };
for (const m of [a, b]) for (const d of Object.values(m)) fs.mkdirSync(d, { recursive: true });
test.after(() => fs.rmSync(here, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** What the office does between the two: every piece read on one machine, written on the other. */
function send(files: MoveFile[], moveId: string) {
  for (const f of files) {
    let offset = 0;
    do {
      const piece = readPiece(a.home, { moveId, file: f.name, offset, length: PIECE });
      writePiece(b.home, { moveId, file: f.name, offset, dataBase64: piece.dataBase64 });
      offset += Buffer.from(piece.dataBase64, 'base64').length;
    } while (offset < f.size);
  }
}

test('a folder moves whole, without what an install or a build makes again', async () => {
  const src = path.join(a.work, 'shop');
  write(path.join(src, 'README.md'), '# Shop\n');
  write(path.join(src, 'CLAUDE.md'), 'Run the tests first.\n');
  write(path.join(src, '.env'), 'KEY=1\n');
  write(path.join(src, 'src', 'index.ts'), 'export {};\n');
  write(path.join(src, 'node_modules', 'x', 'index.js'), 'big\n');
  write(path.join(src, 'dist', 'out.js'), 'built\n');
  write(path.join(src, 'build', 'notes.md'), 'not ignored: theirs\n');
  write(path.join(src, '.gitignore'), 'dist/\n');
  fs.symlinkSync('README.md', path.join(src, 'link.md'));
  git(here, 'init', '-q', src);
  git(src, 'add', '-A');
  git(src, 'commit', '-qm', 'one');

  const listed = await moveList(src);
  assert.deepEqual(listed.skipped.sort(), ['dist', 'node_modules']);

  // Their conversation, as Claude Code keeps it on this machine.
  const sid = '11111111-2222-3333-4444-555555555555';
  const convo = claudeProjectDir(a.claude, src);
  write(path.join(convo, `${sid}.jsonl`), `${JSON.stringify({ cwd: src, message: `edit ${src}/src/index.ts` })}\n`);
  write(path.join(convo, 'memory', 'MEMORY.md'), '- the shop uses pnpm\n');
  write(path.join(convo, 'someone-else.jsonl'), 'not theirs\n');

  const packed = await pack(a.home, { moveId: 'move-one', kind: 'folder', path: src, claude: { configDir: null, cwd: src, sessionIds: [sid] } }, a.claude);
  assert.deepEqual(packed.files.map((f) => f.name), ['folder.tgz', 'claude.tgz']);
  assert.equal(packed.claudeFiles, 2);
  send(packed.files, 'move-one');
  const got = await unpack(b.home, { moveId: 'move-one', files: packed.files, kind: 'folder', parent: b.work, name: 'shop', claude: { configDir: null, rel: '', rewrite: [{ from: src, to: '<dest>' }] } }, b.claude);

  assert.equal(got.path, path.join(b.work, 'shop'));
  for (const f of ['README.md', 'CLAUDE.md', '.env', 'src/index.ts', 'build/notes.md', '.gitignore']) assert.ok(fs.existsSync(path.join(got.path, f)), f);
  assert.ok(!fs.existsSync(path.join(got.path, 'node_modules')) && !fs.existsSync(path.join(got.path, 'dist')));
  assert.equal(fs.readlinkSync(path.join(got.path, 'link.md')), 'README.md');
  assert.equal(git(got.path, 'log', '--format=%s'), 'one', 'its git history came along');
  const there = claudeProjectDir(b.claude, got.path);
  const line = JSON.parse(fs.readFileSync(path.join(there, `${sid}.jsonl`), 'utf8'));
  assert.equal(line.cwd, got.path, 'the old folder is the new one in the conversation');
  assert.equal(line.message, `edit ${got.path}/src/index.ts`);
  assert.equal(fs.readFileSync(path.join(there, 'memory', 'MEMORY.md'), 'utf8'), '- the shop uses pnpm\n');
  assert.ok(!fs.existsSync(path.join(there, 'someone-else.jsonl')), "nobody else's conversation goes along");
  assert.ok(fs.existsSync(src), 'the old folder stays where it was');

  // The same name again: a folder of its own beside it, never over it.
  const again = await unpack(b.home, { moveId: 'move-one', files: packed.files, kind: 'folder', parent: b.work, name: 'shop', claude: null }, b.claude);
  assert.equal(again.path, path.join(b.work, 'shop-2'));
  drop(a.home, 'move-one');
  drop(b.home, 'move-one');
  assert.ok(!fs.existsSync(path.join(a.home, 'moves', 'move-one')));
});

test('a project others work in goes as its repository, every branch, theirs checked out; back, their branches land beside the others', async () => {
  const repo = path.join(a.work, 'platform');
  git(here, 'init', '-q', '-b', 'main', repo);
  write(path.join(repo, 'README.md'), '# Platform\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'checkout', '-qb', 'orch/ana/home');
  write(path.join(repo, 'ana.md'), 'Ana was here\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'ana');
  git(repo, 'checkout', '-q', 'main');
  write(path.join(repo, 'someone-uncommitted.txt'), 'not in the bundle\n');

  const packed = await pack(a.home, { moveId: 'move-two', kind: 'bundle', path: repo, claude: null }, a.claude);
  assert.deepEqual(packed.files.map((f) => f.name), ['repo.bundle']);
  send(packed.files, 'move-two');
  const got = await unpack(b.home, { moveId: 'move-two', files: packed.files, kind: 'bundle', parent: b.work, name: 'platform', branch: 'orch/ana/home', claude: null }, b.claude);
  assert.equal(git(got.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'orch/ana/home');
  assert.deepEqual(git(got.path, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').sort(), ['main', 'orch/ana/home']);
  assert.ok(fs.existsSync(path.join(got.path, 'ana.md')) && !fs.existsSync(path.join(got.path, 'someone-uncommitted.txt')));
  assert.equal(git(got.path, 'remote'), '', 'no remote pointing at a file that is gone');

  // Ana works on the copy, then is moved back: her branches come back into the project, nothing of it overwritten.
  write(path.join(got.path, 'ana.md'), 'Ana was here, and back\n');
  git(got.path, 'commit', '-qam', 'more');
  const mainBefore = git(repo, 'rev-parse', 'main');
  const back = await pack(b.home, { moveId: 'move-three', kind: 'bundle', path: got.path, claude: null }, b.claude);
  for (const f of back.files) {
    let offset = 0;
    do {
      const piece = readPiece(b.home, { moveId: 'move-three', file: f.name, offset, length: PIECE });
      writePiece(a.home, { moveId: 'move-three', file: f.name, offset, dataBase64: piece.dataBase64 });
      offset += Buffer.from(piece.dataBase64, 'base64').length;
    } while (offset < f.size);
  }
  const fetched = await fetchBack(a.home, { moveId: 'move-three', files: back.files, repo, prefix: 'moved/ana' }, a.claude);
  assert.deepEqual(fetched.branches.sort(), ['moved/ana/main', 'moved/ana/orch/ana/home']);
  assert.equal(git(repo, 'rev-parse', 'main'), mainBefore, "the project's own branches are not touched");
  assert.equal(git(repo, 'show', 'moved/ana/orch/ana/home:ana.md'), 'Ana was here, and back');
});

test('a piece out of order, a damaged file or a name that is not a move is refused', async () => {
  assert.throws(() => writePiece(b.home, { moveId: 'move-four', file: 'folder.tgz', offset: 10, dataBase64: 'AA==' }), /does not follow/);
  assert.throws(() => writePiece(b.home, { moveId: 'move-four', file: '../../etc/passwd' as any, offset: 0, dataBase64: 'AA==' }), /not a file of a move/);
  assert.throws(() => readPiece(a.home, { moveId: '../x', file: 'folder.tgz', offset: 0, length: 1 }), /not a move/);
  writePiece(b.home, { moveId: 'move-four', file: 'folder.tgz', offset: 0, dataBase64: Buffer.from('broken').toString('base64') });
  await assert.rejects(unpack(b.home, { moveId: 'move-four', files: [{ name: 'folder.tgz', size: 6, sha256: '0'.repeat(64) }], kind: 'folder', parent: b.work, name: 'never', claude: null }, b.claude), /did not arrive whole/);
  assert.ok(!fs.existsSync(path.join(b.work, 'never')));
});
