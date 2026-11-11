import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { LaunchSpec } from '@orchestrator/contracts';

/**
 * Environment variables that mark a process as running *inside* another Claude
 * Code session. A worker must start as its own top-level session, so they are
 * removed from the pane's environment before `claude` starts.
 */
export const NESTED_SESSION_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
];

export function claudeVersion(bin = 'claude'): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /(\d+\.\d+\.\d+)/.exec(stdout);
      resolve(m ? m[1]! : stdout.trim() || null);
    });
  });
}

/** The levels `--effort` takes, from Claude Code's help text ("--effort <level>  Effort level … (low, medium, high, xhigh, max)"). Empty when the option is not there. */
export function parseEffortLevels(help: string): string[] {
  const at = help.search(/--effort\b/);
  if (at < 0) return [];
  const list = /\(([a-z][a-z,\s]*)\)/.exec(help.slice(at, at + 400));
  const levels = list ? list[1]!.split(',').map((x) => x.trim()).filter((x) => /^[a-z]{2,12}$/.test(x)) : [];
  // The option is there but its levels are not listed the way we know: the three every version with it has had.
  return levels.length ? levels : ['low', 'medium', 'high'];
}

/** Ask this machine's Claude Code which effort levels it has. Nothing is sent to a model: it only prints its help. */
export function claudeEffortLevels(bin = 'claude'): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(bin, ['--help'], { encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? [] : parseEffortLevels(String(stdout))));
  });
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

interface HookEventDef {
  name: string;
  /** Conservative minimum Claude Code version. Events are skipped on older CLIs. */
  min: string;
  /** Tool events take a matcher; "*" matches every tool. */
  tool?: boolean;
  /** Orchestrator may hold this hook open while a human decides. */
  blocking?: boolean;
}

/**
 * Hook events Orchestrator subscribes to. Claude Code rejects settings that
 * name an event it does not know, so newer events are version-gated rather
 * than assumed to exist.
 */
export const HOOK_EVENTS: HookEventDef[] = [
  { name: 'SessionStart', min: '1.0.0' },
  { name: 'SessionEnd', min: '1.0.0' },
  { name: 'UserPromptSubmit', min: '1.0.0' },
  { name: 'PreToolUse', min: '1.0.0', tool: true, blocking: true },
  { name: 'PostToolUse', min: '1.0.0', tool: true },
  { name: 'Notification', min: '1.0.0' },
  { name: 'Stop', min: '1.0.0', blocking: true },
  { name: 'SubagentStop', min: '1.0.0' },
  { name: 'PostToolUseFailure', min: '2.1.0', tool: true },
  { name: 'PermissionRequest', min: '2.1.0', tool: true, blocking: true },
  { name: 'SubagentStart', min: '2.1.0' },
  { name: 'PermissionDenied', min: '2.1.200', tool: true },
  { name: 'StopFailure', min: '2.1.200' },
  // Claude Code's own task list and agent teams.
  { name: 'TaskCreated', min: '2.1.200' },
  { name: 'TaskCompleted', min: '2.1.200' },
  { name: 'TeammateIdle', min: '2.1.200' },
];

export function supportedHookEvents(version: string | null, override?: string[] | null): HookEventDef[] {
  if (override?.length) return HOOK_EVENTS.filter((e) => override.includes(e.name));
  if (!version) return HOOK_EVENTS.filter((e) => e.min === '1.0.0');
  return HOOK_EVENTS.filter((e) => compareVersions(version, e.min) >= 0);
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The hook command: forwards Claude Code's hook JSON to the host agent over a
 * private unix socket and prints the agent's reply (a hook decision, or
 * nothing). It never fails the hook: if the agent is down Claude Code simply
 * behaves as if no hook were installed.
 */
/**
 * What a command hook answers when the machine's agent cannot be reached and the session runs without Claude Code's
 * own permission checks: the command is refused, because nobody could look at it. (No answer at all would mean "run it".)
 */
export const AGENT_UNREACHABLE_REASON =
  "Orchestrator: the office's agent on this machine cannot be reached, so this command could not be checked against the office's high-risk list and was not run. Wait a minute and try once more; if it is refused again, stop and wait — do not look for another way to run it.";

