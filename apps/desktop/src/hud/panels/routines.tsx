import { useEffect, useState } from 'react';
import type { Routine } from '@orchestrator/contracts';
import { ROUTINE_LIMITS } from '@orchestrator/contracts';
import { Button, clock } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { act, ask } from '../core.tsx';
import { onActivate } from './company-shared.tsx';

/** A routine taken away, once it was asked. */
async function removeRoutine(r: Routine): Promise<void> {
  const short = r.instruction.length > 80 ? `${r.instruction.slice(0, 80)}…` : r.instruction;
  if (!(await ask({ title: 'Remove this routine?', body: `“${short}” stops repeating, and is gone (what it did so far stays in the conversation).`, ok: 'Remove' }))) return;
  await act(() => api('DELETE', `/routines/${r.id}`), 'Routine removed');
}

/** How often, as a person says it. */
export function rhythm(minutes: number): string {
  if (minutes === 1440) return 'every day';
  if (minutes % 60 === 0) return minutes === 60 ? 'every hour' : `every ${minutes / 60} h`;
  return `every ${minutes} min`;
}

/** The rhythms most routines want, one click each; anything else in minutes beside them. */
const PRESETS = [15, 30, 60, 180, 1440];

function Every({ value, onChange, disabled, name }: { value: number; onChange: (n: number) => void; disabled?: boolean; name?: string }) {
  const [typed, setTyped] = useState(String(value));
  useEffect(() => setTyped(String(value)), [value]);
  const take = () => {
    const n = Math.round(Number(typed));
    if (Number.isFinite(n) && n >= ROUTINE_LIMITS.minMinutes && n <= ROUTINE_LIMITS.maxMinutes && n !== value) onChange(n);
    else setTyped(String(value));
  };
  return (
    <div className="routine-rhythm" data-routine-every={name}>
      <div className="k-filters" role="group" aria-label="How often">
        {PRESETS.map((n) => (
          <button key={n} type="button" disabled={disabled} aria-pressed={value === n} className={value === n ? 'k-filter-on' : ''} onClick={() => onChange(n)}>
            {rhythm(n).replace('every ', '')}
          </button>
        ))}
      </div>
      <label className="routine-every small" title={`${ROUTINE_LIMITS.minMinutes}–${ROUTINE_LIMITS.maxMinutes} minutes`}>
        or every
        <input type="number" min={ROUTINE_LIMITS.minMinutes} max={ROUTINE_LIMITS.maxMinutes} step={1} value={typed} disabled={disabled} aria-label="Minutes between runs" onChange={(ev) => setTyped(ev.target.value)} onBlur={take} onKeyDown={(ev) => ev.key === 'Enter' && (ev.preventDefault(), (ev.target as HTMLInputElement).blur())} />
        min
      </label>
    </div>
  );
}

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
  // (When the last look handed it over, the line already begins with that time; "Not run yet" is said already too.)
  const last = (r.lastOutcome === 'delivered' && !r.lastNote) || !r.lastRunAt ? '' : `last run ${clock(r.lastRunAt)}`;
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
          <Button small variant="ghost" onClick={() => void removeRoutine(r)} title="Remove this routine">
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
  const [every, setEvery] = useState(60);
  const [now, setNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const valid = !!text.trim();
  const add = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const made = await act(() => api<Routine>('POST', '/routines', { employeeId, instruction: text.trim(), everyMinutes: every, runNow: now }), `Routine added — ${rhythm(every)}`);
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
      <div className="field">
        <span className="field-label">How often</span>
        <Every value={every} onChange={setEvery} name="new" />
      </div>
      <div className="routine-sheet-foot">
        <label className="check small">
          <input type="checkbox" checked={now} onChange={(ev) => setNow(ev.target.checked)} style={{ margin: 0 }} />
          and once right now
        </label>
        <Button variant="primary" type="submit" disabled={!valid || busy}>
          {busy ? 'Adding…' : 'Add the routine'}
        </Button>
      </div>
      <RepeatHint name={name} />
    </form>
  );
}

/** How a routine is, as a dot: lit while it repeats, a ring when paused, orange or red when its last look did not hand it over. */
function dotOf(r: Routine): string {
  if (!r.enabled) return 'k-dot-off';
  const tone = outcome(r).tone;
  return tone === 'bad' ? 'k-dot-bad' : tone === 'warn' ? 'k-dot-busy' : '';
}

