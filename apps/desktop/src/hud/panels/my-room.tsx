import { useEffect, useMemo, useRef, useState } from 'react';
import type { Employee, MemberRoomFurniture, MemberRoomPrefs } from '@orchestrator/contracts';
import { MEMBER_ROOM_FURNITURE, MEMBER_ROOM_LIMITS } from '@orchestrator/contracts';
import { Avatar, Button, Field, Tabs, Window } from '@orchestrator/ui';
import { employeeState } from '../../lib/my-work.ts';
import { State } from './kit.tsx';
import { api } from '../../lib/api.ts';
import { sessionOfEmployee, useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { BulkHire } from './bulk-hire.tsx';
import { OutsideTmux } from './ssh-links.tsx';
import { MyServers } from './my-servers.tsx';

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
    <div className="k-stack room-editor">
      <div className="k-head">
        <div className="k-text">How your room looks to everybody in the office. It is saved as you change it, and grows away from the building, so nobody else's room moves.</div>
        <span className="k-sub">{saved === 'saving' ? 'saving…' : saved === 'error' ? 'not saved' : 'saved'}</span>
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
      <label className="check small room-lock" style={{ alignItems: 'flex-start' }}>
        <input type="checkbox" checked={prefs.locked === true} onChange={(ev) => change({ locked: ev.target.checked })} aria-label="Close my room" />
        <span>
          <span className="strong">Close my room.</span> Nobody but you — the owners of the office and the foreman included — can then open your employees' terminals, read what they say, talk to them, start or stop them, or walk in. Everyone still sees that they are there and whether they work. It covers your computer and the servers you keep to yourself, not a server you shared.
        </span>
      </label>
      <div className="k-actions">
        {/* How the room looks, not whether it is closed: that stays as it is. */}
        <Button small variant="ghost" className="k-quiet" onClick={() => change({ title: null, color: null, desks: null, extraDepth: null, furniture: null })}>
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
type RoomTab = 'people' | 'room' | 'servers';

function MyRoomPanel({ arg, onClose }: { arg: string | null; onClose: () => void }) {
  const me = useOffice((s) => s.me);
  const hosts = useOffice((s) => s.hosts);
  const employees = useOffice((s) => s.employees);
  const sessions = useOffice((s) => s.sessions);
  const myHost = useOffice((s) => s.myHost);
  const roomless = useOffice((s) => s.roomless);
  const [adding, setAdding] = useState(false);
  // What is mine alone: my computers, and the servers I brought in and keep to myself.
  const mine = useMemo(() => Object.values(hosts).filter((h) => !!me?.id && h.memberId === me.id && h.status !== 'revoked'), [hosts, me?.id]);
  // This computer, as the office knows it: the host the desktop app started, else any computer of mine that is online.
  const computers = mine.filter((h) => !h.ownerId);
  const host = computers.find((h) => h.id === myHost.hostId) ?? computers.find((h) => h.status === 'online') ?? null;
  /** Is the machine this employee lives on in the office right now? */
  const there = (e: Employee) => hosts[e.hostId ?? '']?.status === 'online';
  const online = host?.status === 'online';
  const people = useMemo(
    () =>
      Object.values(employees)
        .filter((e) => !e.archived && mine.some((h) => h.id === e.hostId))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [employees, mine],
  );
  const elsewhere = people.filter((e) => e.hostId !== host?.id && computers.some((h) => h.id === e.hostId));

  const start = (e: Employee) => act(() => api('POST', `/employees/${e.id}/start`, {}), `${e.name} is starting on ${hosts[e.hostId ?? '']?.ownerId ? hosts[e.hostId!]!.name : 'your computer'}`);
  const [tab, setTab] = useState<RoomTab>(arg === 'room' || arg === 'servers' ? arg : 'people');
  const member = !!me?.id && me.id !== 'owner' && me.role !== 'visitor';
  const servers = mine.filter((h) => !!h.ownerId).length;
  // The window's line: whether this computer is here — in the words everything else uses — and who is in the room.
  const line = (
    <span className="k-line">
      <State word={online ? 'this computer is in the office' : myHost.state === 'starting' ? 'connecting this computer…' : 'this computer is not in the office'} dot={online ? 'on' : myHost.state === 'starting' ? 'busy' : 'off'} />
      <span className="k-sub">
        {people.length} employee{people.length === 1 ? '' : 's'}
      </span>
    </span>
  );

  return (
    <Window
      kit
      title="My room"
      subtitle={line}
      onClose={onClose}
      width={adding ? 1040 : 860}
      flush
      actions={
        adding ? undefined : (
          <Button variant="primary" disabled={!online} title={online ? 'Hire an employee for each folder you pick on this computer' : 'Your computer is not connected to the office right now'} onClick={() => { setTab('people'); setAdding(true); }}>
            Add folders…
          </Button>
        )
      }
    >
      <Tabs<RoomTab>
        value={tab}
        onChange={(t) => {
          setTab(t);
          setAdding(false);
        }}
        tabs={[
          { id: 'people', label: 'Who is in it', count: people.length },
          { id: 'room', label: 'The room' },
          ...(member ? [{ id: 'servers' as const, label: 'My servers', count: servers }] : []),
        ]}
      />
      <div className="k-body" data-my-room={tab}>
        <div hidden={tab !== 'people'}>
          <div className="k-stack">
            {!online && myHost.state === 'unavailable' && <div className="k-note">{myHost.reason}</div>}
            {!online && myHost.state === 'none' && <div className="k-note">Open this office with the Orchestrator desktop app to bring your computer in: a browser tab cannot run sessions.</div>}
            {host && roomless.includes(host.id) && (
              <div className="k-note">
                There is no free wall on the office's shared floor for your room: rooms are attached only where their door opens into a hall, the open floor or reception. Your employees work as usual and are listed here, but have no desk in the office until a wall is free.
              </div>
            )}
            {adding && host && online ? (
              <section className="k-section">
                <div className="k-head">
                  <div className="k-label">Add folders from this computer</div>
                  <Button small variant="ghost" className="k-quiet" onClick={() => setAdding(false)}>
                    Back
                  </Button>
                </div>
                <BulkHire onlyHostId={host.id} onDone={() => setAdding(false)} />
              </section>
            ) : (
              <>
                <div className="k-text">
                  Your employees run on <b>{host?.name ?? 'your computer'}</b>, with your folders and your Claude account. Others see them and how they are; only you and the owners can open their terminals or talk to them. When you leave, the room goes with you and the sessions wait on your computer.
                </div>
                {people.length === 0 ? (
                  <div className="k-empty">
                    <div className="k-title">Nobody yet</div>
                    <div className="k-text">Add a folder from this computer: one employee is hired for it and works there, on your machine.</div>
                  </div>
                ) : (
                  <div className="k-group">
                    {people.map((e) => {
                      const s = sessionOfEmployee(sessions, e.id);
                      const live = s?.status === 'running';
                      const state = live ? employeeState(s!.activity) : { word: there(e) ? 'not started' : hosts[e.hostId ?? '']?.ownerId ? 'server not connected' : 'computer away', dot: 'off' as const, tone: 'calm' as const };
                      return (
                        <div key={e.id} className="k-row my-room-row">
                          <Avatar appearance={e.appearance} size={32} offline={!live} />
                          <button type="button" className="k-main my-room-who" onClick={() => useOffice.getState().openPanel('employee', e.id)} title="Open their profile">
                            <span className="k-title">
                              {e.name}
                              <span className="k-title-note">{e.title}</span>
                            </span>
                            <span className="k-sub k-mono">{e.workingDir ?? 'no folder'}</span>
                          </button>
                          <State {...state} />
                          {live ? (
                            <Button small onClick={() => useOffice.getState().openPanel('talk', e.id)}>
                              Talk
                            </Button>
                          ) : (
                            <Button small disabled={!there(e)} onClick={() => void start(e)}>
                              Start
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {elsewhere.length > 0 && host && <div className="k-sub">{elsewhere.length} of these live on another computer of yours and wait for it.</div>}
                {host && online && (
                  <section className="k-section">
                    <div className="k-label">Claude Code already running on this computer, outside the office</div>
                    <OutsideTmux host={host} bare />
                  </section>
                )}
              </>
            )}
          </div>
        </div>
        {/* (Kept in the page while another tab is looked at: what is being changed in it is on its way to the office.) */}
        <div hidden={tab !== 'room'}>{(host ?? mine[0]) ? <RoomEditor current={(host ?? mine[0])!.room ?? null} minDesks={Math.max(2, Math.ceil(people.length / 2) * 2)} memberName={me?.name ?? 'My'} /> : <div className="k-sub">Your room is there once a computer of yours has been in the office.</div>}</div>
        {tab === 'servers' && member && me?.id && <MyServers memberId={me.id} />}
      </div>
    </Window>
  );
}

registerPanel('myroom', MyRoomPanel);
