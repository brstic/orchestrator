/**
 * A member's own servers in an office someone else hosts.
 *
 * The office can link servers over SSH itself (Machines → Connect a server), with the keys of whoever runs the
 * office — those are the office's servers. This is the other case: a server that only this member can reach, with
 * the SSH keys on *their* computer. So the reaching is done here, by the desktop app:
 *
 *   1. look at the server (nothing is changed): Linux or macOS, Node.js 22.18+, tmux, curl;
 *   2. ask the office for a one-time enrolment that makes the machine this member's (`POST /api/me/servers`);
 *   3. copy the host agent there and enrol it — the token goes over SSH's own channel, never on a command line;
 *   4. start the agent in the background. From then on it connects to the office by itself, through the door, and
 *      keeps doing so when this computer is off. SSH is used again only to look after it (start it after a reboot of
 *      the server, remove it).
 *
 * That last step is why the office must be reached at an address whose certificate computers trust (a domain): the
 * agent on the server has nobody to tell it which self-made certificate is the right one. An office reached by IP
 * address is refused here, in words, before anything is done on the server.
 *
 * Only the system's `ssh` is used, as the person, with BatchMode: their keys and agent, never a password; a host key
 * that is not known is refused unless they say they trust that server for the first connection.
 */
const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const net = require('node:net');
const { askOffice } = require('./personal-host.cjs');

const TARGET = /^(?:([A-Za-z0-9._][A-Za-z0-9._-]{0,63})@)?([A-Za-z0-9][A-Za-z0-9._-]{0,252})(?::(\d{1,5}))?$/;

