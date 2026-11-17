import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

/**
 * The SDK-managed worker runtime.
 *
 * This process runs *inside the employee's tmux pane* and drives Claude through
 * the Claude Agent SDK instead of the interactive TUI:
 *
 *   prompts      arrive as structured SDK input (no typing into a terminal)
 *   approvals    go through the SDK's canUseTool callback to the office
 *   interrupts   call the SDK's interrupt()
 *   activity     comes from the SDK's hook callbacks, forwarded to the same
 *                hook receiver the interactive workers use
 *
 * The pane shows a plain transcript of what the agent is doing, and a human
 * who takes control can type a prompt and press Enter. It is a different
 * runtime from the interactive CLI and is reported as such.
 */
export interface ManagedSpec {
  sessionId: string;
  sdkEntry: string;
  claudeBin: string;
  cwd: string;
  displayName: string;
  model: string | null;
  permissionMode: string;
  allow: string[];
  deny: string[];
  ask: string[];
  strictMcp: boolean;
  appendSystemPrompt: string;
  mcp: { url: string; token: string } | null;
  claudeSessionId: string;
  resume: boolean;
  socketPath: string;
  hookToken: string;
  approvalWaitSeconds: number;
  env: Record<string, string>;
}

const HOOKS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd'] as const;
const BLOCKING = new Set(['PreToolUse', 'Stop']);

const out = (s: string) => process.stdout.write(s);
const say = (s = '') => out(`${s}\r\n`);
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

