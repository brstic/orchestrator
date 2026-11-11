#!/usr/bin/env node
/**
 * TEST FIXTURE — NOT A PRODUCT FEATURE.
 *
 * A deterministic stand-in for the `claude` CLI used only by the automated
 * tests. It behaves like an interactive Claude Code session at the protocol
 * level so the real host agent, hooks, MCP server and orchestration engine can
 * be exercised end to end without spending tokens:
 *
 *   • reads the same flags (--settings, --mcp-config, --session-id, --resume, --permission-mode)
 *   • executes the configured hook commands with real hook JSON on stdin
 *   • runs the configured status line command after each answer
 *   • calls the real Orchestrator MCP endpoint over HTTP
 *   • really edits files, runs commands and commits in its working directory
 *
 * What it "does" is scripted by directives embedded in the prompt it receives:
 *   @@fake: write a.txt hello; commit add a; complete done@@
 * (`mcp <tool> <json>` calls any Orchestrator tool; `result <file>` then writes what that call returned into a
 * file, so a test can see what a tool call that was held open came back with, and that work went on after it.)
 *
 * Nothing in the application ever launches this file; tests point the agent's
 * `claudeBin` at it explicitly.
 */
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('2.1.321 (Claude Code)');
  process.exit(0);
}
if (argv.includes('--help')) {
  // The two options the office reads from the real CLI's help.
  console.log('Usage: claude [options] [command] [prompt]\n\nOptions:\n  --effort <level>                      Effort level for the current session\n                                        (low, medium, high, xhigh, max)\n  --model <model>                       Model for the current session.');
  process.exit(0);
}
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}
// A way for tests to see what happens when the CLI refuses to start (it prints why and exits 1).
if (flag('--model') === 'crash-on-start') {
  console.log('Simulated startup failure: this build of the CLI cannot start here.');
  process.exit(1);
}
const settingsPath = flag('--settings');
const mcpPath = flag('--mcp-config');
const resumeId = flag('--resume');
const sessionId = resumeId ?? flag('--session-id') ?? 'fake-session';
const permissionMode = flag('--permission-mode') ?? 'default';
const settings = settingsPath ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
const mcp = mcpPath ? JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers?.orchestrator : null;
const cwd = process.cwd();
const transcriptPath = path.join(path.dirname(settingsPath ?? cwd), 'fake-transcript.jsonl');

