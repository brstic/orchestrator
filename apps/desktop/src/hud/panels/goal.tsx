import { useState } from 'react';
import type { Employee, EmployeeGoal } from '@orchestrator/contracts';
import { Button, timeAgo } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { goalStillShown, goalWords } from '../../lib/goal.ts';
import { act } from '../core.tsx';

/**
 * An employee's goal (the office's `/goal`): what they keep working toward until it holds. A line in the window one
 * talks to them in, and a row of their profile with the form to give one. See `Goals` in the orchestration package.
 */

export const setGoal = (employeeId: string, condition: string, check: string | null) => api<EmployeeGoal>('PUT', `/employees/${employeeId}/goal`, { condition, check });
export const clearGoal = (employeeId: string) => api('DELETE', `/employees/${employeeId}/goal`);

/** The line above the conversation: the goal while it stands, and for a while after it ended, how it ended. */
export function GoalStrip({ employee, canWork = true }: { employee: Employee; canWork?: boolean }) {
  const g = employee.goal;
  if (!g || !goalStillShown(g)) return null;
  const active = g.status === 'active';
  return (
    <div className={`goal-strip goal-${g.status}`} data-goal={g.status}>
      <span className="goal-mark" aria-hidden>
        {active ? '🎯' : g.status === 'met' ? '✓' : '■'}
      </span>
      <span className="goal-main">
        <span className="goal-word">{active ? 'Goal' : g.status === 'met' ? 'Goal met' : 'Goal stopped'}</span>
        <span className="goal-text" title={g.condition}>
          {g.condition}
        </span>
        <span className="goal-sub">
          {active
            ? `${goalWords(g)} · from ${g.setBy.kind === 'employee' ? 'themselves' : g.setBy.name} · ${timeAgo(g.setAt)}${g.check ? ` · checked by ${g.check}` : ''}`
            : `${g.outcome ?? ''}${g.endedAt ? ` · ${timeAgo(g.endedAt)}` : ''}`}
        </span>
      </span>
      {active && canWork && (
        <Button small onClick={() => void act(() => clearGoal(employee.id), `${employee.name}'s goal is cleared`)} title="They are no longer sent on toward it">
          Clear
        </Button>
      )}
    </div>
  );
}

/** In the profile: the goal, and a form to give one (with a command to check it by, if wanted). */
export function GoalRow({ employee, canWork }: { employee: Employee; canWork: boolean }) {
  const [open, setOpen] = useState(false);
  const [condition, setCondition] = useState('');
  const [check, setCheck] = useState('');
  const [busy, setBusy] = useState(false);
  const g = employee.goal;
  const active = g?.status === 'active';
  const give = async () => {
    if (!condition.trim() || busy) return;
    setBusy(true);
    const ok = await act(() => setGoal(employee.id, condition.trim(), check.trim() || null), `${employee.name} has the goal; they are told now`);
    setBusy(false);
    if (ok) {
      setOpen(false);
      setCondition('');
      setCheck('');
    }
  };
  return (
    <div className="k-row k-row-sm goal-row" data-profile-goal>
      <span className={`k-dot ${active ? 'k-dot-busy' : 'k-dot-off'}`} aria-hidden />
      <span className="k-main">
        {open ? (
          <span className="goal-form">
            <textarea rows={2} value={condition} autoFocus placeholder="What has to be true when they are done — e.g. every test in packages/api passes and the branch is pushed" onChange={(ev) => setCondition(ev.target.value)} />
            <input className="mono" value={check} placeholder="A command that passes once it holds (optional) — e.g. pnpm test" onChange={(ev) => setCheck(ev.target.value)} />
            <span className="k-sub">They keep working toward it, turn after turn, until it holds (and say so); a command here decides that. It stops by itself after three turns that do nothing.</span>
            <span className="row" style={{ gap: 6 }}>
              <Button small variant="primary" disabled={!condition.trim() || busy} onClick={() => void give()}>
                {active ? 'Replace the goal' : 'Give the goal'}
              </Button>
              <Button small onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </span>
          </span>
        ) : (
          <>
            <span className="k-title k-title-sm">{g && goalStillShown(g) ? (active ? `Goal: ${g.condition}` : `${g.status === 'met' ? 'Goal met' : 'Goal stopped'}: ${g.condition}`) : 'No goal'}</span>
            <span className="k-sub">{g && goalStillShown(g) ? (active ? `${goalWords(g)} · from ${g.setBy.kind === 'employee' ? 'themselves' : g.setBy.name}${g.check ? ` · checked by ${g.check}` : ''}` : (g.outcome ?? '')) : 'Something they keep working toward until it holds — like /goal in Claude Code. Also: type /goal … in Talk.'}</span>
          </>
        )}
      </span>
      {!open && canWork && (
        <span className="row" style={{ gap: 6 }}>
          {active && (
            <Button small onClick={() => void act(() => clearGoal(employee.id), `${employee.name}'s goal is cleared`)}>
              Clear
            </Button>
          )}
          <Button small onClick={() => (setCondition(active ? g!.condition : ''), setCheck(active ? (g!.check ?? '') : ''), setOpen(true))}>
            {active ? 'Change…' : 'Give a goal…'}
          </Button>
        </span>
      )}
    </div>
  );
}

/** For whoever types /goal on its own: what it is now. */
export function goalNow(e: Employee): string {
  const g = e.goal;
  if (!g || g.status !== 'active') return `${e.name} has no goal. Type /goal followed by what has to be true.`;
  return `${e.name}'s goal: ${g.condition} (${goalWords(g)}).`;
}
