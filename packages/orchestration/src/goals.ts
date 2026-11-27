import type { AgentSession, Employee, EmployeeGoal } from '@orchestrator/contracts';
import { nowIso, redactSecrets, truncate } from '@orchestrator/contracts';
import { EngineError } from './core.ts';
import type { Engine } from './engine.ts';

/**
 * Goals — the office's `/goal`. An employee is given a condition ("every test in packages/api passes and the branch is
 * pushed") and keeps working toward it, turn after turn, until it holds: when a turn ends and it does not, the office
 * sends them on through the Stop hook it already holds for every session (as Claude Code's own `/goal` does with a
 * Stop hook of its own). They say when it holds (`goal_met`, with how they know); where a person gave a command to
 * check it by, that command decides.
 *
 * What stops it besides being met: a person clears it; three turns in a row in which they did nothing at all (no
 * tool used — going round in words is not work); and a ceiling of turns, so that a goal nobody watches cannot spend
 * an account for ever. Either way the owner is told.
 *
 * What pauses it (the office does not send them on, the goal stands): a question of theirs that is open, a wait for a
 * colleague, a command of theirs running in the background, a blocker they reported, the session paused or somebody
 * at its terminal. Whatever ends that gives them a new turn, and at its end the goal is there again.
 *
 * Who sets one: whoever may give that employee work (an owner, or a colleague for a shared employee or their own), and
 * the employee for themselves (`set_goal`) — not over a person's goal. A command to check by is given only by a
 * person: it runs on the machine outside Claude Code's permissions, as a project's verification command does.
 */

/** Turns in a row without anything done after which a goal stops. */
export const GOAL_IDLE_TURNS = 3;
/** The most turns the office sends anybody on toward one goal. */
export const GOAL_MAX_TURNS = 100;
const CONDITION_MAX = 2000;
const CHECK_MAX = 500;
const CHECK_TIMEOUT_MS = 10 * 60_000;

export type GoalSetter = { kind: 'owner'; id: string | null; name: string } | { kind: 'employee'; id: string; name: string };

export class Goals {
  private eng: Engine;

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  active(employeeId: string | null | undefined): EmployeeGoal | null {
    const g = employeeId ? this.core.employees.get(employeeId)?.goal : null;
    return g && g.status === 'active' ? g : null;
  }

  /** Give an employee a goal (it replaces the one they had). They are told at once, and started if they have no session. */
  set(employeeId: string, input: { condition: unknown; check?: unknown }, by: GoalSetter): EmployeeGoal {
    const e = this.core.employees.require(employeeId);
    if (e.archived) throw new EngineError(`${e.name} has left the team`, 409);
    const condition = typeof input.condition === 'string' ? input.condition.trim() : '';
    if (!condition) throw new EngineError('Say what has to be true for the goal to be met.', 400);
    if (condition.length > CONDITION_MAX) throw new EngineError(`A goal is said in at most ${CONDITION_MAX} characters.`, 400);
    const check = typeof input.check === 'string' && input.check.trim() ? input.check.trim() : null;
    if (check && by.kind !== 'owner') throw new EngineError('Only a person gives a command to check a goal by.', 403);
    if (check && check.length > CHECK_MAX) throw new EngineError(`A command to check by is at most ${CHECK_MAX} characters.`, 400);
    const was = this.active(e.id);
    if (by.kind === 'employee' && was && was.setBy.kind === 'owner') {
      throw new EngineError(`You already have a goal ${was.setBy.name} gave you: "${truncate(was.condition, 200)}". It stays until it is met or ${was.setBy.name} clears it.`, 409);
    }
    const goal: EmployeeGoal = { condition, check, setBy: { kind: by.kind, id: by.id, name: by.name }, setAt: nowIso(), status: 'active', turns: 0, idle: 0, endedAt: null, outcome: null };
    this.core.put('employee', { ...e, goal });
    this.core.audit(by.kind === 'owner' ? `owner:${by.name}` : `employee:${by.name}`, 'goal.set', e.id, { employee: e.name, condition: truncate(redactSecrets(condition), 400), check: check ? truncate(redactSecrets(check), 200) : null, replaced: was ? truncate(was.condition, 200) : null });
    this.core.event({ type: 'agent.goal', source: 'server', summary: `${e.name}'s goal${by.kind === 'owner' ? ` (from ${by.name})` : ''}: ${truncate(condition, 160)}`, employeeId: e.id, projectId: e.projectId ?? null, data: { phase: 'set', condition: truncate(condition, 400), check, by: by.name } });
    // They are told in their session — unless they set it themselves, in which case they know.
    if (by.kind === 'owner') {
      this.eng.comms.sendMessage({
        from: { kind: 'system', id: null, name: 'The office' },
        toEmployeeId: e.id,
        kind: 'system',
        body: `${by.name} has given you a goal:\n\n${condition}\n\n${GOAL_RULES(check)}`,
      });
    }
    return goal;
  }

