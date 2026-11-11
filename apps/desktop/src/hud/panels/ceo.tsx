import { useEffect, useMemo, useState } from 'react';
import type { OrchestratorEvent } from '@orchestrator/contracts';
import { Badge, Button, Empty, Progress, Provenance, clock, timeAgo } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { loadAccounts, useOffice } from '../../lib/store.ts';
import { accountName, limitText } from '../../lib/views.ts';
import { NOT_AVAILABLE, copyText, eventTone, fmtInt, isLoudEvent } from './company-shared.tsx';
import { useAction } from './tasks.tsx';

/** The parts of the Company window that came from the CEO's desk: projects, usage, what happened. */

export function Portfolio() {
  const projectsById = useOffice((s) => s.projects);
  const tasks = useOffice((s) => s.tasks);
  const projects = useMemo(
    () =>
      Object.values(projectsById)
        .filter((p) => p.status !== 'archived')
        .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || a.name.localeCompare(b.name)),
    [projectsById],
  );
  if (projects.length === 0) return <Empty title="No projects yet">Create a project at the project board to see it here.</Empty>;
  return (
    <div className="grid2" style={{ gap: 10 }}>
      {projects.map((p) => {
        // Review tasks are bookkeeping for the work under review, so they do not count as deliverables.
        const ts = Object.values(tasks).filter((t) => t.projectId === p.id && t.kind !== 'review');
        const done = ts.filter((t) => t.status === 'DONE').length;
        const inProgress = ts.filter((t) => t.status === 'IN_PROGRESS').length;
        const blocked = ts.filter((t) => t.status === 'BLOCKED').length;
        const review = ts.filter((t) => t.status === 'REVIEW').length;
        return (
          <button key={p.id} className="card card-click pc-cardbtn col" style={{ gap: 6, borderLeft: `3px solid ${p.color}` }} onClick={() => useOffice.getState().openPanel('projects', p.id)}>
            <span className="row">
              <span className="strong grow truncate">{p.name}</span>
              {p.deliveredAt && (
                <Badge tone="good" title={`Every released task was verified done ${timeAgo(p.deliveredAt)}`}>
                  delivered
                </Badge>
              )}
              <Badge tone={p.status === 'active' ? 'info' : 'muted'}>{p.status}</Badge>
            </span>
            <span className="row" style={{ gap: 8 }}>
              <Progress value={ts.length ? (done / ts.length) * 100 : 0} tone={p.deliveredAt ? 'good' : 'info'} />
              <span className="small mono muted pc-nowrap">
                {done}/{ts.length} done
              </span>
            </span>
            <span className="row row-wrap small" style={{ gap: 10 }}>
              <span className="muted">{inProgress} in progress</span>
              <span className="muted">{review} in review</span>
              <span className={blocked ? 'feed-bad' : 'muted'}>{blocked} blocked</span>
              {ts.length === 0 && <span className="faint">no tasks yet</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function Usage() {
  const sessions = useOffice((s) => s.sessions);
  const all = Object.values(sessions);
  const measured = all.filter((s) => s.usage !== null);
  const sum = measured.reduce(
    (acc, s) => ({
      input: acc.input + s.usage!.inputTokens,
      output: acc.output + s.usage!.outputTokens,
      cacheRead: acc.cacheRead + s.usage!.cacheReadTokens,
      cacheWrite: acc.cacheWrite + s.usage!.cacheCreationTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  const has = measured.length > 0;
  // Only SDK-managed workers come with a cost figure, and it is the SDK's own estimate.
  const costed = measured.filter((s) => typeof s.usage!.costUsdEstimate === 'number');
  const cost = costed.reduce((acc, s) => acc + (s.usage!.costUsdEstimate ?? 0), 0);
  const value = (n: number) => (has ? fmtInt(n) : <span className="muted">{NOT_AVAILABLE}</span>);
  return (
    <div>
      <div className="row" style={{ margin: '14px 0 6px' }}>
        <div className="section-title" style={{ margin: 0 }}>
          Token usage
        </div>
        {has && <Provenance kind="measured" />}
      </div>
      <div className="card col" style={{ gap: 8 }}>
        <dl className="kv">
          <dt>Input tokens</dt>
          <dd className="mono">{value(sum.input)}</dd>
          <dt>Output tokens</dt>
          <dd className="mono">{value(sum.output)}</dd>
          <dt>Cache-read tokens</dt>
          <dd className="mono">{value(sum.cacheRead)}</dd>
          <dt>Cache-write tokens</dt>
          <dd className="mono">{value(sum.cacheWrite)}</dd>
          <dt>Cost</dt>
          <dd>
            {costed.length ? (
              <span className="mono" title="Reported by the Claude Agent SDK for SDK-managed workers, since each worker process started. The SDK describes it as an estimate, not a bill.">
                ≈ ${cost.toFixed(4)} <span className="faint">(SDK estimate, {costed.length} SDK-managed session{costed.length === 1 ? '' : 's'})</span>
              </span>
            ) : (
              <span className="muted">{NOT_AVAILABLE}</span>
            )}
          </dd>
        </dl>
        <div className="small faint">
          {has
            ? `Measured from the Claude Code transcripts on the machines, summed over ${measured.length} of ${all.length} recorded session${all.length === 1 ? '' : 's'}${
                all.length - measured.length > 0 ? `; for the other ${all.length - measured.length} usage is not available, so the real total may be higher` : ''
              }.`
            : `Usage is measured from Claude Code transcripts on the machines. ${all.length ? `None of the ${all.length} recorded session${all.length === 1 ? ' has' : 's have'} a measurement` : 'There are no sessions yet'}, so no totals are shown.`}{' '}
          {costed.length
            ? 'The cost figure is the Claude Agent SDK’s own running estimate for SDK-managed workers only; interactive Claude Code sessions expose no cost, so it is not a total.'
            : 'Cost is not available because interactive Claude Code does not expose it; nothing here is estimated.'}
        </div>
      </div>
    </div>
  );
}

export function Timeline({ onClose }: { onClose: () => void }) {
  const events = useOffice((s) => s.events);
  const shown = useMemo(() => events.filter(isLoudEvent).slice(-40).reverse(), [events]);
  const go = (e: OrchestratorEvent) => {
    const st = useOffice.getState();
    if (e.taskId && st.tasks[e.taskId]) st.openPanel('task', e.taskId);
    else if (e.employeeId && st.employees[e.employeeId]) {
      st.focusEmployee(e.employeeId);
      onClose();
    }
  };
  return (
    <div>
      <div className="section-title">What happened</div>
      <div className="card pc-timeline" style={{ padding: '6px 0' }}>
        {shown.length === 0 && <div className="feed-item muted">Nothing has happened yet.</div>}
        {shown.map((e) => (
          <button key={e.id} className="feed-item" onClick={() => go(e)} title={`${e.summary}\n${e.type} · source: ${e.source.kind} · ${new Date(e.ts).toLocaleString()}`}>
            <span className="feed-time">{clock(e.ts)}</span>
            <span className={`feed-text ${eventTone(e)}`}>{e.summary}</span>
          </button>
        ))}
      </div>
      {shown.length > 0 && (
        <div className="small faint" style={{ marginTop: 4 }}>
          The last {shown.length} recorded event{shown.length === 1 ? '' : 's'}, newest first. Each comes from a hook, an employee's tool call, a machine observation or your own action.
        </div>
      )}
    </div>
  );
}

function LimitRow({ label, w }: { label: string; w: { usedPercent: number; resetsAt: string | null } | null }) {
  const text = limitText(w);
  return (
    <div className="row" style={{ gap: 8 }}>
      <span className="small muted" style={{ width: 62, flex: 'none' }}>
        {label}
      </span>
      {w ? <Progress value={w.usedPercent} tone={w.usedPercent >= 90 ? 'bad' : w.usedPercent >= 70 ? 'warn' : 'good'} /> : <span className="grow" />}
      <span className="small mono pc-nowrap" title={w?.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : undefined}>
        {text ?? <span className="muted">{NOT_AVAILABLE}</span>}
      </span>
    </div>
  );
}

/** How much Claude is left: one card per account the employees run on; an owner adds accounts to a machine here. */
export function ClaudeAccounts() {
  const accounts = useOffice((s) => s.accounts);
  const employees = useOffice((s) => s.employees);
  const hosts = useOffice((s) => s.hosts);
  const settings = useOffice((s) => s.settings);
  const [busy, run] = useAction();
  useEffect(() => {
    void loadAccounts();
  }, []);
  const then = async <T,>(fn: () => Promise<T>, ok?: string) => {
    const r = await run(fn, ok);
    await loadAccounts();
    return r;
  };
  return (
    <div>
      <div className="row" style={{ margin: '14px 0 6px' }}>
        <div className="section-title" style={{ margin: 0 }}>
          Claude left
        </div>
      </div>
      {accounts.length === 0 && <div className="card small muted">No employee is placed on a machine yet, so there is no Claude account to show.</div>}
      <div className="col" style={{ gap: 8 }}>
        {accounts.map((a) => {
          const who = a.employeeIds.map((id) => employees[id]?.name).filter(Boolean);
          const host = hosts[a.hostId];
          const added = !!a.configDir && !!host?.claudeAccounts?.includes(a.configDir);
          const others = accounts.filter((x) => x.hostId === a.hostId && x.key !== a.key && !x.exhausted && x.loggedIn !== false);
          return (
            <div key={a.key} className="card col claude-account" style={{ gap: 6 }}>
              <div className="row">
                <span className="strong grow truncate">{accountName(a, host?.name)}</span>
                {a.exhausted && <Badge tone="bad">used up</Badge>}
                {a.loggedIn === false && <Badge tone="warn">nobody logged in</Badge>}
                {a.organization && <span className="small faint truncate">{a.organization}</span>}
              </div>
              {a.reportedAt ? (
                <>
                  <LimitRow label="5 hours" w={a.fiveHour} />
                  <LimitRow label="This week" w={a.sevenDay} />
                </>
              ) : (
                <div className="small muted">{a.loggedIn === false ? 'Nobody is logged in to Claude Code in this folder yet.' : 'Not reported yet. It appears the next time an employee on this account starts a session.'}</div>
              )}
              {a.spentUntil && Date.parse(a.spentUntil) > Date.now() && <div className="small warn">Claude refused a turn on this account for its limit; it counts as used up until {new Date(a.spentUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</div>}
              <div className="small faint">
                {host?.name ?? 'unknown machine'} · {a.configDir ?? 'default login'} · used by {who.length ? who.join(', ') : 'nobody'}
                {a.reportedAt ? ` · reported ${timeAgo(a.reportedAt)}${a.reportedBy && employees[a.reportedBy] ? ` by ${employees[a.reportedBy]!.name}'s session` : ''}` : ''}
              </div>
              {(who.length > 0 && others.length > 0) || (added && who.length === 0) ? (
                <div className="row" style={{ gap: 6 }}>
                  {who.length > 0 && others.length > 0 && (
                    <Button small disabled={busy} title="Puts everybody on this account on another account of the same machine and starts their sessions again there" onClick={() => void then(() => api<{ moved: number }>('POST', `/hosts/${a.hostId}/accounts/move`, { from: a.configDir }), 'Moved to another account')}>
                      Move {who.length === 1 ? who[0] : `these ${who.length}`} to another account
                    </Button>
                  )}
                  {added && who.length === 0 && (
                    <Button small variant="ghost" disabled={busy} title="Takes the account off the office's list. Nothing on the machine is deleted." onClick={() => void then(() => api('DELETE', `/hosts/${a.hostId}/accounts?dir=${encodeURIComponent(a.configDir!)}`), 'Account removed from the list')}>
                      Remove from the list
                    </Button>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <AddAccount />
      <div className="small faint" style={{ marginTop: 4 }}>
        The percentages are Claude Code's own for a subscription account; an account billed by API key reports none.{' '}
        {settings?.accountFailover === false
          ? 'An employee whose account runs out waits for it to reset (Settings → Employees).'
          : 'When an account runs out, its employees are put on another account of the same machine that has room, and go on there.'}{' '}
        An employee's account can also be set in their profile.
      </div>
    </div>
  );
}

type AccountAnswer = { dir: string | null; loggedIn: boolean; email: string | null; login: string };

/** Another Claude account for a machine: the office makes its folder there; somebody logs in to it once, on that machine. */
function AddAccount() {
  const hosts = useOffice((s) => s.hosts);
  const accounts = useOffice((s) => s.accounts);
  // The office's own machines; a member's computer is theirs to arrange.
  const machines = useMemo(() => Object.values(hosts).filter((h) => h.status !== 'revoked' && !h.memberId), [hosts]);
  const [open, setOpen] = useState(false);
  const [hostId, setHostId] = useState('');
  const [dir, setDir] = useState('');
  const [answer, setAnswer] = useState<(AccountAnswer & { hostId: string }) | null>(null);
  const [busy, run] = useAction();
  const host = hosts[hostId] ?? machines[0];
  const suggested = useMemo(() => {
    const taken = new Set(accounts.filter((a) => a.hostId === host?.id).map((a) => a.configDir));
    for (let i = 2; ; i++) if (!taken.has(`~/.claude-${i}`)) return `~/.claude-${i}`;
  }, [accounts, host?.id]);
  if (machines.length === 0) return null;
  const add = async () => {
    const res = await run(() => api<AccountAnswer>('POST', `/hosts/${host!.id}/accounts`, { dir: dir.trim() || suggested }));
    if (res) setAnswer({ ...res, hostId: host!.id });
    await loadAccounts();
  };
  const check = async () => {
    const res = await run(() => api<{ accounts: AccountAnswer[] }>('POST', `/hosts/${answer!.hostId}/accounts/check`, {}));
    const mine = res?.accounts.find((x) => x.dir === answer!.dir);
    if (mine) setAnswer({ ...mine, hostId: answer!.hostId });
    await loadAccounts();
  };
  if (!open)
    return (
      <div className="row" style={{ marginTop: 8 }}>
        <Button small onClick={() => setOpen(true)}>
          Add a Claude account…
        </Button>
      </div>
    );
  return (
    <div className="card col" style={{ gap: 8, marginTop: 8 }}>
      <div className="strong">Add a Claude account</div>
      {!answer ? (
        <>
          <div className="small muted">
            Each account is a folder of its own on the machine, with its own login and its own allowance. The office makes the folder; you then log in to it once on that machine. Employees are spread over a machine's accounts when one runs out.
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {machines.length > 1 && (
              <select value={host?.id ?? ''} onChange={(ev) => setHostId(ev.target.value)} aria-label="Machine">
                {machines.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            )}
            <input className="mono grow" value={dir} onChange={(ev) => setDir(ev.target.value)} placeholder={suggested} spellCheck={false} aria-label="Account folder" style={{ minWidth: 160 }} />
            <Button small variant="primary" disabled={busy || !host || host.status !== 'online'} onClick={() => void add()}>
              Add to {host?.name ?? 'the machine'}
            </Button>
            <Button small variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
          {host && host.status !== 'online' && <div className="small warn">{host.name} is offline.</div>}
        </>
      ) : answer.loggedIn ? (
        <>
          <div className="small good">
            {answer.email ?? 'Somebody'} is logged in to {answer.dir}. The account is ready: employees are put on it when theirs runs out, and you can put anybody on it in their profile.
          </div>
          <div className="row">
            <Button small onClick={() => (setAnswer(null), setDir(''), setOpen(false))}>
              Done
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="small">
            The folder <span className="mono">{answer.dir}</span> is there on {hosts[answer.hostId]?.name ?? 'the machine'}. Nobody is logged in to it yet. On that machine, as the user the office runs as, run this and log in with the other account:
          </div>
          <div className="row" style={{ gap: 6 }}>
            <code className="mono small grow" style={{ userSelect: 'all', overflowWrap: 'anywhere' }}>
              {answer.login.replace(/\s+\(then \/login\)$/, '')}
            </code>
            <Button small onClick={() => void copyText(answer.login.replace(/\s+\(then \/login\)$/, ''), 'Command copied')}>
              Copy
            </Button>
          </div>
          <div className="small muted">Then type /login there, finish in the browser, and leave Claude Code with /exit. Nobody is moved to this account before somebody is logged in.</div>
          <div className="row" style={{ gap: 6 }}>
            <Button small variant="primary" disabled={busy} onClick={() => void check()}>
              Check
            </Button>
            <Button small variant="ghost" onClick={() => (setAnswer(null), setDir(''), setOpen(false))}>
              Later
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
