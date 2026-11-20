import path from 'node:path';
import type { AgentSession, Employee, EmployeeMoving, Host, MoveFile, MovePacked, MoveUnpacked, Project, Task } from '@orchestrator/contracts';
import { newId, nowIso, slugify } from '@orchestrator/contracts';
import { EngineError } from './core.ts';
import type { Engine } from './engine.ts';

/**
 * Moving an employee to another machine — the office's machine to a member's own computer and back, or any two
 * machines — with everything that is theirs (`docs/MOVE.md`). What the office keeps (tasks, messages, lessons,
 * routines, the central context) follows the employee by itself; what is on the machine is carried:
 * - **their own folder** (a folder, or a project only they work in, in place): the folder itself, git history, `.md`
 *   files and all, without what an install or a build makes again — the project moves with them;
 * - **a project others work in too**: a copy — the repository with every branch, theirs checked out — becomes a
 *   project of theirs on the new machine (`copiedFrom`); the project and the others stay; their open tasks there go
 *   back on its board;
 * - **back to where a copy came from**: the copy's branches go into that project as `moved/<them>/…`, nothing of it
 *   overwritten, and they work in it again;
 * - **their Claude conversation** and Claude Code's memory of the folder: put where the new machine's Claude Code
 *   looks for it, with the old paths made the new ones — their next session continues it.
 * The old folder stays where it was, as a copy to fall back on (the owner's choice, 2026-11-20).
 *
 * Both machines must be online; what is sent goes through the office piece by piece, never kept here.
 */

export interface MovePlan {
  /** Null: it can be done; otherwise why not, in words for the person who asked. */
  why: string | null;
  kind: 'own' | 'copy' | 'back' | null;
  /** The folder that is taken along, on the machine they are on. */
  folder: string | null;
  /** What it is called there (the new folder's name). */
  name: string | null;
  projectName: string | null;
  /** The project a copy goes back into (kind `back`). */
  backInto: string | null;
  /** Open tasks of theirs that go back on the board of the project they leave (kind `copy`). */
  released: Array<{ key: string; title: string }>;
  /** Their Claude conversation goes along (false: a Codex employee, or none on that machine yet). */
  conversation: boolean;
  /** Their session runs now (between turns): it is stopped first, and continues there. */
  stopsSession: boolean;
  /** Things to know before saying yes. */
  notes: string[];
}

const PIECE = 2 * 1024 * 1024;
/**
 * A move is never done sooner than this after it began: a small folder goes in a blink, and in the office the
 * employee is seen to pack, reach 100 % and carry the box (`docs/MOVE.md`, "In the office") — not to vanish.
 */
export const MOVE_SHOWN_MS = 5000;
const OPEN: Task['status'][] = ['BACKLOG', 'READY', 'BLOCKED'];
const BUSY: Task['status'][] = ['IN_PROGRESS', 'REVIEW'];

export class Moves {
  private eng: Engine;
  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  /** Whether they are being moved right now (a failed move does not count: it only stays to be read). */
  isMoving(e: Employee): boolean {
    return !!e.moving && e.moving.phase !== 'failed';
  }

