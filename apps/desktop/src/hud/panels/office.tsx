import { Seating } from './seating.tsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { OfficeLayout } from '@orchestrator/contracts';
import { DESK_SIZE, decorationBox, decorationKind, deskSeat, unlockedUpgrades } from '@orchestrator/contracts';
import { addDecoration, deskPods, movableEdges, moveDecoration, moveDesks, ownerPosition, placeableDecorations, removeDecoration, renameRoom, resizeRoom, type EditResult } from '@orchestrator/office-3d';
import { Badge, Button, Stat, Window } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { registerPanel } from './index.tsx';

type Selection = { kind: 'pod'; id: string } | { kind: 'decoration'; id: string } | { kind: 'room'; id: string } | null;
type Edge = 'n' | 's' | 'e' | 'w';
const EDGE_LABEL: Record<Edge, string> = { n: 'North wall', s: 'South wall', w: 'West wall', e: 'East wall' };
const STEP = 0.5;

/**
 * The floor plan, editable: desk pods and decorations are moved by dragging them or with the
 * arrow buttons, decorations are added and removed, rooms are renamed and their inner walls moved.
 * Every change is checked against the same world the 3D office is built from (walls, furniture,
 * walkability) and is then stored through the layout API — the office in 3D follows at once.
 */
function FloorPlan({ layout, unlocked }: { layout: OfficeLayout; unlocked: Set<string> }) {
  const employees = useOffice((s) => s.employees);
  const [sel, setSel] = useState<Selection>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState('plant');
  const [name, setName] = useState('');
  const [drag, setDrag] = useState<{ sel: NonNullable<Selection>; from: { x: number; z: number }; dx: number; dz: number; ok: boolean } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const pods = useMemo(() => deskPods(layout.desks), [layout.desks]);
  const rooms = layout.rooms.filter((r) => !r.requires || unlocked.has(r.requires));
  const decorations = layout.decorations.filter((d) => !d.requires || unlocked.has(d.requires));
  const seated = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of Object.values(employees)) if (!e.archived && e.deskId) m.set(e.deskId, e.name);
    return m;
  }, [employees]);
  const pod = sel?.kind === 'pod' ? pods.find((p) => p.id === sel.id) : undefined;
  const decoration = sel?.kind === 'decoration' ? decorations.find((d) => d.id === sel.id) : undefined;
  const room = sel?.kind === 'room' ? rooms.find((r) => r.id === sel.id) : undefined;
  useEffect(() => setName(room?.name ?? ''), [room?.id, room?.name]);
  // Something selected that no longer exists (a removed decoration, a pod that merged with another): nothing is selected.
  useEffect(() => {
    if (sel && !pod && !decoration && !room) setSel(null);
  }, [sel, pod, decoration, room]);

  /** Store an edit that the rules accepted; say why when they refused it. */
  const commit = async (result: EditResult, done: string): Promise<boolean> => {
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    setError(null);
    setBusy(true);
    const saved = await act(() => api<OfficeLayout>('PUT', '/layout', result.layout), done);
    // The server's answer is the new layout; taking it at once means the next nudge starts from it.
    if (saved) useOffice.setState({ layout: saved });
    setBusy(false);
    return !!saved;
  };
  const moveSelected = (target: NonNullable<Selection>, dx: number, dz: number): EditResult => {
    if (target.kind === 'pod') return moveDesks(layout, unlocked, pods.find((p) => p.id === target.id)?.deskIds ?? [], dx, dz);
    if (target.kind === 'decoration') return moveDecoration(layout, unlocked, target.id, dx, dz);
    return { ok: false, error: 'rooms are resized, not moved' };
  };
  const nudge = (dx: number, dz: number) => sel && void commit(moveSelected(sel, dx, dz), sel.kind === 'pod' ? 'Desk pod moved' : 'Decoration moved');

  // Dragging on the plan: the thing follows the pointer in quarter-metre steps, green where it may stand and red where it may not.
  const toWorld = (ev: { clientX: number; clientY: number }) => {
    const m = svg.current?.getScreenCTM();
    if (!m) return { x: 0, z: 0 };
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    return { x: p.x, z: p.y };
  };
  const startDrag = (target: NonNullable<Selection>) => (ev: React.PointerEvent) => {
    ev.stopPropagation();
    setSel(target);
    setError(null);
    if (busy || target.kind === 'room') return;
    (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
    setDrag({ sel: target, from: toWorld(ev), dx: 0, dz: 0, ok: true });
  };
  const onMove = (ev: React.PointerEvent) => {
    if (!drag) return;
    const p = toWorld(ev);
    const dx = Math.round((p.x - drag.from.x) * 4) / 4;
    const dz = Math.round((p.z - drag.from.z) * 4) / 4;
    if (dx === drag.dx && dz === drag.dz) return;
    setDrag({ ...drag, dx, dz, ok: moveSelected(drag.sel, dx, dz).ok });
  };
  const endDrag = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.dx || d.dz) void commit(moveSelected(d.sel, d.dx, d.dz), d.sel.kind === 'pod' ? 'Desk pod moved' : 'Decoration moved');
  };
  const offset = (target: NonNullable<Selection>) => (drag && drag.sel.kind === target.kind && drag.sel.id === target.id ? `translate(${drag.dx} ${drag.dz})` : undefined);
  const dragClass = (target: NonNullable<Selection>) => (drag && drag.sel.kind === target.kind && drag.sel.id === target.id ? (drag.ok ? 'plan-drag-ok' : 'plan-drag-bad') : '');
  const isSel = (k: NonNullable<Selection>['kind'], id: string) => sel?.kind === k && sel.id === id;

  const kinds = placeableDecorations(unlocked);
  const add = async () => {
    // A step in front of where the owner stands in the office, and never on top of them.
    const near = { x: ownerPosition.x + Math.sin(ownerPosition.rot) * 1.5, z: ownerPosition.z + Math.cos(ownerPosition.rot) * 1.5 };
    const result = addDecoration(layout, unlocked, kind, near, { x: ownerPosition.x, z: ownerPosition.z });
    if (await commit(result, `${decorationKind(kind)?.label ?? 'Decoration'} added near where you stand`)) if (result.ok && result.id) setSel({ kind: 'decoration', id: result.id });
  };
  const edges = room ? movableEdges(layout, room.id) : [];
  const names = (ids: string[]) => ids.map((id) => seated.get(id)).filter(Boolean);

  return (
    <div>
      <div className="section-title">Floor plan</div>
      <div className="plan-wrap">
        <svg ref={svg} className="minimap plan" viewBox={`${-layout.width / 2} ${-layout.depth / 2} ${layout.width} ${layout.depth}`} role="group" aria-label="Editable floor plan" onPointerMove={onMove} onPointerUp={endDrag} onPointerLeave={endDrag} onPointerDown={() => setSel(null)}>
          {rooms
            .filter((r) => r.kind !== 'hall')
            .map((r) => (
              <g key={r.id} data-room={r.id} className={`plan-room ${r.open ? 'plan-room-open' : ''} ${isSel('room', r.id) ? 'plan-sel' : ''}`} onPointerDown={startDrag({ kind: 'room', id: r.id })}>
                <rect x={r.x} y={r.z} width={r.w} height={r.d} />
                <text x={r.open ? r.x + r.w - 0.45 : r.x + 0.45} y={r.open ? r.z + r.d - 0.45 : r.z + 0.95} textAnchor={r.open ? 'end' : 'start'}>
                  {r.name}
                </text>
              </g>
            ))}
          {decorations.map((d) => {
            const box = decorationBox(d) ?? { minX: d.x - 0.3, maxX: d.x + 0.3, minZ: d.z - 0.3, maxZ: d.z + 0.3 };
            const target = { kind: 'decoration' as const, id: d.id };
            return (
              <g key={d.id} data-decoration={d.id} className={`plan-decor plan-decor-${d.kind} ${isSel('decoration', d.id) ? 'plan-sel' : ''} ${dragClass(target)}`} transform={offset(target)} onPointerDown={startDrag(target)}>
                <title>{`${decorationKind(d.kind)?.label ?? d.kind} (${d.id})`}</title>
                {d.kind === 'plant' || d.kind === 'floor_lamp' ? <circle cx={d.x} cy={d.z} r={0.38} /> : <rect x={box.minX} y={box.minZ} width={box.maxX - box.minX} height={Math.max(0.3, box.maxZ - box.minZ)} rx={0.08} />}
              </g>
            );
          })}
          {pods.map((p) => {
            const target = { kind: 'pod' as const, id: p.id };
            return (
              <g key={p.id} data-pod={p.id} className={`plan-pod ${isSel('pod', p.id) ? 'plan-sel' : ''} ${dragClass(target)}`} transform={offset(target)} onPointerDown={startDrag(target)}>
                <title>{`Desk pod ${p.id} — ${p.deskIds.length} desks`}</title>
                <rect className="plan-pod-hit" x={p.box.minX - 0.5} y={p.box.minZ - 0.9} width={p.box.maxX - p.box.minX + 1} height={p.box.maxZ - p.box.minZ + 1.8} rx={0.3} />
                {layout.desks
                  .filter((d) => p.deskIds.includes(d.id))
                  .map((d) => {
                    const seat = deskSeat(d);
                    return (
                      <g key={d.id}>
                        <rect className="plan-desk" x={d.x - DESK_SIZE.w / 2} y={d.z - DESK_SIZE.d / 2} width={DESK_SIZE.w} height={DESK_SIZE.d} rx={0.08} />
                        <circle className={seated.has(d.id) ? 'plan-seat plan-seat-on' : 'plan-seat'} cx={seat.x} cy={seat.z} r={0.27} />
                      </g>
                    );
                  })}
              </g>
            );
          })}
        </svg>
        <div className="plan-side col" style={{ gap: 10 }}>
          <label className="field">
            <span className="small muted">Selected</span>
            <select
              aria-label="Selected item"
              value={sel ? `${sel.kind}:${sel.id}` : ''}
              onChange={(ev) => {
                const [k, ...rest] = ev.target.value.split(':');
                setError(null);
                setSel(k ? ({ kind: k, id: rest.join(':') } as Selection) : null);
              }}
            >
              <option value="">Nothing — click the plan</option>
              <optgroup label="Desk pods">
                {pods.map((p) => (
                  <option key={p.id} value={`pod:${p.id}`}>
                    Pod {p.id.replace(/-[a-z]$/, '')} · {p.deskIds.length} desks
                  </option>
                ))}
              </optgroup>
              <optgroup label="Decorations">
                {decorations.map((d) => (
                  <option key={d.id} value={`decoration:${d.id}`}>
                    {decorationKind(d.kind)?.label ?? d.kind} · {d.id}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Rooms">
                {rooms.map((r) => (
                  <option key={r.id} value={`room:${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>

          {(pod || decoration) && (
            <div className="col" style={{ gap: 6 }}>
              <div className="strong">{pod ? `Desk pod ${pod.id.replace(/-[a-z]$/, '')}` : `${decorationKind(decoration!.kind)?.label ?? decoration!.kind}`}</div>
              <div className="small muted">
                {pod
                  ? `${pod.deskIds.length} desks${names(pod.deskIds).length ? ` · ${names(pod.deskIds).join(', ')} sit here and move with it` : ' · nobody sits here'}`
                  : decoration!.requires
                    ? 'A milestone reward: it can be moved, not removed.'
                    : `At ${decoration!.x.toFixed(1)}, ${decoration!.z.toFixed(1)}`}
              </div>
              <div className="plan-nudge" role="group" aria-label="Move the selection">
                <button className="btn btn-sm" disabled={busy} aria-label="Move north" title={`Move ${STEP} m north`} onClick={() => nudge(0, -STEP)}>
                  ↑
                </button>
                <button className="btn btn-sm" disabled={busy} aria-label="Move west" title={`Move ${STEP} m west`} onClick={() => nudge(-STEP, 0)}>
                  ←
                </button>
                <button className="btn btn-sm" disabled={busy} aria-label="Move east" title={`Move ${STEP} m east`} onClick={() => nudge(STEP, 0)}>
                  →
                </button>
                <button className="btn btn-sm" disabled={busy} aria-label="Move south" title={`Move ${STEP} m south`} onClick={() => nudge(0, STEP)}>
                  ↓
                </button>
              </div>
              {decoration && (
                <div className="row">
                  <Button small disabled={busy} onClick={() => void commit(moveDecoration(layout, unlocked, decoration.id, 0, 0, Math.PI / 2), 'Decoration turned')}>
                    Turn
                  </Button>
                  <Button small variant="danger" disabled={busy || !!decoration.requires} onClick={() => void commit(removeDecoration(layout, decoration.id), 'Decoration removed')}>
                    Remove decoration
                  </Button>
                </div>
              )}
              <div className="small faint">Drag it on the plan, or move it half a metre at a time. Places where it would stand in a wall, in furniture or in someone's way are refused.</div>
            </div>
          )}

          {room && (
            <div className="col" style={{ gap: 6 }}>
              <div className="strong">{room.name}</div>
              <div className="small muted">
                {room.w.toFixed(1)} × {room.d.toFixed(1)} m
              </div>
              <form
                className="row"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void commit(renameRoom(layout, room.id, name), 'Room renamed');
                }}
              >
                <input aria-label="Room name" className="grow" value={name} maxLength={40} onChange={(ev) => setName(ev.target.value)} />
                <Button small type="submit" disabled={busy || !name.trim() || name.trim() === room.name}>
                  Rename
                </Button>
              </form>
              {edges.length === 0 ? (
                <div className="small faint">{room.open ? 'An open area has no walls of its own: it grows and shrinks with the rooms around it.' : 'None of its walls can move: they are outer walls or shared with a longer room.'}</div>
              ) : (
                edges.map((e) => {
                  const along = e === 'n' || e === 's';
                  return (
                    <div key={e} className="row plan-wall">
                      <span className="small grow">{EDGE_LABEL[e]}</span>
                      <button className="btn btn-sm" disabled={busy} aria-label={`Move the ${EDGE_LABEL[e].toLowerCase()} ${along ? 'north' : 'west'}`} title={`${STEP} m ${along ? 'north' : 'west'}`} onClick={() => void commit(resizeRoom(layout, unlocked, room.id, e, -STEP), 'Wall moved')}>
                        {along ? '↑' : '←'}
                      </button>
                      <button className="btn btn-sm" disabled={busy} aria-label={`Move the ${EDGE_LABEL[e].toLowerCase()} ${along ? 'south' : 'east'}`} title={`${STEP} m ${along ? 'south' : 'east'}`} onClick={() => void commit(resizeRoom(layout, unlocked, room.id, e, STEP), 'Wall moved')}>
                        {along ? '↓' : '→'}
                      </button>
                    </div>
                  );
                })
              )}
              <div className="small faint">A wall between two rooms moves for both, and the furniture follows the room.</div>
            </div>
          )}

          {!sel && <div className="small faint">Click a desk pod, a decoration or a room on the plan — or pick it from the list — to move, turn, rename or resize it.</div>}
          {error && (
            <div className="small bad" role="alert">
              Not possible: {error}.
            </div>
          )}

          <div className="col plan-add" style={{ gap: 6 }}>
            <div className="small muted">Add a decoration</div>
            <div className="row">
              <select aria-label="Decoration to add" className="grow" value={kind} onChange={(ev) => setKind(ev.target.value)}>
                {kinds.map((k) => (
                  <option key={k.kind} value={k.kind} disabled={!!k.locked}>
                    {k.label}
                    {k.locked ? ` — milestone reward (${k.locked.replace(/_/g, ' ')})` : ''}
                  </option>
                ))}
              </select>
              <Button small variant="primary" disabled={busy} onClick={add}>
                Add decoration
              </Button>
            </div>
            <div className="small faint">It is put on the free floor nearest to where you stand in the office; move it from there.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Customising the office itself: desks, capacity, and what company milestones have unlocked. */
function OfficePanel({ onClose }: { arg: string | null; onClose: () => void }) {
  const s = useOffice();
  const qc = useQueryClient();
  const capacity = useQuery({ queryKey: ['layout-capacity', s.layout?.version], queryFn: () => api<{ desks: number; freePodSlots: number }>('GET', '/layout/capacity') });
  if (!s.layout) return null;
  const employees = Object.values(s.employees).filter((e) => !e.archived);
  const occupied = new Map(employees.filter((e) => e.deskId).map((e) => [e.deskId!, e]));
  const free = s.layout.desks.filter((d) => !occupied.has(d.id));
  const refresh = () => void qc.invalidateQueries({ queryKey: ['layout-capacity'] });
  const unlocked = new Set(unlockedUpgrades(s.milestones));
  return (
    <Window title="Office" subtitle="Floor plan, desks, decorations and upgrades" onClose={onClose} width={940}>
      <div className="col" style={{ gap: 14 }}>
        <div className="grid3">
          <Stat label="Desks" value={s.layout.desks.length} sub={`${free.length} free`} />
          <Stat label="Employees" value={employees.length} sub={`${employees.filter((e) => !e.deskId).length} without a desk`} tone={employees.some((e) => !e.deskId) ? 'warn' : undefined} />
          <Stat label="Room for pods" value={capacity.data?.freePodSlots ?? '—'} sub="four desks each" />
        </div>
        <div className="row">
          <Button variant="primary" disabled={!capacity.data?.freePodSlots} onClick={() => act(() => api('POST', '/layout/pods', {}), 'A new pod of four desks was added to the engineering floor').then(refresh)}>
            Add a desk pod
          </Button>
          <span className="small muted">New desks appear on the engineering floor immediately. Employees without a desk are seated automatically.</span>
        </div>
        <Seating layout={s.layout} />
        <FloorPlan layout={s.layout} unlocked={unlocked} />
        <div>
          <div className="section-title">Free desks</div>
          {free.length === 0 ? (
            <div className="small muted">Every desk is taken.</div>
          ) : (
            <div className="row row-wrap">
              {free.map((d) => (
                <span key={d.id} className="badge badge-muted" style={{ gap: 6 }}>
                  <span className="mono">{d.id}</span>
                  <button className="btn btn-ghost btn-sm" style={{ height: 18, padding: '0 4px' }} title="Remove this empty desk" onClick={() => window.confirm(`Remove empty desk ${d.id}?`) && act(() => api('DELETE', `/layout/desks/${d.id}`), 'Desk removed').then(refresh)}>
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="small faint" style={{ marginTop: 6 }}>
            To move someone, drag them in “Who sits where” above — or, in the office, right-click them → Move to another desk.
          </div>
        </div>
        {s.settings?.gamification && (
          <div>
            <div className="section-title">Upgrades from company milestones</div>
            <div className="col" style={{ gap: 6 }}>
              {s.milestones
                .filter((m) => m.unlocks)
                .map((m) => (
                  <div key={m.key} className="row card" style={{ padding: '8px 10px' }}>
                    <div className="grow">
                      <div className="strong">{m.unlocks!.replace(/_/g, ' ')}</div>
                      <div className="small muted">
                        {m.title} — {m.description}
                      </div>
                    </div>
                    <Badge tone={m.unlockedAt ? 'good' : 'muted'}>{m.unlockedAt ? `unlocked ${new Date(m.unlockedAt).toLocaleDateString()}` : 'locked'}</Badge>
                  </div>
                ))}
            </div>
            <div className="small faint" style={{ marginTop: 6 }}>
              Milestones are reached only by verified work (tasks that passed Orchestrator's own checks).
            </div>
          </div>
        )}
      </div>
    </Window>
  );
}

registerPanel('office', OfficePanel);
