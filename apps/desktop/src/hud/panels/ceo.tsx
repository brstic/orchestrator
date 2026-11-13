import { useEffect, useMemo, useRef, useState } from 'react';
import type { AccountInfo, AccountLogin, Host, OrchestratorEvent } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Empty, Progress, Provenance, Stat, clock, timeAgo } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { loadAccounts, useOffice } from '../../lib/store.ts';
import { useAccess } from '../../lib/access.ts';
import { limitText } from '../../lib/views.ts';
import { NOT_SIGNED_IN, accountName, providerName, signInLink } from '../../lib/accounts.ts';
import { More } from './kit.tsx';
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
  const [signing, setSigning] = useState<{ hostId: string; dir: string | null } | null>(null);
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
              <Button small disabled={host.status !== 'online'} title={host.status !== 'online' ? `${host.name} is offline` : 'Another Claude account for this machine, with an allowance of its own'} onClick={() => (setSigning(null), setAdding(hostId))}>
                Add an account…
              </Button>
            )}
          </div>
          {adding === hostId && host && <div style={{ marginBottom: 10 }}><AddAccount host={host} onClose={() => setAdding(null)} /></div>}
          {signing?.hostId === hostId && host && <div style={{ marginBottom: 10 }}><SignIn key={signing.dir ?? 'default'} host={host} dir={signing.dir} onClose={() => setSigning(null)} /></div>}
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
              // Signing in from here: a Claude login on one of the office's own machines that is in the office now.
              const canSignIn = !providerName(a) && !!host && !host.memberId && host.status === 'online';
              const name = accountName(a, host);
              const service = providerName(a);
              return (
                <div key={a.key} className={`claude-account${isOpen ? ' cl-open' : ''}`}>
                  <div className="cl-row cl-click" role="button" tabIndex={0} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : a.key)} onKeyDown={(ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), setOpen(isOpen ? null : a.key))}>
                    <div style={{ minWidth: 0 }}>
                      <div className="row" style={{ gap: 6 }}>
                        <span className="strong truncate">{name}</span>
                        {a.exhausted && <Badge tone="bad">used up</Badge>}
                        {a.loggedIn === false && name !== NOT_SIGNED_IN && <Badge tone="warn">{service ? 'no key' : 'nobody signed in'}</Badge>}
                      </div>
                      <div className="small faint truncate">{[service && service !== name ? service : null, service ? 'with an API key' : null, a.organization, a.configDir ?? 'the machine\'s default login'].filter((x) => !!x && x !== name).join(' · ')}</div>
                    </div>
                    {a.reportedAt ? (
                      <>
                        <Meter w={a.fiveHour} label="of 5 hours" />
                        <Meter w={a.sevenDay} label="of the week" />
                      </>
                    ) : (
                      <span className="small muted cl-span2" title="The figures come from Claude Code in a running session; they appear the next time an employee on this account starts one.">
                        {service ? 'An API key: no allowance is reported' : a.loggedIn === false ? 'Waiting for somebody to sign in' : 'Not reported yet'}
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
                      {can.admin && (canSignIn || (who.length > 0 && others.length > 0) || (added && who.length === 0)) && (
                        <div className="row" style={{ gap: 6 }}>
                          {canSignIn && (
                            <Button small variant={a.loggedIn === false ? 'primary' : undefined} disabled={busy} title="Claude Code's own sign-in, on that machine, shown here: a link to open and a code to paste" onClick={() => (setAdding(null), setSigning({ hostId: a.hostId, dir: a.configDir }))} data-sign-in-open>
                              {a.loggedIn === false ? 'Sign in…' : 'Sign in again…'}
                            </Button>
                          )}
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
        {settings?.accountFailover === false ? 'An employee whose account runs out waits for it to reset (Settings → Employees).' : 'When an account runs out, its employees go on working on another account of the same kind on the same machine.'}
      </div>
    </div>
  );
}

/** The three steps of a sign-in, read from what its terminal shows: a link to open, a code to give back, done. */
const KEYS: Array<[string, string, string]> = [['up', '↑', 'Up'], ['down', '↓', 'Down'], ['enter', 'Enter', 'Enter'], ['escape', 'Esc', 'Escape']];

/**
 * Signing in to a Claude account without leaving the office (docs/ACCOUNTS.md, "Signing in from the office").
 * Claude Code's own sign-in runs on the machine; this shows what it shows and passes on what is typed here: it gives
 * a link, the link is opened in this computer's browser, and the code that page gives is pasted back.
 * `dir` null with `fresh`: a new account, whose folder the office chooses; `dir` null without it: the machine's default login.
 */
function SignIn({ host, dir, fresh = false, onClose }: { host: Host; dir: string | null; fresh?: boolean; onClose: () => void }) {
  const [login, setLogin] = useState<AccountLogin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const wasSignedIn = useRef(false);
  const where = login?.dir ?? dir;
  const q = where ? `?dir=${encodeURIComponent(where)}` : '';
  // Started once, when the sheet opens; from then on its terminal is looked at every second and a half.
  useEffect(() => {
    let over = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let at: string | null = dir;
    const look = async () => {
      try {
        const res = await api<AccountLogin>('GET', `/hosts/${host.id}/accounts/login${at ? `?dir=${encodeURIComponent(at)}` : ''}`);
        if (over) return;
        setLogin(res);
        setError(null);
      } catch (e) {
        if (!over) setError((e as Error).message);
      }
      if (!over) timer = setTimeout(look, 1500);
    };
    void (async () => {
      try {
        const res = await api<AccountLogin>('POST', `/hosts/${host.id}/accounts/login`, { dir, fresh });
        if (over) return;
        at = res.dir;
        wasSignedIn.current = res.account.loggedIn;
        setLogin(res);
        void loadAccounts();
        timer = setTimeout(look, 1200);
      } catch (e) {
        if (!over) setError((e as Error).message);
      }
    })();
    return () => {
      over = true;
      if (timer) clearTimeout(timer);
      // Whatever was left of the sign-in is put away with the sheet.
      void api('DELETE', `/hosts/${host.id}/accounts/login${at ? `?dir=${encodeURIComponent(at)}` : ''}`).catch(() => undefined);
      void loadAccounts();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.id, dir, fresh]);
  const send = async (payload: { text?: string; key?: string }) => {
    setSending(true);
    try {
      setLogin(await api<AccountLogin>('POST', `/hosts/${host.id}/accounts/login/input`, { dir: where, ...payload }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    setSending(false);
  };
  const link = login ? signInLink(login.lines) : null;
  // Signed in: somebody is, now — and, for an account somebody was signed in to already when this began (signing in
  // again), only once the sign-in itself has finished.
  const signedIn = !!login?.account.loggedIn && (wasSignedIn.current ? !login.running : true);
  const stopped = !!login && !login.running && !signedIn;
  // The list under the sheet says so too, as soon as it is true.
  useEffect(() => {
    if (signedIn) void loadAccounts();
  }, [signedIn]);
  return (
    <div className="k-sheet" data-sign-in={where ?? 'default'}>
      <div className="k-sheet-head">
        <div className="k-title">{fresh ? `A new Claude account on ${host.name}` : `Sign in to Claude on ${host.name}`}</div>
        <Button small variant="ghost" onClick={onClose}>
          {signedIn ? 'Done' : 'Cancel'}
        </Button>
      </div>
      {error && <div className="k-note k-bad">{error}</div>}
      {signedIn ? (
        <div className="k-text" data-signed-in>
          <b>{login!.account.email ?? 'Somebody'}</b> is signed in{login!.account.organization ? ` (${login!.account.organization})` : ''}. The account is ready: put an employee on it in their settings, and when another account of this machine runs out its employees go on working here.
        </div>
      ) : !login ? (
        !error && <div className="k-text">Starting the sign-in on {host.name}…</div>
      ) : (
        <>
          <ol className="cl-steps">
            <li className={link ? 'cl-step-on' : ''}>
              <span>
                <b>Open the sign-in page</b> in your browser and sign in with the Claude account you want here.
              </span>
              {link ? (
                <span className="row" style={{ gap: 6 }}>
                  <a className="btn btn-primary btn-sm" href={link} target="_blank" rel="noopener noreferrer" data-sign-in-link>
                    Open the sign-in page
                  </a>
                  <Button small variant="ghost" onClick={() => void copyText(link, 'Link copied')}>
                    Copy the link
                  </Button>
                </span>
              ) : (
                <span className="k-sub">{stopped ? 'The sign-in ended before it gave a link — see below.' : 'Waiting for Claude Code to give the link…'}</span>
              )}
            </li>
            <li>
              <span>
                <b>Paste the code</b> the page gives you when you have signed in.
              </span>
              <form
                className="row"
                style={{ gap: 6 }}
                onSubmit={(ev) => {
                  ev.preventDefault();
                  if (!code.trim()) return;
                  void send({ text: code.trim(), key: 'enter' });
                  setCode('');
                }}
              >
                <input className="mono grow" value={code} onChange={(ev) => setCode(ev.target.value)} placeholder="The code from the page" spellCheck={false} autoComplete="off" aria-label="Sign-in code" style={{ minWidth: 200 }} />
                <Button small type="submit" disabled={sending || !code.trim() || !login.running}>
                  Send
                </Button>
              </form>
            </li>
          </ol>
          <div>
            <div className="k-label">What Claude Code shows on {host.name}</div>
            <pre className="cl-term" data-sign-in-screen aria-live="polite">
              {login.lines.filter((l, i, all) => l.trim() || (all[i - 1] ?? '').trim()).slice(-14).join('\n') || (login.running ? '…' : 'Nothing: the sign-in is not running.')}
            </pre>
            <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <span className="k-sub">If it asks you to choose something:</span>
              {KEYS.map(([key, label, name]) => (
                <button key={key} type="button" className="k-quiet" disabled={sending || !login.running} onClick={() => void send({ key })} aria-label={`Press ${name}`}>
                  {label}
                </button>
              ))}
              {stopped && (
                <Button small onClick={() => void api<AccountLogin>('POST', `/hosts/${host.id}/accounts/login`, { dir: where }).then(setLogin, (e) => setError((e as Error).message))}>
                  Start the sign-in again
                </Button>
              )}
            </div>
          </div>
          <div className="k-sub" style={{ whiteSpace: 'normal' }}>
            The sign-in is Claude Code&apos;s own, on {host.name}; the office passes on what you type and keeps none of it.{where ? ` The account's folder there is ${where}.` : ''}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * An account of Z.AI's GLM Coding Plan: Claude Code on that account talks to Z.AI's models with an API key instead
 * of a Claude login. The key is written into the account's own folder on the machine and nowhere else.
 */
function ZaiAccount({ host, onClose }: { host: Host; onClose: () => void }) {
  const [token, setToken] = useState('');
  const [models, setModels] = useState({ opus: '', sonnet: '', haiku: '' });
  const [made, setMade] = useState<AccountInfo | null>(null);
  const [busy, run] = useAction();
  const add = async () => {
    const named = models.opus.trim() || models.sonnet.trim() || models.haiku.trim();
    const res = await run(() => api<AccountInfo>('POST', `/hosts/${host.id}/accounts/provider`, { provider: 'zai', token: token.trim(), ...(named ? { models } : {}) }));
    if (res) {
      setMade(res);
      setToken('');
    }
    await loadAccounts();
  };
  return (
    <div className="k-sheet" data-zai-account>
      <div className="k-sheet-head">
        <div className="k-title">A Z.AI account on {host.name}</div>
        <Button small variant="ghost" onClick={onClose}>
          {made ? 'Done' : 'Cancel'}
        </Button>
      </div>
      {made ? (
        <div className="k-text" data-zai-made>
          The account is there (<span className="mono">{made.dir}</span>). Put an employee on it in their settings — <b>Claude account → Z.AI</b>: their session then runs on Z.AI&apos;s models. Nobody is moved onto it or off it by the office itself.
        </div>
      ) : (
        <form
          className="k-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (token.trim()) void add();
          }}
        >
          <div className="k-text">
            Claude Code can run on Z.AI&apos;s GLM models instead of Anthropic&apos;s (their <b>GLM Coding Plan</b>). It needs an API key from{' '}
            <a href="https://z.ai/manage-apikey/apikey-list" target="_blank" rel="noopener noreferrer">
              z.ai → API keys
            </a>
            . The key is written into the account&apos;s folder on {host.name} and is not kept in the office.
          </div>
          <label className="field">
            <span className="field-label">API key</span>
            <input type="password" className="mono" value={token} onChange={(ev) => setToken(ev.target.value)} placeholder="Your Z.AI API key" spellCheck={false} autoComplete="off" aria-label="Z.AI API key" />
          </label>
          <More summary="Which models (Z.AI chooses when these are empty)">
            <div className="grid3" style={{ marginTop: 10 }}>
              {(['opus', 'sonnet', 'haiku'] as const).map((k) => (
                <label key={k} className="field">
                  <span className="field-label">Instead of {k}</span>
                  <input className="mono" value={models[k]} onChange={(ev) => setModels({ ...models, [k]: ev.target.value })} placeholder="a model's name at Z.AI" spellCheck={false} aria-label={`Model instead of ${k}`} />
                </label>
              ))}
            </div>
            <div className="k-sub" style={{ whiteSpace: 'normal', marginTop: 8 }}>
              An employee&apos;s model in the office is still called opus, sonnet or haiku; here you can say which of Z.AI&apos;s models each of those means (the names are in Z.AI&apos;s instructions for Claude Code).
            </div>
          </More>
          <div className="k-actions">
            <Button small variant="primary" type="submit" disabled={busy || !token.trim()}>
              Add the account
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Another account for a machine: a Claude subscription signed in to from here, or Z.AI with an API key. */
function AddAccount({ host, onClose }: { host: Host; onClose: () => void }) {
  const [kind, setKind] = useState<'claude' | 'zai' | null>(null);
  if (kind === 'claude') return <SignIn host={host} dir={null} fresh onClose={onClose} />;
  if (kind === 'zai') return <ZaiAccount host={host} onClose={onClose} />;
  return (
    <div className="k-sheet" data-add-account>
      <div className="k-sheet-head">
        <div className="k-title">Add an account to {host.name}</div>
        <Button small variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
      <div className="k-options">
        <button className="k-option" onClick={() => setKind('claude')} data-add-claude>
          <strong>A Claude account</strong>
          <span>A subscription with an allowance of its own (Pro, Max, Team). You sign in right here: open a link, sign in, paste the code. Nothing to do on the machine.</span>
        </button>
        <button className="k-option" onClick={() => setKind('zai')} data-add-zai>
          <strong>Z.AI — GLM Coding Plan</strong>
          <span>Claude Code running on Z.AI&apos;s models, with an API key from z.ai. For employees you choose to put on it.</span>
        </button>
      </div>
    </div>
  );
}
