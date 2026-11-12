import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { DeliveryState, EvidenceProvenance, OrchestratorEvent, Task } from '@orchestrator/contracts';
import { formatDuration } from '@orchestrator/contracts';
import { Badge, Button, Empty, Markdown, Provenance, Stat, Window, clock, timeAgo, type Tone } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { Person, STATUS_META, plural, stamp } from './task-shared.tsx';
import { TaskFiles } from './task-files.tsx';

/**
 * What stands behind a ticket's conversation: the measured evidence of the work, the changes as they are on the
 * machine right now, and the record of everything that happened to it.
 */

const DELIVERY_TONE: Record<DeliveryState['status'], Tone> = { none: 'muted', queued: 'neutral', sent: 'info', confirmed: 'good', failed: 'bad' };

export function Delivery({ delivery }: { delivery: DeliveryState }) {
  return (
    <div className="col" style={{ gap: 3 }}>
      <span className="row row-wrap" style={{ gap: 6 }}>
        <Badge tone={DELIVERY_TONE[delivery.status]} title="queued → sent (written into the session) → confirmed (a real hook from Claude Code acknowledged it)">
          {delivery.status}
        </Badge>
        {delivery.via && <span className="small muted">via {delivery.via.replace(/_/g, ' ')}</span>}
        {delivery.ts && <span className="small faint">{timeAgo(delivery.ts)}</span>}
      </span>
      {delivery.detail && <span className="small muted">{delivery.detail}</span>}
    </div>
  );
}


function Section({ title, provenance, children }: { title: string; provenance?: EvidenceProvenance; children: ReactNode }) {
  return (
    <div>
      <div className="section-title row" style={{ gap: 8 }}>
        {title}
        {provenance && <Provenance kind={provenance} />}
      </div>
      {children}
    </div>
  );
}

