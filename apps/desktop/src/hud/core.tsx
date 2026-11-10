import { useEffect, useMemo, useRef, useState } from 'react';
import type { CommandPlan, CommandResult, OrchestratorEvent, Question } from '@orchestrator/contracts';
import { ACTIVITY_LABEL } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Markdown, Progress, clock, timeAgo } from '@orchestrator/ui';
import { api, connection } from '../lib/api.ts';
import { usePrefs } from '../lib/prefs.ts';
import { stopRadio } from '../lib/radio.ts';
import { activityOf, currentTaskOf, openQuestionsOf, sessionOfEmployee, useOffice, type CameraMode, type PanelId } from '../lib/store.ts';
import { may, memberOfEmployee, whyNot } from '../lib/access.ts';
import { TerminalView } from '../terminal/TerminalView.tsx';

/** Run an API call and surface failures as a toast instead of swallowing them. */
export async function act<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const res = await fn();
    if (ok) useOffice.getState().toast(ok, 'success');
    return res;
  } catch (e) {
    useOffice.getState().toast((e as Error).message, 'error');
    return undefined;
  }
}

const MODES: Array<{ id: CameraMode; label: string; hint: string }> = [
  { id: 'ceo', label: 'CEO', hint: 'Third person' },
  { id: 'first', label: 'First person', hint: 'Walk the floor' },
  { id: 'management', label: 'Management', hint: 'Elevated view' },
  { id: 'free', label: 'Free cam', hint: 'Fly anywhere' },
  { id: 'command', label: 'Command center', hint: 'Whole office' },
];

