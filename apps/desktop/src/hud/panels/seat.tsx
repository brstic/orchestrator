import { useMemo, useState } from 'react';
import { Avatar, Badge, Button, Window } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { registerPanel } from './index.tsx';

/** The pod a desk belongs to: desks are named `<pod>-a` … `<pod>-d`. */
const podOf = (deskId: string): string => deskId.replace(/-[a-z]$/, '');

/**
 * Seat someone at a desk the owner is standing at. Anyone can be chosen: a person who already
 * has a desk moves here (their old desk becomes free). Nothing about their work changes — the
 * desk is where they are shown, their session keeps running where it runs.
 */
function SeatPanel({ arg, onClose }: { arg: string | null; onClose: () => void }) {
  const employees = useOffice((s) => s.employees);
  const projects = useOffice((s) => s.projects);
  const desks = useOffice((s) => s.layout?.desks ?? []);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const desk = desks.find((d) => d.id === arg);
  const occupant = Object.values(employees).find((e) => !e.archived && e.deskId === arg);
  const neighbours = useMemo(() => Object.values(employees).filter((e) => !e.archived && !!e.deskId && e.deskId !== arg && podOf(e.deskId) === podOf(arg ?? '')), [employees, arg]);
  const needle = search.trim().toLowerCase();
  const people = useMemo(
    () =>
      Object.values(employees)
        .filter((e) => !e.archived && e.roleKey !== 'foreman' && e.deskId !== arg && (!needle || `${e.name} ${e.title} ${projects[e.projectId ?? '']?.name ?? ''}`.toLowerCase().includes(needle)))
        // People without a desk first, then by name.
        .sort((a, b) => Number(!!a.deskId) - Number(!!b.deskId) || a.name.localeCompare(b.name)),
    [employees, projects, arg, needle],
  );
  if (!desk) {
    return (
      <Window title="Seat someone here" onClose={onClose} width={520}>
        <p className="muted">That desk no longer exists.</p>
      </Window>
    );
  }
  const seat = async (id: string, name: string) => {
    setBusy(id);
    const ok = await act(() => api('PATCH', `/employees/${id}`, { deskId: desk.id }), occupant ? `${name} and ${occupant.name} swapped desks` : `${name} now sits here`);
    setBusy(null);
    if (ok) onClose();
  };
  return (
    <Window
      title={occupant ? `${occupant.name}'s desk` : 'Seat someone at this desk'}
      subtitle={`${occupant ? 'Choosing someone swaps the two of them' : 'An empty desk'}${neighbours.length ? ` · next to ${neighbours.map((n) => n.name).join(', ')}` : ''}`}
      onClose={onClose}
      width={620}
    >
      <div className="col" style={{ gap: 10 }}>
        <input type="search" autoFocus placeholder="Search people…" value={search} onChange={(ev) => setSearch(ev.target.value)} aria-label="Search people" />
        <div className="small muted">Only where they sit changes. Their session, project and work are not touched.</div>
        <div className="list" style={{ maxHeight: '52vh', overflowY: 'auto' }}>
          {people.length === 0 && <div className="small faint">Nobody matches.</div>}
          {people.map((e) => (
            <div key={e.id} className="row" style={{ padding: '6px 4px', gap: 10 }}>
              <Avatar appearance={e.appearance} size={26} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="strong truncate">{e.name}</div>
                <div className="small muted truncate">
                  {e.title}
                  {e.projectId && projects[e.projectId] ? ` · ${projects[e.projectId]!.name}` : ''}
                </div>
              </div>
              {e.deskId ? <Badge tone="muted">has a desk</Badge> : <Badge tone="warn">no desk</Badge>}
              <Button small variant="primary" disabled={busy === e.id} onClick={() => void seat(e.id, e.name)}>
                {occupant ? 'Swap here' : e.deskId ? 'Move here' : 'Seat here'}
              </Button>
            </div>
          ))}
        </div>
      </div>
    </Window>
  );
}

registerPanel('seat', SeatPanel);
