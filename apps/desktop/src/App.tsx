import { useEffect, useMemo, useRef, useState } from 'react';
import { unlockedUpgrades } from '@orchestrator/contracts';
import { OfficeScene, ownerPosition } from '@orchestrator/office-3d';
import { Button } from '@orchestrator/ui';
import { api, connection, serverBase, setToken } from './lib/api.ts';
import { Knock } from './Knock.tsx';
import { loadAccounts, loadDocs, onScreen, sessionOfEmployee, startConnection, useOffice, type PanelId } from './lib/store.ts';
import { loadPrefs, usePrefs } from './lib/prefs.ts';
import { boardView, ceoView, foremanView, memberClocks, hostViews, officeWithRooms, personViews, walkRequests, wallView, whiteboardView, zoneViews } from './lib/views.ts';
import { ChatBox, CommandBar, ConfirmDialog, DoorBell, Replies, CommandCenter, ContextMenu, EmployeeCard, Feed, Prompt, Toasts, TopBar, Welcome, Workstation, interact, seatAt, talk, type ContextMenuState } from './hud/core.tsx';
import { onTvFrame } from './lib/tv.ts';
import { startRadio } from './lib/radio.ts';
import { RadioNotice } from './hud/radio-bits.tsx';
import { TvLayer } from './hud/tv.tsx';
import { PanelHost } from './hud/panels/index.tsx';
import './hud/panels/all.ts';

function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || !!el.closest?.('.xterm'));
}

function Login() {
  const [value, setValue] = useState('');
  return (
    <div className="login">
      <div className="glass login-card col" style={{ gap: 14 }}>
        <h1>ORCHESTRATOR</h1>
        <p className="muted">Your code. Your company. Your world.</p>
        <p className="small">
          Enter the owner token to open your office. The server prints a link containing it at startup, and stores it in <span className="mono">~/.orchestrator/server/owner-token</span>.
        </p>
        <input type="password" placeholder="orch_owner_…" value={value} onChange={(e) => setValue(e.target.value)} autoFocus onKeyDown={(e) => e.key === 'Enter' && value.trim() && (setToken(value), connection.connect())} />
        <Button
          variant="primary"
          disabled={!value.trim()}
          onClick={() => {
            setToken(value);
            connection.connect();
          }}
        >
          Enter the office
        </Button>
      </div>
    </div>
  );
}

/**
 * Nobody is signed in. In the desktop app, or at an office's own address on its own computer, that
 * means the owner token is asked for. At an office's door on the network (a browser at its public
 * address) it is the place to knock.
 */
function Entrance() {
  const [door, setDoor] = useState<{ office: string } | null | 'none'>(window.orchestrator ? 'none' : null);
  const [ownToken, setOwnToken] = useState(false);
  useEffect(() => {
    if (window.orchestrator) return;
    let live = true;
    fetch(`${serverBase}/knock`, { cache: 'no-store' })
      .then(async (r) => (r.ok ? await r.json() : null))
      .then((j) => live && setDoor(j?.orchestrator ? { office: String(j.office || 'An office') } : 'none'))
      .catch(() => live && setDoor('none'));
    return () => void (live = false);
  }, []);
  if (door === null) return <div className="login" />;
  if (door === 'none' || ownToken) return <Login />;
  return <Knock office={door.office} onOwnToken={() => setOwnToken(true)} />;
}

const PANEL_KEYS: Array<[string, PanelId]> = [
  ['overview', 'overview'],
  ['map', 'map'],
  ['tasks', 'tasks'],
  ['projects', 'projects'],
  ['notifications', 'notifications'],
];

/** Project areas are marked on the floor only when that is switched on for this computer. */
const NO_ZONES: never[] = [];