/**
 * The command Claude Code runs for a hook: the event (JSON on standard input) is handed to the machine's agent over
 * its socket, and what the agent answers is the hook's answer.
 *
 * `retrySeconds` (hooks that may decide something): when the agent does not answer because it is not there — being
 * restarted, as at a deploy — the hook tries again once a second for that long, under the same name (`x-orch-hook`),
 * so the agent that comes back takes the same request up. Without this, a hook in flight got no answer, and no answer
 * means Claude Code goes on by its own rules.
 *
 * `failClosed` (a session in bypass mode): if the agent cannot be reached at all, a Bash command is refused instead
 * of being run with nothing having looked at it. Other tools, and other modes, go on as Claude Code decides.
 */
/** The mark a hook leaves beside the agent's socket when the agent stayed away (see `hookCommand`). */
export function agentAwayMark(socketPath: string): string {
  return `${socketPath}.away`;
}

export function hookCommand(opts: { socketPath: string; token: string; sessionId: string | null; maxSeconds: number; retrySeconds?: number; failClosed?: boolean; launch?: string | null }): string {
  const headers = [
    `-H 'content-type: application/json'`,
    `-H ${shellSingleQuote(`x-orch-token: ${opts.token}`)}`,
    opts.sessionId ? `-H ${shellSingleQuote(`x-orch-session: ${opts.sessionId}`)}` : '',
    // Which start of the session this process is: a session is started again under the same name, and what the
    // process before it still reports (its end) must not be taken for the new one's.
    opts.launch && /^[A-Za-z0-9-]{4,64}$/.test(opts.launch) ? `-H 'x-orch-launch: ${opts.launch}'` : '',
    `-H "x-tmux-pane: \${TMUX_PANE:-}"`,
  ]
    .filter(Boolean)
    .join(' ');
  const retry = Math.max(0, Math.floor(opts.retrySeconds ?? 0));
  if (!retry && !opts.failClosed) return `curl -sS --max-time ${opts.maxSeconds} --unix-socket ${shellSingleQuote(opts.socketPath)} -X POST ${headers} --data-binary @- http://orchestrator/hook 2>/dev/null || true`;
  // Plain sh, one line. $b: the event; $i: this hook's name, the same at every try; $l: the seconds this hook has left.
  // curl's 7 / 52 / 56: nobody listens on the socket, or the connection ended without an answer — the agent is gone
  // for now. Anything else (a refusal, a timeout) is not tried again.
  // $m: a mark beside the socket that says "the agent has been away for longer than a hook waits". While it is there
  // a hook tries once and does not wait — otherwise every tool call of a session whose agent is switched off would
  // stand for the whole retry time. The first hook that gets through takes the mark away, and so does the agent when it starts.
  const refuse = opts.failClosed
    ? ` case "$b" in *'"tool_name":"Bash"'*|*'"tool_name": "Bash"'*) printf '%s' ${shellSingleQuote(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: AGENT_UNREACHABLE_REASON } }))} ;; esac;`
    : '';
  return (
    `b=$(cat); i="$$-$(date +%s)"; t=$(date +%s); n=0; m=${shellSingleQuote(agentAwayMark(opts.socketPath))}; while :; do l=$(( ${opts.maxSeconds} - $(date +%s) + t )); [ "$l" -gt 1 ] || break; ` +
    `o=$(printf '%s' "$b" | curl -sSf --max-time "$l" --unix-socket ${shellSingleQuote(opts.socketPath)} -X POST ${headers} -H "x-orch-hook: $i" -H "x-orch-left: $l" --data-binary @- http://orchestrator/hook 2>/dev/null); c=$?; ` +
    `if [ "$c" -eq 0 ]; then [ ! -e "$m" ] || rm -f "$m"; printf '%s' "$o"; exit 0; fi; case "$c" in 7|52|56) ;; *) break ;; esac; n=$((n+1)); if [ "$n" -gt ${retry} ] || [ -e "$m" ]; then : > "$m" 2>/dev/null; break; fi; sleep 1; done;${refuse} exit 0`
  );
}

/**
 * The status line command for a worker session. Claude Code hands it the session's state as JSON
 * (including the account's rate limits, on subscription plans); it is passed on to the host agent,
 * and one short line is printed for the terminal.
 */
