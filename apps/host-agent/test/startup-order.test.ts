import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostAgent } from '../src/agent.ts';
import { defaultConfig } from '../src/config.ts';

/**
 * A hook that was in flight while the agent was being restarted comes again the instant the agent's socket is open.
 * It must find the agent already waiting for the office ("a request for a decision waits") — otherwise it is let
 * through at once: a permission request falls to the terminal, a held command is refused for nothing.
 */
test('the agent is already holding requests for the office when its socket opens', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir().length > 40 ? '/tmp' : os.tmpdir(), 'orch-agent-'));
  // An office that is not there: the agent starts, opens its socket, and keeps trying to connect.
  const cfg = { ...defaultConfig(), serverUrl: 'http://127.0.0.1:9', hostId: 'h1', credential: 'x', name: 'test', allowedRoots: [home], tmuxSocketName: `orch-order-${process.pid}`, linkGraceSeconds: 30 };
  const agent = new HostAgent(cfg, home, () => undefined);
  const inner = agent as unknown as { linkGrace: unknown; startHookServer: () => Promise<void>; reconcile: () => Promise<void> };
  const seen: Record<string, boolean> = {};
  const open = inner.startHookServer.bind(agent);
  inner.startHookServer = async () => {
    seen.atSocket = !!inner.linkGrace;
    return open();
  };
  const reconcile = inner.reconcile.bind(agent);
  inner.reconcile = async () => {
    seen.whileLookingAtSessions = !!inner.linkGrace;
    return reconcile();
  };
  await agent.start();
  try {
    assert.deepEqual(seen, { atSocket: true, whileLookingAtSessions: true });
    assert.equal(agent.isConnected, false);
    assert.ok(inner.linkGrace, 'and it still is, until the office answers or the wait runs out');
  } finally {
    await agent.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
  assert.equal(inner.linkGrace, null, 'stopping ends the wait');
});
