/**
 * TEST FIXTURE — NOT A PRODUCT FEATURE, AND NOT THE CLAUDE AGENT SDK.
 *
 * A deterministic stand-in for `@anthropic-ai/claude-agent-sdk` used only by
 * the automated tests of the SDK-managed worker runtime. It implements the
 * part of the SDK's `query()` contract the runner relies on, with no model:
 *
 *   • streaming input (an async iterable of user messages)
 *   • the hook callbacks, called with real hook payloads
 *   • permission rules, permission modes and the canUseTool callback
 *   • interrupt()
 *   • assistant / tool_result / result messages, with a running cost
 *
 * It really edits files, runs commands and calls the Orchestrator MCP server.
 * What it "does" is scripted by the same directives the fake-claude fixture
 * understands:  @@fake: write a.txt hello; commit add a; complete done@@
 *
 * Nothing in the application ever loads this file; tests point the agent's
 * `sdkPath` at it explicitly.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function query({ prompt, options }) {
  const cwd = options.cwd ?? process.cwd();
  const sessionId = options.resume ?? options.sessionId ?? 'fake-sdk-session';
  const permissionMode = options.permissionMode ?? 'default';
  const transcriptPath = path.join(cwd, '..', `fake-sdk-transcript-${sessionId}.jsonl`);
  const mcp = options.mcpServers?.orchestrator ?? null;
  const rules = options.settings?.permissions ?? {};
  const allowRules = [...(options.allowedTools ?? []), ...(rules.allow ?? [])];
  const denyRules = [...(options.disallowedTools ?? []), ...(rules.deny ?? [])];
  const askRules = rules.ask ?? [];
  if (!options.pathToClaudeCodeExecutable || !fs.existsSync(options.pathToClaudeCodeExecutable)) throw new Error('fake SDK: pathToClaudeCodeExecutable does not exist');

  let interrupted = false;
  let abort = new AbortController();
  let cost = 0;
  let turns = 0;
  let toolSeq = 0;
  let rpcId = 0;
  /** Messages produced by the current turn, handed to the consumer in order. */
  const outbox = [];
  const emit = (m) => outbox.push({ ...m, session_id: sessionId });

  const transcript = (rec) => fs.appendFileSync(transcriptPath, JSON.stringify(rec) + '\n');

  async function hook(event, extra = {}) {
    const input = { session_id: sessionId, transcript_path: transcriptPath, cwd, permission_mode: permissionMode, hook_event_name: event, ...extra };
    let result = null;
    for (const matcher of options.hooks?.[event] ?? []) {
      for (const cb of matcher.hooks ?? []) {
        const out = await cb(input, extra.tool_use_id, { signal: abort.signal });
        if (out && Object.keys(out).length && !result) result = out;
      }
    }
    return result;
  }

  function ruleMatches(rule, tool, input) {
    if (rule === tool) return true;
    if (tool.startsWith('mcp__') && tool.startsWith(rule + '__')) return true;
    const m = /^Bash\((.+?)(:\*)?\)$/.exec(rule);
    if (!m || tool !== 'Bash') return false;
    const cmd = String(input.command ?? '');
    return cmd === m[1] || cmd.startsWith(m[1] + ' ') || (!!m[2] && cmd.startsWith(m[1]));
  }

  function verdictFor(tool, input) {
    if (denyRules.some((r) => ruleMatches(r, tool, input))) return 'deny';
    if (askRules.some((r) => ruleMatches(r, tool, input))) return 'ask';
    if (allowRules.some((r) => ruleMatches(r, tool, input))) return 'allow';
    if (tool === 'Read' || tool === 'AskUserQuestion') return 'allow';
    if (permissionMode === 'auto') return 'allow';
    if (tool === 'Write' || tool === 'Edit') return permissionMode === 'acceptEdits' ? 'allow' : 'ask';
    return 'ask';
  }

  /** One tool call with the lifecycle the real SDK runs: PreToolUse → rules → canUseTool → run → PostToolUse[Failure]. */
  async function useTool(tool, input, run) {
    const id = `toolu_fakesdk_${++toolSeq}`;
    emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] } });
    const result = (content, isError = false) => emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
    const pre = await hook('PreToolUse', { tool_name: tool, tool_input: input, tool_use_id: id });
    const decision = pre?.hookSpecificOutput?.permissionDecision;
    if (pre?.hookSpecificOutput?.updatedInput) input = pre.hookSpecificOutput.updatedInput;
    if (decision === 'deny') {
      result(`denied by hook: ${pre.hookSpecificOutput.permissionDecisionReason ?? ''}`, true);
      return { denied: true };
    }
    let verdict = verdictFor(tool, input);
    if (decision === 'ask') verdict = 'ask';
    if (decision === 'allow') verdict = 'allow';
    if (verdict === 'deny') {
      result('denied by permission rules', true);
      return { denied: true };
    }
    if (verdict === 'ask') {
      const answer = await options.canUseTool(tool, input, { signal: abort.signal, suggestions: [], toolUseID: id });
      if (answer?.behavior !== 'allow') {
        result(`denied: ${answer?.message ?? ''}`, true);
        return { denied: true, message: answer?.message };
      }
      if (answer.updatedInput) input = answer.updatedInput;
    }
    const started = Date.now();
    try {
      const response = await run(input);
      await hook('PostToolUse', { tool_name: tool, tool_input: input, tool_response: response ?? {}, tool_use_id: id, duration_ms: Date.now() - started });
      result(typeof response?.content === 'string' ? response.content : JSON.stringify(response ?? {}));
      return { response };
    } catch (e) {
      await hook('PostToolUseFailure', { tool_name: tool, tool_input: input, error: String(e.message), is_interrupt: false, tool_use_id: id, duration_ms: Date.now() - started });
      result(String(e.message).split('\n')[0], true);
      return { failed: true };
    }
  }

  const bash = (command) =>
    useTool('Bash', { command, description: 'scripted by test' }, (input) => {
      const env = { ...process.env, GIT_AUTHOR_NAME: 'Fake SDK', GIT_AUTHOR_EMAIL: 'fake@example.test', GIT_COMMITTER_NAME: 'Fake SDK', GIT_COMMITTER_EMAIL: 'fake@example.test' };
      return { content: execSync(input.command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }) };
    });

  async function orchestrator(tool, args) {
    let text = '';
    await useTool(`mcp__orchestrator__${tool}`, args, async () => {
      if (!mcp) throw new Error('no orchestrator MCP server configured');
      const res = await fetch(mcp.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(mcp.headers ?? {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args } }) });
      if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(body.error.message);
      text = body.result.content.map((c) => c.text).join('\n');
      return { content: text };
    });
    return text;
  }

  async function runDirectives(text) {
    let last = 'Understood.';
    for (const [, block] of text.matchAll(/@@fake:([\s\S]*?)@@/g)) {
      for (const raw of block.split(';')) {
        const step = raw.trim();
        if (!step) continue;
        if (interrupted) return 'Interrupted by user';
        const [verb, ...parts] = step.split(/\s+/);
        const rest = step.slice(verb.length).trim();
        if (verb === 'say') last = rest;
        else if (verb === 'sleep') {
          const end = Date.now() + (Number(rest) || 100);
          while (Date.now() < end && !interrupted) await sleep(25);
        } else if (verb === 'read') await useTool('Read', { file_path: path.join(cwd, rest) }, (i) => ({ content: fs.existsSync(i.file_path) ? fs.readFileSync(i.file_path, 'utf8') : '' }));
        else if (verb === 'write') {
          const content = rest.slice(parts[0].length).trim().replace(/\\n/g, '\n');
          await useTool('Write', { file_path: path.join(cwd, parts[0]), content }, (i) => {
            fs.mkdirSync(path.dirname(i.file_path), { recursive: true });
            fs.writeFileSync(i.file_path, i.content + '\n');
            return { content: `wrote ${i.file_path}` };
          });
        } else if (verb === 'bash') await bash(rest);
        else if (verb === 'commit') await bash(`git add -A && git commit -q -m ${JSON.stringify(rest || 'work')}`);
        else if (verb === 'mcp') await orchestrator(parts[0], rest.slice(parts[0].length).trim() ? JSON.parse(rest.slice(parts[0].length).trim()) : {});
        else if (verb === 'ask') last = await orchestrator('ask_boss', { question: rest, context: 'asked by the test fixture', why: 'the scripted task needs it', options: [{ label: 'Option A' }, { label: 'Option B' }] });
        else if (verb === 'askuser') {
          const [question, ...opts] = rest.split('|').map((s) => s.trim());
          const r = await useTool('AskUserQuestion', { questions: [{ question, header: 'Choice', options: opts.map((label) => ({ label, description: `choose ${label}` })), multiSelect: false }] }, (i) => ({ content: JSON.stringify(i.answers ?? {}), answers: i.answers ?? {} }));
          last = r.denied ? `not answered: ${r.message ?? ''}` : `answered: ${JSON.stringify(r.response?.answers ?? {})}`;
        } else if (verb === 'complete') last = await orchestrator('complete_task', { summary: rest || 'scripted completion', tests_run: 'npm test (scripted)' });
        else last = `(fake SDK: unknown directive "${verb}")`;
      }
    }
    return last;
  }

  async function turn(text) {
    const started = Date.now();
    interrupted = false;
    abort = new AbortController();
    turns++;
    transcript({ type: 'user', message: { role: 'user', content: text } });
    await hook('UserPromptSubmit', { prompt: text });
    let last = await runDirectives(text);
    for (let depth = 0; depth < 6; depth++) {
      emit({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: last }] } });
      transcript({ type: 'assistant', message: { id: `msg_fakesdk_${turns}_${depth}`, role: 'assistant', content: [{ type: 'text', text: last }], usage: { input_tokens: 200, output_tokens: 60, cache_read_input_tokens: 2000, cache_creation_input_tokens: 20 } } });
      cost += 0.0123;
      if (interrupted) break;
      const stop = await hook('Stop', { stop_hook_active: depth > 0, last_assistant_message: last });
      if (stop?.decision !== 'block' || !stop.reason) break;
      last = await runDirectives(stop.reason);
    }
    emit({ type: 'result', subtype: interrupted ? 'error_during_execution' : 'success', is_error: false, result: last, num_turns: turns, total_cost_usd: cost, duration_ms: Date.now() - started, usage: {} });
  }

  async function* run() {
    yield { type: 'system', subtype: 'init', session_id: sessionId, model: options.model ?? 'fake-model', claude_code_version: 'fake-sdk', tools: ['Read', 'Write', 'Bash'], mcp_servers: mcp ? [{ name: 'orchestrator', status: 'connected' }] : [], permissionMode };
    for await (const message of prompt) {
      const content = message.message?.content;
      const working = turn(typeof content === 'string' ? content : JSON.stringify(content));
      // Hand messages over while the turn is still running, like a real stream.
      let done = false;
      void working.finally(() => (done = true));
      while (!done || outbox.length) {
        if (outbox.length) yield outbox.shift();
        else await sleep(15);
      }
      await working;
    }
  }

  const q = run();
  q.interrupt = async () => {
    interrupted = true;
    abort.abort();
  };
  q.initializationResult = async () => ({ commands: [], models: [] });
  q.setPermissionMode = async () => undefined;
  return q;
}
