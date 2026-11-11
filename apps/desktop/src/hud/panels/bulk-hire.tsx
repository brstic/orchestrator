import { useEffect, useMemo, useState } from 'react';
import { ROLE_CATALOGUE, type Employee, type Host } from '@orchestrator/contracts';
import { Badge, Button, Field } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { isThisComputer, useAccess } from '../../lib/access.ts';

interface FolderEntry {
  name: string;
  path: string;
  repo: boolean;
  claude: boolean;
}
interface Listing {
  path: string;
  parent: string | null;
  folders: FolderEntry[];
  home: string;
  roots: string[];
}

interface Row {
  path: string;
  name: string;
  /** The owner typed a name: do not regenerate it. */
  edited: boolean;
  result?: { ok: true } | { ok: false; error: string };
}

const nativeFolders = (): (() => Promise<string[]>) | null => (window as any).orchestrator?.pickFolders ?? null;

const SMALL = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'my', 'new', 'app', 'project', 'repo', 'src', 'main', 'www', 'web', 'site', 'code']);

/**
 * A name you can match to the project at a glance: the folder's own words, capitalised and
 * joined ("xagio-panel" → "XagioPanel", "1p-work" → "1pWork", "my_shop.api" → "ShopApi").
 * Filler words are dropped when something more telling remains.
 */
export function nameForFolder(path: string): string {
  const base = path.split('/').filter(Boolean).pop() ?? 'Worker';
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const telling = words.filter((w) => !SMALL.has(w.toLowerCase()));
  const use = (telling.length ? telling : words).slice(0, 3);
  const name = use.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return (name || 'Worker').slice(0, 24);
}