/** Tell the others in the office where this person's character is: when it moved, at most ten times a second. */
/** How much of each Claude account is used: for the clocks in the CEO room (the office's accounts) and in each member's room (theirs). */
function useAccounts(): void {
  const owner = useOffice((s) => !!s.me);
  // Asked again when someone starts or stops working, and every minute.
  const live = useOffice((s) => Object.values(s.sessions).filter((x) => x.status === 'running').length);
  useEffect(() => {
    if (!owner) return;
    const load = () => void loadAccounts();
    load();
    const t = window.setInterval(load, 60_000);
    return () => window.clearInterval(t);
  }, [owner, live]);
}

/**
 * The same function objects on every render, always calling the latest version. The 3D scene is redrawn by React
 * only when its inputs change; handlers written inline would look new each time and defeat that.
 */
function useStable<T extends Record<string, (...args: any[]) => any>>(fns: T): T {
  const latest = useRef(fns);
  latest.current = fns;
  return useMemo(() => Object.fromEntries(Object.keys(fns).map((k) => [k, (...args: any[]) => latest.current[k]!(...args)])) as T, []); // eslint-disable-line react-hooks/exhaustive-deps
}

function usePresence(): void {
  useEffect(() => {
    let last = { x: NaN, z: NaN, rot: NaN, moving: false };
    let still = 0;
    const timer = window.setInterval(() => {
      const st = useOffice.getState();
      if (st.conn !== 'online') return;
      const { x, z, rot } = ownerPosition;
      const moved = Math.abs(x - last.x) > 0.01 || Math.abs(z - last.z) > 0.01 || Math.abs(rot - last.rot) > 0.01;
      still = moved ? 0 : still + 1;
      const moving = still < 3 && !Number.isNaN(last.x);
      // Also say so once when coming to a stop, and every few seconds so newcomers see everyone.
      if (!moved && moving === last.moving && still % 30 !== 3) return;
      last = { x, z, rot, moving };
      connection.send({ t: 'presence', x, z, rot, moving });
    }, 100);
    return () => window.clearInterval(timer);
  }, []);
}