/** One routine: a line — its words, how often, when next — and on a click all of it, to change, run, pause or remove. */
function OwnRow({ r, canWork, open, onToggle }: { r: Routine; canWork: boolean; open: boolean; onToggle: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(r.instruction);
  useEffect(() => {
    if (!editing) setText(r.instruction);
  }, [r.instruction, editing]);
  const o = outcome(r);
  const next = r.enabled && r.nextRunAt ? (Date.parse(r.nextRunAt) < Date.now() - 60_000 ? 'next as soon as it can' : `next ${clock(r.nextRunAt)}`) : null;
  const line = [r.enabled ? rhythm(r.everyMinutes) : `Paused · was ${rhythm(r.everyMinutes)}`, next, r.runs > 0 ? `${r.runs} run${r.runs === 1 ? '' : 's'}` : 'not run yet'].filter(Boolean).join(' · ');
  const changed = !!text.trim() && text.trim() !== r.instruction;
  return (
    <div className={`routine-own${r.enabled ? '' : ' routine-off'}`} data-routine={r.id}>
      <div className="k-row k-row-click" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle} onKeyDown={(ev) => ev.target === ev.currentTarget && onActivate(onToggle)(ev)}>
        <span className={`k-dot ${dotOf(r)}`} aria-hidden />
        <div className="k-main">
          <div className="k-title-sm routine-words">{r.instruction}</div>
          <div className="k-sub">{line}</div>
        </div>
        {(o.tone === 'warn' || o.tone === 'bad') && <span className={`k-aside routine-${o.tone}`}>{o.tone === 'bad' ? 'Failed' : 'Held'}</span>}
        <span className="k-chev" aria-hidden />
      </div>
      {open && (
        <div className="k-detail">
          <div className="k-section">
            {editing ? (
              <div className="routine-edit" data-edit-routine={r.id}>
                <textarea value={text} onChange={(ev) => setText(ev.target.value)} maxLength={ROUTINE_LIMITS.instruction} aria-label="What to do each time" autoFocus style={{ minHeight: 84 }} />
                <div className="k-actions">
                  <Button small variant="primary" disabled={!changed} onClick={() => void act(() => api('PATCH', `/routines/${r.id}`, { instruction: text.trim() }), 'Routine changed').then((ok) => ok && setEditing(false))}>
                    Save
                  </Button>
                  <Button small variant="ghost" onClick={() => (setText(r.instruction), setEditing(false))}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              // (The words themselves stand in full on the line above, once it is open.)
              canWork && (
                <button type="button" className="k-link routine-change" onClick={() => setEditing(true)}>
                  Change the words
                </button>
              )
            )}
          </div>
          <div className="k-section">
            <span className="k-label">How often</span>
            <Every value={r.everyMinutes} disabled={!canWork} name={r.id} onChange={(n) => void act(() => api('PATCH', `/routines/${r.id}`, { everyMinutes: n }), `Now ${rhythm(n)}`)} />
          </div>
          <div className="k-section">
            <span className="k-label">Last run</span>
            <div className={`small routine-${o.tone}`}>
              {o.text}
              {r.lastRunAt && r.lastOutcome !== 'delivered' ? ` · last handed over ${clock(r.lastRunAt)}` : ''}
            </div>
          </div>
          {canWork && (
            <div className="k-actions">
              <Button small disabled={!r.enabled} onClick={() => void act(() => api<Routine>('POST', `/routines/${r.id}/run`, {})).then((res) => res && useOffice.getState().toast(res.lastOutcome === 'delivered' ? 'Handed over now' : `Not run: ${res.lastNote ?? 'they are busy'}`, res.lastOutcome === 'delivered' ? 'success' : 'info'))} title="Run it once now, whatever its rhythm says">
                Run now
              </Button>
              <Button small onClick={() => void act(() => api('PATCH', `/routines/${r.id}`, { enabled: !r.enabled }), r.enabled ? 'Routine paused' : 'Routine runs again')}>
                {r.enabled ? 'Pause' : 'Resume'}
              </Button>
              <span className="grow" />
              <Button small variant="ghost" className="k-quiet" onClick={() => void removeRoutine(r)}>
                Remove
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Everything one employee repeats by themselves, in their own window (the "Routines" tab): one line per routine — its
 * words, how often, when next — and on a click its words to change, its rhythm, what the last run came to, and running
 * it now, pausing and removing it. The same routines the Talk window lists above a conversation; here they are the subject.
 */
export function RoutinesOf({ employeeId, name, canWork = true }: { employeeId: string; name: string; canWork?: boolean }) {
  const routines = useOffice((s) => s.routines);
  const mine = Object.values(routines)
    .filter((r) => r.employeeId === employeeId)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const full = mine.length >= ROUTINE_LIMITS.perEmployee;
  const on = mine.filter((r) => r.enabled).length;
  return (
    <div className="k-stack" data-profile-routines>
      <div className="routine-top">
        <div className="k-text">
          Instructions the office hands {name} again and again — every so many minutes, whenever they are between turns. A run that finds them busy waits for the next.
        </div>
        {canWork && !adding && (
          <Button variant="primary" disabled={full} title={full ? `${name} already has ${ROUTINE_LIMITS.perEmployee} routines; remove one first` : undefined} onClick={() => setAdding(true)} data-add-routine-open>
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
        <div className="k-section">
          <span className="k-label">
            {mine.length} routine{mine.length === 1 ? '' : 's'}
            {on < mine.length ? ` · ${mine.length - on} paused` : ''}
          </span>
          <div className="k-group">
            {mine.map((r) => (
              <OwnRow key={r.id} r={r} canWork={canWork} open={open === r.id} onToggle={() => setOpen((o) => (o === r.id ? null : r.id))} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
