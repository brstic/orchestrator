import { useCallback, useEffect, useState } from 'react';
import type { Employee, Host } from '@orchestrator/contracts';
import { Button, Field } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { elapsedWords } from '../../lib/machines.ts';
import { useOffice } from '../../lib/store.ts';
import { act, ask } from '../core.tsx';
import { More } from './kit.tsx';

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

/** A server the office reaches over SSH: where it is, and what the link is doing right now. */
export interface Link {
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

/** A name nobody has yet, from a folder or tmux session name. */
export function freeEmployeeName(base: string, employees: Record<string, Employee>): string {
  const clean = (base.split('/').filter(Boolean).pop() ?? 'worker').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('').slice(0, 24) || 'Worker';
  const taken = new Set(Object.values(employees).filter((e) => !e.archived).map((e) => e.name.toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean}${i}`.toLowerCase())) return `${clean}${i}`;
}

/**
 * The servers linked over SSH, kept fresh while the window is open (every second while one is connecting). Only an
 * owner has any: for everybody else the list is empty and nothing is asked.
 */
export function useSshLinks(enabled: boolean): { links: Link[]; reload: () => Promise<void> } {
  const [links, setLinks] = useState<Link[]>([]);
  const reload = useCallback(() => (enabled ? api<Link[]>('GET', '/ssh-links').then(setLinks, () => undefined) : Promise.resolve()), [enabled]);
  const working = links.some((l) => l.status === 'connecting' || l.status === 'reconnecting');
  useEffect(() => {
    if (!enabled) return;
    void reload();
    const t = window.setInterval(reload, working ? 1000 : 4000);
    return () => window.clearInterval(t);
  }, [enabled, working, reload]);
  return { links, reload };
}

/** What can be done with a link, each said to the server and then read back. */
export const linkActs = {
  connect: (l: Link, reload: () => Promise<void>) => void act(() => api('POST', `/ssh-links/${l.id}/connect`, {}), 'Connecting…').then(reload),
  disconnect: (l: Link, reload: () => Promise<void>) => void act(() => api('POST', `/ssh-links/${l.id}/disconnect`, {}), 'Disconnected — everything on the server keeps running').then(reload),
  remove: (l: Link, reload: () => Promise<void>) =>
    void ask({ title: `Remove the link to ${l.target}?`, body: `The agent on the server is stopped and its folder deleted, and the machine "${l.name}" can no longer connect. Claude Code sessions running in tmux on the server are left alone.`, ok: 'Remove link', danger: true }).then((yes) => {
      if (yes) void act(() => api('DELETE', `/ssh-links/${l.id}`), 'Link removed').then(reload);
    }),
};

/** What the check found on the server: who and what it is, and only then what is missing. */
function What({ probe }: { probe: Probe }) {
  const found = [
    ['Node', probe.node],
    ['tmux', probe.tmux?.replace(/^tmux /, '') ?? null],
    ['Claude Code', probe.claude?.replace(/ \(Claude Code\)$/, '') ?? null],
    ['git', probe.git?.replace(/^git version /, '') ?? null],
  ] as const;
  const running = probe.tmuxSessions > 0 || probe.claudeProcesses > 0;
  return (
    <div className="k-section">
      <div className="k-text" style={{ color: 'var(--text)' }}>
        <span className="k-mono">
          {probe.user}@{probe.hostname}
        </span>{' '}
        answers: {probe.os} {probe.arch}
        {found.filter(([, v]) => v).length > 0 && `, with ${found.filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ')}`}.
        {running && ` Already running there: ${probe.claudeProcesses} Claude Code process${probe.claudeProcesses === 1 ? '' : 'es'} and ${probe.tmuxSessions} tmux session${probe.tmuxSessions === 1 ? '' : 's'} — once connected, you can bring them in as employees.`}
      </div>
      {probe.problems.map((p) => (
        <div key={p} className="small bad">
          {p}
        </div>
      ))}
      {probe.warnings.map((w) => (
        <div key={w} className="small k-warn">
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
export function SshForm({ onDone }: { onDone: () => void }) {
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [roots, setRoots] = useState('');
  const [probe, setProbe] = useState<Probe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unknownHost, setUnknownHost] = useState(false);
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);

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
    if (res) onDone();
  };
  const ready = !!probe && probe.problems.length === 0;

  return (
    <form
      className="k-form" data-ssh-form
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!valid || busy) return;
        if (ready) void connect();
        else void check();
      }}
    >
      <div className="k-text">The office sets itself up there through SSH, with your own keys. No port is opened and no password is stored.</div>
      <div className="grid2">
        <Field label="Server" hint="As you would type it after ssh: user@host, or a name from your ~/.ssh/config.">
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
        <Field label="Name in the office" hint="Optional.">
          <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder="e.g. Production" />
        </Field>
      </div>
      <More summary="Projects live outside your home folder there">
        <Field label="Folders the office may work in" hint="One per line, e.g. /var/www. Left empty, employees may work anywhere in your home folder on the server.">
          <textarea className="mono" value={roots} onChange={(ev) => setRoots(ev.target.value)} placeholder="/var/www" spellCheck={false} style={{ minHeight: 44 }} />
        </Field>
      </More>
      {error && <div className="small bad">{error}</div>}
      {unknownHost && (
        <label className="check small">
          <input type="checkbox" checked={trust} onChange={(ev) => setTrust(ev.target.checked)} />
          <span>I trust this server: accept its key the first time (it is remembered in your known_hosts; a different key later is refused).</span>
        </label>
      )}
      {probe && <What probe={probe} />}
      <div className="k-actions">
        <Button variant={ready ? 'default' : 'primary'} type="button" disabled={!valid || busy} onClick={() => void check()} title="Checking changes nothing on the server">
          {busy && !probe ? 'Checking…' : probe ? 'Check again' : 'Check the server'}
        </Button>
        <Button variant={ready ? 'primary' : 'default'} type="button" disabled={!valid || busy || !ready} onClick={() => void connect()} title={!probe ? 'Check the server first' : probe.problems.length ? 'Fix what is listed above on the server first' : 'Copies the agent to ~/.orchestrator on the server and connects it'}>
          Connect
        </Button>
      </div>
    </form>
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
export function OutsideTmux({ host, bare = false }: { host: Host; /** Under a heading of the caller's own: no heading here, and "none" is said. */ bare?: boolean }) {
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
    const created = await act(() => api<Employee>('POST', '/employees', { name: freeEmployeeName(p.cwd!, employees), roleKey: 'fullstack', hostId: host.id, workingDir: p.cwd, autonomy: useOffice.getState().me?.kind === 'owner' ? 'unrestricted' : 'auto' }));
    if (created) await act(() => api('POST', `/employees/${created.id}/start`, { continueLast: true }), `${created.name} is starting in ${p.cwd}, continuing the last conversation there`);
    setBusy(null);
    void load();
  };

  if (error) return <div className="small muted">Could not list Claude Code processes: {error}</div>;
  if (!procs) return <div className="small muted">Looking for Claude Code outside tmux…</div>;
  if (procs.length === 0) return bare ? <div className="small faint">No Claude Code is running outside tmux on {host.name}.</div> : null;
  return (
    <div className="k-section" style={bare ? undefined : { marginTop: 6 }}>
      {!bare && <div className="k-label">Claude Code outside tmux</div>}
      <div className="k-text">
        Started in a plain terminal, so there is nothing to attach to. Finish or exit one there, then continue it here: an employee starts in the same folder and picks up the same conversation.
      </div>
      <div className="k-group">
        {procs.map((p) => {
          const here = Object.values(employees).find((e) => !e.archived && e.hostId === host.id && e.workingDir === p.cwd);
          return (
            <div key={p.pid} className="k-row k-row-sm">
              <div className="k-main">
                <div className="k-mono" style={{ overflowWrap: 'anywhere' }}>
                  {p.cwd ?? 'unknown folder'}
                </div>
                <div className="k-sub" title={`${p.tty ? `terminal ${p.tty}, ` : ''}process ${p.pid}`}>
                  running for {elapsedWords(p.elapsed)}
                </div>
              </div>
              {here ? (
                <span className="k-sub">{here.name} works here</span>
              ) : (
                <Button small disabled={!p.cwd || busy === p.pid} onClick={() => void adopt(p)} title="Hire an employee who lives in this folder and continues the last Claude Code conversation there">
                  Continue here as an employee
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