export function App() {
  const s = useOffice();
  // Graphics, keys and extras are this computer's own, not the office's.
  const prefs = usePrefs((p) => p.prefs);
  const prefsReady = usePrefs((p) => p.ready);
  usePresence();
  useAccounts();
  // The office's hi-fi is heard in this window too, from where this person's character stands.
  useEffect(() => startRadio(), []);
  const [saying, setSaying] = useState(false);
  // Speech bubbles fade on their own: look again a moment after someone spoke.
  const [sayTick, setSayTick] = useState(0);
  useEffect(() => {
    if (!s.chat.length) return;
    const t = window.setTimeout(() => setSayTick((n) => n + 1), 7200);
    return () => window.clearTimeout(t);
  }, [s.chat[s.chat.length - 1]?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  // What the 3D office calls back with.
  const on = useStable({
    openDocs: (id: string) => useOffice.getState().openPanel('docs', id),
    openTalk: (id: string) => useOffice.getState().openPanel('talk', id),
    openRadio: () => useOffice.getState().openPanel('radio'),
    openTv: () => useOffice.getState().openPanel('tv'),
    openVault: () => useOffice.getState().openPanel('vault'),
    pickSeat: (deskId: string) => {
      const moving = useOffice.getState().movingEmployeeId;
      if (moving) void seatAt(moving, deskId);
    },
    openMeeting: (id: string | null) => useOffice.getState().openPanel('meetings', id),
    openProject: (id: string) => useOffice.getState().openPanel('projects', id),
    select: (id: string | null) => useOffice.getState().selectEmployee(id),
    context: (employeeId: string, x: number, y: number) => setMenu({ employeeId, x, y }),
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    loadPrefs();
    startConnection();
  }, []);

  // Walk animations expire with time, so re-derive them on a slow clock.
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 2500);
    return () => window.clearInterval(t);
  }, []);

  // Tell the server the owner is here (drives "what happened while I was away").
  useEffect(() => {
    if (!s.ready) return;
    const leave = () => void api('POST', '/seen', {}).catch(() => undefined);
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, [s.ready]);

  useEffect(() => {
    const kb = prefs.keybindings;
    const onKey = (e: KeyboardEvent) => {
      const st = useOffice.getState();
      if (e.code === (kb.exit ?? 'Escape')) {
        if (typing(e) && !(e.target as HTMLElement).closest?.('.xterm')) (e.target as HTMLElement).blur();
        // In a terminal, Escape belongs to the terminal (it is Claude Code's interrupt key).
        if ((e.target as HTMLElement)?.closest?.('.xterm')) return;
        if (st.commandOpen) st.setCommandOpen(false);
        else if (st.panel) st.openPanel(null);
        else if (st.movingEmployeeId) st.setMoving(null);
        else if (st.cameraMode === 'workstation') {
          const emp = st.workstationId;
          const session = emp ? Object.values(st.sessions).find((x) => x.employeeId === emp && st.control[x.id]?.you) : undefined;
          if (session) connection.send({ t: 'control.release', sessionId: session.id });
          st.leaveWorkstation();
        } else if (st.selectedEmployeeId) st.selectEmployee(null);
        return;
      }
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === (kb.command ?? 'KeyG')) {
        e.preventDefault();
        st.setCommandOpen(true);
        return;
      }
      if (st.commandOpen) return;
      if (e.code === (kb.interact ?? 'Space') && !st.panel && st.cameraMode !== 'free') {
        // Space would otherwise also "click" whatever HUD button was used last.
        e.preventDefault();
        (document.activeElement as HTMLElement | null)?.blur?.();
        interact();
        return;
      }
      // Enter: say something out loud — the chat box opens its line.
      if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !st.panel && !st.commandOpen && st.cameraMode !== 'workstation') {
        e.preventDefault();
        setSaying(true);
        return;
      }
      // The whip: a sound and an animation, nothing more. Only at someone the owner is standing next to.
      if (e.code === (kb.whip ?? 'KeyR') && !st.panel && st.nearby?.kind === 'employee' && (st.cameraMode === 'ceo' || st.cameraMode === 'first')) {
        e.preventDefault();
        st.whip(st.nearby.id);
        return;
      }
      if (e.code === (kb.talk ?? 'KeyF') && !st.panel && st.cameraMode !== 'free' && st.cameraMode !== 'workstation') {
        e.preventDefault();
        talk();
        return;
      }
      if (e.code === (kb.camera ?? 'KeyC') && !st.panel) {
        const order = ['ceo', 'first', 'management', 'free', 'command'] as const;
        const i = order.indexOf(st.cameraMode as any);
        st.setCameraMode(order[(i + 1) % order.length]!);
        return;
      }
      for (const [bind, panel] of PANEL_KEYS) {
        if (e.code === kb[bind]) {
          e.preventDefault();
          st.openPanel(st.panel === panel ? null : panel);
          return;
        }
      }
      if (e.key === '?') st.openPanel('help');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prefs.keybindings]);

  const unlocked = useMemo(() => unlockedUpgrades(s.milestones), [s.milestones]);
  // The office as it is drawn: the stored layout plus a room for each member whose own computer is connected.
  const office = useMemo(() => officeWithRooms(s, unlocked), [s.layout, s.hosts, s.employees, unlocked]); // eslint-disable-line react-hooks/exhaustive-deps
  // The My room panel tells a member when the shared floor had no place left for their room.
  const roomless = (office?.unplaced ?? []).join(',');
  useEffect(() => {
    useOffice.setState({ roomless: roomless ? roomless.split(',') : [] });
  }, [roomless]);
  const people = useMemo(() => personViews(s, office), [s.employees, s.sessions, s.tasks, s.questions, s.meetings, s.projects, s.filter, s.control, office]); // eslint-disable-line react-hooks/exhaustive-deps
  const walks = useMemo(() => walkRequests(s, Date.now()), [s.events, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  // The foreman has no desk: who it is with, and what it is doing, comes from its rounds.
  const foremanNow = foremanView(s, Date.now());
  const foreman = useMemo(() => foremanNow, [JSON.stringify(foremanNow)]); // eslint-disable-line react-hooks/exhaustive-deps
  const hosts = useMemo(() => hostViews(s), [s.hosts, s.sessions]); // eslint-disable-line react-hooks/exhaustive-deps
  const board = useMemo(() => boardView(s), [s.tasks, s.projects, s.employees, s.filter]); // eslint-disable-line react-hooks/exhaustive-deps
  const wall = useMemo(() => wallView(s, people), [people, s.hosts, s.tasks, s.questions]); // eslint-disable-line react-hooks/exhaustive-deps
  const whiteboard = useMemo(() => whiteboardView(s), [s.meetings, s.employees]); // eslint-disable-line react-hooks/exhaustive-deps
  const zones = useMemo(() => zoneViews(s, office), [s.layout, s.employees, s.projects, s.tasks, office]); // eslint-disable-line react-hooks/exhaustive-deps
  const clocks = useMemo(() => memberClocks(s), [s.accounts, s.hosts]); // eslint-disable-line react-hooks/exhaustive-deps
  const ceo = useMemo(() => ceoView(s), [s.company, s.projects, s.tasks, s.questions, s.employees, s.accounts, s.hosts, s.settings?.companyName]); // eslint-disable-line react-hooks/exhaustive-deps
  // The folders on a desk stand for real files: one stack per employee whose folder has Markdown documents.
  const docViews = useMemo(
    () => people.filter((p) => p.deskId && (s.docs[p.id]?.files.length ?? 0) > 0).map((p) => ({ employeeId: p.id, name: p.name, deskId: p.deskId!, count: s.docs[p.id]!.files.length })),
    [people, s.docs],
  );
  // Look into everyone's folder when they appear, when their session changes, and every minute.
  const docKey = Object.values(s.employees)
    .filter((e) => !e.archived)
    .map((e) => `${e.id}:${e.workingDir ?? ''}:${e.projectId ?? ''}:${sessionOfEmployee(s.sessions, e.id)?.cwd ?? ''}:${e.hostId ? s.hosts[e.hostId]?.status : ''}`)
    .join('|');
  useEffect(() => {
    if (!s.ready) return;
    const ids = Object.values(useOffice.getState().employees).filter((e) => !e.archived).map((e) => e.id);
    const read = () => ids.forEach((id) => void loadDocs(id));
    read();
    const timer = setInterval(read, 60_000);
    return () => clearInterval(timer);
  }, [docKey, s.ready]);
  // The hi-fi in the 3D office shows the office's state, the same in every window — also in one that has muted its copy.
  const radioView = useMemo(() => ({ playing: !!s.hifi, station: s.hifi?.station.name ?? null }), [s.hifi]);
  // The other people in the office (not this window), each with what they last said for a few seconds.
  const humans = useMemo(() => {
    const now = Date.now();
    return s.people
      .filter((p) => p.id !== s.clientId)
      .map((p) => {
        const last = [...s.chat].reverse().find((c) => c.fromId === p.id && !c.emote);
        return { ...p, saying: last && now - last.at < 7000 ? last.text : null, whipAt: s.peopleWhips[p.id] };
      });
  }, [s.people, s.clientId, s.chat, s.peopleWhips, sayTick]);
  // My own conversations: dots over whoever is working on what I said, a bubble over whoever has answered.
  const talkMarks = useMemo(
    () => [
      ...Object.keys(s.replies).map((id) => ({ id, kind: 'answered' as const })),
      ...Object.keys(s.asks)
        .filter((id) => !s.replies[id])
        .map((id) => ({ id, kind: 'waiting' as const })),
    ],
    [s.asks, s.replies],
  );
  // What I said myself: the same bubble, over my own character.
  const selfSaying = useMemo(() => {
    const last = [...s.chat].reverse().find((c) => c.fromId === s.clientId && !c.emote);
    return last && Date.now() - last.at < 7000 ? last.text : null;
  }, [s.chat, s.clientId, sayTick]);
  const tvView = useMemo(() => ({ on: s.tv.on, title: s.tv.page?.title ?? null, audible: !!s.tv.page?.audible }), [s.tv.on, s.tv.page?.title, s.tv.page?.audible]);
  // While someone is being moved: the desks nobody sits at.
  const freeSeats = useMemo(() => {
    if (!s.movingEmployeeId) return null;
    const taken = new Set(Object.values(s.employees).filter((e) => !e.archived && e.deskId).map((e) => e.deskId));
    return (s.layout?.desks ?? []).filter((d) => !taken.has(d.id) && d.kind !== 'executive').map((d) => d.id);
  }, [s.movingEmployeeId, s.employees, s.layout]);
  const keymap = useMemo(() => {
    const kb = prefs.keybindings;
    return { forward: kb.forward ?? 'KeyW', back: kb.back ?? 'KeyS', left: kb.left ?? 'KeyA', right: kb.right ?? 'KeyD', strafeLeft: kb.strafeLeft ?? 'KeyQ', strafeRight: kb.strafeRight ?? 'KeyE' };
  }, [prefs.keybindings]);

  if (s.conn === 'unauthorized') return <Entrance />;
  if (!s.ready || !s.layout || !s.settings || !prefsReady) {
    return (
      <div className="login">
        <div className="glass login-card col">
          <h1>ORCHESTRATOR</h1>
          <p className="muted">{s.conn === 'offline' ? 'Cannot reach the Orchestrator server. Retrying…' : 'Opening your office…'}</p>
        </div>
      </div>
    );
  }

  const inWorkstation = s.cameraMode === 'workstation';
  return (
    <div className="app">
      <div className="scene">
        <OfficeScene
          layout={office?.layout ?? s.layout}
          unlocked={unlocked}
          people={people}
          humans={humans}
          foreman={foreman}
          selfSaying={selfSaying}
          talkMarks={talkMarks}
          onOpenTalk={on.openTalk}
          docs={docViews}
          onOpenDocs={on.openDocs}
          radio={radioView}
          onOpenRadio={on.openRadio}
          tv={tvView}
          tvFrames={onTvFrame}
          onOpenTv={on.openTv}
          onOpenVault={on.openVault}
          freeSeats={freeSeats}
          onPickSeat={on.pickSeat}
          whips={s.whips}
          whipAt={s.whipAt}
          walks={walks}
          hosts={hosts}
          board={board}
          wall={wall}
          ceo={ceo}
          memberClocks={clocks}
          whiteboard={whiteboard}
          onOpenMeeting={on.openMeeting}
          zones={prefs.projectZones ? zones : NO_ZONES}
          approachZoom={prefs.approachZoom}
          onOpenProject={on.openProject}
          cameraMode={s.cameraMode}
          quality={prefs.quality}
          keymap={keymap}
          selectedId={s.selectedEmployeeId}
          workstationId={s.workstationId}
          focus={s.focusRequest}
          subscribeScreen={onScreen}
          onNearby={s.setNearby}
          onSelect={on.select}
          onContext={on.context}
          onLeaveWorkstation={s.leaveWorkstation}
        />
      </div>
      <div className="hud">
        <TopBar />
        {s.conn !== 'online' && <div className="glass banner">Connection to the server lost — the office is frozen at its last known state. Reconnecting…</div>}
        {inWorkstation ? (
          <div className="left-dock">
            <ChatBox open={saying} onOpen={() => setSaying(true)} onClose={() => setSaying(false)} quiet />
          </div>
        ) : (
          <div className="left-dock">
            <ChatBox open={saying} onOpen={() => setSaying(true)} onClose={() => setSaying(false)} />
            <Feed />
          </div>
        )}
        {inWorkstation ? (
          <Workstation />
        ) : (
          <>
            <Prompt />
            <EmployeeCard />
            <CommandCenter />
            <Welcome />
          </>
        )}
        <PanelHost />
        <TvLayer />
        <div className="notice-stack">
          <DoorBell />
          <RadioNotice />
          <Replies />
        </div>
        <CommandBar />
        {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
        <Toasts />
        <ConfirmDialog />
      </div>
    </div>
  );
}
