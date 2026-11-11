/**
 * This computer's place in an office, on Windows.
 *
 * Claude Code workers run in tmux, which Windows does not have — WSL2 does. So the desktop app, which runs on
 * Windows (and draws the office with the real graphics card), starts the personal host inside the person's WSL
 * distribution: the relay, the enrolment and the host agent all run there, exactly as on Linux
 * (personal-host.cjs through personal-host-cli.cjs). Their sessions, folders and Claude account are the WSL ones.
 *
 * Nothing has to be installed in WSL by hand except what a Linux computer needs anyway: Node.js 22.18+, tmux and
 * the Claude Code CLI. The three files the host consists of are written into the distribution on every start
 * (`~/.orchestrator/desktop-host/`), so they always match the app that started them — also when the app is
 * packaged and its files are not reachable from WSL.
 *
 * One `wsl.exe` process is started, with a script on its standard input and no command line to quote: the script
 * writes the files, finds a Node.js that is new enough and replaces itself with the host, which reads what is left
 * of the same input (the office to join, with the member's token) and reports its state on standard output.
 */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** `wsl.exe` for the default distribution, or the one named in ORCH_WSL_DISTRO. */
const wslArgs = () => (process.env.ORCH_WSL_DISTRO ? ['-d', process.env.ORCH_WSL_DISTRO] : []);

/** wsl.exe's own messages come in UTF-16; what a Linux program prints comes as it is. Make either readable. */
const plain = (buf) => String(buf || '').replace(/\0/g, '').trim();

/**
 * A Windows path as WSL sees it (`D:\Work` → `/mnt/d/Work`). A folder of the distribution itself, reached from Windows
 * (`\\wsl.localhost\Ubuntu\home\mila`, `\\wsl$\…`), is that folder; a path that is already a Linux one is kept;
 * anything else — another computer's share — is dropped.
 */
function toWslPath(p) {
  const s = String(p || '').trim();
  if (s.startsWith('/')) return s;
  const own = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/][^\\/]+(.*)$/i.exec(s);
  if (own) return own[1].replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  const m = /^([A-Za-z]):[\\/]*(.*)$/.exec(s);
  if (!m) return null;
  const rest = m[2].replace(/\\/g, '/').replace(/\/+$/, '');
  return `/mnt/${m[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/**
 * Where sessions on this computer may work, besides the WSL home (which the host adds itself): the person's Windows
 * profile folder — what a home folder is on macOS and Linux — and whatever ORCH_PERSONAL_ROOTS names (`;`-separated,
 * Windows or WSL paths), for code that lives on another drive.
 */
function windowsRoots() {
  const extra = String(process.env.ORCH_PERSONAL_ROOTS || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([os.homedir(), ...extra].map(toWslPath).filter(Boolean))];
}

/** A file of the app as a here-document: `cat > "$dir/<name>" <<'<mark>'`. The mark is random, so no line of the file can end it early. */
function hereDoc(name, text, mark) {
  return `cat > "$dir/${name}" <<'${mark}'\n${text.replace(/\r\n/g, '\n').replace(/\n?$/, '\n')}${mark}\n`;
}

/** What `bash -s` runs inside WSL before it becomes the host. Plain sh-compatible bash; no arguments, nothing from outside but $HOME. */
function bootstrap(files) {
  const mark = `ORCH_EOF_${crypto.randomBytes(12).toString('hex')}`;
  const unavailable = (reason) => `printf '%s\\n' '${JSON.stringify({ state: 'unavailable', reason, hostId: null }).replace(/'/g, `'\\''`)}'; exit 0`;
  return [
    'set -e',
    'dir="$HOME/.orchestrator/desktop-host"',
    'mkdir -p "$dir"',
    'chmod 700 "$dir"',
    ...Object.entries(files).map(([name, text]) => hereDoc(name, text, mark)),
    // A Node.js new enough to run the agent: the one on PATH, or the usual places a newer one is installed for one user.
    'node=""',
    'for c in "${ORCH_NODE:-}" node "$HOME/.local/node22/bin/node" "$HOME"/.nvm/versions/node/*/bin/node "$HOME/.volta/bin/node" /usr/local/bin/node; do',
    '  [ -n "$c" ] || continue',
    `  if "$c" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' >/dev/null 2>&1; then node="$c"; fi`,
    '  [ -z "$node" ] || break',
    'done',
    `if [ -z "$node" ]; then ${unavailable('Sessions on this computer run in WSL, and they need Node.js 22.18 or newer there (none was found: install it in your WSL distribution, or set ORCH_NODE to its path).')}; fi`,
    // The agent starts `claude`, `tmux` and `git` by name: make sure the per-user install folder and this Node.js are on PATH.
    'case "$node" in */*) PATH="$(dirname "$node"):$PATH" ;; esac',
    'export PATH="$HOME/.local/bin:$PATH"',
    'cd "$HOME"',
    'exec "$node" "$dir/personal-host-cli.cjs"',
    '',
  ].join('\n');
}

