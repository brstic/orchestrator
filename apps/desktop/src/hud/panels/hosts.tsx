import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AgentSession, Employee, Host } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Field, Window, timeAgo } from '@orchestrator/ui';
import { useAccess } from '../../lib/access.ts';
import { api, serverBase } from '../../lib/api.ts';
import { aboutLine, cpuMeter, memoryMeter, missingOn, onlineLine, systemLine } from '../../lib/machines.ts';
import { sessionOfEmployee, useOffice } from '../../lib/store.ts';
import { act, ask } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { Faces, Meter, More } from './kit.tsx';
import { OutsideTmux, SshForm, freeEmployeeName, linkActs, useSshLinks, type Link } from './ssh-links.tsx';
import { ConfirmBox, byName, copyText, fmtDateTime, isLive, onActivate, useTick, type PanelProps } from './company-shared.tsx';

/**
 * Machines (docs/UI.md is the look, docs/OPERATIONS.md what a machine is): one line per machine says what it is
 * and how it is; a click opens who works there, what it runs and what can be done with it. Adding one is the
 * window's one main button. Only an owner adds, renames, revokes and removes; whoever may work on a machine may
 * bring in what already runs there.
 */

/** One tmux pane as reported by the host agent's discovery. */
interface DiscoveredPane {
  tmuxSession: string;
  paneId: string;
  window?: number | string;
  command: string | null;
  cwd: string | null;
  size?: string;
  dead?: boolean;
  looksLikeClaude: boolean;
  connectedAs: string | null;
}

/** Employees a session can be given to: on the team and without a live session of their own. */
function useAssignable(): Employee[] {
  const employees = useOffice((s) => s.employees);
  const sessions = useOffice((s) => s.sessions);
  return useMemo(
    () =>
      Object.values(employees)
        .filter((e) => !e.archived && !isLive(sessionOfEmployee(sessions, e.id)))
        .sort(byName),
    [employees, sessions],
  );
}

const NEW_EMPLOYEE = '__new';

function EmployeeSelect({ value, onChange, employees, emptyLabel, withNew }: { value: string; onChange: (id: string) => void; employees: Employee[]; emptyLabel: string; withNew?: boolean }) {
  return (
    <select value={value} onChange={(ev) => onChange(ev.target.value)} style={{ width: 'auto', minWidth: 170, maxWidth: 260 }} aria-label="Employee">
      {withNew && <option value={NEW_EMPLOYEE}>A new employee, in that folder</option>}
      <option value="">{emptyLabel}</option>
      {employees.map((e) => (
        <option key={e.id} value={e.id}>
          {e.name} — {e.title}
        </option>
      ))}
    </select>
  );
}

