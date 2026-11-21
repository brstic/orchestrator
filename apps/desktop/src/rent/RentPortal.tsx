/**
 * The Rent portal (`docs/RENT.md`): where a client of the office talks to the employees they rent. It is not the office —
 * no 3D, no windows of the office — but a chat at the office's address: the employees down the side, one conversation
 * each, and a box to write in. It looks like the entrance page (the office at night: dark floor, gold, the logo's violet
 * and teal), and works on a phone as well as on a computer.
 *
 *   /r/<code>  an invitation: who it is for, and a password of their own → in
 *   /rent      signing in (name and password), then the portal
 *
 * Everything it asks of the office is under `/rent/api`, with the client's own session (kept in this browser as
 * `orch.rent-token`). The office answers nothing else to it.
 */
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { matchesWords, searchWords, snippetOf, type Appearance, type RentLine, type SaidFile } from '@orchestrator/contracts';
import { Avatar, Markdown } from '@orchestrator/ui';
import { serverBase } from '../lib/api.ts';
import { Marked, useFoundMarks, useSettled } from '../lib/found.tsx';
import logo from '../entrance/logo.svg';
import type { StageMood, StageReaction } from './AgentStage.tsx';
import { isNew, landOn } from './landing.ts';
import './rent.css';
import { phoneReady } from './phone.ts';

// The 3D (three.js) is loaded only when it is shown: the portal opens with faces and the figures follow.
const AgentStage = lazy(() => import('./AgentStage.tsx').then((m) => ({ default: m.AgentStage })));
const TeamStage = lazy(() => import('./AgentStage.tsx').then((m) => ({ default: m.TeamStage })));
/** Can this browser draw in 3D? Asked once, without loading three.js for it. */
let webgl: boolean | null = null;
const canDraw3d = (): boolean => {
  if (webgl !== null) return webgl;
  try {
    const c = document.createElement('canvas');
    webgl = !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    webgl = false;
  }
  return webgl;
};
const STAGE = 'orch.rent-stage';

const TOKEN = 'orch.rent-token';
const SEEN = 'orch.rent-seen';
const CHUNK = 768 * 1024;

const read = (key: string): string => {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* a private window keeps nothing */
  }
};

class SignedOut extends Error {}

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${serverBase}${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401 && token) throw new SignedOut(data.error ?? 'Sign in again.');
  if (!res.ok) throw new Error(data.error ?? `The office answered ${res.status}.`);
  return data as T;
}

type Doing = 'thinking' | 'reading' | 'writing' | 'running' | 'researching' | 'waiting';
interface Agent {
  id: string;
  name: string;
  title: string;
  appearance: Appearance;
  state: 'working' | 'available' | 'away' | 'paused';
  busy: boolean;
  files: boolean;
  since: string;
  /** Their machine is not connected (a computer that is off): away until it is back. */
  offline?: boolean;
  doing?: Doing | null;
  last: RentLine | null;
}
const DOING_WORD: Record<Doing, string> = { thinking: 'thinking', reading: 'reading', writing: 'writing', running: 'running something', researching: 'looking things up', waiting: 'waiting on the office' };
const moodOf = (a: Agent, reading: boolean): StageMood =>
  a.state === 'away' ? 'away' : a.state === 'paused' ? 'paused' : a.busy ? (a.doing === 'reading' || a.doing === 'researching' ? 'reading' : a.doing === 'thinking' || a.doing === 'waiting' ? 'thinking' : 'working') : reading ? 'reading' : 'available';
interface Me {
  office: string;
  name: string;
  company: string | null;
  agents: Agent[];
}
type Line = RentLine & { delivery?: string };

const STATE_WORD: Record<Agent['state'], string> = { working: 'Working', available: 'Available', away: 'Away', paused: 'Paused' };
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayOf = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
};
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** The portal: the invitation, signing in, or the conversations — whichever this address and this browser are at. */
export function RentPortal() {
  const code = /^\/r\/([A-Za-z0-9.-]+)/.exec(window.location.pathname)?.[1] ?? null;
  const [token, setToken] = useState(() => read(TOKEN));
  const [joining, setJoining] = useState(!!code);
  const signedIn = (t: string) => {
    write(TOKEN, t);
    setToken(t);
    setJoining(false);
    if (window.location.pathname !== '/rent') window.history.replaceState({}, '', '/rent');
  };
  const signOut = () => {
    write(TOKEN, null);
    setToken('');
  };
  useEffect(() => {
    document.title = 'Rent portal';
    return phoneReady('');
  }, []);
  if (joining && code) return <Join code={code} onIn={signedIn} onSignIn={() => (setJoining(false), window.history.replaceState({}, '', '/rent'))} />;
  if (!token) return <SignIn onIn={signedIn} />;
  return <Portal token={token} onOut={signOut} onToken={signedIn} />;
}

// ───────────── coming in ─────────────

function Door({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="rp rp-door">
      <div className="rp-glow" aria-hidden />
      <main className={`rp-card ${wide ? 'rp-card-wide' : ''}`}>
        <img src={logo} alt="" className="rp-card-logo" width={48} height={48} />
        {children}
      </main>
    </div>
  );
}