export function TaskEvidence({ task }: { task: Task }) {
  const ev = task.evidence;
  const v = ev.verification;
  const f = task.friction;
  return (
    <div className="col" style={{ gap: 4 }}>
      <TaskFiles task={task} only="evidence" />
      <Section title="Verification" provenance={v?.provenance}>
        {v ? (
          <div className="col">
            <div className="row row-wrap">
              <Badge tone={v.passed === true ? 'good' : v.passed === false ? 'bad' : 'muted'}>{v.passed === true ? 'passed' : v.passed === false ? 'failed' : 'no result'}</Badge>
              <span className="small muted">
                exit code {v.exitCode ?? 'not available'} · duration {v.durationMs != null ? formatDuration(v.durationMs) : 'not available'} · {stamp(v.ts)}
              </span>
            </div>
            {v.command ? <div className="code">$ {v.command}</div> : <div className="small muted">No verification command is configured, so nothing was run.</div>}
            {v.outputTail && (
              <>
                <div className="small faint">End of the command's output, as captured on the host:</div>
                <div className="code">{v.outputTail}</div>
              </>
            )}
          </div>
        ) : (
          <div className="muted">No verification is on record for this task. History shows how it reached its current status.</div>
        )}
      </Section>

      <Section title="What the employee reported" provenance="reported">
        {ev.summary ? <Markdown text={ev.summary} /> : <div className="muted">Not available: the employee has not submitted a result.</div>}
        {ev.reportedTests && (
          <div style={{ marginTop: 8 }}>
            <div className="small faint">Tests, as described by the employee:</div>
            <div className="small pre">{ev.reportedTests}</div>
          </div>
        )}
      </Section>

      <Section title={`Commits (${ev.commits.length})`} provenance="measured">
        {ev.commits.length ? (
          <table className="tbl">
            <tbody>
              {ev.commits.map((c) => (
                <tr key={c.sha}>
                  <td className="mono">{c.sha.slice(0, 8)}</td>
                  <td>{c.subject}</td>
                  <td className="small muted">{c.author}</td>
                  <td className="small faint">{c.ts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">No commits have been recorded on the task branch.</div>
        )}
      </Section>

      {ev.verification?.touchedChecks?.length ? (
        <div className="pc-note" data-touched-checks>
          This task changed what it is checked by — {ev.verification.touchedChecks.slice(0, 8).join(', ')}
          {ev.verification.touchedChecks.length > 8 ? ` and ${ev.verification.touchedChecks.length - 8} more` : ''}. Its checks passed with those changes, so it was sent to review: look at what was changed in the tests before approving.
        </div>
      ) : null}
      <Section title={`Files changed (${ev.filesChanged.length})`} provenance="measured">
        {ev.filesChanged.length ? <div className="code">{ev.filesChanged.join('\n')}</div> : <div className="muted">None recorded.</div>}
        {ev.diffStat && (
          <div className="code" style={{ marginTop: 8 }}>
            {ev.diffStat}
          </div>
        )}
      </Section>

      <Section title="Review">
        {ev.review ? (
          <div className="col" style={{ gap: 6 }}>
            <div className="row row-wrap">
              <Badge tone={ev.review.verdict === 'approved' ? 'good' : 'warn'}>{ev.review.verdict === 'approved' ? 'approved' : 'changes requested'}</Badge>
              <span className="small muted row" style={{ gap: 6 }}>
                by {ev.review.by === 'owner' ? 'you' : <Person id={ev.review.reviewerId} size={18} fallback="an employee" />} · {stamp(ev.review.ts)}
              </span>
            </div>
            {ev.review.comments ? <Markdown text={ev.review.comments} /> : <div className="small muted">No comments.</div>}
          </div>
        ) : (
          <div className="muted">{task.requiresReview ? 'Required, not reviewed yet.' : 'Not required for this task; none recorded.'}</div>
        )}
      </Section>

      <Section title="Merge" provenance={ev.merge ? 'measured' : undefined}>
        {ev.merge ? (
          <div className="col" style={{ gap: 6 }}>
            <div className="row row-wrap">
              <Badge tone={ev.merge.ok ? 'good' : 'bad'}>{ev.merge.ok ? 'merged' : 'merge failed'}</Badge>
              <span className="small muted">
                into <span className="mono">{ev.merge.into}</span>
                {ev.merge.sha ? (
                  <>
                    {' '}
                    at <span className="mono">{ev.merge.sha.slice(0, 8)}</span>
                  </>
                ) : null}{' '}
                · {stamp(ev.merge.ts)}
              </span>
            </div>
            {ev.merge.detail && <div className="code">{ev.merge.detail}</div>}
          </div>
        ) : (
          <div className="muted">No merge has been attempted.</div>
        )}
      </Section>

      <Section title="Friction on the way" provenance="measured">
        <div className="grid4">
          <Stat label="Failed verifications" value={f.failedVerifications} tone={f.failedVerifications ? 'warn' : undefined} />
          <Stat label="Review rejections" value={f.reviewRejections} tone={f.reviewRejections ? 'warn' : undefined} />
          <Stat label="Merge conflicts" value={f.mergeConflicts} tone={f.mergeConflicts ? 'warn' : undefined} />
          <Stat label="Blockers" value={f.blockers} tone={f.blockers ? 'warn' : undefined} />
          <Stat label="Questions asked" value={f.questions} />
          <Stat label="Permission denials" value={f.denials} />
          <Stat label="Nudges to continue" value={task.nudges} />
          <Stat label="Times sent back" value={task.attempts} />
        </div>
      </Section>
    </div>
  );
}


// ─────────────────────────── task: changes ───────────────────────────

/** What the host returns for a working tree (git status + diff, read live). */
interface GitView {
  cwd: string;
  base: string | null;
  status: { branch: string | null; head: string | null; dirty: boolean; files: Array<{ status: string; path: string }>; repoRoot: string | null };
  diff: { stat: string; diff: string; truncated: boolean; uncommitted: string; untracked: string[]; files: string[] };
}

function DiffView({ text }: { text: string }) {
  const lines = useMemo(() => {
    let header = false;
    return text
      .replace(/\n$/, '')
      .split('\n')
      .map((line) => {
        if (line.startsWith('diff --git')) header = true;
        else if (line.startsWith('@@')) header = false;
        const cls = header ? 'diff-file' : line.startsWith('@@') ? 'diff-hunk' : line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-del' : undefined;
        return { line, cls };
      });
  }, [text]);
  return (
    <div className="code pw-diff">
      {lines.map((l, i) => (
        <div key={i} className={l.cls}>
          {l.line}
        </div>
      ))}
    </div>
  );
}

export function GitChanges({ path }: { path: string }) {
  const q = useQuery({ queryKey: ['git-view', path], queryFn: () => api<GitView>('GET', path), retry: false, refetchOnMount: 'always' });
  if (q.isPending) return <div className="muted">Reading the working tree from the host…</div>;
  if (q.isError) {
    return (
      <div className="col" style={{ alignItems: 'center' }}>
        <Empty title="The changes cannot be read right now">
          Orchestrator reads them live from the employee's machine, and it answered: {q.error.message}.
        </Empty>
        <Button onClick={() => q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? 'Trying…' : 'Try again'}
        </Button>
      </div>
    );
  }
  const { cwd, base, status, diff } = q.data;
  const tracked = status.files.filter((f) => f.status !== '??');
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row spread">
        <span className="row" style={{ gap: 8 }}>
          <Provenance kind="measured" />
          <span className="small muted">read from the host at {clock(new Date(q.dataUpdatedAt).toISOString())}</span>
        </span>
        <Button small onClick={() => q.refetch()} disabled={q.isFetching}>
          {q.isFetching ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
      <dl className="kv small">
        <dt>Working directory</dt>
        <dd className="mono">{cwd}</dd>
        <dt>Branch</dt>
        <dd className="mono">
          {status.branch ?? 'not available'}
          {status.head ? ` @ ${status.head.slice(0, 10)}` : ''}
        </dd>
        <dt>Compared with</dt>
        <dd className="mono">{base ?? <span className="muted">no base is known — only uncommitted changes can be shown</span>}</dd>
      </dl>
      {!status.repoRoot ? (
        <Empty title="Not a git repository">This directory is not under git, so there is nothing to diff.</Empty>
      ) : (
        <>
          {diff.truncated && <div className="pw-note pw-warn">The diff is larger than 300 KB and was cut off on the host. What follows is incomplete; open the workstation to see everything.</div>}

          <div className="section-title">Committed since the base{diff.files.length ? ` (${plural(diff.files.length, 'file')})` : ''}</div>
          {diff.stat && <div className="code">{diff.stat}</div>}
          {diff.diff ? <DiffView text={diff.diff} /> : <div className="muted">{base ? 'No committed changes.' : 'Not available without a base.'}</div>}

          <div className="section-title">Uncommitted changes{tracked.length ? ` (${plural(tracked.length, 'file')})` : ''}</div>
          {tracked.length > 0 && <div className="code">{tracked.map((f) => `${f.status.padEnd(2)} ${f.path}`).join('\n')}</div>}
          {diff.uncommitted ? <DiffView text={diff.uncommitted} /> : <div className="muted">{status.dirty ? 'No changes to tracked files.' : 'The working tree is clean.'}</div>}

          <div className="section-title">Untracked files ({diff.untracked.length})</div>
          {diff.untracked.length ? <div className="code">{diff.untracked.join('\n')}</div> : <div className="muted">None.</div>}
        </>
      )}
    </div>
  );
}


// ─────────────────────────── task: history ───────────────────────────

interface HistoryRow {
  key: string;
  ts: string;
  seq: number;
  origin: string;
  text: string;
  detail: string;
}

export function TaskHistory({ task }: { task: Task }) {
  const q = useQuery({ queryKey: ['task-events', task.id], queryFn: () => api<OrchestratorEvent[]>('GET', `/events?taskId=${encodeURIComponent(task.id)}&limit=300`), refetchOnMount: 'always' });
  const live = useOffice((s) => s.events);
  const rows = useMemo(() => {
    const events = new Map<string, OrchestratorEvent>();
    for (const e of q.data ?? []) events.set(e.id, e);
    for (const e of live) if (e.taskId === task.id && e.type !== 'session.activity') events.set(e.id, e);
    const out: HistoryRow[] = [...events.values()].map((e) => ({ key: e.id, ts: e.ts, seq: e.seq, origin: e.source.kind, text: e.summary, detail: e.type }));
    task.history.forEach((h, i) => out.push({ key: `h${i}`, ts: h.ts, seq: i, origin: 'board', text: h.note, detail: `${STATUS_META[h.status].label} · by ${h.by}` }));
    return out.sort((a, b) => b.ts.localeCompare(a.ts) || b.seq - a.seq);
  }, [q.data, live, task.history, task.id]);
  return (
    <div className="col">
      <div className="small muted">
        Newest first. <Badge tone="accent">board</Badge> rows are the task's own status record; the others are recorded events, labelled with the signal they came from (hook, mcp, host, server, owner).
      </div>
      {q.isError && <div className="pw-note pw-warn">The stored event log could not be loaded ({q.error.message}). Showing the task's own record and the events received in this session.</div>}
      {q.data?.length === 300 && <div className="pw-note">Only the latest 300 stored events are shown.</div>}
      {rows.length === 0 ? (
        <div className="muted">{q.isPending ? 'Loading…' : 'Nothing has been recorded for this task yet.'}</div>
      ) : (
        <div className="pw-timeline">
          {rows.map((r) => (
            <div key={r.key} style={{ display: 'contents' }}>
              <span className="mono faint" title={new Date(r.ts).toLocaleString()}>
                {stamp(r.ts)}
              </span>
              <Badge tone={r.origin === 'board' ? 'accent' : 'muted'}>{r.origin}</Badge>
              <span>
                {r.text} <span className="small faint">{r.detail}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


export function EmployeeChanges({ employeeId, onClose }: { employeeId: string; onClose: () => void }) {
  const e = useOffice((s) => s.employees[employeeId]);
  return (
    <Window title={e ? `${e.name}'s working tree` : 'Working tree'} subtitle="What they have changed in their folder so far" onClose={onClose} width={1040} flush>
      <div className="pw-frame">
        <div className="pw-body">{e ? <GitChanges path={`/employees/${employeeId}/git`} /> : <Empty title="Unknown employee" />}</div>
      </div>
    </Window>
  );
}

