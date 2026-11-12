/**
 * A session's command is run from a file in its folder, not from tmux's command line. tmux refuses a command longer
 * than about 16 KB ("command too long"), and an employee's instructions — part of Claude Code's command line — grow
 * past that: on the owner's server two employees could not be started on 2026-11-12.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Tmux, LAUNCHER, launcherScript, looksLikeClaude, planClaudeLaunch, shellQuote } from '../src/index.ts';

const SOCK = `orch-launch-${process.pid}`;
const tmux = new Tmux({ socketName: SOCK });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let tmp = '';

async function waitFor<T>(fn: () => T | Promise<T>, ms = 8000, label = 'condition'): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(40);
  }
}

// Instructions as long as a seasoned employee's, with everything a shell would trip over.
const NASTY = `Lessons:\n- don't "fix" $HOME or \`rm -rf\` anything; it's the owner's\n- 100% of \\backslashes\\ and 'single' quotes '\\'' stay as they are\n- čćšđž ČĆŠĐŽ — “quotes” … ✓\n\t$(echo not run) \${NOT_SET:-nor this} !history #comment ; & | > <\n`;
const LONG = `${NASTY.repeat(Math.ceil(40_000 / NASTY.length))}\nthe end, with a blank line after it\n\n`;

const spec = (over: Record<string, unknown>) =>
  ({ displayName: 'Xagio Panel', cwd: tmp, mode: 'interactive_cli', model: null, permissionMode: 'default', permissions: { allow: [], deny: [], ask: [] }, allowedTools: [], disallowedTools: [], appendSystemPrompt: '', mcp: { url: 'http://127.0.0.1:1/mcp', token: 't' }, strictMcp: true, highRiskPatterns: [], claudeSessionId: 's-1', resume: false, env: {}, cols: 100, rows: 30, ...over }) as any;

/** A plan with a stand-in for Claude Code that writes down exactly what it was started with, and stays. */
function plan(name: string, prompt: string) {
  const sessionDir = path.join(tmp, name);
  fs.mkdirSync(sessionDir, { recursive: true });
  const out = path.join(sessionDir, 'started-with');
  const claudeBin = path.join(tmp, 'claude');
  fs.writeFileSync(claudeBin, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\0\' "$a"; done > "$ORCH_TEST_OUT.part"\nprintf \'%s\' "$ORCH_SESSION_ID" > "$ORCH_TEST_OUT.session"\nmv "$ORCH_TEST_OUT.part" "$ORCH_TEST_OUT"\nexec sleep 60\n', { mode: 0o755 });
  const p = planClaudeLaunch({ claudeBin, spec: spec({ appendSystemPrompt: prompt, env: { ORCH_TEST_OUT: out } }), sessionId: `sess-${name}`, sessionDir, hookSocket: path.join(tmp, 'sock'), hookToken: 't', claudeVersion: '2.1.322', approvalWaitSeconds: 60 });
  for (const f of p.files) fs.writeFileSync(f.path, f.content, { mode: 0o600 });
  const startedWith = () => (fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\0').slice(0, -1) : null);
  return { p, out, claudeBin, startedWith, sessionDir };
}

before(async () => {
  await tmux.exec(['kill-server']).catch(() => undefined);
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir().length > 40 ? '/tmp' : os.tmpdir(), 'orch-launch-')));
});
after(async () => {
  await tmux.exec(['kill-server']).catch(() => undefined);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('an argument is read back by the shell exactly as it was', () => {
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  assert.equal(shellQuote(''), `''`);
  assert.equal(shellQuote('a\0b'), `'ab'`, 'a byte no argument can hold is left out');
  assert.match(launcherScript(['/usr/bin/env', 'A=1 2', 'claude', '--x', 'y\nz']), /^#!\/bin\/sh\n(#.*\n)+exec '\/usr\/bin\/env' 'A=1 2' 'claude' '--x' 'y\nz'\n$/);
});

test('an employee with 40 KB of instructions starts, and Claude Code is given every byte of them', async () => {
  const { p, startedWith, claudeBin, sessionDir, out } = plan('long', LONG);
  assert.ok(Buffer.byteLength(p.argv.join(' ')) > 40_000, 'the command is far longer than tmux takes');
  // What the agent does (`HostAgent.launch`): the pane runs `run`, the short command, where there is one.
  const pane = await tmux.newSession({ name: 'long', cwd: tmp, cols: 100, rows: 30, argv: p.run ?? p.argv });
  const got = await waitFor(startedWith, 8000, 'the stand-in to write down what it was started with');
  // Everything after the program itself, in order, byte for byte.
  assert.deepEqual(got, p.argv.slice(p.argv.indexOf(claudeBin) + 1));
  assert.equal(got[got.indexOf('--append-system-prompt') + 1], LONG);
  assert.equal(fs.readFileSync(`${out}.session`, 'utf8'), 'sess-long', 'and the session\'s environment came along');
  // tmux was given a path, not the command.
  assert.deepEqual(p.run, ['/bin/sh', path.join(sessionDir, LAUNCHER)]);
  const started = (await tmux.listPanes()).find((x) => x.paneId === pane.paneId)!;
  assert.ok(started.startCommand.length < 1000, `${started.startCommand.length} characters on tmux's command line`);
  assert.ok(looksLikeClaude({ currentCommand: 'sh', startCommand: started.startCommand, title: '' }), 'the pane is still recognised as Claude Code\'s by how it was started');

  // The same when the process in a kept pane is started again.
  fs.rmSync(out);
  await tmux.respawnPane(pane.paneId, tmp, p.run ?? p.argv);
  assert.equal((await waitFor(startedWith, 8000, 'the stand-in after a restart'))[got.indexOf('--append-system-prompt') + 1], LONG);
});

test('a short command is started the same way: there is one way a session starts', async () => {
  const { p, startedWith, claudeBin } = plan('short', 'Be brief.');
  assert.ok(p.run, 'through the launcher too');
  await tmux.newSession({ name: 'short', cwd: tmp, cols: 100, rows: 30, argv: p.run ?? p.argv });
  assert.deepEqual(await waitFor(startedWith, 8000, 'the stand-in'), p.argv.slice(p.argv.indexOf(claudeBin) + 1));
});

test('the limit is tmux\'s: the same command given to tmux itself is refused before anything runs', async () => {
  const { p, startedWith } = plan('direct', LONG);
  await assert.rejects(tmux.newSession({ name: 'direct', cwd: tmp, cols: 100, rows: 30, argv: p.argv }), /too long/i);
  await sleep(300);
  assert.equal(startedWith(), null);
});
