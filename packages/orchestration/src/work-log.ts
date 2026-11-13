import type { AgentSession, Employee, EmployeeOfMonth } from '@orchestrator/contracts';
import { directsOthers, isWorking } from '@orchestrator/contracts';
import type { Engine } from './engine.ts';

/**
 * How long each employee has worked this month, and who has worked the most: the office's "employee of the month"
 * (`CompanyStats.employeeOfMonth`; the decoration of that name shows their picture).
 *
 * **What counts as work.** Time a running session spends in a working state (`isWorking`: thinking, reading, coding,
 * testing, running a command…) — in conversation and on tasks alike. Not counted: being between turns, and waiting
 * for somebody — an answer, an approval, a colleague. A session that has not been heard from for a quarter of an
 * hour is not counted either: a state that nothing confirms any more is not work.
 *
 * **How.** By looking, not by bookkeeping: every tick (half a minute) each session that is working gets the time
 * since the last tick. There are a dozen places where a session's state changes without passing through one
 * function, and a count hung on all of them would be wrong the first time one was missed; a look cannot be.
 *
 * **The month** is the calendar month in UTC. The leader is this month's as soon as anybody has worked a minute in
 * it; until then last month's stays up. A foreman and a team lead are not in it — they keep others working — and
 * neither is somebody archived.
 *
 * The first time an office runs this in a month, the month so far is estimated from the record of state changes
 * (`session.activity` events): each stretch in a working state up to the next change, a quarter of an hour at most.
 */

const KV = 'work.month';
/** A session's state is believed for this long after it was last heard from. */
const HEARD_WITHIN_MS = 15 * 60_000;
/** Nobody is employee of the month for less than this. */
const LEAST_MS = 60_000;
const HOUR = 3_600_000;

export const monthOf = (at: number): string => new Date(at).toISOString().slice(0, 7);

interface Tally {
  month: string;
  ms: Record<string, number>;
}

