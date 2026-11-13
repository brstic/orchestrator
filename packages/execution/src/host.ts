import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';
import type { SessionUsage } from '@orchestrator/contracts';
import { NESTED_SESSION_ENV } from './claude.ts';

// ───────────────────────── Verification ──────────────────────────

export interface VerifyResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

/**
 * Run a project's verification command (e.g. the test suite) in a working
 * tree and report what actually happened. This is how "tests passed" becomes
 * a measured fact instead of an agent's claim.
 */
export function runVerify(opts: { cwd: string; command: string; timeoutMs: number; tailBytes?: number }): Promise<VerifyResult> {
  const tailBytes = opts.tailBytes ?? 8000;
  return new Promise((resolve) => {
    const started = Date.now();
    const env: Record<string, string | undefined> = { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' };
    for (const k of NESTED_SESSION_ENV) delete env[k];
    for (const k of Object.keys(env)) if (k.startsWith('ORCH_')) delete env[k];
    const child = spawn(opts.command, { cwd: opts.cwd, shell: true, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (d: Buffer) => {
      tail += d.toString('utf8');
      if (tail.length > tailBytes * 2) tail = tail.slice(-tailBytes);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, opts.timeoutMs);
    const done = (code: number | null) => {
      clearTimeout(timer);
      resolve({ command: opts.command, exitCode: timedOut ? null : code, timedOut, durationMs: Date.now() - started, outputTail: tail.slice(-tailBytes) });
    };
    child.on('error', (err) => {
      tail += `\n[spawn error] ${err.message}`;
      done(127);
    });
    child.on('close', (code) => done(code));
  });
}

// ───────────────────────── Token usage ───────────────────────────

/**
 * Sum token usage from a Claude Code transcript (JSONL). These are the numbers
 * Claude Code itself recorded, so they are reported as measured. Returns null
 * when the transcript cannot be read — never an estimate.
 */
export async function readTranscriptUsage(transcriptPath: string): Promise<SessionUsage | null> {
  try {
    await fs.access(transcriptPath);
  } catch {
    return null;
  }
  const perMessage = new Map<string, { i: number; o: number; cr: number; cc: number }>();
  let turns = 0;
  const rl = readline.createInterface({ input: createReadStream(transcriptPath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== '{') continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'user' && rec.message && typeof rec.message.content === 'string' && !rec.isMeta) turns++;
    const usage = rec?.message?.usage;
    if (rec.type !== 'assistant' || !usage) continue;
    const id = String(rec.message.id ?? rec.uuid ?? perMessage.size);
    // A message can span several transcript lines; the last one carries the final usage.
    perMessage.set(id, {
      i: Number(usage.input_tokens) || 0,
      o: Number(usage.output_tokens) || 0,
      cr: Number(usage.cache_read_input_tokens) || 0,
      cc: Number(usage.cache_creation_input_tokens) || 0,
    });
  }
  const total: SessionUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, turns, measuredAt: new Date().toISOString() };
  for (const u of perMessage.values()) {
    total.inputTokens += u.i;
    total.outputTokens += u.o;
    total.cacheReadTokens += u.cr;
    total.cacheCreationTokens += u.cc;
  }
  return total;
}

// ───────────────────────── Host resources ────────────────────────

interface CpuTimes {
  idle: number;
  total: number;
}

function cpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  }
  return { idle, total };
}

function execText(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: 4000 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** Memory in use, excluding reclaimable cache where the platform lets us tell. */
async function memUsedBytes(): Promise<number | null> {
  if (process.platform === 'darwin') {
    const out = await execText('vm_stat', []);
    if (out) {
      const page = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
      const get = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
      const used = (get('Pages active') + get('Pages wired down') + get('Pages occupied by compressor')) * page;
      if (used > 0) return used;
    }
  } else if (process.platform === 'linux') {
    try {
      const info = await fs.readFile('/proc/meminfo', 'utf8');
      const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(info)?.[1] ?? NaN);
      const total = kb('MemTotal');
      const avail = kb('MemAvailable');
      if (Number.isFinite(total) && Number.isFinite(avail)) return (total - avail) * 1024;
    } catch {
      /* fall through */
    }
  }
  const free = os.freemem();
  return Number.isFinite(free) ? os.totalmem() - free : null;
}

export class ResourceSampler {
  private last: CpuTimes = cpuTimes();

  async sample(): Promise<{ cpuPercent: number | null; loadAvg1: number | null; memUsedBytes: number | null; memTotalBytes: number }> {
    const now = cpuTimes();
    const dTotal = now.total - this.last.total;
    const dIdle = now.idle - this.last.idle;
    this.last = now;
    const cpuPercent = dTotal > 0 ? Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 1000) / 10)) : null;
    const load = os.loadavg()[0];
    return {
      cpuPercent,
      loadAvg1: process.platform === 'win32' ? null : Math.round((load ?? 0) * 100) / 100,
      memUsedBytes: await memUsedBytes(),
      memTotalBytes: os.totalmem(),
    };
  }
}

export function isPidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

/**
 * What the agent last wrote in words, among the newest records of a Claude Code transcript (oldest first): the line
 * one sees in the terminal above the tool it is running ("Fix committed and pushed. Deploying it to dev…"). Its first
 * line only, without Markdown marks. null when the turn has said nothing yet — the search stops at the prompt that
 * started the turn, so that the answer of the turn before is never shown as what is being said now.
 */
export function lastSaidIn(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line || line[0] !== '{') continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    // (A subagent's words are not the employee's.)
    if (rec?.isSidechain === true) continue;
    const role = rec?.message?.role ?? rec?.type;
    const content = rec?.message?.content;
    if (role === 'user') {
      // A prompt (typed, or pasted by the office) starts the turn; a tool's result is in the middle of it.
      if (rec.isMeta) continue;
      if (typeof content === 'string' || (Array.isArray(content) && content.some((b: any) => b?.type === 'text'))) return null;
      continue;
    }
    if (role !== 'assistant' || !Array.isArray(content)) continue;
    const texts = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string' && b.text.trim());
    if (!texts.length) continue;
    const first = String(texts[texts.length - 1].text)
      .split('\n')
      .map((l) => l.replace(/^\s*(#{1,6}\s+|[-*>]\s+|\d+[.)]\s+)/, '').replace(/[*_`]{1,3}/g, '').trim())
      .find((l) => l.length > 0);
    if (!first) continue;
    return first.length > 240 ? `${first.slice(0, 239)}…` : first;
  }
  return null;
}

/**
 * The same, from the file: only its end is read (a transcript grows to many megabytes; the last words are in its last
 * few records), so this costs one small read. null when the file cannot be read or says nothing.
 */
export async function readLastSaid(transcriptPath: string, maxBytes = 96 * 1024): Promise<string | null> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(transcriptPath, 'r');
    const { size } = await fh.stat();
    const from = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - from);
    await fh.read(buf, 0, buf.length, from);
    const lines = buf.toString('utf8').split('\n');
    // (Read from the middle of the file, the first line is the end of a record.)
    if (from > 0) lines.shift();
    return lastSaidIn(lines);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}
