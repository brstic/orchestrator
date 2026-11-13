import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Tmux, buildHooksSettings, claudeVersion } from '@orchestrator/execution';
import { HostAgent, enroll } from './agent.ts';
import { AGENT_VERSION, agentHome, isLoopback, loadConfig, paths, saveConfig } from './config.ts';
import { SDK_PACKAGE, installSdk, locateSdk } from './sdk.ts';

const HELP = `orchestrator-agent ${AGENT_VERSION} — connects this machine's Claude Code sessions to an Orchestrator office

USAGE
  orchestrator-agent <command> [options]

COMMANDS
  login     --server <url> --token <enrollment-token> [--name <host-name>] [--allow-root <dir>]...
              Enroll this machine. The token is created in the office (Server Room → Enroll host)
              or printed by the server at startup in local mode.
  connect   [--daemon] [--allow-root <dir>]...
              Run the agent (foreground by default). Makes one outbound connection to the server;
              no inbound ports are opened.
  status    Show whether the agent is running, connected, and what it is tracking.
  sessions list
              List tmux sessions on this machine and which are connected to the office.
  attach    --tmux-session <name> [--pane <%id>] [--employee <name>] [--role <role>]
              Connect an already-running tmux session (e.g. an existing Claude Code session)
              to an employee. Non-destructive: the process is not restarted.
  create    --name <employee-name> --project <dir> [--role <role>] [--model <model>] [--autonomy <level>]
              Create an employee and start a managed Claude Code worker for it in <dir>.
  hooks install --project <dir>
              Add Orchestrator hooks to <dir>/.claude/settings.local.json so sessions started there
              report real activity even when they were not launched by Orchestrator.
  hooks uninstall --project <dir>
  sdk status | sdk install [--version <v>]
              SDK-managed workers (an optional runtime: prompts, approvals and interrupts go through
              the Claude Agent SDK instead of the terminal). \`install\` puts the SDK in the agent's
              own state directory with npm; restart the agent afterwards.
  service install | service uninstall
              Install/remove a user service (launchd on macOS, systemd --user on Linux) that keeps
              the agent connected.
  stop      Stop the running agent (tmux sessions keep running).
  logout    Forget the server credential on this machine.
  version

ENVIRONMENT
  ORCH_AGENT_HOME   State directory (default ~/.orchestrator/agent)

ROLES     backend, frontend, fullstack, architect, devops, security, qa, database,
          performance, reverse, researcher, docs, pm, reviewer
AUTONOMY  standard | auto
`;

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** Talk to the running daemon over its private unix socket. */
function control<T = any>(pathname: string, body?: unknown, timeoutMs = 95000): Promise<T> {
  const home = agentHome();
  const cfg = loadConfig(home);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: paths(home).socket,
        path: pathname,
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-orch-local': cfg.localToken, 'content-type': 'application/json' },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed: any = {};
          try {
            parsed = JSON.parse(data || '{}');
          } catch {
            return reject(new Error(`unexpected response from agent: ${data.slice(0, 200)}`));
          }
          if ((res.statusCode ?? 500) >= 400) reject(new Error(parsed.error ?? `agent returned ${res.statusCode}`));
          else resolve(parsed);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('agent did not answer in time')));
    req.on('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') reject(new Error('the agent is not running on this machine (start it with `orchestrator-agent connect`)'));
      else reject(e);
    });
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function table(rows: string[][]): string {
  if (!rows.length) return '';
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ').trimEnd()).join('\n');
}

