#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

if (process.argv.includes('--version')) {
  console.log('codex-cli 0.136.0');
  process.exit(0);
}
assert.equal(process.argv[2], 'app-server');
const config = Object.fromEntries(process.argv.flatMap((arg, i, argv) => arg === '-c' ? [argv[i + 1].split(/=(.*)/s, 2)] : []));
assert.equal(config['features.shell_tool'], 'false');
assert.equal(config['features.hooks'], 'false');

const endpoint = JSON.parse(config['mcp_servers.orchestrator.url']);
const mcpToken = process.env[JSON.parse(config['mcp_servers.orchestrator.bearer_token_env_var'])];
const input = readline.createInterface({ input: process.stdin });
const send = (response) => console.log(JSON.stringify({ jsonrpc: '2.0', ...response }));
const reply = (id, result) => send({ id, result });
const event = (method, params) => send({ method, params });

async function tool(name, args) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mcpToken}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).result;
}

for await (const line of input) {
  const { id, method, params } = JSON.parse(line);
  switch (method) {
    case 'initialize':
      reply(id, {});
      break;
    case 'thread/start':
    case 'thread/resume':
      assert.equal(params.approvalPolicy, 'never');
      assert.equal(params.sandbox, 'workspace-write');
      reply(id, { thread: { id: params.threadId ?? randomUUID() }, approvalPolicy: 'never', cwd: params.cwd, sandbox: { type: 'workspaceWrite', networkAccess: false, writableRoots: [], excludeTmpdirEnvVar: true, excludeSlashTmp: true }, model: 'fake-codex' });
      break;
    case 'turn/start': {
      const { threadId } = params;
      const turnId = randomUUID();
      const prompt = params.input[0].text;
      const turn = { id: turnId, status: 'inProgress' };
      if (prompt.includes('reject this test turn')) {
        send({ id, error: { code: -32000, message: 'Test turn rejected' } });
        break;
      }
      reply(id, { turn });
      event('turn/started', { threadId, turn });
      const status = await tool('report_status', { status: 'working', detail: 'Called from fake Codex' });
      assert.equal(status.isError, false, JSON.stringify(status));
      const forbidden = await tool('attach_file', { path: 'README.md' });
      assert.equal(forbidden.isError, true);
      assert.match(forbidden.content[0].text, /cannot access host files/);
      const review = /Review request .*?review (\S+) "/.exec(prompt);
      if (review) {
        const result = await tool('submit_review', { task: review[1], verdict: 'approve', comments: 'Reviewed the supplied material.' });
        assert.equal(result.isError, false, JSON.stringify(result));
      }
      event('item/completed', { threadId, turnId, item: { type: 'agentMessage', text: 'Codex reached the office tools.' } });
      event('turn/completed', { threadId, turn: { ...turn, status: 'completed' } });
      break;
    }
  }
}
