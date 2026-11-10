import { useEffect, useState } from 'react';
import type { Routine } from '@orchestrator/contracts';
import { ROUTINE_LIMITS } from '@orchestrator/contracts';
import { Button, clock } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';

/** What the last look at a routine came to, in plain words. */
function outcome(r: Routine): { text: string; tone: 'good' | 'warn' | 'bad' | 'muted' } {
  if (!r.enabled) return { text: 'Paused', tone: 'muted' };
  switch (r.lastOutcome) {
    case 'delivered':
      return { text: r.lastNote ?? `Last run ${r.lastRunAt ? clock(r.lastRunAt) : '—'}`, tone: 'good' };
    case 'skipped_busy':
      return { text: `Skipped at ${r.lastOutcomeAt ? clock(r.lastOutcomeAt) : '—'}: ${r.lastNote ?? 'they were busy'}`, tone: 'warn' };
    case 'skipped_offline':
      return { text: `Waiting: ${r.lastNote ?? 'their machine is away'}`, tone: 'warn' };
    case 'not_run':
      return { text: `On hold: ${r.lastNote ?? 'not run'}`, tone: 'warn' };
    case 'failed':
      return { text: `Failed: ${r.lastNote ?? 'could not be handed over'}`, tone: 'bad' };
    default:
      return { text: 'Not run yet', tone: 'muted' };
  }
}

function when(r: Routine): string {
  if (!r.enabled) return '';
  // (When the last look handed it over, the line already begins with that time.)
  const last = r.lastOutcome === 'delivered' && !r.lastNote ? '' : r.lastRunAt ? `last run ${clock(r.lastRunAt)}` : 'not run yet';
  if (!r.nextRunAt) return last;
  // Past due while it is held (their machine is away, they are paused): it runs as soon as that is over.
  const next = Date.parse(r.nextRunAt) < Date.now() - 60_000 ? 'next as soon as it can' : `next ${clock(r.nextRunAt)}`;
  return last ? `${last} · ${next}` : next;
}

function Row({ r, canWork }: { r: Routine; canWork: boolean }) {
  const [minutes, setMinutes] = useState(String(r.everyMinutes));
  useEffect(() => setMinutes(String(r.everyMinutes)), [r.everyMinutes]);
  const o = outcome(r);
  const saveMinutes = () => {
    const n = Math.round(Number(minutes));
    if (!Number.isFinite(n) || n === r.everyMinutes) return setMinutes(String(r.everyMinutes));
    void act(() => api('PATCH', `/routines/${r.id}`, { everyMinutes: n }), `Now every ${n} min`).then((ok) => {
      if (!ok) setMinutes(String(r.everyMinutes));
    });
  };
  return (
    <div className={`routine-row${r.enabled ? '' : ' routine-off'}`}>
      <div className="routine-main">
        <div className="routine-text" title={r.instruction}>
          {r.instruction}
        </div>
        <div className="small faint">
          <span className={`routine-${o.tone}`}>{o.text}</span>
          {when(r) && <span> · {when(r)}</span>}
          {r.runs > 0 && <span> · {r.runs} run{r.runs === 1 ? '' : 's'}</span>}
        </div>
      </div>
      <label className="routine-every small" title="How often it is repeated">
        every
        <input type="number" min={ROUTINE_LIMITS.minMinutes} max={ROUTINE_LIMITS.maxMinutes} step={1} value={minutes} disabled={!canWork} aria-label="Minutes between runs" onChange={(ev) => setMinutes(ev.target.value)} onBlur={saveMinutes} onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()} />
        min
      </label>
      {canWork && (
        <>
          <Button small disabled={!r.enabled} onClick={() => void act(() => api<Routine>('POST', `/routines/${r.id}/run`, {})).then((res) => res && useOffice.getState().toast(res.lastOutcome === 'delivered' ? 'Handed over now' : `Not run: ${res.lastNote ?? 'they are busy'}`, res.lastOutcome === 'delivered' ? 'success' : 'info'))} title="Run it once now, whatever its rhythm says">
            Run now
          </Button>
          <Button small onClick={() => void act(() => api('PATCH', `/routines/${r.id}`, { enabled: !r.enabled }), r.enabled ? 'Routine paused' : 'Routine runs again')}>
            {r.enabled ? 'Pause' : 'Resume'}
          </Button>
          <Button small variant="ghost" onClick={() => void act(() => api('DELETE', `/routines/${r.id}`), 'Routine removed')} title="Remove this routine">
            Remove
          </Button>
        </>
      )}
    </div>
  );
}

/** The routines of one employee: what they are told to repeat, how often, and what the last run came to. Nothing when there are none. */
export function RoutineList({ employeeId, canWork = true }: { employeeId: string; canWork?: boolean }) {
  const routines = useOffice((s) => s.routines);
  const mine = Object.values(routines)
    .filter((r) => r.employeeId === employeeId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  // The times shown ("next 12:05", "as soon as it can") are read off the clock: looked at again every half minute.
  const [, tick] = useState(0);
  useEffect(() => {
    if (!mine.length) return;
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, [mine.length]);
  if (!mine.length) return null;
  return (
    <div className="routine-list" aria-label="Routines">
      <div className="routine-head small">Repeats by itself</div>
      {mine.map((r) => (
        <Row key={r.id} r={r} canWork={canWork} />
      ))}
    </div>
  );
}

/**
 * The choice under the message box: say it once, or have the office repeat it. With it ticked, what is typed becomes
 * a routine (its first run is now) instead of a one-off message.
 */
export function RepeatChoice({ on, minutes, name, onChange }: { on: boolean; minutes: number; name: string; onChange: (on: boolean, minutes: number) => void }) {
  return (
    <span className="routine-choice">
      <label className="check small" title={`The office hands this to ${name} again and again, each time they are between turns. A run that finds them busy is skipped.`}>
        <input type="checkbox" checked={on} onChange={(ev) => onChange(ev.target.checked, minutes)} />
        Repeat every
      </label>
      <input
        className="routine-minutes"
        type="number"
        min={ROUTINE_LIMITS.minMinutes}
        max={ROUTINE_LIMITS.maxMinutes}
        step={1}
        value={minutes}
        aria-label="Minutes between runs"
        onFocus={() => !on && onChange(true, minutes)}
        onChange={(ev) => onChange(on, Math.max(ROUTINE_LIMITS.minMinutes, Math.min(ROUTINE_LIMITS.maxMinutes, Math.round(Number(ev.target.value)) || ROUTINE_LIMITS.defaultMinutes)))}
      />
      <span className="small">minutes</span>
    </span>
  );
}

/** What repeating costs and may ask of the owner, said where the choice is made. */
export function RepeatHint({ name }: { name: string }) {
  return (
    <div className="routine-hint small faint">
      Each run is a real Claude turn on {name}'s account. If a run needs a tool they must ask for (fetching a web page, for example), they ask you every time until that tool is allowed in their project's policy (Projects → Policy → Allow rules) or
      in their profile.
    </div>
  );
}

/** Create a routine for an employee from what was typed. Resolves to true when it exists. */
export async function createRoutine(employeeId: string, name: string, instruction: string, everyMinutes: number): Promise<boolean> {
  const r = await act(() => api<Routine>('POST', '/routines', { employeeId, instruction, everyMinutes }));
  if (!r) return false;
  useOffice.getState().toast(r.lastOutcome === 'delivered' ? `${name} does this every ${r.everyMinutes} min from now on; the first run is on its way.` : `${name} does this every ${r.everyMinutes} min from now on. Not run yet: ${r.lastNote ?? 'they are busy'}.`, 'success');
  return true;
}