async function cmdLogin(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { server: { type: 'string' }, token: { type: 'string' }, name: { type: 'string' }, 'allow-root': { type: 'string', multiple: true }, insecure: { type: 'boolean' } },
  });
  // The token may come from the environment, so it does not show up in the process list.
  values.token ??= process.env.ORCH_ENROLLMENT_TOKEN;
  if (!values.server || !values.token) die('login needs --server <url> and --token <enrollment-token>');
  const server = values.server.replace(/\/+$/, '');
  const u = new URL(server);
  if (u.protocol !== 'https:' && u.protocol !== 'wss:' && !isLoopback(server) && !values.insecure) {
    die(`${server} is not TLS and not loopback. Use an https:// URL (or pass --insecure to accept an unencrypted connection on a trusted network).`);
  }
  const home = agentHome();
  const cfg = loadConfig(home);
  if (values.name) cfg.name = values.name;
  if (values['allow-root']?.length) cfg.allowedRoots = values['allow-root'].map((r) => path.resolve(r));
  const tmux = new Tmux({ socketName: cfg.tmuxSocketName });
  const info = {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    agentVersion: AGENT_VERSION,
    tmuxVersion: await tmux.version(),
    claudeVersion: await claudeVersion(cfg.claudeBin),
    cpus: os.cpus().length,
    totalMemBytes: os.totalmem(),
    user: os.userInfo().username,
  };
  const res = await enroll(server, values.token, cfg.name, info).catch((e) => die(`enrollment failed: ${e.message}`));
  cfg.serverUrl = server;
  cfg.hostId = res.hostId;
  cfg.credential = res.credential;
  cfg.name = res.name;
  saveConfig(cfg, home);
  console.log(`Enrolled as host "${res.name}" (${res.hostId}).`);
  console.log(`Allowed roots: ${cfg.allowedRoots.join(', ')}`);
  if (!info.tmuxVersion) console.log('warning: tmux is not installed; install it before creating or attaching sessions.');
  if (!info.claudeVersion) console.log('warning: the claude CLI was not found on PATH.');
  console.log('Next: orchestrator-agent connect');
}

async function cmdConnect(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { daemon: { type: 'boolean' }, 'allow-root': { type: 'string', multiple: true }, quiet: { type: 'boolean' }, server: { type: 'string' } } });
  // The agent starts long-lived things (the tmux server): never from a directory that may go away.
  try {
    process.chdir(os.homedir());
  } catch {
    /* keep the current directory */
  }
  const home = agentHome();
  const cfg = loadConfig(home);
  if (values['allow-root']?.length) {
    cfg.allowedRoots = values['allow-root'].map((r) => path.resolve(r));
    saveConfig(cfg, home);
  }
  // The office may be reached at a new address (an SSH link whose tunnel moved to another port).
  if (values.server && values.server.replace(/\/+$/, '') !== cfg.serverUrl) {
    const server = values.server.replace(/\/+$/, '');
    const u = new URL(server);
    if (u.protocol !== 'https:' && u.protocol !== 'wss:' && !isLoopback(server)) die(`${server} is not TLS and not loopback`);
    cfg.serverUrl = server;
    saveConfig(cfg, home);
  }
  if (!cfg.serverUrl || !cfg.credential) die('not logged in. Run: orchestrator-agent login --server <url> --token <enrollment-token>');
  if (values.daemon) {
    const p = paths(home);
    const out = fs.openSync(p.log, 'a');
    const self = fileURLToPath(import.meta.url);
    const child = spawn(process.execPath, [self, 'connect'], { detached: true, stdio: ['ignore', out, out], env: process.env });
    child.unref();
    console.log(`orchestrator-agent started in the background (pid ${child.pid}); logs: ${p.log}`);
    return;
  }
  const agent = new HostAgent(cfg, home, values.quiet ? () => undefined : undefined);
  await agent.start();
  const shutdown = () => {
    void agent.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Keep running until signalled or revoked.
  const check = setInterval(() => {
    if (agent.rejection) {
      clearInterval(check);
      console.error(`The server refused this host: ${agent.rejection}`);
      void agent.stop().then(() => process.exit(2));
    }
  }, 1000);
}

