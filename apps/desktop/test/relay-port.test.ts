import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

/**
 * The relay on a member's computer (electron/personal-host.cjs) is the address every session there is given for the
 * office's tools, and Claude Code keeps that address for as long as the session lives. So when the app starts again
 * the relay has to come back on the port it had — or every session that was running loses the office for good.
 */
const require = createRequire(import.meta.url);
const { startRelay } = require('../electron/personal-host.cjs') as { startRelay: (address: string, fingerprint: string | null, preferredPort?: number) => Promise<{ port: number; close: () => void }> };

const closed = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('the relay comes back on the port it had, so sessions started before keep their address', async () => {
  const first = await startRelay('https://office.example.test', null);
  const port = first.port;
  first.close();
  await closed();
  const again = await startRelay('https://office.example.test', null, port);
  assert.equal(again.port, port);
  again.close();
  await closed();
});

test('when something else has taken that port, the relay still starts — on another one', async () => {
  const squatter = http.createServer();
  await new Promise<void>((r) => squatter.listen(0, '127.0.0.1', r));
  const taken = (squatter.address() as { port: number }).port;
  const relay = await startRelay('https://office.example.test', null, taken);
  assert.notEqual(relay.port, taken);
  assert.ok(relay.port > 0);
  relay.close();
  squatter.close();
});

test('a remembered port that is not a usable one is ignored', async () => {
  for (const bad of [0, 80, 70000, Number.NaN, 1.5]) {
    const relay = await startRelay('https://office.example.test', null, bad);
    assert.ok(relay.port > 1023, String(bad));
    relay.close();
  }
});

/**
 * Seen on the live office: on a member's computer every `ask_boss` (and every comment that asks and waits) failed after
 * exactly 60 seconds with "this computer could not reach the office: the office did not answer" — the relay gave up on
 * an answer the office was still waiting for (up to four minutes), and the employee, told it had failed, asked again.
 * The relay waits for the office's tools at least as long as Claude Code itself does (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`).
 */
test('the relay waits for the office\'s tools as long as the longest of them waits, and as long as Claude Code does', async () => {
  const { MCP_WAIT_MS } = require('../electron/personal-host.cjs') as { MCP_WAIT_MS: number };
  const { DEFAULT_TIMINGS } = await import('../../../packages/orchestration/src/core.ts');
  const longest = Math.max(DEFAULT_TIMINGS.askBossWaitMs, DEFAULT_TIMINGS.colleagueWaitMs);
  const claudeCode = Math.max(600_000, longest * 2); // as registry.ts gives every session
  assert.ok(MCP_WAIT_MS >= claudeCode, `the relay waits ${MCP_WAIT_MS} ms, a tool may take ${claudeCode} ms`);
});
