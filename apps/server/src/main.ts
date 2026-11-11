import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { defaultDataDir, startServer } from './server.ts';

const HELP = `orchestrator-server — the Orchestrator control server

USAGE
  orchestrator-server [options]

OPTIONS
  --host <addr>            Address to listen on (default 127.0.0.1 — local only)
  --port <n>               Port (default 4600)
  --data <dir>             Data directory (default ~/.orchestrator/server, or $ORCH_SERVER_HOME)
  --database <url>         Use PostgreSQL (postgres://user:pass@host/db) instead of SQLite;
                           also $ORCH_DATABASE_URL. One server per database.
  --public-url <url>       URL that workers and remote hosts use to reach this server
  --tls-cert <file>        TLS certificate (required to listen on a non-loopback address)
  --tls-key <file>         TLS private key
  --allow-insecure-remote  Listen on a non-loopback address without TLS (only behind a TLS proxy)
  --ui <dir>               Directory with the built office UI
  --print-enroll-token     Print a one-time enrollment token for a new host, then keep running
  --quiet                  Only log errors
`;

/**
 * What stands between a mistake in the office's own code and the office going away for everybody. One request that
 * trips over such a mistake is written down and the office goes on. Several within a minute mean something is
 * really wrong: then it stops, and whatever runs it (systemd) starts it again clean.
 */
export function stumbleNet(log: (line: string) => void, stop: () => void, opts: { limit?: number; windowMs?: number; now?: () => number } = {}): (kind: string) => (e: unknown) => void {
  const limit = opts.limit ?? 10;
  const windowMs = opts.windowMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const at: number[] = [];
  return (kind) => (e) => {
    log(`[${new Date(now()).toISOString()}] ERROR ${kind}: ${(e as Error)?.stack ?? e}`);
    const t = now();
    while (at.length && t - at[0]! > windowMs) at.shift();
    if (at.push(t) >= limit) stop();
  };
}

/**
 * What the office says when it has started. To a person at a terminal: the link that opens it, token and all. To
 * anything else — a service's log, a file, a pipe — only where the token is kept: a log is read by more people and
 * kept for longer than the token file, and the token is the key to the whole office on this machine.
 */
export function startupLines(url: string, ownerToken: string, tokenFile: string, toTerminal: boolean): string[] {
  return [toTerminal ? `  Office UI:   ${url}/?token=${ownerToken}` : `  Office UI:   ${url}  (open it with the owner token; it is not written to a log)`, `  Owner token: stored in ${tokenFile}`];
}

export async function main(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      data: { type: 'string' },
      database: { type: 'string' },
      'public-url': { type: 'string' },
      'tls-cert': { type: 'string' },
      'tls-key': { type: 'string' },
      'allow-insecure-remote': { type: 'boolean' },
      ui: { type: 'string' },
      'print-enroll-token': { type: 'boolean' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const uiCandidates = [values.ui, process.env.ORCH_UI_DIR, path.join(here, '..', '..', 'desktop', 'dist'), path.join(here, '..', 'ui')].filter((p): p is string => !!p);
  const uiDir = uiCandidates.find((p) => fs.existsSync(path.join(p, 'index.html'))) ?? null;
  if ((values['tls-cert'] && !values['tls-key']) || (!values['tls-cert'] && values['tls-key'])) {
    console.error('error: --tls-cert and --tls-key must be given together');
    process.exit(1);
  }
  let server;
  try {
    server = await startServer({
      dataDir: values.data ? path.resolve(values.data) : defaultDataDir(),
      database: values.database ?? process.env.ORCH_DATABASE_URL ?? null,
      host: values.host ?? process.env.ORCH_HOST ?? '127.0.0.1',
      port: Number(values.port ?? process.env.ORCH_PORT ?? 4600),
      publicUrl: values['public-url'] ?? process.env.ORCH_PUBLIC_URL,
      tls: values['tls-cert'] ? { certFile: values['tls-cert'], keyFile: values['tls-key']! } : null,
      allowInsecureRemote: values['allow-insecure-remote'],
      uiDir,
      quiet: values.quiet,
    });
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
  }
  const stumbled = stumbleNet((line) => console.error(line), () => process.exit(1));
  process.on('uncaughtException', stumbled('uncaught exception'));
  process.on('unhandledRejection', stumbled('unhandled rejection'));
  if (!values.quiet) for (const line of startupLines(server.url, server.ownerToken, path.join(values.data ? path.resolve(values.data) : defaultDataDir(), 'owner-token'), !!process.stderr.isTTY)) console.error(line);
  if (values['print-enroll-token']) console.log(server.localEnrollToken());
  const shutdown = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