export function statusLineCommand(opts: { socketPath: string; token: string; sessionId: string; label: string }): string {
  const headers = [`-H 'content-type: application/json'`, `-H ${shellSingleQuote(`x-orch-token: ${opts.token}`)}`, `-H ${shellSingleQuote(`x-orch-session: ${opts.sessionId}`)}`].join(' ');
  return `curl -sS --max-time 2 --unix-socket ${shellSingleQuote(opts.socketPath)} -X POST ${headers} --data-binary @- http://orchestrator/statusline >/dev/null 2>&1; printf '%s' ${shellSingleQuote(opts.label)}`;
}

export function buildHooksSettings(opts: {
  socketPath: string;
  token: string;
  sessionId: string | null;
  claudeVersion: string | null;
  /** How long a blocking hook may wait for the owner, in seconds. */
  approvalWaitSeconds: number;
  events?: string[] | null;
  /** How long a hook that may decide something keeps trying to reach an agent that is not there (see `hookCommand`). 0: not at all. */
  retrySeconds?: number;
  /** The session runs in bypass mode: a command nobody could look at is refused. */
  bypass?: boolean;
  /** The name of this start of the session (see `hookCommand`). */
  launch?: string | null;
}): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const ev of supportedHookEvents(opts.claudeVersion, opts.events)) {
    const timeout = ev.blocking ? opts.approvalWaitSeconds + 30 : 30;
    const entry: Record<string, unknown> = {
      hooks: [
        {
          type: 'command',
          command: hookCommand({
            socketPath: opts.socketPath,
            token: opts.token,
            sessionId: opts.sessionId,
            launch: opts.launch,
            maxSeconds: timeout,
            // Those that decide — what may run (PreToolUse: the high-risk list, a question to the boss), a permission
            // request — and the end of a turn, which the office must not miss (the session would look busy for good).
            retrySeconds: ev.name === 'PreToolUse' || ev.name === 'PermissionRequest' || ev.name === 'Stop' ? (opts.retrySeconds ?? 0) : 0,
            failClosed: ev.name === 'PreToolUse' && !!opts.bypass,
          }),
          timeout: timeout + 5,
        },
      ],
    };
    if (ev.tool) entry.matcher = '*';
    hooks[ev.name] = [entry];
  }
  return hooks;
}

/** A restart of the agent takes a few seconds (at a deploy: stop, unpack, start); a hook waits this long for it. */
export const HOOK_RETRY_SECONDS = 45;

export interface ClaudeLaunchPlan {
  argv: string[];
  /** `mode`: for a file that is run (default: private, not executable). */
  files: Array<{ path: string; content: string; mode?: number }>;
  hookEvents: string[];
}

/**
 * The vault's helper in a session's own folder: a small program a command calls to take a credential out of the
 * office's vault by name — `curl -H "Authorization: Bearer $("$ORCH_VAULT" get github-deploy-token)" …` — or to put
 * one in from a pipe (`openssl rand -hex 24 | "$ORCH_VAULT" put shop-api-key`). The value goes from the office to
 * the command (or the other way) and never through the model's conversation. It talks to the office's worker
 * endpoint with the session's own token (read from the `mcp.json` next to it), so it can do only what that
 * session may, and every use is recorded there.
 */