export function TopBar() {
  const s = useOffice();
  const employees = Object.values(s.employees).filter((e) => !e.archived);
  const openQuestions = Object.values(s.questions).filter((q) => q.status === 'open').length;
  const blocked = Object.values(s.tasks).filter((t) => t.status === 'BLOCKED').length;
  const unread = Object.values(s.notifications).filter((n) => !n.resolvedAt && !n.readAt).length;
  const working = employees.filter((e) => {
    const a = activityOf(sessionOfEmployee(s.sessions, e.id));
    return !['offline', 'unknown', 'idle', 'waiting_input', 'paused'].includes(a);
  }).length;
  const suggestions = Object.values(s.improvements).filter((i) => i.status === 'proposed').length + Object.values(s.lessons).filter((l) => l.status === 'proposed').length;
  const kb = usePrefs((p) => p.prefs.keybindings);
  const key = (id: string) => (kb[id] ?? '').replace(/^Key/, '');
  const nav: Array<{ id: PanelId; label: string; k: string; count?: number; bad?: boolean }> = [
    { id: 'overview', label: 'Company', k: key('overview') },
    { id: 'tasks', label: 'Tasks', k: key('tasks'), count: blocked, bad: true },
    { id: 'projects', label: 'Projects', k: key('projects') },
    { id: 'team', label: 'Team', k: '' },
    { id: 'meetings', label: 'Meetings', k: '' },
    { id: 'hosts', label: 'Machines', k: '' },
    { id: 'wall', label: 'Terminals', k: '' },
    { id: 'growth', label: 'Growth', k: '', count: suggestions },
    { id: 'reports', label: 'Reports', k: '', count: Object.keys(s.artifacts).length || undefined },
    { id: 'map', label: 'Map', k: key('map') },
    { id: 'office', label: 'Office', k: '' },
    { id: 'radio', label: 'Hi-fi', k: '' },
    { id: 'tv', label: 'TV', k: '' },
    { id: 'people', label: 'People', k: '', count: Math.max(0, s.people.length - 1) || undefined },
    // A member's own computer in this office (not for the office's own machine, nor for a visitor).
    ...(s.me && s.me.role !== 'visitor' && s.me.id && s.me.id !== 'owner' ? [{ id: 'myroom' as PanelId, label: 'My room', k: '', count: Object.values(s.employees).filter((e) => !e.archived && !!e.hostId && s.hosts[e.hostId]?.memberId === s.me!.id).length || undefined }] : []),
  ];
  // The menu stays out of the way until asked for; it closes on a click elsewhere or once something is chosen.
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (ev: MouseEvent) => {
      if (!menuRef.current?.contains(ev.target as Node)) setMenu(false);
    };
    const esc = (ev: KeyboardEvent) => ev.key === 'Escape' && setMenu(false);
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [menu]);
  const menuCount = nav.reduce((n, x) => n + (x.count ?? 0), 0);
  return (
    <div className="topbar">
      <div ref={menuRef} className="menu-anchor">
        <button className={`glass brand brand-btn ${menu ? 'brand-on' : ''}`} onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-haspopup="menu" title="Menu">
          <div className="brand-mark">O</div>
          <div>
            <b>{s.settings?.companyName || 'ORCHESTRATOR'}</b>
            <br />
            <span>Menu {menu ? '▴' : '▾'}</span>
          </div>
          {menuCount > 0 && <span className="pill-count pill-count-bad">{menuCount}</span>}
        </button>
        {menu && (
          <div className="glass dock" role="menu">
            {nav.map((n) => (
              <button
                key={n.id}
                role="menuitem"
                className={`pill ${s.panel === n.id ? 'pill-on' : ''}`}
                onClick={() => {
                  setMenu(false);
                  s.openPanel(s.panel === n.id ? null : n.id);
                }}
              >
                <span className="grow" style={{ textAlign: 'left' }}>
                  {n.label}
                </span>
                {!!n.count && <span className={`pill-count ${n.bad ? 'pill-count-bad' : ''}`}>{n.count}</span>}
                {n.k && <kbd>{n.k}</kbd>}
              </button>
            ))}
            <button
              role="menuitem"
              className="pill"
              onClick={() => {
                setMenu(false);
                s.openPanel('settings');
              }}
            >
              <span className="grow" style={{ textAlign: 'left' }}>
                Settings
              </span>
            </button>
            <button
              role="menuitem"
              className="pill"
              onClick={() => {
                setMenu(false);
                s.openPanel('help');
              }}
            >
              <span className="grow" style={{ textAlign: 'left' }}>
                Help
              </span>
            </button>
          </div>
        )}
      </div>
      <div className="glass pillbar">
        {MODES.map((m) => (
          <button key={m.id} className={`pill ${s.cameraMode === m.id ? 'pill-on' : ''}`} title={m.hint} onClick={() => s.setCameraMode(m.id)}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="grow" />
      {s.radio.stationId && (
        <div className="glass pillbar radio-mini">
          <button className="pill" onClick={() => s.openPanel('radio')} title={s.radio.nowPlaying ? `${s.radio.name} — ${s.radio.nowPlaying}` : (s.radio.name ?? 'Radio')}>
            <span className={`radio-eq ${s.radio.status === 'playing' ? 'radio-eq-on' : ''}`} aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <span className="truncate" style={{ maxWidth: 190 }}>
              {s.radio.status === 'loading' ? 'Tuning in…' : s.radio.status === 'error' ? 'Radio: cannot play' : (s.radio.nowPlaying ?? s.radio.name)}
            </span>
          </button>
          <button className="pill" onClick={stopRadio} title="Stop the radio" aria-label="Stop the radio">
            ■
          </button>
        </div>
      )}
      {(s.me?.kind === 'guest' || s.people.length > 1) && (
        <div className="glass pillbar">
          <button className="pill" onClick={() => s.openPanel('people')} title={s.me?.kind === 'guest' ? `You are a guest here (${s.me.role}). Click to see who is here and talk to them.` : 'Other people are in your office. Click to see who, and to talk to them.'}>
            {s.me?.kind === 'guest' ? `Here as a ${s.me.role}` : 'People'} · {Math.max(1, s.people.length)} here
          </button>
        </div>
      )}
      {s.tv.on && s.panel !== 'tv' && (
        <div className="glass pillbar radio-mini">
          <button className="pill" onClick={() => s.openPanel('tv')} title={s.tv.page ? `${s.tv.page.title} — ${s.tv.page.url}` : 'The TV is on'}>
            <span className={`radio-eq ${s.tv.page?.audible ? 'radio-eq-on' : ''}`} aria-hidden>
              <i />
              <i />
              <i />
            </span>
            <span className="truncate" style={{ maxWidth: 190 }}>
              TV · {s.tv.page?.title || 'on'}
            </span>
          </button>
          <button className="pill" onClick={() => s.tvOff()} title="Turn the TV off" aria-label="Turn the TV off">
            ■
          </button>
        </div>
      )}
      <div className="glass pillbar">
        {employees.length > 0 && (
          <button className="pill" title="Employees doing something right now — open the company overview" onClick={() => s.openPanel('overview')}>
            <span className="dot dot-info" /> {working}/{employees.length} working
          </button>
        )}
        <button className={`pill ${openQuestions ? 'pill-alert' : ''}`} onClick={() => s.openPanel('notifications')} title={`What needs you (${key('notifications')})`}>
          Inbox
          {openQuestions + unread > 0 && <span className="pill-count">{openQuestions + unread}</span>}
        </button>
        <button className="pill" onClick={() => s.setCommandOpen(true)} title={`Tell Orchestrator what to do (${key('command')})`}>
          Command
        </button>
      </div>
    </div>
  );
}

function eventTone(e: OrchestratorEvent): string {
  if (/completed|merged|answered|milestone|level_up|lesson|applied/.test(e.type)) return 'feed-good';
  if (/blocked|failed|conflict|lost|disconnected|revoked/.test(e.type)) return 'feed-bad';
  if (/question|permission_requested|review_requested|proposed/.test(e.type)) return 'feed-warn';
  return '';
}

/** The live office feed: every line is a recorded event; clicking one goes to where it happened. */
export function Feed() {
  const events = useOffice((s) => s.events);
  const [open, setOpen] = useState(false);
  const shown = useMemo(() => events.filter((e) => !(e.data as any)?.quiet && e.type !== 'session.activity').slice(-60).reverse(), [events]);
  const go = (e: OrchestratorEvent) => {
    const st = useOffice.getState();
    if (e.taskId && st.tasks[e.taskId]) st.openPanel('task', e.taskId);
    else if (e.employeeId && st.employees[e.employeeId]) st.focusEmployee(e.employeeId);
  };
  if (!open) {
    const latest = shown[0];
    return (
      <button className="glass feed-pill" onClick={() => setOpen(true)} title="Show the live office feed">
        <span className="feed-pill-label">Feed</span>
        {latest ? <span className={`feed-text truncate ${eventTone(latest)}`}>{latest.summary}</span> : <span className="muted">Nothing has happened yet.</span>}
      </button>
    );
  }
  return (
    <div className="glass feed">
      <div className="feed-head">
        <span>LIVE OFFICE FEED</span>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          Hide
        </button>
      </div>
      {
        <div className="feed-list">
          {shown.length === 0 && <div className="feed-item muted">Nothing has happened yet.</div>}
          {shown.map((e) => (
            <button key={e.id} className="feed-item" onClick={() => go(e)} title={`${e.summary}\n${e.type} · source: ${e.source.kind}`}>
              <span className="feed-time">{clock(e.ts)}</span>
              <span className={`feed-text ${eventTone(e)}`}>{e.summary}</span>
            </button>
          ))}
        </div>
      }
    </div>
  );
}

export function Toasts() {
  const toasts = useOffice((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

const ROOM_PANEL: Record<string, PanelId> = { tv: 'tv', hifi: 'radio', board: 'tasks', meeting: 'meetings', server: 'hosts', ops: 'wall', ceo: 'ceo', break: 'overview', reception: 'overview' };

/** What pressing the interact key does for whatever the owner is standing next to. */
export function interact(): void {
  const s = useOffice.getState();
  if (s.cameraMode === 'workstation') return;
  const n = s.nearby;
  if (!n) return;
  const moving = s.movingEmployeeId ? s.employees[s.movingEmployeeId] : undefined;
  if (n.kind === 'desk') {
    // An empty desk: put down whoever is being moved, or choose someone to sit here.
    if (moving) void seatAt(moving.id, n.id);
    else s.openPanel('seat', n.id);
  } else if (n.kind === 'employee') {
    // While moving someone, another person's desk means "swap the two".
    const other = s.employees[n.id];
    if (moving && other && other.id !== moving.id && other.deskId) void seatAt(moving.id, other.deskId);
    else s.enterWorkstation(n.id);
  } else s.openPanel(ROOM_PANEL[n.kind] ?? 'overview');
}

/** Seat an employee at a desk (whoever sits there swaps with them). Only where they are shown changes. */
export async function seatAt(employeeId: string, deskId: string): Promise<void> {
  const s = useOffice.getState();
  const who = s.employees[employeeId];
  const there = Object.values(s.employees).find((e) => !e.archived && e.deskId === deskId && e.id !== employeeId);
  if (!who || who.deskId === deskId) return s.setMoving(null);
  const ok = await act(() => api('PATCH', `/employees/${employeeId}`, { deskId }), there ? `${who.name} and ${there.name} swapped desks` : `${who.name} moved to another desk`);
  if (ok) useOffice.getState().setMoving(null);
}

/** Walk up and talk: open a direct conversation with the employee next to you (or the selected one). */
export function talk(): void {
  const s = useOffice.getState();
  const id = s.nearby?.kind === 'employee' ? s.nearby.id : s.selectedEmployeeId;
  if (id) s.openPanel('talk', id);
}

/** How long a new line keeps the chat box lit before it fades back (it stays readable on hover and while typing). */
const CHAT_FRESH_MS = 20_000;

/**
 * The office chat, bottom left, as in an online game: what people said and did, oldest at the top.
 * Enter opens the line to say something; Enter again says it. New lines light the box up for a
 * while, then it fades so the office stays in view — pointing at it brings it back to scroll.
 * `quiet` (at a workstation): only fresh lines, nothing to click.
 */
export function ChatBox({ open, onOpen, onClose, quiet }: { open: boolean; onOpen: () => void; onClose: () => void; quiet?: boolean }) {
  const chat = useOffice((s) => s.chat);
  const [text, setText] = useState('');
  const [hover, setHover] = useState(false);
  const [, tick] = useState(0);
  const log = useRef<HTMLDivElement>(null);
  const last = chat[chat.length - 1];
  useEffect(() => {
    if (!last) return;
    const t = window.setTimeout(() => tick((n) => n + 1), CHAT_FRESH_MS + 100);
    return () => window.clearTimeout(t);
  }, [last?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // The newest line is the one in view.
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last?.id, open]); // eslint-disable-line react-hooks/exhaustive-deps
  const fresh = !!last && Date.now() - last.at < CHAT_FRESH_MS;
  const held = open || hover;
  if (quiet && !fresh) return null;
  return (
    <div className={`chatbox${held || fresh ? ' awake' : ''}${held ? ' held' : ''}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div ref={log} className="chatbox-log" role="log" aria-label="Office chat">
        {chat.length === 0 && <div className="chat-line chat-system">Nothing said yet. What you say here is heard by the people in the office, not by the employees.</div>}
        {chat.map((c) => (
          <div key={c.id} className={`chat-line${c.emote ? ' chat-emote' : ''}`}>
            <span className="chat-time">[{new Date(c.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}]</span>{' '}
            {c.emote ? (
              <>
                {c.name} {c.text}.
              </>
            ) : (
              <>
                <span className="chat-name" style={{ color: `hsl(${c.hue ?? 210} 75% 70%)` }}>
                  [{c.name}]
                </span>{' '}
                says: {c.text}
              </>
            )}
          </div>
        ))}
      </div>
      {!quiet &&
        (open ? (
          <form
            className="chatbox-form"
            onSubmit={(ev) => {
              ev.preventDefault();
              useOffice.getState().say(text);
              setText('');
              onClose();
            }}
          >
            <span className="chat-say">Say:</span>
            <input
              autoFocus
              value={text}
              maxLength={300}
              placeholder="Enter to say, Esc to cancel"
              aria-label="Say something to the people here"
              onChange={(ev) => setText(ev.target.value)}
              onBlur={onClose}
              onKeyDown={(ev) => {
                if (ev.key === 'Escape') {
                  ev.stopPropagation();
                  setText('');
                  onClose();
                }
              }}
            />
          </form>
        ) : (
          <button type="button" className="chatbox-tab" onClick={onOpen} title="Say something to the people in the office">
            Chat <span className="kbd">Enter</span>
          </button>
        ))}
    </div>
  );
}

export function Prompt() {
  const nearby = useOffice((s) => s.nearby);
  const mode = useOffice((s) => s.cameraMode);
  const panel = useOffice((s) => s.panel);
  const key = usePrefs((p) => (p.prefs.keybindings.interact ?? 'Space').replace(/^Key/, ''));
  const talkKey = usePrefs((p) => (p.prefs.keybindings.talk ?? 'KeyF').replace(/^Key/, ''));
  const whipKey = usePrefs((p) => (p.prefs.keybindings.whip ?? 'KeyR').replace(/^Key/, ''));
  const moving = useOffice((s) => (s.movingEmployeeId ? s.employees[s.movingEmployeeId] : undefined));
  if (panel || mode === 'workstation') return null;
  if (moving) {
    // Carrying someone to another desk: say what the interact key will do here, and how to stop.
    const swap = nearby?.kind === 'employee' && nearby.id !== moving.id;
    return (
      <div className="glass prompt prompt-moving">
        <span className="strong">MOVING {moving.name.toUpperCase()}</span>
        <span className="faint">·</span>
        {nearby?.kind === 'desk' ? (
          <>
            <span className="kbd">{key}</span> SEAT {moving.name.toUpperCase()} HERE
          </>
        ) : swap ? (
          <>
            <span className="kbd">{key}</span> SWAP SEATS WITH {nearby!.label.toUpperCase()}
          </>
        ) : (
          <span>WALK TO A DESK, OR CLICK A GREEN RING</span>
        )}
        <span className="faint">·</span>
        <button className="fp-link" style={{ display: 'inline' }} onClick={() => useOffice.getState().setMoving(null)}>
          cancel (Esc)
        </button>
      </div>
    );
  }
  if (!nearby) return null;
  return (
    <div className="glass prompt">
      {nearby.kind === 'desk' ? (
        <>
          <span className="kbd">{key}</span> SEAT SOMEONE AT THIS DESK
        </>
      ) : nearby.kind === 'employee' ? (
        <>
          <span className="kbd">{talkKey}</span> TALK TO {nearby.label.toUpperCase()}
          <span className="faint">·</span>
          <span className="kbd">{key}</span> INSPECT WORKSTATION
          <span className="faint">·</span>
          <span className="kbd">{whipKey}</span> WHIP
        </>
      ) : (
        <>
          <span className="kbd">{key}</span>
          {nearby.label}
        </>
      )}
    </div>
  );
}

/** Summary card for the employee the owner is standing next to or has selected. */
export function EmployeeCard() {
  const s = useOffice();
  const id = s.cameraMode === 'workstation' ? null : (s.selectedEmployeeId ?? (s.nearby?.kind === 'employee' ? s.nearby.id : null));
  const e = id ? s.employees[id] : undefined;
  if (!e || s.panel || s.cameraMode === 'command') return null;
  const session = sessionOfEmployee(s.sessions, e.id);
  const activity = activityOf(session);
  const task = currentTaskOf(s.tasks, e.id);
  const questions = openQuestionsOf(s.questions, e.id);
  const live = !!session && session.status === 'running';
  // What this person may do with this employee (the office decides; this saves a refused click).
  const member = memberOfEmployee(s.hosts, e);
  const work = may(s.me, 'work', member);
  const read = may(s.me, 'read', member);
  const why = whyNot(s.me, 'work', member) ?? undefined;
  const whose = member && s.hosts[e.hostId ?? '']?.memberName;
  return (
    <div className="glass near-card col">
      <div className="row">
        <Avatar appearance={e.appearance} size={40} offline={!live} />
        <div className="grow">
          <div className="strong truncate">{e.name}</div>
          <div className="muted small truncate">
            {e.title} · L{e.level}
            {whose ? ` · ${member === s.me?.id ? 'yours' : `${whose}'s`}` : ''}
          </div>
        </div>
        <Badge tone={questions.length ? 'warn' : activity === 'blocked' ? 'bad' : live ? 'info' : 'muted'}>{ACTIVITY_LABEL[activity] ?? activity}</Badge>
      </div>
      {session?.activityDetail && live && <div className="small muted truncate mono">{session.activityDetail}</div>}
      {task ? (
        <div className="col" style={{ gap: 4 }}>
          <div className="small truncate">
            <span className="mono muted">{task.key}</span> {task.title}
          </div>
          {task.progress.percent != null && <Progress value={task.progress.percent} />}
          {task.progress.note && <div className="small muted truncate">{task.progress.note}</div>}
        </div>
      ) : (
        <div className="small muted">{live ? 'No task in progress.' : 'Asleep — no session is running. Talk to them or give them work to wake them.'}</div>
      )}
      {questions[0] && work && (
        <Button variant="primary" small onClick={() => s.openPanel('question', questions[0]!.id)}>
          {questions[0].kind === 'permission' ? 'Review approval request' : 'Answer their question'}
        </Button>
      )}
      <div className="row row-wrap">
        <Button small variant="primary" onClick={() => s.openPanel('talk', e.id)} disabled={!work} title={why}>
          Talk
        </Button>
        <Button small onClick={() => s.enterWorkstation(e.id)} disabled={!session || !read} title={read ? undefined : (whyNot(s.me, 'read', member) ?? undefined)}>
          {work ? 'Open workstation' : 'Watch terminal'}
        </Button>
        {read && (s.docs[e.id]?.files.length ?? 0) > 0 && (
          <Button small onClick={() => s.openPanel('docs', e.id)} title="The Markdown files in their folder">
            Documents ({s.docs[e.id]!.files.length})
          </Button>
        )}
        <Button small onClick={() => s.openPanel('employee', e.id)}>
          Profile
        </Button>
        {!live && e.hostId && work && (
          <Button small variant="success" onClick={() => act(() => api('POST', `/employees/${e.id}/start`, {}), `${e.name}'s session is starting`)}>
            Start session
          </Button>
        )}
      </div>
    </div>
  );
}

/** First run: an empty office says what to do next instead of looking broken. */
const NOT_WORKING_STATES = new Set(['offline', 'unknown', 'idle', 'waiting_input', 'paused']);

/**
 * Command center view: the whole company at a glance next to the top-down
 * office — what needs the owner, what everyone is really doing, and the
 * measured load of every machine. Everything listed is live state; rows open
 * the real thing they describe.
 */
export function CommandCenter() {
  const s = useOffice();
  if (s.cameraMode !== 'command' || s.panel) return null;
  const employees = Object.values(s.employees).filter((e) => !e.archived);
  const rows = employees
    .map((e) => {
      const session = sessionOfEmployee(s.sessions, e.id);
      const activity = activityOf(session);
      const questions = openQuestionsOf(s.questions, e.id);
      const live = !!session && (session.status === 'running' || session.status === 'starting');
      // Needs you → blocked → working → at the desk → not here.
      const rank = questions.length ? 0 : activity === 'blocked' ? 1 : live && !NOT_WORKING_STATES.has(activity) ? 2 : live ? 3 : 4;
      return { e, session, activity, questions, live, task: currentTaskOf(s.tasks, e.id), rank };
    })
    .sort((a, b) => a.rank - b.rank || a.e.name.localeCompare(b.e.name));
  const waiting = Object.values(s.questions)
    .filter((q) => q.status === 'open')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const blocked = Object.values(s.tasks).filter((t) => t.status === 'BLOCKED');
  const hosts = Object.values(s.hosts)
    .filter((h) => h.status !== 'revoked')
    .sort((a, b) => a.name.localeCompare(b.name));
  // Same definition as the top bar: a live session that is not idle, paused or waiting for input.
  const working = rows.filter((r) => r.live && !NOT_WORKING_STATES.has(r.activity)).length;
  const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n)}%`);
  return (
    <div className="glass cc col">
      <div className="cc-head">
        <div className="section-title" style={{ margin: 0 }}>
          Command center
        </div>
        <span className="small muted">
          {working}/{employees.length} working · {rows.filter((r) => r.live).length} at their desks
        </span>
      </div>
      <div className="cc-body col">
        <div className="col" style={{ gap: 4 }}>
          <div className="cc-label">
            Needs you <span className={waiting.length ? 'cc-count cc-count-warn' : 'cc-count'}>{waiting.length}</span>
          </div>
          {waiting.length === 0 && <div className="small muted">Nothing is waiting on you.</div>}
          {waiting.slice(0, 6).map((q) => (
            <button key={q.id} className="cc-row" onClick={() => s.openPanel('question', q.id)} title="Open and answer">
              <Badge tone={q.kind === 'permission' ? 'warn' : 'accent'}>{q.kind === 'permission' ? 'approval' : q.kind === 'trust_prompt' ? 'trust' : 'question'}</Badge>
              <span className="small truncate grow">
                <span className="strong">{s.employees[q.employeeId ?? '']?.name ?? 'Session'}</span> {q.text}
              </span>
              <span className="small faint">{timeAgo(q.createdAt)}</span>
            </button>
          ))}
          {waiting.length > 6 && (
            <button className="cc-row" onClick={() => s.openPanel('notifications')}>
              <span className="small muted">…and {waiting.length - 6} more in the inbox</span>
            </button>
          )}
          {blocked.length > 0 && (
            <button className="cc-row" onClick={() => s.openPanel('tasks')} title="Open the task board">
              <Badge tone="bad">blocked</Badge>
              <span className="small truncate grow">
                {blocked.length} task{blocked.length === 1 ? '' : 's'}: {blocked.map((t) => t.key).join(', ')}
              </span>
            </button>
          )}
        </div>
        <div className="col" style={{ gap: 4 }}>
          <div className="cc-label">
            People <span className="cc-count">{employees.length}</span>
          </div>
          {rows.length === 0 && <div className="small muted">Nobody works here yet.</div>}
          {rows.map(({ e, session, activity, questions, live, task }) => (
            <button key={e.id} className="cc-row" onClick={() => s.focusEmployee(e.id)} onDoubleClick={() => live && s.enterWorkstation(e.id)} title={live ? 'Click to find them in the office · double-click to sit at their terminal' : 'Click to find their desk'}>
              <Avatar appearance={e.appearance} size={22} offline={!live} />
              <span className="cc-who">
                <span className="small strong truncate">{e.name}</span>
                <span className="small muted truncate">{task ? `${task.key} ${task.title}` : live ? (session?.activityDetail ?? e.title) : e.title}</span>
              </span>
              <Badge tone={questions.length ? 'warn' : activity === 'blocked' ? 'bad' : live ? (NOT_WORKING_STATES.has(activity) ? 'neutral' : 'info') : 'muted'}>{questions.length ? 'NEEDS YOU' : (ACTIVITY_LABEL[activity] ?? activity)}</Badge>
            </button>
          ))}
        </div>
        <div className="col" style={{ gap: 4 }}>
          <div className="cc-label">
            Machines <span className="cc-count">{hosts.length}</span>
          </div>
          {hosts.length === 0 && <div className="small muted">No machine is enrolled.</div>}
          {hosts.map((h) => {
            const r = h.status === 'online' ? h.resources : null;
            const mem = r?.memUsedBytes != null && r.memTotalBytes ? (r.memUsedBytes / r.memTotalBytes) * 100 : null;
            return (
              <button key={h.id} className="cc-row" onClick={() => s.openPanel('hosts')} title="Open Machines">
                <span className={`dot ${h.status === 'online' ? 'dot-good' : 'dot-bad'}`} />
                <span className="small strong truncate grow">{h.name}</span>
                {r ? (
                  <span className="small mono muted" title="Measured on the machine by its host agent">
                    CPU {pct(r.cpuPercent)} · RAM {pct(mem)} · {r.sessionCount} session{r.sessionCount === 1 ? '' : 's'}
                  </span>
                ) : (
                  <span className="small muted">{h.status === 'online' ? 'no measurement yet' : h.status}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function Welcome() {
  const s = useOffice();
  const employees = Object.values(s.employees).filter((e) => !e.archived);
  const hosts = Object.values(s.hosts).filter((h) => h.status === 'online');
  if (employees.length > 0 || s.panel || s.commandOpen || s.cameraMode === 'command') return null;
  return (
    <div className="glass welcome col">
      <div className="strong" style={{ fontSize: 16 }}>
        Your office is empty.
      </div>
      <div className="small muted">Employees are real Claude Code sessions. Each one lives in a folder on one of your machines and works there.</div>
      <div className="col" style={{ gap: 6 }}>
        <div className="row">
          <span className={`dot ${hosts.length ? 'dot-good' : 'dot-bad'}`} />
          <span className="small">{hosts.length ? `${hosts.length} machine${hosts.length === 1 ? '' : 's'} connected (${hosts.map((h) => h.name).join(', ')})` : 'No machine is connected yet — start a host agent, or open Machines to connect one.'}</span>
        </div>
        <div className="row">
          <span className="dot" />
          <span className="small">Hire someone and give them a folder. Then walk up and talk to them.</span>
        </div>
      </div>
      <div className="row row-wrap">
        <Button variant="primary" onClick={() => s.openPanel('team', 'hire')}>
          Hire your first employee
        </Button>
        <Button onClick={() => s.openPanel('hosts')}>Machines</Button>
        <Button variant="ghost" onClick={() => s.openPanel('help')}>
          How it works
        </Button>
      </div>
    </div>
  );
}

export interface ContextMenuState {
  employeeId: string;
  x: number;
  y: number;
}

export function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const s = useOffice();
  const e = s.employees[menu.employeeId];
  const docCount = s.docs[menu.employeeId]?.files.length ?? 0;
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
  }, [onClose]);
  if (!e) return null;
  const session = sessionOfEmployee(s.sessions, e.id);
  const live = !!session && session.status === 'running';
  const paused = session?.control === 'PAUSED';
  const q = openQuestionsOf(s.questions, e.id)[0];
  const member = memberOfEmployee(s.hosts, e);
  const work = may(s.me, 'work', member);
  const read = may(s.me, 'read', member);
  const admin = may(s.me, 'admin', null);
  const item = (label: string, fn: () => void, disabled = false) => (
    <button
      disabled={disabled}
      onPointerDown={(ev) => ev.stopPropagation()}
      onClick={() => {
        onClose();
        fn();
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      className="glass ctx"
      // Keep the whole menu on screen whatever its length: measured once it is laid out.
      ref={(el) => {
        if (!el) return;
        const h = el.offsetHeight;
        el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - h - 8))}px`;
      }}
      style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 440), maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' }}
    >
      <div className="ctx-title">
        {e.name} · {e.title}
      </div>
      {!work && <div className="small faint" style={{ padding: '2px 10px 6px' }}>{whyNot(s.me, 'work', member)}</div>}
      {item('Talk', () => s.openPanel('talk', e.id), !work)}
      {item('Crack the whip (just for show)', () => s.whip(e.id))}
      {admin && !member && item('Move to another desk…', () => {
        s.setMoving(e.id);
        if (s.cameraMode !== 'ceo' && s.cameraMode !== 'first') s.toast(`Click a green ring to seat ${e.name} there — or switch to CEO view and walk to a desk`, 'info');
      })}
      {q && work && item(q.kind === 'permission' ? 'Review approval request' : 'Answer their question', () => s.openPanel('question', q.id))}
      {item('Inspect work', () => s.enterWorkstation(e.id), !session || !read)}
      {item(work ? 'Open terminal' : 'Watch terminal', () => s.enterWorkstation(e.id), !session || !read)}
      {item('Assign task…', () => s.openPanel('task', `new:${e.id}`), !work)}
      <hr />
      {item(`Documents${docCount ? ` (${docCount})` : ''}`, () => s.openPanel('docs', e.id), !docCount || !read)}
      {item('View skills', () => s.openPanel('employee', e.id))}
      {item('View history', () => s.openPanel('employee', `${e.id}:history`))}
      {item('View current project', () => s.openPanel('projects', e.projectId), !e.projectId)}
      {admin && !member && item('Change workstation…', () => s.openPanel('employee', `${e.id}:desk`))}
      <hr />
      {work && (
        <>
          {paused ? item('Resume', () => void act(() => api('POST', `/employees/${e.id}/resume`, {}), `${e.name} resumed`)) : item('Pause (interrupt)', () => void act(() => api('POST', `/employees/${e.id}/pause`, {}), `${e.name} interrupted`), !live)}
          {item('Request report', () => void act(() => api('POST', `/employees/${e.id}/report`, {}), 'Report requested'), !live)}
          {!live && item('Start session', () => void act(() => api('POST', `/employees/${e.id}/start`, {}), 'Session starting'), !e.hostId)}
        </>
      )}
    </div>
  );
}

