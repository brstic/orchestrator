import { useEffect, useMemo, useState } from 'react';
import type { Host } from '@orchestrator/contracts';
import { Badge, Button, Empty, Field } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { act, ask } from '../core.tsx';

/** What the desktop app keeps about a server this person brought in: how to reach it, and what it is doing to it right now. */
interface ServerRecord {
  id: string;
  target: string;
  name: string;
  roots: string[];
  hostId: string | null;
  step: string | null;
  error: string | null;
}

/** The desktop app's side (electron/member-servers.cjs): it does the reaching over SSH, with the keys on this computer. */
interface ServersBridge {
  list: () => Promise<ServerRecord[] | null>;
  add: (input: { target: string; name?: string; roots?: string[]; trustNewHost?: boolean }) => Promise<{ ok?: boolean; error?: string; cancelled?: boolean; warnings?: string[] }>;
  reconnect: (id: string) => Promise<{ ok?: boolean; error?: string }>;
  /** Absent in a desktop app from before folders could be changed. */
  setRoots?: (id: string, roots: string[]) => Promise<{ ok?: boolean; error?: string; cancelled?: boolean; roots?: string[] }>;
  remove: (id: string) => Promise<{ ok?: boolean; error?: string; cancelled?: boolean; cleaned?: boolean }>;
  onChange: (cb: () => void) => () => void;
}
const bridge = (): ServersBridge | null => (window as unknown as { orchestrator?: { servers?: ServersBridge } }).orchestrator?.servers ?? null;

/**
 * Servers of my own in the office: machines only I can reach, brought in with the SSH keys on my computer. They are
 * mine like my computer — my employees on them sit in my room — until I share one: then it is a machine of the
 * office like any other, stands with them, and colleagues work on it. I can take it back.
 */