async function cmdStatus(): Promise<void> {
  const cfg = loadConfig();
  let st: any;
  try {
    st = await control('/control/status', undefined, 8000);
  } catch (e) {
    console.log(`agent:   not running (${(e as Error).message})`);
    console.log(`server:  ${cfg.serverUrl ?? '(not logged in)'}`);
    console.log(`host:    ${cfg.name}${cfg.hostId ? ` (${cfg.hostId})` : ''}`);
    process.exitCode = 1;
    return;
  }
  console.log(`agent:   running (pid ${st.pid}, v${st.version})`);
  console.log(`server:  ${st.serverUrl} — ${st.connected ? 'connected' : st.rejected ? `rejected: ${st.rejected}` : 'disconnected (retrying)'}`);
  console.log(`host:    ${st.name} (${st.hostId ?? 'not enrolled'})`);
  console.log(`tmux:    ${st.info?.tmuxVersion ?? 'not found'}    claude: ${st.info?.claudeVersion ?? 'not found'}`);
  console.log(`roots:   ${st.allowedRoots.join(', ')}`);
  if (st.pendingEvents) console.log(`queued:  ${st.pendingEvents} events waiting for the server`);
  const sessions = st.sessions as any[];
  if (!sessions.length) console.log('sessions: none connected');
  else {
    console.log('sessions:');
    console.log(
      table([
        ['  TMUX', 'ORIGIN', 'STATE', 'HOOKS', 'MCP', 'CWD'],
        ...sessions.map((s) => ['  ' + s.tmuxSession, s.origin, s.alive ? 'running' : 'stopped', s.capabilities.hooks ? 'yes' : 'no', s.capabilities.mcp ? 'yes' : 'no', s.cwd]),
      ]),
    );
  }
  if (st.server?.employees?.length) {
    console.log('employees on this host:');
    console.log(table([['  NAME', 'ROLE', 'ACTIVITY', 'TASK'], ...st.server.employees.map((e: any) => ['  ' + e.name, e.title, e.activity, e.task ?? '-'])]));
  }
}

async function cmdSessions(argv: string[]): Promise<void> {
  if (argv[0] && argv[0] !== 'list') die(`unknown subcommand "sessions ${argv[0]}"`);
  let panes: any[];
  try {
    panes = (await control('/control/discover', undefined, 8000)).panes;
  } catch {
    // The daemon is not running: fall back to reading tmux directly.
    const cfg = loadConfig();
    const tmux = new Tmux({ socketName: cfg.tmuxSocketName });
    panes = (await tmux.listPanes()).map((p) => ({ tmuxSession: p.sessionName, paneId: p.paneId, command: p.currentCommand, cwd: p.currentPath, size: `${p.width}x${p.height}`, dead: p.dead, looksLikeClaude: /claude/i.test(p.currentCommand + p.startCommand), connectedAs: null }));
    console.log('(agent not running — showing local tmux sessions only)');
  }
  if (!panes.length) return console.log('No tmux sessions on this machine.');
  console.log(
    table([
      ['TMUX SESSION', 'PANE', 'COMMAND', 'CLAUDE?', 'CONNECTED', 'CWD'],
      ...panes.map((p) => [p.tmuxSession, p.paneId, p.command + (p.dead ? ' (dead)' : ''), p.looksLikeClaude ? 'yes' : '-', p.connectedAs ? 'yes' : 'no', p.cwd]),
    ]),
  );
}

async function cmdAttach(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { 'tmux-session': { type: 'string' }, pane: { type: 'string' }, employee: { type: 'string' }, role: { type: 'string' } } });
  if (!values['tmux-session']) die('attach needs --tmux-session <name>');
  const res = await control('/control/attach', { tmuxSession: values['tmux-session'], pane: values.pane ?? null, employee: values.employee ?? null, role: values.role ?? null }).catch((e) => die(e.message));
  console.log(`Attached tmux session "${res.session.tmuxSession}" (${res.session.tmuxPane}) — the running process was not touched.`);
  if (res.warning) console.log(`warning: ${res.warning}`);
  else if (res.bound?.employee) console.log(`Employee: ${res.bound.employee.name} (${res.bound.employee.title})${res.bound.created ? ' — newly created' : ''}`);
  console.log('This session is terminal-only (observe / take control). Run `orchestrator-agent hooks install --project <dir>` to also report real activity from sessions started there.');
}

