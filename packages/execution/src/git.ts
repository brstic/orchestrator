import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export class GitError extends Error {
  stderr: string;
  code: number | null;
  constructor(message: string, stderr: string, code: number | null) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}

function git(cwd: string, args: string[], opts: { maxBuffer?: number; allowFail?: boolean } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        timeout: 120000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0;
        if (err && !opts.allowFail) reject(new GitError(`git ${args.slice(0, 2).join(' ')} failed: ${String(stderr || err.message).trim()}`, String(stderr), code));
        else resolve({ stdout: String(stdout), stderr: String(stderr), code });
      },
    );
  });
}

export interface PathInspection {
  path: string;
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  repoRoot: string | null;
  branch: string | null;
  head: string | null;
  hasCommits: boolean;
}

export async function inspectPath(p: string): Promise<PathInspection> {
  const abs = path.resolve(p);
  const out: PathInspection = { path: abs, exists: false, isDirectory: false, isGitRepo: false, repoRoot: null, branch: null, head: null, hasCommits: false };
  try {
    const st = await fs.stat(abs);
    out.exists = true;
    out.isDirectory = st.isDirectory();
  } catch {
    return out;
  }
  if (!out.isDirectory) return out;
  const top = await git(abs, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (top.code !== 0) return out;
  out.isGitRepo = true;
  out.repoRoot = top.stdout.trim();
  const br = await git(abs, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  out.branch = br.code === 0 ? br.stdout.trim() : null;
  const head = await git(abs, ['rev-parse', 'HEAD'], { allowFail: true });
  out.hasCommits = head.code === 0;
  out.head = head.code === 0 ? head.stdout.trim() : null;
  if (!out.hasCommits) {
    const sym = await git(abs, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true });
    out.branch = sym.code === 0 ? sym.stdout.trim() : out.branch;
  }
  return out;
}

export interface GitStatus {
  branch: string | null;
  head: string | null;
  dirty: boolean;
  files: Array<{ status: string; path: string }>;
  repoRoot: string | null;
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  const insp = await inspectPath(cwd);
  if (!insp.isGitRepo) return { branch: null, head: null, dirty: false, files: [], repoRoot: null };
  const st = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  const files = st.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
  return { branch: insp.branch, head: insp.head, dirty: files.length > 0, files, repoRoot: insp.repoRoot };
}

export interface GitDiff {
  base: string | null;
  stat: string;
  diff: string;
  truncated: boolean;
  uncommitted: string;
  untracked: string[];
  files: string[];
}

/** Committed changes since `base` plus the uncommitted working tree state. */
export async function gitDiff(cwd: string, base: string | null, maxBytes = 400_000): Promise<GitDiff> {
  const out: GitDiff = { base, stat: '', diff: '', truncated: false, uncommitted: '', untracked: [], files: [] };
  const cap = (s: string) => {
    if (s.length > maxBytes) {
      out.truncated = true;
      return s.slice(0, maxBytes) + '\n… (truncated)\n';
    }
    return s;
  };
  if (base) {
    const range = `${base}...HEAD`;
    const stat = await git(cwd, ['diff', '--stat', range], { allowFail: true });
    out.stat = stat.stdout.trim();
    const d = await git(cwd, ['diff', range], { allowFail: true, maxBuffer: 64 * 1024 * 1024 });
    out.diff = cap(d.stdout);
    const names = await git(cwd, ['diff', '--name-only', range], { allowFail: true });
    out.files = names.stdout.split('\n').filter(Boolean);
  }
  const wt = await git(cwd, ['diff', 'HEAD'], { allowFail: true, maxBuffer: 64 * 1024 * 1024 });
  out.uncommitted = cap(wt.stdout);
  const un = await git(cwd, ['ls-files', '--others', '--exclude-standard'], { allowFail: true });
  out.untracked = un.stdout.split('\n').filter(Boolean);
  return out;
}

export interface GitCommit {
  sha: string;
  subject: string;
  author: string;
  ts: string;
}

export async function gitLog(cwd: string, range: string, max = 50): Promise<GitCommit[]> {
  const res = await git(cwd, ['log', `--max-count=${max}`, '--format=%H%x1f%s%x1f%an%x1f%cI', range], { allowFail: true });
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, subject, author, ts] = l.split('\x1f');
      return { sha: sha!, subject: subject ?? '', author: author ?? '', ts: ts ?? '' };
    });
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code === 0;
}

async function isWorktree(repo: string, wtPath: string): Promise<boolean> {
  const list = await git(repo, ['worktree', 'list', '--porcelain'], { allowFail: true });
  const real = await fs.realpath(wtPath).catch(() => path.resolve(wtPath));
  return list.stdout.split('\n').some((l) => l.startsWith('worktree ') && (l.slice(9) === real || l.slice(9) === path.resolve(wtPath)));
}

