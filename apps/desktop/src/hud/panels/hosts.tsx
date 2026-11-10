import { useMemo, useState } from 'react';
import type { AgentSession, Employee, Host } from '@orchestrator/contracts';
import { Badge, Button, Empty, Field, Progress, Provenance, Window, timeAgo, type Tone } from '@orchestrator/ui';
import { api, serverBase } from '../../lib/api.ts';
import { sessionOfEmployee, useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { OutsideTmux, SshLinks, freeEmployeeName } from './ssh-links.tsx';
import { CapabilityBadges, ConfirmBox, byName, copyText, fmtBytes, fmtDateTime, hostDotClass, isLive, useTick, type PanelProps } from './company-shared.tsx';

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

function statusTone(status: Host['status']): Tone {
  return status === 'online' ? 'good' : status === 'offline' ? 'bad' : 'muted';
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
    <select value={value} onChange={(ev) => onChange(ev.target.value)} style={{ width: 'auto', minWidth: 170 }} aria-label="Employee">
      {withNew && <option value={NEW_EMPLOYEE}>A new employee (lives in that folder)</option>}
      <option value="">{emptyLabel}</option>
      {employees.map((e) => (
        <option key={e.id} value={e.id}>
          {e.name} — {e.title}
        </option>
      ))}
    </select>
  );
}

function Resources({ host }: { host: Host }) {
  const r = host.status === 'online' ? host.resources : null;
  if (!r) {
    return <div className="small muted">No data — {host.status === 'online' ? 'the machine has not reported a measurement yet.' : `the machine is ${host.status}, so nothing is being measured.`}</div>;
  }
  const memPct = r.memUsedBytes != null && r.memTotalBytes ? (r.memUsedBytes / r.memTotalBytes) * 100 : null;
  return (
    <div className="col" style={{ gap: 5 }}>
      <div className="pc-meter">
        <span className="muted">CPU</span>
        {r.cpuPercent != null ? <Progress value={r.cpuPercent} tone={r.cpuPercent > 90 ? 'bad' : r.cpuPercent > 70 ? 'warn' : 'info'} /> : <span className="muted">not available</span>}
        <span className="mono">{r.cpuPercent != null ? `${Math.round(r.cpuPercent)}%` : '—'}</span>
      </div>
      <div className="pc-meter">
        <span className="muted">Memory</span>
        {memPct != null ? <Progress value={memPct} tone={memPct > 92 ? 'bad' : memPct > 80 ? 'warn' : 'info'} /> : <span className="muted">not available</span>}
        <span className="mono">{memPct != null ? `${fmtBytes(r.memUsedBytes!)} / ${fmtBytes(r.memTotalBytes!)}` : '—'}</span>
      </div>
      <div className="row row-wrap small" style={{ gap: 10 }}>
        <span>
          <span className="muted">Load (1 min)</span> <span className="mono">{r.loadAvg1 != null ? r.loadAvg1.toFixed(2) : 'not available'}</span>
        </span>
        <span>
          <span className="muted">Tracked sessions</span> <span className="mono">{r.sessionCount}</span>
        </span>
        <Provenance kind="measured" />
        <span className="faint">on the machine, {timeAgo(r.ts)}</span>
      </div>
    </div>
  );
}