export async function runManaged(specPath: string): Promise<void> {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as ManagedSpec;
  const sdk: any = await import(pathToFileURL(spec.sdkEntry).href);
  const query = sdk.query ?? sdk.default?.query;
  if (typeof query !== 'function') throw new Error(`${spec.sdkEntry} does not export query()`);

  /** Talk to the host agent over its private unix socket. */
  const call = (method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<any> =>
    new Promise((resolve) => {
      const req = http.request(
        { socketPath: spec.socketPath, path, method, timeout: timeoutMs, headers: { 'content-type': 'application/json', 'x-orch-token': spec.hookToken, 'x-orch-session': spec.sessionId, 'x-tmux-pane': process.env.TMUX_PANE ?? '' } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              resolve(data.trim() ? JSON.parse(data) : null);
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on('timeout', () => req.destroy());
      // The agent being down must never break the worker: it just means "no decision".
      req.on('error', () => resolve(null));
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  // ── input: prompts from the office and from a human at the keyboard ──
  const pendingInput: Array<{ text: string; echo: boolean }> = [];
  let wake = null as (() => void) | null;
  let ended = false;
  const push = (text: string, echo: boolean) => {
    pendingInput.push({ text, echo });
    wake?.();
  };
  async function* input(): AsyncGenerator<any> {
    for (;;) {
      while (!pendingInput.length && !ended) await new Promise<void>((r) => (wake = r));
      wake = null;
      if (ended && !pendingInput.length) return;
      const { text, echo } = pendingInput.shift()!;
      // A prompt typed at the keyboard is already on screen; one from the office is shown here.
      if (echo) {
        say();
        say(`\x1b[1m>\x1b[0m ${clip(text, 400)}`);
      }
      busy = true;
      yield { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    }
  }

  let q: any = null;
  let busy = false;
  let announced = false;
  let keyWaiter = null as ((key: string) => void) | null;

  /**
   * The office's central context given at the start (the answer to the start this runner reports itself, below):
   * the SDK has no conversation yet to put it in, so it goes in with the first prompt (docs/CONTEXT.md).
   */
  let startContext: string | null = null;
  const hooks: Record<string, unknown[]> = {};
  for (const event of HOOKS) {
    const timeout = BLOCKING.has(event) ? spec.approvalWaitSeconds + 30 : 30;
    hooks[event] = [
      {
        timeout: timeout + 5,
        hooks: [
          async (payload: any) => {
            // The start and a resume are reported by this runner itself once Claude Code is up; the SDK's own
            // SessionStart is passed on only after a compaction (or /clear), when what the session held is gone.
            if (event === 'SessionStart' && payload?.source !== 'compact' && payload?.source !== 'clear') return {};
            const res: any = (await call('POST', '/hook', { ...payload, orch_runtime: 'sdk' }, timeout * 1000)) ?? {};
            if (event === 'UserPromptSubmit' && startContext) {
              const now = res?.hookSpecificOutput?.additionalContext;
              const merged = [startContext, typeof now === 'string' ? now : ''].filter(Boolean).join('\n\n');
              startContext = null;
              return { ...res, hookSpecificOutput: { ...(res.hookSpecificOutput ?? {}), hookEventName: 'UserPromptSubmit', additionalContext: merged } };
            }
            return res;
          },
        ],
      },
    ];
  }

  /** The SDK asks whether a tool may run: the question goes to the office. */
  const canUseTool = async (toolName: string, toolInput: Record<string, unknown>, opts: { signal?: AbortSignal; title?: string; decisionReason?: string }) => {
    if (toolName === 'AskUserQuestion') {
      // The office answers these through the PreToolUse hook. Getting here means nobody did in time.
      say(dim('  ⎿ nobody answered the question in time'));
      return { behavior: 'deny', message: 'Nobody answered this question in time. Ask the boss with the ask_boss tool (it waits for the answer), or continue with your best judgement and state the assumption you made.' };
    }
    say(`\x1b[33m? approval needed:\x1b[0m ${opts.title ?? `${toolName} ${clip(JSON.stringify(toolInput), 120)}`}`);
    const res = await call('POST', '/hook', { hook_event_name: 'PermissionRequest', session_id: spec.claudeSessionId, cwd: spec.cwd, permission_mode: spec.permissionMode, tool_name: toolName, tool_input: toolInput, orch_runtime: 'sdk', title: opts.title ?? null }, (spec.approvalWaitSeconds + 5) * 1000);
    const decision = res?.hookSpecificOutput?.decision;
    if (decision?.behavior === 'allow') {
      say(dim('  ⎿ approved from the office'));
      return { behavior: 'allow', updatedInput: decision.updatedInput ?? toolInput };
    }
    if (decision?.behavior === 'deny') {
      say(dim(`  ⎿ denied from the office: ${decision.message ?? ''}`));
      return { behavior: 'deny', message: decision.message ?? 'Denied by the boss in Orchestrator.' };
    }
    // Nobody answered in the office (or it is unreachable): ask at the workstation, like the CLI does.
    void call('POST', '/hook', { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: `Waiting at the terminal for permission to use ${toolName}`, session_id: spec.claudeSessionId, cwd: spec.cwd, orch_runtime: 'sdk' }, 5000);
    say(`\x1b[33mAllow this? [y/N]\x1b[0m`);
    const key = await new Promise<string>((resolve) => {
      keyWaiter = resolve;
      opts.signal?.addEventListener('abort', () => resolve('n'));
    });
    keyWaiter = null;
    return key.toLowerCase() === 'y' ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: 'Denied at the workstation.' };
  };

  say(`\x1b[1m◆ ${spec.displayName}\x1b[0m — SDK-managed Claude worker (Orchestrator)`);
  say(dim(`  cwd: ${spec.cwd}`));
  say(dim(`  session: ${spec.claudeSessionId}${spec.resume ? ' (resumed)' : ''} · mode: ${spec.permissionMode}`));
  say(dim('  Prompts arrive from the office. With control of this terminal you can also type one and press Enter; Esc interrupts.'));

  const env: Record<string, string | undefined> = { ...process.env, ...spec.env };
  const options: Record<string, unknown> = {
    cwd: spec.cwd,
    pathToClaudeCodeExecutable: spec.claudeBin,
    // The CLI calls its ask-first mode "manual" since 2.1.200; the SDK's name for it is "default".
    permissionMode: spec.permissionMode === 'manual' ? 'default' : spec.permissionMode,
    allowedTools: spec.allow,
    disallowedTools: spec.deny,
    // The same permission rules an interactive worker gets in its settings file.
    settings: { permissions: { allow: spec.allow, deny: spec.deny, ask: spec.ask } },
    canUseTool,
    hooks,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: spec.appendSystemPrompt },
    // Project instructions (CLAUDE.md) apply; the owner's personal settings and connectors do not.
    settingSources: ['project'],
    strictMcpConfig: spec.strictMcp,
    mcpServers: spec.mcp ? { orchestrator: { type: 'http', url: spec.mcp.url, headers: { Authorization: `Bearer ${spec.mcp.token}` } } } : {},
    env,
    stderr: (data: string) => out(dim(data.replace(/\n/g, '\r\n'))),
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.resume ? { resume: spec.claudeSessionId } : { sessionId: spec.claudeSessionId }),
  };

  // ── the office's inbox: prompts and interrupts, long-polled from the host agent ──
  void (async () => {
    while (!ended) {
      const item = await call('GET', `/managed/inbox?wait=25`, undefined, 40000);
      if (!item) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      if (item.type === 'prompt' && typeof item.text === 'string') push(item.text, true);
      else if (item.type === 'interrupt') await interrupt('office');
      else if (item.type === 'exit') {
        ended = true;
        wake?.();
      }
    }
  })();

  async function interrupt(by: string): Promise<void> {
    if (!busy || !q) return;
    say(`\x1b[33m⎿ Interrupted (${by})\x1b[0m`);
    await q.interrupt?.().catch(() => undefined);
  }

  // ── the keyboard: a human who took control of this terminal ──
  let line = '';
  let inPaste = false;
  const onKeys = (chunk: Buffer) => {
    let s = chunk.toString('utf8');
    while (s.length) {
      if (!inPaste && s.startsWith('\x1b[200~')) {
        inPaste = true;
        s = s.slice(6);
        continue;
      }
      if (inPaste) {
        const end = s.indexOf('\x1b[201~');
        line += end === -1 ? s : s.slice(0, end);
        if (end === -1) return;
        inPaste = false;
        s = s.slice(end + 6);
        continue;
      }
      const ch = s[0]!;
      s = s.slice(1);
      if (keyWaiter) {
        const w = keyWaiter;
        keyWaiter = null;
        say(ch === '\r' ? '' : ch);
        w(ch);
      } else if (ch === '\x1b' && /^[\[O]/.test(s)) {
        // An arrow or function key, not Escape: swallow the whole sequence.
        const m = /^(\[[0-9;?]*[ -/]*[@-~]|O.)/.exec(s);
        s = s.slice(m ? m[0].length : 1);
      } else if (ch === '\x1b' || ch === '\x03') void interrupt('keyboard');
      else if (ch === '\r' || ch === '\n') {
        const text = line.trim();
        line = '';
        out('\r\n');
        if (text === '/exit') {
          ended = true;
          wake?.();
        } else if (text) push(text, false);
      } else if (ch === '\x7f') {
        if (line.length) {
          line = line.slice(0, -1);
          out('\b \b');
        }
      } else if (ch >= ' ') {
        line += ch;
        out(ch);
      }
    }
  };
  out('\x1b[?2004h');
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', onKeys);
  process.stdin.resume();

  q = query({ prompt: input(), options });
  // Wait until Claude Code itself is up before telling the office this worker is ready.
  if (typeof q.initializationResult === 'function') await q.initializationResult();
  const started: any = await call('POST', '/hook', { hook_event_name: 'SessionStart', source: spec.resume ? 'resume' : 'startup', session_id: spec.claudeSessionId, cwd: spec.cwd, permission_mode: spec.permissionMode, orch_runtime: 'sdk' }, 10000);
  const given = started?.hookSpecificOutput?.additionalContext;
  if (typeof given === 'string' && given) startContext = given;
  out('\r\n\x1b[1m>\x1b[0m ');

  try {
    for await (const msg of q as AsyncIterable<any>) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        // Sent at the start of every turn; worth showing once.
        if (announced) continue;
        announced = true;
        // Replace the waiting prompt line rather than writing after it.
        if (!busy) out('\r\x1b[K');
        say(dim(`  Claude Code ${msg.claude_code_version ?? ''} · model ${msg.model ?? spec.model ?? 'default'} · ${msg.tools?.length ?? 0} tools · MCP: ${(msg.mcp_servers ?? []).map((m: any) => `${m.name} (${m.status})`).join(', ') || 'none'}`));
        if (!busy) out('\r\n\x1b[1m>\x1b[0m ');
      } else if (msg.type === 'assistant') {
        busy = true;
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'text' && block.text?.trim()) say(String(block.text).replace(/\n/g, '\r\n'));
          else if (block.type === 'tool_use') say(`\x1b[36m⏺ ${block.name}\x1b[0m ${dim(clip(JSON.stringify(block.input ?? {}), 140))}`);
        }
      } else if (msg.type === 'user' && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (block.type !== 'tool_result') continue;
          const text = typeof block.content === 'string' ? block.content : (block.content ?? []).map((c: any) => c.text ?? '').join(' ');
          say(dim(`  ⎿ ${block.is_error ? 'error: ' : ''}${clip(text, 200)}`));
        }
      } else if (msg.type === 'result') {
        busy = false;
        const cost = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null;
        say(dim(`  ✓ turn finished in ${((msg.duration_ms ?? 0) / 1000).toFixed(1)}s${cost != null ? ` · running cost estimate $${cost.toFixed(4)}` : ''}${msg.subtype && msg.subtype !== 'success' ? ` · ${msg.subtype}` : ''}`));
        if (cost != null) void call('POST', '/managed/usage', { costUsdEstimate: cost, turns: msg.num_turns ?? 0 }, 5000);
        out('\r\n\x1b[1m>\x1b[0m ');
      }
    }
  } finally {
    ended = true;
    await call('POST', '/hook', { hook_event_name: 'SessionEnd', reason: 'other', session_id: spec.claudeSessionId, cwd: spec.cwd, orch_runtime: 'sdk' }, 5000);
    out('\x1b[?2004l');
  }
}
