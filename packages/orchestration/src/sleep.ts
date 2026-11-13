import type { AgentSession, Employee } from '@orchestrator/contracts';
import type { Engine } from './engine.ts';
import { FOREMAN_ROLE } from './foreman.ts';

/** What a session may be doing and still be put to sleep: between turns with nothing going on. */
const RESTING = new Set(['idle', 'waiting_input', 'task_complete', 'blocked']);

/**
 * Sleep: a Claude Code process that sits idle still holds a few hundred megabytes. On the office's own machines a
 * session that has had no work for a while (Settings → Employees) is stopped — the same clean stop as "Stop session",
 * so its conversation stays where Claude Code keeps it — and the employee is shown as sleeping. Whatever they are
 * next needed for starts the session again, in the folder it was in, continuing that conversation (`Comms.pump`,
 * `SessionRegistry.wake`).
 *
 * A session is only put to sleep when nothing can be lost by it: it is between turns, has no task in hand, no
 * question or approval open, is not waiting for a colleague, nothing on its way to it, nobody at its terminal, is
 * not in a meeting, and (the foreman's) is not in the middle of a round.
 */
export class Sleeper {
  private eng: Engine;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), Math.max(20, this.core.timings.sleepTickMs));
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** How long without work before a session is put to sleep, in milliseconds; 0: never. */
  idleMs(): number {
    return this.core.timings.sleepIdleMs ?? Math.max(0, this.core.settings.sleepAfterMinutes ?? 0) * 60_000;
  }

  /** Why this session is left running, in words; null when it may be put to sleep now. */
  keptAwake(employee: Employee, s: AgentSession, now = Date.now()): string | null {
    const core = this.core;
    const idle = this.idleMs();
    if (idle <= 0) return 'sleep is switched off';
    if (s.origin !== 'managed') return 'the office did not start this session';
    if (s.status !== 'running') return `the session is ${s.status}`;
    // The office's own machines only: what runs on a member's own computer is theirs to keep or stop.
    if (this.eng.hosts.memberOfHost(s.hostId)) return "it runs on a member's own computer";
    // A person's own session (they sat down at a desk and opened it) is theirs to leave open.
    if (employee.selfDriven) return "it is a person's own session";
    if (!core.agents.isOnline(s.hostId)) return 'its machine is offline';
    if (!s.capabilities.hooks || s.inTurn !== false) return 'it may be in the middle of a turn';
    if (!RESTING.has(s.activity)) return `it is ${s.activity}`;
    // Stopping the session would stop that command too.
    if (s.background?.length) return 'a command of theirs is running in the background';
    if (core.gateway.isPaused(s.id) || s.control === 'PAUSED') return 'the owner paused it';
    if (s.control === 'HUMAN_OBSERVING' || s.control === 'HUMAN_CONTROLLED' || core.gateway.isHumanControlled(s.id)) return 'someone is at its terminal';
    if (s.control !== 'AGENT_CONTROLLED') return 'its terminal cannot be reached';
    if (this.eng.tasks.currentTask(employee.id) || this.eng.tasks.isStarting(employee.id)) return 'they have a task in hand';
    if (core.questions.find((q) => q.employeeId === employee.id && (q.status === 'open' || q.status === 'answered') && q.channel !== 'system')) return 'a question of theirs is open';
    if (s.waitingOn) return 'they are waiting for a colleague';
    if (this.eng.comms.pending(employee.id)) return 'something is on its way to them';
    if (this.eng.meetings.isBusy(employee.id) || this.eng.meetings.activeFor(employee.id)) return 'they are in a meeting';
    if (employee.roleKey === FOREMAN_ROLE && this.eng.foreman.inRound()) return 'a round is in progress';
    const since = Math.max(Date.parse(s.activitySince) || 0, Date.parse(s.lastEventAt ?? '') || 0, Date.parse(s.startedAt) || 0);
    if (now - since < idle) return 'it has not been idle long enough';
    return null;
  }

  async tick(now = Date.now()): Promise<number> {
    if (this.busy || this.idleMs() <= 0) return 0;
    this.busy = true;
    let slept = 0;
    try {
      for (const employee of this.core.employees.filter((e) => !e.archived)) {
        const s = this.core.runningSessionOf(employee.id);
        if (!s || this.keptAwake(employee, s, now)) continue;
        const minutes = Math.round(this.idleMs() / 60_000);
        try {
          await this.eng.sessions.stop(employee.id, { actor: 'office', asleep: true, reason: minutes >= 1 ? `asleep after ${minutes} min without work` : 'asleep after a while without work' });
          slept++;
        } catch (e) {
          this.core.log('warn', `could not put ${employee.name}'s session to sleep: ${(e as Error).message}`);
        }
      }
    } finally {
      this.busy = false;
    }
    return slept;
  }
}