/** `user@host[:port]`, `host`, `ssh://user@host:port` → what to hand to ssh. Nothing here can be read as an option. */
function parseTarget(input) {
  const text = String(input || '').trim().replace(/^ssh:\/\//i, '').replace(/\/+$/, '');
  const m = TARGET.exec(text);
  if (!m) throw new Error('Enter the server as user@host (or a name from your ~/.ssh/config), optionally with :port.');
  const port = m[3] ? Number(m[3]) : null;
  if (port !== null && (port < 1 || port > 65535)) throw new Error('That is not a valid port.');
  return { dest: m[1] ? `${m[1]}@${m[2]}` : m[2], port, host: m[2], text };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Folders on the server the office may work in: absolute, or under the home folder; nothing that climbs out. */
function cleanRoots(roots) {
  // (`~` alone is the home folder itself.)
  const out = (Array.isArray(roots) ? roots : []).map((r) => String(r).trim()).filter(Boolean).map((r) => (r === '~' ? '~/' : r));
  for (const r of out) if (!/^(\/|~\/)[A-Za-z0-9._ \/@+-]*$/.test(r) || r.includes('..')) throw new Error(`"${r}" is not a folder path the office can use (absolute, or ~/…).`);
  return out;
}

/** A folder path the way the server's shell is to read it: quoted, with `~` as the home folder there. */
const shPath = (r) => (r === '~' || r === '~/' ? '"$HOME"' : r.startsWith('~/') ? `"$HOME"/${shq(r.slice(2))}` : shq(r));

/** Where to look on the server: the home folder when nothing is named; otherwise held to the same rules as the folders themselves. */
function cleanBrowsePath(dir) {
  const d = String(dir == null ? '' : dir).trim();
  return d ? cleanRoots([d])[0] : '~/';
}

const USABLE_NAME = /^[A-Za-z0-9._ @+-]+$/;
/**
 * What the listing printed → where it is, and the folders in it. Only folders that can be named as a folder to work
 * in are kept (the same characters as `cleanRoots`); null when the folder could not be opened.
 */
function readListing(stdout) {
  const text = String(stdout);
  const pwd = (/^ORCH:PWD=(.*)$/m.exec(text) || [])[1];
  if (/^ORCH:NODIR$/m.test(text) || !pwd || !pwd.startsWith('/')) return null;
  const folders = [...text.matchAll(/^ORCH:DIR=(.*)$/gm)].map((m) => m[1]).filter((n) => USABLE_NAME.test(n) && !n.includes('..'));
  folders.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return {
    path: pwd,
    home: (/^ORCH:HOME=(.*)$/m.exec(text) || [])[1] || '',
    parent: pwd === '/' ? null : pwd.replace(/\/[^/]*$/, '') || '/',
    folders,
    // The folder itself can be chosen only when its own path is one the office can use.
    usable: /^\/[A-Za-z0-9._ \/@+-]*$/.test(pwd) && !pwd.includes('..'),
    more: /^ORCH:MORE$/m.test(text),
  };
}

/** Non-interactive SSH shells get a bare PATH; node, tmux and claude are usually in one of these. */
const PATH_PRELUDE = `for d in "$HOME/.local/bin" "$HOME/bin" "$HOME/.npm-global/bin" "$HOME/.volta/bin" "$HOME/.bun/bin" "$HOME/.claude/local" "$HOME/.asdf/shims" "$HOME/.local/share/fnm/aliases/default/bin" /usr/local/bin /opt/homebrew/bin /snap/bin; do [ -d "$d" ] && PATH="$d:$PATH"; done
ORCH_NVM=$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1 || true)
[ -n "\${ORCH_NVM:-}" ] && PATH="$ORCH_NVM:$PATH"
export PATH`;

const PROBE = `${PATH_PRELUDE}
echo "os=$(uname -s)"
echo "arch=$(uname -m)"
echo "hostname=$(hostname 2>/dev/null || uname -n)"
echo "user=$(id -un)"
echo "home=$HOME"
echo "node=$(node -v 2>/dev/null || true)"
echo "tmux=$(tmux -V 2>/dev/null || true)"
echo "claude=$(claude --version 2>/dev/null | head -1 || true)"
echo "git=$(git --version 2>/dev/null || true)"
echo "curl=$(command -v curl >/dev/null 2>&1 && echo yes || echo no)"
`;

/** What ssh said, in words the person can act on. */
function explain(stderr, target) {
  const text = String(stderr || '').trim();
  if (/Host key verification failed|No .* host key is known/i.test(text)) return `This computer has never connected to ${target} before, so the server's identity is not known. Connect once in a terminal (ssh ${target}) and accept its key — or tick "I trust this server" — then try again.`;
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(text)) return `The identity of ${target} is different from the one this computer remembers. That can mean the server was reinstalled, or that something is intercepting the connection. Nothing was sent. Check it in a terminal (ssh ${target}) before trying again.`;
  if (/Permission denied/i.test(text)) return `${target} did not accept any of your SSH keys. Set up key login (ssh-copy-id ${target}) or load your key (ssh-add), check that "ssh ${target}" works in a terminal without asking for a password, then try again. Passwords are never asked for or stored.`;
  if (/Could not resolve hostname/i.test(text)) return `The name "${target}" could not be found. Check the spelling, or use the server's address.`;
  if (/Connection timed out|Operation timed out|timed out/i.test(text)) return `${target} did not answer in time. Check that the server is on and reachable from this computer.`;
  if (/Connection refused/i.test(text)) return `${target} refused the connection: SSH is not listening there (wrong port?).`;
  return text.split('\n').filter(Boolean).slice(-3).join(' ') || 'ssh failed without saying why';
}

/** What the probe printed, as facts about the server and what stands in the way of using it. */
function readProbe(stdout, fallbackHost) {
  const kv = new Map(String(stdout).split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]));
  const get = (k) => kv.get(k) || null;
  const probe = { os: get('os') || 'unknown', arch: get('arch') || 'unknown', hostname: get('hostname') || fallbackHost, user: get('user') || '', home: get('home') || '', node: get('node'), tmux: get('tmux'), claude: get('claude'), git: get('git'), curl: get('curl') === 'yes', problems: [], warnings: [] };
  if (!/^(Linux|Darwin)$/.test(probe.os)) probe.problems.push(`The server runs ${probe.os}; employees need Linux or macOS.`);
  const [major, minor] = (probe.node || '').replace(/^v/, '').split('.').map(Number);
  if (!probe.node) probe.problems.push('Node.js is not installed on the server (22.18 or newer is needed to run the agent).');
  else if (!(major > 22 || (major === 22 && minor >= 18))) probe.problems.push(`Node.js ${probe.node} is too old on the server; 22.18 or newer is needed.`);
  if (!probe.tmux) probe.problems.push('tmux is not installed on the server; employees run inside tmux sessions.');
  if (!probe.curl) probe.problems.push('curl is not installed on the server; Claude Code hooks use it to report to the agent.');
  if (!probe.claude) probe.warnings.push('The claude CLI was not found on the server. Install Claude Code there (and log in once) before starting employees.');
  if (!probe.git) probe.warnings.push('git is not installed on the server; employees need it to work in repositories.');
  return probe;
}