export class WorkLog {
  private eng: Engine;
  private timer: NodeJS.Timeout | null = null;
  private tally: Tally = { month: '', ms: {} };
  private last = 0;
  private unsaved = 0;

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  start(now = Date.now()): void {
    if (this.timer) return;
    const kept = this.core.store.kvGet<Tally | null>(KV, null);
    const month = monthOf(now);
    if (kept && kept.month === month && kept.ms && typeof kept.ms === 'object') this.tally = { month, ms: { ...kept.ms } };
    else {
      this.tally = { month, ms: {} };
      try {
        this.backfill(now);
      } catch (e) {
        this.core.log('warn', `time worked this month could not be read from the record: ${(e as Error).message}`);
      }
      this.core.store.kvSet(KV, this.tally);
    }
    this.last = now;
    this.publish();
    const every = Math.max(20, this.core.timings.workTickMs);
    this.timer = setInterval(() => this.tick(), every);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.unsaved) this.save();
  }

  /** Time worked by one employee this month, in milliseconds. */
  workedMs(employeeId: string): number {
    return this.tally.ms[employeeId] ?? 0;
  }

  /** One look: whoever is working gets the time since the last look. */
  tick(now = Date.now()): void {
    const month = monthOf(now);
    if (month !== this.tally.month) {
      // A new month: everybody starts from nothing. Last month's employee of the month stays up until somebody has worked.
      this.tally = { month, ms: {} };
      this.save();
    }
    // (Twice the tick at most: a process that was stopped for an hour did not see an hour of work.)
    const dt = Math.max(0, Math.min(now - this.last, 2 * Math.max(20, this.core.timings.workTickMs)));
    this.last = now;
    if (!dt) return;
    let added = false;
    for (const s of this.core.sessions.filter((x) => x.status === 'running')) {
      if (!s.employeeId || !this.atWork(s, now)) continue;
      this.tally.ms[s.employeeId] = (this.tally.ms[s.employeeId] ?? 0) + dt;
      added = true;
    }
    if (!added) return;
    // Kept every few minutes (and at once when the leader changes): half a minute lost in a crash is nothing.
    if (this.publish() || ++this.unsaved >= 10) this.save();
  }

  private atWork(s: AgentSession, now: number): boolean {
    if (!isWorking(s.activity)) return false;
    const heard = Date.parse(s.lastEventAt ?? s.activitySince ?? '');
    return Number.isFinite(heard) && now - heard <= HEARD_WITHIN_MS;
  }

  private save(): void {
    this.unsaved = 0;
    this.core.store.kvSet(KV, this.tally);
  }

  private eligible(e: Employee | undefined): e is Employee {
    return !!e && !e.archived && !directsOthers(e.roleKey);
  }

  /** Who has worked the most this month, if anybody has worked at all. Whoever leads keeps the place on a tie. */
  leader(): EmployeeOfMonth | null {
    const current = this.core.company.employeeOfMonth;
    let best: EmployeeOfMonth | null = null;
    for (const [employeeId, ms] of Object.entries(this.tally.ms)) {
      if (ms < LEAST_MS || !this.eligible(this.core.employees.get(employeeId))) continue;
      if (!best || ms > best.ms || (ms === best.ms && current?.employeeId === employeeId)) best = { employeeId, month: this.tally.month, ms };
    }
    return best;
  }

  /**
   * Put the leader where everybody sees it. Returns whether somebody else leads now. The figure beside the name is
   * said in whole hours, so it is sent again only when the hour changes — not every half minute.
   */
  private publish(): boolean {
    const now = this.leader();
    const was = this.core.company.employeeOfMonth ?? null;
    // Nobody has worked this month yet: last month's stays, unless they are no longer here.
    if (!now) {
      if (was && !this.eligible(this.core.employees.get(was.employeeId))) {
        this.core.company.employeeOfMonth = null;
        this.core.saveCompany();
      }
      return false;
    }
    const other = !was || was.employeeId !== now.employeeId || was.month !== now.month;
    if (!other && Math.floor(was!.ms / HOUR) === Math.floor(now.ms / HOUR)) return false;
    this.core.company.employeeOfMonth = now;
    this.core.saveCompany();
    if (other) {
      const e = this.core.employees.get(now.employeeId);
      this.core.audit('office', 'employee_of_month', now.employeeId, { month: now.month, hours: Math.round(now.ms / HOUR) });
      this.core.log('info', `${e?.name ?? 'Somebody'} is the employee of the month (${now.month}): ${Math.round(now.ms / HOUR)} h of work so far`);
    }
    return other;
  }

  /**
   * The month so far, from the record of state changes: for every session, each stretch in a working state up to
   * its next change of state — a quarter of an hour at most, since nothing says the session was still there.
   */
  private backfill(now: number): void {
    const since = `${this.tally.month}-01T00:00:00.000Z`;
    const bySession = new Map<string, Array<{ at: number; employeeId: string; working: boolean }>>();
    let beforeSeq: number | undefined;
    for (let page = 0; page < 60; page++) {
      const rows = this.core.store.queryEvents({ types: ['session.activity'], since, limit: 2000, ...(beforeSeq ? { beforeSeq } : {}) });
      for (const e of rows) {
        if (!e.sessionId || !e.employeeId) continue;
        const at = Date.parse(e.ts);
        if (!Number.isFinite(at)) continue;
        let list = bySession.get(e.sessionId);
        if (!list) bySession.set(e.sessionId, (list = []));
        list.push({ at, employeeId: e.employeeId, working: isWorking((e.data as { state?: AgentSession['activity'] } | null)?.state) });
      }
      if (rows.length < 2000 || rows[0]?.seq == null) break;
      beforeSeq = rows[0].seq;
    }
    for (const list of bySession.values()) {
      list.sort((a, b) => a.at - b.at);
      for (let i = 0; i < list.length; i++) {
        const cur = list[i]!;
        if (!cur.working) continue;
        const until = list[i + 1]?.at ?? now;
        this.tally.ms[cur.employeeId] = (this.tally.ms[cur.employeeId] ?? 0) + Math.max(0, Math.min(until - cur.at, HEARD_WITHIN_MS));
      }
    }
  }
}
