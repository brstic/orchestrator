/**
 * This computer's host in an office, run as a process of its own: `node personal-host-cli.cjs`.
 *
 * The desktop app on Windows cannot host sessions itself (no tmux), so it starts this inside WSL2 and talks to it
 * over the process's own pipes (wsl-host.cjs):
 *
 *   stdin   one line of JSON: { address, token, fingerprint, agentEntry, allowedRoots }
 *           — the member's token arrives here, never on a command line. When stdin closes, the host stops.
 *   stdout  one line of JSON for every change of state: { state, reason, hostId }
 *
 * Everything else is personal-host.cjs as it runs on macOS and Linux: the relay, the enrolment and the agent.
 */
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { startPersonalHost } = require('./personal-host.cjs');

/** The app does not know this side's home folder: it writes `~` and paths relative to it. */
const fromHome = (p) => (p === '~' ? os.homedir() : path.resolve(os.homedir(), String(p)));

const say = (state) => process.stdout.write(`${JSON.stringify(state)}\n`);
let host = null;

const lines = readline.createInterface({ input: process.stdin });
lines.once('line', (line) => {
  let opts;
  try {
    opts = JSON.parse(line);
  } catch {
    say({ state: 'unavailable', reason: 'The desktop app did not say which office to join.', hostId: null });
    return process.exit(1);
  }
  // The automated tests' knobs (a tmux server, a worker and folders of their own) are set on the app's side; pass them on.
  for (const [k, v] of Object.entries(opts.env || {})) if (/^ORCH_[A-Z_]+$/.test(k) && typeof v === 'string') process.env[k] = v;
  host = startPersonalHost({
    address: opts.address,
    token: opts.token,
    fingerprint: opts.fingerprint,
    node: process.execPath,
    agentEntry: fromHome(opts.agentEntry),
    PATH: process.env.PATH,
    allowedRoots: Array.isArray(opts.allowedRoots) ? opts.allowedRoots.map(fromHome) : undefined,
    onState: say,
  });
});

/** The app closed the office (or went away): stop the agent and the relay. The tmux sessions stay. */
const leave = () => {
  if (host) host.stop();
  setTimeout(() => process.exit(0), 400);
};
lines.on('close', leave);
process.on('SIGTERM', leave);
process.on('SIGHUP', leave);
process.on('SIGINT', leave);
