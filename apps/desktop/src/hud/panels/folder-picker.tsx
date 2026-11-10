import { useEffect, useRef, useState } from 'react';
import type { Host } from '@orchestrator/contracts';
import { Badge, Button } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { isThisComputer } from '../../lib/access.ts';
import { useOffice } from '../../lib/store.ts';

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
  repo: boolean;
  home: string;
  roots: string[];
}

/** The desktop app can show the operating system's own folder dialog; a browser cannot. */
const nativePicker = (): (() => Promise<string | null>) | null => (window as any).orchestrator?.pickFolder ?? null;

/**
 * A folder field that does not make anyone type a path: the system dialog when the folder is on
 * this computer (desktop app), otherwise a browser over what the machine's host agent can see.
 * Typing or pasting a path still works.
 */
export function FolderField({ value, onChange, host, disabled, placeholder }: { value: string; onChange: (path: string) => void; host: Host | undefined; disabled?: boolean; placeholder?: string }) {
  const [browsing, setBrowsing] = useState(false);
  // The system's folder dialog shows this computer's disk: offered only when that is the machine in question.
  // (An office on a server is "local" to itself, not to the person looking at it.)
  const myHostId = useOffice((s) => s.myHost.hostId);
  const native = isThisComputer(host, myHostId) ? nativePicker() : null;
  const canBrowse = !!host && host.status === 'online';
  const browse = async () => {
    if (native) {
      const picked = await native();
      if (picked) onChange(picked);
    } else setBrowsing((b) => !b);
  };
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        <input className="mono grow" value={value} onChange={(ev) => onChange(ev.target.value)} placeholder={placeholder ?? '/path/to/the/project/folder'} disabled={disabled} spellCheck={false} />
        <Button type="button" onClick={() => void browse()} disabled={disabled || !canBrowse} title={canBrowse ? 'Choose a folder' : 'Their machine is not connected, so its folders cannot be listed'}>
          Browse…
        </Button>
      </div>
      {native && !disabled && (
        <button type="button" className="fp-link" onClick={() => setBrowsing((b) => !b)}>
          {browsing ? 'Hide the folder list' : 'or pick from a list of folders'}
        </button>
      )}
      {browsing && host && !disabled && (
        <FolderBrowser
          host={host}
          start={value.trim() || null}
          onPick={(p) => {
            onChange(p);
            setBrowsing(false);
          }}
        />
      )}
    </div>
  );
}

function FolderBrowser({ host, start, onPick }: { host: Host; start: string | null; onPick: (path: string) => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const load = (path: string | null) => {
    setError(null);
    api<Listing>('GET', `/hosts/${host.id}/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`)
      .then((l) => {
        setListing(l);
        setFilter('');
      })
      .catch((e) => {
        // A typed path that does not exist (yet): fall back to where browsing is allowed to start.
        if (path) load(null);
        else setError((e as Error).message);
      });
  };
  useEffect(() => load(start), [host.id]);
  // Long paths: keep the end (where you are) in view.
  const crumbsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (crumbsRef.current) crumbsRef.current.scrollLeft = crumbsRef.current.scrollWidth;
  }, [listing?.path]);
  if (error) return <div className="fp small bad">{error}</div>;
  if (!listing) return <div className="fp small muted">Reading folders on {host.name}…</div>;
  const needle = filter.trim().toLowerCase();
  const shown = listing.folders.filter((f) => !needle || f.name.toLowerCase().includes(needle));
  const crumbs = listing.path.split('/').filter(Boolean);
  return (
    <div className="fp">
      <div className="fp-bar">
        <Button small type="button" disabled={!listing.parent} onClick={() => load(listing.parent)} title="Up one folder">
          ↑
        </Button>
        <div ref={crumbsRef} className="fp-crumbs mono" title={listing.path}>
          {crumbs.map((c, i) => {
            const target = `/${crumbs.slice(0, i + 1).join('/')}`;
            const reachable = listing.roots.some((r) => target === r || target.startsWith(`${r}/`));
            return (
              <span key={target}>
                <span className="faint">/</span>
                {reachable && i < crumbs.length - 1 ? (
                  <button type="button" className="fp-crumb" onClick={() => load(target)}>
                    {c}
                  </button>
                ) : (
                  <span className={i === crumbs.length - 1 ? 'strong' : 'faint'}>{c}</span>
                )}
              </span>
            );
          })}
          {listing.repo && <Badge tone="info">git</Badge>}
        </div>
        <Button small variant="primary" type="button" onClick={() => onPick(listing.path)}>
          Use this folder
        </Button>
      </div>
      {listing.folders.length > 8 && <input className="fp-filter" value={filter} onChange={(ev) => setFilter(ev.target.value)} placeholder="Filter folders…" aria-label="Filter folders" />}
      <div className="fp-list">
        {shown.length === 0 && <div className="small muted fp-empty">{listing.folders.length ? 'No folder matches.' : 'No folders inside this one.'}</div>}
        {shown.map((f) => (
          <div key={f.path} className="fp-row">
            <button type="button" className="fp-open" onClick={() => load(f.path)} title="Open this folder">
              <span className="fp-icon" aria-hidden>
                ▸
              </span>
              <span className="truncate">{f.name}</span>
              {f.repo && <Badge tone="info">git</Badge>}
              {f.claude && (
                <Badge tone="accent" title="Has a CLAUDE.md">
                  CLAUDE.md
                </Badge>
              )}
            </button>
            <Button small type="button" onClick={() => onPick(f.path)}>
              Choose
            </Button>
          </div>
        ))}
      </div>
      <div className="small faint">
        Folders on {host.name}
        {listing.roots.length ? ` inside ${listing.roots.join(', ')}` : ''}. Hidden folders are not listed.
      </div>
    </div>
  );
}