async function cmdCreate(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { name: { type: 'string' }, project: { type: 'string' }, role: { type: 'string' }, model: { type: 'string' }, autonomy: { type: 'string' } } });
  if (!values.name || !values.project) die('create needs --name <employee-name> and --project <dir>');
  const project = path.resolve(values.project.replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(project)) die(`project directory does not exist: ${project}`);
  const res = await control('/control/create', { name: values.name, project, role: values.role ?? null, model: values.model ?? null, autonomy: values.autonomy ?? null }).catch((e) => die(e.message));
  console.log(`Employee "${res.employee.name}" (${res.employee.title}) is at their desk.`);
  console.log(`Claude Code worker running in tmux session "${res.session.tmuxSession}" — cwd ${res.session.cwd}`);
}

function settingsLocalPath(project: string): string {
  return path.join(project, '.claude', 'settings.local.json');
}

const HOOK_MARK = 'http://orchestrator/hook';

async function cmdHooks(argv: string[]): Promise<void> {
  const sub = argv[0];
  const { values } = parseArgs({ args: argv.slice(1), options: { project: { type: 'string' } } });
  if (!values.project) die('hooks needs --project <dir>');
  const project = path.resolve(values.project);
  const file = settingsLocalPath(project);
  const home = agentHome();
  const cfg = loadConfig(home);
  let settings: any = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      die(`${file} is not valid JSON; fix it first`);
    }
  }
  settings.hooks = settings.hooks ?? {};
  // Drop our previous entries (identified by the hook URL) and leave everything else alone.
  for (const [event, entries] of Object.entries<any[]>(settings.hooks)) {
    settings.hooks[event] = (entries ?? []).filter((e) => !JSON.stringify(e).includes(HOOK_MARK));
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  if (sub === 'install') {
    const ours = buildHooksSettings({ socketPath: paths(home).socket, token: cfg.localToken, sessionId: null, claudeVersion: await claudeVersion(cfg.claudeBin), approvalWaitSeconds: cfg.approvalWaitSeconds, events: cfg.hookEvents });
    for (const [event, entries] of Object.entries(ours)) settings.hooks[event] = [...(settings.hooks[event] ?? []), ...(entries as any[])];
  } else if (sub !== 'uninstall') die('usage: orchestrator-agent hooks install|uninstall --project <dir>');
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  console.log(sub === 'install' ? `Installed Orchestrator hooks in ${file}.\nSessions started in this project from now on will report activity when they run inside a tmux session that is attached to the office.` : `Removed Orchestrator hooks from ${file}.`);
}

function cmdService(argv: string[]): void {
  const sub = argv[0];
  const self = fileURLToPath(import.meta.url);
  const node = process.execPath;
  const home = agentHome();
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.orchestrator.agent.plist');
    if (sub === 'uninstall') {
      spawn('launchctl', ['unload', plist], { stdio: 'ignore' }).on('close', () => {
        fs.rmSync(plist, { force: true });
        console.log(`Removed ${plist}`);
      });
      return;
    }
    if (sub !== 'install') die('usage: orchestrator-agent service install|uninstall');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.orchestrator.agent</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${self}</string><string>connect</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${process.env.PATH ?? '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin'}</string>
    <key>ORCH_AGENT_HOME</key><string>${home}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${paths(home).log}</string>
  <key>StandardErrorPath</key><string>${paths(home).log}</string>
</dict></plist>
`;
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, xml);
    console.log(`Wrote ${plist}\nEnable it with:  launchctl load ${plist}`);
    return;
  }
  if (process.platform === 'linux') {
    const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'orchestrator-agent.service');
    if (sub === 'uninstall') {
      fs.rmSync(unit, { force: true });
      console.log(`Removed ${unit}\nRun: systemctl --user daemon-reload`);
      return;
    }
    if (sub !== 'install') die('usage: orchestrator-agent service install|uninstall');
    const text = `[Unit]
Description=Orchestrator host agent
After=network-online.target

[Service]
ExecStart=${node} ${self} connect
Environment=ORCH_AGENT_HOME=${home}
Environment=PATH=${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, text);
    console.log(`Wrote ${unit}\nEnable it with:  systemctl --user daemon-reload && systemctl --user enable --now orchestrator-agent\nTo keep it running after logout:  loginctl enable-linger $USER`);
    return;
  }
  die('service install supports macOS (launchd) and Linux (systemd). On Windows run the agent inside WSL2.');
}