  /** Clear an employee's goal (a person, or the employee for a goal they set themselves). */
  clear(employeeId: string, by: GoalSetter, why = 'cleared'): EmployeeGoal | null {
    const e = this.core.employees.require(employeeId);
    const g = this.active(e.id);
    if (!g) return null;
    if (by.kind === 'employee' && g.setBy.kind === 'owner') throw new EngineError(`${g.setBy.name} gave you this goal; only a person can clear it. If you cannot reach it, say so with report_blocker.`, 403);
    this.end(e, g, 'stopped', `${why} by ${by.name}`);
    this.core.audit(by.kind === 'owner' ? `owner:${by.name}` : `employee:${by.name}`, 'goal.cleared', e.id, { employee: e.name, condition: truncate(g.condition, 200) });
    return this.core.employees.require(e.id).goal ?? null;
  }

  /** The employee says the goal holds. With a command to check by, that command decides. */
  async met(employee: Employee, session: AgentSession | undefined, evidence: unknown): Promise<{ text: string; isError: boolean }> {
    const g = this.active(employee.id);
    if (!g) return { text: 'You have no goal right now.', isError: true };
    const how = typeof evidence === 'string' ? evidence.trim() : '';
    if (how.length < 10) return { text: 'Say how you know the goal holds (what you ran, what you saw), in "evidence".', isError: true };
    if (g.check) {
      const host = session?.hostId ?? employee.hostId;
      const cwd = session?.cwd ?? employee.workingDir;
      if (!host || !cwd) return { text: 'The office cannot tell where to check your goal (no session, no folder). Tell the boss with report_blocker.', isError: true };
      let res: { exitCode: number | null; timedOut?: boolean; outputTail?: string };
      try {
        res = await this.core.agents.rpc(host, { method: 'verify.run', params: { cwd, command: g.check, timeoutMs: CHECK_TIMEOUT_MS } }, CHECK_TIMEOUT_MS + 20_000);
      } catch (e) {
        return { text: `The office could not run the check (${(e as Error).message}). Your goal stands; tell the boss with report_blocker if this persists.`, isError: true };
      }
      if (res.exitCode !== 0 || res.timedOut) {
        this.core.event({ type: 'agent.goal', source: 'server', summary: `${employee.name} said their goal holds; the check did not pass (${res.timedOut ? 'timed out' : `exit ${res.exitCode}`})`, employeeId: employee.id, data: { phase: 'check_failed', condition: truncate(g.condition, 400), check: g.check, exitCode: res.exitCode, quiet: true } });
        return { text: `Not yet: the check "${g.check}" ${res.timedOut ? 'timed out' : `ended with exit code ${res.exitCode}`}.\n\nOutput (tail):\n${truncate(String(res.outputTail ?? ''), 3000)}\n\nYour goal stands. Keep working toward it.`, isError: true };
      }
    }
    this.end(employee, g, 'met', truncate(redactSecrets(how), 1000));
    return { text: `Goal met${g.check ? ` — "${g.check}" passes` : ''}. Well done. The office will not send you on toward it any more.`, isError: false };
  }

