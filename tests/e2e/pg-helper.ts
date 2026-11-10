/**
 * Starts a throwaway PostgreSQL cluster from the locally installed binaries
 * (initdb / pg_ctl) in a temp directory. Returns null when PostgreSQL is not
 * installed, so the PostgreSQL tests are skipped rather than faked.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface TestPostgres {
  url: string;
  psql(sql: string): string;
  stop(): void;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

export async function startPostgres(): Promise<TestPostgres | null> {
  if (spawnSync('initdb', ['--version'], { stdio: 'ignore' }).status !== 0 || spawnSync('pg_ctl', ['--version'], { stdio: 'ignore' }).status !== 0) return null;
  let base = os.tmpdir();
  if (base.length > 40) base = '/tmp';
  const dir = fs.mkdtempSync(path.join(base, 'orch-pg-'));
  const port = await freePort();
  execFileSync('initdb', ['-D', path.join(dir, 'data'), '-A', 'trust', '-U', 'orch', '--no-sync', '-E', 'UTF8', '--locale=C'], { stdio: 'ignore' });
  execFileSync('pg_ctl', ['-D', path.join(dir, 'data'), '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, '-l', path.join(dir, 'log'), '-w', 'start'], { stdio: 'ignore' });
  execFileSync('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', 'orch', 'orchestrator'], { stdio: 'ignore' });
  let stopped = false;
  return {
    url: `postgres://orch@127.0.0.1:${port}/orchestrator`,
    psql: (sql) => execFileSync('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', 'orch', '-d', 'orchestrator', '-At', '-c', sql], { encoding: 'utf8' }).trim(),
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        execFileSync('pg_ctl', ['-D', path.join(dir, 'data'), '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' });
      } catch {
        /* already stopped */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