/**
 * Start this computer's host in an office, inside WSL. Same contract as `startPersonalHost`: `onState` is told
 * { state, reason, hostId }, and the result has `state()` and `stop()`.
 */
function startPersonalHostInWsl({ address, token, fingerprint, agentEntry, onState }) {
  let stopped = false;
  let child = null;
  let state = { state: 'starting', reason: null, hostId: null };
  const set = (next) => {
    state = { ...state, ...next };
    try {
      onState(state);
    } catch {
      /* the window is gone */
    }
  };
  const unavailable = (reason) => set({ state: 'unavailable', reason });

  // Not in the same tick: the caller keeps the returned object before the first state arrives, as on other platforms.
  setImmediate(() => {
    if (stopped) return;
    try {
      // The bundled agent is one file with nothing to install beside it; the TypeScript sources are not.
      if (!agentEntry || !/\.mjs$/.test(agentEntry) || !fs.existsSync(agentEntry)) {
        return unavailable('Sessions on this computer need the bundled host agent, which this copy of the app does not have yet (from the repository: pnpm build).');
      }
      const probe = spawnSync('wsl.exe', [...wslArgs(), '-e', 'true'], { timeout: 30000, windowsHide: true });
      if (probe.error || probe.status !== 0) {
        return unavailable(`Sessions on this computer run in WSL2, which did not start${plain(probe.stderr) || plain(probe.stdout) ? `: ${(plain(probe.stderr) || plain(probe.stdout)).split('\n').pop()}` : ''}. Install it with "wsl --install" (Ubuntu), then tmux, Node.js 22.18+ and Claude Code inside it. Everything shared in this office works without it.`);
      }
      const files = {
        'personal-host.cjs': fs.readFileSync(path.join(__dirname, 'personal-host.cjs'), 'utf8'),
        'personal-host-cli.cjs': fs.readFileSync(path.join(__dirname, 'personal-host-cli.cjs'), 'utf8'),
        'orchestrator-agent.mjs': fs.readFileSync(agentEntry, 'utf8'),
      };
      // A login shell (-l), so the person's own PATH applies; the script comes on standard input (-s).
      child = spawn('wsl.exe', [...wslArgs(), '-e', 'bash', '-l', '-s'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => {
        out += d;
        let nl;
        while ((nl = out.indexOf('\n')) >= 0) {
          const line = out.slice(0, nl).trim();
          out = out.slice(nl + 1);
          if (!line.startsWith('{')) continue; // whatever a login shell printed
          try {
            const s = JSON.parse(line);
            if (s && typeof s.state === 'string' && !stopped) set({ state: s.state, reason: s.reason ?? null, hostId: s.hostId ?? null });
          } catch {
            /* not ours */
          }
        }
      });
      child.stderr.on('data', (d) => (err = (err + plain(d)).slice(-2000)));
      child.stdin.on('error', () => {
        /* WSL went away while we were writing; the exit below says so */
      });
      child.on('error', (e) => !stopped && unavailable(`WSL could not be started: ${e.message}`));
      child.on('exit', (code) => {
        child = null;
        if (stopped) return;
        // The host says itself why it cannot run; only an exit it did not explain is reported from here.
        if (state.state !== 'unavailable') unavailable(`The host in WSL stopped (${code}). ${err.split('\n').pop() || ''}`.trim());
      });
      // The script first, then the one line the host reads. The pipe stays open: closing it is how the host is told to stop.
      child.stdin.write(bootstrap(files));
      // For the automated tests only (see personal-host.cjs, applyTestKnobs): these name things inside WSL.
      const env = Object.fromEntries(['ORCH_OFFICES_HOME', 'ORCH_TMUX_SOCKET', 'ORCH_CLAUDE_BIN', 'ORCH_ALLOW_ROOT'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
      child.stdin.write(`${JSON.stringify({ address, token, fingerprint, agentEntry: '.orchestrator/desktop-host/orchestrator-agent.mjs', allowedRoots: ['~', ...windowsRoots()], env })}\n`);
    } catch (e) {
      unavailable(e.message);
    }
  });

  return {
    state: () => state,
    stop: () => {
      if (stopped) return;
      stopped = true;
      const c = child;
      if (c) {
        // Closing its input asks the host to stop the agent and the relay; the tmux sessions stay, as everywhere.
        try {
          c.stdin.end();
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          if (c.exitCode === null) c.kill();
        }, 3000).unref();
      }
      set({ state: 'stopped', reason: null });
    },
  };
}

module.exports = { startPersonalHostInWsl, toWslPath, windowsRoots, bootstrap };