  /** The session their conversation is in: their latest managed one on the machine they are on. */
  private lastSession(e: Employee): AgentSession | undefined {
    return this.core.sessions
      .filter((s) => s.employeeId === e.id && s.origin === 'managed' && s.hostId === e.hostId)
      .sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1))[0];
  }

  /** Where their session starts on a machine (`SessionRegistry.start`): their own folder, else their project's. */
  private startCwd(e: Pick<Employee, 'workingDir' | 'projectId'>, project: Project | undefined): string | null {
    return e.workingDir ?? project?.repoPath ?? null;
  }

  private colleaguesOn(project: Project, e: Employee): Employee[] {
    return this.core.employees.filter((x) => !x.archived && x.id !== e.id && (x.projectId === project.id || (x.alsoProjectIds ?? []).includes(project.id)));
  }

  /** What a move of this employee to that machine would do, or why it cannot be done. Nothing is changed. */
  plan(employeeId: string, toHostId: string): MovePlan {
    const e = this.core.employees.require(employeeId);
    const out: MovePlan = { why: null, kind: null, folder: null, name: null, projectName: null, backInto: null, released: [], conversation: false, stopsSession: false, notes: [] };
    const no = (why: string): MovePlan => ({ ...out, why });
    const from = e.hostId ? this.core.hosts.get(e.hostId) : undefined;
    const to = this.core.hosts.get(toHostId);
    if (e.archived) return no(`${e.name} is archived.`);
    if (!from) return no(`${e.name} is not on any machine yet: give them one instead.`);
    if (!to || to.status === 'revoked') return no('That machine is not in the office.');
    if (to.id === from.id) return no(`${e.name} is on ${to.name} already.`);
    if (e.roleKey === 'foreman') return no('The foreman stays on the office’s machine.');
    if (e.roleKey === 'lead') return no('A team lead stays on its member’s computer.');
    if (e.selfDriven) return no('A desk somebody sits at with their own Claude Code is theirs, not the office’s: it is not moved.');
    if (this.eng.rent.rentalOf(e.id)) return no(`${e.name} is rented out: end the rental first.`);
    if (this.isMoving(e)) return no(`${e.name} is being moved already.`);
    if (!this.core.agents.isOnline(from.id)) return no(`${from.name} is not connected now: both machines must be, while ${e.name} is moved.`);
    if (!this.core.agents.isOnline(to.id)) return no(`${to.name} is not connected now: both machines must be, while ${e.name} is moved.`);
    for (const h of [from, to]) if (!h.info?.moves) return no(`${h.name} runs an older office program that cannot move employees: update it there (${h.memberId ? 'the app on that computer' : 'orchestrator-agent'}) first.`);
    const busy = this.core.tasks.filter((t) => t.assigneeId === e.id && BUSY.includes(t.status));
    if (busy.length) return no(`${e.name} is working on ${busy.map((t) => t.key).join(', ')}: let it be done (or stop it) first — that work is in a folder of the machine they are on.`);
    const live = this.core.runningSessionOf(e.id);
    if (live) {
      if (live.status === 'host_offline') return no(`${e.name}'s session is still running on ${from.name}, which is reconnecting.`);
      if (live.origin !== 'managed') return no(`${e.name} is attached to a session the office did not start: detach it first.`);
      if (live.inTurn) return no(`${e.name} is in the middle of something: wait until their turn ends, or pause them.`);
      out.stopsSession = true;
    }

    const project = this.core.projects.get(e.projectId ?? '');
    const original = project?.copiedFrom ? this.core.projects.get(project.copiedFrom.projectId) : undefined;
    if (project && original && original.hostId === to.id && original.status !== 'archived' && original.repoPath) {
      out.kind = 'back';
      out.folder = project.repoPath;
      out.backInto = original.name;
      out.projectName = original.name;
      out.notes.push(`Their branches go into ${original.name} as moved/${slugify(e.name)}/…: nothing of ${original.name} is overwritten, and merging them is yours to decide.`);
      const left = this.core.tasks.filter((t) => t.projectId === project.id && OPEN.includes(t.status)).length;
      if (left) out.notes.push(`${left} open task${left === 1 ? '' : 's'} of ${project.name} stay${left === 1 ? 's' : ''} with it.`);
    } else if (project && project.repoPath && project.workspace === 'in_place' && (!project.ownerEmployeeId || project.ownerEmployeeId === e.id) && this.colleaguesOn(project, e).length === 0) {
      out.kind = 'own';
      out.folder = project.repoPath;
      out.projectName = project.name;
      out.notes.push(`${project.name} moves with them: its tasks, its settings, its folder.`);
    } else if (project && project.repoPath) {
      out.kind = 'copy';
      out.folder = project.repoPath;
      out.projectName = project.name;
      out.released = this.core.tasks.filter((t) => t.assigneeId === e.id && t.projectId === project.id && OPEN.includes(t.status)).map((t) => ({ key: t.key, title: t.title }));
      const others = this.colleaguesOn(project, e);
      out.notes.push(`${project.name} stays on ${from.name}${others.length ? ` with ${others.map((x) => x.name).join(', ')}` : ''}; ${e.name} gets a copy of it on ${to.name} as a project of their own.`);
      if (out.released.length) out.notes.push(`Their open tasks there go back on its board: ${out.released.map((t) => t.key).join(', ')}.`);
    } else if (e.workingDir) {
      out.kind = 'own';
      out.folder = e.workingDir;
    } else return no(`${e.name} has no folder to take along: give them a project or a folder first.`);
    out.name = path.basename(out.folder ?? '') || slugify(e.name);
    if (project?.extraRepos?.length && out.kind !== 'back') out.notes.push(`The project's other repositories (${project.extraRepos.map((r) => r.name).join(', ')}) stay on ${from.name}.`);

    const session = this.lastSession(e);
    if (e.executionMode === 'codex_managed') out.notes.push('A Codex employee starts a new thread there: Codex keeps its threads with the session on the old machine.');
    else out.conversation = !!session?.claudeSessionId && !!session.lastEventAt;
    if (!out.conversation && e.executionMode !== 'codex_managed') out.notes.push('They have no conversation on this machine yet: they start a new one there.');
    if (e.claudeConfigDir) out.notes.push(`They use the default Claude account on ${to.name} (an account belongs to one machine).`);
    out.notes.push(`The folder on ${from.name} stays where it is, as a copy to fall back on.`);
    if (!!from.memberId !== !!to.memberId || from.memberId !== to.memberId) {
      out.notes.push(
        to.memberId
          ? `On ${to.name} they are ${to.memberName ?? 'that member'}'s: what they do there is in that member's room, and the office's long memory keeps nothing of it.`
          : `On ${to.name} they are the office's: what they did and do is seen by everybody who works here.`,
      );
    }
    return out;
  }

  /** Begins the move (it goes on by itself; `Employee.moving` says how far it is). */
  start(employeeId: string, toHostId: string, opts: { parent?: string | null; deskId?: string | null; actor: string }): Employee {
    const plan = this.plan(employeeId, toHostId);
    if (plan.why) throw new EngineError(plan.why, 409);
    if (plan.kind !== 'back' && !opts.parent?.trim()) throw new EngineError('choose the folder on the other machine to put them in');
    // Where they will sit there: the one chosen, checked now (not after the files have gone); none chosen, one is found when they arrive.
    const deskId = opts.deskId?.trim() || null;
    if (deskId) {
      const why = this.eng.employees.deskProblem(deskId, toHostId, employeeId);
      if (why) throw new EngineError(why, 409);
    }
    const e = this.core.employees.require(employeeId);
    const moving: EmployeeMoving = { id: newId().replace(/[^a-zA-Z0-9]/g, '').slice(0, 24), fromHostId: e.hostId!, toHostId, phase: 'packing', sent: 0, total: 0, startedAt: nowIso(), by: opts.actor, error: null };
    e.moving = moving;
    this.core.put('employee', e);
    const to = this.core.hosts.require(toHostId);
    this.core.event({ type: 'employee.moving', source: 'owner', summary: `${e.name} is being moved to ${to.name}`, employeeId: e.id, hostId: e.hostId, data: { to: toHostId, kind: plan.kind } });
    this.core.audit(opts.actor, 'employee.move_started', e.id, { name: e.name, from: e.hostId, to: toHostId, kind: plan.kind, folder: plan.folder });
    void this.run(e.id, moving.id, plan, opts.parent?.trim() ?? null, opts.actor, deskId);
    return e;
  }

  /** A failed move's note, put away. */
  dismiss(employeeId: string): Employee {
    const e = this.core.employees.require(employeeId);
    if (this.isMoving(e)) throw new EngineError(`${e.name} is being moved right now.`, 409);
    e.moving = null;
    return this.core.put('employee', e);
  }

  private progress(e: Employee, change: Partial<EmployeeMoving>, every = 0): void {
    if (!e.moving) return;
    Object.assign(e.moving, change);
    const now = Date.now();
    if (every && now - (this.lastPut.get(e.id) ?? 0) < every) return;
    this.lastPut.set(e.id, now);
    this.core.put('employee', e);
  }
  private lastPut = new Map<string, number>();

  private async run(employeeId: string, moveId: string, plan: MovePlan, parent: string | null, actor: string, deskId: string | null): Promise<void> {
    const core = this.core;
    const e = core.employees.require(employeeId);
    const fromId = e.moving!.fromHostId;
    const toId = e.moving!.toHostId;
    const from = core.hosts.require(fromId);
    const to = core.hosts.require(toId);
    const rpc = <T>(hostId: string, call: any, ms: number) => core.agents.rpc<T>(hostId, call, ms);
    try {
      if (plan.stopsSession) await this.eng.sessions.stop(e.id, { actor: 'system', reason: `moving to ${to.name}` });
      const project = core.projects.get(e.projectId ?? '');
      const session = this.lastSession(e);
      const slug = slugify(e.name);
      // On a shared project their work in progress is in their worktree: committed there first, so it goes along.
      if (plan.kind === 'copy' && project?.repoPath) {
        const wt = this.eng.tasks.worktreePaths(project.repoPath, e).employee;
        const st = await rpc<{ repoRoot: string | null; branch: string | null; dirty: boolean }>(fromId, { method: 'git.status', params: { cwd: wt } }, 30_000).catch(() => null);
        if (st?.repoRoot && st.dirty && st.branch) await rpc(fromId, { method: 'git.wip', params: { cwd: wt, branch: st.branch, message: `Work in progress of ${e.name}, before moving to ${to.name}` } }, 120_000);
      }
      const oldStart = this.startCwd(e, project) ?? plan.folder!;
      const sessionIds = plan.conversation ? [...new Set(core.sessions.filter((s) => s.employeeId === e.id && s.hostId === fromId && s.origin === 'managed' && !!s.claudeSessionId).map((s) => s.claudeSessionId!))] : [];
      const packed = await rpc<MovePacked>(fromId, { method: 'move.pack', params: { moveId, kind: plan.kind === 'own' ? 'folder' : 'bundle', path: plan.folder!, claude: sessionIds.length && session ? { configDir: e.claudeConfigDir ?? null, cwd: session.cwd, sessionIds } : null } }, 60 * 60_000);
      const total = packed.files.reduce((n, f) => n + f.size, 0);
      this.progress(e, { phase: 'sending', total, sent: 0 });
      let sent = 0;
      for (const f of packed.files) {
        for (let offset = 0; offset < f.size; ) {
          const piece = await rpc<{ dataBase64: string }>(fromId, { method: 'move.read', params: { moveId, file: f.name, offset, length: PIECE } }, 120_000);
          await rpc(toId, { method: 'move.write', params: { moveId, file: f.name, offset, dataBase64: piece.dataBase64 } }, 120_000);
          const n = Buffer.byteLength(piece.dataBase64, 'base64');
          if (!n) throw new Error(`${f.name} stopped arriving at ${offset} of ${f.size} bytes`);
          offset += n;
          sent += n;
          this.progress(e, { sent }, 700);
        }
      }
      this.progress(e, { phase: 'unpacking', sent: total });
      const started = Date.parse(e.moving?.startedAt ?? '') || Date.now();
      // Old paths in the conversation, and what they become there.
      const rewrite = [...new Set([plan.folder!, session?.cwd, oldStart].filter((x): x is string => !!x))].map((p) => ({ from: p, to: '' }));

      // (Seen packing for a moment at least, whatever the size: the records move after it.)
      const showFor = (): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, started + MOVE_SHOWN_MS - Date.now())));
      if (plan.kind === 'back') {
        const original = core.projects.require(project!.copiedFrom!.projectId);
        await showFor();
        const back = await rpc<{ branches: string[]; claudeFiles: number }>(toId, { method: 'move.fetchBack', params: { moveId, files: packed.files, repo: original.repoPath!, prefix: `moved/${slug}`, claude: packed.claudeFiles ? { configDir: null, cwd: original.repoPath!, rewrite: rewrite.map((r) => ({ from: r.from, to: original.repoPath! })) } : null } }, 60 * 60_000);
        this.rehome(e, { hostId: toId, projectId: original.id, workingDir: null, deskId }, original.repoPath!, back.claudeFiles > 0 ? session : undefined);
        this.done(e, from, to, actor, `${e.name} is back on ${to.name}, in ${original.name}: their branches are there as moved/${slug}/… (${back.branches.length}).`, plan.stopsSession);
      } else {
        const rel = plan.folder && oldStart.startsWith(plan.folder + path.sep) ? path.relative(plan.folder, oldStart) : '';
        const got = await rpc<MoveUnpacked>(
          toId,
          { method: 'move.unpack', params: { moveId, files: packed.files, kind: plan.kind === 'own' ? 'folder' : 'bundle', parent: parent!, name: plan.name!, branch: plan.kind === 'copy' ? `orch/${slug}/home` : null, claude: packed.claudeFiles ? { configDir: null, rel, rewrite: rewrite.map((r) => ({ from: r.from, to: r.from === oldStart || r.from === session?.cwd ? (rel ? `<dest>/${rel}` : '<dest>') : '<dest>' })) } : null } },
          60 * 60_000,
        );
        await showFor();
        if (plan.kind === 'own') {
          if (project && project.repoPath === plan.folder) {
            project.hostId = toId;
            project.repoPath = got.path;
            project.extraRepos = [];
            delete project.integration;
            core.put('project', project);
            this.rehome(e, { hostId: toId, projectId: project.id, workingDir: e.workingDir ? got.cwd : null, deskId }, got.cwd, packed.claudeFiles ? session : undefined);
          } else this.rehome(e, { hostId: toId, projectId: e.projectId, workingDir: got.cwd, deskId }, got.cwd, packed.claudeFiles ? session : undefined);
          this.done(e, from, to, actor, `${e.name} moved to ${to.name}, with their folder (${got.path}).`, plan.stopsSession);
        } else {
          const copy = await this.copyOf(project!, toId, got.path, e, actor);
          const released = this.release(e, project!, actor, to);
          this.rehome(e, { hostId: toId, projectId: copy.id, workingDir: e.workingDir ? got.cwd : null, deskId }, got.cwd, packed.claudeFiles ? session : undefined);
          this.done(e, from, to, actor, `${e.name} moved to ${to.name}, with a copy of ${project!.name} (${got.path}) as a project of their own.${released ? ` ${released} open task${released === 1 ? '' : 's'} of theirs went back on ${project!.name}'s board.` : ''}`, plan.stopsSession);
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      const now = core.employees.get(employeeId);
      if (now?.moving?.id === moveId) {
        now.moving = { ...now.moving, phase: 'failed', error: message };
        core.put('employee', now);
      }
      core.event({ type: 'employee.move_failed', source: 'server', summary: `Moving ${e.name} to ${to.name} failed: ${message}`, employeeId, hostId: fromId, data: { to: toId, error: message } });
      this.eng.comms.notify({ kind: 'info', severity: 'warning', title: `${e.name} was not moved to ${to.name}`, body: `${message}\n\n${e.name} is where they were, on ${from.name}, with everything.`, employeeId, hostId: fromId });
    } finally {
      for (const h of [fromId, toId]) void rpc(h, { method: 'move.drop', params: { moveId } }, 30_000).catch(() => undefined);
    }
  }

  /** The records, moved: the employee onto the new machine (desk, room and project as for any change of machine), and their conversation with them. */
  private rehome(e: Employee, patch: { hostId: string; projectId: string | null; workingDir: string | null; deskId: string | null }, cwd: string, session: AgentSession | undefined): void {
    const core = this.core;
    const to = core.hosts.require(patch.hostId);
    // (No account folder there: an account belongs to one machine. Kept by a member: not any more, on a member's own computer.)
    // Done with the move in the same change that seats them there: in the office they are seen to finish and leave at once.
    e.moving = null;
    e.claudeConfigDir = null;
    if (to.memberId) e.keptBy = null;
    core.put('employee', e);
    this.eng.employees.update(e.id, { hostId: patch.hostId, projectId: patch.projectId, alsoProjectIds: [], workingDir: patch.workingDir } as any, 'system');
    // A desk there, never none: the one chosen if it is still free, else one found for them (a seat of the room, or an office desk near their project).
    const chosen = patch.deskId && !this.eng.employees.deskProblem(patch.deskId, patch.hostId, e.id) ? patch.deskId : null;
    const now = core.employees.require(e.id);
    const keep = now.deskId && !this.eng.employees.deskProblem(now.deskId, patch.hostId, e.id) ? now.deskId : null;
    const desk = chosen ?? (patch.deskId ? null : keep) ?? this.eng.employees.deskOn(patch.hostId, e.id, patch.projectId);
    if (desk && desk !== now.deskId) this.eng.employees.update(e.id, { deskId: desk } as any, 'system');
    if (session?.claudeSessionId) {
      // The conversation's record on the new machine, as one that has ended: their next start continues it (`SessionRegistry.start`).
      const moved: AgentSession = { ...session, id: newId(), hostId: patch.hostId, cwd, repoRoot: null, branch: null, tmuxSession: '', tmuxPane: null, pid: null, status: 'exited', activity: 'offline', activityDetail: `Moved from another machine`, inTurn: false, launchId: null, claudeConfigDir: null, endedAt: nowIso(), exitReason: 'moved to another machine', usage: null };
      core.put('session', moved);
    }
  }

  private async copyOf(project: Project, hostId: string, repoPath: string, e: Employee, actor: string): Promise<Project> {
    let name = project.name;
    for (let i = 2; this.core.projects.find((p) => p.name.toLowerCase() === name.toLowerCase() && p.status !== 'archived'); i++) name = `${project.name} (${i})`;
    const copy = await this.eng.tasks.createProject(
      {
        name,
        description: project.description,
        goals: project.goals,
        requirements: project.requirements,
        docs: project.docs,
        hostId,
        repoPath,
        baseBranch: project.baseBranch,
        verifyCommand: project.verifyCommand,
        verifyTimeoutSec: project.verifyTimeoutSec,
        color: project.color,
        policy: { ...project.policy },
        workspace: 'in_place',
        ownerEmployeeId: e.id,
      },
      actor,
    );
    copy.copiedFrom = { projectId: project.id, hostId: project.hostId ?? '' };
    return this.core.put('project', copy);
  }

  /** Their open tasks of the project they leave, back on its board. */
  private release(e: Employee, project: Project, actor: string, to: Host): number {
    let n = 0;
    for (const t of this.core.tasks.filter((x) => x.assigneeId === e.id && x.projectId === project.id && OPEN.includes(x.status))) {
      this.eng.comms.cancelFor({ kind: 'task', id: t.id });
      t.assigneeId = null;
      t.history.push({ ts: nowIso(), status: t.status, note: `${e.name} moved to ${to.name}; back on the board for someone else`, by: actor });
      t.updatedAt = nowIso();
      this.core.put('task', t);
      n++;
    }
    return n;
  }

  private done(e: Employee, from: Host, to: Host, actor: string, summary: string, resume = false): void {
    const now = this.core.employees.require(e.id);
    now.moving = null;
    this.core.put('employee', now);
    // Their session was running when the move began: it goes on there, with the same conversation.
    if (resume) void this.eng.sessions.start(e.id, { actor: 'system' }).catch((err) => this.core.event({ type: 'employee.moved', source: 'server', summary: `${e.name} is on ${to.name}, but their session did not start there: ${(err as Error).message}`, employeeId: e.id, hostId: to.id }));
    this.core.event({ type: 'employee.moved', source: 'server', summary, employeeId: e.id, hostId: to.id, data: { from: from.id, to: to.id } });
    this.core.audit(actor, 'employee.moved', e.id, { name: e.name, from: from.id, to: to.id });
    this.eng.comms.notify({ kind: 'info', severity: 'info', title: `${e.name} moved to ${to.name}`, body: summary, employeeId: e.id, hostId: to.id });
  }
}