/**
 * Can a computer that knows nothing but the address tell that this is the office? Yes when the certificate there is
 * one the system trusts for that name. (An IP address, or a certificate the office made itself, is not.)
 */
function publiclyTrusted(address) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(address);
    } catch {
      return resolve(false);
    }
    // (An IPv6 address is written in brackets in an address.)
    if (u.protocol !== 'https:' || net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) return resolve(false);
    const socket = tls.connect({ host: u.hostname, port: Number(u.port) || 443, servername: u.hostname, rejectUnauthorized: false });
    socket.setTimeout(8000, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
    socket.once('secureConnect', () => {
      const ok = socket.authorized === true;
      socket.destroy();
      resolve(ok);
    });
  });
}

/**
 * The servers this person brought into one office, and the means to look after them.
 * `office` is { address, token, fingerprint } of the office the app is in; `file` is where the list is kept on this
 * computer; `agentBundle` is the bundled host agent.
 */
function memberServers({ office, file, agentBundle, ssh = 'ssh', log = () => undefined }) {
  const key = crypto.createHash('sha256').update(`${office.fingerprint}|${new URL(office.address).host}`).digest('hex').slice(0, 16);
  const readAll = () => {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  };
  const list = () => (Array.isArray(readAll()[key]) ? readAll()[key] : []);
  const save = (records) => {
    const all = readAll();
    all[key] = records;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
  };
  /** What is being done to a server right now, for the window: id → { step, error }. */
  const doing = new Map();

  const sshArgs = (target, trustNewHost) => {
    const { dest, port } = parseTarget(target);
    const args = [];
    // Tests point at their own client configuration; nothing else reads this.
    if (process.env.ORCH_SSH_CONFIG) args.push('-F', process.env.ORCH_SSH_CONFIG);
    args.push('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3');
    if (trustNewHost) args.push('-o', 'StrictHostKeyChecking=accept-new');
    if (port) args.push('-p', String(port));
    return { args, dest };
  };

  /** Run a fixed command on the server, optionally feeding it input. The command never contains anything typed unquoted. */
  const exec = (target, trustNewHost, command, input, timeoutMs = 60000) => {
    const { args, dest } = sshArgs(target, trustNewHost);
    return new Promise((resolve) => {
      const child = execFile(ssh, [...args, dest, command], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : err.killed ? 124 : 255) : 0;
        resolve({ code, stdout: stdout || '', stderr: err && err.killed ? `${stderr || ''}\ntimed out` : err && err.code === 'ENOENT' ? 'The ssh program was not found on this computer.' : stderr || '' });
      });
      if (child.stdin) {
        child.stdin.on('error', () => undefined);
        child.stdin.end(input || '');
      }
    });
  };
  // Scripts go to the server's `sh` on standard input, with Unix line ends whatever this computer uses.
  const script = (target, trustNewHost, text, timeoutMs) => exec(target, trustNewHost, 'sh -s', String(text).replace(/\r\n/g, '\n'), timeoutMs);

  async function probe(target, trustNewHost = false) {
    const { dest, host } = parseTarget(target);
    const res = await script(target, trustNewHost, PROBE, 30000);
    if (res.code !== 0 && !/^os=/m.test(res.stdout)) throw new Error(explain(res.stderr, dest));
    return readProbe(res.stdout, host);
  }

  const api = async (method, route, body) => {
    const res = await askOffice(office.address, office.fingerprint, office.token, method, route, body);
    if (res.status >= 400 || !res.body) throw new Error((res.body && res.body.error) || `the office refused (${res.status})`);
    return res.body;
  };

  const agentHome = (id) => `$HOME/.orchestrator/member-servers/${id}`;
  // No folder named: the home folder on the server. It is always passed, so that taking a folder away takes effect
  // too (the agent keeps the folders it was last started with).
  const rootArgs = (roots) => (roots.length ? roots : ['~/']).map((r) => ` --allow-root ${shPath(r)}`).join('');

  /** Copy the agent to the server when the one there is another build, and write the small launcher beside it. */
  async function installAgent(rec, trustNewHost) {
    const { dest } = parseTarget(rec.target);
    if (!agentBundle || !fs.existsSync(agentBundle)) throw new Error('This copy of the app has no bundled host agent yet (from the repository: pnpm build).');
    const bundle = fs.readFileSync(agentBundle);
    const sha = crypto.createHash('sha256').update(bundle).digest('hex');
    const have = await script(rec.target, trustNewHost, `f="$HOME/.orchestrator/bin/orchestrator-agent.mjs"; if [ -f "$f" ]; then (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -d' ' -f1; fi`);
    const fresh = have.stdout.trim() !== sha;
    if (fresh) {
      const up = await exec(rec.target, trustNewHost, `sh -c 'umask 077; mkdir -p "$HOME/.orchestrator/bin" && cat > "$HOME/.orchestrator/bin/orchestrator-agent.mjs.new" && mv "$HOME/.orchestrator/bin/orchestrator-agent.mjs.new" "$HOME/.orchestrator/bin/orchestrator-agent.mjs"'`, bundle, 120000);
      if (up.code !== 0) throw new Error(`Could not copy the agent to ${dest}: ${explain(up.stderr, dest)}`);
    }
    const wrapper = await script(rec.target, trustNewHost, `set -eu\numask 077\nmkdir -p "$HOME/.orchestrator/bin" "${agentHome(rec.id)}"\ncat > "$HOME/.orchestrator/bin/orchestrator-agent" <<'ORCH_WRAPPER'\n#!/bin/sh\n${PATH_PRELUDE}\nexec node "$HOME/.orchestrator/bin/orchestrator-agent.mjs" "$@"\nORCH_WRAPPER\nchmod 700 "$HOME/.orchestrator/bin/orchestrator-agent"\n`);
    if (wrapper.code !== 0) throw new Error(`Could not prepare the agent on ${dest}: ${explain(wrapper.stderr, dest)}`);
    return fresh;
  }

  /** Make sure the agent on the server is enrolled with this office and running. `token` enrols it when it is not yet. Returns its host id, or null when a token is needed. */
  async function ensureAgent(rec, trustNewHost, token, restart) {
    const { dest } = parseTarget(rec.target);
    // The enrolment token is not part of a command line, here or on the server (it would show in a process list): it
    // is in the script, which travels on ssh's own channel to the shell's standard input, and is handed to the agent
    // in its environment. (Not read from the input by the script itself: some shells read their script ahead.)
    const res = await script(
      rec.target,
      trustNewHost,
      `set -eu
TOKEN=${shq(/^[A-Za-z0-9_-]*$/.test(token || '') ? token || '' : '')}
${PATH_PRELUDE}
export ORCH_AGENT_HOME="${agentHome(rec.id)}"
A="$HOME/.orchestrator/bin/orchestrator-agent"
URL=${shq(office.address)}
NAME=${shq(rec.name)}
CFG="$ORCH_AGENT_HOME/config.json"
enrolled() { [ -f "$CFG" ] && node -e "const c=require(process.argv[1]); process.exit(c.credential && c.hostId ? 0 : 1)" "$CFG"; }
if ! enrolled; then
  [ -n "$TOKEN" ] || { echo "ORCH:NEED_TOKEN"; exit 0; }
  ORCH_ENROLLMENT_TOKEN="$TOKEN" "$A" login --server "$URL" --name "$NAME"${rootArgs(rec.roots)} >/dev/null
fi
running() { [ -f "$ORCH_AGENT_HOME/agent.pid" ] && kill -0 "$(cat "$ORCH_AGENT_HOME/agent.pid")" 2>/dev/null; }
if running && [ ${restart ? '1' : '0'} = 1 ]; then
  "$A" stop >/dev/null 2>&1 || true
  # Until it is really gone (ten seconds at most): an agent that is still on its way out would be taken for a
  # running one, not be started again, and leave the server out of the office.
  i=0; while running && [ $i -lt 40 ]; do sleep 0.25; i=$((i+1)); done
fi
if ! running; then "$A" connect --daemon --server "$URL"${rootArgs(rec.roots)} >/dev/null; fi
echo "ORCH:HOST=$(node -e "console.log(require(process.argv[1]).hostId)" "$CFG")"
`,
      90000,
    );
    if (/ORCH:NEED_TOKEN/.test(res.stdout)) return null;
    const hostId = (/ORCH:HOST=([0-9a-f-]{8,})/.exec(res.stdout) || [])[1];
    if (!hostId) throw new Error(`Could not start the agent on ${dest}: ${(res.stderr.trim() || res.stdout.trim()).split('\n').slice(-3).join(' | ') || 'no output'}`);
    return hostId;
  }

  /** Wait until the office says the machine is here, and that it is this person's. */
  async function waitOnline(hostId, seconds) {
    for (let i = 0; i < seconds * 2; i++) {
      const mine = await api('GET', '/me/servers').catch(() => []);
      const host = Array.isArray(mine) ? mine.find((h) => h.id === hostId) : null;
      if (host && host.status === 'online') return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /** Bring a server into the office. Resolves when it is there; `onStep` is told what is being done, in words. */
  async function add(input, onStep = () => undefined) {
    const { dest, host, text } = parseTarget(input.target);
    const roots = cleanRoots(input.roots);
    const records = list();
    if (records.some((r) => r.target === text)) throw new Error(`${dest} is already one of your servers here.`);
    // (ORCH_MEMBER_SERVER_ANY_CERT is for the automated tests, whose office has only a certificate of its own and whose
    // stand-in server is told not to check it.)
    if (!process.env.ORCH_MEMBER_SERVER_ANY_CERT && !(await publiclyTrusted(office.address))) {
      throw new Error(`A server connects to the office by itself, so it has to recognise it: that needs an office reached at a domain with a certificate computers trust. This office is reached at ${new URL(office.address).host}, which has none. Ask its owner for the office's domain address, or have the server linked from the office's own computer (Machines).`);
    }
    const rec = { id: crypto.randomBytes(8).toString('hex'), target: text, name: String(input.name || '').trim().slice(0, 40) || host.split('.')[0], roots, hostId: null, createdAt: new Date().toISOString() };
    const trust = input.trustNewHost === true;
    const step = (s) => {
      doing.set(rec.id, { step: s, error: null });
      onStep(s);
    };
    try {
      step('Checking the server');
      const seen = await probe(rec.target, trust);
      if (seen.problems.length) throw new Error(seen.problems.join(' '));
      step('Installing the agent');
      await installAgent(rec, trust);
      step('Asking the office for a place');
      const { token } = await api('POST', '/me/servers', { name: rec.name });
      step('Starting the agent');
      const hostId = await ensureAgent(rec, trust, token, false);
      if (!hostId) throw new Error(`The agent on ${dest} could not be enrolled.`);
      rec.hostId = hostId;
      save([...list().filter((r) => r.id !== rec.id), rec]);
      step('Waiting for the server to come into the office');
      if (!(await waitOnline(hostId, 40))) {
        const tail = await script(rec.target, trust, `tail -n 6 "${agentHome(rec.id)}/agent.log" 2>/dev/null || true`, 20000);
        throw new Error(`The agent on ${dest} did not come into the office. Its last words: ${tail.stdout.trim().split('\n').slice(-3).join(' | ') || '(nothing logged)'}`);
      }
      doing.delete(rec.id);
      log(`member server ${dest} is in the office (host ${hostId})`);
      return { ...rec, warnings: seen.warnings };
    } catch (e) {
      doing.set(rec.id, { step: null, error: e.message });
      throw e;
    }
  }

  /** Start the agent on a server again (after the server was restarted), or restart it. */
  async function reconnect(id) {
    const rec = list().find((r) => r.id === id);
    if (!rec) throw new Error('That server is not in this computer\'s list.');
    doing.set(id, { step: 'Starting the agent', error: null });
    try {
      await installAgent(rec, false);
      const hostId = await ensureAgent(rec, false, null, true);
      if (!hostId) throw new Error('The server no longer has its place in the office (it was removed there). Remove it here and add it again.');
      const up = await waitOnline(hostId, 30);
      doing.delete(id);
      return { ok: up };
    } catch (e) {
      doing.set(id, { step: null, error: e.message });
      throw e;
    }
  }

  /**
   * Change the folders employees may work in on a server that is already in the office. The agent is the one that
   * holds them to those folders, so it is started again with the new list; sessions on the server keep running in
   * tmux and are picked up again. A folder that does not exist on the server is refused before anything is changed.
   */
  async function setRoots(id, wanted) {
    const records = list();
    const rec = records.find((r) => r.id === id);
    if (!rec) throw new Error('That server is not in this computer\'s list.');
    const roots = cleanRoots(wanted);
    doing.set(id, { step: 'Changing the folders', error: null });
    try {
      const { dest } = parseTarget(rec.target);
      const check = await script(rec.target, false, `for d in${roots.map((r) => ` ${shPath(r)}`).join('')}; do [ -d "$d" ] || echo "ORCH:MISSING=$d"; done; echo ORCH:CHECKED`, 30000);
      if (!/ORCH:CHECKED/.test(check.stdout)) throw new Error(explain(check.stderr, dest));
      const missing = [...check.stdout.matchAll(/ORCH:MISSING=(.*)/g)].map((m) => m[1]);
      if (missing.length) throw new Error(`${missing.join(', ')} ${missing.length === 1 ? 'is not a folder' : 'are not folders'} on ${dest} (or ${parseTarget(rec.target).dest.split('@')[0] || 'that user'} cannot see ${missing.length === 1 ? 'it' : 'them'}). Nothing was changed.`);
      const next = { ...rec, roots };
      const hostId = await ensureAgent(next, false, null, true);
      if (!hostId) throw new Error('The server no longer has its place in the office (it was removed there). Remove it here and add it again.');
      save(records.map((r) => (r.id === id ? next : r)));
      const up = await waitOnline(hostId, 30);
      doing.delete(id);
      return { ok: up, roots };
    } catch (e) {
      doing.set(id, { step: null, error: e.message });
      throw e;
    }
  }

  /**
   * The folders inside one folder on a server, for choosing the ones employees may work in. Names only, nothing is
   * changed there; whatever the server's user can open can be looked into (that is the person's own server, reached
   * with their own keys — what the office may work in is still only what they then choose).
   */
  async function browse(id, dir) {
    const rec = list().find((r) => r.id === id);
    if (!rec) throw new Error('That server is not in this computer\'s list.');
    const { dest } = parseTarget(rec.target);
    const where = cleanBrowsePath(dir);
    const res = await script(
      rec.target,
      false,
      `cd -- ${shPath(where)} 2>/dev/null || { echo ORCH:NODIR; exit 0; }
echo "ORCH:PWD=$(pwd -P)"
echo "ORCH:HOME=$HOME"
n=0
for d in */; do
  [ -d "$d" ] || continue
  n=$((n+1))
  if [ $n -gt 400 ]; then echo ORCH:MORE; break; fi
  printf 'ORCH:DIR=%s\\n' "\${d%/}"
done
echo ORCH:LISTED
`,
      30000,
    );
    if (!/ORCH:(LISTED|NODIR)/.test(res.stdout)) throw new Error(explain(res.stderr, dest));
    const listing = readListing(res.stdout);
    if (!listing) throw new Error(`${where} is not a folder on ${dest}, or ${dest.includes('@') ? dest.split('@')[0] : 'that user'} cannot open it.`);
    return listing;
  }

  /** Take a server out of the office: stop the agent there, delete what was installed for it, and have the office forget the machine. */
  async function remove(id) {
    const rec = list().find((r) => r.id === id);
    if (!rec) return { ok: true, cleaned: false };
    const res = await script(
      rec.target,
      false,
      `${PATH_PRELUDE}
export ORCH_AGENT_HOME="${agentHome(rec.id)}"
PID=$(cat "$ORCH_AGENT_HOME/agent.pid" 2>/dev/null || true)
"$HOME/.orchestrator/bin/orchestrator-agent" stop >/dev/null 2>&1 || true
i=0; while [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && [ $i -lt 40 ]; do sleep 0.25; i=$((i+1)); done
[ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && kill "$PID" 2>/dev/null || true
rm -rf "$ORCH_AGENT_HOME"
[ -e "$ORCH_AGENT_HOME" ] || echo ORCH:CLEANED
`,
      30000,
    ).catch(() => null);
    if (rec.hostId) await api('DELETE', `/me/servers/${rec.hostId}`).catch(() => undefined);
    save(list().filter((r) => r.id !== id));
    doing.delete(id);
    return { ok: true, cleaned: !!res && /ORCH:CLEANED/.test(res.stdout) };
  }

  return {
    /** What this computer knows about the person's servers in this office (the office knows whether each is online and shared). */
    list: () => list().map((r) => ({ id: r.id, target: r.target, name: r.name, roots: r.roots, hostId: r.hostId, ...(doing.get(r.id) || { step: null, error: null }) })),
    probe,
    add,
    reconnect,
    setRoots,
    browse,
    remove,
  };
}

module.exports = { memberServers, parseTarget, cleanRoots, cleanBrowsePath, readListing, readProbe, explain, publiclyTrusted };