/**
 * Give an employee an isolated working tree on its own branch. Existing
 * worktrees are reused untouched; nothing is ever reset or overwritten.
 */
export async function ensureWorktree(opts: { repo: string; path: string; branch: string; base: string }): Promise<{ path: string; branch: string; created: boolean; head: string | null }> {
  const insp = await inspectPath(opts.repo);
  if (!insp.isGitRepo || !insp.repoRoot) throw new Error(`${opts.repo} is not a git repository`);
  if (!insp.hasCommits) throw new Error(`${opts.repo} has no commits yet; make an initial commit before assigning work`);
  const repo = insp.repoRoot;
  const target = path.resolve(opts.path);
  const exists = await fs.stat(target).then(() => true).catch(() => false);
  if (exists) {
    if (!(await isWorktree(repo, target))) throw new Error(`${target} exists but is not a worktree of ${repo}`);
    const head = await git(target, ['rev-parse', 'HEAD'], { allowFail: true });
    const br = await git(target, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
    return { path: target, branch: br.stdout.trim(), created: false, head: head.stdout.trim() || null };
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await git(repo, ['worktree', 'prune'], { allowFail: true });
  if (await branchExists(repo, opts.branch)) await git(repo, ['worktree', 'add', target, opts.branch]);
  else await git(repo, ['worktree', 'add', '-b', opts.branch, target, opts.base]);
  const head = await git(target, ['rev-parse', 'HEAD'], { allowFail: true });
  return { path: target, branch: opts.branch, created: true, head: head.stdout.trim() || null };
}

/**
 * Start a task branch inside an employee's worktree. Refuses to proceed over
 * uncommitted work — the owner or the employee must deal with it first.
 */
export async function startBranch(opts: { cwd: string; branch: string; base: string }): Promise<{ branch: string; baseSha: string; reused: boolean }> {
  const st = await gitStatus(opts.cwd);
  if (!st.repoRoot) throw new Error(`${opts.cwd} is not a git repository`);
  if (st.branch === opts.branch) {
    const mb = await git(opts.cwd, ['merge-base', 'HEAD', opts.base], { allowFail: true });
    return { branch: opts.branch, baseSha: mb.stdout.trim() || st.head || '', reused: true };
  }
  if (st.dirty) {
    throw new Error(
      `working tree has uncommitted changes (${st.files
        .slice(0, 5)
        .map((f) => f.path)
        .join(', ')}${st.files.length > 5 ? ', …' : ''}); refusing to switch branches over them`,
    );
  }
  const baseSha = (await git(opts.cwd, ['rev-parse', opts.base])).stdout.trim();
  if (await branchExists(opts.cwd, opts.branch)) {
    await git(opts.cwd, ['switch', opts.branch]);
    return { branch: opts.branch, baseSha, reused: true };
  }
  await git(opts.cwd, ['switch', '-c', opts.branch, opts.base]);
  return { branch: opts.branch, baseSha, reused: false };
}

/**
 * Put whatever is uncommitted in a worktree away as one commit on the branch that is checked out — "work in
 * progress", made when a task is stopped, so that the folder is clean for the next task and nothing is lost: it is
 * on the task's own branch when the task is taken up again. Only on the branch named (never on a branch the task
 * does not own); hooks are not run for it.
 */
export async function commitWip(opts: { cwd: string; branch: string; message: string }): Promise<{ committed: boolean; sha: string | null; files: number }> {
  const st = await gitStatus(opts.cwd);
  if (!st.repoRoot) throw new Error(`${opts.cwd} is not a git repository`);
  if (st.branch !== opts.branch) throw new Error(`the folder is on "${st.branch}", not on "${opts.branch}"; nothing was committed`);
  if (!st.dirty) return { committed: false, sha: st.head ?? null, files: 0 };
  await git(opts.cwd, ['add', '-A']);
  await git(opts.cwd, ['-c', 'user.name=Orchestrator', '-c', 'user.email=orchestrator@localhost', 'commit', '--no-verify', '-q', '-m', opts.message]);
  const sha = (await git(opts.cwd, ['rev-parse', 'HEAD'])).stdout.trim();
  return { committed: true, sha, files: st.files.length };
}

export interface MergeResult {
  ok: boolean;
  sha: string | null;
  into: string;
  conflicts: string[];
  detail: string;
  alreadyMerged: boolean;
}

/**
 * Merge a finished task branch into the project's integration branch inside a
 * dedicated integration worktree, so nobody's working tree is disturbed. A
 * conflicting merge is aborted and reported; it is never forced.
 */
export async function mergeBranch(opts: { repo: string; worktree: string; into: string; base: string; branch: string; message: string }): Promise<MergeResult> {
  const wt = await ensureWorktree({ repo: opts.repo, path: opts.worktree, branch: opts.into, base: opts.base });
  const cwd = wt.path;
  const st = await gitStatus(cwd);
  if (st.branch !== opts.into) throw new Error(`integration worktree is on ${st.branch}, expected ${opts.into}`);
  if (st.dirty) throw new Error('integration worktree has uncommitted changes; resolve them before merging');
  const anc = await git(cwd, ['merge-base', '--is-ancestor', opts.branch, 'HEAD'], { allowFail: true });
  if (anc.code === 0) {
    const head = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    return { ok: true, sha: head, into: opts.into, conflicts: [], detail: 'already merged', alreadyMerged: true };
  }
  const res = await git(cwd, ['-c', 'user.name=Orchestrator', '-c', 'user.email=orchestrator@localhost', 'merge', '--no-ff', '-m', opts.message, opts.branch], { allowFail: true });
  if (res.code === 0) {
    const head = (await git(cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    return { ok: true, sha: head, into: opts.into, conflicts: [], detail: res.stdout.trim().split('\n').slice(-3).join('\n'), alreadyMerged: false };
  }
  const conflicted = await git(cwd, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true });
  const conflicts = conflicted.stdout.split('\n').filter(Boolean);
  await git(cwd, ['merge', '--abort'], { allowFail: true });
  return {
    ok: false,
    sha: null,
    into: opts.into,
    conflicts,
    detail: (res.stdout + '\n' + res.stderr).trim().split('\n').slice(-8).join('\n'),
    alreadyMerged: false,
  };
}

export interface IntegrationStatus {
  base: string;
  integration: string;
  baseHead: string | null;
  integrationHead: string | null;
  /** Commits on the integration branch that the base branch does not have yet. */
  ahead: number;
  /** Commits on the base branch that the integration branch lacks. */
  behind: number;
  /** Where the base branch is checked out (the owner's own working tree), and whether it has uncommitted changes. */
  baseCheckout: string | null;
  baseDirty: boolean;
}

/** Where a branch is checked out among the repository's worktrees, if anywhere. */
async function checkoutOf(repo: string, branch: string): Promise<string | null> {
  const out = (await git(repo, ['worktree', 'list', '--porcelain'], { allowFail: true })).stdout;
  let dir: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice(9).trim();
    else if (line.trim() === `branch refs/heads/${branch}`) return dir;
  }
  return null;
}

/** How the integration branch stands against the base branch. Read-only. */
export async function integrationStatus(opts: { repo: string; base: string; integration: string }): Promise<IntegrationStatus> {
  const rev = async (ref: string) => {
    const r = await git(opts.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  };
  const [baseHead, integrationHead] = [await rev(opts.base), await rev(opts.integration)];
  let ahead = 0;
  let behind = 0;
  if (baseHead && integrationHead) {
    const [l, r] = (await git(opts.repo, ['rev-list', '--left-right', '--count', `${baseHead}...${integrationHead}`])).stdout.trim().split(/\s+/).map(Number);
    behind = l ?? 0;
    ahead = r ?? 0;
  }
  const baseCheckout = await checkoutOf(opts.repo, opts.base);
  const baseDirty = baseCheckout ? (await gitStatus(baseCheckout)).dirty : false;
  return { base: opts.base, integration: opts.integration, baseHead, integrationHead, ahead, behind, baseCheckout, baseDirty };
}

/**
 * Move the base branch forward to the integration branch. Only ever a fast-forward: if the base
 * has commits of its own, or its working tree has uncommitted changes, this refuses and nothing
 * is touched. Nothing is pushed anywhere.
 */
export async function promoteIntegration(opts: { repo: string; base: string; integration: string }): Promise<{ sha: string; commits: number; from: string }> {
  const st = await integrationStatus(opts);
  if (!st.baseHead || !st.integrationHead) throw new Error(`branch ${!st.baseHead ? opts.base : opts.integration} does not exist`);
  if (st.ahead === 0) throw new Error(`${opts.base} already has everything on ${opts.integration}`);
  if (st.behind > 0) throw new Error(`${opts.base} has ${st.behind} commit${st.behind === 1 ? '' : 's'} that ${opts.integration} lacks; bring them into the integration branch first`);
  if (st.baseCheckout) {
    if (st.baseDirty) throw new Error(`${opts.base} is checked out in ${st.baseCheckout} with uncommitted changes; commit or stash them first`);
    await git(st.baseCheckout, ['merge', '--ff-only', st.integrationHead]);
  } else {
    // Not checked out anywhere: move the ref, but only if it is still where we saw it.
    await git(opts.repo, ['update-ref', `refs/heads/${opts.base}`, st.integrationHead, st.baseHead]);
  }
  return { sha: st.integrationHead, commits: st.ahead, from: st.baseHead };
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}
