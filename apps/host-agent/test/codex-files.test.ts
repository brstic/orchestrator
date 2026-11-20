import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workspaceTools } from '../src/codex-files.ts';

/**
 * The file tools a Codex employee works with (`codex-files.ts`): the only way it reaches its folder, so everything it
 * may not touch is refused here — outside the folder, through a link, hidden or key-like names, the office's own
 * files, and what a deny rule takes away.
 */
const here = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-codex-files-')));
const work = path.join(here, 'work');
const office = path.join(work, 'office-home');
const outside = path.join(here, 'outside');
fs.mkdirSync(path.join(work, 'src'), { recursive: true });
fs.mkdirSync(office, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(work, 'README.md'), '# Work\n');
fs.writeFileSync(path.join(work, 'src', 'a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(work, '.env'), 'KEY=x\n');
fs.writeFileSync(path.join(work, 'deploy.key'), 'key\n');
fs.writeFileSync(path.join(work, 'binary.bin'), Buffer.from([1, 0, 2]));
fs.writeFileSync(path.join(work, 'big.txt'), 'x'.repeat(256 * 1024 + 1));
fs.writeFileSync(path.join(office, 'office.db'), 'rows\n');
fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside\n');
fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(work, 'link.txt'));
fs.symlinkSync(outside, path.join(work, 'linkdir'));
fs.linkSync(path.join(outside, 'secret.txt'), path.join(work, 'hard.txt'));
test.after(() => fs.rmSync(here, { recursive: true, force: true }));

const tools = (fileDeny: string[] = []) => workspaceTools({ cwd: work, fileDeny, officeRoots: [office] });
const refused = (fn: () => unknown, why: RegExp) => assert.throws(fn, why);

test('it lists, reads and writes text inside the folder', () => {
  const t = tools();
  assert.deepEqual(t.tools.map((x) => x.name), ['list_files', 'read_file', 'write_file']);
  const listed = t.call('list_files', { path: '.' }).split('\n');
  assert.ok(listed.includes('README.md') && listed.includes('src/'));
  assert.ok(!listed.includes('.env') && !listed.includes('deploy.key'), 'hidden and key-like names are not listed');
  assert.ok(!listed.includes('link.txt') && !listed.includes('linkdir/'), 'links are not listed');
  assert.ok(!listed.includes('office-home/'), "the office's own folder is not listed");
  assert.equal(t.call('read_file', { path: 'src/a.ts' }), 'export const a = 1;\n');
  assert.equal(t.call('write_file', { path: 'src/b.ts', content: 'export const b = 2;\n' }), 'Wrote src/b.ts');
  assert.equal(fs.readFileSync(path.join(work, 'src', 'b.ts'), 'utf8'), 'export const b = 2;\n');
  t.call('write_file', { path: 'README.md', content: '# Changed\n' });
  assert.equal(fs.readFileSync(path.join(work, 'README.md'), 'utf8'), '# Changed\n');
  assert.ok(!fs.readdirSync(work).some((n) => n.startsWith('.orch-codex-')), 'no temporary file is left behind');
});

test('nothing outside the folder: not by a parent, an absolute path, a link or a second name', () => {
  const t = tools();
  refused(() => t.call('read_file', { path: '../outside/secret.txt' }), /outside the accessible/);
  refused(() => t.call('read_file', { path: 'src/../../outside/secret.txt' }), /outside the accessible/);
  refused(() => t.call('read_file', { path: path.join(outside, 'secret.txt') }), /workspace-relative/);
  refused(() => t.call('read_file', { path: 'link.txt' }), /linked/);
  refused(() => t.call('read_file', { path: 'linkdir/secret.txt' }), /linked/);
  refused(() => t.call('write_file', { path: 'linkdir/new.txt', content: 'x' }), /linked/);
  refused(() => t.call('read_file', { path: 'hard.txt' }), /linked/);
  refused(() => t.call('write_file', { path: 'hard.txt', content: 'x' }), /linked/);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'outside\n');
  refused(() => t.call('write_file', { path: 'src\\x.ts', content: 'x' }), /workspace-relative/);
});

test('hidden and key-like names, binary and oversized files are refused', () => {
  const t = tools();
  refused(() => t.call('read_file', { path: '.env' }), /outside the accessible/);
  refused(() => t.call('write_file', { path: '.env', content: 'x' }), /outside the accessible/);
  refused(() => t.call('read_file', { path: 'deploy.key' }), /outside the accessible/);
  refused(() => t.call('read_file', { path: 'binary.bin' }), /text file/);
  refused(() => t.call('read_file', { path: 'big.txt' }), /256 KiB/);
  refused(() => t.call('write_file', { path: 'big2.txt', content: 'x'.repeat(256 * 1024 + 1) }), /256 KiB/);
  refused(() => t.call('write_file', { path: 'missing/dir/x.txt', content: 'x' }), /unavailable/);
});

test("the office's own files stay fenced off, even inside the folder", () => {
  const t = tools();
  refused(() => t.call('read_file', { path: 'office-home/office.db' }), /office/);
  refused(() => t.call('list_files', { path: 'office-home' }), /office/);
  refused(() => t.call('write_file', { path: 'office-home/new.txt', content: 'x' }), /office/);
  assert.ok(!fs.existsSync(path.join(office, 'new.txt')));
  // A folder that is inside the office's own files is no folder to work in at all.
  refused(() => workspaceTools({ cwd: office, officeRoots: [office] }), /office/);
});

test('a deny rule for reading or editing takes that tool away', () => {
  assert.deepEqual(tools(['Edit(src/**)']).tools.map((x) => x.name), ['list_files', 'read_file']);
  assert.deepEqual(tools(['Write']).tools.map((x) => x.name), ['list_files', 'read_file']);
  assert.deepEqual(tools(['Read(./secrets/**)']).tools.map((x) => x.name), ['write_file']);
  assert.deepEqual(tools(['Bash(rm:*)', 'WebFetch']).tools.map((x) => x.name), ['list_files', 'read_file', 'write_file']);
  refused(() => tools(['Edit']).call('write_file', { path: 'x.txt', content: 'x' }), /unavailable/);
});
