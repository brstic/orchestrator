import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

export interface CodexSpec {
  sessionId: string;
  codexBin: string;
  cwd: string;
  displayName: string;
  model: string | null;
  effort?: string | null;
  fileDeny?: string[];
  /** The office's own folders on this machine, fenced off from the file tools (`codex-files.ts`). */
  officeRoots?: string[];
  appendSystemPrompt: string;
  mcp: { url: string; token: string } | null;
  codexThreadId?: string | null;
  socketPath: string;
  hookToken: string;
  hookLaunch: string;
  env: Record<string, string>;
}

type JsonObject = Record<string, unknown>;
type RpcId = number | string;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

interface ActiveTurn {
  id: string | null;
  submitted: boolean;
  accepted: Promise<void>;
  interrupt: boolean;
  interruptSent: boolean;
  continuation: boolean;
  reply: string;
}

interface Prompt {
  text: string;
  id: string;
  continuation: boolean;
  echo: boolean;
}

const TOKEN_ENV = 'ORCHESTRATOR_CODEX_MCP_TOKEN';
const say = (message: string) => process.stdout.write(`${message.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')}\n`);

function callHost(spec: CodexSpec, method: 'GET' | 'POST', route: string, body: unknown, timeout: number, signal?: AbortSignal): Promise<JsonObject> {
  return new Promise((resolve) => {
    const req = http.request({
      socketPath: spec.socketPath,
      path: route,
      method,
      timeout,
      signal,
      headers: {
        'content-type': 'application/json',
        'x-orch-token': spec.hookToken,
        'x-orch-launch': spec.hookLaunch,
        'x-orch-session': spec.sessionId,
        'x-tmux-pane': process.env.TMUX_PANE ?? '',
      },
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { data += chunk; });
      response.on('error', () => resolve({}));
      response.on('end', () => {
        try {
          resolve(response.statusCode === 200 && data ? object(JSON.parse(data)) : {});
        } catch {
          resolve({});
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({}));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

class AppServer {
  private nextId = 0;
  private closed = false;
  private pending = new Map<number, { resolve: (result: JsonObject) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly exit: Promise<string>;
  private readonly child;

  constructor(bin: string, cwd: string, env: NodeJS.ProcessEnv, options: string[], onEvent: (method: string, params: JsonObject) => void) {
    this.child = spawn(bin, ['app-server', '--listen', 'stdio://', ...options], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.exit = new Promise((resolve) => {
      const end = (message: string) => {
        if (this.closed) return;
        this.closed = true;
        for (const id of this.pending.keys()) this.reject(id, new Error(message));
        resolve(message);
      };
      this.child.once('error', (error) => end(error.message));
      this.child.once('close', (code, signal) => end(`Codex app-server exited (${signal ?? code})`));
      // A child that closes its input before the process exits also rejects outstanding work.
      this.child.stdin.on('error', (error) => end(error.message));
    });
    // The app server's diagnostic stream can include connection configuration.
    this.child.stderr.resume();
    const stream = readline.createInterface({ input: this.child.stdout });
    stream.on('line', (line) => {
      let message: JsonObject;
      try {
        message = object(JSON.parse(line));
      } catch {
        return;
      }
      const method = string(message.method);
      if (method) {
        if (typeof message.id === 'string' || typeof message.id === 'number') this.decline(message.id, method);
        else onEvent(method, object(message.params));
        return;
      }
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (message.error) {
        this.reject(message.id, new Error(string(object(message.error).message) || 'Codex app-server request failed'));
      } else {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(object(message.result));
      }
    });
  }

  private write(message: JsonObject): void {
    if (!this.closed) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  private reject(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private decline(id: RpcId, method: string): void {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.write({ id, result: { decision: 'decline' } });
    } else if (method === 'mcpServer/elicitation/request') {
      this.write({ id, result: { action: 'decline', content: null, _meta: null } });
    } else {
      this.write({ id, error: { code: -32601, message: 'Request disabled for this Orchestrator worker' } });
    }
  }

  notify(method: string): void {
    this.write({ method });
  }

  request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.closed) return Promise.reject(new Error('Codex app-server is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.reject(id, new Error(`Codex app-server timed out on ${method}`)), 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

/**
 * Why an item Codex started is not allowed, or null. Its shell, web search and image viewer are switched off by the
 * runner's configuration, and its own file changes may only be in its scratch folder (its sandbox holds it there too);
 * the selected folder is reached through the workspace tools alone (`codex-files.ts`).
 */
export function forbidden(item: JsonObject, scratch: string | string[]): string | null {
  const roots = Array.isArray(scratch) ? scratch : [scratch];
  const type = string(item.type);
  if (type === 'commandExecution') return 'it tried to run a command, which Codex employees may not run';
  if (type === 'webSearch') return 'it tried to search the web, which Codex employees may not do';
  if (type === 'imageView') return 'it tried to open a file outside its workspace tools';
  if (type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const outside = changes.some((c) => {
      const p = path.resolve(roots[0]!, string(object(c).path));
      return !roots.some((root) => p === root || p.startsWith(root + path.sep));
    });
    if (outside) return 'it tried to change a file outside its workspace tools';
  }
  return null;
}

function workerHome(specPath: string): string {
  const home = path.join(path.dirname(specPath), 'codex-home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // Share the operator's file-backed login and its refreshes without importing their configuration.
  const source = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  const target = path.join(home, 'auth.json');
  try {
    fs.symlinkSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return home;
}

export async function runCodex(specPath: string): Promise<void> {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as CodexSpec;
  const deadline = Date.now() + 5_000;
  while ((await callHost(spec, 'GET', '/managed/ready', undefined, 1_000)).ready !== true) {
    if (Date.now() >= deadline) throw new Error('The host did not register this Codex launch');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  const prompts: Prompt[] = [];
  const inbox = new AbortController();
  let threadId = '';
  let active: ActiveTurn | null = null;
  let startContext = '';
  let stopping = false;
  let failure: Error | undefined;
  let endReason = 'other';
  let finished: () => void = () => {};
  const done = new Promise<void>((resolve) => { finished = resolve; });
  let events = Promise.resolve();
  const home = workerHome(specPath);
  const emptyThread = path.join(home, 'empty-thread');
  const scratch = path.join(path.dirname(specPath), 'codex-scratch');
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  // (As Codex may name it: through a link in its path or not — /tmp and /private/tmp on a Mac.)
  const scratchRoots = [...new Set([scratch, fs.realpathSync(scratch)])];
  const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env, CODEX_HOME: home };
  delete env[TOKEN_ENV];
  if (spec.mcp) env[TOKEN_ENV] = spec.mcp.token;

  // Native tools remain sandboxed. The separate workspace MCP process handles scoped file access.
  const config = [
    'approval_policy="never"', 'sandbox_mode="workspace-write"',
    'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true', 'web_search="disabled"',
    'features.shell_tool=false', 'features.shell_snapshot=false', 'features.hooks=false',
    'features.plugins=false', 'features.apps=false', 'features.multi_agent=false',
    'features.view_image=false', 'features.image_generation=false', 'features.in_app_browser=false',
    'features.computer_use=false', 'features.browser_use=false', 'features.browser_use_external=false',
    'features.remote_plugin=false', 'features.code_mode=false', 'features.workspace_dependencies=false',
    'features.request_permissions_tool=false',
    'features.skill_mcp_dependency_install=false', 'features.memories=false',
    'cli_auth_credentials_store="file"',
    `projects.${JSON.stringify(scratch)}.trust_level="untrusted"`,
  ];
  config.push(
    `mcp_servers.workspace.command=${JSON.stringify(process.execPath)}`,
    `mcp_servers.workspace.args=${JSON.stringify([process.argv[1], 'codex-files', '--spec', specPath])}`,
    'mcp_servers.workspace.required=true',
    'mcp_servers.workspace.default_tools_approval_mode="approve"',
    ...(process.env.ELECTRON_RUN_AS_NODE ? ['mcp_servers.workspace.env.ELECTRON_RUN_AS_NODE="1"'] : []),
  );
  if (spec.effort) config.push(`model_reasoning_effort=${JSON.stringify(spec.effort)}`);
  if (spec.mcp) {
    config.push(
      `mcp_servers.orchestrator.url=${JSON.stringify(spec.mcp.url)}`,
      `mcp_servers.orchestrator.bearer_token_env_var="${TOKEN_ENV}"`,
      'mcp_servers.orchestrator.required=true',
      // These tools can read local files or secrets outside Codex's file boundary.
      'mcp_servers.orchestrator.disabled_tools=["attach_file","vault_read"]',
    );
  }
  const app = new AppServer(spec.codexBin, scratch, env, config.flatMap((entry) => ['-c', entry]), (method, params) => {
    if (stopIfForbidden(method, params)) return;
    events = events.then(() => onEvent(method, params)).catch(fail);
  });
  const hook = (event: string, data: JsonObject = {}) => callHost(spec, 'POST', '/hook', {
    hook_event_name: event, session_id: threadId, cwd: spec.cwd, permission_mode: 'read-only', orch_runtime: 'codex', ...data,
  }, 10_000);

  function stopWorker(): void {
    stopping = true;
    inbox.abort();
    finished();
  }

  function fail(error: unknown): void {
    if (stopping) return;
    failure = error instanceof Error ? error : new Error(String(error));
    stopWorker();
  }

  function enqueue(text: string, echo: boolean, continuation = false, id: string = randomUUID()): void {
    if (!text.trim() || stopping) return;
    const prompt = { text, id, continuation, echo };
    if (continuation) prompts.unshift(prompt);
    else prompts.push(prompt);
    void nextPrompt().catch(fail);
  }

  async function tryInterrupt(turn: ActiveTurn): Promise<void> {
    if (!turn.id || turn.interruptSent || active !== turn) return;
    turn.interruptSent = true;
    await app.request('turn/interrupt', { threadId, turnId: turn.id });
  }

  function interrupt(): void {
    if (!active) return;
    active.interrupt = true;
    void tryInterrupt(active).catch((error: unknown) => {
      if (!stopping && active?.interruptSent) say(`Codex interrupt failed: ${String(error)}`);
    });
  }

  function contextFrom(result: JsonObject): string {
    return string(object(result.hookSpecificOutput).additionalContext);
  }

  function canReplaceEmptyThread(error: unknown): boolean {
    if (!(error instanceof Error) || error.message !== `no rollout found for thread id ${spec.codexThreadId}`) return false;
    try {
      return fs.readFileSync(emptyThread, 'utf8') === spec.codexThreadId;
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
      return false;
    }
  }

  async function nextPrompt(): Promise<void> {
    if (active || stopping || !threadId) return;
    const prompt = prompts.shift();
    if (!prompt) return;
    let accepted: () => void = () => {};
    const confirmation = new Promise<void>((resolve) => { accepted = resolve; });
    const turn: ActiveTurn = { id: null, submitted: false, accepted: confirmation, interrupt: false, interruptSent: false, continuation: prompt.continuation, reply: '' };
    active = turn;
    if (prompt.echo) say(`> ${prompt.text}`);

    try {
      const preview = await callHost(spec, 'GET', '/managed/context', undefined, 5_000, inbox.signal);
      if (stopping) return;
      if (turn.interrupt) {
        await hook('Stop', { is_interrupt: true });
        active = null;
        void nextPrompt().catch(fail);
        return;
      }
      const context = [startContext, string(preview.text)].filter(Boolean).join('\n\n');
      // The app server may persist history as soon as it receives the request.
      fs.rmSync(emptyThread, { force: true });
      turn.submitted = true;
      const result = await app.request('turn/start', {
        threadId,
        clientUserMessageId: prompt.id,
        input: [{ type: 'text', text: context ? `${prompt.text}\n\n${context}` : prompt.text, text_elements: [] }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      });
      if (stopping) return;
      turn.id = string(object(result.turn).id);
      if (!turn.id) throw new Error('Codex app-server returned no turn ID');
      if (turn.interrupt) interrupt();
      startContext = '';
      await hook('UserPromptSubmit', {
        prompt: prompt.text, prompt_id: prompt.id, orch_codex_context_rev: string(preview.rev) || null,
      });
    } finally {
      accepted();
    }
  }

  /**
   * What Codex was told it does not have (the switches above) and still started: the worker stops there, whatever turn
   * it belongs to, as the event arrives (not behind the events still being handled). A newer Codex that ignored a
   * switch must not get a shell that asks nobody.
   */
  function stopIfForbidden(method: string, params: JsonObject): boolean {
    if (stopping || (method !== 'item/started' && method !== 'item/completed')) return false;
    const why = forbidden(object(params.item), scratchRoots);
    if (!why) return false;
    if (active?.id) void app.request('turn/interrupt', { threadId, turnId: active.id }).catch(() => undefined);
    say(`Stopped: ${why}.`);
    endReason = why;
    fail(new Error(why));
    return true;
  }

  async function onEvent(method: string, params: JsonObject): Promise<void> {
    if (!threadId || params.threadId !== threadId || !active?.submitted || stopping) return;
    const turn = active;
    await turn.accepted;
    if (stopping || active !== turn) return;
    const detail = object(params.turn);
    const id = string(params.turnId ?? detail.id);
    if (!turn.id || id !== turn.id) return;

    const item = object(params.item);
    if ((method === 'item/started' || method === 'item/completed') && item.type === 'mcpToolCall') {
      const name = `mcp__${string(item.server)}__${string(item.tool)}`;
      const started = method === 'item/started';
      const failed = item.status === 'failed' || object(item.result).isError === true;
      if (started) say(`  ${name}`);
      await hook(started ? 'PreToolUse' : failed ? 'PostToolUseFailure' : 'PostToolUse', {
        tool_name: name,
        tool_use_id: item.id,
        tool_input: item.arguments,
        ...(started ? { orch_said: turn.reply } : { tool_response: item.result, error: object(item.error).message }),
      });
    }
    if (method === 'item/completed' && item.type === 'agentMessage') {
      const reply = string(item.text);
      if (reply) {
        turn.reply = reply;
        say(reply);
      }
    }
    if (method !== 'turn/completed') return;

    const status = string(detail.status);
    const data = { last_assistant_message: turn.reply, duration_ms: detail.durationMs, stop_hook_active: turn.continuation };
    let continuation = '';
    if (status === 'completed' && !turn.interrupt) {
      const decision = await hook('Stop', data);
      if (decision.decision === 'block') continuation = string(decision.reason);
    } else if (status === 'interrupted' || turn.interrupt) {
      await hook('Stop', { ...data, is_interrupt: true });
    } else {
      const message = string(object(detail.error).message);
      if (message) say(message);
      await hook('StopFailure', { ...data, message });
    }
    active = null;
    if (continuation && !turn.interrupt) enqueue(continuation, true, true);
    else void nextPrompt().catch(fail);
  }

  const childEnded = app.exit.then((message) => {
    if (!stopping) fail(message);
  });
  try {
    await app.request('initialize', {
      clientInfo: { name: 'orchestrator', title: 'Orchestrator', version: '0.1.0' },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    app.notify('initialized');
    const options = {
      cwd: scratch,
      ...(spec.model ? { model: spec.model } : {}),
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      developerInstructions: `${spec.appendSystemPrompt}
The native Codex working directory is private scratch space. The employee’s selected workspace is ${spec.cwd}. Use the workspace MCP tools for the selected directory, including write_file when provided. Its file policy is enforced independently of the native sandbox.`,
    };
    let resumed = Boolean(spec.codexThreadId);
    let result: JsonObject;
    try {
      result = await (resumed
        ? app.request('thread/resume', { ...options, threadId: spec.codexThreadId })
        : app.request('thread/start', options));
    } catch (error) {
      if (!resumed || !canReplaceEmptyThread(error)) throw error;
      resumed = false;
      result = await app.request('thread/start', options);
    }
    threadId = string(object(result.thread).id);
    if (!threadId || (resumed && threadId !== spec.codexThreadId)) {
      threadId = '';
      throw new Error('Codex app-server returned an unexpected thread ID');
    }
    const sandbox = object(result.sandbox);
    if (result.approvalPolicy !== 'never' || sandbox.type !== 'workspaceWrite' || sandbox.networkAccess !== false || string(result.cwd) !== scratch || !Array.isArray(sandbox.writableRoots) || sandbox.writableRoots.some((dir) => dir !== scratch) || sandbox.excludeTmpdirEnvVar !== true || sandbox.excludeSlashTmp !== true) {
      threadId = '';
      throw new Error('Codex app-server did not confirm private scratch permissions');
    }
    if (!resumed) fs.writeFileSync(emptyThread, threadId, { mode: 0o600 });
    const started = await hook('SessionStart', { source: resumed ? 'resume' : 'startup' });
    startContext = contextFrom(started);
    say(`◆ ${spec.displayName} — Codex worker · ${string(result.model) || spec.model || 'default'} · scoped workspace tools`);

    void (async () => {
      while (!stopping) {
        const item = await callHost(spec, 'GET', '/managed/inbox?wait=25', undefined, 40_000, inbox.signal);
        if (stopping) break;
        if (item.type === 'prompt') enqueue(string(item.text), true, false, string(item.id ?? item.promptId) || undefined);
        else if (item.type === 'interrupt') interrupt();
        else if (item.type === 'exit') stopWorker();
        else await new Promise<void>((resolve) => setTimeout(resolve, 300));
      }
    })().catch(fail);
    await Promise.race([done, childEnded]);
    if (failure) throw failure;
  } finally {
    stopWorker();
    app.close();
    if (threadId) await hook('SessionEnd', { reason: endReason });
  }
}
