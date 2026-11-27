import { useState } from 'react';
import type { Employee, OfficeLayout } from '@orchestrator/contracts';
import { Avatar, Button } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';

const podOf = (deskId: string): string => deskId.replace(/-[a-z]$/, '');

/**
 * A table's seats the way they stand in the office: the row on the far side first, then the row facing it, each from
 * left to right — so the card looks like the table seen from above. A place in the grid with no desk is `null`.
 */
export function seatsAsTheyStand(desks: OfficeLayout['desks']): { columns: number; cells: Array<OfficeLayout['desks'][number] | null> } {
  const round = (n: number) => Math.round(n * 10) / 10;
  const xs = [...new Set(desks.map((d) => round(d.x)))].sort((a, b) => a - b);
  const zs = [...new Set(desks.map((d) => round(d.z)))].sort((a, b) => a - b);
  // Anything that is not a plain grid (a table somebody rearranged by hand) is shown in the order of its seats.
  if (xs.length * zs.length > 12 || xs.length > 4) return { columns: 2, cells: desks };
  const cells = zs.flatMap((z) => xs.map((x) => desks.find((d) => round(d.x) === x && round(d.z) === z) ?? null));
  return { columns: Math.max(1, xs.length), cells };
}

/**
 * Who sits where. Every table (a desk pod) is a card: what is written on it, its seats and who
 * is in each. Drag a person onto another seat to move them (onto someone else: the two swap),
 * or onto "No desk" to stand them up. Only where people are shown changes — never their work.
 */