  /**
   * A turn of theirs is ending (the Stop hook, held): the words that send them on toward their goal, or null when it
   * does not hold them — no goal, or something they wait for. `didSomething`: a tool was used in this turn.
   */
  onStop(employee: Employee, session: AgentSession, didSomething: boolean): string | null {
    const g = this.active(employee.id);
    if (!g) return null;
    // They reported that they cannot go on: the owner has it; sending them on would only repeat it.
    if (session.activity === 'blocked') return null;
    const idle = didSomething ? 0 : g.idle + 1;
    if (idle >= GOAL_IDLE_TURNS) {
      this.end(employee, g, 'stopped', `no progress: ${GOAL_IDLE_TURNS} turns in a row ended without anything done`);
      this.eng.comms.notify({ kind: 'blocked', severity: 'warning', title: `${employee.name} stopped working toward their goal`, body: `Three turns in a row ended without anything done, so the office no longer sends them on. The goal was: "${truncate(g.condition, 300)}". Look at their terminal, or give them the goal again with what is missing.`, employeeId: employee.id, sessionId: session.id });
      return null;
    }
    if (g.turns >= GOAL_MAX_TURNS) {
      this.end(employee, g, 'stopped', `the office sent them on ${GOAL_MAX_TURNS} times and it still did not hold`);
      this.eng.comms.notify({ kind: 'blocked', severity: 'warning', title: `${employee.name}'s goal is not met after ${GOAL_MAX_TURNS} turns`, body: `The office stopped sending them on toward "${truncate(g.condition, 300)}". Look at where they are, and give it again if it should go on.`, employeeId: employee.id, sessionId: session.id });
      return null;
    }
    const next: EmployeeGoal = { ...g, turns: g.turns + 1, idle };
    this.core.put('employee', { ...this.core.employees.require(employee.id), goal: next });
    return `Goal not yet met — keep working toward it:\n\n${g.condition}\n\n${GOAL_RULES(g.check)}${idle ? `\n\nThat turn ended without anything done (${idle} of ${GOAL_IDLE_TURNS}): do the next concrete step now.` : ''}`;
  }

  /** For `get_current_task`: what they work toward, if anything. */
  describe(employeeId: string): string | null {
    const g = this.active(employeeId);
    if (!g) return null;
    return `Your goal (${g.setBy.kind === 'owner' ? `from ${g.setBy.name}` : 'you set it'}, ${g.turns} turns so far): ${g.condition}${g.check ? `\nChecked by: ${g.check}` : ''}\nKeep working until it holds, then call goal_met with how you know.`;
  }

  private end(employee: Employee, g: EmployeeGoal, status: 'met' | 'stopped', outcome: string): void {
    const e = this.core.employees.require(employee.id);
    this.core.put('employee', { ...e, goal: { ...g, status, endedAt: nowIso(), outcome } });
    const summary = status === 'met' ? `${e.name} met their goal: ${truncate(g.condition, 140)}` : `${e.name}'s goal stopped (${truncate(outcome, 120)}): ${truncate(g.condition, 120)}`;
    this.core.event({ type: 'agent.goal', source: 'server', summary, employeeId: e.id, projectId: e.projectId ?? null, data: { phase: status, condition: truncate(g.condition, 400), turns: g.turns, outcome: truncate(outcome, 400) } });
    if (status === 'met' && g.setBy.kind === 'owner') this.eng.comms.notify({ kind: 'task_completed', severity: 'success', title: `${e.name} met the goal you gave them`, body: `"${truncate(g.condition, 300)}" — ${truncate(outcome, 500)}`, employeeId: e.id });
  }
}

/** What an employee with a goal is told each time: how to go on, and how to finish. */
function GOAL_RULES(check: string | null): string {
  return [
    'Treat it as your directive: work toward it now, step after step, without stopping to ask what to do next. The office sends you on each time your turn ends until it holds.',
    `When it holds, call goal_met with how you know (what you ran, what you saw)${check ? ` — the office then runs \`${check}\` to confirm` : ''}.`,
    'If you truly cannot go on (something only a person can give you), say so with report_blocker or ask_boss; the office waits for the answer.',
  ].join('\n');
}