function Join({ code, onIn, onSignIn }: { code: string; onIn: (token: string) => void; onSignIn: () => void }) {
  const [info, setInfo] = useState<{ office: string; name: string; company: string | null; agents: Array<{ name: string; title: string; appearance?: Appearance }> } | null>(null);
  const [gone, setGone] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call<typeof info>('GET', `/rent/join/${encodeURIComponent(code)}`).then(setInfo, (e: Error) => setGone(e.message));
  }, [code]);
  if (gone)
    return (
      <Door>
        <h1 className="rp-h1">This link no longer works</h1>
        <p className="rp-lead">{gone}</p>
        <button type="button" className="rp-btn rp-btn-ghost" onClick={onSignIn}>
          I have a password — sign in
        </button>
      </Door>
    );
  if (!info)
    return (
      <Door>
        <p className="rp-lead">Opening your invitation…</p>
      </Door>
    );
  const short = password.length > 0 && password.length < 8;
  const differ = again.length > 0 && again !== password;
  const ready = password.length >= 8 && again === password && !busy;
  return (
    <Door>
      {canDraw3d() && info.agents.some((a) => a.appearance) && (
        <Suspense fallback={<div className="rp-team-canvas" />}>
          <TeamStage looks={info.agents.map((a) => a.appearance).filter((a): a is Appearance => !!a)} />
        </Suspense>
      )}
      <div className="rp-eyebrow">{info.office} · Rent portal</div>
      <h1 className="rp-h1">Welcome, {info.name.split(' ')[0]}</h1>
      <p className="rp-lead">
        {info.office} gives you {info.agents.length === 1 ? 'an AI employee' : `${info.agents.length} AI employees`} to work with. Talk to them here, like in any chat — they do the work and answer you.
      </p>
      {info.agents.length > 0 && (
        <ul className="rp-team">
          {info.agents.map((a) => (
            <li key={a.name}>
              <span className="rp-initial" aria-hidden>
                {a.name.slice(0, 1)}
              </span>
              <span>
                <b>{a.name}</b>
                <small>{a.title}</small>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        className="rp-form"
        onSubmit={async (ev) => {
          ev.preventDefault();
          if (!ready) return;
          setBusy(true);
          setError('');
          try {
            const r = await call<{ token: string }>('POST', '/rent/join', { code, password });
            try {
              write('orch.rent-name', info.name);
            } catch {
              /* nothing */
            }
            onIn(r.token);
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      >
        <div className="rp-field">
          <label htmlFor="rp-name">Your name</label>
          <input id="rp-name" value={info.name} readOnly autoComplete="username" />
        </div>
        <div className="rp-field">
          <label htmlFor="rp-pw">Choose a password</label>
          <input id="rp-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus minLength={8} placeholder="8 characters or more" data-rent-password />
          {short && <small className="rp-hint">At least 8 characters.</small>}
        </div>
        <div className="rp-field">
          <label htmlFor="rp-pw2">The same once more</label>
          <input id="rp-pw2" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" data-rent-password-again />
          {differ && <small className="rp-hint">The two are not the same.</small>}
        </div>
        {error && (
          <div className="rp-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="rp-btn" disabled={!ready} data-rent-join>
          {busy ? 'Opening…' : 'Start'}
        </button>
        <p className="rp-fine">
          From now on you sign in at <b>{window.location.host}/rent</b> with your name and this password. This link works only once.
        </p>
      </form>
    </Door>
  );
}

function SignIn({ onIn }: { onIn: (token: string) => void }) {
  const [name, setName] = useState(() => read('orch.rent-name'));
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Door>
      <div className="rp-eyebrow">Rent portal</div>
      <h1 className="rp-h1">Sign in</h1>
      <p className="rp-lead">Talk to the AI employees who work for you.</p>
      <form
        className="rp-form"
        onSubmit={async (ev) => {
          ev.preventDefault();
          if (busy || !name.trim() || !password) return;
          setBusy(true);
          setError('');
          try {
            const r = await call<{ token: string; kind?: string }>('POST', '/rent/login', { username: name.trim(), password });
            if (r.kind !== 'client') {
              setError('That is a member of the office, not a client: members go in at the office itself.');
              setBusy(false);
              return;
            }
            write('orch.rent-name', name.trim());
            onIn(r.token);
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      >
        <div className="rp-field">
          <label htmlFor="rp-in-name">Name</label>
          <input id="rp-in-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" autoFocus={!name} data-rent-signin-name />
        </div>
        <div className="rp-field">
          <label htmlFor="rp-in-pw">Password</label>
          <input id="rp-in-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus={!!name} data-rent-signin-password />
        </div>
        {error && (
          <div className="rp-error" role="alert">
            {error}
          </div>
        )}
        <button type="submit" className="rp-btn" disabled={busy || !name.trim() || !password} data-rent-signin>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="rp-fine">No password yet? Open the link you were sent. Forgot it? Ask whoever invited you for a new link.</p>
      </form>
    </Door>
  );
}

// ───────────── the conversations ─────────────

function Portal({ token, onOut, onToken }: { token: string; onOut: () => void; onToken: (t: string) => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(() => window.location.hash.slice(1) || null);
  /** On a phone the list and a conversation take the whole screen in turn. */
  const [showChat, setShowChat] = useState(!!window.location.hash.slice(1));
  const [menu, setMenu] = useState(false);
  const [changing, setChanging] = useState(false);
  // Searching (the side bar): the team by name, and every conversation by what was said in it.
  const [q, setQ] = useState('');
  const settled = useSettled(q.trim());
  const [found, setFound] = useState<{ q: string; hits: Line[]; words: string[]; more: boolean } | null>(null);
  /** A line a search found, to be shown in its conversation (`at` makes the same line again a new jump). */
  const [jump, setJump] = useState<Jump | null>(null);
  const [seen, setSeen] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(read(SEEN) || '{}');
    } catch {
      return {};
    }
  });
  const ask = useCallback(
    <T,>(method: string, path: string, body?: unknown) =>
      call<T>(method, `/rent/api${path}`, body, token).catch((e) => {
        if (e instanceof SignedOut) onOut();
        throw e;
      }),
    [token, onOut],
  );
  const load = useCallback(() => ask<Me>('GET', '/me').then((m) => (setMe(m), setError('')), (e: Error) => setError(e.message)), [ask]);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(t);
  }, [load]);
  // Coming in: a conversation where something new waits (an employee wrote while they were away) is the one opened —
  // unless the one they came back to has something new itself. Once, on the first look; after that they choose.
  const landed = useRef(false);
  useEffect(() => {
    if (!me || landed.current) return;
    landed.current = true;
    const to = landOn(me.agents, seen, open);
    if (to) setOpen(to);
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (settled.length < 2) return setFound(null);
    let gone = false;
    ask<{ hits: Line[]; words: string[]; more: boolean }>('POST', '/search', { q: settled, limit: 40 }).then(
      (r) => !gone && setFound({ q: settled, ...r }),
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [settled, ask]);
  const agent = me?.agents.find((a) => a.id === open) ?? me?.agents[0] ?? null;
  useEffect(() => {
    if (agent && window.location.hash.slice(1) !== agent.id) window.history.replaceState({}, '', `/rent#${agent.id}`);
  }, [agent?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const markSeen = useCallback((eid: string, lineId: string) => {
    setSeen((s) => {
      if (s[eid] === lineId) return s;
      const next = { ...s, [eid]: lineId };
      write(SEEN, JSON.stringify(next));
      return next;
    });
  }, []);

  if (!me)
    return (
      <div className="rp rp-loading">
        <img src={logo} alt="" width={44} height={44} />
        <span>{error || 'Opening…'}</span>
      </div>
    );
  return (
    <div className={`rp rp-app ${showChat ? 'rp-show-chat' : 'rp-show-list'}`}>
      <aside className="rp-side" aria-label="Your team">
        <header className="rp-brand">
          <img src={logo} alt="" width={34} height={34} />
          <div>
            <b>{me.office}</b>
            <small>Rent portal</small>
          </div>
        </header>
        {me.agents.length > 0 && (
          <div className="rp-side-find" role="search">
            <SearchIcon />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQ('')}
              placeholder="Search your team and messages"
              aria-label="Search your team and messages"
              enterKeyHint="search"
              data-rent-search
            />
            {q && (
              <button type="button" className="rp-find-clear" aria-label="Clear the search" onClick={() => setQ('')}>
                ×
              </button>
            )}
          </div>
        )}
        {(() => {
          // (Searching: the people who fit, if any — then the messages; nobody fitting is said only when nothing else is shown.)
          const fit = me.agents.some((a) => matchesWords(`${a.name} ${a.title}`, searchWords(q)));
          if (!q.trim()) return <div className="rp-side-label">Your team</div>;
          if (fit) return <div className="rp-side-label">People</div>;
          return q.trim().length < 2 ? <p className="rp-empty-side rp-empty-find">Nobody by that name.</p> : null;
        })()}
        <nav className="rp-agents">
          {me.agents.length === 0 && <p className="rp-empty-side">Nobody is assigned to you yet.</p>}
          {me.agents.filter((a) => !q.trim() || matchesWords(`${a.name} ${a.title}`, searchWords(q))).map((a) => {
            const unread = isNew(a, seen) && a.id !== agent?.id;
            return (
              <button
                key={a.id}
                type="button"
                className={`rp-agent ${a.id === agent?.id ? 'rp-agent-on' : ''}`}
                onClick={() => {
                  setOpen(a.id);
                  setShowChat(true);
                }}
                data-rent-agent={a.name}
              >
                <span className="rp-face">
                  <Avatar appearance={a.appearance} size={42} offline={a.state === 'away'} />
                  <i className={`rp-dot rp-dot-${a.state}`} aria-hidden />
                </span>
                <span className="rp-agent-main">
                  <span className="rp-agent-top">
                    <b>{a.name}</b>
                    {a.last && <small>{time(a.last.ts)}</small>}
                  </span>
                  <span className="rp-agent-sub">{a.busy ? <em>working on it…</em> : a.last ? `${a.last.from === 'client' ? 'You: ' : ''}${a.last.text || (a.last.files?.length ? `📎 ${a.last.files[0]!.name}` : '')}` : a.title}</span>
                </span>
                {unread && <i className="rp-unread" aria-label="new" />}
              </button>
            );
          })}
          {q.trim().length >= 2 && (
            <div className="rp-found" data-rent-found>
              <div className="rp-side-label">Messages</div>
              {!found || found.q !== settled ? (
                <p className="rp-empty-side">Searching…</p>
              ) : found.hits.length === 0 ? (
                <p className="rp-empty-side">No message has “{found.q}” in it.</p>
              ) : (
                found.hits.map((h) => {
                  const who = me.agents.find((a) => a.id === h.employeeId);
                  const text = h.text || (h.files ?? []).map((f) => `📎 ${f.name}`).join(' ');
                  return (
                    <button
                      key={h.id}
                      type="button"
                      className={`rp-hit ${jump?.lineId === h.id ? 'rp-hit-on' : ''}`}
                      onClick={() => {
                        setOpen(h.employeeId);
                        setShowChat(true);
                        setJump({ employeeId: h.employeeId, lineId: h.id, q: found.q, at: Date.now() });
                      }}
                      data-rent-hit={h.id}
                    >
                      <span className="rp-hit-top">
                        <b>{h.from === 'client' ? `You → ${who?.name ?? ''}` : who?.name}</b>
                        <small>{dayOf(h.ts)}</small>
                      </span>
                      <Marked className="rp-hit-text" text={snippetOf(text, found.words, 110)} words={found.words} />
                    </button>
                  );
                })
              )}
              {found?.more && found.q === settled && <p className="rp-empty-side">Only the newest are shown — add a word to find fewer.</p>}
            </div>
          )}
        </nav>
        <footer className="rp-me">
          <span className="rp-initial rp-initial-me" aria-hidden>
            {me.name.slice(0, 1)}
          </span>
          <span className="rp-me-name">
            <b>{me.name}</b>
            {me.company && <small>{me.company}</small>}
          </span>
          <button type="button" className="rp-icon" aria-label="Your account" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <circle cx="5" cy="12" r="1.8" fill="currentColor" />
              <circle cx="12" cy="12" r="1.8" fill="currentColor" />
              <circle cx="19" cy="12" r="1.8" fill="currentColor" />
            </svg>
          </button>
          {menu && (
            <div className="rp-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => (setMenu(false), setChanging(true))}>
                Change password
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void ask('POST', '/logout', {}).finally(onOut);
                }}
                data-rent-signout
              >
                Sign out
              </button>
            </div>
          )}
        </footer>
      </aside>
      <section className="rp-main">
        {agent ? (
          <Chat key={agent.id} agent={agent} me={me.name} ask={ask} jump={jump?.employeeId === agent.id ? jump : null} onBack={() => setShowChat(false)} onSeen={markSeen} onSent={() => void load()} />
        ) : (
          <div className="rp-blank">
            <img src={logo} alt="" width={56} height={56} />
            <h2>Nobody here yet</h2>
            <p>When {me.office} assigns you an AI employee, they appear on the left.</p>
          </div>
        )}
      </section>
      {changing && <ChangePassword ask={ask} onClose={() => setChanging(false)} onToken={onToken} />}
    </div>
  );
}

/** A line a search found, to be shown in its conversation. */
interface Jump {
  employeeId: string;
  lineId: string;
  q: string;
  at: number;
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden className="rp-search-icon">
      <circle cx="10.5" cy="10.5" r="6.2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M15.2 15.2L20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

interface Pending {
  key: string;
  name: string;
  size: number;
  done: number;
  id: string | null;
  error: string | null;
}

function Chat({ agent, me, ask, jump, onBack, onSeen, onSent }: { agent: Agent; me: string; ask: <T>(method: string, path: string, body?: unknown) => Promise<T>; jump: Jump | null; onBack: () => void; onSeen: (eid: string, lineId: string) => void; onSent: () => void }) {
  const [lines, setLines] = useState<Line[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState(agent);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const last = useRef<string>('');
  const stick = useRef(true);
  // The figure: what they do, a gesture now and then, and a word over their head.
  const [reaction, setReaction] = useState<StageReaction | null>(null);
  const [bubble, setBubble] = useState<string | null>(null);
  const [readingUntil, setReadingUntil] = useState(0);
  const [stageOn, setStageOn] = useState(() => read(STAGE) !== 'off');
  // Writing on a phone: the desk steps aside so that the conversation has the room the keyboard leaves (rent.css).
  const [typing, setTyping] = useState(false);
  const seenIds = useRef<Set<string> | null>(null);
  const say = useCallback((text: string, pose: StageReaction['pose']) => {
    setReaction({ pose, at: Date.now() });
    setBubble(text);
    window.setTimeout(() => setBubble((b) => (b === text ? null : b)), 2800);
  }, []);

  const pull = useCallback(async () => {
    const r = await ask<{ agent: Agent; lines: Line[]; pending: Line[]; whole: boolean }>('GET', `/chats/${agent.id}${last.current ? `?after=${last.current}` : ''}`);
    setLive((a) => ({ ...a, ...r.agent }));
    setLines((prev) => {
      const base = r.whole ? [] : prev;
      const byId = new Map(base.map((l) => [l.id, l]));
      for (const l of [...r.lines, ...r.pending]) byId.set(l.id, { ...byId.get(l.id), ...l });
      const next = [...byId.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      if (next.length) last.current = next[next.length - 1]!.id;
      return next;
    });
    setLoaded(true);
  }, [agent.id, ask]);
  /** The whole kept conversation, not only its last 200 lines: to go to an old line a search found. */
  const whole = useRef(false);
  const pullAll = useCallback(async () => {
    const r = await ask<{ agent: Agent; lines: Line[]; pending: Line[] }>('GET', `/chats/${agent.id}?all=1`);
    whole.current = true;
    setLive((a) => ({ ...a, ...r.agent }));
    setLines((prev) => {
      const byId = new Map(r.lines.map((l) => [l.id, l] as const));
      for (const l of [...prev, ...r.pending]) byId.set(l.id, { ...byId.get(l.id), ...l });
      const next = [...byId.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
      if (next.length) last.current = next[next.length - 1]!.id;
      return next;
    });
  }, [agent.id, ask]);

  // Searching this conversation (the magnifier, or Ctrl/⌘ F): the whole of it, on the server; ↑ older, ↓ newer.
  const [finding, setFinding] = useState(false);
  const [fq, setFq] = useState('');
  const fSettled = useSettled(fq.trim());
  const [hits, setHits] = useState<{ q: string; ids: string[]; words: string[]; more: boolean } | null>(null);
  const [hitAt, setHitAt] = useState(0);
  const [focus, setFocus] = useState<string | null>(null);
  const wantId = useRef<string | null>(null);
  const findBox = useRef<HTMLInputElement>(null);
  const linesIn = useRef<HTMLDivElement>(null);
  const closeFind = () => {
    setFinding(false);
    setFq('');
    setHits(null);
    setFocus(null);
  };
  useEffect(() => {
    if (!finding || fSettled.length < 1) return setHits(null);
    let gone = false;
    ask<{ hits: Line[]; words: string[]; more: boolean }>('POST', '/search', { q: fSettled, eid: agent.id, limit: 500 }).then(
      (r) => {
        if (gone) return;
        const ids = r.hits.map((h) => h.id);
        const want = wantId.current ? ids.indexOf(wantId.current) : -1;
        wantId.current = null;
        setHits({ q: fSettled, ids, words: r.words, more: r.more });
        setHitAt(Math.max(0, want));
      },
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [finding, fSettled, agent.id, ask]);
  // Going to the line found: the whole conversation is fetched first when it is older than what is shown.
  const goTo = useCallback(
    async (id: string) => {
      stick.current = false;
      if (!whole.current && !lines.some((l) => l.id === id)) await pullAll().catch(() => undefined);
      setFocus(id);
    },
    [lines, pullAll],
  );
  const hitId = hits?.ids[hitAt] ?? null;
  useEffect(() => {
    if (loaded && hitId) void goTo(hitId);
  }, [hitId, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (!focus) return;
    scroller.current?.querySelector(`[data-line-id="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focus, lines.length]);
  // A line found in the side bar: this conversation's search opens with the same words, on that line.
  useEffect(() => {
    if (!jump || !loaded) return;
    wantId.current = jump.lineId;
    setFinding(true);
    setFq(jump.q);
    void goTo(jump.lineId);
  }, [jump?.at, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFinding(true);
        window.setTimeout(() => findBox.current?.select(), 0);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useFoundMarks(linesIn, finding ? (hits?.words ?? []) : [], 'rent-found', [lines, finding, hits]);

  useEffect(() => {
    last.current = '';
    void pull().catch(() => undefined);
    const t = window.setInterval(() => void pull().catch(() => undefined), 1500);
    return () => window.clearInterval(t);
  }, [pull]);
  useEffect(() => {
    const l = lines[lines.length - 1];
    if (l) onSeen(agent.id, l.id);
    if (!loaded) return;
    if (!seenIds.current) {
      seenIds.current = new Set(lines.map((x) => x.id));
      return;
    }
    const fresh = lines.filter((x) => !seenIds.current!.has(x.id));
    for (const x of fresh) seenIds.current.add(x.id);
    if (fresh.some((x) => x.from === 'agent')) say(['Done!', 'Here you go', 'All yours', 'Got it'][Math.floor(Math.random() * 4)]!, 'thumbsUp');
  }, [lines, agent.id, onSeen, loaded, say]);
  // New lines keep the view at the bottom — unless the client has scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, live.busy]);
  useEffect(() => {
    if (window.matchMedia('(pointer: fine)').matches) box.current?.focus();
  }, [agent.id]);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const upload = async (file: File) => {
    const key = `${file.name}-${file.size}-${Math.random()}`;
    setFiles((f) => [...f, { key, name: file.name, size: file.size, done: 0, id: null, error: null }]);
    const set = (patch: Partial<Pending>) => setFiles((fs) => fs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
    try {
      const made = await ask<{ id: string }>('POST', `/chats/${agent.id}/files`, { name: file.name, size: file.size });
      const buf = new Uint8Array(await file.arrayBuffer());
      for (let offset = 0; offset < buf.length || offset === 0; offset += CHUNK) {
        const part = buf.subarray(offset, offset + CHUNK);
        let bin = '';
        for (let i = 0; i < part.length; i += 0x8000) bin += String.fromCharCode(...part.subarray(i, i + 0x8000));
        await ask('POST', `/chats/${agent.id}/files/${made.id}/data`, { offset, dataBase64: btoa(bin) });
        set({ done: Math.min(buf.length, offset + part.length) });
        if (!buf.length) break;
      }
      set({ id: made.id, done: file.size });
    } catch (e) {
      set({ error: (e as Error).message });
    }
  };
  const ready = files.every((f) => f.id || f.error);
  const send = async () => {
    const words = text.trim();
    const ids = files.filter((f) => f.id).map((f) => f.id!);
    if (sending || !ready || (!words && !ids.length)) return;
    setSending(true);
    setError('');
    try {
      const line = await ask<Line>('POST', `/chats/${agent.id}`, { text: words, files: ids });
      stick.current = true;
      setReadingUntil(Date.now() + 5000);
      setLines((ls) => (ls.some((l) => l.id === line.id) ? ls : [...ls, line]));
      last.current = line.id;
      setText('');
      setFiles([]);
      onSent();
      void pull().catch(() => undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
      box.current?.focus();
    }
  };

  // What to show between the lines: the day when it changes, and where the employee is now.
  const rows = useMemo(() => {
    const out: Array<{ kind: 'day'; key: string; day: string } | { kind: 'line'; key: string; line: Line; first: boolean }> = [];
    let day = '';
    let prevFrom = '';
    for (const l of lines) {
      const d = dayOf(l.ts);
      if (d !== day) {
        out.push({ kind: 'day', key: `d-${l.id}`, day: d });
        day = d;
        prevFrom = '';
      }
      out.push({ kind: 'line', key: l.id, line: l, first: l.from !== prevFrom });
      prevFrom = l.from;
    }
    return out;
  }, [lines]);
  const lastLine = lines[lines.length - 1];
  const thinking = live.busy || (!!lastLine && lastLine.from === 'client' && lastLine.delivery !== 'failed' && live.state !== 'away' && Date.now() - Date.parse(lastLine.ts) < 10 * 60_000);
  const doingWord = live.busy && live.doing ? DOING_WORD[live.doing] : null;
  const stateWord = live.offline ? 'away — their computer is off' : doingWord ? `${doingWord}…` : live.busy ? 'working…' : STATE_WORD[live.state].toLowerCase();
  const mood = moodOf(live, Date.now() < readingUntil);
  const first = me.split(' ')[0];
  const show3d = canDraw3d();
  const SUGGEST = [`Hi ${live.name}! What can you do for me?`, 'Where are we on the work so far?', 'Here is what I need today:'];

  return (
    <div
      className={`rp-chat ${over ? 'rp-chat-over' : ''}`}
      onDragOver={(e) => {
        if (!live.files || ![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
      onDrop={(e) => {
        if (!live.files) return;
        e.preventDefault();
        setOver(false);
        for (const f of Array.from(e.dataTransfer.files).slice(0, 10)) void upload(f);
      }}
    >
      <header className="rp-chat-head">
        <button type="button" className="rp-icon rp-back" aria-label="Back to your team" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
            <path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="rp-face">
          <Avatar appearance={live.appearance} size={40} offline={live.state === 'away'} />
          <i className={`rp-dot rp-dot-${live.state}`} aria-hidden />
        </span>
        <div className="rp-chat-who">
          <b>{live.name}</b>
          <small>
            {live.title} · <span className={`rp-state rp-state-${live.state}`} data-rent-state>{stateWord}</span>
          </small>
        </div>
        <button
          type="button"
          className={`rp-icon rp-find-toggle ${finding ? 'rp-stage-toggle-on' : ''}`}
          aria-pressed={finding}
          title={`Search the conversation with ${live.name}`}
          aria-label={`Search the conversation with ${live.name}`}
          onClick={() => (finding ? closeFind() : (setFinding(true), window.setTimeout(() => findBox.current?.focus(), 0)))}
          data-rent-find-open
        >
          <SearchIcon />
        </button>
        {show3d && (
          <button
            type="button"
            className={`rp-icon rp-stage-toggle ${stageOn ? 'rp-stage-toggle-on' : ''}`}
            aria-pressed={stageOn}
            title={stageOn ? `Hide ${live.name}'s desk` : `Show ${live.name}'s desk`}
            onClick={() => {
              write(STAGE, stageOn ? 'off' : null);
              setStageOn(!stageOn);
            }}
          >
            <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden>
              <path d="M3 18h18M5 18V9h14v9M9 9V6h6v3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </header>
      {finding && (
        <div className="rp-find" role="search">
          <SearchIcon />
          <input
            ref={findBox}
            type="search"
            value={fq}
            autoFocus
            onChange={(e) => setFq(e.target.value)}
            onKeyDown={(e) => {
              const n = hits?.ids.length ?? 0;
              if (e.key === 'Escape') (e.preventDefault(), closeFind());
              else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'ArrowUp') (e.preventDefault(), n && setHitAt((i) => Math.min(n - 1, i + 1)));
              else if ((e.key === 'Enter' && e.shiftKey) || e.key === 'ArrowDown') (e.preventDefault(), n && setHitAt((i) => Math.max(0, i - 1)));
            }}
            placeholder={`Search the conversation with ${live.name}`}
            aria-label={`Search the conversation with ${live.name}`}
            enterKeyHint="search"
            data-rent-find
          />
          <span className="rp-find-count" aria-live="polite" data-rent-find-count>
            {!fq.trim() ? '' : !hits || hits.q !== fSettled ? '…' : hits.ids.length === 0 ? 'Nothing found' : `${hitAt + 1} of ${hits.ids.length}${hits.more ? '+' : ''}`}
          </span>
          <button type="button" className="rp-icon rp-find-step" aria-label="Older" title="Older (Enter)" disabled={!hits || hitAt >= hits.ids.length - 1} onClick={() => setHitAt((i) => i + 1)} data-rent-find-older>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" className="rp-icon rp-find-step" aria-label="Newer" title="Newer (Shift+Enter)" disabled={!hits || hitAt <= 0} onClick={() => setHitAt((i) => i - 1)} data-rent-find-newer>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button type="button" className="rp-icon rp-find-step" aria-label="Close the search" onClick={closeFind}>
            ×
          </button>
        </div>
      )}
      <div className={`rp-chat-body ${show3d && stageOn ? 'rp-with-stage' : ''} ${typing ? 'rp-typing' : ''}`}>
      {show3d && stageOn && (
        <aside className="rp-stage" data-rent-stage={mood}>
          <Suspense fallback={<div className="rp-stage-canvas rp-stage-wait"><Avatar appearance={live.appearance} size={64} /></div>}>
            <AgentStage look={live.appearance} mood={mood} reaction={reaction} label={`${live.name} at their desk, ${stateWord}`} onPoke={() => say(live.state === 'away' ? 'Zzz…' : `Hi ${first}! 👋`, live.state === 'away' ? 'bow' : 'wave')} />
          </Suspense>
          <div className="rp-stage-tag" aria-hidden>
            <b>{live.name}</b>
            <span className={`rp-stage-word rp-stage-word-${mood}`}>{live.offline ? 'AWAY' : doingWord ? doingWord.toUpperCase() : live.busy ? 'WORKING' : STATE_WORD[live.state].toUpperCase()}</span>
          </div>
          {bubble && (
            <div className="rp-stage-bubble" key={bubble + (reaction?.at ?? 0)}>
              {bubble}
            </div>
          )}
          <div className="rp-stage-card">
            <div>
              <small>Works for you since</small>
              <b>{new Date(live.since).toLocaleDateString([], { month: 'long', day: 'numeric' })}</b>
            </div>
            <div>
              <small>Files</small>
              <b>{live.files ? 'both ways' : 'words only'}</b>
            </div>
            <p className="rp-stage-hint">Drag to turn the desk · click {live.name} to say hi</p>
          </div>
        </aside>
      )}
      <div className="rp-chat-col">
      <div
        className="rp-lines"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        data-rent-lines
      >
        <div className="rp-lines-in" ref={linesIn}>
          {loaded && lines.length === 0 && (
            <div className="rp-hello">
              <Avatar appearance={live.appearance} size={72} />
              <h2>{live.name}</h2>
              <p>
                {live.title}. Tell {live.name} what you need, in your own words — {live.files ? 'add files if they help. ' : ''}They work on it and answer here.
              </p>
              <div className="rp-suggest">
                {SUGGEST.map((s) => (
                  <button key={s} type="button" onClick={() => (setText(s), box.current?.focus())}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {rows.map((r) =>
            r.kind === 'day' ? (
              <div key={r.key} className="rp-day">
                <span>{r.day}</span>
              </div>
            ) : (
              <Bubble key={r.key} line={r.line} first={r.first} agent={live} ask={ask} fresh={!!seenIds.current && !seenIds.current.has(r.line.id)} found={finding && focus === r.line.id} />
            ),
          )}
          {thinking && (
            <div className="rp-row rp-row-agent">
              <span className="rp-row-face">
                <Avatar appearance={live.appearance} size={28} />
              </span>
              <div className="rp-bubble rp-bubble-agent rp-typing" aria-label={`${live.name} is working on it`} data-rent-typing>
                <i />
                <i />
                <i />
                {doingWord && <span className="rp-typing-word">{doingWord}</span>}
              </div>
            </div>
          )}
        </div>
      </div>
      <form
        className="rp-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {files.length > 0 && (
          <div className="rp-pending">
            {files.map((f) => (
              <span key={f.key} className={`rp-chip ${f.error ? 'rp-chip-bad' : ''}`} title={f.error ?? undefined}>
                📎 {f.name} <small>{f.error ? 'failed' : f.id ? size(f.size) : `${Math.round((f.done / Math.max(1, f.size)) * 100)}%`}</small>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {error && (
          <div className="rp-error rp-error-compose" role="alert">
            {error}
          </div>
        )}
        <div className="rp-box">
          {live.files && (
            <>
              <button type="button" className="rp-icon rp-attach" aria-label="Add files" title="Add files" onClick={() => picker.current?.click()}>
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden>
                  <path d="M20.5 11.5l-8.2 8.2a5.2 5.2 0 01-7.4-7.4l8.6-8.6a3.5 3.5 0 015 5l-8.6 8.6a1.8 1.8 0 01-2.5-2.5l7.8-7.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  for (const f of Array.from(e.target.files ?? []).slice(0, 10)) void upload(f);
                  e.target.value = '';
                }}
              />
            </>
          )}
          <textarea
            ref={box}
            rows={1}
            value={text}
            placeholder={`Message ${live.name}…`}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setTyping(true)}
            onBlur={() => setTyping(false)}
            enterKeyHint="send"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(pointer: fine)').matches) {
                e.preventDefault();
                void send();
              }
            }}
            onPaste={(e) => {
              if (!live.files) return;
              const pasted = Array.from(e.clipboardData.files);
              if (pasted.length) {
                e.preventDefault();
                for (const f of pasted.slice(0, 10)) void upload(f);
              }
            }}
            aria-label={`Message ${live.name}`}
            data-rent-box
          />
          <button type="submit" className="rp-send" aria-label="Send" disabled={sending || !ready || (!text.trim() && !files.some((f) => f.id))} data-rent-send>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
              <path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <small className="rp-compose-hint">{live.state === 'away' ? `${live.name} is away; they start as soon as you write.` : 'Enter to send · Shift+Enter for a new line'}</small>
      </form>
      </div>
      </div>
    </div>
  );
}

function Bubble({ line, first, agent, ask, fresh, found }: { line: Line; first: boolean; agent: Agent; ask: <T>(method: string, path: string, body?: unknown) => Promise<T>; fresh?: boolean; found?: boolean }) {
  if (line.from === 'note')
    return (
      <div className="rp-note" role="status" data-found-skip>
        {line.text}
      </div>
    );
  const mine = line.from === 'client';
  const tick = mine ? (line.delivery === 'failed' ? 'Not delivered' : line.delivery === 'confirmed' ? 'Seen' : 'Sent') : null;
  return (
    <div className={`rp-row ${mine ? 'rp-row-me' : 'rp-row-agent'} ${first ? 'rp-row-first' : ''} ${fresh ? 'rp-row-new' : ''} ${found ? 'rp-row-found' : ''}`} data-rent-line={line.from} data-line-id={line.id}>
      {!mine && <span className="rp-row-face">{first && <Avatar appearance={agent.appearance} size={28} />}</span>}
      <div className={`rp-bubble ${mine ? 'rp-bubble-me' : 'rp-bubble-agent'}`}>
        {line.files?.map((f) => (
          <FileView key={f.id} file={f} employeeId={line.employeeId} ask={ask} />
        ))}
        {line.text && (mine ? <div className="rp-text">{line.text}</div> : <Markdown text={line.text} className="rp-md" />)}
        <div className="rp-meta" data-found-skip>
          {time(line.ts)}
          {tick && <span className={`rp-tick ${line.delivery === 'failed' ? 'rp-tick-bad' : ''}`}> · {tick}</span>}
        </div>
      </div>
    </div>
  );
}

/** A file in a conversation: a picture is shown, anything else is a name to download. Fetched with the client's session. */
function FileView({ file, employeeId, ask }: { file: SaidFile; employeeId: string; ask: <T>(method: string, path: string, body?: unknown) => Promise<T> }) {
  void ask;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const picture = /^image\/(png|jpeg|gif|webp)$/.test(file.mime);
  const fetchIt = useCallback(async () => {
    const res = await fetch(`${serverBase}/rent/api/chats/${employeeId}/files/${file.id}`, { headers: { authorization: `Bearer ${read(TOKEN)}` } });
    if (!res.ok) throw new Error('gone');
    return URL.createObjectURL(await res.blob());
  }, [employeeId, file.id]);
  useEffect(() => {
    if (!picture) return;
    let made: string | null = null;
    fetchIt().then(
      (u) => setUrl((made = u)),
      () => setFailed(true),
    );
    return () => {
      if (made) URL.revokeObjectURL(made);
    };
  }, [picture, fetchIt]);
  const download = async () => {
    try {
      const u = url ?? (await fetchIt());
      const a = document.createElement('a');
      a.href = u;
      a.download = file.name;
      a.click();
    } catch {
      setFailed(true);
    }
  };
  if (picture && url)
    return (
      <button type="button" className="rp-picture" onClick={() => void download()} title={`${file.name} — click to download`}>
        <img src={url} alt={file.name} />
      </button>
    );
  return (
    <button type="button" className="rp-file" onClick={() => void download()} disabled={failed} data-rent-file={file.name}>
      <span className="rp-file-icon" aria-hidden>
        {file.name.split('.').pop()?.slice(0, 4).toUpperCase() || 'FILE'}
      </span>
      <span className="rp-file-name">
        <b>{file.name}</b>
        <small>{failed ? 'no longer kept' : `${size(file.size)} · download`}</small>
      </span>
    </button>
  );
}

function ChangePassword({ ask, onClose, onToken }: { ask: <T>(method: string, path: string, body?: unknown) => Promise<T>; onClose: () => void; onToken: (t: string) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="rp-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="rp-card rp-dialog"
        role="dialog"
        aria-label="Change password"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || next.length < 8) return;
          setBusy(true);
          setError('');
          try {
            const r = await ask<{ token: string }>('POST', '/password', { current, password: next });
            onToken(r.token);
            setDone(true);
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 className="rp-h2">Change password</h2>
        {done ? (
          <>
            <p className="rp-lead">Done. Other browsers you were signed in with are signed out.</p>
            <button type="button" className="rp-btn" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <div className="rp-field">
              <label htmlFor="rp-cur">Current password</label>
              <input id="rp-cur" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
            </div>
            <div className="rp-field">
              <label htmlFor="rp-new">New password</label>
              <input id="rp-new" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" placeholder="8 characters or more" />
            </div>
            {error && (
              <div className="rp-error" role="alert">
                {error}
              </div>
            )}
            <div className="rp-dialog-actions">
              <button type="button" className="rp-btn rp-btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="rp-btn" disabled={busy || !current || next.length < 8}>
                {busy ? 'Saving…' : 'Change'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