export function MyServers({ memberId }: { memberId: string }) {
  const hosts = useOffice((s) => s.hosts);
  const employees = useOffice((s) => s.employees);
  const servers = useMemo(
    () =>
      Object.values(hosts)
        .filter((h) => h.ownerId === memberId && h.status !== 'revoked')
        .sort((a, b) => a.name.localeCompare(b.name)),
    [hosts, memberId],
  );
  const native = bridge();
  const [records, setRecords] = useState<ServerRecord[]>([]);
  const [adding, setAdding] = useState(false);
  const [target, setTarget] = useState('');
  const [name, setName] = useState('');
  const [roots, setRoots] = useState('');
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The server whose folders are being edited, and what is typed for them. */
  const [editing, setEditing] = useState<{ id: string; text: string; busy: boolean; error: string | null } | null>(null);

  useEffect(() => {
    if (!native) return;
    let alive = true;
    const load = () => void native.list().then((l) => alive && setRecords(l ?? []));
    load();
    const off = native.onChange(load);
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!native]);

  const recordOf = (h: Host) => records.find((r) => r.hostId === h.id) ?? null;
  // A server whose bringing-in did not finish (or failed) is known to this computer and not yet to the office.
  const pending = records.filter((r) => !r.hostId || !servers.some((h) => h.id === r.hostId));
  const staff = (h: Host) => Object.values(employees).filter((e) => !e.archived && e.hostId === h.id).length;

  const add = async () => {
    if (!native) return;
    setBusy(true);
    setError(null);
    const res = await native.add({ target: target.trim(), name: name.trim() || undefined, roots: roots.split(',').map((r) => r.trim()).filter(Boolean), trustNewHost: trust });
    setBusy(false);
    if (res.cancelled) return;
    if (res.error) return setError(res.error);
    setAdding(false);
    setTarget('');
    setName('');
    setRoots('');
    setTrust(false);
    useOffice.getState().toast(`The server is in the office${res.warnings?.length ? ` — ${res.warnings[0]}` : ''}`, res.warnings?.length ? 'info' : 'success');
  };

  const saveRoots = async () => {
    if (!editing || !native?.setRoots) return;
    setEditing({ ...editing, busy: true, error: null });
    const res = await native.setRoots(editing.id, editing.text.split(',').map((r) => r.trim()).filter(Boolean));
    if (res.cancelled) return setEditing({ ...editing, busy: false });
    if (res.error) return setEditing({ ...editing, busy: false, error: res.error });
    setEditing(null);
    useOffice.getState().toast(res.ok ? 'The folders are changed' : 'The folders are changed; the server has not come back into the office yet', res.ok ? 'success' : 'info');
  };

  const share = async (h: Host, shared: boolean) => {
    const n = staff(h);
    const body = shared
      ? `${h.name} becomes a machine of the office like its own: colleagues can hire onto it and work with whoever is on it${n ? ` — the ${n === 1 ? 'employee' : `${n} employees`} there now become${n === 1 ? 's' : ''} the office's, with what they said and did` : ''}. It stands with the office's machines instead of in your room. It stays yours to take back or remove.`
      : `${h.name} is yours alone again${n ? `, with the ${n === 1 ? 'employee' : `${n} employees`} on it: only you and the owners can then work with them` : ''}. Work in progress there for a project on another machine has to finish first.`;
    if (!(await ask({ title: shared ? `Share ${h.name} with the office?` : `Take ${h.name} back?`, body, ok: shared ? 'Share it' : 'Take it back' }))) return;
    await act(() => api('PATCH', `/me/servers/${h.id}`, { shared }), shared ? `${h.name} is shared with the office` : `${h.name} is yours alone again`);
  };

  const remove = async (h: Host) => {
    const rec = recordOf(h);
    if (rec && native) {
      // The app asks in a dialog of its own (it is about to reach into the server), then stops the agent there and has the office forget the machine.
      const res = await native.remove(rec.id);
      if (res.error) useOffice.getState().toast(res.error, 'error');
      else if (!res.cancelled) useOffice.getState().toast(`${h.name} is out of the office${res.cleaned ? '' : '; what was installed on it could not be removed from here'}`, 'success');
      return;
    }
    if (!(await ask({ title: `Remove ${h.name} from the office?`, body: 'The office forgets the machine and its agent is refused from then on. This computer does not know how to reach that server, so what was installed on it stays there (~/.orchestrator). Sessions on it keep running in tmux.', ok: 'Remove', danger: true }))) return;
    await act(() => api('DELETE', `/me/servers/${h.id}`), `${h.name} is out of the office`);
  };

  return (
    <div className="card col my-servers" style={{ gap: 8 }}>
      <div className="row">
        <span className="section-title grow" style={{ margin: 0 }}>
          My servers ({servers.length})
        </span>
        {!adding && (
          <Button small variant="primary" disabled={!native} title={native ? undefined : 'Open this office in the Orchestrator desktop app: bringing a server in uses the SSH keys on your computer'} onClick={() => setAdding(true)}>
            Bring a server in…
          </Button>
        )}
      </div>
      <div className="small muted">
        Servers only you can reach, brought in over SSH with the keys on this computer. They are yours like your computer, and stay in the office when you leave. Share one and it becomes a machine of the office that colleagues work on.
      </div>
      {!native && <div className="small faint">A browser tab cannot reach your servers: open this office in the desktop app to add one. Sharing and taking back work from here.</div>}

      {servers.length === 0 && pending.length === 0 && !adding && <Empty title="No server of yours here yet">A server you can ssh into, with Node.js 22.18+, tmux and Claude Code on it.</Empty>}

      <div className="list">
        {servers.map((h) => {
          const rec = recordOf(h);
          const shared = !h.memberId;
          return (
            <div key={h.id} className="row my-server-row" style={{ padding: '6px 0', gap: 10 }}>
              <div className="grow" style={{ minWidth: 0 }}>
                <span className="strong">{h.name}</span> <span className="small muted">{rec?.target ?? h.info?.hostname ?? ''}</span>
                <div className="small faint">
                  {staff(h)} {staff(h) === 1 ? 'employee' : 'employees'} · {shared ? 'shared: a machine of the office, colleagues work on it' : 'yours alone, in your room'}
                  {rec?.step ? ` · ${rec.step}…` : ''}
                </div>
                {rec && (
                  <div className="small faint">
                    Folders: <span className="mono">{rec.roots.length ? rec.roots.join(', ') : 'the home folder'}</span>
                  </div>
                )}
                {rec?.error && <div className="small bad">{rec.error}</div>}
                {rec && editing?.id === rec.id && (
                  <div className="col" style={{ gap: 6, marginTop: 6 }}>
                    <input value={editing.text} placeholder="~/code, /srv/app" onChange={(ev) => setEditing({ ...editing, text: ev.target.value })} aria-label="Folders employees may work in" spellCheck={false} autoFocus disabled={editing.busy} />
                    <div className="small faint">Separated by commas; absolute, or ~/… for under your home folder (~ alone is the home folder). Only these: a folder you leave out is no longer allowed. The server's user must be able to work in them.</div>
                    {editing.error && <div className="small bad">{editing.error}</div>}
                    <div className="row" style={{ gap: 8 }}>
                      <Button small variant="primary" disabled={editing.busy} onClick={() => void saveRoots()}>
                        {editing.busy ? 'Changing…' : 'Change the folders'}
                      </Button>
                      <Button small variant="ghost" disabled={editing.busy} onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </div>
              <Badge tone={h.status === 'online' ? 'good' : 'muted'}>{h.status === 'online' ? 'in the office' : 'not connected'}</Badge>
              {h.status !== 'online' && rec && native && (
                <Button small onClick={() => void native.reconnect(rec.id).then((r) => r.error && useOffice.getState().toast(r.error, 'error'))} title="Start the agent on the server again (after the server was restarted)">
                  Reconnect
                </Button>
              )}
              {rec && native?.setRoots && editing?.id !== rec.id && (
                <Button small onClick={() => setEditing({ id: rec.id, text: rec.roots.join(', '), busy: false, error: null })} title="Which folders on the server employees may work in">
                  Folders…
                </Button>
              )}
              <Button small onClick={() => void share(h, !shared)}>
                {shared ? 'Take back' : 'Share…'}
              </Button>
              <Button small variant="ghost" onClick={() => void remove(h)}>
                Remove…
              </Button>
            </div>
          );
        })}
        {pending.map((r) => (
          <div key={r.id} className="row my-server-row" style={{ padding: '6px 0', gap: 10 }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <span className="strong">{r.name}</span> <span className="small muted">{r.target}</span>
              <div className={`small ${r.error ? 'bad' : 'faint'}`}>{r.error ?? (r.step ? `${r.step}…` : 'not in the office')}</div>
            </div>
            {native && !r.step && (
              <Button small variant="ghost" onClick={() => void native.remove(r.id)}>
                Remove…
              </Button>
            )}
          </div>
        ))}
      </div>

      {adding && native && (
        <div className="col" style={{ gap: 8 }}>
          <div className="grid2">
            <Field label="Server" hint="As you would type it after ssh: user@host, a name from your ~/.ssh/config, optionally :port. Key login only.">
              <input value={target} placeholder="deploy@build.example.com" onChange={(ev) => setTarget(ev.target.value)} aria-label="Server" autoFocus spellCheck={false} />
            </Field>
            <Field label="Name in the office" hint="Empty: the server's own name.">
              <input value={name} maxLength={40} onChange={(ev) => setName(ev.target.value)} aria-label="Name in the office" />
            </Field>
          </div>
          <Field label="Folders employees may work in" hint="Separated by commas; absolute, or ~/… Empty: your home folder on the server.">
            <input value={roots} placeholder="~/code, /srv/app" onChange={(ev) => setRoots(ev.target.value)} aria-label="Folders" spellCheck={false} />
          </Field>
          <label className="check small" style={{ alignItems: 'center' }}>
            <input type="checkbox" checked={trust} onChange={(ev) => setTrust(ev.target.checked)} style={{ marginTop: 0 }} />I trust this server: accept its identity if this computer has never connected to it before
          </label>
          {error && <div className="small bad">{error}</div>}
          <div className="row" style={{ gap: 8 }}>
            <Button small variant="primary" disabled={busy || !target.trim()} onClick={() => void add()}>
              {busy ? 'Bringing it in…' : 'Bring it in'}
            </Button>
            <Button small variant="ghost" disabled={busy} onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <span className="small faint grow">The app asks once more, then connects over SSH, installs the office's agent in ~/.orchestrator on the server and starts it. Nothing else on the server is touched.</span>
          </div>
        </div>
      )}
    </div>
  );
}
