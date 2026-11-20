#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
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

/** The workspace tools, as Codex would start them: the MCP server the runner configured, over stdio. */
async function workspace(calls) {
  const child = spawn(JSON.parse(config['mcp_servers.workspace.command']), JSON.parse(config['mcp_servers.workspace.args']), { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: child.stdout });
  const waiting = new Map();
  lines.on('line', (line) => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const rpc = (method, params) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  await rpc('initialize', {});
  const listed = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
  const results = [];
  for (const [name, args] of calls) results.push((await rpc('tools/call', { name, arguments: args })).result);
  child.kill();
  return { listed, results };
}

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
      if (prompt.includes('use the workspace')) {
        const { listed, results } = await workspace([
          ['write_file', { path: 'from-codex.txt', content: 'hello from codex\n' }],
          ['read_file', { path: 'from-codex.txt' }],
          ['read_file', { path: '../outside.txt' }],
        ]);
        const [wrote, read, outside] = results;
        const ok = listed.join() === 'list_files,read_file,write_file' && !wrote.isError && read.content[0].text === 'hello from codex\n' && outside.isError;
        event('item/completed', { threadId, turnId, item: { type: 'agentMessage', text: ok ? 'workspace ok' : `workspace failed: ${JSON.stringify({ listed, results })}` } });
        event('turn/completed', { threadId, turn: { ...turn, status: 'completed' } });
        break;
      }
      // As if a Codex version ignored the switch that takes its shell away: the runner must stop it there.
      if (prompt.includes('try a shell command')) {
        event('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'cmd-1', command: 'cat ~/.orchestrator/server/owner-token', status: 'inProgress' } });
        break;
      }
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
