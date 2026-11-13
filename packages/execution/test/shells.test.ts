import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { commandOfShell, elapsedSeconds, isToolShell, parseProcessTable, readProcessTable, toolShells } from '../src/shells.ts';

/**
 * The commands a Claude Code session is running are the shells it started for them. The lines below are how
 * Claude Code 2.1.323 starts one (copied from `ps` on macOS, with the home folder and the snapshot's name changed).
 */
const PRELUDE = `/bin/zsh -c source /Users/someone/.claude/shell-snapshots/snapshot-zsh-1794325136251-abc123.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \\builtin unalias -- 'which'; \\builtin unset -f -- 'which'; } >/dev/null 2>&1 || true`;
const shellOf = (quoted: string) => `${PRELUDE} && eval '${quoted}' < /dev/null && pwd -P >| /tmp/claude-1ad5-cwd`;

test('ps\'s elapsed time, in every form it takes', () => {
  assert.equal(elapsedSeconds('00:07'), 7);
  assert.equal(elapsedSeconds('12:34'), 754);
  assert.equal(elapsedSeconds('01:02:03'), 3723);
  assert.equal(elapsedSeconds('16-08:41:34'), 16 * 86400 + 8 * 3600 + 41 * 60 + 34);
  assert.equal(elapsedSeconds('junk'), 0);
});

test('the command a tool shell runs is read back as it was written — quotes and line breaks too', () => {
  assert.equal(commandOfShell(shellOf('pnpm test')), 'pnpm test');
  // A quote inside the command, written the way Claude Code writes it.
  assert.equal(commandOfShell(shellOf(`echo "it'"'"'s done" && sleep 600`)), `echo "it's done" && sleep 600`);
  assert.equal(commandOfShell(shellOf(`echo '\\''x'\\''`)), `echo 'x'`);
  // macOS's ps writes a line break as \\012.
  assert.equal(commandOfShell(shellOf('cd app\\012npm run build')), 'cd app\nnpm run build');
  // The prelude has quoted words of its own ('which'): they are not the command.
  assert.equal(commandOfShell(PRELUDE), null);
  assert.equal(isToolShell(shellOf('ls')), true);
  // Without a snapshot (the shell's own setup could not be saved) it is still one.
  assert.equal(isToolShell(`/bin/bash -c eval 'make' < /dev/null && pwd -P >| /tmp/claude-9f2e-cwd`), true);
  // Claude Code's other children are not commands: its MCP servers, a hook, the status line.
  for (const other of ['node /opt/orchestrator/mcp.js', `/bin/sh -c '/usr/local/bin/orchestrator-agent hook --event Stop'`, '/bin/sh -c ~/.claude/statusline.sh']) assert.equal(isToolShell(other), false, other);
});

test('the tool shells of one session, oldest first — not another session\'s, and not what a command started', () => {
  const ps = [
    `  100     1 2-00:00:00 tmux new-session -d -s orch-alex`,
    `  200   100   01:00:00 claude --model opus`,
    `  210   200   01:00:00 node /opt/orchestrator/mcp.js`,
    `  220   200      04:10 ${shellOf('pnpm test')}`,
    `  221   220      04:09 node node_modules/.bin/vitest run`,
    `  222   221      04:00 ${shellOf('nested — part of the test run')}`,
    `  230   200      00:03 ${shellOf('git status')}`,
    `  300   100   01:00:00 /bin/sh /tmp/launcher.sh`,
    `  310   300   01:00:00 claude --model sonnet`,
    `  320   310      09:00 ${shellOf('npm run dev')}`,
  ].join('\n');
  const rows = parseProcessTable(ps);
  assert.deepEqual(toolShells(rows, 200), [
    { pid: 220, command: 'pnpm test', seconds: 250 },
    { pid: 230, command: 'git status', seconds: 3 },
  ]);
  // Started through a launcher: found below it all the same.
  assert.deepEqual(toolShells(rows, 300), [{ pid: 320, command: 'npm run dev', seconds: 540 }]);
  assert.deepEqual(toolShells(rows, 999), []);
});

test('on this machine: a shell started like Claude Code starts one is found under its parent while it runs, and is gone after', async () => {
  // A stand-in for Claude Code: a process that starts one tool shell, the way Claude Code does, and waits.
  const parent = spawn(process.execPath, ['-e', `require('node:child_process').spawn('/bin/sh', ['-c', ${JSON.stringify(`true /x/shell-snapshots/snapshot-sh-1.sh && eval 'sleep 3; echo "it'"'"'s"' < /dev/null && pwd -P >| /dev/null`)}], { stdio: 'ignore' }); setTimeout(() => {}, 6000);`], { stdio: 'ignore' });
  try {
    let found: ReturnType<typeof toolShells> = [];
    for (let i = 0; i < 40 && !found.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      found = toolShells(await readProcessTable(), parent.pid!);
    }
    assert.equal(found.length, 1, 'the shell is seen');
    assert.equal(found[0]!.command, `sleep 3; echo "it's"`);
    for (let i = 0; i < 100 && found.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      found = toolShells(await readProcessTable(), parent.pid!);
    }
    assert.deepEqual(found, [], 'and is gone once its command has finished');
  } finally {
    parent.kill();
  }
});
