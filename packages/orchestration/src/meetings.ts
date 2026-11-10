import type { DeliveryState, Employee, Meeting, MeetingContribution } from '@orchestrator/contracts';
import { newId, nowIso, truncate } from '@orchestrator/contracts';
import { EngineError } from './core.ts';
import type { Engine } from './engine.ts';
import { meetingPrompt } from './prompts.ts';
import type { ProposedTask } from './tasks.ts';

/**
 * Meetings as a real workflow.
 *
 *   proposals  → every participant's actual session is asked for a proposal
 *   responses  → each one receives the others' proposals and answers them
 *   synthesis  → the facilitator's session writes the decision document and tasks
 *
 * Every word in a meeting record was produced by a participant's Claude Code
 * session through the meeting_* tools. A participant who does not answer in
 * time is recorded as absent; nothing is written on their behalf.
 */
export class MeetingManager {
  private eng: Engine;
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  restore(): void {
    for (const m of this.core.meetings.filter((x) => x.status === 'proposals' || x.status === 'responses' || x.status === 'synthesis')) {
      const elapsed = Date.now() - Date.parse(m.roundStartedAt ?? m.createdAt);
      this.arm(m, Math.max(5000, this.core.timings.meetingRoundMs - elapsed));
    }
  }

  private active(m: Meeting): boolean {
    return m.status === 'proposals' || m.status === 'responses' || m.status === 'synthesis';
  }

  /** While a meeting round is waiting on someone, the scheduler leaves them alone. */
  isBusy(employeeId: string): boolean {
    for (const m of this.core.meetings.all()) {
      if (!this.active(m) || m.absent.includes(employeeId)) continue;
      if (m.status === 'synthesis') {
        if (m.facilitatorId === employeeId) return true;
        continue;
      }
      if (!m.participantIds.includes(employeeId)) continue;
      const round = m.status === 'proposals' ? 'proposal' : 'response';
      if (!m.contributions.find((c) => c.employeeId === employeeId && c.round === round)) return true;
    }
    return false;
  }

  activeFor(employeeId: string): Meeting | undefined {
    return this.core.meetings.find((m) => this.active(m) && (m.participantIds.includes(employeeId) || m.facilitatorId === employeeId));
  }

  create(input: { topic: string; context?: string; projectId?: string | null; participantIds: string[]; facilitatorId?: string | null }, actor = 'owner'): Meeting {
    const topic = input.topic?.trim();
    if (!topic) throw new EngineError('a meeting needs a topic');
    const participants = [...new Set(input.participantIds)].map((id) => this.core.employees.require(id)).filter((e) => !e.archived);
    if (participants.length < 2) throw new EngineError('a meeting needs at least two participants');
    // Someone asleep can take part: the invitation wakes them. Someone who was never started, or was stopped, cannot.
    const here = (e: Employee) => this.eng.sessions.present(e.id);
    const unavailable = participants.filter((e) => !here(e));
    if (unavailable.length === participants.length) throw new EngineError('none of the invited employees has a running session');
    const facilitator =
      (input.facilitatorId ? this.core.employees.get(input.facilitatorId) : undefined) ??
      participants.find((e) => e.roleKey === 'architect' && here(e)) ??
      participants.find((e) => e.roleKey === 'pm' && here(e)) ??
      participants.find((e) => here(e))!;
    const meeting: Meeting = {
      id: newId().slice(0, 8),
      projectId: input.projectId ?? facilitator.projectId ?? null,
      topic,
      context: input.context ?? '',
      status: 'proposals',
      facilitatorId: facilitator.id,
      participantIds: participants.map((e) => e.id),
      // People without a session (other than asleep) cannot take part; that is recorded up front.
      absent: unavailable.map((e) => e.id),
      contributions: [],
      decisionDoc: null,
      generatedTaskIds: [],
      createdAt: nowIso(),
      roundStartedAt: nowIso(),
      concludedAt: null,
    };
    this.core.put('meeting', meeting);
    this.core.audit(actor, 'meeting.created', meeting.id, { topic, participants: participants.map((e) => e.name) });
    this.core.event({
      type: 'meeting.created',
      source: 'owner',
      summary: `Meeting started: ${topic} (${participants.map((e) => e.name).join(', ')})`,
      projectId: meeting.projectId,
      correlationId: meeting.id,
      data: { meetingId: meeting.id, participantIds: meeting.participantIds, facilitatorId: facilitator.id, absent: meeting.absent },
    });
    this.startRound(meeting, 'proposals');
    return meeting;
  }

