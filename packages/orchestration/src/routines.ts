import type { Employee, Routine, RoutineOutcome } from '@orchestrator/contracts';
import { ROUTINE_LIMITS, newId, nowIso, truncate } from '@orchestrator/contracts';
import { EngineError } from './core.ts';
import type { Engine } from './engine.ts';

/**
 * Routines: standing instructions the office repeats for one employee — "check the support desk every five
 * minutes, and put anything new on the task board".
 *
 * A run is nothing special: the instruction is delivered into the employee's real session the way a message from
 * the owner is, so it is in their conversation and in the feed, and what they do about it they do with the tools
 * they already have. What this module decides is only *when*:
 *
 *   between turns, nothing waiting on the owner      → delivered
 *   mid-turn, a question or approval open, waiting
 *   for a colleague, or the run before this one not
 *   yet delivered                                    → skipped; looked at again one interval later
 *   no session                                       → their session is started (as talking to them does)
 *   their machine is away, they are paused,
 *   their project is paused, outside their hours     → held; it runs once when that is over
 *
 * Runs never pile up: there is at most one undelivered run per routine, and the next run is counted from the
 * moment of the look, not from the slots that were missed.
 */
export class Routines {
  private eng: Engine;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  /** Begin looking for routines that are due. One that came due while the office was down runs once. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), Math.max(20, this.core.timings.routineTickMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(): Routine[] {
    return this.core.routines.all().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  private intervalMs(r: Routine): number {
    return r.everyMinutes * this.core.timings.routineMinuteMs;
  }

  private static minutes(raw: unknown, fallback: number): number {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || Math.round(n) !== n) throw new EngineError('how often: a whole number of minutes');
    if (n < ROUTINE_LIMITS.minMinutes || n > ROUTINE_LIMITS.maxMinutes) throw new EngineError(`how often: between ${ROUTINE_LIMITS.minMinutes} minute and ${ROUTINE_LIMITS.maxMinutes} minutes (a day)`);
    return n;
  }

  private static words(raw: unknown): string {
    const text = String(raw ?? '').replace(/\u0000/g, '').trim();
    if (!text) throw new EngineError('say what they should do each time');
    if (text.length > ROUTINE_LIMITS.instruction) throw new EngineError(`the instruction is too long (at most ${ROUTINE_LIMITS.instruction} characters)`);
    return text;
  }

  /** Set a routine up. Unless told otherwise its first run is now. */
  create(input: { employeeId?: unknown; instruction?: unknown; everyMinutes?: unknown; enabled?: unknown; runNow?: unknown }, actor = 'owner'): Routine {
    const employee = this.core.employees.require(String(input.employeeId ?? ''));
    if (employee.archived) throw new EngineError(`${employee.name} is archived`);
    if (this.core.routines.filter((r) => r.employeeId === employee.id).length >= ROUTINE_LIMITS.perEmployee) throw new EngineError(`${employee.name} already has ${ROUTINE_LIMITS.perEmployee} routines; remove one first`);
    const now = Date.now();
    const routine: Routine = {
      id: newId().slice(0, 8),
      employeeId: employee.id,
      instruction: Routines.words(input.instruction),
      everyMinutes: Routines.minutes(input.everyMinutes, ROUTINE_LIMITS.defaultMinutes),
      enabled: input.enabled !== false,
      createdAt: new Date(now).toISOString(),
      createdBy: actor,
      lastRunAt: null,
      nextRunAt: null,
      runs: 0,
      lastOutcome: null,
      lastOutcomeAt: null,
      lastNote: null,
      lastMessageId: null,
    };
    routine.nextRunAt = routine.enabled ? new Date(now + (input.runNow === false ? this.intervalMs(routine) : 0)).toISOString() : null;
    this.core.put('routine', routine);
    this.core.audit(actor, 'routine.created', routine.id, { employee: employee.name, everyMinutes: routine.everyMinutes, instruction: truncate(routine.instruction, 200) });
    this.core.event({ type: 'routine.created', source: actor === 'owner' ? 'owner' : 'server', summary: `${employee.name} has a new routine, every ${routine.everyMinutes} min: ${truncate(routine.instruction, 100)}`, employeeId: employee.id, projectId: employee.projectId, data: { routineId: routine.id, everyMinutes: routine.everyMinutes } });
    if (routine.enabled && input.runNow !== false) this.look(routine, now, true);
    return routine;
  }

