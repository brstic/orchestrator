/**
 * The release gate (`docs/RELEASE-GATE.md`; the owner, 2026-11-23: "review must be the gate: I see what they did, and
 * if it is good I let it go on to where it has to go"). Work is done and tried freely — on the employee's own
 * branches, on a development server — but nothing reaches the branches the office protects (`master`, `main`) or a
 * production server before an owner approved it. This is the rule that tells, from a command's text, whether it is
 * such a release; the machine applies it to every command (host agent), the office decides whether it may run.
 *
 * Like the fence of a rented employee it reads a command for what it says: a push whose branch the command puts
 * together itself, or a program that deploys on its own, is not seen ("Limits" in the page above).
 */
export interface ReleaseRules {
  on: boolean;
  /** Branches nothing is pushed to before approval (also merged into by `gh pr merge`). */
  branches: string[];
  /** Production servers — host names, addresses, or folders on them — nothing is changed on before approval. */
  hosts: string[];
}

export const RELEASE_GATE_DEFAULT: ReleaseRules = { on: false, branches: ['main', 'master'], hosts: [] };

/** The office's rules as set (Settings → Employees → Release gate), with the defaults filled in. */
export function releaseRulesOf(settings: { releaseGate?: Partial<ReleaseRules> | null }): ReleaseRules {
  const g = settings.releaseGate ?? {};
  const list = (v: unknown, fallback: string[]) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, 40) : fallback);
  return { on: g.on === true, branches: list(g.branches, RELEASE_GATE_DEFAULT.branches), hosts: list(g.hosts, []) };
}