  private present(m: Meeting): Employee[] {
    return m.participantIds.filter((id) => !m.absent.includes(id)).map((id) => this.core.employees.get(id)).filter((e): e is Employee => !!e);
  }

  private arm(m: Meeting, ms = this.core.timings.meetingRoundMs): void {
    const prev = this.timers.get(m.id);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.timers.delete(m.id);
      this.roundTimedOut(m.id);
    }, ms);
    timer.unref?.();
    this.timers.set(m.id, timer);
  }

  private digest(m: Meeting, rounds: Array<MeetingContribution['round']>, excludeId?: string) {
    return m.contributions
      .filter((c) => rounds.includes(c.round) && c.employeeId !== excludeId)
      .map((c) => {
        const e = this.core.employees.get(c.employeeId);
        return { name: `${e?.name ?? 'Unknown'}${c.round === 'response' ? ' — response' : ''}`, title: e?.title ?? '', body: c.body, disagreements: c.disagreements };
      });
  }

  private startRound(m: Meeting, status: 'proposals' | 'responses' | 'synthesis'): void {
    m.status = status;
    m.roundStartedAt = nowIso();
    this.core.put('meeting', m);
    const round = status === 'proposals' ? 'proposal' : status === 'responses' ? 'response' : 'synthesis';
    this.core.event({ type: 'meeting.round_started', source: 'server', summary: `Meeting "${truncate(m.topic, 60)}": ${status} round`, projectId: m.projectId, correlationId: m.id, data: { meetingId: m.id, round: status } });
    const targets = status === 'synthesis' ? [this.core.employees.get(m.facilitatorId)].filter((e): e is Employee => !!e) : this.present(m);
    for (const e of targets) {
      const others = status === 'proposals' ? [] : status === 'responses' ? this.digest(m, ['proposal'], e.id) : this.digest(m, ['proposal', 'response']);
      const text = meetingPrompt(m, e, round, others);
      this.eng.comms.deliver(e.id, 'MEETING', `${m.id}-${round}-${e.id.slice(0, 8)}`, { kind: 'meeting', id: m.id }, text);
    }
    this.arm(m);
    this.eng.tasks.schedule();
  }

  onDeliveryState(_meetingId: string, _employeeId: string, _state: DeliveryState): void {
    // Delivery of meeting prompts is visible through contributions arriving; nothing to persist.
  }

  contribute(employee: Employee, meetingId: string, body: string, disagreements: string[] = []): string {
    const m = this.core.meetings.get(meetingId) ?? this.core.meetings.find((x) => x.id.startsWith(meetingId));
    if (!m) throw new EngineError(`no meeting "${meetingId}"`);
    if (!m.participantIds.includes(employee.id)) throw new EngineError('you are not a participant in that meeting');
    if (m.status !== 'proposals' && m.status !== 'responses') throw new EngineError(`that meeting is not collecting contributions right now (status ${m.status})`);
    const round = m.status === 'proposals' ? 'proposal' : 'response';
    if (m.contributions.find((c) => c.employeeId === employee.id && c.round === round)) throw new EngineError(`you already submitted your ${round}`);
    if (!body.trim()) throw new EngineError('contribution is empty');
    m.contributions.push({ id: newId(), employeeId: employee.id, round, body: body.trim(), disagreements: disagreements.filter((d) => typeof d === 'string' && d.trim()), ts: nowIso() });
    // Someone marked absent who answers after all is simply present again.
    m.absent = m.absent.filter((id) => id !== employee.id);
    this.core.put('meeting', m);
    this.core.event({
      type: 'meeting.contribution',
      source: 'mcp',
      summary: `${employee.name} submitted a ${round} in "${truncate(m.topic, 60)}"`,
      employeeId: employee.id,
      projectId: m.projectId,
      correlationId: m.id,
      data: { meetingId: m.id, round, disagreements: disagreements.length },
    });
    this.advanceIfComplete(m);
    return round === 'proposal' ? 'Proposal recorded. You will receive the other proposals for the response round shortly; wait for that.' : 'Response recorded. The facilitator will write the decision document.';
  }

  private advanceIfComplete(m: Meeting): void {
    const round = m.status === 'proposals' ? 'proposal' : 'response';
    const present = this.present(m);
    if (!present.every((e) => m.contributions.find((c) => c.employeeId === e.id && c.round === round))) return;
    if (m.status === 'proposals') {
      if (present.length < 2) this.startRound(m, 'synthesis');
      else this.startRound(m, 'responses');
    } else if (m.status === 'responses') this.startRound(m, 'synthesis');
  }

  private roundTimedOut(meetingId: string): void {
    const m = this.core.meetings.get(meetingId);
    if (!m || !this.active(m)) return;
    if (m.status === 'synthesis') {
      // The facilitator never produced a decision: close honestly with the raw record.
      this.finish(m, null, []);
      return;
    }
    const round = m.status === 'proposals' ? 'proposal' : 'response';
    const silent = this.present(m).filter((e) => !m.contributions.find((c) => c.employeeId === e.id && c.round === round));
    for (const e of silent) {
      m.absent.push(e.id);
      this.eng.comms.cancelFor({ kind: 'meeting', id: m.id });
    }
    this.core.put('meeting', m);
    if (silent.length) {
      this.core.event({ type: 'meeting.round_started', source: 'server', summary: `Meeting "${truncate(m.topic, 60)}": ${silent.map((e) => e.name).join(', ')} did not answer the ${round} round`, projectId: m.projectId, correlationId: m.id, data: { meetingId: m.id, absent: silent.map((e) => e.id) } });
    }
    if (!m.contributions.length) return this.finish(m, null, []);
    if (m.status === 'proposals' && this.present(m).length >= 2) this.startRound(m, 'responses');
    else this.startRound(m, 'synthesis');
  }

  conclude(employee: Employee, meetingId: string, decisionDoc: string, tasks: ProposedTask[] = []): string {
    const m = this.core.meetings.get(meetingId) ?? this.core.meetings.find((x) => x.id.startsWith(meetingId));
    if (!m) throw new EngineError(`no meeting "${meetingId}"`);
    if (m.facilitatorId !== employee.id) throw new EngineError('only the facilitator can conclude the meeting');
    if (m.status !== 'synthesis') throw new EngineError(`the meeting is not ready to be concluded yet (status ${m.status})`);
    if (!decisionDoc.trim()) throw new EngineError('decision_doc is empty');
    m.contributions.push({ id: newId(), employeeId: employee.id, round: 'synthesis', body: decisionDoc.trim(), disagreements: [], ts: nowIso() });
    this.finish(m, decisionDoc.trim(), tasks, employee);
    return `Meeting concluded. Decision document stored${m.generatedTaskIds.length ? ` and ${m.generatedTaskIds.length} follow-up tasks created` : ''}.`;
  }

  private finish(m: Meeting, decisionDoc: string | null, tasks: ProposedTask[], facilitator?: Employee): void {
    const timer = this.timers.get(m.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(m.id);
    this.eng.comms.cancelFor({ kind: 'meeting', id: m.id });
    const names = (ids: string[]) => ids.map((id) => this.core.employees.get(id)?.name ?? 'unknown').join(', ');
    const disagreements = m.contributions.flatMap((c) => c.disagreements.map((d) => `- **${this.core.employees.get(c.employeeId)?.name ?? 'unknown'}**: ${d}`));
    const header = [`# ${m.topic}`, '', `- Date: ${nowIso()}`, `- Participants: ${names(m.participantIds.filter((id) => !m.absent.includes(id))) || 'none'}`, m.absent.length ? `- Did not take part: ${names(m.absent)}` : '', `- Facilitator: ${this.core.employees.get(m.facilitatorId)?.name ?? 'unknown'}`, ''].filter((l) => l !== '');
    let doc: string;
    if (decisionDoc) {
      doc = [...header, '', decisionDoc, disagreements.length ? `\n## Recorded disagreements\n${disagreements.join('\n')}` : ''].join('\n');
    } else {
      // No synthesis was produced. Say so, and keep the raw contributions as the record.
      const raw = m.contributions.map((c) => `### ${this.core.employees.get(c.employeeId)?.name ?? 'unknown'} — ${c.round}\n${c.body}`).join('\n\n');
      doc = [...header, '', '> No decision was synthesised: the facilitator did not conclude the meeting in time. The contributions below are the complete, unedited record.', '', raw || '_No contributions were received._', disagreements.length ? `\n## Recorded disagreements\n${disagreements.join('\n')}` : ''].join('\n');
    }
    m.decisionDoc = doc;
    m.status = decisionDoc ? 'concluded' : m.contributions.length ? 'concluded' : 'cancelled';
    m.concludedAt = nowIso();
    if (tasks.length && m.projectId && facilitator) {
      try {
        m.generatedTaskIds = this.eng.tasks.proposeTasks(facilitator, m.projectId, tasks, undefined, `meeting ${m.id}`).map((t) => t.id);
      } catch (e) {
        this.core.log('warn', `meeting ${m.id}: follow-up tasks rejected: ${(e as Error).message}`);
      }
    }
    this.core.put('meeting', m);
    this.eng.addArtifact({ kind: 'decision_doc', title: `Decision: ${m.topic}`, content: doc, projectId: m.projectId, meetingId: m.id, employeeId: facilitator?.id ?? null });
    this.core.event({
      type: 'meeting.concluded',
      source: decisionDoc ? 'mcp' : 'server',
      summary: decisionDoc ? `Meeting concluded: ${truncate(m.topic, 80)} (${m.generatedTaskIds.length} tasks)` : `Meeting ended without a synthesised decision: ${truncate(m.topic, 80)}`,
      projectId: m.projectId,
      employeeId: facilitator?.id ?? null,
      correlationId: m.id,
      data: { meetingId: m.id, synthesised: !!decisionDoc, tasks: m.generatedTaskIds.length, absent: m.absent },
    });
    this.eng.comms.notify({
      kind: 'info',
      severity: decisionDoc ? 'success' : 'warning',
      title: decisionDoc ? `Meeting concluded: ${truncate(m.topic, 60)}` : `Meeting ended without a decision: ${truncate(m.topic, 60)}`,
      body: decisionDoc ? `Decision document ready${m.generatedTaskIds.length ? `; ${m.generatedTaskIds.length} follow-up tasks created` : ''}.` : 'The raw contributions were kept as the record.',
      projectId: m.projectId,
    });
    this.eng.tasks.schedule();
  }

  cancel(meetingId: string, actor = 'owner'): Meeting {
    const m = this.core.meetings.require(meetingId);
    if (!this.active(m)) throw new EngineError('that meeting is already over');
    const timer = this.timers.get(m.id);
    if (timer) clearTimeout(timer);
    this.timers.delete(m.id);
    this.eng.comms.cancelFor({ kind: 'meeting', id: m.id });
    m.status = 'cancelled';
    m.concludedAt = nowIso();
    this.core.put('meeting', m);
    this.core.audit(actor, 'meeting.cancelled', m.id, {});
    this.core.event({ type: 'meeting.concluded', source: 'owner', summary: `Meeting cancelled: ${truncate(m.topic, 80)}`, projectId: m.projectId, correlationId: m.id, data: { meetingId: m.id, cancelled: true } });
    this.eng.tasks.schedule();
    return m;
  }
}
