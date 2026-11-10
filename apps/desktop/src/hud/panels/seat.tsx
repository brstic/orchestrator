import { useMemo, useState } from 'react';
import { memberSeatOf } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Window } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useAccess } from '../../lib/access.ts';
import { useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { registerPanel } from './index.tsx';

/** The pod a desk belongs to: desks are named `<pod>-a` … `<pod>-d`. */
const podOf = (deskId: string): string => deskId.replace(/-[a-z]$/, '');

/**
 * An empty desk the person is standing at. Three things can be done with it, and the window says so
 * first: hire someone new for it, sit down oneself with a Claude Code session of one's own, or move
 * someone who already works here. Moving changes only where a person is shown.
 */
function SeatPanel({ arg, onClose }: { arg: string | null; onClose: () => void }) {
  const employees = useOffice((s) => s.employees);
  const projects = useOffice((s) => s.projects);
  const hosts = useOffice((s) => s.hosts);
  const desks = useOffice((s) => s.layout?.desks ?? []);
  const can = useAccess();
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  // A seat in a member's room is not in the office's stored layout: it belongs to that member's computer.
  const seat = memberSeatOf(arg);
  const roomHost = seat ? hosts[seat.hostId] : undefined;
  const desk = desks.find((d) => d.id === arg);
  const occupant = Object.values(employees).find((e) => !e.archived && e.deskId === arg);
  const neighbours = useMemo(() => Object.values(employees).filter((e) => !e.archived && !!e.deskId && e.deskId !== arg && podOf(e.deskId) === podOf(arg ?? '')), [employees, arg]);
  const needle = search.trim().toLowerCase();
  const people = useMemo(
    () =>
      Object.values(employees)
        // Who can sit here: in the office, anyone of the office's own; in a room, the people of that computer.
        .filter((e) => !e.archived && e.roleKey !== 'foreman' && e.deskId !== arg && (seat ? e.hostId === seat.hostId : !hosts[e.hostId ?? '']?.memberId))
        .filter((e) => !needle || `${e.name} ${e.title} ${projects[e.projectId ?? '']?.name ?? ''}`.toLowerCase().includes(needle))
        // People without a desk first, then by name.
        .sort((a, b) => Number(!!a.deskId) - Number(!!b.deskId) || a.name.localeCompare(b.name)),
    [employees, projects, hosts, arg, needle, seat?.hostId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const mine = !!seat && !!can.me?.id && roomHost?.memberId === can.me.id;
  if (!arg || (!desk && !roomHost)) {
    return (
      <Window title="This desk" onClose={onClose} width={520}>
        <p className="muted">That desk no longer exists.</p>
      </Window>
    );
  }
  // In someone else's room only they (and owners) arrange things.
  const allowed = seat ? mine || !!can.admin : can.work(null);
  const where = seat ? (mine ? 'in your room' : `in ${roomHost?.memberName ?? 'a member'}'s room`) : 'in the office';
  const put = async (id: string, name: string) => {
    setBusy(id);
    const ok = await act(() => api('PATCH', `/employees/${id}`, { deskId: arg }), occupant ? `${name} and ${occupant.name} swapped desks` : `${name} now sits here`);
    setBusy(null);
    if (ok) onClose();
  };
  const open = useOffice.getState().openPanel;
  const list = (
    <div className="col" style={{ gap: 10 }}>
      <input type="search" autoFocus placeholder="Search people…" value={search} onChange={(ev) => setSearch(ev.target.value)} aria-label="Search people" />
      <div className="small muted">Only where they sit changes. Their session, project and work are not touched.</div>
      <div className="list" style={{ maxHeight: '46vh', overflowY: 'auto' }}>
        {people.length === 0 && <div className="small faint">{needle ? 'Nobody matches.' : 'Nobody else works here yet.'}</div>}
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
            <Button small variant="primary" disabled={busy === e.id} onClick={() => void put(e.id, e.name)}>
              {occupant ? 'Swap here' : e.deskId ? 'Move here' : 'Seat here'}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );

  // Somebody already sits here: the only question is who takes their place.
  if (occupant) {
    return (
      <Window title={`${occupant.name}'s desk`} subtitle="Choosing someone swaps the two of them" onClose={onClose} width={620}>
        {list}
      </Window>
    );
  }
  return (
    <Window title="An empty desk" subtitle={`${where}${neighbours.length ? ` · next to ${neighbours.map((n) => n.name).join(', ')}` : ''}`} onClose={onClose} width={620}>
      {!allowed ? (
        <p className="muted">{seat ? 'Only the member whose room this is, or an owner, can use this desk.' : 'Visitors can look around; they cannot hire or seat anyone.'}</p>
      ) : moving ? (
        <div className="col" style={{ gap: 12 }}>
          <button type="button" className="fp-link" style={{ alignSelf: 'flex-start' }} onClick={() => setMoving(false)}>
            ← Back
          </button>
          {list}
        </div>
      ) : (
        <div className="choices">
          <button type="button" className="choice" data-choice="hire" onClick={() => open('team', `hire@${arg}`)}>
            <span className="choice-title">Hire someone new for this desk</span>
            <span className="choice-text">A new employee: a Claude Code session that works in a folder {seat ? 'on that computer' : 'on the server'} and takes the work you give it.</span>
          </button>
          <button type="button" className="choice" data-choice="me" onClick={() => open('team', `me@${arg}`)}>
            <span className="choice-title">Sit here myself</span>
            <span className="choice-text">
              Your own Claude Code at this desk, in a folder {seat ? 'on your computer' : 'on the server'}. You type into it; the office gives it no work.
              {!seat && ' For a folder on your own computer, use a desk in your room: what runs on your computer sits there.'}
            </span>
          </button>
          <button type="button" className="choice" data-choice="move" onClick={() => setMoving(true)} disabled={people.length === 0}>
            <span className="choice-title">Seat someone who already works here</span>
            <span className="choice-text">{people.length === 0 ? 'Nobody else works here yet.' : 'Move a person to this desk. Nothing about their work changes.'}</span>
          </button>
        </div>
      )}
    </Window>
  );
}

registerPanel('seat', SeatPanel);
