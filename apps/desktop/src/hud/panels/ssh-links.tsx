import { useEffect, useState } from 'react';
import type { Employee, Host } from '@orchestrator/contracts';
import { Badge, Button, Field, timeAgo, type Tone } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { act, ask } from '../core.tsx';

interface Probe {
  os: string;
  arch: string;
  hostname: string;
  user: string;
  home: string;
  node: string | null;
  tmux: string | null;
  claude: string | null;
  git: string | null;
  curl: boolean;
  tmuxSessions: number;
  claudeProcesses: number;
  problems: string[];
  warnings: string[];
}

interface Link {
  id: string;
  target: string;
  name: string;
  roots: string[];
  remotePort: number;
  hostId: string | null;
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
  step: string | null;
  error: string | null;
  connectedAt: string | null;
  remote: Probe | null;
}

const STATUS: Record<Link['status'], { tone: Tone; label: string }> = {
  idle: { tone: 'muted', label: 'disconnected' },
  connecting: { tone: 'info', label: 'connecting' },
  connected: { tone: 'good', label: 'connected' },
  reconnecting: { tone: 'warn', label: 'reconnecting' },
  error: { tone: 'bad', label: 'failed' },
};

/** A name nobody has yet, from a folder or tmux session name. */
export function freeEmployeeName(base: string, employees: Record<string, Employee>): string {
  const clean = (base.split('/').filter(Boolean).pop() ?? 'worker').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('').slice(0, 24) || 'Worker';
  const taken = new Set(Object.values(employees).filter((e) => !e.archived).map((e) => e.name.toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean}${i}`.toLowerCase())) return `${clean}${i}`;
}

function What({ probe }: { probe: Probe }) {
  const item = (label: string, value: string | null, need = true) => (
    <span className="small">
      <span className="muted">{label} </span>
      {value ? <span className="mono">{value}</span> : <span className={need ? 'bad' : 'faint'}>not found</span>}
    </span>
  );
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row row-wrap" style={{ gap: 14 }}>
        <span className="small">
          <span className="mono strong">{probe.user}@{probe.hostname}</span> <span className="muted">· {probe.os} {probe.arch}</span>
        </span>
        {item('Node', probe.node)}
        {item('tmux', probe.tmux?.replace(/^tmux /, '') ?? null)}
        {item('Claude Code', probe.claude?.replace(/ \(Claude Code\)$/, '') ?? null, false)}
        {item('git', probe.git?.replace(/^git version /, '') ?? null, false)}
      </div>
      {(probe.tmuxSessions > 0 || probe.claudeProcesses > 0) && (
        <div className="small">
          Already running there: <span className="strong">{probe.claudeProcesses}</span> Claude Code process{probe.claudeProcesses === 1 ? '' : 'es'}, <span className="strong">{probe.tmuxSessions}</span> tmux session{probe.tmuxSessions === 1 ? '' : 's'}. Once the server is connected you can bring them in as employees.
        </div>
      )}
      {probe.problems.map((p) => (
        <div key={p} className="small bad">
          {p}
        </div>
      ))}
      {probe.warnings.map((w) => (
        <div key={w} className="small" style={{ color: 'var(--warn)' }}>
          {w}
        </div>
      ))}
    </div>
  );
}

/**
 * Connect a server over SSH: the office checks it, copies its agent there and keeps a reverse
 * SSH tunnel open, so nothing has to be opened to the network on either side. Uses the owner's
 * own SSH keys; no password is asked for or stored.
 */
export function SshLinks() {
  const hosts = useOffice((s) => s.hosts);
  const [links, setLinks] = useState<Link[]>([]);
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [roots, setRoots] = useState('');
  const [probe, setProbe] = useState<Probe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unknownHost, setUnknownHost] = useState(false);
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const load = () => api<Link[]>('GET', '/ssh-links').then(setLinks, () => undefined);
  const working = links.some((l) => l.status === 'connecting' || l.status === 'reconnecting');
  useEffect(() => {
    void load();
    const t = window.setInterval(load, working ? 1000 : 4000);
    return () => window.clearInterval(t);
  }, [working]);

  const valid = /^(?:[A-Za-z0-9._][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*(?::\d{1,5})?$/.test(target.trim().replace(/^ssh:\/\//i, ''));
  const rootList = roots.split(/[\n,]/).map((r) => r.trim()).filter(Boolean);
  const check = async () => {
    setBusy(true);
    setError(null);
    setProbe(null);
    try {
      setProbe(await api<Probe>('POST', '/ssh-links/probe', { target: target.trim(), trustNewHost: trust }));
      setUnknownHost(false);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
      setUnknownHost(/never connected to/.test(msg));
    }
    setBusy(false);
  };
  const connect = async () => {
    setBusy(true);
    const res = await act(() => api<Link>('POST', '/ssh-links', { target: target.trim(), name: name.trim() || undefined, roots: rootList, trustNewHost: trust }), 'Connecting the server…');
    setBusy(false);
    if (!res) return;
    setTarget('');
    setName('');
    setRoots('');
    setProbe(null);
    setTrust(false);
    setOpen(false);
    void load();
  };

  return (
    <div className="card">
      <div className="row">
        <div className="section-title" style={{ margin: 0 }}>
          Servers over SSH
        </div>
        <span className="grow" />
        {!open && (
          <Button small variant="primary" onClick={() => setOpen(true)}>
            Connect a server over SSH
          </Button>
        )}
      </div>
      <div className="small muted" style={{ marginTop: 4 }}>
        A server you can already <span className="mono">ssh</span> into: the office sets itself up there through SSH, with your own keys. No port is opened and no password is stored.
      </div>

      {links.map((l) => {
        const host: Host | undefined = l.hostId ? hosts[l.hostId] : undefined;
        const st = STATUS[l.status];
        return (
          <div key={l.id} className="ssh-link">
            <div className="row row-wrap">
              <span className="strong">{l.name}</span>
              <span className="mono small muted">{l.target}</span>
              <Badge tone={st.tone}>{st.label}</Badge>
              {l.step && <span className="small muted">{l.step}…</span>}
              {l.status === 'connected' && l.connectedAt && <span className="small faint">since {timeAgo(l.connectedAt)}</span>}
              <span className="grow" />
              {l.status === 'idle' || l.status === 'error' ? (
                <Button small variant="primary" onClick={() => void act(() => api('POST', `/ssh-links/${l.id}/connect`, {}), 'Connecting…').then(load)}>
                  {l.status === 'error' ? 'Try again' : 'Connect'}
                </Button>
              ) : (
                <Button small onClick={() => void act(() => api('POST', `/ssh-links/${l.id}/disconnect`, {}), 'Disconnected — everything on the server keeps running').then(load)} title="Close the tunnel. The agent and the sessions keep running on the server and reappear when you connect again.">
                  Disconnect
                </Button>
              )}
              <Button
                small
                variant="ghost"
                title="Stop the agent on the server, delete what was installed for this link, and revoke the machine. tmux sessions on the server are left alone."
                onClick={() => void ask({ title: `Remove the link to ${l.target}?`, body: `The agent on the server is stopped and its folder deleted, and the machine "${l.name}" can no longer connect. Claude Code sessions running in tmux on the server are left alone.`, ok: 'Remove link', danger: true }).then((yes) => { if (yes) void act(() => api('DELETE', `/ssh-links/${l.id}`), 'Link removed').then(load); })}
              >
                Remove
              </Button>
            </div>
            {l.error && <div className="small bad">{l.error}</div>}
            {l.status === 'connected' && host && (
              <div className="small muted">
                It is the machine “{host.name}” above{l.remote && (l.remote.tmuxSessions > 0 || l.remote.claudeProcesses > 0) ? ` — ${l.remote.claudeProcesses} Claude Code process${l.remote.claudeProcesses === 1 ? '' : 'es'} and ${l.remote.tmuxSessions} tmux session${l.remote.tmuxSessions === 1 ? ' was' : 's were'} already running there: use “Bring in what is running there” on its card` : ''}.
              </div>
            )}
          </div>
        );
      })}

      {open && (
        <form
          className="col ssh-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (probe && !probe.problems.length) void connect();
            else void check();
          }}
        >
          <div className="grid2">
            <Field label="Server" hint="As you would type it after ssh: user@host, a name from your ~/.ssh/config, optionally :port.">
              <input
                className="mono"
                value={target}
                onChange={(ev) => {
                  setTarget(ev.target.value);
                  setProbe(null);
                  setError(null);
                  setUnknownHost(false);
                  setTrust(false);
                }}
                placeholder="deploy@my-server.example.com"
                spellCheck={false}
                autoFocus
                aria-label="Server"
              />
            </Field>
            <Field label="Name in the office (optional)">
              <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder="e.g. Production" />
            </Field>
          </div>
          <Field label="Folders the office may work in (optional)" hint="One per line. Left empty, employees may work anywhere in your home folder on the server. Add e.g. /var/www if projects live elsewhere.">
            <textarea className="mono" value={roots} onChange={(ev) => setRoots(ev.target.value)} placeholder="/var/www" spellCheck={false} style={{ minHeight: 44 }} />
          </Field>
          {error && <div className="small bad">{error}</div>}
          {unknownHost && (
            <label className="check small">
              <input type="checkbox" checked={trust} onChange={(ev) => setTrust(ev.target.checked)} />
              <span>I trust this server: accept its key the first time (it is remembered in your known_hosts; a different key later is refused).</span>
            </label>
          )}
          {probe && <What probe={probe} />}
          <div className="row">
            <Button type="button" disabled={!valid || busy} onClick={() => void check()}>
              {busy && !probe ? 'Checking…' : probe ? 'Check again' : 'Check the server'}
            </Button>
            <Button variant="primary" type="button" disabled={!valid || busy || !probe || probe.problems.length > 0} onClick={() => void connect()} title={!probe ? 'Check the server first' : probe.problems.length ? 'Fix what is listed above on the server first' : undefined}>
              Connect
            </Button>
            <Button variant="ghost" type="button" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <span className="small faint">Checking changes nothing on the server. Connecting copies the agent to ~/.orchestrator there.</span>
          </div>
        </form>
      )}
    </div>
  );
}

interface Proc {
  pid: number;
  cwd: string | null;
  tty: string | null;
  elapsed: string;
  command: string;
}

/**
 * Claude Code processes on a machine that run outside tmux. They cannot be taken over (there is
 * no terminal to attach to); the office can start an employee in the same folder that continues
 * the conversation Claude Code has there.
 */
export function OutsideTmux({ host }: { host: Host }) {
  const employees = useOffice((s) => s.employees);
  const [procs, setProcs] = useState<Proc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const load = () =>
    api<{ processes: Proc[] }>('GET', `/hosts/${host.id}/claude-processes`).then(
      (r) => {
        setProcs(r.processes ?? []);
        setError(null);
      },
      (e) => setError((e as Error).message),
    );
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.id]);

  const adopt = async (p: Proc) => {
    if (!p.cwd) return;
    setBusy(p.pid);
    const created = await act(() => api<Employee>('POST', '/employees', { name: freeEmployeeName(p.cwd!, employees), roleKey: 'fullstack', hostId: host.id, workingDir: p.cwd, autonomy: 'auto' }));
    if (created) await act(() => api('POST', `/employees/${created.id}/start`, { continueLast: true }), `${created.name} is starting in ${p.cwd}, continuing the last conversation there`);
    setBusy(null);
    void load();
  };

  if (error) return <div className="small muted">Could not list Claude Code processes: {error}</div>;
  if (!procs) return <div className="small muted">Looking for Claude Code outside tmux…</div>;
  if (procs.length === 0) return <div className="small faint">No Claude Code is running outside tmux on {host.name}.</div>;
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="section-title" style={{ margin: 0 }}>
        Claude Code running outside tmux on {host.name}
      </div>
      <div className="small muted">
        These were started in a plain terminal, so there is nothing to attach to and the office cannot take them over. To bring one in: finish or exit it there, then start an employee in the same folder — it continues the same conversation (<span className="mono">claude --continue</span>), now inside tmux where you can watch and take control.
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Folder</th>
            <th>Running for</th>
            <th>Terminal</th>
            <th>PID</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {procs.map((p) => {
            const here = Object.values(employees).find((e) => !e.archived && e.hostId === host.id && e.workingDir === p.cwd);
            return (
              <tr key={p.pid}>
                <td className="mono small" style={{ wordBreak: 'break-all' }}>
                  {p.cwd ?? 'unknown'}
                </td>
                <td className="mono small">{p.elapsed}</td>
                <td className="mono small">{p.tty ?? '—'}</td>
                <td className="mono small">{p.pid}</td>
                <td className="pc-nowrap">
                  {here ? (
                    <Badge tone="info">{here.name} works here</Badge>
                  ) : (
                    <Button small variant="primary" disabled={!p.cwd || busy === p.pid} onClick={() => void adopt(p)} title="Hire an employee who lives in this folder and continues the last Claude Code conversation there">
                      Continue here as an employee
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
