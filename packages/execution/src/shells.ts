import { execFile } from 'node:child_process';

/**
 * The commands a Claude Code session is running, read from the machine's process table.
 *
 * Claude Code runs every command of its Bash tool in a shell of its own, started as its own child:
 *
 *   /bin/zsh -c source ~/.claude/shell-snapshots/snapshot-zsh-….sh 2>/dev/null || true && … && eval '<the command>' < /dev/null && pwd -P >| /tmp/claude-…-cwd
 *
 * (seen with Claude Code 2.1.323 on macOS; Linux is the same but for the shell). That shell lives as long as the
 * command does — also when the command runs in the background (`run_in_background`, a command moved there after its
 * time ran out, one the person at the terminal sent there), when the session has long finished its turn. So a session
 * whose turn is over and that still has such a shell is waiting for a command to finish.
 *
 * Nothing here knows which of them is in front of the session: the office tells that from the hooks (a Bash call in
 * progress). This only finds them, with the command each runs and how long it has been running.
 */
export interface ProcessRow {
  ppid: number;
  /** How long it has been running, in seconds. */
  seconds: number;
  args: string;
}

export interface ToolShell {
  pid: number;
  /** The command the shell was given (what stands in `eval '…'`), or the shell's arguments when that cannot be read. */
  command: string;
  seconds: number;
}

/** `ps`'s elapsed time — `[[dd-]hh:]mm:ss` — in seconds. */
export function elapsedSeconds(etime: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/** Lines of `ps -o pid=,ppid=,etime=,args=`. */
export function parseProcessTable(text: string): Map<number, ProcessRow> {
  const rows = new Map<number, ProcessRow>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m) rows.set(Number(m[1]), { ppid: Number(m[2]), seconds: elapsedSeconds(m[3]!), args: m[4]! });
  }
  return rows;
}

/** Is this the shell Claude Code started for one command of its Bash tool? */
export function isToolShell(args: string): boolean {
  return /\/shell-snapshots\/snapshot-/.test(args) || (/\beval '/.test(args) && /pwd -P >\| /.test(args));
}

/**
 * The command a tool shell runs: what stands between `eval '` and the `'` that ends it (a quote inside the command is
 * written `'"'"'` or `'\''`). `ps` on macOS writes a line break as `\012`. Null when it cannot be read.
 */
export function commandOfShell(args: string): string | null {
  const start = args.indexOf("eval '");
  if (start < 0) return null;
  let i = start + 6;
  let out = '';
  while (i < args.length) {
    if (args.startsWith(`'"'"'`, i)) {
      out += "'";
      i += 5;
    } else if (args.startsWith(`'\\''`, i)) {
      out += "'";
      i += 4;
    } else if (args[i] === "'") {
      return out.replace(/\\012/g, '\n');
    } else {
      out += args[i];
      i++;
    }
  }
  return null;
}

/**
 * The tool shells below a session's process (the pane's process: Claude Code itself, or what started it). Only the
 * outermost: a shell a command started is part of that command. Oldest first.
 */
export function toolShells(rows: Map<number, ProcessRow>, rootPid: number): ToolShell[] {
  const children = new Map<number, number[]>();
  for (const [pid, row] of rows) {
    const list = children.get(row.ppid);
    if (list) list.push(pid);
    else children.set(row.ppid, [pid]);
  }
  const out: ToolShell[] = [];
  const seen = new Set<number>([rootPid]);
  // Breadth first, a few levels down (Claude Code under a launcher, an SDK runner, a person's own shell).
  let level = children.get(rootPid) ?? [];
  for (let depth = 0; depth < 6 && level.length; depth++) {
    const next: number[] = [];
    for (const pid of level) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      const row = rows.get(pid)!;
      if (isToolShell(row.args)) {
        out.push({ pid, command: commandOfShell(row.args) ?? row.args, seconds: row.seconds });
        continue;
      }
      next.push(...(children.get(pid) ?? []));
    }
    level = next;
  }
  return out.sort((a, b) => b.seconds - a.seconds || a.pid - b.pid);
}

/** This user's processes, as `ps` lists them (full arguments). Empty when `ps` cannot be run. */
export function readProcessTable(): Promise<Map<number, ProcessRow>> {
  return new Promise((resolve) => {
    execFile('ps', ['-ww', '-u', String(process.getuid?.() ?? ''), '-o', 'pid=,ppid=,etime=,args='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 5000 }, (_e, out) => resolve(parseProcessTable(out ?? '')));
  });
}
