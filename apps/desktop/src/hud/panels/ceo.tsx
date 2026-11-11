import { useEffect, useMemo, useState } from 'react';
import type { Host, OrchestratorEvent } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Empty, Progress, Provenance, Stat, clock, timeAgo } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { loadAccounts, useOffice } from '../../lib/store.ts';
import { useAccess } from '../../lib/access.ts';
import { limitText } from '../../lib/views.ts';
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

export function Usage({ untitled }: { untitled?: boolean } = {}) {
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
      {!untitled && (
        <div className="row" style={{ margin: '14px 0 6px' }}>
          <div className="section-title" style={{ margin: 0 }}>
            Token usage
          </div>
          {has && <Provenance kind="measured" />}
        </div>
      )}
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

/** One window of an account as a bar with its figure above it. */
function Meter({ w, label }: { w: { usedPercent: number; resetsAt: string | null } | null; label: string }) {
  if (!w) return <span className="small muted">{NOT_AVAILABLE}</span>;
  const resets = (limitText(w) ?? '').split('·')[1]?.trim();
  return (
    <div className="cl-meter" title={w.resetsAt ? `Resets ${new Date(w.resetsAt).toLocaleString()}` : undefined}>
      <div className="cl-meter-top">
        <span>
          <span className="mono strong">{Math.round(w.usedPercent)}%</span>
          {/* Shown where the table has no header row (a narrow window). */}
          <span className="faint cl-meter-label"> {label}</span>
        </span>
        {resets && <span className="faint">{resets}</span>}
      </div>
      <Progress value={w.usedPercent} tone={w.usedPercent >= 90 ? 'bad' : w.usedPercent >= 70 ? 'warn' : 'good'} />
    </div>
  );
}

type Account = ReturnType<typeof useOffice.getState>['accounts'][number];

/**
 * The Claude accounts of the office, machine by machine: how much of each is used, who is on it, and — for an
 * owner — adding an account to a machine and moving people off one. A row opens for the details.
 */
export function ClaudeAccounts() {
  const accounts = useOffice((s) => s.accounts);
  const employees = useOffice((s) => s.employees);
  const hosts = useOffice((s) => s.hosts);
  const settings = useOffice((s) => s.settings);
  const can = useAccess();
  const [busy, run] = useAction();
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  useEffect(() => {
    void loadAccounts();
  }, []);
  const then = async <T,>(fn: () => Promise<T>, ok?: string) => {
    const r = await run(fn, ok);
    await loadAccounts();
    return r;
  };
  const ready = (a: Account) => !a.exhausted && a.loggedIn !== false;
  const used = (a: Account) => Math.max(a.fiveHour?.usedPercent ?? 0, a.sevenDay?.usedPercent ?? 0);
  // The office's own machines first, then members' computers; in a machine, the accounts people are on first.
  const groups = useMemo(() => {
    const byHost = new Map<string, Account[]>();
    for (const a of accounts) byHost.set(a.hostId, [...(byHost.get(a.hostId) ?? []), a]);
    return [...byHost.entries()]
      .map(([hostId, list]) => ({ host: hosts[hostId], hostId, list: [...list].sort((x, y) => Number(y.employeeIds.length > 0) - Number(x.employeeIds.length > 0) || used(y) - used(x)) }))
      .sort((x, y) => Number(!!x.host?.memberId) - Number(!!y.host?.memberId) || (x.host?.name ?? '').localeCompare(y.host?.name ?? ''));
  }, [accounts, hosts]);
  const people = new Set(accounts.flatMap((a) => a.employeeIds)).size;
  const spent = accounts.filter((a) => a.exhausted);
  const waiting = spent.reduce((n, a) => n + a.employeeIds.length, 0);

  if (accounts.length === 0) return <div className="card small muted">No employee is placed on a machine yet, so there is no Claude account to show.</div>;
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="pc-stats">
        <Stat label="Accounts" value={accounts.length} />
        <Stat label="With room" value={accounts.filter(ready).length} />
        <Stat label="Used up" value={spent.length} tone={spent.length ? 'bad' : undefined} />
        <Stat label="Employees" value={people} />
      </div>
      {waiting > 0 && (
        <div className="pc-note">
          {waiting} employee{waiting === 1 ? ' is' : 's are'} on an account that is used up.{' '}
          {settings?.accountFailover === false ? 'Moving them by itself is switched off (Settings → Employees).' : 'They are moved as soon as another account on the same machine has room and somebody logged in.'}
        </div>
      )}

      {groups.map(({ host, hostId, list }) => (
        <div key={hostId}>
          <div className="row" style={{ marginBottom: 6 }}>
            <span className={`dot${host?.status === 'online' ? ' dot-good' : ''}`} />
            <span className="strong">{host?.name ?? 'Unknown machine'}</span>
            <span className="small faint grow">
              {list.length} account{list.length === 1 ? '' : 's'}
              {host?.status !== 'online' ? ' · offline' : ''}
            </span>
            {can.admin && host && !host.memberId && adding !== hostId && (
              <Button small disabled={host.status !== 'online'} title={host.status !== 'online' ? `${host.name} is offline` : 'Another Claude account for this machine, with an allowance of its own'} onClick={() => setAdding(hostId)}>
                Add an account…
              </Button>
            )}
          </div>
          {adding === hostId && host && <AddAccount host={host} taken={list.map((a) => a.configDir)} onClose={() => setAdding(null)} />}
          <div className="cl-table">
            <div className="cl-row cl-head">
              <span>Account</span>
              <span>5 hours used</span>
              <span>This week used</span>
              <span>Employees</span>
              <span />
            </div>
            {list.map((a) => {
              const who = a.employeeIds.map((id) => employees[id]).filter((e): e is NonNullable<typeof e> => !!e);
              const added = !!a.configDir && !!host?.claudeAccounts?.includes(a.configDir);
              const others = list.filter((x) => x.key !== a.key && ready(x));
              const isOpen = open === a.key;
              const name = a.email ?? (host?.memberId ? `${host.memberName ?? 'Member'}'s Claude` : (a.configDir ?? 'Default login'));
              return (
                <div key={a.key} className={`claude-account${isOpen ? ' cl-open' : ''}`}>
                  <div className="cl-row cl-click" role="button" tabIndex={0} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : a.key)} onKeyDown={(ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), setOpen(isOpen ? null : a.key))}>
                    <div style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 6 }}>
                        <span className="strong truncate">{name}</span>
                        {a.exhausted && <Badge tone="bad">used up</Badge>}
                        {a.loggedIn === false && <Badge tone="warn">nobody logged in</Badge>}
                      </div>
                      <div className="small faint truncate">{[a.organization, a.configDir ?? 'default login'].filter((x) => !!x && x !== name).join(' · ') || 'an account added to this machine'}</div>
                    </div>
                    {a.reportedAt ? (
                      <>
                        <Meter w={a.fiveHour} label="of 5 hours" />
                        <Meter w={a.sevenDay} label="of the week" />
                      </>
                    ) : (
                      <span className="small muted cl-span2" title="The figures come from Claude Code in a running session; they appear the next time an employee on this account starts one.">
                        {a.loggedIn === false ? 'Waiting for somebody to log in' : 'Not reported yet'}
                      </span>
                    )}
                    <div className="cl-people" aria-label={who.length ? `used by ${who.map((e) => e.name).join(', ')}` : 'used by nobody'} title={who.map((e) => e.name).join(', ') || 'Nobody is on this account'}>
                      {who.slice(0, 5).map((e) => (
                        <Avatar key={e.id} appearance={e.appearance} size={22} />
                      ))}
                      <span className={`small ${who.length ? 'muted' : 'faint'}`}>{who.length > 5 ? `+${who.length - 5}` : who.length === 0 ? 'nobody' : ''}</span>
                    </div>
                    <span className="cl-chevron" aria-hidden />
                  </div>
                  {isOpen && (
                    <div className="cl-detail col" style={{ gap: 6 }}>
                      <div className="small">
                        <span className="muted">Used by</span> {who.length ? who.map((e) => e.name).join(', ') : 'nobody'}
                      </div>
                      <div className="small faint">
                        {a.reportedAt
                          ? `Reported ${timeAgo(a.reportedAt)}${a.reportedBy && employees[a.reportedBy] ? ` by ${employees[a.reportedBy]!.name}'s session` : ''}.`
                          : a.loggedIn === false
                            ? 'Nobody is logged in to Claude Code in this folder yet. Nobody is moved here before somebody is.'
                            : 'Not reported yet. The figures appear the next time an employee on this account starts a session.'}
                      </div>
                      {a.spentUntil && Date.parse(a.spentUntil) > Date.now() && <div className="small warn">Claude refused a turn on this account for its limit; it counts as used up until {new Date(a.spentUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</div>}
                      {can.admin && ((who.length > 0 && others.length > 0) || (added && who.length === 0)) && (
                        <div className="row" style={{ gap: 6 }}>
                          {who.length > 0 && others.length > 0 && (
                            <Button small disabled={busy} title="Puts everybody on this account on another account of the same machine and starts their sessions again there" onClick={() => void then(() => api<{ moved: number }>('POST', `/hosts/${a.hostId}/accounts/move`, { from: a.configDir }), 'Moved to another account')}>
                              Move {who.length === 1 ? who[0]!.name : `these ${who.length}`} to another account
                            </Button>
                          )}
                          {added && who.length === 0 && (
                            <Button small variant="ghost" disabled={busy} title="Takes the account off the office's list. Nothing on the machine is deleted." onClick={() => void then(() => api('DELETE', `/hosts/${a.hostId}/accounts?dir=${encodeURIComponent(a.configDir!)}`), 'Account removed from the list')}>
                              Remove from the list
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="small faint">
        The percentages are Claude Code's own for a subscription account; an account billed by API key reports none.{' '}
        {settings?.accountFailover === false ? 'An employee whose account runs out waits for it to reset (Settings → Employees).' : 'When an account runs out, its employees go on working on another account of the same machine.'}
      </div>
    </div>
  );
}

type AccountAnswer = { dir: string | null; loggedIn: boolean; email: string | null; login: string };

/** Another Claude account for a machine: the office makes its folder there; somebody logs in to it once, on that machine. */
function AddAccount({ host, taken, onClose }: { host: Host; taken: Array<string | null>; onClose: () => void }) {
  const [dir, setDir] = useState('');
  const [answer, setAnswer] = useState<AccountAnswer | null>(null);
  const [busy, run] = useAction();
  const suggested = useMemo(() => {
    for (let i = 2; ; i++) if (!taken.includes(`~/.claude-${i}`)) return `~/.claude-${i}`;
    // Suggested once, when the form opens: the list changes as soon as the account is added.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const add = async () => {
    const res = await run(() => api<AccountAnswer>('POST', `/hosts/${host.id}/accounts`, { dir: dir.trim() || suggested }));
    if (res) setAnswer(res);
    await loadAccounts();
  };
  const check = async () => {
    const res = await run(() => api<{ accounts: AccountAnswer[] }>('POST', `/hosts/${host.id}/accounts/check`, {}));
    const mine = res?.accounts.find((x) => x.dir === answer!.dir);
    if (mine) setAnswer(mine);
    await loadAccounts();
  };
  const command = answer?.login.replace(/\s+\(then \/login\)$/, '') ?? '';
  return (
    <div className="card col" style={{ gap: 8, marginBottom: 8 }}>
      <div className="strong">Add a Claude account to {host.name}</div>
      {!answer ? (
        <>
          <div className="small muted">An account is a folder of its own on the machine, with its own login and its own allowance. The office makes the folder; you then log in to it once, on that machine.</div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input className="mono grow" value={dir} onChange={(ev) => setDir(ev.target.value)} placeholder={suggested} spellCheck={false} aria-label="Account folder" style={{ minWidth: 160 }} />
            <Button small variant="primary" disabled={busy} onClick={() => void add()}>
              Add
            </Button>
            <Button small variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </>
      ) : answer.loggedIn ? (
        <>
          <div className="small good">
            {answer.email ?? 'Somebody'} is logged in to {answer.dir}. The account is ready: employees are put on it when theirs runs out, and anybody can be put on it in their profile.
          </div>
          <div className="row">
            <Button small onClick={onClose}>
              Done
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="small">
            <b>1.</b> The folder <span className="mono">{answer.dir}</span> is there. On {host.name}, as the user the office runs as, run:
          </div>
          <div className="row" style={{ gap: 6 }}>
            <code className="mono small grow cl-command">{command}</code>
            <Button small onClick={() => void copyText(command, 'Command copied')}>
              Copy
            </Button>
          </div>
          <div className="small">
            <b>2.</b> Type <span className="mono">/login</span> there, finish in the browser with the other account, and leave with <span className="mono">/exit</span>.
          </div>
          <div className="small">
            <b>3.</b> Come back and press Check.
          </div>
          <div className="row" style={{ gap: 6 }}>
            <Button small variant="primary" disabled={busy} onClick={() => void check()}>
              Check
            </Button>
            <Button small variant="ghost" onClick={onClose}>
              Later
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
