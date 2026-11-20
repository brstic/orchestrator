import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlClient, Tmux } from '../src/tmux.ts';

/**
 * A tmux control client whose tmux has stopped reading (its session just ended — put to sleep, stopped, moved) must
 * not take the machine's agent down with it: on the live office (2026-11-20) a command written to it then failed
 * with EPIPE, nobody listened for that, and the agent — and with it the whole office on that server — exited.
 */
test('a command to a control client whose tmux stopped reading is refused, and nothing crashes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-epipe-'));
  const fake = path.join(dir, 'tmux');
  // Attached at once (a %begin/%end block), then its input is closed while it lives on for a moment — as a tmux
  // whose session has just ended.
  fs.writeFileSync(fake, '#!/bin/sh\nprintf "%%begin 1 1 0\\n%%end 1 1 0\\n"\nexec 0<&-\nsleep 2\n', { mode: 0o755 });
  const crashed: unknown[] = [];
  const onCrash = (e: unknown) => crashed.push(e);
  process.on('uncaughtException', onCrash);
  try {
    const client = new ControlClient(new Tmux({ bin: fake }), 'gone');
    await client.start();
    await new Promise((r) => setTimeout(r, 200));
    // Big enough to need more than the pipe's buffer: the write fails rather than being kept.
    const big = `display-message ${'x'.repeat(200_000)}`;
    const results = await Promise.allSettled([client.command(big), client.command('list-panes')]);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(crashed, [], 'nothing was left unhandled');
    assert.ok(results.every((r) => r.status === 'rejected'), 'the commands were refused');
    assert.equal(client.alive, false);
    await assert.rejects(client.command('list-panes'), /not running/);
  } finally {
    process.off('uncaughtException', onCrash);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