function Discover({ host, onClose }: { host: Host; onClose: () => void }) {
  const sessions = useOffice((s) => s.sessions);
  const employees = useOffice((s) => s.employees);
  const assignable = useAssignable();
  const [panes, setPanes] = useState<DiscoveredPane[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [started, setStarted] = useState(false);

  const scan = async () => {
    setStarted(true);
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
      employeeId ? `Attached "${p.tmuxSession}" to ${useOffice.getState().employees[employeeId]?.name ?? 'the new employee'}` : `Attached "${p.tmuxSession}" — bind it to an employee below`,
    );
    setBusy(null);
    if (res) void scan();
  };

  if (!started) {
    return (
      <div className="row row-wrap">
        <Button small onClick={scan}>
          Bring in what is running there…
        </Button>
        <span className="small faint">Lists the tmux panes and the Claude Code processes on {host.name}. Nothing is changed until you attach one.</span>
      </div>
    );
  }
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row">
        <div className="section-title" style={{ margin: 0 }}>
          tmux panes on {host.name}
        </div>
        <span className="grow" />
        <Button small onClick={scan} disabled={loading}>
          {loading ? 'Scanning…' : 'Rescan'}
        </Button>
        <Button small variant="ghost" onClick={onClose}>
          Hide
        </Button>
      </div>
      <div className="pc-info">
        Attaching is non-destructive: the process is not restarted and nothing is typed into it. An attached session that has no Orchestrator hooks is terminal-only — you can watch it and take the keyboard, but its activity is shown as UNKNOWN, and
        questions, approvals and token usage are not available. To add hooks to sessions started in a project, run <span className="mono">orchestrator-agent hooks install --project &lt;dir&gt;</span> on that machine.
      </div>
      {error && (
        <div className="row">
          <Badge tone="bad">Discovery failed</Badge>
          <span className="small muted">{error}</span>
        </div>
      )}
      {panes && panes.length === 0 && <div className="small muted">No tmux panes are running on this machine.</div>}
      {panes && panes.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>tmux session</th>
              <th>Pane</th>
              <th>Command</th>
              <th>Working directory</th>
              <th>Detected</th>
              <th>Attach to</th>
            </tr>
          </thead>
          <tbody>
            {panes.map((p) => {
              const key = `${p.tmuxSession}/${p.paneId}`;
              const connected = p.connectedAs ? sessions[p.connectedAs] : undefined;
              const owner = connected?.employeeId ? employees[connected.employeeId] : undefined;
              return (
                <tr key={key}>
                  <td className="mono">{p.tmuxSession}</td>
                  <td className="mono pc-nowrap">
                    {p.paneId}
                    {p.size ? <span className="faint"> {p.size}</span> : null}
                  </td>
                  <td className="mono">{p.command ?? '—'}</td>
                  <td className="mono small" style={{ wordBreak: 'break-all' }}>
                    {p.cwd ?? '—'}
                  </td>
                  <td>
                    {p.dead ? (
                      <Badge tone="bad" title="The process in this pane has exited">
                        dead pane
                      </Badge>
                    ) : p.looksLikeClaude ? (
                      <Badge tone="good" title="A heuristic on the pane's command and title — you confirm by attaching">
                        looks like Claude Code
                      </Badge>
                    ) : (
                      <Badge tone="muted" title="Nothing about this pane suggests Claude Code is running in it">
                        not recognised
                      </Badge>
                    )}
                  </td>
                  <td className="pc-nowrap">
                    {p.connectedAs ? (
                      <span className="row">
                        <Badge tone="info" title="This pane is already tracked by the office">
                          already connected{owner ? ` · ${owner.name}` : connected ? ' · unbound' : ''}
                        </Badge>
                        {connected?.origin === 'attached' && connected.status === 'running' && owner && (
                          <Button
                            small
                            disabled={busy === key}
                            title="An attached session is terminal-only: you can watch it and type, but it cannot receive tasks, ask you questions or report what it does. This restarts Claude Code there under the office, continuing the same conversation."
                            onClick={async () => {
                              if (!window.confirm(`Make ${owner.name} a full employee?\n\nClaude Code in "${p.tmuxSession}" is asked to exit (/exit), and is started again by the office in ${p.cwd ?? 'the same folder'}, continuing the same conversation — now able to take tasks, ask you questions and report its work.\n\nIf it is in the middle of something it will not exit, and nothing changes.`)) return;
                              setBusy(key);
                              await act(() => api('POST', `/sessions/${connected.id}/adopt`, {}), `${owner.name} now runs under the office, continuing the same conversation`);
                              setBusy(null);
                              void scan();
                            }}
                          >
                            Make a full employee
                          </Button>
                        )}
                      </span>
                    ) : (
                      <span className="row">
                        <EmployeeSelect value={pick[key] ?? (p.looksLikeClaude ? NEW_EMPLOYEE : '')} onChange={(id) => setPick({ ...pick, [key]: id })} employees={assignable} emptyLabel="No employee yet" withNew />
                        <Button small variant="primary" disabled={busy === key || !!p.dead} onClick={() => attach(p)}>
                          Attach
                        </Button>
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {panes && <OutsideTmux key={panes.length} host={host} />}
    </div>
  );
}

function HostCard({ host }: { host: Host }) {
  const sessions = useOffice((s) => s.sessions);
  const employees = useOffice((s) => s.employees);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(host.name);
  const [confirm, setConfirm] = useState<'revoke' | 'remove' | null>(null);
  const [busy, setBusy] = useState(false);
  const [discover, setDiscover] = useState(0);
  const staff = Object.values(employees)
    .filter((e) => e.hostId === host.id && !e.archived)
    .sort(byName);
  const running = Object.values(sessions).filter((x) => x.hostId === host.id && x.status === 'running').length;
  const unobservable = Object.values(sessions).filter((x) => x.hostId === host.id && x.status === 'host_offline').length;
  const info = host.info;
  const st = useOffice.getState();

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

  return (
    <div className={`card col ${host.status === 'revoked' ? 'pc-dim' : ''}`} style={{ gap: 10 }}>
      <div className="row row-wrap">
        <span className={hostDotClass(host)} />
        {renaming ? (
          <form
            className="row"
            onSubmit={(ev) => {
              ev.preventDefault();
              void rename();
            }}
          >
            <input value={name} onChange={(ev) => setName(ev.target.value)} autoFocus style={{ width: 220 }} aria-label="Machine name" />
            <Button small variant="primary" type="submit" disabled={!name.trim()}>
              Save
            </Button>
            <Button small variant="ghost" type="button" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <span className="strong" style={{ fontSize: 15 }}>
            {host.name}
          </span>
        )}
        <Badge tone={statusTone(host.status)}>{host.status}</Badge>
        {host.local && <Badge tone="muted" title="The machine the Orchestrator server itself runs on">this server's machine</Badge>}
        <span className="grow" />
        {!renaming && host.status !== 'revoked' && (
          <Button
            small
            variant="ghost"
            onClick={() => {
              setName(host.name);
              setRenaming(true);
            }}
          >
            Rename
          </Button>
        )}
        {host.status !== 'revoked' && (
          <Button small variant="danger" onClick={() => setConfirm('revoke')}>
            Revoke…
          </Button>
        )}
        {host.status !== 'online' && (
          <Button small onClick={() => setConfirm('remove')}>
            Remove…
          </Button>
        )}
      </div>

      {confirm === 'revoke' && (
        <ConfirmBox title={`Revoke ${host.name}?`} confirmLabel="Revoke machine" busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => run(() => api('POST', `/hosts/${host.id}/revoke`, {}), `${host.name} was revoked`)}>
          Its credential stops working immediately and its agent is disconnected. The tmux sessions on the machine keep running — nothing is killed — but the office can no longer observe or control them
          {running ? ` (${running} running session${running === 1 ? '' : 's'} right now)` : ''}. To bring the machine back you have to enroll it again with a new token.
        </ConfirmBox>
      )}
      {confirm === 'remove' && (
        <ConfirmBox title={`Remove ${host.name} from the office?`} confirmLabel="Remove machine" busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => run(() => api('DELETE', `/hosts/${host.id}`), `${host.name} was removed`)}>
          The machine and the session records kept for it are deleted from the office. Nothing on the machine itself is touched.
          {staff.length > 0 && ` ${staff.length} employee${staff.length === 1 ? ' is' : 's are'} still assigned to it; the server refuses until they are moved or archived.`}
          {host.status === 'offline' && ' Its credential stays valid until you revoke it, so revoke first if the machine should not be able to reconnect.'}
        </ConfirmBox>
      )}

      <div className="grid2">
        <dl className="kv small">
          <dt>System</dt>
          <dd>{info ? `${info.platform} / ${info.arch} · ${info.cpus} CPUs · ${fmtBytes(info.totalMemBytes)} RAM` : <span className="muted">not reported</span>}</dd>
          <dt>Hostname</dt>
          <dd className="mono">{info ? `${info.user}@${info.hostname}` : '—'}</dd>
          <dt>Claude Code</dt>
          <dd>{!info ? '—' : info.claudeVersion ? <span className="mono">{info.claudeVersion}</span> : <Badge tone="warn" title="The agent could not find the claude binary on this machine">not found</Badge>}</dd>
          <dt>tmux</dt>
          <dd>{!info ? '—' : info.tmuxVersion ? <span className="mono">{info.tmuxVersion}</span> : <Badge tone="warn" title="The agent could not find tmux on this machine">not found</Badge>}</dd>
          <dt>Worker runtimes</dt>
          <dd>
            {!info?.runtimes ? (
              <span className="muted">not reported</span>
            ) : (
              <span className="row row-wrap">
                <Badge tone="good" title="The real Claude Code terminal UI in tmux">interactive CLI</Badge>
                {info.runtimes.includes('managed_sdk') ? (
                  <Badge tone="good" title="The Claude Agent SDK is installed on this machine: employees can be driven through it">SDK-managed</Badge>
                ) : (
                  <span className="small muted" title="Install it on that machine with: orchestrator-agent sdk install (then restart the agent)">
                    SDK-managed: not installed
                  </span>
                )}
              </span>
            )}
          </dd>
          <dt>Agent</dt>
          <dd className="mono">{info?.agentVersion ?? '—'}</dd>
          <dt>Last seen</dt>
          <dd title={host.lastSeenAt ?? undefined}>{host.status === 'online' ? `connected · ${timeAgo(host.lastSeenAt)}` : host.lastSeenAt ? timeAgo(host.lastSeenAt) : 'never connected'}</dd>
          <dt>Enrolled</dt>
          <dd>
            {fmtDateTime(host.enrolledAt)}
            {host.revokedAt ? ` · revoked ${fmtDateTime(host.revokedAt)}` : ''}
          </dd>
        </dl>
        <div className="col" style={{ gap: 8 }}>
          <Resources host={host} />
          <div className="small">
            <span className="muted">Sessions</span> {running} running{unobservable ? `, ${unobservable} not observable while the machine is offline` : ''}
          </div>
          <div className="row row-wrap small" style={{ gap: 4 }}>
            <span className="muted">Employees</span>
            {staff.length === 0 && <span className="faint">none</span>}
            {staff.map((e) => (
              <button key={e.id} className="btn btn-ghost btn-sm" onClick={() => st.openPanel('employee', `${e.id}:session`)}>
                {e.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {host.status === 'online' && <Discover key={discover} host={host} onClose={() => setDiscover((n) => n + 1)} />}
    </div>
  );
}

function UnboundSessions() {
  const sessions = useOffice((s) => s.sessions);
  const hosts = useOffice((s) => s.hosts);
  const assignable = useAssignable();
  const [pick, setPick] = useState<Record<string, string>>({});
  const unbound = Object.values(sessions)
    .filter((x) => x.employeeId === null && (x.status === 'running' || x.status === 'starting' || x.status === 'host_offline'))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  if (unbound.length === 0) return null;
  return (
    <div>
      <div className="section-title">Sessions without an employee</div>
      <div className="small muted" style={{ marginBottom: 6 }}>
        These sessions are connected to the office but represent nobody yet. Bind each one to an employee to see it at a desk.
      </div>
      <div className="list">
        {unbound.map((x) => (
          <div key={x.id} className="card row row-wrap" style={{ padding: 10 }}>
            <div className="grow col" style={{ gap: 4 }}>
              <div className="row row-wrap">
                <span className="mono strong">{x.tmuxSession}</span>
                <Badge tone={x.origin === 'managed' ? 'info' : 'neutral'}>{x.origin}</Badge>
                <span className="small muted">on {hosts[x.hostId]?.name ?? 'an unknown machine'}</span>
                {x.status === 'host_offline' && <Badge tone="warn">machine offline</Badge>}
              </div>
              <div className="small mono muted truncate">{x.cwd}</div>
              <CapabilityBadges capabilities={x.capabilities} />
            </div>
            <EmployeeSelect value={pick[x.id] ?? ''} onChange={(id) => setPick({ ...pick, [x.id]: id })} employees={assignable} emptyLabel="Choose an employee…" />
            <Button small variant="primary" disabled={!pick[x.id]} onClick={() => act(() => api('POST', `/sessions/${x.id}/bind`, { employeeId: pick[x.id] }), 'Session bound')}>
              Bind
            </Button>
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

function ConnectMachine() {
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
  const login = issued ? `orchestrator-agent login --server ${server} --token ${issued.token}` : '';
  const connect = 'orchestrator-agent connect';
  const expired = !!issued && Date.parse(issued.expiresAt) <= Date.now();
  const insecure = /^http:\/\//i.test(server) && !isLoopbackUrl(server);
  return (
    <div className="card col" style={{ gap: 10 }}>
      <div className="strong">Connect a machine</div>
      <div className="small muted">
        Each machine runs the Orchestrator host agent, which makes one outbound connection to this server — no inbound ports are opened on the machine. Create a one-time enrollment token, then run the two commands there.
      </div>
      <div className="grid3">
        <Field label="Label" hint="Only for the audit log.">
          <input value={label} onChange={(ev) => setLabel(ev.target.value)} placeholder="e.g. build-server" />
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
        <Field label="Server URL as seen from that machine" hint="Defaults to the address this window uses.">
          <input value={url} onChange={(ev) => setUrl(ev.target.value)} className="mono" />
        </Field>
      </div>
      <div className="row">
        <Button variant="primary" onClick={create} disabled={busy}>
          {issued ? 'Create another token' : 'Create enrollment token'}
        </Button>
        {issued && (
          <Button variant="ghost" onClick={() => setIssued(null)}>
            Hide token
          </Button>
        )}
      </div>
      {issued && (
        <div className="col" style={{ gap: 8 }}>
          <div className="row row-wrap">
            <Badge tone={expired ? 'bad' : 'warn'}>{expired ? 'expired' : 'shown once'}</Badge>
            <span className="small">
              {expired ? 'This token has expired; create a new one.' : `This token is shown only now — the server keeps just a hash. It works once and expires ${fmtDateTime(issued.expiresAt)}.`}
            </span>
          </div>
          <div className="row">
            <div className="pc-token grow">{issued.token}</div>
            <Button small onClick={() => copyText(issued.token, 'Token copied')}>
              Copy token
            </Button>
          </div>
          <div className="section-title" style={{ margin: 0 }}>
            Run on the machine
          </div>
          <div className="row">
            <div className="code grow" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {login}
              {'\n'}
              {connect}
            </div>
            <Button small onClick={() => copyText(`${login}\n${connect}`, 'Commands copied')}>
              Copy
            </Button>
          </div>
          <div className="small faint">
            <span className="mono">login</span> enrolls the machine with the token; <span className="mono">connect</span> runs the agent in the foreground (add <span className="mono">--daemon</span>, or use <span className="mono">orchestrator-agent service install</span>, to
            keep it connected).
          </div>
        </div>
      )}
      {isLoopbackUrl(server) && <div className="pc-note">This address is a loopback address: it only works for an agent on the same machine as the server. For another machine, use the address the server is reachable at from there.</div>}
      {insecure && <div className="pc-note">This address is plain http. A remote machine needs the server reachable over TLS (https): the server refuses to listen on a non-loopback address without it, unless TLS terminates at a reverse proxy in front of it.</div>}
      {!isLoopbackUrl(server) && !insecure && <div className="small faint">Remote machines need this server reachable over TLS (https) from where they are.</div>}
    </div>
  );
}

function HostsPanel({ onClose }: PanelProps) {
  const hostsById = useOffice((s) => s.hosts);
  const hosts = useMemo(() => Object.values(hostsById).sort((a, b) => Number(a.status === 'revoked') - Number(b.status === 'revoked') || a.enrolledAt.localeCompare(b.enrolledAt)), [hostsById]);
  const active = hosts.filter((h) => h.status !== 'revoked');
  const online = active.filter((h) => h.status === 'online').length;
  return (
    <Window title="Machines" subtitle={`The server room · ${online} of ${active.length} online`} onClose={onClose} width={1040}>
      <div className="col" style={{ gap: 14 }}>
        {hosts.length === 0 ? <Empty title="No machines yet">Connect the machine your Claude Code sessions run on to bring the office to life.</Empty> : hosts.map((h) => <HostCard key={h.id} host={h} />)}
        <UnboundSessions />
        <SshLinks />
        <ConnectMachine />
      </div>
    </Window>
  );
}
registerPanel('hosts', HostsPanel);