export function vaultHelper(sessionDir: string): { command: string; files: Array<{ path: string; content: string; mode?: number }> } {
  const script = path.join(sessionDir, 'vault.mjs');
  const command = path.join(sessionDir, 'vault');
  const mjs = `// The office's vault, for commands in this session. Usage:
//   "$ORCH_VAULT" get NAME                      print the value (nothing else, no newline)
//   … | "$ORCH_VAULT" put NAME [--service S] [--user U] [--kind password|api_key|token|ssh_key|other] [--note "…"]
//   "$ORCH_VAULT" list [QUERY]                  names and what they are for; never values
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fail = (msg, code = 1) => { process.stderr.write('vault: ' + msg + '\\n'); process.exit(code); };
let office;
try {
  office = JSON.parse(fs.readFileSync(path.join(here, 'mcp.json'), 'utf8')).mcpServers.orchestrator;
} catch {
  fail('this session is not connected to an office');
}
async function call(name, args) {
  let res, body;
  try {
    res = await fetch(office.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...office.headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    body = await res.json();
  } catch (e) {
    fail('the office did not answer (' + (e && e.message) + ')');
  }
  const text = (body && body.result && body.result.content && body.result.content[0] && body.result.content[0].text) || '';
  if (!res.ok || body.error || (body.result && body.result.isError)) fail(String((body.error && body.error.message) || text || res.status).replace(/^Error: /, ''));
  return text;
}
const [cmd, name, ...rest] = process.argv.slice(2);
const opt = (flag) => { const i = rest.indexOf(flag); return i >= 0 ? rest[i + 1] : undefined; };
if (cmd === 'get' && name) process.stdout.write(await call('vault_read', { name }));
else if (cmd === 'list') process.stdout.write((await call('vault_list', { query: name || '' })) + '\\n');
else if (cmd === 'put' && name) {
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  value = value.replace(/\\r?\\n$/, '');
  if (!value) fail('nothing to store: give the value on standard input, e.g.  printf %s "$TOKEN" | "$ORCH_VAULT" put ' + name, 2);
  process.stdout.write((await call('vault_store', { name, value, service: opt('--service'), username: opt('--user'), kind: opt('--kind'), description: opt('--note') })).split('. ')[0] + '.\\n');
} else fail('usage: "$ORCH_VAULT" get NAME  |  … | "$ORCH_VAULT" put NAME [--service S] [--user U] [--kind K] [--note "…"]  |  "$ORCH_VAULT" list [QUERY]', 2);
`;
  const sh = `#!/bin/sh\nexec ${shellSingleQuote(process.execPath)} ${shellSingleQuote(script)} "$@"\n`;
  return { command, files: [{ path: script, content: mjs }, { path: command, content: sh, mode: 0o700 }] };
}

/**
 * Turn a LaunchSpec into the exact argv and config files for a managed
 * interactive Claude Code worker. Nothing here weakens Claude Code's own
 * permission system: autonomy maps to its real permission modes and rules.
 */
export function planClaudeLaunch(opts: {
  claudeBin: string;
  spec: LaunchSpec;
  sessionId: string;
  sessionDir: string;
  hookSocket: string;
  hookToken: string;
  claudeVersion: string | null;
  approvalWaitSeconds: number;
  hookEvents?: string[] | null;
  /** How long a deciding hook keeps trying to reach the agent while it is being restarted. Default `HOOK_RETRY_SECONDS`. */
  hookRetrySeconds?: number;
  /** A name for this start of the session, sent with every hook of the process started now. */
  hookLaunch?: string | null;
  /** What `--effort` accepts on this machine (see `claudeEffortLevels`). An effort that is not among them is left out rather than passed to a CLI that would refuse to start. */
  effortLevels?: string[] | null;
  /** A browser for this session: the command of an MCP server that drives one (see `findBrowserMcp`). */
  browser?: { command: string; args: string[] } | null;
}): ClaudeLaunchPlan {
  const { spec } = opts;
  const settingsPath = path.join(opts.sessionDir, 'settings.json');
  const mcpPath = path.join(opts.sessionDir, 'mcp.json');
  const hooks = buildHooksSettings({
    socketPath: opts.hookSocket,
    token: opts.hookToken,
    sessionId: opts.sessionId,
    claudeVersion: opts.claudeVersion,
    approvalWaitSeconds: opts.approvalWaitSeconds,
    events: opts.hookEvents,
    retrySeconds: opts.hookRetrySeconds ?? HOOK_RETRY_SECONDS,
    bypass: spec.permissionMode === 'bypassPermissions',
    launch: opts.hookLaunch,
  });
  const browser = spec.mcp && opts.browser ? opts.browser : null;
  const allow = [...new Set([...spec.permissions.allow, ...spec.allowedTools, ...(spec.mcp ? ['mcp__orchestrator'] : []), ...(browser ? ['mcp__browser'] : [])])];
  const deny = [...new Set([...spec.permissions.deny, ...spec.disallowedTools])];
  const settings = {
    permissions: { allow, deny, ask: spec.permissions.ask },
    hooks,
    // Refreshed after each answer, and once a minute while idle.
    statusLine: { type: 'command', command: statusLineCommand({ socketPath: opts.hookSocket, token: opts.hookToken, sessionId: opts.sessionId, label: `Orchestrator · ${spec.displayName}` }), refreshInterval: 60 },
  };
  const files: ClaudeLaunchPlan['files'] = [{ path: settingsPath, content: JSON.stringify(settings, null, 2) }];

  const unset = NESTED_SESSION_ENV.flatMap((k) => ['-u', k]);
  // The vault's helper for this session (see `vaultHelper`): commands reach credentials by name through it.
  const vault = spec.mcp ? vaultHelper(opts.sessionDir) : null;
  if (vault) files.push(...vault.files);
  const envPairs = Object.entries({ ...spec.env, ORCH_SESSION_ID: opts.sessionId, ...(vault ? { ORCH_VAULT: vault.command } : {}) }).map(([k, v]) => `${k}=${v}`);
  const argv = ['/usr/bin/env', ...unset, ...envPairs, opts.claudeBin, '--settings', settingsPath];
  if (spec.resume) argv.push('--resume', spec.claudeSessionId);
  // Pick up the most recent conversation Claude Code has for this folder (one that was started outside the office).
  else if (spec.continueLast) argv.push('--continue');
  else argv.push('--session-id', spec.claudeSessionId);
  if (spec.addDirs?.length) argv.push('--add-dir', ...spec.addDirs);
  argv.push('--permission-mode', spec.permissionMode);
  if (spec.model) argv.push('--model', spec.model);
  if (spec.effort && opts.effortLevels?.includes(spec.effort)) argv.push('--effort', spec.effort);
  if (spec.displayName) argv.push('--name', spec.displayName);
  if (spec.appendSystemPrompt) argv.push('--append-system-prompt', spec.appendSystemPrompt);
  if (spec.mcp) {
    files.push({
      path: mcpPath,
      content: JSON.stringify(
        {
          mcpServers: {
            orchestrator: { type: 'http', url: spec.mcp.url, headers: { Authorization: `Bearer ${spec.mcp.token}` } },
            // A browser of this session's own: headless, with a profile that is gone when the session ends.
            ...(browser ? { browser: { type: 'stdio', command: browser.command, args: [...browser.args, '--output-dir', path.join(opts.sessionDir, 'browser')] } } : {}),
          },
        },
        null,
        2,
      ),
    });
    if (spec.strictMcp) argv.push('--strict-mcp-config');
    // --mcp-config is variadic, so it goes last.
    argv.push('--mcp-config', mcpPath);
  }
  return { argv, files, hookEvents: Object.keys(hooks) };
}

