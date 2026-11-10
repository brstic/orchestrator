import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORCHESTRATOR_TOOLS, describeTool, handleMcpPost, interpretHook, isTestCommand, type McpServerOptions } from '../src/index.ts';

const ctx: { employeeName: string; debugging: boolean; taskKind: string | null; activeSubagents: number } = { employeeName: 'Alex', debugging: false, taskKind: null, activeSubagents: 0 };

test('hook payloads map to activity states', () => {
  const act = (payload: any, c = ctx) => interpretHook(payload, c).activity?.state ?? null;
  assert.equal(act({ hook_event_name: 'SessionStart', source: 'startup' }), 'idle');
  assert.equal(act({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), 'thinking');
  assert.equal(act({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/r/a.ts' } }), 'reading');
  assert.equal(act({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/a.ts' } }), 'coding');
  assert.equal(act({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} }, { ...ctx, debugging: true }), 'debugging');
  assert.equal(act({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test -- --watch=false' } }), 'testing');
  assert.equal(act({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' } }), 'running_command');
  assert.equal(act({ hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_input: { query: 'x' } }), 'researching');
  assert.equal(act({ hook_event_name: 'PreToolUse', tool_name: 'Task', tool_input: {} }), 'delegating');
  assert.equal(act({ hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: {} }), 'planning');
  assert.equal(act({ hook_event_name: 'PreToolUse', tool_name: 'Grep', tool_input: { pattern: 'x' } }, { ...ctx, taskKind: 'review' }), 'reviewing');
  assert.equal(act({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: {} }), 'waiting_answer');
  assert.equal(act({ hook_event_name: 'PreToolUse', tool_name: 'mcp__orchestrator__ask_boss', tool_input: {} }), 'waiting_answer');
  assert.equal(act({ hook_event_name: 'PreToolUse', tool_name: 'mcp__orchestrator__report_progress', tool_input: {} }), null, 'reporting is not a change of activity');
  assert.equal(act({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm x' } }), 'needs_approval');
  assert.equal(act({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs permission' }), 'needs_approval');
  assert.equal(act({ hook_event_name: 'Notification', notification_type: 'idle_prompt' }), 'waiting_input');
  assert.equal(act({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }), 'offline');
  assert.equal(act({ hook_event_name: 'SessionEnd', reason: 'clear' }), null, '/clear does not end the process');
  assert.equal(act({ hook_event_name: 'Stop' }), null, 'the orchestrator decides what a finished turn means');
  assert.equal(act({ hook_event_name: 'SomethingNew' }), null, 'unknown hooks never invent a state');
});

test('hook interpretation extracts facts and keeps secrets out', () => {
  const edit = interpretHook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/repo/src/AuthController.php' }, cwd: '/repo' }, ctx);
  assert.equal(edit.fileModified, 'src/AuthController.php');
  assert.equal(edit.events[0]!.summary, 'Alex modified src/AuthController.php');
  const failed = interpretHook({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npx vitest run' }, error: 'exit 1' }, ctx);
  assert.equal(failed.testOutcome, 'failed');
  const passed = interpretHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'pytest -q' }, tool_response: { stdout: 'ok' } }, ctx);
  assert.equal(passed.testOutcome, 'passed');
  const prompt = interpretHook({ hook_event_name: 'UserPromptSubmit', prompt: '[ORCH:TASK:t-1] do it with API_KEY=abcdef123456' }, ctx);
  assert.deepEqual(prompt.markers, [{ kind: 'TASK', id: 't-1' }]);
  assert.ok(!JSON.stringify(prompt.events).includes('abcdef123456'));
  const write = interpretHook({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/repo/.env', content: 'SECRET=verysecretvalue' }, cwd: '/repo' }, ctx);
  assert.ok(!JSON.stringify(write.events).includes('verysecretvalue'), 'file contents are never stored in events');
  assert.equal(describeTool('Bash', { command: 'export TOKEN=abcdefgh12345 && deploy' }), '$ export TOKEN=[REDACTED] && deploy');
  assert.ok(isTestCommand('cd app && php artisan test'));
  assert.ok(isTestCommand('node --test'));
  assert.ok(!isTestCommand('cat testdata.txt'));
});

test('the MCP server speaks the protocol and validates arguments', async () => {
  const calls: any[] = [];
  const opts: McpServerOptions<{ who: string }> = {
    name: 'orchestrator',
    version: '0.1.0',
    instructions: 'x',
    tools: ORCHESTRATOR_TOOLS,
    handlers: {
      report_status: async (args, c) => {
        calls.push([args, c]);
        return 'ok';
      },
      ask_boss: async () => {
        throw new Error('boom');
      },
      complete_task: async () => ({ text: 'verification failed', isError: true }),
    },
  };
  const c = { who: 'alex' };
  const init: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, opts, c);
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal((await handleMcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, opts, c)).status, 202);
  const list: any = await handleMcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, opts, c);
  const names = list.body.result.tools.map((t: any) => t.name);
  for (const n of ['report_status', 'request_help', 'ask_boss', 'get_current_task', 'get_project_context', 'report_progress', 'report_blocker', 'submit_result', 'request_review', 'send_message', 'request_collaboration', 'get_available_tasks', 'complete_task', 'record_lesson', 'get_playbook']) assert.ok(names.includes(n), `tool ${n}`);
  assert.ok(list.body.result.tools.every((t: any) => t.inputSchema.type === 'object' && t.description.length > 10));
  const ok: any = await handleMcpPost({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'report_status', arguments: { status: 'working' } } }, opts, c);
  assert.deepEqual(ok.body.result, { content: [{ type: 'text', text: 'ok' }], isError: false });
  assert.deepEqual(calls[0], [{ status: 'working' }, c]);
  const missing: any = await handleMcpPost({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'report_status', arguments: {} } }, opts, c);
  assert.equal(missing.body.result.isError, true);
  assert.match(missing.body.result.content[0].text, /missing required argument "status"/);
  const wrongType: any = await handleMcpPost({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'report_status', arguments: { status: 5 } } }, opts, c);
  assert.match(wrongType.body.result.content[0].text, /must be a string/);
  const thrown: any = await handleMcpPost({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'ask_boss', arguments: { question: 'q' } } }, opts, c);
  assert.deepEqual(thrown.body.result, { content: [{ type: 'text', text: 'Error: boom' }], isError: true });
  const toolError: any = await handleMcpPost({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'complete_task', arguments: { summary: 's' } } }, opts, c);
  assert.equal(toolError.body.result.isError, true);
  const unknown: any = await handleMcpPost({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope', arguments: {} } }, opts, c);
  assert.equal(unknown.body.error.code, -32602);
  assert.equal(((await handleMcpPost({ jsonrpc: '2.0', id: 9, method: 'weird/method' }, opts, c)) as any).body.error.code, -32601);
  const batch: any = await handleMcpPost([{ jsonrpc: '2.0', id: 10, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/cancelled' }], opts, c);
  assert.equal(batch.body.length, 1);
  assert.equal((await handleMcpPost('garbage', opts, c)).status, 400);
});

test('quoted text is not mistaken for a test run', () => {
  assert.ok(!isTestCommand('git add -A && git commit -m "Add greet(); verified with npm test"'));
  assert.ok(!isTestCommand("echo 'run pytest later'"));
  assert.ok(isTestCommand('git add -A && npm test'));
});
