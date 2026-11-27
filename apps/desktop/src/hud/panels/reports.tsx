import { useMemo, useState } from 'react';
import type { Artifact } from '@orchestrator/contracts';
import { Avatar, Button, Markdown, Window, timeAgo } from '@orchestrator/ui';
import { useAccess } from '../../lib/access.ts';
import { api } from '../../lib/api.ts';
import { byDay, oneLine } from '../../lib/inbox.ts';
import { useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { byName } from './company-shared.tsx';
import { registerPanel } from './index.tsx';

const KIND_LABEL: Record<Artifact['kind'], string> = { decision_doc: 'decision', report: 'report', plan: 'plan', review: 'review', test_output: 'test output', summary: 'summary' };
const KIND_MANY: Record<Artifact['kind'], string> = { decision_doc: 'Decisions', report: 'Reports', plan: 'Plans', review: 'Reviews', test_output: 'Test output', summary: 'Summaries' };

/** Asking somebody for a report, opened in place: whom, and what happens next. */
function AskForReport({ onClose }: { onClose: () => void }) {
  const employees = useOffice((s) => s.employees);
  const can = useAccess();
  const [who, setWho] = useState('');
  const [busy, setBusy] = useState(false);
  const askable = Object.values(employees)
    .filter((e) => !e.archived && can.work(e.hostId))
    .sort(byName);
  const ask = async () => {
    const e = employees[who];
    if (!e) return;
    setBusy(true);
    const ok = await act(() => api('POST', `/employees/${e.id}/report`, {}), `${e.name} was asked for a report. It appears here when they hand it in.`);
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <form
      className="k-sheet"
      data-ask-report
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!busy) void ask();
      }}
    >
      <div className="k-text">They write what they did, what they found and what is left, and hand it in through the office. It is listed here, and stays.</div>
      <div className="k-actions">
        <select value={who} onChange={(ev) => setWho(ev.target.value)} aria-label="Who writes the report" style={{ width: 'auto', minWidth: 240 }} autoFocus>
          <option value="">Choose somebody…</option>
          {askable.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} — {e.title}
            </option>
          ))}
        </select>
        <Button small type="submit" disabled={!who || busy}>
          {busy ? 'Asking…' : 'Ask for a report'}
        </Button>
        <Button small variant="ghost" type="button" className="k-quiet" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Reports (docs/UI.md is the look): what employees wrote for the people of the office — reports asked for, plans,
 * reviews, summaries, and what a meeting decided. Each was handed in by a real session through the office's tools
 * (or written by a meeting's facilitator) and is shown as written. On the left, what there is, newest first; on
 * the right, one of them to read.
 */
function ReportsPanel({ arg, onClose }: { arg: string | null; onClose: () => void }) {
  const artifacts = useOffice((s) => s.artifacts);
  const employees = useOffice((s) => s.employees);
  const projects = useOffice((s) => s.projects);
  const tasks = useOffice((s) => s.tasks);
  const openPanel = useOffice((s) => s.openPanel);
  const visitor = useOffice((s) => s.me?.role === 'visitor');
  // `arg` is an artifact id, or "task:<id>" / "employee:<id>" to show only theirs.
  const scope = arg?.startsWith('task:') ? { taskId: arg.slice(5) } : arg?.startsWith('employee:') ? { employeeId: arg.slice(9) } : null;
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string | null>(arg && !scope ? arg : null);
  const [asking, setAsking] = useState(false);

  const all = useMemo(() => Object.values(artifacts).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [artifacts]);
  const inScope = all.filter((a) => !scope || (scope.taskId ? a.taskId === scope.taskId : a.employeeId === scope.employeeId));
  const needle = search.trim().toLowerCase();
  const shown = inScope.filter((a) => (!kind || a.kind === kind) && (!needle || `${a.title} ${a.content} ${employees[a.employeeId ?? '']?.name ?? ''}`.toLowerCase().includes(needle)));
  const current = shown.find((a) => a.id === picked) ?? shown[0] ?? null;
  const scopeLabel = scope?.taskId ? `for ${tasks[scope.taskId]?.key ?? 'this task'}` : scope?.employeeId ? `from ${employees[scope.employeeId]?.name ?? 'this employee'}` : null;
  const kinds = (Object.keys(KIND_LABEL) as Array<Artifact['kind']>).map((k) => ({ k, n: inScope.filter((a) => a.kind === k).length })).filter((x) => x.n > 0);
  const author = (a: Artifact) => (a.employeeId ? employees[a.employeeId] : undefined);

  return (
    <Window
      kit
      title="Reports"
      subtitle={`What employees wrote for you${scopeLabel ? ` · only ${scopeLabel}` : ''}`}
      onClose={onClose}
      width={1160}
      flush
      actions={
        visitor || asking ? undefined : (
          <Button variant="primary" onClick={() => setAsking(true)}>
            Ask for a report
          </Button>
        )
      }
    >
      <div className="k-split" data-reports>
        <aside className="k-split-side">
          {all.length > 0 && (
            <div className="k-split-tools">
              <input className="k-find" type="search" aria-label="Search reports" placeholder="Find by a word in it, or by who wrote it…" value={search} onChange={(e) => setSearch(e.target.value)} />
              {kinds.length > 1 && (
                <div className="k-filters" role="tablist" aria-label="Kind">
                  <button type="button" role="tab" aria-selected={!kind} className={kind ? '' : 'k-filter-on'} onClick={() => setKind('')}>
                    All <span>{inScope.length}</span>
                  </button>
                  {kinds.map(({ k, n }) => (
                    <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'k-filter-on' : ''} onClick={() => setKind(k)}>
                      {KIND_MANY[k]} <span>{n}</span>
                    </button>
                  ))}
                </div>
              )}
              {scope && (
                <button type="button" className="k-link" style={{ alignSelf: 'flex-start' }} onClick={() => openPanel('reports')}>
                  Show everything
                </button>
              )}
            </div>
          )}
          <div className="k-split-list">
            {shown.length === 0 && all.length > 0 && <div className="k-sub" style={{ padding: 12 }}>Nothing matches.</div>}
            {byDay(shown).map((g) => (
              <div key={g.day} className="k-section" style={{ gap: 2 }}>
                <div className="k-label" style={{ padding: '8px 12px 4px' }}>
                  {g.day}
                </div>
                {g.rows.map((a) => {
                  const e = author(a);
                  return (
                    <button key={a.id} type="button" className={`pj-item report-row ${current?.id === a.id ? 'pj-item-on report-row-on' : ''}`} onClick={() => setPicked(a.id)} data-report={a.id}>
                      {e ? <Avatar appearance={e.appearance} size={24} /> : <span className="k-nobody" style={{ width: 24, height: 24 }} aria-hidden />}
                      <span className="k-main">
                        <span className="k-title k-title-sm" style={{ fontWeight: 600 }}>
                          {a.title}
                        </span>
                        <span className="k-sub">
                          {KIND_LABEL[a.kind]} · {e?.name ?? (a.meetingId ? 'a meeting' : 'the office')} · {timeAgo(a.createdAt)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </aside>
        <div className="k-split-main">
          {asking && (
            <div style={{ padding: '20px 24px 0' }}>
              <AskForReport onClose={() => setAsking(false)} />
            </div>
          )}
          {current ? (
            <>
              <div className="doc-head rp-head">
                {author(current) ? <Avatar appearance={author(current)!.appearance} size={36} /> : null}
                <div className="k-main">
                  <div className="k-title strong" style={{ fontSize: 16 }}>
                    {current.title}
                  </div>
                  <div className="k-sub">
                    {KIND_LABEL[current.kind]} by {author(current)?.name ?? (current.meetingId ? 'a meeting' : 'the office')} · {new Date(current.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    {current.projectId && projects[current.projectId] ? ` · ${projects[current.projectId]!.name}` : ''}
                  </div>
                </div>
                {current.taskId && tasks[current.taskId] && (
                  <Button small variant="ghost" className="k-quiet" onClick={() => openPanel('task', current.taskId)} title={`The task it belongs to: ${oneLine(tasks[current.taskId]!.title, 80)}`}>
                    {tasks[current.taskId]!.key}
                  </Button>
                )}
                {current.meetingId && (
                  <Button small variant="ghost" className="k-quiet" onClick={() => openPanel('meetings', current.meetingId)}>
                    The meeting
                  </Button>
                )}
                {current.employeeId && employees[current.employeeId] && !visitor && (
                  <Button small variant="ghost" className="k-quiet" onClick={() => openPanel('talk', current.employeeId)} title="Say something about it to whoever wrote it">
                    Talk to {employees[current.employeeId]!.name}
                  </Button>
                )}
              </div>
              <div className="doc-body rp-body">
                <Markdown text={current.content} />
              </div>
            </>
          ) : (
            !asking && (
              <div className="k-empty" style={{ margin: 'auto' }}>
                <div className="k-title">{all.length === 0 ? 'Nothing has been written yet' : 'Nothing to show'}</div>
                <div className="k-text">
                  This is where what employees write for you is kept, to be read when you have the time:
                  <br />a <b>report</b> you asked somebody for · a <b>plan</b> or a <b>review</b> handed in with a task · what a <b>meeting</b> decided.
                </div>
                {!visitor && (
                  <Button variant="primary" onClick={() => setAsking(true)}>
                    Ask for a report
                  </Button>
                )}
              </div>
            )
          )}
        </div>
      </div>
    </Window>
  );
}

registerPanel('reports', ReportsPanel);