const out = (s) => process.stdout.write(s);
const say = (s) => out(`${s}\r\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function transcript(rec) {
  try {
    fs.appendFileSync(transcriptPath, JSON.stringify(rec) + '\n');
  } catch {
    /* ignore */
  }
}

/** Run the hook commands configured for an event, exactly as Claude Code would. */
function fireHook(event, extra = {}) {
  const entries = settings.hooks?.[event] ?? [];
  const payload = { session_id: sessionId, transcript_path: transcriptPath, cwd, permission_mode: permissionMode, hook_event_name: event, ...extra };
  const runs = [];
  for (const entry of entries) {
    for (const h of entry.hooks ?? []) {
      if (h.type !== 'command') continue;
      runs.push(
        new Promise((resolve) => {
          const child = spawn('/bin/sh', ['-c', h.command], { stdio: ['pipe', 'pipe', 'ignore'], env: process.env });
          let stdout = '';
          child.stdout.on('data', (d) => (stdout += d));
          child.on('close', () => {
            try {
              resolve(stdout.trim() ? JSON.parse(stdout) : null);
            } catch {
              resolve(null);
            }
          });
          child.on('error', () => resolve(null));
          child.stdin.end(JSON.stringify(payload));
          currentHook = child;
        }),
      );
    }
  }
  return Promise.all(runs).then((results) => results.find((r) => r) ?? null);
}
let currentHook = null;

/**
 * Run the configured status line command after an answer, as Claude Code does, with the session's
 * state on stdin. A "subscription account" exists for the fixture when the Claude config folder it
 * was started with holds a `fake-limits.json` (the `rate_limits` object Claude Code would send).
 */
function statusLine() {
  const cmd = settings.statusLine?.type === 'command' ? settings.statusLine.command : null;
  if (!cmd) return Promise.resolve();
  let rate_limits;
  try {
    rate_limits = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME ?? '/nonexistent', 'fake-limits.json'), 'utf8'));
  } catch {
    rate_limits = undefined; // an API-key account: Claude Code sends no limits
  }
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', cmd], { stdio: ['pipe', 'ignore', 'ignore'], env: process.env });
    child.on('close', resolve);
    child.on('error', resolve);
    child.stdin.end(JSON.stringify({ session_id: sessionId, transcript_path: transcriptPath, cwd, model: { id: 'fake', display_name: 'Fake' }, workspace: { current_dir: cwd }, ...(rate_limits ? { rate_limits } : {}) }));
  });
}
let stepCount = 0;

let rpcId = 0;
async function mcpCall(tool, args) {
  if (!mcp) return { text: 'no orchestrator MCP server configured', isError: true };
  const res = await fetch(mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(mcp.headers ?? {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  if (!res.ok) return { text: `MCP HTTP ${res.status}`, isError: true };
  const body = await res.json();
  if (body.error) return { text: body.error.message, isError: true };
  return { text: body.result.content.map((c) => c.text).join('\n'), isError: body.result.isError === true };
}

function allowed(tool, input) {
  const rules = settings.permissions?.allow ?? [];
  const denied = settings.permissions?.deny ?? [];
  if (denied.includes(tool)) return 'deny';
  if (tool.startsWith('mcp__orchestrator')) return 'allow';
  // "auto" is Claude Code's own classifier deciding; the fixture stands in for it by letting tools through.
  if (permissionMode === 'auto') return 'allow';
  // Bypass mode: Claude Code checks and asks nothing (deny rules, above, still hold).
  if (permissionMode === 'bypassPermissions') return 'allow';
  if (tool === 'Write' || tool === 'Edit') return permissionMode === 'acceptEdits' || rules.includes(tool) ? 'allow' : 'ask';
  if (tool === 'Bash') {
    const cmd = String(input.command ?? '');
    for (const r of rules) {
      const m = /^Bash\((.+?)(:\*)?\)$/.exec(r);
      if (m && (cmd === m[1] || cmd.startsWith(m[1] + ' ') || (m[2] && cmd.startsWith(m[1])))) return 'allow';
    }
    return 'ask';
  }
  return 'allow';
}

let toolSeq = 0;
/** One tool call with the full hook lifecycle: PreToolUse → (PermissionRequest) → run → PostToolUse[Failure]. */
async function useTool(tool, input, run) {
  const tool_use_id = `toolu_fake_${++toolSeq}`;
  say(`\x1b[36m⏺ ${tool}\x1b[0m ${JSON.stringify(input).slice(0, 110)}`);
  const pre = await fireHook('PreToolUse', { tool_name: tool, tool_input: input, tool_use_id });
  const preDecision = pre?.hookSpecificOutput?.permissionDecision;
  if (pre?.hookSpecificOutput?.updatedInput) input = pre.hookSpecificOutput.updatedInput;
  if (preDecision === 'deny') {
    say(`  ⎿ denied by hook: ${pre.hookSpecificOutput.permissionDecisionReason ?? ''}`);
    await fireHook('PermissionDenied', { tool_name: tool, tool_input: input });
    return { denied: true };
  }
  let verdict = allowed(tool, input);
  if (preDecision === 'ask') verdict = 'ask';
  if (preDecision === 'allow') verdict = 'allow';
  if (verdict === 'deny') {
    say(`  ⎿ denied by permission rules`);
    await fireHook('PermissionDenied', { tool_name: tool, tool_input: input });
    return { denied: true };
  }
  if (verdict === 'ask') {
    const res = await fireHook('PermissionRequest', { tool_name: tool, tool_input: input, permission_suggestions: [] });
    const behavior = res?.hookSpecificOutput?.decision?.behavior;
    if (behavior === 'deny') {
      say(`  ⎿ denied: ${res.hookSpecificOutput.decision.message ?? ''}`);
      await fireHook('PermissionDenied', { tool_name: tool, tool_input: input });
      return { denied: true };
    }
    if (behavior !== 'allow') {
      // No structured decision: fall back to a prompt in the terminal, like the real CLI.
      void fireHook('Notification', { notification_type: 'permission_prompt', message: `Claude needs your permission to use ${tool}` });
      // Laid out like the real dialog: what it is about in a box, the question, the options one under another.
      const about = String(input.command ?? input.file_path ?? tool).split('\n')[0].slice(0, 160);
      say(` ${tool === 'Bash' ? 'Bash command' : tool}`);
      say(` │ ${about}`);
      say(` \x1b[33mDo you want to proceed?\x1b[0m`);
      say(` ❯ 1. Yes`);
      say(`   2. No`);
      say(` Esc to cancel · Tab to amend`);
      dialogOpen = true;
      let key = await nextKey();
      let moved = false;
      if (key === '\x1b') {
        // An arrow (ESC [ B) moves the choice to "No" and the Enter after it confirms that; an Escape on its own cancels.
        moved = true;
        const next = await Promise.race([nextKey(), sleep(150).then(() => null)]);
        if (next === '[' || next === 'O') {
          await nextKey();
          key = await nextKey();
        } else keyWaiter = null;
      }
      dialogOpen = false;
      keyQueue.length = 0;
      // The dialog goes away once it is answered, as the real one does.
      out('\x1b[6A\x1b[J');
      if (moved || (key !== '1' && key !== 'y' && key !== '\r')) {
        say('  ⎿ rejected in terminal');
        await fireHook('PermissionDenied', { tool_name: tool, tool_input: input });
        return { denied: true };
      }
    }
  }
  const started = Date.now();
  try {
    const response = await run(input);
    await fireHook('PostToolUse', { tool_name: tool, tool_input: input, tool_response: response ?? {}, tool_use_id, duration_ms: Date.now() - started });
    return { response };
  } catch (e) {
    say(`  ⎿ \x1b[31mfailed\x1b[0m ${String(e.message).split('\n')[0]}`);
    await fireHook('PostToolUseFailure', { tool_name: tool, tool_input: input, error: String(e.message), is_interrupt: false, duration_ms: Date.now() - started });
    return { failed: true, error: e };
  }
}

function bash(command) {
  return useTool('Bash', { command, description: 'scripted by test' }, (input) => {
    const stdout = execSync(input.command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 'Fake Claude', GIT_AUTHOR_EMAIL: 'fake@example.test', GIT_COMMITTER_NAME: 'Fake Claude', GIT_COMMITTER_EMAIL: 'fake@example.test' } });
    if (stdout.trim()) say('  ⎿ ' + stdout.trim().split('\n').slice(-3).join('\r\n    '));
    return { stdout, stderr: '', interrupted: false };
  });
}

/** What the last Orchestrator tool call returned (or how it failed). */
let lastResult = { text: '', isError: false };

async function orchestrator(tool, args) {
  let result = { text: '', isError: false };
  lastResult = { text: '(the call did not come back)', isError: true };
  await useTool(`mcp__orchestrator__${tool}`, args, async () => {
    result = lastResult = await mcpCall(tool, args);
    say(`  ⎿ ${result.isError ? '\x1b[31m' : ''}${result.text.split('\n').join('\r\n    ')}\x1b[0m`);
    return { content: result.text, is_error: result.isError };
  });
  return result;
}

/** The turn in hand ended with an API error (the `limit` step): no Stop hook follows it. */
let turnFailed = false;

/** Execute the scripted steps found in a prompt. */
async function runDirectives(text) {
  turnFailed = false;
  // A re-delivered task (review feedback, merge conflict) can script a different second attempt.
  const retry = /Feedback to address from the previous attempt/.test(text) ? [...text.matchAll(/@@fake-retry:([\s\S]*?)@@/g)].map((m) => m[1]) : [];
  const blocks = retry.length ? retry : [...text.matchAll(/@@fake:([\s\S]*?)@@/g)].map((m) => m[1]);
  let lastMessage = 'Done.';
  for (const block of blocks) {
    for (const raw of block.split(';')) {
      const step = raw.trim();
      if (!step) continue;
      const [verb, ...restParts] = step.split(/\s+/);
      const rest = step.slice(verb.length).trim();
      if (interrupted) {
        say('\x1b[33m⎿ Interrupted\x1b[0m');
        return 'Interrupted by user';
      }
      switch (verb) {
        case 'say':
          say(rest);
          lastMessage = rest;
          break;
        case 'saw':
          // Was this text in the prompt that was delivered? (What a test asks about a prompt's content.)
          say(`saw[${rest}]=${text.replace(/@@[\s\S]*?@@/g, '').includes(rest) ? 'yes' : 'no'}`);
          break;
        case 'sleep':
          await sleep(Number(rest) || 100);
          break;
        case 'read':
          await useTool('Read', { file_path: path.join(cwd, rest) }, () => ({ content: fs.existsSync(path.join(cwd, rest)) ? fs.readFileSync(path.join(cwd, rest), 'utf8') : '' }));
          break;
        case 'write': {
          const file = restParts[0];
          const content = rest.slice(file.length).trim().replace(/\\n/g, '\n');
          await useTool('Write', { file_path: path.join(cwd, file), content }, (input) => {
            fs.mkdirSync(path.dirname(input.file_path), { recursive: true });
            fs.writeFileSync(input.file_path, input.content + '\n');
            return { type: 'create', filePath: input.file_path };
          });
          break;
        }
        case 'bash':
          await bash(rest);
          break;
        case 'commit':
          await bash(`git add -A && git commit -q -m ${JSON.stringify(rest || 'work')}`);
          break;
        case 'step': {
          // Claude Code's own task list: a step is planned, then finished.
          const id = `step-${++stepCount}`;
          await fireHook('TaskCreated', { task_id: id, task_subject: rest });
          say(`☐ ${rest}`);
          await fireHook('TaskCompleted', { task_id: id, task_subject: rest });
          say(`☒ ${rest}`);
          break;
        }
        case 'denied':
          // Claude Code itself refuses an action (a deny rule, or auto mode's safety check).
          say(`\x1b[31m⎿ Denied: ${rest}\x1b[0m`);
          await fireHook('PermissionDenied', { tool_name: 'Bash', tool_input: { command: rest }, reason: 'blocked by a deny rule' });
          break;
        case 'mcp': {
          const tool = restParts[0];
          const json = rest.slice(tool.length).trim();
          await orchestrator(tool, json ? JSON.parse(json) : {});
          break;
        }
        case 'result':
          // What the last Orchestrator tool call returned, into a file in the working directory.
          fs.writeFileSync(path.join(cwd, rest), `${lastResult.isError ? 'ERROR ' : ''}${lastResult.text}\n`);
          say(`result → ${rest}`);
          break;
        case 'progress':
          await orchestrator('report_progress', { note: rest, percent: 50 });
          break;
        case 'ask': {
          const res = await orchestrator('ask_boss', { question: rest, context: 'asked by the test fixture', why: 'the scripted task needs it', options: [{ label: 'Option A' }, { label: 'Option B' }] });
          lastMessage = res.text;
          break;
        }
        case 'askuser': {
          const [question, ...opts] = rest.split('|').map((s) => s.trim());
          const input = { questions: [{ question, header: 'Choice', options: opts.map((label) => ({ label, description: `choose ${label}` })), multiSelect: false }] };
          const r = await useTool('AskUserQuestion', input, (finalInput) => {
            const answer = finalInput.answers?.[question];
            say(`  ⎿ answer: ${answer ?? '(none supplied by hook)'}`);
            return { answers: finalInput.answers ?? {} };
          });
          lastMessage = `answered: ${JSON.stringify(r.response?.answers ?? {})}`;
          break;
        }
        case 'block':
          await orchestrator('report_blocker', { reason: rest });
          break;
        case 'cutoff':
          // Claude Code has given up the connection to the office: its tools fail without ever reaching it.
          say('\x1b[31m⎿ MCP server "orchestrator" is not connected\x1b[0m');
          await fireHook('PostToolUseFailure', { tool_name: `mcp__orchestrator__${rest || 'get_current_task'}`, tool_input: {}, tool_use_id: `toolu_fake_${Date.now()}`, error: 'MCP server "orchestrator" is not connected' });
          break;
        case 'limit':
          // Claude refuses the turn for the account's limit: the turn ends with StopFailure, not Stop.
          turnFailed = true;
          say("\x1b[31mYou've hit your limit\x1b[0m");
          await fireHook('StopFailure', { error: rest || 'rate_limit', error_details: '429 usage limit reached' });
          return "You've hit your limit";
        case 'complete': {
          const res = await orchestrator('complete_task', { summary: rest || 'scripted completion', tests_run: 'npm test (scripted)' });
          lastMessage = res.text;
          break;
        }
        case 'complete-nocode': {
          const res = await orchestrator('complete_task', { summary: rest || 'no code changes needed', no_code_changes: true });
          lastMessage = res.text;
          break;
        }
        default:
          say(`(fake-claude: unknown directive "${verb}")`);
      }
    }
  }
  return lastMessage;
}

/** Sensible scripted reactions to Orchestrator's own prompts when no directive is embedded. */
async function defaultBehaviour(text) {
  const meeting = /meeting id ([0-9a-f-]+)/i.exec(text)?.[1];
  const who = process.env.ORCH_EMPLOYEE ?? 'employee';
  if (/\[ORCH:MEETING:/.test(text) && meeting) {
    if (/Round 1/.test(text)) await orchestrator('meeting_contribute', { meeting_id: meeting, body: `Proposal from ${who}: keep the module boundary at the HTTP layer and cover it with tests.` });
    else if (/Round 2/.test(text)) await orchestrator('meeting_contribute', { meeting_id: meeting, body: `Response from ${who}: broadly agree.`, disagreements: [`${who} prefers smaller pull requests than proposed`] });
    else if (/facilitator/i.test(text))
      await orchestrator('meeting_conclude', {
        meeting_id: meeting,
        decision_doc: '## Decision\nAdopt the HTTP boundary.\n\n## Rationale\nAll participants agreed on the boundary.',
        tasks: [{ title: 'Document the HTTP boundary', description: 'Write the decision into docs/architecture.md', acceptance: 'File exists', kind: 'docs', role: 'docs' }],
      });
    return 'Meeting contribution submitted.';
  }
  if (/\[ORCH:REPORT:/.test(text)) {
    await orchestrator('report_status', { status: `${who} is idle and ready` });
    await orchestrator('submit_result', { title: `Status report from ${who}`, content: 'Nothing in progress.', kind: 'report' });
    return 'Report submitted.';
  }
  if (/\[ORCH:RETRO:/.test(text)) {
    // Reflect on the facts Orchestrator recorded, the way the retrospective prompt asks.
    // A lesson has a rule, a trigger, the evidence and a scope; the evidence is quoted from the facts in the prompt.
    const fact = (kind) => new RegExp(`^- \\[${kind}\\] (.*(?:\\n {4}.*)*)`, 'm').exec(text)?.[1] ?? '';
    const lastLine = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
    const replaces = /replaces="([0-9a-f]+)"/.exec(text)?.[1];
    if (replaces && /Anything to change\?/.test(text))
      // The earlier lesson was in the prompt and did not prevent a repeat: sharpen it.
      await orchestrator('record_lesson', { lesson: "Run the project's verification command and read its whole output before calling complete_task", applies_when: 'before calling complete_task on a task with a verification command', why: `The same verification failure happened again with the earlier lesson in place: "${lastLine(fact('verification'))}"`, scope: 'self', replaces });
    else if (/Verification \(.*\) failed/.test(text)) await orchestrator('record_lesson', { lesson: "Run the project's verification command myself before calling complete_task", applies_when: 'before completing any task', why: `Verification failed on this task before it passed, with "${lastLine(fact('verification'))}"`, scope: 'self' });
    else if (/review requested changes/i.test(text)) await orchestrator('record_lesson', { lesson: 'Remove draft markers and re-read my own diff before asking for review', applies_when: 'before a task goes to review', why: 'The reviewer sent this task back because a draft marker was still in the file', scope: 'project' });
    else if (/conflicted/.test(text)) await orchestrator('record_lesson', { lesson: 'Merge the integration branch into my task branch before finishing work on shared files', applies_when: 'when touching files other people also change', why: 'Merging my branch conflicted because a teammate changed the same file first', scope: 'self' });
    else await orchestrator('record_lesson', { none: true, reason: 'Nothing in the recorded facts would be prevented by a rule' });
    return 'Retrospective done.';
  }
  if (/\[ORCH:ROUND:/.test(text)) {
    // A foreman's round: look at the office, then deal with each item of the digest the way the prompt asks.
    // A question marked [escalate] stands for "a matter of direction": it goes to the owner instead of being answered.
    await orchestrator('office_overview', {});
    const now = text.split('Already seen in earlier rounds')[0];
    let handled = 0;
    for (const m of now.matchAll(/^\d+\. QUESTION (\S+) from (.+?) \([^)]*\): "(.*)" — waiting/gm)) {
      await orchestrator('look_at', { employee: m[2] });
      if (/\[escalate\]/.test(m[3])) await orchestrator('escalate_to_owner', { summary: `${m[2]} needs a decision that is yours`, detail: `${who} did not answer this: it is a matter of direction.`, question_id: m[1] });
      else await orchestrator('answer_question', { question_id: m[1], answer: 'Go with the simplest option that meets the task, and note it in your summary.' });
      handled++;
    }
    // Someone who stopped and is doing nothing: go and look, and tell them to carry on.
    for (const m of now.matchAll(/^\d+\. IDLE (\S+) \(/gm)) {
      await orchestrator('look_at', { employee: m[1] });
      await orchestrator('tell_employee', { employee: m[1], message: 'Carry on with what you were asked to do, and report when it is done. @@fake: say carried-on@@' });
      handled++;
    }
    for (const m of now.matchAll(/^\d+\. UNASSIGNED (\S+) .* free now: ([^ (,]+)/gm)) {
      await orchestrator('assign_task', { task: m[1], employee: m[2] });
      handled++;
    }
    await orchestrator('finish_round', { summary: `Handled ${handled} item${handled === 1 ? '' : 's'}.` });
    return 'Round finished.';
  }
  const request = /request id ([0-9a-f]+)/i.exec(text)?.[1];
  if (/\[ORCH:MSG:/.test(text) && request && /respond_to_request/.test(text)) {
    const action = /\[new_task\]/.test(text) ? 'new_task' : /\[decision\]/.test(text) ? 'needs_decision' : 'incorporated';
    await orchestrator('respond_to_request', { request_id: request, action, note: `${who} will expose it as GET /api/permissions` });
    return 'Responded to the request.';
  }
  const review = /Review request[\s\S]*?submit_review with task "([A-Z]+-\d+)"/.exec(text);
  if (review) {
    // A real (if simple-minded) review: read the actual diff and judge it.
    const diffCmd = /^\s*(git diff \S+)\s*$/m.exec(text)?.[1];
    let diff = '';
    if (diffCmd) {
      const r = await bash(diffCmd);
      diff = r.response?.stdout ?? '';
    }
    const bad = /NEEDS-WORK/.test(diff);
    await orchestrator('submit_review', { task: review[1], verdict: bad ? 'request_changes' : 'approve', comments: bad ? 'The change still contains a NEEDS-WORK marker; remove it.' : 'Looks correct and is covered by the checks.' });
    await orchestrator('complete_task', { summary: `Reviewed ${review[1]}`, no_code_changes: true });
    return 'Review submitted.';
  }
  return null;
}

let interrupted = false;
let busy = false;

async function handlePrompt(text, viaStopHook = false) {
  busy = true;
  interrupted = false;
  if (!viaStopHook) {
    transcript({ type: 'user', message: { role: 'user', content: text } });
    await fireHook('UserPromptSubmit', { prompt: text });
  }
  say('');
  // A review request quotes the author's task text; a reviewer reviews, it does not replay that script.
  const scripted = /@@fake(-retry)?:/.test(text) && !/Review request —/.test(text);
  let last = scripted ? await runDirectives(text) : ((await defaultBehaviour(text)) ?? 'Understood.');
  transcript({ type: 'assistant', message: { id: `msg_fake_${Date.now()}`, role: 'assistant', content: [{ type: 'text', text: last }], usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } } });
  say(`\x1b[2m${String(last).split('\n')[0].slice(0, 160)}\x1b[0m`);
  // Stop hook: a "block" decision means "keep going with this reason", possibly repeatedly.
  for (let depth = 0; depth < 6 && !turnFailed; depth++) {
    const stop = await fireHook('Stop', { stop_hook_active: depth > 0 || viaStopHook, last_assistant_message: last });
    if (stop?.decision !== 'block' || !stop.reason) break;
    say(`\x1b[35m⎿ Stop hook feedback:\x1b[0m ${String(stop.reason).split('\n')[0].slice(0, 140)}`);
    // What comes back from the Stop hook is new input: an interrupt of the work before it does not carry over.
    interrupted = false;
    last = await runDirectives(stop.reason);
    if (!/@@fake(-retry)?:/.test(stop.reason)) last = (await defaultBehaviour(stop.reason)) ?? 'Continuing.';
  }
  await statusLine();
  busy = false;
  prompt();
}

function prompt() {
  out('\r\n\x1b[1m>\x1b[0m ');
}

// ───────────── terminal input: raw mode with bracketed paste, like a real TUI ─────────────
let line = '';
let inPaste = false;
let keyWaiter = null;
const queue = [];

// While a dialog is open every key belongs to it — also the ones that arrive together in one read (an arrow key
// is three bytes, and the Enter after it often comes with them): they wait in a queue for the dialog to take them.
let dialogOpen = false;
const keyQueue = [];
function nextKey() {
  if (keyQueue.length) return Promise.resolve(keyQueue.shift());
  return new Promise((resolve) => {
    keyWaiter = resolve;
  });
}

function submit() {
  const text = line;
  line = '';
  out('\r\n');
  if (!text.trim()) return prompt();
  if (text.trim() === '/exit') return shutdown('prompt_input_exit');
  if (busy) queue.push(text);
  else void handlePrompt(text).then(drain);
}

async function drain() {
  while (queue.length && !busy) await handlePrompt(queue.shift());
}

function onInput(chunk) {
  let s = chunk.toString('utf8');
  while (s.length) {
    if (!inPaste && s.startsWith('\x1b[200~')) {
      inPaste = true;
      s = s.slice(6);
      continue;
    }
    if (inPaste) {
      const end = s.indexOf('\x1b[201~');
      const part = end === -1 ? s : s.slice(0, end);
      line += part;
      out(`\x1b[2m[pasted ${part.length} chars]\x1b[0m`);
      if (end === -1) return;
      inPaste = false;
      s = s.slice(end + 6);
      continue;
    }
    const ch = s[0];
    s = s.slice(1);
    if (keyWaiter) {
      const w = keyWaiter;
      keyWaiter = null;
      if (!dialogOpen) out(`${ch === '\r' ? '' : ch}\r\n`);
      w(ch);
      continue;
    }
    if (dialogOpen) {
      keyQueue.push(ch);
      continue;
    }
    if (ch === '\x03') return shutdown('other');
    if (ch === '\x1b') {
      // Escape interrupts the current turn, like the real CLI.
      if (busy) interrupted = true;
      continue;
    }
    if (ch === '\r' || ch === '\n') submit();
    else if (ch === '\x7f') {
      if (line.length) {
        line = line.slice(0, -1);
        out('\b \b');
      }
    } else {
      line += ch;
      out(ch);
    }
  }
}

async function shutdown(reason) {
  await fireHook('SessionEnd', { reason });
  out('\x1b[?2004l');
  process.exit(0);
}

out('\x1b[?2004h');
say('\x1b[1m✻ FAKE CLAUDE\x1b[0m — test fixture, not Claude Code');
say(`  cwd: ${cwd}`);
// A conversation that was never written down (the session was stopped before its first prompt) cannot be continued:
// the real CLI says so and exits — after reporting the end of that attempt through its hook. A test asks for this
// with a file named `.fake-no-conversation` in the working folder.
if (resumeId && fs.existsSync(path.join(cwd, '.fake-no-conversation'))) {
  console.error(`No conversation found with session ID: ${resumeId}`);
  await fireHook('SessionEnd', { reason: 'other' });
  process.exit(1);
}
say(`  session: ${sessionId}${resumeId ? ' (resumed)' : ''} · mode: ${permissionMode}`);
if (flag('--model') || flag('--effort')) say(`  model: ${flag('--model') ?? 'default'} · effort: ${flag('--effort') ?? 'default'}`);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', onInput);
process.stdin.resume();
process.on('SIGTERM', () => void shutdown('other'));
// The first start of an account in bypass mode: Claude Code's warning, which somebody has to accept — once.
// (Remembered per Claude config folder, as the real one remembers it in that folder's settings.)
if (permissionMode === 'bypassPermissions') {
  const accepted = path.join(process.env.CLAUDE_CONFIG_DIR ?? process.env.HOME ?? '/nonexistent', '.fake-bypass-accepted');
  if (!fs.existsSync(accepted)) {
    say(' \x1b[31mWARNING: Claude Code running in Bypass Permissions mode\x1b[0m');
    say(' In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.');
    say(' By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.');
    say(' ❯ 1. No, exit');
    say('   2. Yes, I accept');
    // Keys come one byte at a time: an arrow (ESC [ B) moves to "Yes, I accept", Enter confirms the choice.
    let onYes = false;
    dialogOpen = true;
    for (;;) {
      const key = await nextKey();
      if (key === '\x1b') {
        const a = await nextKey();
        const b = a === '[' || a === 'O' ? await nextKey() : '';
        if (b === 'B') onYes = true;
        else if (b === 'A') onYes = false;
        continue;
      }
      if (key === '2') onYes = true;
      if (key === '\r' || key === '2' || key === '1') break;
    }
    dialogOpen = false;
    keyQueue.length = 0;
    if (!onYes) {
      say(' Exiting.');
      process.exit(1);
    }
    try {
      fs.writeFileSync(accepted, new Date().toISOString());
    } catch {
      /* not remembered: asked again next time */
    }
    out('\x1b[5A\x1b[J');
  }
}
await fireHook('SessionStart', { source: resumeId ? 'resume' : 'startup' });
prompt();