/** The parts of a command line between ; && || | and new lines — not where those stand inside quotes. */
function segments(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === "\\" && q === "\"" && i + 1 < s.length) (cur += c + s[i + 1]), i++;
      else {
        if (c === q) q = null;
        cur += c;
      }
      continue;
    }
    if (c === "\"" || c === "'") (q = c), (cur += c);
    else if (c === ";" || c === "\n" || c === "|" || (c === "&" && s[i + 1] === "&")) {
      out.push(cur);
      cur = "";
      if ((c === "&" || c === "|") && s[i + 1] === c) i++;
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * The words of a command line as the shell makes them: quotes taken off, pieces quoted differently but written
 * together (`'a'"'"'b'`) one word, a backslash outside quotes and before ", $, \ or ` inside double quotes taken off.
 */
function words(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q === "'") {
      if (c === "'") q = null;
      else cur += c;
    } else if (q === '"') {
      if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1]!)) cur += s[++i];
      else if (c === '"') q = null;
      else cur += c;
    } else if (c === "'" || c === '"') {
      q = c;
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

const OPT_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

/**
 * Where a `git push` with these arguments sends things: the remote (name or address) and the branches. `current`:
 * the branch the push is made from, for a push that names none (`git push`, `git push origin HEAD`).
 */
export function pushTargets(args: string[], current: () => string | null): { remote: string | null; branches: string[]; all: boolean; dryRun: boolean } {
  const pos: string[] = [];
  let all = false;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--all' || a === '--mirror' || a === '--branches') all = true;
    else if (a === '--dry-run' || a === '-n') dryRun = true;
    else if (OPT_WITH_VALUE.has(a)) i++;
    else if (a.startsWith('-')) continue;
    else pos.push(a);
  }
  const [remote = null, ...specs] = pos;
  const branches: string[] = [];
  for (const raw of specs) {
    const spec = raw.replace(/^\+/, '');
    let dst = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec;
    if (!dst) continue; // ":branch" deletes; "src:" is not a branch
    dst = dst.replace(/^refs\/heads\//, '');
    if (dst === 'HEAD' || dst === '@') {
      const c = current();
      if (c) branches.push(c);
    } else if (!dst.startsWith('refs/tags/')) branches.push(dst);
  }
  if (!specs.length && !all) {
    const c = current();
    if (c) branches.push(c);
  }
  return { remote, branches, all, dryRun };
}

/** What changes something where it runs (read on what runs on a production server, not on the whole command). */
const CHANGES_THERE = [
  /\bgit\b(?:\s+-[cC]\s+\S+)*\s+(?:pull|merge|reset|checkout|switch|rebase|cherry-pick|am|apply|restore|push|stash\s+(?:pop|apply))(?![\w-])/,
  /\bmysql\b[\s\S]*\b(?:insert|update|delete|alter|drop|create|truncate|rename|replace|grant|revoke)\b/i,
  // SQL that writes, wherever it is written (a PHP or a Python probe run there, a client's -e).
  /\b(?:INSERT\s+(?:IGNORE\s+)?INTO|UPDATE\s+[`"\w.]+\s+SET|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+(?:TABLE|DATABASE|INDEX|VIEW|USER)|CREATE\s+(?:TABLE|DATABASE|INDEX|VIEW|USER|TRIGGER|PROCEDURE)|TRUNCATE\s+(?:TABLE\s+)?[`"\w]|REPLACE\s+INTO|GRANT\s+\w|REVOKE\s+\w|RENAME\s+TABLE)\b/i,
  /\b(?:composer\s+(?:install|update|require)|npm\s+(?:ci|install|run\s+build)|yarn\s+(?:install|build)|pnpm\s+(?:install|build))\b/,
  /\b(?:pm2\s+(?:restart|reload|start|stop|delete)|systemctl\s+(?:restart|reload|start|stop|enable|disable)|service\s+\S+\s+(?:restart|reload|start|stop))\b/,
  /\b(?:artisan|index\.php)\b[^'"]*\bmigrat/,
  // A crontab put in (from a file, from standard input, edited, removed) — not `crontab -l`.
  /\bcrontab\s+(?:-[rei]\b|-(?=\s|$|\))|[~.$\/][^\s|;&)]*|\S+\.(?:txt|cron|bak|tab)\b)/,
  // PHP or Python that writes files (outside /tmp).
  /\b(?:file_put_contents|unlink|rename|rmdir|fwrite)\s*\(\s*(?!['"]\/tmp\/)/,
  // A redirect into a file that is not under /tmp (or /dev/null, or another descriptor).
  // (Not PHP's -> and =>, not a comparison >=, not a file made by mktemp.)
  /(?:^|[^0-9&>=-])>>?(?!=)\s*(?!\/dev\/null|&|['"]?\/tmp\/|['"]?\/dev\/(?:stdout|stderr)\b|\$\(mktemp\b)[^\s|;&)]/,
];

/** Whether a command names one of the production servers (a host, an address, or a folder on it). */
function namesHost(command: string, host: string): boolean {
  const h = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9.-])${h}($|[^A-Za-z0-9-])`, 'i').test(command);
}

/** The patterns above read in a program's text too, quotes and all (SQL, PHP's file writes). */
const IN_TEXT = new Set([1, 2, 7]);

/** File commands whose arguments are what they change (all of them, or the last one: where a copy goes). */
const CHANGES_FILES: Record<string, 'all' | 'last'> = { rm: 'all', mkdir: 'all', touch: 'all', chmod: 'all', chown: 'all', truncate: 'all', tee: 'all', unzip: 'all', mv: 'all', cp: 'last', ln: 'last', install: 'last', sed: 'all' };

const underTmp = (a: string) => /^\/(?:tmp|dev\/null)(?:\/|$)|^\$\(mktemp\b/.test(a);

/** Does this script — what runs on a production server — change something there (outside /tmp)? */
function changesThere(script: string): boolean {
  for (const seg of segments(script)) {
    const w = words(beforeRedirect(seg).trim());
    // Past what only starts a command: sudo, a timeout, nice, assignments.
    let i = 0;
    while (i < w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]!) || ['sudo', 'nice', 'nohup', 'time', 'command', 'exec'].includes(w[i]!) || (w[i] === 'timeout' && ++i))) i++;
    const cmd = w[i]?.replace(/^.*\//, '').replace(/^\(+/, '');
    // A deploy script run there (scripts/deploy.sh, deploy): what it does is not read here, and deploying is a release.
    if (cmd && /^deploy\b/i.test(cmd)) return true;
    const how = cmd ? CHANGES_FILES[cmd] : undefined;
    if (how && !(cmd === 'sed' && !w.slice(i + 1).some((a) => /^(?:-[a-zA-Z]*i|--in-place)/.test(a))) && !(cmd === 'tar')) {
      const args = w.slice(i + 1).filter((a) => !a.startsWith('-') && !/^\d+$/.test(a) && !(cmd === 'sed' && /^s(.).*\1/.test(a)));
      const targets = how === 'last' ? args.slice(-1) : args;
      if (targets.some((a) => !underTmp(a))) return true;
    }
    if (/^\s*tar\s+-?[a-zA-Z]*x/.test(seg) && !/-C\s+['"]?\/tmp\//.test(seg)) return true;
    // SQL and file writes in a program's text are read as they stand (they sit in quotes: php -r '…', mysql -e "…");
    // the shell's own (git, a redirect, a crontab…) only outside quotes, where they are commands and not words.
    const bare = seg.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, 'Q');
    if (CHANGES_THERE.some((re, k) => (IN_TEXT.has(k) ? re.test(seg) : re.test(bare)))) return true;
  }
  return false;
}

/** Simple assignments (NAME=value, NAME="…", NAME='…') put into the $NAME and ${NAME} after them: how a command often names its ssh and its host. */
function expand(command: string): string {
  const vars = new Map<string, string>();
  const re = /(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|'"]*)/g;
  for (let m = re.exec(command); m; m = re.exec(command)) vars.set(m[1]!, m[2]!.replace(/^"([\s\S]*)"$|^'([\s\S]*)'$/, (_a, d, q) => d ?? q));
  if (!vars.size) return command;
  return command.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a, b) => vars.get(a ?? b) ?? all);
}

/** The body of a heredoc that starts in this text at or after `from` and before the end of that line, if one does. */
function heredocAfter(text: string, from: number): string | null {
  const lineEnd = text.indexOf('\n', from);
  const head = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(text.slice(from, lineEnd < 0 ? undefined : lineEnd));
  if (!head || lineEnd < 0) return null;
  const rest = text.slice(lineEnd + 1);
  const end = new RegExp(`^\\s*${head[2]}\\s*$`, 'm').exec(rest);
  return end ? rest.slice(0, end.index) : rest;
}

/** A statement up to its first redirect outside quotes (`>`, `<`, `2>`): what stands before it is the command. */
function beforeRedirect(stmt: string): string {
  let q: string | null = null;
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i]!;
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>' || c === '<') return stmt.slice(0, i).replace(/\s\d$/, '');
  }
  return stmt;
}

const SSH_OPT_WITH_VALUE = new Set(['-p', '-i', '-o', '-l', '-F', '-J', '-L', '-R', '-D', '-E', '-c', '-m', '-b', '-e', '-S', '-O', '-w', '-W', '-Q', '-B', '-P']);

/**
 * What a command changes on a production server, or null. Read: what it runs there over ssh (with a heredoc it feeds
 * it, or the file it sends it — read with `readFile` where the machine can, held where it cannot), and copies onto it
 * (scp, rsync, sftp). What it does here — writing its findings to a file, a request to the site — is not a change
 * there; nor are probes written into /tmp there.
 */
function productionChange(command: string, host: string, readFile?: (path: string) => string | null): string | null {
  const text = expand(command);
  if (!namesHost(text, host)) return null;
  // Copied onto it.
  for (const seg of segments(text)) {
    const w = words(seg.trim());
    const at = w.findIndex((x) => /^(?:scp|rsync|sftp)$/.test(x.replace(/^.*\//, '')));
    if (at < 0) continue;
    const args = w.slice(at + 1).filter((a) => !a.startsWith('-'));
    const dest = args.at(-1);
    if (dest && namesHost(dest, host)) return `it copies onto ${host}, a production server`;
  }
  // Run on it over ssh.
  for (const m of text.matchAll(/(?:^|[\s;&|(`$"'])ssh(?=\s)/g)) {
    const from = m.index! + m[0].length;
    // The ssh statement: to the end of its segment (quotes kept together).
    const stmt = segments(text.slice(from))[0] ?? '';
    // What goes to the server is what stands before this machine's own redirects (`> out.txt`, `< file`).
    const w = words(beforeRedirect(stmt));
    let i = 0;
    while (i < w.length && w[i]!.startsWith('-')) i += SSH_OPT_WITH_VALUE.has(w[i]!) ? 2 : 1;
    const dest = w[i];
    if (!dest || !namesHost(dest, host)) continue;
    let remote = w.slice(i + 1).join(' ');
    const body = heredocAfter(text, from);
    if (body !== null) remote += `\n${body}`;
    // A program sent from this machine on its standard input: read it where it can be read.
    const fed = /(?:^|\s)<\s*(?!<)(['"]?)([^\s'"|;&]+)\1/.exec(stmt.replace(/<<-?\s*\S+/, ''));
    const runsInput = /\/dev\/stdin|\b(?:bash|sh)\s+-s\b|\bphp\s+-(?:\s|$)|\bpython3?\s+-(?:\s|$)|\bmysql\b(?![^|;&]*\s-e\s)/.test(remote);
    if (fed && (runsInput || /\bcat\s*>/.test(remote))) {
      const content = readFile?.(fed[2]!) ?? null;
      if (/\bcat\s*>\s*(?!['"]?\/tmp\/)/.test(remote)) return `it changes something on ${host}, a production server`;
      if (runsInput) {
        if (content === null) return `it runs a program from this machine on ${host}, a production server (what it does cannot be read here)`;
        remote += `\n${content}`;
      }
    }
    if (changesThere(remote)) return `it changes something on ${host}, a production server`;
  }
  // A database on it, written to from here.
  if (/\bmysql\b/.test(text) && CHANGES_THERE[1]!.test(text) && /\bmysql\b[^|;&\n]*\s-h\s*\S*/.test(text)) return `it changes something on ${host}, a production server`;
  return null;
}

/**
 * Whether this command releases something, and what (`null`: it does not). `cwd`: where it runs; `branchOf(dir)`:
 * the branch checked out in a folder (for a push that names none), or null when not known; `readFile(path)`: a file on
 * this machine a command sends to a production server to run (null: it cannot be read, and the command is held).
 */
export function releaseOf(command: string, rules: ReleaseRules, cwd: string, branchOf: (dir: string) => string | null, readFile?: (path: string) => string | null): string | null {
  if (!rules.on || !command.trim()) return null;
  const protectedBranch = new Set(rules.branches);
  // Production: what the command runs on a production server, or copies onto it, changes something there.
  for (const host of rules.hosts) {
    const why = productionChange(command, host, readFile);
    if (why) return why;
  }
  // Merging a pull request merges into a protected branch.
  if (/\b(?:gh\s+pr\s+merge|glab\s+mr\s+merge)\b/.test(command)) return 'it merges a pull request (into the protected branch)';
  // Every `git … push …` in the command, with the folder it runs in.
  let dir = cwd;
  for (const seg of segments(command)) {
    const cd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*$/.exec(seg);
    if (cd) {
      const to = cd[1]!.replace(/^["']|["']$/g, '');
      dir = to.startsWith('/') ? to : `${dir.replace(/\/$/, '')}/${to}`;
      continue;
    }
    const m = /\bgit\b((?:\s+(?:-[cC]\s+(?:"[^"]*"|'[^']*'|\S+)|--?[\w-]+(?:=\S+)?))*)\s+push\b(.*)$/.exec(seg);
    if (!m) continue;
    const gitArgs = words(m[1] ?? '');
    const at = gitArgs.indexOf('-C');
    const where = at >= 0 && gitArgs[at + 1] ? (gitArgs[at + 1]!.startsWith('/') ? gitArgs[at + 1]! : `${dir.replace(/\/$/, '')}/${gitArgs[at + 1]}`) : dir;
    const t = pushTargets(words(m[2] ?? ''), () => branchOf(where));
    if (t.dryRun) continue;
    if (t.remote && rules.hosts.some((h) => namesHost(t.remote!, h))) return `it pushes to ${t.remote}, on a production server`;
    if (t.all) return `it pushes every branch (${[...protectedBranch].join(', ')} among them)`;
    const hit = t.branches.find((b) => protectedBranch.has(b));
    if (hit) return `it pushes to ${hit}`;
  }
  return null;
}