const EXAMPLES = ['Assign Alex to fix the authentication bug', 'Get Mike to test everything Alex changed', 'Ask the whole team to review the architecture', 'Find an available backend engineer', 'Show me everyone who needs my attention', 'Summarize what happened while I was away'];

/**
 * The global command bar. An instruction is first turned into an explicit plan
 * that the owner sees; nothing runs until they confirm it.
 */
export function CommandBar() {
  const open = useOffice((s) => s.commandOpen);
  const [input, setInput] = useState('');
  const [plan, setPlan] = useState<CommandPlan | null>(null);
  const [result, setResult] = useState<CommandResult | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setPlan(null);
      setResult(null);
      setTimeout(() => ref.current?.focus(), 20);
    }
  }, [open]);
  if (!open) return null;
  const close = () => useOffice.getState().setCommandOpen(false);
  const interpret = async () => {
    if (!input.trim()) return;
    setBusy(true);
    setResult(null);
    const p = await act(() => api<CommandPlan>('POST', '/commands/plan', { input }));
    setBusy(false);
    if (!p) return;
    setPlan(p);
    // Questions change nothing, so they need no confirmation.
    if (!p.problems.length && p.operations.length && p.operations.every((o) => o.operation.op.startsWith('query.') || o.operation.op === 'ui.focus')) void execute();
  };
  const execute = async () => {
    setBusy(true);
    const r = await act(() => api<CommandResult>('POST', '/commands/execute', { input }));
    setBusy(false);
    if (!r) return;
    setResult(r);
    const focus = r.answer?.title === 'Go to desk' ? r.answer.employeeIds?.[0] : undefined;
    if (focus) {
      useOffice.getState().focusEmployee(focus);
      close();
    }
  };
  const isQuery = !!plan && plan.operations.every((o) => o.operation.op.startsWith('query.') || o.operation.op === 'ui.focus');
  return (
    <div className="cmd-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="glass cmd">
        <input
          ref={ref}
          value={input}
          placeholder="Tell Orchestrator what to do…  e.g. “Have Sarah improve mobile responsiveness”"
          onChange={(e) => {
            setInput(e.target.value);
            setPlan(null);
            setResult(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') close();
            if (e.key === 'Enter') void (plan && !plan.problems.length && !result && !isQuery ? execute() : interpret());
          }}
        />
        <div className="cmd-body">
          {!plan && !busy && (
            <div className="col">
              <div className="section-title">Examples</div>
              {EXAMPLES.map((x) => (
                <button key={x} className="feed-item" onClick={() => setInput(x)}>
                  <span className="feed-text muted">{x}</span>
                </button>
              ))}
              <div className="small faint">Press Enter to see exactly what will happen before anything runs.</div>
            </div>
          )}
          {busy && <div className="muted">Working…</div>}
          {plan && plan.problems.length > 0 && (
            <div className="col">
              <Badge tone="bad">Not understood — nothing was done</Badge>
              {plan.problems.map((p, i) => (
                <div key={i} className="small">
                  {p}
                </div>
              ))}
            </div>
          )}
          {plan && !plan.problems.length && !result && !isQuery && (
            <div className="col">
              <div className="row spread">
                <div className="section-title" style={{ margin: 0 }}>
                  This will happen
                </div>
                <Badge tone="muted" title={plan.interpretedBy === 'rules' ? 'Interpreted by deterministic rules' : 'Interpreted by a headless Claude run, then validated'}>
                  {plan.interpretedBy === 'rules' ? 'rules' : 'Claude (validated)'}
                </Badge>
              </div>
              {plan.operations.map((o, i) => (
                <div key={i} className="cmd-op">
                  <span className="cmd-op-n">{i + 1}</span>
                  <span>{o.description}</span>
                </div>
              ))}
              <div className="row">
                <Button variant="primary" onClick={execute} disabled={busy}>
                  Confirm <span className="kbd">Enter</span>
                </Button>
                <Button variant="ghost" onClick={() => setPlan(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {result && (
            <div className="col">
              {result.executed
                .filter((x) => !isQuery || !x.ok)
                .map((x, i) => (
                  <div key={i} className="cmd-op">
                    <Badge tone={x.ok ? 'good' : 'bad'}>{x.ok ? 'done' : 'failed'}</Badge>
                    <span>
                      {x.description}
                      <span className="muted"> — {x.detail}</span>
                    </span>
                  </div>
                ))}
              {result.answer && (
                <div className="col">
                  <div className="strong">{result.answer.title}</div>
                  {result.answer.lines.map((l, i) => (
                    <div key={i} className="small pre">
                      {l}
                    </div>
                  ))}
                  {!!result.answer.employeeIds?.length && (
                    <div className="row row-wrap">
                      {result.answer.employeeIds.map((id) => {
                        const emp = useOffice.getState().employees[id];
                        return (
                          emp && (
                            <Button
                              key={id}
                              small
                              onClick={() => {
                                useOffice.getState().focusEmployee(id);
                                close();
                              }}
                            >
                              Go to {emp.name}
                            </Button>
                          )
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Answer a question or decide an approval — without opening the terminal. */
export function QuestionBody({ q, onDone }: { q: Question; onDone?: () => void }) {
  const s = useOffice();
  const e = q.employeeId ? s.employees[q.employeeId] : undefined;
  const [text, setText] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    const res = await act(() => api<Question>('POST', `/questions/${q.id}/answer`, body));
    setBusy(false);
    if (res) {
      s.toast(res.kind === 'permission' ? 'Decision sent. It is confirmed when Claude Code acts on it.' : 'Answer sent. It is confirmed when the session receives it.', 'success');
      onDone?.();
    }
  };
  const open = q.status === 'open';
  const input: any = q.tool?.input ?? {};
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row">
        {e && <Avatar appearance={e.appearance} size={36} />}
        <div className="grow">
          <div className="strong">{e ? `${e.name} · ${e.title}` : 'Orchestrator'}</div>
          <div className="small muted">
            asked {timeAgo(q.createdAt)} · via {q.channel.replace(/_/g, ' ')}
            {q.taskId && s.tasks[q.taskId] ? ` · ${s.tasks[q.taskId]!.key}` : ''}
          </div>
        </div>
        <Badge tone={open ? 'warn' : q.status === 'confirmed' ? 'good' : q.status === 'failed' || q.status === 'superseded' ? 'bad' : 'info'}>{q.status}</Badge>
      </div>
      <div style={{ fontSize: 15, fontWeight: 650, lineHeight: 1.4 }}>
        <Markdown text={q.text} />
      </div>
      {q.kind === 'permission' && q.tool && (
        <div className="col" style={{ gap: 6 }}>
          <div className="section-title">Exactly what would run</div>
          <div className="code">{typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2)}</div>
        </div>
      )}
      {q.context && (
        <div>
          <div className="section-title">Context</div>
          <Markdown className="small" text={q.context} />
        </div>
      )}
      {q.why && (
        <div>
          <div className="section-title">Why it matters</div>
          <div className="small pre">{q.why}</div>
        </div>
      )}
      {!open && (
        <div className="card">
          <div className="small muted">{q.kind === 'permission' ? `Decision: ${q.decision ?? '—'}` : `Answer: ${q.answer ?? '—'}`}</div>
          {q.deliveryDetail && <div className="small">{q.deliveryDetail}</div>}
        </div>
      )}
      {open && q.kind === 'permission' && (
        <div className="col">
          <input placeholder="Optional note to the agent if you deny" value={text} onChange={(ev) => setText(ev.target.value)} />
          <div className="row">
            <Button variant="success" disabled={busy} onClick={() => send({ decision: 'allow' })}>
              Allow this once
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => send({ decision: 'deny', answer: text || undefined })}>
              Deny
            </Button>
            {q.sessionId && e && (
              <Button variant="ghost" onClick={() => s.enterWorkstation(e.id)}>
                Look at their terminal first
              </Button>
            )}
          </div>
        </div>
      )}
      {open && q.kind !== 'permission' && q.parts.length > 1 && (
        <div className="col">
          {q.parts.map((p) => (
            <div key={p.question} className="col" style={{ gap: 6 }}>
              <div className="strong small">{p.question}</div>
              <div className="row row-wrap">
                {p.options.map((o) => (
                  <Button key={o.label} small variant={answers[p.question] === o.label ? 'primary' : 'default'} title={o.description} onClick={() => setAnswers({ ...answers, [p.question]: o.label })}>
                    {o.label}
                  </Button>
                ))}
              </div>
            </div>
          ))}
          <Button variant="primary" disabled={busy || q.parts.some((p) => !answers[p.question])} onClick={() => send({ answers })}>
            Send answers
          </Button>
        </div>
      )}
      {open && q.kind !== 'permission' && q.parts.length <= 1 && (
        <div className="col">
          {q.options.length > 0 && (
            <div className="col" style={{ gap: 6 }}>
              <div className="section-title">Suggested options</div>
              {q.options.map((o) => (
                <button key={o.label} className="card card-click" style={{ textAlign: 'left' }} disabled={busy} onClick={() => send(q.parts.length === 1 ? { answers: { [q.parts[0]!.question]: o.label } } : { answer: o.label })}>
                  <div className="strong">{o.label}</div>
                  {o.description && <div className="small muted">{o.description}</div>}
                  {o.consequence && <div className="small">→ {o.consequence}</div>}
                </button>
              ))}
            </div>
          )}
          {q.channel !== 'ask_user_question_hook' && q.kind !== 'trust_prompt' && (
            <>
              <textarea placeholder="Or reply in your own words…" value={text} onChange={(ev) => setText(ev.target.value)} onKeyDown={(ev) => (ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && text.trim() && void send({ answer: text })} />
              <div className="row">
                <Button variant="primary" disabled={busy || !text.trim()} onClick={() => send({ answer: text })}>
                  Send reply
                </Button>
                <span className="small faint">⌘/Ctrl + Enter</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Sitting at an employee's workstation: their real terminal, observed by
 * default, with an explicit switch to take the keyboard and hand it back.
 */
export function Workstation() {
  const s = useOffice();
  const [fit, setFit] = useState(false);
  const [msg, setMsg] = useState('');
  const e = s.workstationId ? s.employees[s.workstationId] : undefined;
  const session = e ? sessionOfEmployee(s.sessions, e.id) : undefined;
  const sessionId = session?.id ?? null;
  useEffect(() => {
    connection.send({ t: 'screens.focus', sessionId });
    return () => connection.send({ t: 'screens.focus', sessionId: null });
  }, [sessionId]);
  if (!e) return null;
  const ctl = session ? s.control[session.id] : undefined;
  const controlState = ctl?.control ?? session?.control ?? 'DISCONNECTED';
  const mine = ctl?.you === true;
  const live = !!session && (session.status === 'running' || session.status === 'starting');
  const task = currentTaskOf(s.tasks, e.id);
  const questions = openQuestionsOf(s.questions, e.id);
  const activity = activityOf(session);
  const paused = controlState === 'PAUSED';
  const leave = () => {
    if (session && mine) connection.send({ t: 'control.release', sessionId: session.id });
    s.leaveWorkstation();
  };
  return (
    <div className="ws">
      <div className="glass ws-term">
        <div className="ws-bar">
          <Avatar appearance={e.appearance} size={28} offline={!live} />
          <div className="strong">{e.name}</div>
          <span className="muted small truncate grow mono">{session ? `${session.tmuxSession} · ${session.cwd}${session.branch ? ` · ${session.branch}` : ''}` : 'no session'}</span>
          <span className={`ws-state ws-state-${controlState}`}>{mine ? 'YOU ARE IN CONTROL' : controlState.replace(/_/g, ' ')}</span>
          {session && live && !mine && !may(s.me, 'work', memberOfEmployee(s.hosts, e)) && <span className="small muted">watching only</span>}
          {session && live && !mine && may(s.me, 'work', memberOfEmployee(s.hosts, e)) && (
            <Button variant="primary" small onClick={() => connection.send({ t: 'control.acquire', sessionId: session.id })} title="Type directly into this exact tmux session">
              Take control
            </Button>
          )}
          {mine && (
            <>
              <label className="check small" title="Resize the real terminal to fill this panel">
                <input type="checkbox" checked={fit} onChange={(ev) => setFit(ev.target.checked)} /> Fit
              </label>
              <Button variant="success" small onClick={() => connection.send({ t: 'control.release', sessionId: session!.id })}>
                Return control
              </Button>
            </>
          )}
          <Button variant="ghost" small onClick={leave} title="Stand up (Esc)">
            Leave
          </Button>
        </div>
        {session ? (
          <TerminalView key={session.id} sessionId={session.id} fitPane={fit} />
        ) : (
          <div className="term">
            <div className="term-overlay">
              {e.name} has no session yet.
              <br />
              Start one, or assign a task and Orchestrator will start it.
            </div>
          </div>
        )}
      </div>
      <div className="glass ws-side">
        <div>
          <div className="section-title">Status — from real signals</div>
          <div className="row">
            <Badge tone={questions.length ? 'warn' : activity === 'blocked' ? 'bad' : live ? 'info' : 'muted'}>{ACTIVITY_LABEL[activity] ?? activity}</Badge>
            {session && <span className="small muted">for {timeAgo(session.activitySince).replace(' ago', '')}</span>}
          </div>
          {session?.activityDetail && <div className="small mono muted pre" style={{ marginTop: 4 }}>{session.activityDetail}</div>}
          {session && !session.capabilities.hooks && live && <div className="small" style={{ marginTop: 6, color: '#ffd27a' }}>This session has no hooks, so only its terminal can be observed — activity is not inferred.</div>}
        </div>
        {questions.map((q) => (
          <div key={q.id} className="card">
            <QuestionBody q={q} />
          </div>
        ))}
        <div>
          <div className="section-title">Current task</div>
          {task ? (
            <div className="col" style={{ gap: 4 }}>
              <button className="feed-item" style={{ padding: 0 }} onClick={() => s.openPanel('task', task.id)}>
                <span className="feed-text">
                  <span className="mono muted">{task.key}</span> {task.title}
                </span>
              </button>
              {task.progress.percent != null && <Progress value={task.progress.percent} />}
              {task.progress.note && <div className="small muted">{task.progress.note}</div>}
              <div className="small faint">
                Prompt delivery: {task.delivery.status}
                {task.delivery.via ? ` (${task.delivery.via.replace('_', ' ')})` : ''}
              </div>
            </div>
          ) : (
            <div className="small muted">None.</div>
          )}
        </div>
        <div>
          <div className="section-title">Actions</div>
          <div className="ws-actions">
            <Button small onClick={() => s.openPanel('task', `new:${e.id}`)}>
              Assign task
            </Button>
            <Button small onClick={() => s.openPanel('task', task ? `${task.id}:diff` : `diff:${e.id}`)} disabled={!session}>
              View changes
            </Button>
            {paused ? (
              <Button small variant="success" onClick={() => act(() => api('POST', `/employees/${e.id}/resume`, {}), 'Resumed')}>
                Resume work
              </Button>
            ) : (
              <Button small onClick={() => act(() => api('POST', `/employees/${e.id}/pause`, {}), 'Interrupted')} disabled={!live} title="A real interrupt of the running turn (Escape, or the SDK interrupt): a real interrupt of the current turn">
                Interrupt
              </Button>
            )}
            <Button small onClick={() => act(() => api('POST', `/employees/${e.id}/report`, {}), 'Summary requested from the session')} disabled={!live}>
              Request summary
            </Button>
            <Button small onClick={() => s.openPanel('projects', e.projectId)} disabled={!e.projectId} title={e.projectId ? 'Open the project this employee works on' : 'Not on a project'}>
              Open project
            </Button>
            <Button small onClick={() => s.openPanel('docs', e.id)} title="The Markdown documents in their folder">
              Documents
            </Button>
            <Button small onClick={() => s.openPanel('employee', e.id)}>
              Profile
            </Button>
            {live ? (
              <Button small variant="danger" onClick={() => window.confirm(`Stop ${e.name}'s Claude Code session? It can be resumed later.`) && act(() => api('POST', `/employees/${e.id}/stop`, {}), 'Session stopped')}>
                {session?.origin === 'attached' ? 'Detach' : 'Stop session'}
              </Button>
            ) : (
              <Button small variant="success" onClick={() => act(() => api('POST', `/employees/${e.id}/start`, {}), 'Session starting')} disabled={!e.hostId}>
                {session?.lastEventAt ? 'Resume session' : 'Start session'}
              </Button>
            )}
          </div>
        </div>
        <div>
          <div className="section-title">Send a message</div>
          <textarea value={msg} placeholder={`Tell ${e.name} something. It is delivered into this session when it is between turns.`} onChange={(ev) => setMsg(ev.target.value)} style={{ minHeight: 56 }} />
          <Button small variant="primary" disabled={!msg.trim()} style={{ marginTop: 6 }} onClick={() => act(() => api('POST', `/employees/${e.id}/message`, { body: msg }), 'Message queued').then((r) => r && setMsg(''))}>
            Send message
          </Button>
        </div>
        {session && (
          <div>
            <div className="section-title">Session</div>
            <dl className="kv small">
              <dt>Runtime</dt>
              <dd>{session.origin === 'managed' ? 'Managed interactive Claude Code' : 'Attached existing session'}</dd>
              <dt>Permission mode</dt>
              <dd>{session.permissionMode ?? '—'}</dd>
              <dt>Capabilities</dt>
              <dd>{(['terminal', 'hooks', 'mcp', 'structuredApproval', 'usage'] as const).filter((c) => session.capabilities[c]).join(', ') || 'terminal only'}</dd>
              <dt>Tokens</dt>
              <dd>{session.usage ? `${session.usage.outputTokens.toLocaleString()} out / ${session.usage.inputTokens.toLocaleString()} in (measured)` : 'not available'}</dd>
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