export function Seating({ layout }: { layout: OfficeLayout }) {
  const employees = useOffice((s) => s.employees);
  const projects = useOffice((s) => s.projects);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const people = Object.values(employees).filter((e) => !e.archived);
  const at = new Map(people.filter((e) => e.deskId).map((e) => [e.deskId!, e]));
  const pods = new Map<string, OfficeLayout['desks']>();
  for (const d of layout.desks) {
    if (d.kind === 'executive') continue;
    const list = pods.get(podOf(d.id)) ?? [];
    list.push(d);
    pods.set(podOf(d.id), list);
  }
  // Someone in a member's own room has a seat there (the room is that member's to arrange), so they are not "without a desk".
  const hosts = useOffice((s) => s.hosts);
  const inRooms = people.filter((e) => !!hosts[e.hostId ?? '']?.memberId);
  const standing = people.filter((e) => !hosts[e.hostId ?? '']?.memberId && (!e.deskId || !layout.desks.some((d) => d.id === e.deskId)));

  const move = (employeeId: string, deskId: string | null) => {
    const who = employees[employeeId];
    if (!who || (who.deskId ?? null) === deskId) return;
    const there = deskId ? at.get(deskId) : undefined;
    void act(() => api('PATCH', `/employees/${employeeId}`, { deskId }), deskId ? (there ? `${who.name} and ${there.name} swapped seats` : `${who.name} moved`) : `${who.name} has no desk now`);
  };
  const dropOn = (target: string) => ({
    onDragOver: (ev: React.DragEvent) => {
      if (!drag) return;
      ev.preventDefault();
      setOver(target);
    },
    onDragLeave: () => setOver((o) => (o === target ? null : o)),
    onDrop: (ev: React.DragEvent) => {
      ev.preventDefault();
      const id = ev.dataTransfer.getData('text/orch-employee') || drag;
      setDrag(null);
      setOver(null);
      if (id) move(id, target === 'none' ? null : target);
    },
  });
  const chip = (e: Employee) => (
    <span
      className="seat-chip"
      draggable
      data-employee={e.name}
      onDragStart={(ev) => {
        ev.dataTransfer.setData('text/orch-employee', e.id);
        ev.dataTransfer.effectAllowed = 'move';
        setDrag(e.id);
      }}
      onDragEnd={() => {
        setDrag(null);
        setOver(null);
      }}
      title={`${e.name} — ${e.title}${e.projectId && projects[e.projectId] ? ` · ${projects[e.projectId]!.name}` : ''}. Drag to another seat.`}
    >
      <Avatar appearance={e.appearance} size={18} />
      <span className="truncate">{e.name}</span>
    </span>
  );

  return (
    <div>
      <div className="small muted" style={{ marginBottom: 8 }}>
        Drag a person to another seat. Dropping onto someone swaps the two. Each table can carry a label and have between one and six seats.
      </div>
      <div className="seat-tables">
        {[...pods.entries()].map(([pod, desks]) => {
          const saved = layout.podLabels?.[pod] ?? '';
          const text = labels[pod] ?? saved;
          const seated = desks.filter((d) => at.has(d.id)).length;
          const stand = seatsAsTheyStand(desks);
          return (
            <div key={pod} className="seat-table" data-pod={pod}>
              <div className="row" style={{ gap: 6 }}>
                <input
                  value={text}
                  maxLength={40}
                  placeholder={`Table ${pod} — write something on it`}
                  aria-label={`Label of table ${pod}`}
                  onChange={(ev) => setLabels({ ...labels, [pod]: ev.target.value })}
                  onBlur={() => text.trim() !== saved && void act(() => api('PUT', `/layout/pods/${pod}/label`, { label: text }), text.trim() ? 'Written on the table' : 'Label removed')}
                  onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()}
                />
                <span className="small faint" style={{ flex: 'none' }} title="Seated / seats">
                  {seated}/{desks.length}
                </span>
              </div>
              <div className="seat-grid" style={{ gridTemplateColumns: `repeat(${stand.columns}, minmax(0, 1fr))` }}>
                {stand.cells.map((d, i) => {
                  if (!d) return <div key={`gap-${i}`} className="seat seat-gap" aria-hidden="true" />;
                  const e = at.get(d.id);
                  return (
                    <div key={d.id} className={`seat ${over === d.id ? 'seat-over' : ''} ${e ? '' : 'seat-empty'}`} data-desk={d.id} {...dropOn(d.id)}>
                      {e ? (
                        chip(e)
                      ) : (
                        <>
                          <span className="small faint">empty</span>
                          <button className="seat-x" title="Remove this empty seat" aria-label={`Remove seat ${d.id}`} onClick={() => void act(() => api('DELETE', `/layout/desks/${d.id}`), 'Seat removed')}>
                            ✕
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              <Button small variant="ghost" disabled={desks.length >= 6} title={desks.length >= 6 ? 'A table has at most six seats' : 'Add a seat to this table'} onClick={() => void act(() => api('POST', `/layout/pods/${pod}/desks`, {}), 'A seat was added')}>
                + seat
              </Button>
              {seated === 0 && (
                <Button small variant="ghost" title="Take this empty table off the floor. It can be put back with “Add a table”." onClick={() => void act(() => api('POST', '/layout/desks/remove', { ids: desks.map((d) => d.id) }), 'Table removed')}>
                  Remove table
                </Button>
              )}
            </div>
          );
        })}
        <div className={`seat-table seat-none ${over === 'none' ? 'seat-over' : ''}`} {...dropOn('none')}>
          <div className="strong small">No desk</div>
          <div className="small faint">Drop someone here to stand them up; drag from here to seat them.</div>
          <div className="row row-wrap" style={{ gap: 6 }}>
            {standing.map((e) => (
              <span key={e.id}>{chip(e)}</span>
            ))}
            {standing.length === 0 && <span className="small faint">Everyone has a seat.</span>}
          </div>
        </div>
        {inRooms.length > 0 && (
          <div className="seat-table" data-in-rooms>
            <div className="strong small">In members' own rooms</div>
            <div className="small faint">They sit in the room of the computer they run on; its member arranges it (My room).</div>
            <div className="row row-wrap" style={{ gap: 6 }}>
              {inRooms.map((e) => (
                <span key={e.id} className="seat-chip" title={`${e.name} — on ${hosts[e.hostId ?? '']?.memberName ?? 'a member'}'s computer`}>
                  <Avatar appearance={e.appearance} size={18} />
                  <span className="truncate">{e.name}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