async function cmdSdk(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  const home = agentHome();
  const cfg = loadConfig(home);
  if (sub === 'install') {
    const { values } = parseArgs({ args: rest, options: { version: { type: 'string' } } });
    console.log(`Installing ${SDK_PACKAGE}${values.version ? `@${values.version}` : ''} into ${home} …`);
    const code = await installSdk(home, values.version ?? null).catch((e) => die(`could not run npm: ${e.message}`));
    if (code !== 0) die(`npm exited with status ${code}`);
    const found = locateSdk(cfg, home);
    if (!found) die('npm finished but the SDK was not found afterwards');
    console.log(`Installed Claude Agent SDK ${found.version ?? ''} (${found.entry}).`);
    console.log('Restart the agent (orchestrator-agent stop && orchestrator-agent connect --daemon) so the office sees the new runtime.');
    return;
  }
  if (sub === 'status' || sub === undefined) {
    const found = locateSdk(cfg, home);
    if (found) console.log(`Claude Agent SDK ${found.version ?? '(unknown version)'}\n  ${found.entry}\n  found via: ${found.source}\nThis host can run SDK-managed workers.`);
    else console.log(`Claude Agent SDK: not installed${cfg.sdkPath ? ` (sdkPath ${cfg.sdkPath} has no SDK)` : ''}.\nThis host runs interactive Claude Code workers only. Install it with: orchestrator-agent sdk install`);
    return;
  }
  die('usage: orchestrator-agent sdk status | sdk install [--version <v>]');
}

/** Internal: the process inside an SDK-managed worker's tmux pane. Started by the agent, not by people. */
async function cmdManagedRun(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { spec: { type: 'string' } } });
  if (!values.spec) die('managed-run needs --spec <file>');
  const { runManaged } = await import('./managed-runner.ts');
  try {
    await runManaged(values.spec);
    process.exit(0);
  } catch (e) {
    process.stdout.write(`\r\n\x1b[31mSDK-managed worker stopped: ${(e as Error).message}\x1b[0m\r\n`);
    process.exit(1);
  }
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'sdk':
        return await cmdSdk(rest);
      case 'managed-run':
        return await cmdManagedRun(rest);
      case 'login':
        return await cmdLogin(rest);
      case 'connect':
        return await cmdConnect(rest);
      case 'status':
        return await cmdStatus();
      case 'sessions':
        return await cmdSessions(rest);
      case 'attach':
        return await cmdAttach(rest);
      case 'create':
        return await cmdCreate(rest);
      case 'hooks':
        return await cmdHooks(rest);
      case 'service':
        return cmdService(rest);
      case 'stop':
        await control('/control/stop', {}).catch((e) => die(e.message));
        return console.log('Agent stopped. tmux sessions are still running.');
      case 'logout': {
        const cfg = loadConfig();
        cfg.credential = null;
        cfg.hostId = null;
        saveConfig(cfg);
        return console.log('Credential removed from this machine. Revoke the host in the office to invalidate it server-side.');
      }
      case 'version':
      case '--version':
      case '-v':
        return console.log(AGENT_VERSION);
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        return console.log(HELP);
      default:
        die(`unknown command "${cmd}". Run orchestrator-agent help.`);
    }
  } catch (e) {
    die((e as Error).message);
  }
}

/** Started directly (not imported)? Compared through realpath: the install may sit behind a symlink. */
function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntryPoint()) void main(process.argv.slice(2));
