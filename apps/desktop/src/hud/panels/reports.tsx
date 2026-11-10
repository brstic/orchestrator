import { useMemo, useState } from 'react';
import type { Artifact } from '@orchestrator/contracts';
import { Badge, Empty, Markdown, Window, timeAgo } from '@orchestrator/ui';
import { useOffice } from '../../lib/store.ts';
import { registerPanel } from './index.tsx';

const KIND_LABEL: Record<Artifact['kind'], string> = { decision_doc: 'decision', report: 'report', plan: 'plan', review: 'review', test_output: 'test output', summary: 'summary' };

/**
 * What employees handed in: reports, plans, reviews, summaries and meeting decisions. Each one was
 * submitted by a real session through the office's tools (or written by a meeting's facilitator);
 * it is shown as written, formatted as Markdown.
 */
function ReportsPanel({ arg, onClose }: { arg: string | null; onClose: () => void }) {
  const artifacts = useOffice((s) => s.artifacts);
  const employees = useOffice((s) => s.employees);
  const projects = useOffice((s) => s.projects);
  const tasks = useOffice((s) => s.tasks);
  const openPanel = useOffice((s) => s.openPanel);
  // `arg` is an artifact id, or "task:<id>" / "employee:<id>" to show only theirs.
  const scope = arg?.startsWith('task:') ? { taskId: arg.slice(5) } : arg?.startsWith('employee:') ? { employeeId: arg.slice(9) } : null;
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string | null>(arg && !scope ? arg : null);

  const all = useMemo(() => Object.values(artifacts).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [artifacts]);
  const needle = search.trim().toLowerCase();
  const shown = all.filter(
    (a) =>
      (!scope || (scope.taskId ? a.taskId === scope.taskId : a.employeeId === scope.employeeId)) &&
      (!kind || a.kind === kind) &&
      (!needle || `${a.title} ${a.content} ${employees[a.employeeId ?? '']?.name ?? ''}`.toLowerCase().includes(needle)),
  );
  const current = shown.find((a) => a.id === picked) ?? shown[0] ?? null;
  const scopeLabel = scope?.taskId ? `for ${tasks[scope.taskId]?.key ?? 'this task'}` : scope?.employeeId ? `from ${employees[scope.employeeId]?.name ?? 'this employee'}` : null;

  return (
    <Window title="Reports" subtitle={`Handed in by employees${scopeLabel ? ` · ${scopeLabel}` : ''}`} onClose={onClose} width={1180} flush>
      <div className="doc-cols">
        <div className="doc-side">
          <div className="col" style={{ gap: 6, padding: '10px 10px 6px' }}>
            <input type="search" aria-label="Search reports" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Every kind ({all.length})</option>
              {(Object.keys(KIND_LABEL) as Array<Artifact['kind']>).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]} ({all.filter((a) => a.kind === k).length})
                </option>
              ))}
            </select>
            {scope && (
              <button className="btn btn-ghost btn-sm" onClick={() => openPanel('reports')}>
                Show everything
              </button>
            )}
          </div>
          <div className="doc-tree">
          {shown.length === 0 ? (
            <div className="small faint" style={{ padding: 12 }}>
              {all.length === 0 ? 'Nothing has been handed in yet. Ask someone for a report (right-click → Request report), or hold a meeting.' : 'Nothing matches.'}
            </div>
          ) : (
            shown.map((a) => (
              <button key={a.id} className={`report-row ${current?.id === a.id ? 'report-row-on' : ''}`} onClick={() => setPicked(a.id)}>
                <span className="truncate strong">{a.title}</span>
                <span className="small faint truncate">
                  {KIND_LABEL[a.kind]} · {employees[a.employeeId ?? '']?.name ?? (a.meetingId ? 'meeting' : 'office')} · {timeAgo(a.createdAt)}
                </span>
              </button>
            ))
          )}
          </div>
        </div>
        <div className="doc-main">
          {current ? (
            <>
              <div className="doc-head">
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="strong truncate">{current.title}</div>
                  <div className="small muted">
                    {employees[current.employeeId ?? '']?.name ?? 'The office'} · {new Date(current.createdAt).toLocaleString()}
                    {current.projectId && projects[current.projectId] ? ` · ${projects[current.projectId]!.name}` : ''}
                  </div>
                </div>
                <Badge tone="info">{KIND_LABEL[current.kind]}</Badge>
                {current.taskId && tasks[current.taskId] && (
                  <button className="btn btn-sm" onClick={() => openPanel('task', current.taskId)}>
                    {tasks[current.taskId]!.key}
                  </button>
                )}
                {current.meetingId && (
                  <button className="btn btn-sm" onClick={() => openPanel('meetings', current.meetingId)}>
                    Meeting
                  </button>
                )}
              </div>
              <div className="doc-body">
                <Markdown text={current.content} />
              </div>
            </>
          ) : (
            <Empty title="No document selected">Reports, plans, reviews and meeting decisions appear here as employees hand them in.</Empty>
          )}
        </div>
      </div>
    </Window>
  );
}

registerPanel('reports', ReportsPanel);
