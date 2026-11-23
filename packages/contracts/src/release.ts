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

/** Pieces of a command line, joined where quotes hold them together (good enough to read arguments). */
function words(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
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

const CHANGES_THERE = [
  /\bgit\b(?:\s+-[cC]\s+\S+)*\s+(?:pull|merge|reset|checkout|switch|rebase|cherry-pick|am|apply|restore|push|stash\s+(?:pop|apply))\b/,
  /\b(?:rsync|scp|sftp)\b/,
  /\bmysql\b[\s\S]*\b(?:insert|update|delete|alter|drop|create|truncate|rename|replace|grant)\b/i,
  /\b(?:composer\s+(?:install|update|require)|npm\s+(?:ci|install|run\s+build)|yarn\s+(?:install|build)|pnpm\s+(?:install|build))\b/,
  /\b(?:pm2\s+(?:restart|reload|start|stop|delete)|systemctl\s+(?:restart|reload|start|stop)|service\s+\S+\s+(?:restart|reload|start|stop))\b/,
  /\b(?:artisan|index\.php)\b[^'"]*\bmigrat/,
  /\bsed\s+(?:-[a-zA-Z]*i|--in-place)/,
  /(?:^|[\s;&|'"(])(?:rm|mv|cp|chmod|chown|ln|tee|mkdir|touch|truncate|unzip|tar\s+-?x)\b/,
  /(?:^|[^0-9&>])>>?\s*(?!\/dev\/null|&)[^\s|;&]/,
];

/** Whether a command names one of the production servers (a host, an address, or a folder on it). */
function namesHost(command: string, host: string): boolean {
  const h = host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9.-])${h}($|[^A-Za-z0-9-])`, 'i').test(command);
}

/**
 * Whether this command releases something, and what (`null`: it does not). `cwd`: where it runs; `branchOf(dir)`:
 * the branch checked out in a folder (for a push that names none), or null when not known.
 */
export function releaseOf(command: string, rules: ReleaseRules, cwd: string, branchOf: (dir: string) => string | null): string | null {
  if (!rules.on || !command.trim()) return null;
  const protectedBranch = new Set(rules.branches);
  // Production: a command that names a production server and changes something there.
  for (const host of rules.hosts) {
    if (namesHost(command, host) && CHANGES_THERE.some((re) => re.test(command))) return `it changes something on ${host}, a production server`;
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