/** Heuristic used only for *discovery* of existing sessions; the owner confirms the attachment. */
export function looksLikeClaude(pane: { currentCommand: string; startCommand: string; title: string }): boolean {
  return /\bclaude\b/i.test(pane.currentCommand) || /\bclaude\b/i.test(pane.startCommand) || /claude/i.test(pane.title);
}

/**
 * A browser the employees on this machine can drive: Playwright's MCP server, if it is installed where the office
 * looks for it. Never downloaded by the office itself — somebody installs it once (docs/ATTACHMENTS.md, "A browser").
 *
 * Looked for, in order: `ORCH_BROWSER_MCP` (the path of its `cli.js`), then `browser/node_modules/@playwright/mcp/cli.js`
 * in each of `dirs` (beside the office program; in the agent's home). It runs headless with a profile kept in memory,
 * on the machine's own Chrome when there is one (else the browser Playwright installed).
 */
export function findBrowserMcp(dirs: string[], env: NodeJS.ProcessEnv = process.env): { command: string; args: string[]; version: string; engine: string } | null {
  const candidates = [env.ORCH_BROWSER_MCP, ...dirs.map((d) => path.join(d, 'browser', 'node_modules', '@playwright', 'mcp', 'cli.js'))].filter((x): x is string => !!x);
  for (const cli of candidates) {
    try {
      if (!fs.statSync(cli).isFile()) continue;
      let version = 'unknown';
      try {
        version = String(JSON.parse(fs.readFileSync(path.join(path.dirname(cli), 'package.json'), 'utf8')).version ?? 'unknown');
      } catch {
        /* a cli on its own (a test's stand-in): no version to tell */
      }
      const chrome = env.ORCH_BROWSER_CHROME ?? ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p)) ?? null;
      const args = [cli, '--headless', '--isolated', '--file-paths', 'absolute', ...(chrome && chrome !== 'none' ? ['--browser', 'chrome'] : [])];
      return { command: process.execPath, args, version, engine: chrome && chrome !== 'none' ? 'chrome' : 'chromium' };
    } catch {
      /* not there: the next place */
    }
  }
  return null;
}