  update(id: string, patch: { instruction?: unknown; everyMinutes?: unknown; enabled?: unknown }, actor = 'owner'): Routine {
    const r = this.core.routines.require(id);
    const employee = this.core.employees.get(r.employeeId);
    const before = { instruction: r.instruction, everyMinutes: r.everyMinutes, enabled: r.enabled };
    if (patch.instruction !== undefined) r.instruction = Routines.words(patch.instruction);
    if (patch.everyMinutes !== undefined) r.everyMinutes = Routines.minutes(patch.everyMinutes, r.everyMinutes);
    if (patch.enabled !== undefined) r.enabled = patch.enabled === true;
    const now = Date.now();
    // Switched on again, or given another rhythm: the next run is one interval from now, never a burst of missed ones.
    if (!r.enabled) r.nextRunAt = null;
    else if (!before.enabled || before.everyMinutes !== r.everyMinutes || !r.nextRunAt) r.nextRunAt = new Date(now + this.intervalMs(r)).toISOString();
    this.core.put('routine', r);
    const changed = (Object.keys(before) as Array<keyof typeof before>).filter((k) => before[k] !== r[k]);
    if (changed.length) {
      this.core.audit(actor, 'routine.updated', r.id, { employee: employee?.name, changed, everyMinutes: r.everyMinutes, enabled: r.enabled });
      this.core.event({ type: 'routine.updated', source: actor === 'owner' ? 'owner' : 'server', summary: `${employee?.name ?? 'An employee'}'s routine ${!r.enabled ? 'was paused' : !before.enabled ? 'runs again' : `now runs every ${r.everyMinutes} min`}: ${truncate(r.instruction, 100)}`, employeeId: r.employeeId, projectId: employee?.projectId ?? null, data: { routineId: r.id, changed, quiet: true } });
    }
    return r;
  }

  remove(id: string, actor = 'owner'): void {
    const r = this.core.routines.require(id);
    const employee = this.core.employees.get(r.employeeId);
    // A run of it that is still waiting to be delivered goes with it.
    if (r.lastMessageId && this.core.messages.get(r.lastMessageId)?.delivery.status === 'queued') this.eng.comms.cancelFor({ kind: 'message', id: r.lastMessageId });
    this.core.remove('routine', id);
    this.core.audit(actor, 'routine.removed', id, { employee: employee?.name, instruction: truncate(r.instruction, 200) });
    this.core.event({ type: 'routine.removed', source: actor === 'owner' ? 'owner' : 'server', summary: `${employee?.name ?? 'An employee'}'s routine was removed: ${truncate(r.instruction, 100)}`, employeeId: r.employeeId, projectId: employee?.projectId ?? null, data: { routineId: id, quiet: true } });
  }

  /** Run it now, whatever its rhythm says. What came of it is in the routine's last outcome. */
  runNow(id: string, actor = 'owner'): Routine {
    const r = this.core.routines.require(id);
    this.core.audit(actor, 'routine.run_now', r.id, {});
    this.look(r, Date.now(), true);
    return r;
  }

