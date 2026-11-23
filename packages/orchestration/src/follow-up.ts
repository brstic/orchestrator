import { truncate, type OrchestratorEvent, type Task } from '@orchestrator/contracts';
import type { Engine } from './engine.ts';

/**
 * The employee who put work on the board hears how it went — done, or blocked — so that it can take the next step
 * itself (the owner, 2026-11-23: "I tell the project manager what I need, and it breaks it down, uses the other agents
 * and builds the whole thing by itself"). Before, only the boss was told; a manager that had handed out the parts of
 * a job learned of them only by asking.
 *
 * Not told: of a task it does itself, of reviews, and of the parts of a divided ticket (those come back to whoever
 * leads it, `task-talk.ts`).
 */
export class FollowUp {
  private readonly eng: Engine;
  constructor(eng: Engine) {
    this.eng = eng;
    eng.core.bus.on('event', (e: OrchestratorEvent) => this.onEvent(e));
  }

  /** The employee who made this task, when it is one other than whoever has it. */
  makerOf(task: Task) {
    if (!/^employee:/.test(task.createdBy ?? '') || task.reviewOf || task.parentId) return null;
    const name = task.createdBy!.slice('employee:'.length);
    const maker = this.eng.core.employees.find((e) => e.name === name && !e.archived);
    return maker && maker.id !== task.assigneeId ? maker : null;
  }

  private onEvent(e: OrchestratorEvent): void {
    if ((e.type !== 'task.completed' && e.type !== 'task.blocked') || !e.taskId) return;
    const task = this.eng.core.tasks.get(e.taskId);
    if (!task) return;
    const maker = this.makerOf(task);
    if (!maker) return;
    const who = this.eng.core.employees.get(task.assigneeId)?.name ?? 'its assignee';
    const open = this.eng.core.tasks.filter((t) => t.id !== task.id && this.makerOf(t)?.id === maker.id && t.status !== 'DONE' && !t.cancelled);
    const left = open.length ? ` Of the work you put on the board, ${open.length} ${open.length === 1 ? 'task is' : 'tasks are'} still open: ${open.slice(0, 6).map((t) => `${t.key} (${t.status.toLowerCase().replace('_', ' ')})`).join(', ')}${open.length > 6 ? ', …' : ''}.` : ' Everything you put on the board is done.';
    const body =
      e.type === 'task.completed'
        ? `${task.key} "${truncate(task.title, 100)}", which you put on the board, is done (${who}): ${truncate(task.evidence.summary ?? 'finished', 400)}${left} Take the next step of the job: what now can start, what is still missing against what the boss asked for — and when all of it is there, report it to the boss with message_person (what was delivered, how it was checked).`
        : `${task.key} "${truncate(task.title, 100)}", which you put on the board, is blocked (${who}): ${truncate(String(e.data?.reason ?? task.blockedReason ?? ''), 400)} If you know how it goes on, unblock_task and say how; if it needs the boss, ask_boss.`;
    this.eng.comms.sendMessage({ from: { kind: 'system', id: null, name: 'the office' }, toEmployeeId: maker.id, kind: 'system', taskId: task.id, body });
  }
}
