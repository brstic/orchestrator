import { useEffect, useMemo, useRef, useState } from 'react';
import type { Employee, MemberRoomFurniture, MemberRoomPrefs } from '@orchestrator/contracts';
import { ACTIVITY_LABEL, MEMBER_ROOM_FURNITURE, MEMBER_ROOM_LIMITS } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Empty, Field, Window } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { sessionOfEmployee, useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { BulkHire } from './bulk-hire.tsx';
import { OutsideTmux } from './ssh-links.tsx';

const COLORS = ['#e0a23a', '#4fb6a8', '#d0698c', '#7c8fe0', '#8cbf5a', '#d9774a', '#b8a078', '#5a6b8c', '#8a5fbf', '#3f8f5a'];
const FURNITURE: Record<MemberRoomFurniture, string> = { plant: 'Plant', bookshelf: 'Bookshelf', sofa: 'Sofa', floor_lamp: 'Floor lamp' };

/**
 * How the member wants their room: bigger, another colour, a name of its own, what stands in it. Saved as they
 * change it and seen by everyone in the office at once. The room only ever grows away from the building, so the
 * neighbours' rooms do not move.
 */
function RoomEditor({ current, minDesks, memberName }: { current: MemberRoomPrefs | null; minDesks: number; memberName: string }) {
  const [prefs, setPrefs] = useState<MemberRoomPrefs>(current ?? {});
  const [saved, setSaved] = useState<'saved' | 'saving' | 'error'>('saved');
  const timer = useRef<number | null>(null);
  const latest = useRef(prefs);
  // What the office has (another window of mine changed it) replaces what is shown, unless a change of mine is on its way.
  useEffect(() => {
    if (saved === 'saved') setPrefs(current ?? {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(current ?? {})]);
  const change = (patch: Partial<MemberRoomPrefs>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setPrefs(next);
    setSaved('saving');
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      api<MemberRoomPrefs>('PUT', '/me/room', latest.current).then(
        () => setSaved('saved'),
        (e) => {
          setSaved('error');
          useOffice.getState().toast((e as Error).message, 'error');
        },
      );
    }, 350);
  };
  const desks = Math.max(minDesks, prefs.desks ?? 2);
  const extra = prefs.extraDepth ?? 0;
  const furniture = prefs.furniture ?? ['plant', 'bookshelf'];
  return (
    <div className="card col room-editor" style={{ gap: 10 }}>
      <div className="row">
        <span className="section-title grow" style={{ margin: 0 }}>
          Arrange my room
        </span>
        <span className="small faint">{saved === 'saving' ? 'saving…' : saved === 'error' ? 'not saved' : 'saved · everyone sees it'}</span>
      </div>
      <div className="grid2">
        <Field label="Name on the door" hint={`Empty: ${memberName.toUpperCase()}'S ROOM`}>
          <input value={prefs.title ?? ''} maxLength={28} placeholder={`${memberName}'s room`} onChange={(ev) => change({ title: ev.target.value })} aria-label="Name on the door" />
        </Field>
        <Field label="Colour">
          <div className="row row-wrap" style={{ gap: 6 }}>
            {COLORS.map((c) => (
              <button key={c} type="button" className={`room-swatch${prefs.color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => change({ color: c })} aria-label={`Colour ${c}`} title={c} />
            ))}
            <input type="color" value={prefs.color ?? '#e0a23a'} onChange={(ev) => change({ color: ev.target.value })} aria-label="Any colour" title="Any colour" style={{ width: 34, height: 26, padding: 0 }} />
          </div>
        </Field>
        <Field label={`Desks: ${desks}`} hint={`By pairs, up to ${MEMBER_ROOM_LIMITS.desks}. Never fewer than your employees need (${minDesks}).`}>
          <input type="range" min={2} max={MEMBER_ROOM_LIMITS.desks} step={2} value={desks} onChange={(ev) => change({ desks: Math.max(minDesks, Number(ev.target.value)) })} aria-label="Desks" />
        </Field>
        <Field label={`Open floor behind the desks: ${extra} m`} hint="Room to walk around, and where a sofa fits (from 2 m).">
          <input type="range" min={0} max={MEMBER_ROOM_LIMITS.extraDepth} step={0.5} value={extra} onChange={(ev) => change({ extraDepth: Number(ev.target.value) })} aria-label="Open floor" />
        </Field>
      </div>
      <Field label="In the room">
        <div className="row row-wrap" style={{ gap: 12 }}>
          {MEMBER_ROOM_FURNITURE.map((k) => (
            <label key={k} className="check small" style={{ alignItems: 'center' }}>
              <input type="checkbox" checked={furniture.includes(k)} onChange={(ev) => change({ furniture: MEMBER_ROOM_FURNITURE.filter((x) => (x === k ? ev.target.checked : furniture.includes(x))) })} style={{ marginTop: 0 }} />
              {FURNITURE[k]}
              {k === 'sofa' && extra < 2 && furniture.includes('sofa') ? <span className="faint"> (needs 2 m of open floor)</span> : null}
            </label>
          ))}
        </div>
      </Field>
      <div className="row">
        <span className="small faint grow">The room grows away from the building, so nobody else's room moves. It is in the office while you are.</span>
        <Button small variant="ghost" onClick={() => change({ title: null, color: null, desks: null, extraDepth: null, furniture: null })}>
          Back to how it came
        </Button>
      </div>
    </div>
  );
}

/**
 * A member's own corner of the office: the sessions that run on their own computer. While they are
 * here their computer is one of the office's machines and their employees sit in their room; when
 * they leave, the room goes with them and the sessions wait in tmux on their computer.
 */
function MyRoomPanel({ onClose }: { arg: string | null; onClose: () => void }) {
  const me = useOffice((s) => s.me);
  const hosts = useOffice((s) => s.hosts);
  const employees = useOffice((s) => s.employees);
  const sessions = useOffice((s) => s.sessions);
  const myHost = useOffice((s) => s.myHost);
  const [adding, setAdding] = useState(false);
  // This computer, as the office knows it: the host the desktop app started, else any of mine that is online.
  const mine = useMemo(() => Object.values(hosts).filter((h) => !!me?.id && h.memberId === me.id && h.status !== 'revoked'), [hosts, me?.id]);
  const host = mine.find((h) => h.id === myHost.hostId) ?? mine.find((h) => h.status === 'online') ?? null;
  const online = host?.status === 'online';
  const people = useMemo(
    () =>
      Object.values(employees)
        .filter((e) => !e.archived && mine.some((h) => h.id === e.hostId))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [employees, mine],
  );
  const elsewhere = people.filter((e) => e.hostId !== host?.id);

  const status = online ? (
    <Badge tone="good">this computer is in the office</Badge>
  ) : myHost.state === 'starting' ? (
    <Badge tone="info">connecting this computer…</Badge>
  ) : (
    <Badge tone="muted">this computer is not in the office</Badge>
  );
  const start = (e: Employee) => act(() => api('POST', `/employees/${e.id}/start`, {}), `${e.name} is starting on your computer`);

  return (
    <Window title="My room" subtitle="Employees that run on your own computer" onClose={onClose} width={adding ? 1040 : 760}>
      <div className="col" style={{ gap: 14 }}>
        <div className="card col" style={{ gap: 6 }}>
          <div className="row">
            <span className="strong grow">{host?.name ?? 'Your computer'}</span>
            {status}
          </div>
          <div className="small muted">
            What runs here is yours: your folders, your Claude account. Others see your employees and what state they are in; only you and the owners can open their terminals or talk to them. When you leave, your room is locked and the sessions wait on your computer.</div>
          {!online && myHost.state === 'unavailable' && <div className="small bad">{myHost.reason}</div>}
          {!online && myHost.state === 'none' && <div className="small muted">Open this office with the Orchestrator desktop app to bring your computer in: a browser tab cannot run sessions.</div>}
        </div>

        {!adding && host && <RoomEditor current={host.room ?? null} minDesks={Math.max(2, Math.ceil(people.filter((e) => e.hostId === host.id).length / 2) * 2)} memberName={me?.name ?? 'My'} />}

        {adding && host && online ? (
          <div className="card">
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="section-title grow" style={{ margin: 0 }}>
                Add folders from this computer
              </span>
              <Button small variant="ghost" onClick={() => setAdding(false)}>
                Back
              </Button>
            </div>
            <BulkHire onlyHostId={host.id} onDone={() => setAdding(false)} />
          </div>
        ) : (
          <>
            <div>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="section-title grow" style={{ margin: 0 }}>
                  In my room ({people.length})
                </span>
                <Button small variant="primary" disabled={!online} title={online ? undefined : 'Your computer is not connected to the office right now'} onClick={() => setAdding(true)}>
                  Add folders…
                </Button>
              </div>
              {people.length === 0 && <Empty title="Nobody yet">Add a folder from this computer: one employee is hired for it and works there, on your machine.</Empty>}
              <div className="list">
                {people.map((e) => {
                  const s = sessionOfEmployee(sessions, e.id);
                  const live = s?.status === 'running';
                  return (
                    <div key={e.id} className="row my-room-row" style={{ padding: '6px 0', gap: 10 }}>
                      <Avatar appearance={e.appearance} size={30} />
                      <button className="pc-rowbtn grow" style={{ textAlign: 'left' }} onClick={() => useOffice.getState().openPanel('employee', e.id)}>
                        <span className="strong">{e.name}</span> <span className="small muted">{e.title}</span>
                        <div className="small faint mono truncate">{e.workingDir ?? 'no folder'}</div>
                      </button>
                      <Badge tone={live ? 'good' : 'muted'}>{live ? (ACTIVITY_LABEL[s!.activity] ?? s!.activity) : e.hostId === host?.id && online ? 'not started' : 'computer away'}</Badge>
                      {live ? (
                        <Button small onClick={() => useOffice.getState().openPanel('talk', e.id)}>
                          Talk
                        </Button>
                      ) : (
                        <Button small disabled={!(e.hostId === host?.id && online)} onClick={() => void start(e)}>
                          Start
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
              {elsewhere.length > 0 && host && <div className="small faint">{elsewhere.length} of these live on another computer of yours and wait for it.</div>}
            </div>
            {host && online && (
              <div>
                <div className="section-title">Claude sessions already running on this computer</div>
                <OutsideTmux host={host} />
              </div>
            )}
          </>
        )}
      </div>
    </Window>
  );
}

registerPanel('myroom', MyRoomPanel);