  tick(now = Date.now()): void {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const r of this.core.routines.filter((x) => x.enabled && !!x.nextRunAt && Date.parse(x.nextRunAt!) <= now)) {
        try {
          this.look(r, now, false);
        } catch (e) {
          this.core.log('warn', `routine ${r.id}: ${(e as Error).message}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Record what a look at a routine came to. Written (and sent to the windows) only when something changed. */
  private note(r: Routine, outcome: RoutineOutcome, note: string | null, now: number, next: number | 'keep'): void {
    const nextRunAt = next === 'keep' ? r.nextRunAt : new Date(next).toISOString();
    const same = r.lastOutcome === outcome && r.lastNote === note && r.nextRunAt === nextRunAt;
    if (same && outcome !== 'delivered') return;
    const first = r.lastOutcome !== outcome || r.lastNote !== note;
    r.lastOutcome = outcome;
    r.lastNote = note;
    r.lastOutcomeAt = new Date(now).toISOString();
    r.nextRunAt = nextRunAt;
    this.core.put('routine', r);
    // Said in the feed once per spell, not at every look.
    if (first && outcome !== 'delivered') {
      const employee = this.core.employees.get(r.employeeId);
      this.core.event({ type: 'routine.skipped', source: 'server', summary: `${employee?.name ?? 'An employee'}'s routine did not run: ${note ?? outcome}`, employeeId: r.employeeId, projectId: employee?.projectId ?? null, data: { routineId: r.id, outcome, quiet: true } });
    }
  }

  /** Why a routine is held back altogether, in words; null when it may run. */
  private held(employee: Employee | undefined): string | null {
    if (!employee) return 'the employee no longer exists';
    if (employee.archived) return `${employee.name} is archived`;
    if (!this.eng.tasks.withinSchedule(employee)) return `${employee.name} is outside their working hours`;
    const project = this.core.projects.get(employee.projectId);
    if (project?.status === 'paused') return `project ${project.name} is paused`;
    const session = this.core.runningSessionOf(employee.id);
    if (session && this.core.gateway.isPaused(session.id)) return `${employee.name} is paused`;
    return null;
  }

  /**
   * A routine somebody else set for an employee on a member's own computer does not run while that member's room is
   * closed (it types into their session, and starts it). One the member set themselves goes on.
   */
  private closedRoom(r: Routine, employee: Employee | undefined): string | null {
    const host = employee ? this.core.hosts.get(employee.hostId) : undefined;
    if (!host?.memberId || !this.eng.hosts.isClosed(host.memberId)) return null;
    return r.createdBy === `member:${host.memberName}` ? null : `${employee!.name}'s room is closed`;
  }

  /** Why this is not the moment to hand a running session something new, in words; null when it is. */
  private busy(employee: Employee): string | null {
    const session = this.core.runningSessionOf(employee.id)!;
    if (session.status === 'starting') return `${employee.name}'s session is still starting`;
    if (this.core.gateway.isHumanControlled(session.id)) return `someone is at ${employee.name}'s terminal`;
    const open = this.core.questions.find((q) => q.employeeId === employee.id && q.status === 'open' && q.channel !== 'system');
    if (open) return `${employee.name} is waiting for ${open.kind === 'permission' ? 'an approval' : 'an answer'} from you`;
    // Waiting for a colleague (in a held tool call, or at the prompt until the answer comes) is not the moment either.
    if (session.waitingOn) return `${employee.name} is waiting for ${this.eng.waits.words(session.waitingOn)}`;
    // With hooks the office knows when Claude is between turns; without them it cannot tell, and does not hold back.
    if (session.capabilities.hooks && session.inTurn !== false) return `${employee.name} was in the middle of something`;
    // (Another routine's run does not count: two that come due together are handed over one after the other.)
    if (this.eng.comms.pending(employee.id, true)) return `${employee.name} has other things waiting to be delivered first`;
    return null;
  }

  private look(r: Routine, now: number, manual: boolean): void {
    const employee = this.core.employees.get(r.employeeId);
    const every = this.intervalMs(r);
    const held = this.held(employee) ?? this.closedRoom(r, employee);
    // Held: nothing is counted down meanwhile, so it runs once when the hold is over.
    if (held || !employee) return this.note(r, 'not_run', held, now, manual ? now + every : 'keep');

    // At most one undelivered run: while the one before is still waiting, there is no second one behind it.
    const previous = r.lastMessageId ? this.core.messages.get(r.lastMessageId) : undefined;
    if (previous?.delivery.status === 'queued') {
      // Someone without a session is woken for it again (a start that failed is retried here, one interval later).
      if (!this.core.runningSessionOf(employee.id)) this.eng.comms.schedulePump(employee.id, 0);
      const problem = this.core.runningSessionOf(employee.id) ? null : this.eng.comms.wakeProblem(employee.id);
      return this.note(r, problem ? 'failed' : 'skipped_busy', problem ? `their session could not be started: ${truncate(problem, 160)}` : 'the run before this one has not been delivered yet', now, now + every);
    }

    if (this.core.runningSessionOf(employee.id)) {
      const busy = this.busy(employee);
      if (busy) return this.note(r, 'skipped_busy', busy, now, now + every);
    } else {
      // No session: it is started for this, as talking to them does — if their machine is there.
      const no = this.eng.sessions.cannotStart(employee);
      if (no) return this.note(r, 'skipped_offline', no, now, manual ? now + every : 'keep');
    }

    const waking = !this.core.runningSessionOf(employee.id);
    const msg = this.eng.comms.sendMessage({
      from: { kind: 'system', id: null, name: 'The office' },
      toEmployeeId: employee.id,
      body: `Routine (every ${r.everyMinutes} min): ${r.instruction}`,
      kind: 'system',
      routineId: r.id,
    });
    r.lastMessageId = msg.id;
    r.lastRunAt = new Date(now).toISOString();
    r.runs++;
    this.note(r, 'delivered', waking ? `${employee.name} had no session: it is being started for this` : null, now, now + every);
  }
}
