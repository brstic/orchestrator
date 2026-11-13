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

/** A new routine for an employee: what to do each time, how often, and whether the first run is now. */
function AddRoutine({ employeeId, name, onClose }: { employeeId: string; name: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const [minutes, setMinutes] = useState(String(ROUTINE_LIMITS.defaultMinutes * 6));
  const [now, setNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const every = Math.round(Number(minutes));
  const valid = !!text.trim() && Number.isFinite(every) && every >= ROUTINE_LIMITS.minMinutes && every <= ROUTINE_LIMITS.maxMinutes;
  const add = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const made = await act(() => api<Routine>('POST', '/routines', { employeeId, instruction: text.trim(), everyMinutes: every, runNow: now }), 'Routine added');
    setBusy(false);
    if (made) onClose();
  };
  return (
    <form
      className="k-sheet"
      data-add-routine
      onSubmit={(ev) => {
        ev.preventDefault();
        void add();
      }}
    >
      <div className="k-sheet-head">
        <div className="k-title">Something for {name} to repeat</div>
        <Button small variant="ghost" type="button" onClick={onClose}>
          Cancel
        </Button>
      </div>
      <label className="field">
        <span className="field-label">What to do each time</span>
        <textarea value={text} onChange={(ev) => setText(ev.target.value)} maxLength={ROUTINE_LIMITS.instruction} placeholder="e.g. Check the error log of the shop; if something new is there, say what it is and what you would do about it." autoFocus style={{ minHeight: 84 }} aria-label="What to do each time" />
      </label>
      <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
        <label className="routine-every small">
          every
          <input type="number" min={ROUTINE_LIMITS.minMinutes} max={ROUTINE_LIMITS.maxMinutes} step={1} value={minutes} onChange={(ev) => setMinutes(ev.target.value)} aria-label="Minutes between runs" />
          minutes
        </label>
        <label className="check small" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={now} onChange={(ev) => setNow(ev.target.checked)} style={{ margin: 0 }} />
          and once right now
        </label>
        <span className="grow" />
        <Button small variant="primary" type="submit" disabled={!valid || busy}>
          {busy ? 'Adding…' : 'Add the routine'}
        </Button>
      </div>
      <RepeatHint name={name} />
    </form>
  );
}

/** One routine with its text open for changing: saved with the button, left as it was with Cancel. */
function EditRoutine({ r, onClose }: { r: Routine; onClose: () => void }) {
  const [text, setText] = useState(r.instruction);
  const changed = text.trim() !== r.instruction && !!text.trim();
  return (
    <div className="routine-edit" data-edit-routine={r.id}>
      <textarea value={text} onChange={(ev) => setText(ev.target.value)} maxLength={ROUTINE_LIMITS.instruction} aria-label="What to do each time" autoFocus style={{ minHeight: 72 }} />
      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
        <Button small variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button small disabled={!changed} onClick={() => void act(() => api('PATCH', `/routines/${r.id}`, { instruction: text.trim() }), 'Routine changed').then((ok) => ok && onClose())}>
          Save
        </Button>
      </div>
    </div>
  );
}

/**
 * Everything one employee repeats by themselves, in their own window (the "Routines" tab): what each is, how often,
 * what the last run came to — and adding one, changing its words or its rhythm, running it now, pausing and
 * removing it. The same routines the Talk window lists above a conversation; here they are the subject.
 */
export function RoutinesOf({ employeeId, name, canWork = true }: { employeeId: string; name: string; canWork?: boolean }) {
  const routines = useOffice((s) => s.routines);
  const mine = Object.values(routines)
    .filter((r) => r.employeeId === employeeId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const full = mine.length >= ROUTINE_LIMITS.perEmployee;
  const on = mine.filter((r) => r.enabled).length;
  return (
    <div className="k-stack" data-profile-routines>
      <div className="k-head">
        <div className="k-text" style={{ flex: 1 }}>
          A routine is an instruction the office hands {name} again and again — every so many minutes, each time they are between turns. A run that finds them busy is skipped.
        </div>
        {canWork && !adding && (
          <Button small disabled={full} title={full ? `${name} already has ${ROUTINE_LIMITS.perEmployee} routines; remove one first` : undefined} onClick={() => setAdding(true)} data-add-routine-open>
            Add a routine
          </Button>
        )}
      </div>
      {adding && <AddRoutine employeeId={employeeId} name={name} onClose={() => setAdding(false)} />}
      {mine.length === 0 ? (
        !adding && (
          <div className="k-empty">
            <div className="k-title">Nothing repeats yet</div>
            <div className="k-text">For what should be looked at regularly without your asking each time: a log, a queue, a page, the state of a build.</div>
          </div>
        )
      ) : (
        <div>
          <div className="k-label">
            {mine.length} routine{mine.length === 1 ? '' : 's'}
            {on < mine.length ? ` · ${mine.length - on} paused` : ''}
          </div>
          <div className="routine-list routine-list-own" aria-label="Routines">
            {mine.map((r) =>
              editing === r.id ? (
                <EditRoutine key={r.id} r={r} onClose={() => setEditing(null)} />
              ) : (
                <div key={r.id} className="routine-own" data-routine={r.id}>
                  <Row r={r} canWork={canWork} />
                  {canWork && (
                    <button type="button" className="k-quiet routine-change" onClick={() => setEditing(r.id)}>
                      Change the words
                    </button>
                  )}
                </div>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