/** What already runs on a machine — tmux sessions, and Claude Code outside tmux — and bringing it in. */
function Discover({ host, onClose }: { host: Host; onClose: () => void }) {
  const sessions = useOffice((s) => s.sessions);
  const employees = useOffice((s) => s.employees);
  const assignable = useAssignable();
  const [panes, setPanes] = useState<DiscoveredPane[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const scan = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ panes: DiscoveredPane[] }>('GET', `/hosts/${host.id}/discover`);
      setPanes(res.panes ?? []);
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  };
  useEffect(() => {
    void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.id]);

  const attach = async (p: DiscoveredPane) => {
    const key = `${p.tmuxSession}/${p.paneId}`;
    setBusy(key);
    let employeeId: string | null = (pick[key] ?? (p.looksLikeClaude ? NEW_EMPLOYEE : '')) || null;
    // "New employee": someone who lives in that pane's folder, named after it.
    if (employeeId === NEW_EMPLOYEE) {
      const created = await act(() => api<Employee>('POST', '/employees', { name: freeEmployeeName(p.cwd || p.tmuxSession, employees), roleKey: 'fullstack', hostId: host.id, workingDir: p.cwd || null, autonomy: 'auto' }));
      if (!created) return setBusy(null);
      employeeId = created.id;
    }
    const res = await act(
      () => api<AgentSession>('POST', '/sessions/attach', { hostId: host.id, tmuxSession: p.tmuxSession, tmuxPane: p.paneId, employeeId }),
      employeeId ? `Attached "${p.tmuxSession}" to ${useOffice.getState().employees[employeeId]?.name ?? 'the new employee'}` : `Attached "${p.tmuxSession}" — give it to an employee above`,
    );
    setBusy(null);
    if (res) void scan();
  };
  // A session with several panes says which pane each line is.
  const several = new Set((panes ?? []).filter((p, i, all) => all.findIndex((q) => q.tmuxSession === p.tmuxSession) !== i).map((p) => p.tmuxSession));

  /** One pane: what it is, and either who it already is in the office or whom to give it to. */
  const row = (p: DiscoveredPane) => {
        const key = `${p.tmuxSession}/${p.paneId}`;
        const connected = p.connectedAs ? sessions[p.connectedAs] : undefined;
        const owner = connected?.employeeId ? employees[connected.employeeId] : undefined;
        return (
          <div key={key} className="k-row k-row-sm">
            <div className="k-main">
              <div className="row" style={{ gap: 8 }}>
                <span className="k-mono strong">{p.tmuxSession}</span>
                {several.has(p.tmuxSession) && <span className="k-mono faint">{p.paneId}</span>}
                {p.dead ? (
                  <Badge tone="bad" title="The process in this pane has exited">
                    exited
                  </Badge>
                ) : p.looksLikeClaude ? (
                  <Badge tone="good" title="By the pane's command and title — you confirm by attaching">
                    Claude Code
                  </Badge>
                ) : null}
              </div>
              <div className="k-sub k-mono" title={[p.cwd, p.command && `runs ${p.command}`, `pane ${p.paneId}${p.size ? `, ${p.size}` : ''}`].filter(Boolean).join(' · ')}>
                {p.cwd ?? 'unknown folder'}
                {p.command && !p.looksLikeClaude ? ` · ${p.command}` : ''}
              </div>
            </div>
            {p.connectedAs ? (
              <>
                <span className="k-sub" title="This pane is already tracked by the office">
                  {owner ? `Already here as ${owner.name}` : connected ? 'Already here, without an employee' : 'Already here'}
                </span>
                {connected?.origin === 'attached' && connected.status === 'running' && owner && (
                  <Button
                    small
                    disabled={busy === key}
                    title="An attached session is terminal-only: you can watch it and type, but it cannot receive tasks, ask you questions or report what it does. This restarts Claude Code there under the office, continuing the same conversation."
                    onClick={async () => {
                      if (!(await ask({ title: `Make ${owner.name} a full employee?`, body: `Claude Code in "${p.tmuxSession}" is asked to exit and is started again by the office in ${p.cwd ?? 'the same folder'}, continuing the same conversation. After that it can take tasks, ask you questions and report its work.\n\nIf it is in the middle of something it will not exit, and nothing changes.`, ok: 'Restart under the office' }))) return;
                      setBusy(key);
                      await act(() => api('POST', `/sessions/${connected.id}/adopt`, {}), `${owner.name} now runs under the office, continuing the same conversation`);
                      setBusy(null);
                      void scan();
                    }}
                  >
                    Make a full employee
                  </Button>
                )}
              </>
            ) : (
              <>
                <EmployeeSelect value={pick[key] ?? (p.looksLikeClaude ? NEW_EMPLOYEE : '')} onChange={(id) => setPick({ ...pick, [key]: id })} employees={assignable} emptyLabel="No employee yet" withNew />
                <Button small variant="primary" disabled={busy === key || !!p.dead} onClick={() => attach(p)}>
                  Attach
                </Button>
              </>
            )}
          </div>
        );
  };
  // What can still be done something with comes first: a pane the office does not have, or one it only watches.
  const actionable = (p: DiscoveredPane) => {
    const connected = p.connectedAs ? sessions[p.connectedAs] : undefined;
    return !p.connectedAs || (connected?.origin === 'attached' && connected.status === 'running' && !!connected.employeeId);
  };
  const fresh = (panes ?? []).filter(actionable);
  const here = (panes ?? []).filter((p) => !actionable(p));

  return (
    <div className="k-section" style={{ gap: 12 }} data-discover>
      <div className="k-actions">
        <div className="k-label">Already running on {host.name}</div>
        <span className="grow" />
        <Button small variant="ghost" className="k-quiet" onClick={scan} disabled={loading}>
          {loading ? 'Looking…' : 'Look again'}
        </Button>
        <Button small variant="ghost" className="k-quiet" onClick={onClose}>
          Hide
        </Button>
      </div>
      <div className="k-text">Attaching restarts nothing and types nothing: you can watch the session and take its keyboard. To give it tasks and hear its questions, make it a full employee afterwards.</div>
      <More summary="What an attached session cannot do">
        <div className="k-text">
          A session without Orchestrator's hooks is terminal-only: its activity shows as UNKNOWN, and questions, approvals and token usage are not available. To add the hooks to sessions started in a project, run{' '}
          <span className="k-mono">orchestrator-agent hooks install --project &lt;dir&gt;</span> on that machine.
        </div>
      </More>
      {error && <div className="small bad">Could not look: {error}</div>}
      {panes && fresh.length === 0 && <div className="k-sub">{panes.length === 0 ? 'No tmux sessions are running there.' : 'Every tmux session there is in the office already.'}</div>}
      {fresh.length > 0 && <div className="k-group">{fresh.map(row)}</div>}
      {here.length > 0 && (
        <More summary={`${here.length} already in the office`}>
          <div className="k-group">{here.map(row)}</div>
        </More>
      )}
      {panes && <OutsideTmux key={panes.length} host={host} />}
    </div>
  );
}

