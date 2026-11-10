import { useMemo } from 'react';
import type { Host } from '@orchestrator/contracts';
import { MEMBER_ROOM_LIMITS, memberSeatId, memberSeatOf } from '@orchestrator/contracts';
import { Badge } from '@orchestrator/ui';
import { useAccess } from '../../lib/access.ts';
import { useOffice } from '../../lib/store.ts';

/** A place a new employee can live: a machine everyone shares, or the hiring person's own computer (their room). */
export interface HirePlace {
  host: Host;
  mine: boolean;
  /** Why nobody can be started there right now, if so. */
  problem: string | null;
}

/**
 * Where someone can be hired: the office's shared machines, and — for a member whose computer is in the office —
 * their own room. Another member's computer is not offered: what runs there is theirs to set up.
 */
export function useHirePlaces(): { places: HirePlace[]; myRoomUnavailable: string | null } {
  const can = useAccess();
  const hosts = useOffice((s) => s.hosts);
  const myHost = useOffice((s) => s.myHost);
  return useMemo(() => {
    const all = Object.values(hosts).filter((h) => h.status !== 'revoked');
    const shared = all.filter((h) => !h.memberId && can.usable(h)).sort((a, b) => Number(b.local) - Number(a.local) || a.name.localeCompare(b.name));
    const own = all.filter((h) => !!can.me?.id && h.memberId === can.me.id).sort((a, b) => Number(b.id === myHost.hostId) - Number(a.id === myHost.hostId) || Number(b.status === 'online') - Number(a.status === 'online'));
    const places: HirePlace[] = [
      ...shared.map((host) => ({ host, mine: false, problem: host.status === 'online' ? null : `${host.name} is offline right now` })),
      // One room: the computer this window is on, else whichever of theirs is connected.
      ...own.slice(0, 1).map((host) => ({ host, mine: true, problem: host.status === 'online' ? null : 'Your computer is not connected to the office right now' })),
    ];
    // Why there is no "my room" to offer, when there could be one.
    const myRoomUnavailable = own.length || can.root || can.visitor ? null : myHost.state === 'unavailable' ? myHost.reason : myHost.state === 'starting' ? 'Your computer is still connecting to the office…' : 'Open this office with the Orchestrator desktop app to have a room of your own here.';
    return { places, myRoomUnavailable };
  }, [hosts, myHost, can.me?.id, can.me?.role]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Step one of hiring: the shared office, or my own room. Nothing is chosen for the person. */
export function WherePicker({ value, onChange, only }: { value: string; onChange: (hostId: string) => void; only?: 'shared' | 'mine' }) {
  const { places: all, myRoomUnavailable } = useHirePlaces();
  const places = only ? all.filter((p) => (only === 'mine' ? p.mine : !p.mine)) : all;
  // More than one shared machine: each is named, or the choices would read the same.
  const severalShared = places.filter((p) => !p.mine).length > 1;
  const employees = useOffice((s) => s.employees);
  const count = (hostId: string) => Object.values(employees).filter((e) => !e.archived && e.hostId === hostId).length;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="hire-where" role="radiogroup" aria-label="Where they work">
        {places.map(({ host, mine, problem }) => (
          <button key={host.id} type="button" role="radio" aria-checked={value === host.id} className={`hire-place${value === host.id ? ' on' : ''}`} onClick={() => onChange(host.id)} data-place={mine ? 'mine' : 'shared'}>
            <span className="row" style={{ gap: 8 }}>
              <span className="strong grow">{mine ? 'In my room' : severalShared ? `In the shared office · ${host.name}` : 'In the shared office'}</span>
              <Badge tone={problem ? 'warn' : 'good'}>{problem ? 'offline' : 'online'}</Badge>
            </span>
            <span className="small muted">
              {mine
                ? `On this computer (${host.name}). Yours: your folders and your Claude account. Others see them in your room; only you and the owners can work with them.`
                : `On the server (${host.name}). Everyone in the office can work with them; they use the server's folders and its Claude account.`}
            </span>
            <span className="small faint">
              {count(host.id)} there now{problem ? ` · ${problem}` : ''}
            </span>
          </button>
        ))}
        {places.length === 0 && <div className="card small bad">No machine is available to hire on.</div>}
      </div>
      {myRoomUnavailable && only !== 'shared' && <div className="small faint">My room is not offered: {myRoomUnavailable}</div>}
    </div>
  );
}

/** The table a desk of the shared office belongs to: desks are named `<table>-a` … `<table>-h`. */
const tableOf = (deskId: string): string => deskId.replace(/-[a-z]$/, '');

/**
 * Which desk they get. In the shared office: any free desk, shown table by table as they stand. In one's own room:
 * a seat there (the room grows to hold it). "Automatic" is always there: next to their project's people, or the next free seat.
 */
export function DeskPicker({ place, value, onChange }: { place: HirePlace; value: string | null; onChange: (deskId: string | null) => void }) {
  const layout = useOffice((s) => s.layout);
  const employees = useOffice((s) => s.employees);
  const active = useMemo(() => Object.values(employees).filter((e) => !e.archived), [employees]);
  const occupant = (deskId: string) => active.find((e) => e.deskId === deskId);

  const auto = (
    <button type="button" className={`desk-auto${value === null ? ' on' : ''}`} onClick={() => onChange(null)} aria-pressed={value === null}>
      Automatic
    </button>
  );

  if (place.mine) {
    const here = active.filter((e) => e.hostId === place.host.id);
    const chosen = here.map((e) => memberSeatOf(e.deskId)?.n ?? 0);
    // The seats the room has now, and one more pair to grow into.
    const seats = Math.min(MEMBER_ROOM_LIMITS.desks, Math.max(2, Math.ceil((here.length + 1) / 2) * 2, place.host.room?.desks ?? 0, ...chosen) + 2);
    return (
      <div className="col" style={{ gap: 8 }}>
        <div className="row row-wrap" style={{ gap: 6 }}>
          {auto}
          <span className="small faint">or a seat in your room — it grows when you pick one beyond its last desk</span>
        </div>
        <div className="desk-tables">
          {Array.from({ length: Math.ceil(seats / 4) }, (_x, pod) => (
            <div key={pod} className="desk-table" aria-label={`Table ${pod + 1}`}>
              <div className="small faint">Table {pod + 1}</div>
              <div className="desk-seats">
                {[1, 2, 3, 4].map((k) => {
                  const n = pod * 4 + k;
                  if (n > seats) return <span key={k} />;
                  const id = memberSeatId(place.host.id, n);
                  const who = occupant(id);
                  return (
                    <button key={k} type="button" className={`desk-seat${value === id ? ' on' : ''}${who ? ' taken' : ''}`} disabled={!!who} onClick={() => onChange(id)} title={who ? `${who.name} sits here` : `Seat ${n}`} data-desk={id}>
                      {who ? who.name.slice(0, 8) : n}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        {here.some((e) => !memberSeatOf(e.deskId)) && <div className="small faint">People without a chosen seat ({here.filter((e) => !memberSeatOf(e.deskId)).map((e) => e.name).join(', ')}) take the free seats in order.</div>}
      </div>
    );
  }

  const tables = new Map<string, string[]>();
  for (const d of layout?.desks ?? []) {
    if (d.kind === 'executive') continue;
    tables.set(tableOf(d.id), [...(tables.get(tableOf(d.id)) ?? []), d.id]);
  }
  const free = [...tables.values()].flat().filter((id) => !occupant(id)).length;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row row-wrap" style={{ gap: 6 }}>
        {auto}
        <span className="small faint">
          or pick a free desk — {free} free. Automatic seats them with their project's people.
        </span>
      </div>
      <div className="desk-tables">
        {[...tables.entries()].map(([table, ids]) => (
          <div key={table} className="desk-table" aria-label={`Table ${table}`}>
            <div className="small faint truncate">{layout?.podLabels?.[table] || `Table ${table.toUpperCase()}`}</div>
            <div className="desk-seats">
              {ids.map((id) => {
                const who = occupant(id);
                return (
                  <button key={id} type="button" className={`desk-seat${value === id ? ' on' : ''}${who ? ' taken' : ''}`} disabled={!!who} onClick={() => onChange(id)} title={who ? `${who.name} sits here` : `Desk ${id}`} data-desk={id}>
                    {who ? who.name.slice(0, 8) : id.slice(-1).toUpperCase()}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {free === 0 && <div className="small bad">Every desk is taken. Add a table in Office → Who sits where, or hire them without a desk (Automatic).</div>}
    </div>
  );
}