/** Make every name in the batch different from the others and from the people already hired. */
function distinct(rows: Row[], employees: Record<string, Employee>): Row[] {
  const taken = new Set(Object.values(employees).filter((e) => !e.archived).map((e) => e.name.toLowerCase()));
  return rows.map((r) => {
    if (r.edited) {
      taken.add(r.name.trim().toLowerCase());
      return r;
    }
    const base = nameForFolder(r.path);
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}${i}`;
    taken.add(name.toLowerCase());
    return { ...r, name };
  });
}

/**
 * Hire one employee for each of several project folders in one go. Each lives in their folder
 * (it becomes their project) and is named after it. Nobody's session is started here: it starts
 * when you first talk to them, give them a task, or press Start.
 */
export function BulkHire({ onDone, onlyHostId }: { onDone: () => void; onlyHostId?: string }) {
  const can = useAccess();
  const thisComputer = useOffice((s) => s.myHost.hostId);
  const hostsById = useOffice((s) => s.hosts);
  const employees = useOffice((s) => s.employees);
  // The machines this person may put employees on: the shared ones and their own (or the one this was opened for).
  const hosts = useMemo(() => Object.values(hostsById).filter((h) => h.status === 'online' && (onlyHostId ? h.id === onlyHostId : can.usable(h))), [hostsById, onlyHostId, can.me]); // eslint-disable-line react-hooks/exhaustive-deps
  const [hostId, setHostId] = useState(() => onlyHostId ?? (hosts.find((h) => h.local) ?? hosts.find((h) => !h.memberId) ?? hosts[0])?.id ?? '');
  const host: Host | undefined = hostsById[hostId];
  const [roleKey, setRoleKey] = useState(ROLE_CATALOGUE.find((r) => r.key === 'fullstack')?.key ?? ROLE_CATALOGUE[0]!.key);
  const [rows, setRows] = useState<Row[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  // The system's own folder dialog shows this computer: right when the machine is the one this window is on.
  const native = isThisComputer(host, thisComputer) ? nativeFolders() : null;

  const load = (path: string | null) => {
    if (!hostId) return;
    setError(null);
    api<Listing>('GET', `/hosts/${hostId}/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`).then(
      (l) => {
        setListing(l);
        setFilter('');
      },
      (e) => setError((e as Error).message),
    );
  };
  useEffect(() => {
    setListing(null);
    setRows([]);
    load(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  // Folders where somebody on this machine already lives are not offered twice.
  const occupied = useMemo(() => new Map(Object.values(employees).filter((e) => !e.archived && e.hostId === hostId && !!e.workingDir).map((e) => [e.workingDir!, e.name])), [employees, hostId]);
  const chosen = new Set(rows.map((r) => r.path));
  const setChosen = (paths: string[], on: boolean) =>
    setRows((prev) => {
      const next = on ? [...prev, ...paths.filter((p) => !prev.some((r) => r.path === p) && !occupied.has(p)).map((p) => ({ path: p, name: '', edited: false }))] : prev.filter((r) => !paths.includes(r.path));
      return distinct(next, employees);
    });

  const needle = filter.trim().toLowerCase();
  const shown = (listing?.folders ?? []).filter((f) => !needle || f.name.toLowerCase().includes(needle));
  const free = shown.filter((f) => !occupied.has(f.path));
  const names = rows.map((r) => r.name.trim().toLowerCase());
  const existing = new Set(Object.values(employees).filter((e) => !e.archived).map((e) => e.name.toLowerCase()));
  const problem = (r: Row, i: number): string | null => (!r.name.trim() ? 'needs a name' : existing.has(r.name.trim().toLowerCase()) ? 'someone already has this name' : names.indexOf(r.name.trim().toLowerCase()) !== i ? 'same name twice' : null);
  const pending = rows.filter((r) => !r.result?.ok);
  const valid = pending.length > 0 && rows.every((r, i) => r.result?.ok || !problem(r, i));

  const hire = async () => {
    setBusy(true);
    let made = 0;
    for (const r of rows) {
      if (r.result?.ok) continue;
      try {
        await api<Employee>('POST', '/employees', { name: r.name.trim(), roleKey, hostId, workingDir: r.path, autonomy: can.admin ? 'unrestricted' : 'auto' });
        made++;
        setRows((prev) => prev.map((x) => (x.path === r.path ? { ...x, result: { ok: true } } : x)));
      } catch (e) {
        setRows((prev) => prev.map((x) => (x.path === r.path ? { ...x, result: { ok: false, error: (e as Error).message } } : x)));
      }
    }
    setBusy(false);
    if (made) useOffice.getState().toast(`${made} employee${made === 1 ? '' : 's'} hired — their sessions start when you first talk to them`, 'success');
    if (made === pending.length) onDone();
  };

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="small muted">
        Tick the folders. One employee is hired for each and named after it; each starts working when you first talk to them or give them a task.</div>
      <div className="grid2">
        <Field label="Machine">
          <select value={hostId} onChange={(ev) => setHostId(ev.target.value)} aria-label="Machine">
            {hosts.length === 0 && <option value="">No machine is online</option>}
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
                {h.local ? ' (this computer)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Role for all of them" hint="You can change anyone's role afterwards.">
          <select value={roleKey} onChange={(ev) => setRoleKey(ev.target.value)} aria-label="Role">
            {ROLE_CATALOGUE.filter((r) => r.key !== 'foreman').map((r) => (
              <option key={r.key} value={r.key}>
                {r.title}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="bulk-cols">
        <div className="bulk-pick">
          <div className="row" style={{ gap: 6 }}>
            <Button small type="button" disabled={!listing?.parent} onClick={() => load(listing!.parent)} title="Up one folder">
              ↑
            </Button>
            <span className="mono small truncate grow" title={listing?.path}>
              {listing?.path ?? '…'}
            </span>
            {native && (
              <Button
                small
                type="button"
                onClick={async () => {
                  const picked = await native();
                  if (picked.length) setChosen(picked, true);
                }}
                title="Choose several folders in the system dialog (hold ⌘ or Shift)"
              >
                Choose folders…
              </Button>
            )}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <input type="search" placeholder="Filter folders…" value={filter} onChange={(ev) => setFilter(ev.target.value)} aria-label="Filter folders" />
            <Button small type="button" disabled={!free.some((f) => f.repo && !chosen.has(f.path))} onClick={() => setChosen(free.filter((f) => f.repo).map((f) => f.path), true)} title="Tick every git repository in this list">
              All repositories
            </Button>
            <Button small type="button" disabled={!free.some((f) => !chosen.has(f.path))} onClick={() => setChosen(free.map((f) => f.path), true)}>
              All
            </Button>
          </div>
          {error && <div className="small bad">{error}</div>}
          <div className="bulk-list">
            {!listing && !error && <div className="small muted">Reading folders on {host?.name ?? 'the machine'}…</div>}
            {listing && shown.length === 0 && <div className="small faint">No folders here.</div>}
            {shown.map((f) => {
              const who = occupied.get(f.path);
              return (
                <div key={f.path} className="bulk-item">
                  <label className="check" style={{ alignItems: 'center', flex: 1, minWidth: 0 }} title={who ? `${who} already lives here` : f.path}>
                    <input type="checkbox" checked={chosen.has(f.path)} disabled={!!who} onChange={(ev) => setChosen([f.path], ev.target.checked)} style={{ marginTop: 0 }} />
                    <span className="truncate">{f.name}</span>
                  </label>
                  {who ? <Badge tone="info">{who}</Badge> : f.claude ? <Badge tone="good">Claude</Badge> : f.repo ? <Badge tone="muted">git</Badge> : null}
                  <button type="button" className="fp-link" style={{ flex: 'none' }} onClick={() => load(f.path)} title="Look inside this folder">
                    open ›
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="bulk-chosen">
          <div className="section-title" style={{ margin: 0 }}>
            {rows.length ? `${rows.length} to hire` : 'Nobody chosen yet'}
          </div>
          {rows.length === 0 && <div className="small faint">Tick folders on the left{native ? ', or use “Choose folders…”' : ''}. You can go into other folders and keep ticking.</div>}
          <div className="bulk-list">
            {rows.map((r, i) => {
              const bad = r.result?.ok ? null : problem(r, i);
              return (
                <div key={r.path} className="bulk-row">
                  <input
                    value={r.name}
                    aria-label={`Name for ${r.path}`}
                    disabled={busy || !!r.result?.ok}
                    onChange={(ev) => setRows((prev) => prev.map((x) => (x.path === r.path ? { ...x, name: ev.target.value, edited: true } : x)))}
                    style={{ width: 150, flex: 'none' }}
                  />
                  <span className="mono small faint truncate grow" title={r.path}>
                    {r.path}
                  </span>
                  {r.result?.ok ? <Badge tone="good">hired</Badge> : r.result ? <span className="small bad" title={r.result.error}>failed: {r.result.error.slice(0, 60)}</span> : bad ? <span className="small bad">{bad}</span> : null}
                  {!r.result?.ok && (
                    <button type="button" className="fp-link" style={{ flex: 'none' }} disabled={busy} onClick={() => setChosen([r.path], false)} aria-label={`Remove ${r.path}`}>
                      ✕
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="row">
        <Button variant="primary" disabled={!valid || busy || !hostId} onClick={() => void hire()}>
          {busy ? 'Hiring…' : `Hire ${pending.length || ''} employee${pending.length === 1 ? '' : 's'}`.replace('  ', ' ')}
        </Button>
        <Button variant="ghost" onClick={onDone} disabled={busy}>
          Cancel
        </Button>
        <span className="small faint">Everyone is hired on Auto (no permission questions, only decisions) and can be changed afterwards.</span>
      </div>
    </div>
  );
}