/** One fact about a machine: a small name over it. */
function Fact({ name, title, children }: { name: string; title?: string; children: ReactNode }) {
  return (
    <div title={title}>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** One machine: a line that says what it is and how it is, opening to who works there and what can be done with it. */
function Machine({ host, link, reload, startOpen }: { host: Host; link: Link | null; reload: () => Promise<void>; startOpen: boolean }) {
  const can = useAccess();
  const [open, setOpen] = useState(startOpen);
  const sessions = useOffice((s) => s.sessions);
  const employees = useOffice((s) => s.employees);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(host.name);
  const [confirm, setConfirm] = useState<'revoke' | 'remove' | null>(null);
  const [busy, setBusy] = useState(false);
  /** Null until asked for; a new number looks again from the start. */
  const [discover, setDiscover] = useState<number | null>(null);
  const staff = Object.values(employees)
    .filter((e) => e.hostId === host.id && !e.archived)
    .sort(byName);
  const running = Object.values(sessions).filter((x) => x.hostId === host.id && x.status === 'running').length;
  const unobservable = Object.values(sessions).filter((x) => x.hostId === host.id && x.status === 'host_offline').length;
  const info = host.info;
  const online = host.status === 'online';
  const revoked = host.status === 'revoked';
  const working = link?.status === 'connecting' || link?.status === 'reconnecting';
  const cpu = online ? cpuMeter(host.resources) : null;
  const memory = online ? memoryMeter(host.resources) : null;
  const measured = host.resources ? `Measured on the machine, ${timeAgo(host.resources.ts)}` : undefined;
  const problems = [...(online ? missingOn(info) : []), ...(link?.error ? [link.error] : [])];
  const system = systemLine(info);

  const rename = async () => {
    const next = name.trim();
    if (!next || next === host.name) return setRenaming(false);
    const res = await act(() => api<Host>('PATCH', `/hosts/${host.id}`, { name: next }), 'Machine renamed');
    if (res) setRenaming(false);
  };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    await act(fn, ok);
    setBusy(false);
    setConfirm(null);
  };
  const toggle = () => setOpen((o) => !o);

  return (
    <div data-machine={host.id}>
      <div className="k-row k-row-click" role="button" tabIndex={0} aria-expanded={open} aria-label={`${host.name}: ${open ? 'hide' : 'show'} details`} onClick={toggle} onKeyDown={(ev) => ev.target === ev.currentTarget && onActivate(toggle)(ev)}>
        <span className={`k-dot ${online ? '' : working ? 'k-dot-busy' : link?.status === 'error' ? 'k-dot-bad' : 'k-dot-off'}`} title={host.status} />
        <div className={`k-main ${revoked ? 'k-dim' : ''}`}>
          <div className="k-title">{host.name}</div>
          <div className="k-sub">{aboutLine(host, link, staff.length, (iso) => timeAgo(iso))}</div>
          {problems.map((p) => (
            <div key={p} className={`small ${link?.error === p ? 'k-bad' : 'k-warn'}`} style={{ whiteSpace: 'normal' }}>
              {p}
            </div>
          ))}
        </div>
        <Faces people={staff} />
        {cpu && <Meter label="CPU" meter={cpu} title={measured} />}
        {memory && <Meter label="Memory" meter={memory} title={measured} />}
        {can.owner && link && !working && link.status !== 'connected' && (
          <Button
            small
            onClick={(ev) => {
              ev.stopPropagation();
              linkActs.connect(link, reload);
            }}
          >
            {link.status === 'error' ? 'Try again' : 'Reconnect'}
          </Button>
        )}
        <span className="k-chev" aria-hidden />
      </div>

      {open && (
        <div className="k-detail">
          {confirm === 'revoke' && (
            <ConfirmBox title={`Revoke ${host.name}?`} confirmLabel="Revoke machine" busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => run(() => api('POST', `/hosts/${host.id}/revoke`, {}), `${host.name} was revoked`)}>
              Its credential stops working at once and its agent is disconnected. The tmux sessions on the machine keep running — nothing is killed — but the office can no longer see or control them
              {running ? ` (${running} running right now)` : ''}. To bring the machine back you enroll it again with a new token.
            </ConfirmBox>
          )}
          {confirm === 'remove' && (
            <ConfirmBox title={`Remove ${host.name} from the office?`} confirmLabel="Remove machine" busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => run(() => api('DELETE', `/hosts/${host.id}`), `${host.name} was removed`)}>
              The machine and the session records kept for it are deleted from the office. Nothing on the machine itself is touched.
              {staff.length > 0 && ` ${staff.length} employee${staff.length === 1 ? ' is' : 's are'} still assigned to it; the server refuses until they are moved or archived.`}
              {host.status === 'offline' && ' Its credential stays valid until you revoke it, so revoke first if the machine should not be able to reconnect.'}
            </ConfirmBox>
          )}

          {(staff.length > 0 || online) && (
            <div className="k-section">
              <div className="k-label">Works here</div>
              {staff.length === 0 ? (
                <div className="k-sub">Nobody yet.</div>
              ) : (
                <div className="k-chips">
                  {staff.map((e) => (
                    <button key={e.id} className="k-chip" onClick={() => useOffice.getState().openPanel('employee', `${e.id}:session`)} title={`${e.name} — ${e.title}`}>
                      <Avatar appearance={e.appearance} size={20} offline={!isLive(sessionOfEmployee(sessions, e.id))} />
                      {e.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <dl className="k-spec">
            {/* A machine that has never connected has reported nothing about itself: there is nothing to list. */}
            {system && <Fact name="System">{system}</Fact>}
            {info?.hostname && (
              <Fact name="Address">
                <span className="k-mono">
                  {info.user ? `${info.user}@` : ''}
                  {info.hostname}
                </span>
              </Fact>
            )}
            {system && (
              <>
                <Fact name="Claude Code">{info!.claudeVersion ? <span className="k-mono">{info!.claudeVersion}</span> : <span className="k-warn">not found</span>}</Fact>
                <Fact name="tmux">{info!.tmuxVersion ? <span className="k-mono">{info!.tmuxVersion}</span> : <span className="k-warn">not found</span>}</Fact>
                <Fact name="Agent">
                  <span className="k-mono">{info!.agentVersion}</span>
                </Fact>
                {info!.runtimes && (
                  <Fact name="SDK-managed workers" title={info!.runtimes.includes('managed_sdk') ? 'The Claude Agent SDK is installed on this machine: employees can be driven through it' : 'Install it on that machine with: orchestrator-agent sdk install (then restart the agent)'}>
                    {info!.runtimes.includes('managed_sdk') ? 'available' : <span className="muted">not installed</span>}
                  </Fact>
                )}
                {info!.runtimes && (
                  <Fact name="Codex-managed workers" title="The machine reports this runtime when its host agent can find the Codex CLI.">
                    {info!.runtimes.includes('codex_managed') ? 'available' : <span className="muted">unavailable</span>}
                  </Fact>
                )}
                <Fact name="Browser for employees" title="A browser of their own to look at what they build (Settings → Employees)">
                  {info!.browser ? info!.browser.engine : <span className="muted">not installed</span>}
                </Fact>
              </>
            )}
            {(online || running > 0 || unobservable > 0) && (
              <Fact name="Sessions">{online ? <><span className="k-num">{running}</span> running</> : `${unobservable + running} out of sight while it is offline`}</Fact>
            )}
            {!online && host.lastSeenAt && <Fact name="Last seen">{fmtDateTime(host.lastSeenAt)}</Fact>}
            <Fact name="Added">
              {fmtDateTime(host.enrolledAt)}
              {host.revokedAt ? ` · revoked ${fmtDateTime(host.revokedAt)}` : ''}
            </Fact>
          </dl>

          {renaming ? (
            <form
              className="k-actions"
              onSubmit={(ev) => {
                ev.preventDefault();
                void rename();
              }}
            >
              <input value={name} onChange={(ev) => setName(ev.target.value)} autoFocus style={{ width: 240 }} aria-label="Machine name" />
              <Button small variant="primary" type="submit" disabled={!name.trim()}>
                Save
              </Button>
              <Button small variant="ghost" type="button" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            (can.owner || (online && can.work(host.id))) && (
              <div className="k-actions">
                {online && can.work(host.id) && (
                  <Button small onClick={() => setDiscover((n) => (n ?? 0) + 1)} title={`Lists the tmux sessions and the Claude Code processes on ${host.name}. Nothing is changed until you attach one.`}>
                    Bring in what is running there…
                  </Button>
                )}
                <span className="grow" />
                {can.owner && !revoked && (
                  <Button
                    small
                    variant="ghost"
                    className="k-quiet"
                    onClick={() => {
                      setName(host.name);
                      setRenaming(true);
                    }}
                  >
                    Rename
                  </Button>
                )}
                {can.owner && link && (link.status === 'connected' || working) && (
                  <Button small variant="ghost" className="k-quiet" onClick={() => linkActs.disconnect(link, reload)} title="Close the tunnel. The agent and the sessions keep running on the server and reappear when you connect again.">
                    Disconnect
                  </Button>
                )}
                {can.owner && link && (
                  <Button small variant="ghost" className="k-quiet" onClick={() => linkActs.remove(link, reload)} title="Stop the agent on the server, delete what was installed for this link, and revoke the machine. tmux sessions on the server are left alone.">
                    Remove the link…
                  </Button>
                )}
                {can.owner && !link && !revoked && (
                  <Button small variant="ghost" className="k-quiet" onClick={() => setConfirm('revoke')} title="This machine can no longer connect to the office">
                    Revoke…
                  </Button>
                )}
                {can.owner && !link && !online && (
                  <Button small variant="ghost" className="k-quiet" onClick={() => setConfirm('remove')}>
                    Remove…
                  </Button>
                )}
              </div>
            )
          )}

          {online && discover !== null && <Discover key={discover} host={host} onClose={() => setDiscover(null)} />}
        </div>
      )}
    </div>
  );
}

/** A server that is being linked, or could not be: there is no machine in the office for it yet. */
function Linking({ link, reload }: { link: Link; reload: () => Promise<void> }) {
  const working = link.status === 'connecting' || link.status === 'reconnecting';
  return (
    <div className="k-row" data-link={link.id}>
      <span className={`k-dot ${working ? 'k-dot-busy' : link.status === 'error' ? 'k-dot-bad' : 'k-dot-off'}`} />
      <div className="k-main">
        <div className="k-title">{link.name}</div>
        <div className="k-sub">
          Over SSH · {link.target} · {working ? `${link.status}${link.step ? ` — ${link.step}` : ''}…` : link.status === 'error' ? 'could not connect' : 'not connected'}
        </div>
        {link.error && (
          <div className="small k-bad" style={{ whiteSpace: 'normal' }}>
            {link.error}
          </div>
        )}
      </div>
      {!working && <Button small onClick={() => linkActs.connect(link, reload)}>{link.status === 'error' ? 'Try again' : 'Connect'}</Button>}
      <Button small variant="ghost" className="k-quiet" onClick={() => linkActs.remove(link, reload)}>
        Remove…
      </Button>
    </div>
  );
}

/** Sessions that belong to nobody yet: each is given to an employee, to be seen at a desk. */
function UnboundSessions() {
  const sessions = useOffice((s) => s.sessions);
  const hosts = useOffice((s) => s.hosts);
  const can = useAccess();
  const assignable = useAssignable();
  const [pick, setPick] = useState<Record<string, string>>({});
  const unbound = Object.values(sessions)
    .filter((x) => x.employeeId === null && (x.status === 'running' || x.status === 'starting' || x.status === 'host_offline'))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  if (unbound.length === 0) return null;
  return (
    <div className="k-section">
      <div className="k-label">
        {unbound.length === 1 ? 'A session' : `${unbound.length} sessions`} without an employee
      </div>
      <div className="k-group k-notice">
        {unbound.map((x) => (
          <div key={x.id} className="k-row k-row-sm">
            <div className="k-main">
              <div className="k-mono strong">{x.tmuxSession}</div>
              <div className="k-sub" title={x.cwd}>
                {x.origin === 'managed' ? 'Started by the office' : 'Attached'} on {hosts[x.hostId]?.name ?? 'an unknown machine'}
                {x.status === 'host_offline' ? ', which is offline' : ''} · <span className="k-mono">{x.cwd}</span>
              </div>
            </div>
            {can.work(x.hostId) && (
              <>
                <EmployeeSelect value={pick[x.id] ?? ''} onChange={(id) => setPick({ ...pick, [x.id]: id })} employees={assignable} emptyLabel="Choose an employee…" />
                <Button small variant="primary" disabled={!pick[x.id]} onClick={() => act(() => api('POST', `/sessions/${x.id}/bind`, { employeeId: pick[x.id] }), 'Session bound')}>
                  Bind
                </Button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const TTL_CHOICES = [
  { minutes: 15, label: '15 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 24 * 60, label: '24 hours' },
];

function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  } catch {
    return false;
  }
}

/** Any machine at all: it runs the office's small agent, which connects out to here with a one-time token. */
function TokenForm() {
  const [label, setLabel] = useState('');
  const [ttl, setTtl] = useState(60);
  const [url, setUrl] = useState(() => (serverBase || window.location.origin).replace(/\/+$/, ''));
  const [issued, setIssued] = useState<{ token: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useTick(issued ? 15_000 : 3_600_000);
  const create = async () => {
    setBusy(true);
    const res = await act(() => api<{ token: string; expiresAt: string }>('POST', '/hosts/enroll-token', { label: label.trim() || 'host', ttlMinutes: ttl }));
    setBusy(false);
    if (res) setIssued(res);
  };
  const server = url.trim().replace(/\/+$/, '') || '<server-url>';
  const connect = 'orchestrator-agent connect';
  const expired = !!issued && Date.parse(issued.expiresAt) <= Date.now();
  const loopback = isLoopbackUrl(server);
  const insecure = /^http:\/\//i.test(server) && !loopback;
  return (
    <div className="k-form">
      <div className="k-text">For a machine the office cannot reach over SSH. You run a small agent on it, and it connects out to this office; nothing is opened on the machine.</div>
      {/* The address is in sight whenever it would not work from another machine. */}
      <More summary="Options" startOpen={loopback || insecure}>
        <div className="grid3">
          <Field label="Office address, as that machine sees it">
            <input value={url} onChange={(ev) => setUrl(ev.target.value)} className="mono" spellCheck={false} />
          </Field>
          <Field label="Token valid for">
            <select value={ttl} onChange={(ev) => setTtl(Number(ev.target.value))}>
              {TTL_CHOICES.map((c) => (
                <option key={c.minutes} value={c.minutes}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Label, for the audit log">
            <input value={label} onChange={(ev) => setLabel(ev.target.value)} placeholder="e.g. build-server" />
          </Field>
        </div>
      </More>
      {loopback && <div className="k-note">This address only works for an agent on the same machine as the office. For another machine, give the address the office is reachable at from there.</div>}
      {insecure && <div className="k-note">This address is plain http. A remote machine needs the office reachable over https: the server refuses to listen on a non-loopback address without it, unless TLS ends at a reverse proxy in front of it.</div>}
      {issued && !expired && (
        <div className="k-section">
          <div className="k-label">Run on that machine</div>
          <div className="k-code">
            orchestrator-agent login --server {server} --token <span>{issued.token}</span>
            {'\n'}
            {connect}
            <Button small onClick={() => copyText(`orchestrator-agent login --server ${server} --token ${issued.token}\n${connect}`, 'Commands copied')}>
              Copy
            </Button>
          </div>
          <div className="k-text">
            The token is shown only now and works once, until {fmtDateTime(issued.expiresAt)}. The second line keeps the agent in that terminal; to keep the machine connected for good, run <span className="k-mono">orchestrator-agent service install</span> instead.
          </div>
        </div>
      )}
      {issued && expired && <div className="k-note">That token has expired. Create a new one.</div>}
      <div className="k-actions">
        <Button variant={issued && !expired ? 'default' : 'primary'} onClick={create} disabled={busy}>
          {issued ? 'Create another token' : 'Create a token'}
        </Button>
      </div>
    </div>
  );
}

/** Adding a machine: first which way, then that way's few questions. */
function AddMachine({ onClose, onLinked }: { onClose: () => void; onLinked: () => void }) {
  const [way, setWay] = useState<'ssh' | 'token' | null>(null);
  return (
    <div className="k-sheet" data-add-machine>
      <div className="k-sheet-head">
        <div className="k-title">{way === 'ssh' ? 'A server over SSH' : way === 'token' ? 'Any machine, with a token' : 'Add a machine'}</div>
        {way && (
          <Button small variant="ghost" className="k-quiet" onClick={() => setWay(null)}>
            Back
          </Button>
        )}
        <Button small variant="ghost" className="k-quiet" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {way === null && (
        <div className="k-options">
          <button className="k-option" onClick={() => setWay('ssh')}>
            <strong>A server over SSH</strong>
            <span>A server you can already ssh into. The office sets itself up there with your keys.</span>
          </button>
          <button className="k-option" onClick={() => setWay('token')}>
            <strong>Any machine, with a token</strong>
            <span>You run a small agent on it, and it connects out to this office.</span>
          </button>
        </div>
      )}
      {way === 'ssh' && <SshForm onDone={onLinked} />}
      {way === 'token' && <TokenForm />}
    </div>
  );
}

function HostsPanel({ onClose }: PanelProps) {
  const can = useAccess();
  const hostsById = useOffice((s) => s.hosts);
  const { links, reload } = useSshLinks(can.owner);
  const [adding, setAdding] = useState(false);
  const hosts = useMemo(() => Object.values(hostsById).sort((a, b) => a.enrolledAt.localeCompare(b.enrolledAt) || a.id.localeCompare(b.id)), [hostsById]);
  const active = hosts.filter((h) => h.status !== 'revoked');
  const gone = hosts.filter((h) => h.status === 'revoked');
  const linkOf = (h: Host): Link | null => links.find((l) => l.hostId === h.id) ?? null;
  // A link that has no machine in the office yet (it is being set up, or never got that far) has a line of its own.
  const linking = links.filter((l) => !l.hostId || !hostsById[l.hostId]);
  const nothing = active.length === 0 && linking.length === 0;
  return (
    <Window
      kit
      title="Machines"
      subtitle={onlineLine(hosts)}
      onClose={onClose}
      width={900}
      actions={
        can.owner && !adding && !nothing ? (
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add a machine
          </Button>
        ) : undefined
      }
    >
      <div className="k-stack">
        {adding && (
          <AddMachine
            onClose={() => setAdding(false)}
            onLinked={() => {
              setAdding(false);
              void reload();
            }}
          />
        )}
        <UnboundSessions />
        {nothing && !adding && (
          <div className="k-empty">
            <div className="k-title">No machines yet</div>
            <div className="k-text">{can.owner ? 'Add the machine your Claude Code sessions run on, and the office comes to life.' : 'An owner of the office adds the machines employees work on.'}</div>
            {can.owner && (
              <Button variant="primary" onClick={() => setAdding(true)}>
                Add a machine
              </Button>
            )}
          </div>
        )}
        {!nothing && (
          <div className="k-group">
            {active.map((h) => (
              <Machine key={h.id} host={h} link={linkOf(h)} reload={reload} startOpen={active.length === 1 && h.status === 'online'} />
            ))}
            {linking.map((l) => (
              <Linking key={l.id} link={l} reload={reload} />
            ))}
          </div>
        )}
        {gone.length > 0 && (
          <More summary={`${gone.length} revoked machine${gone.length === 1 ? '' : 's'}`}>
            <div className="k-group">
              {gone.map((h) => (
                <Machine key={h.id} host={h} link={null} reload={reload} startOpen={false} />
              ))}
            </div>
          </More>
        )}
      </div>
    </Window>
  );
}
registerPanel('hosts', HostsPanel);
