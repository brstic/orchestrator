import { Component, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Door } from './Door.tsx';
import { SIN, laneOf, overscanOf, type Geo, type Slot } from './geometry.ts';
import './entrance.css';
import logo from './logo.svg';
import shotBoard from './shots/board.webp';
import shotCommand from './shots/command.webp';
import shotDesks from './shots/desks.webp';
import shotForeman from './shots/foreman.webp';
import shotHand from './shots/hand.webp';
import shotLounge from './shots/lounge.webp';
import shotRoom from './shots/room.webp';
import shotTerminal from './shots/terminal.webp';

/**
 * The page a browser gets at an office's address before anybody is signed in (`docs/ENTRANCE-PAGE.md`): what this
 * place is, shown with real pictures of the app and with the office's own little people standing on the page — and
 * the door (sign in, or knock) hanging beside it all the way down.
 *
 * The page scrolls by itself, natively; everything that moves reads the scroll position and follows it.
 */

// The scene (three.js and the office's models) arrives after the page is readable, and only where it can be drawn.
const Stage = lazy(() => import('./Stage.tsx'));

/** Whatever goes wrong in the drawing, the page and the door stay. */
class Quiet extends Component<{ children: ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFail();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function canDraw(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

const CALM_KEY = 'orch.entrance-calm';
/** A calm page — nothing runs, swings or slides — when the system asks for less motion, or the reader does here. */
function useCalm(): [boolean, boolean, (on: boolean) => void] {
  const [system, setSystem] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [chosen, setChosen] = useState<boolean | null>(() => {
    try {
      const v = localStorage.getItem(CALM_KEY);
      return v === null ? null : v === '1';
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const q = matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setSystem(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  const choose = useCallback((on: boolean) => {
    setChosen(on);
    try {
      localStorage.setItem(CALM_KEY, on ? '1' : '0');
    } catch {
      /* private window: for this visit only */
    }
  }, []);
  return [chosen ?? system, system, choose];
}

/** A real picture of the app, framed. */
function Shot({ src, alt, w, h, caption, tilt = 'left' }: { src: string; alt: string; w: number; h: number; caption: string; tilt?: 'left' | 'right' }) {
  return (
    <figure className={`ent-shot ent-shot-${tilt} ent-reveal`}>
      <div className="ent-shot-frame">
        <div className="ent-shot-bar" aria-hidden>
          <i />
          <i />
          <i />
          <span>real capture · demo office</span>
        </div>
        <img src={src} alt={alt} width={w} height={h} loading="lazy" decoding="async" />
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

const Key = ({ children, wide }: { children: ReactNode; wide?: boolean }) => <kbd className={wide ? 'ent-key ent-key-wide' : 'ent-key'}>{children}</kbd>;

/** Room on the page for something of the scene; `r` is the radius of its pool of light in metres. */
function Place({ id, kind = id, w, h, r, ax = 0.5, ay = 0.6, className = '' }: { id: string; kind?: string; w: number; h: number; r: number; ax?: number; ay?: number; className?: string }) {
  return <div className={`ent-slot ${className}`} data-station={id} data-kind={kind} data-ax={ax} data-ay={ay} style={{ '--w': w, '--h': h, '--r': r, '--ax': ax, '--ay': ay } as React.CSSProperties} aria-hidden />;
}

export default function EntrancePage({ office, onOwnToken }: { office: string; onOwnToken: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const rig = useRef<HTMLElement>(null);
  const tilt = useRef<HTMLDivElement>(null);
  const [calm, systemCalm, setCalm] = useCalm();
  const [size, setSize] = useState(() => ({ vw: window.innerWidth, vh: window.innerHeight }));
  const [layout, setLayout] = useState<{ geo: Geo; slots: Slot[] } | null>(null);
  const [drawable, setDrawable] = useState(canDraw);
  const [staged, setStaged] = useState(false);
  // Under this width there is no room beside the text for the little office: the page is the text, the pictures and the door.
  const wide = size.vw >= 860;
  // Where the little office cannot be drawn, the right-hand side is kept only as wide as the door.
  const flat = wide && !drawable;
  const { lane, ppu } = flat ? { lane: 348, ppu: laneOf(size.vw).ppu } : laneOf(size.vw);

  // ── the door: open where the page begins and where it ends; in between it is folded to its name, out of the way of
  // the little office, and opens again under the pointer, on a click, or when the keyboard comes to it ──
  const [edge, setEdge] = useState(true);
  /** Where the page was when the cursor went into one of the door's fields. */
  const focusedAt = useRef(0);
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const [typing, setTyping] = useState(false);
  // Somebody who has knocked is shown their code until they are answered.
  const [knocking, setKnocking] = useState(false);
  // (In a narrow window it lies over the text when open, so there it opens only when asked to.)
  const open = (wide && edge) || pinned || hover || typing || knocking;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const read = () => setSize((s) => (s.vw === el.clientWidth && s.vh === el.clientHeight ? s : { vw: el.clientWidth, vh: el.clientHeight }));
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Where the page left room for the scene's things, in the page's own pixels. Measured again whenever the page changes size.
  const measure = useCallback(() => {
    const sc = scroller.current;
    const pg = page.current;
    if (!sc || !pg) return;
    const pr = pg.getBoundingClientRect();
    const slots: Slot[] = [...pg.querySelectorAll<HTMLElement>('[data-station]')]
      .filter((el) => el.offsetParent !== null)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.station!, kind: el.dataset.kind!, x: Math.round(r.left - pr.left + r.width * Number(el.dataset.ax)), y: Math.round(r.top - pr.top + r.height * Number(el.dataset.ay)) };
      });
    const laneEl = pg.querySelector<HTMLElement>('.ent-lane-mark');
    const corridor = laneEl ? laneEl.getBoundingClientRect().left - pr.left + ppu * 0.55 : sc.clientWidth - lane;
    const geo: Geo = { vw: sc.clientWidth, vh: sc.clientHeight, pageH: pg.offsetHeight, ppu, over: overscanOf(sc.clientHeight), corridor };
    setLayout((was) => (was && JSON.stringify(was) === JSON.stringify({ geo, slots }) ? was : { geo, slots }));
  }, [lane, ppu]);
  useLayoutEffect(() => {
    measure();
    const pg = page.current;
    if (!pg) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    ro.observe(pg);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [measure, size.vw, size.vh]);

  // The tab says whose door this is.
  useEffect(() => {
    const was = document.title;
    document.title = `${office} · Orchestrator`;
    return () => void (document.title = was);
  }, [office]);

  // The keys that scroll a page (space, arrows, Page Down) go to this one from the start.
  useEffect(() => {
    if (document.activeElement === document.body || !document.activeElement) scroller.current?.focus({ preventScroll: true });
  }, []);

  // Things come into view once, as they are reached.
  useEffect(() => {
    const pg = page.current;
    if (!pg) return;
    const all = [...pg.querySelectorAll('.ent-reveal')];
    if (calm || typeof IntersectionObserver !== 'function') {
      all.forEach((el) => el.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add('is-in');
          io.unobserve(e.target);
        }
      },
      { root: scroller.current, rootMargin: '0px 0px -12% 0px', threshold: 0.08 },
    );
    all.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [calm]);

  // The door hangs from the top of the window: it swings a little against the way the page is scrolled, leans toward
  // the pointer, and comes to rest. Held still while somebody is using it.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let raf = 0;
    let last = el.scrollTop;
    let lastT = 0;
    let vel = 0;
    let angle = 0;
    let spin = 0;
    let lag = 0;
    let lagV = 0;
    let px = 0.5;
    let py = 0.5;
    let tx = 0;
    let ty = 0;
    let quietUntil = 0;
    const apply = () => {
      if (rig.current) rig.current.style.transform = `rotate(${angle.toFixed(3)}deg)`;
      if (tilt.current) tilt.current.style.transform = `translate3d(0, ${lag.toFixed(2)}px, 0) rotateX(${ty.toFixed(3)}deg) rotateY(${tx.toFixed(3)}deg)`;
    };
    const frame = (now: number) => {
      raf = 0;
      const dt = Math.min(0.05, lastT ? (now - lastT) / 1000 : 0.016);
      lastT = now;
      const top = el.scrollTop;
      vel += ((top - last) / Math.max(dt, 0.001) - vel) * Math.min(1, dt * 14);
      last = top;
      const held = !!rig.current && (rig.current.matches(':hover') || rig.current.contains(document.activeElement));
      const wantAngle = held ? 0 : Math.max(-5, Math.min(5, vel * 0.0022));
      spin += ((wantAngle - angle) * 70 - spin * (held ? 18 : 7.5)) * dt;
      angle += spin * dt;
      const wantLag = held ? 0 : Math.max(-22, Math.min(22, -vel * 0.012));
      lagV += ((wantLag - lag) * 90 - lagV * 13) * dt;
      lag += lagV * dt;
      const wx = held ? 0 : (px - 0.5) * 7;
      const wy = held ? 0 : (0.5 - py) * 5;
      tx += (wx - tx) * Math.min(1, dt * 6);
      ty += (wy - ty) * Math.min(1, dt * 6);
      apply();
      const moving = Math.abs(vel) > 2 || Math.abs(angle - wantAngle) > 0.01 || Math.abs(spin) > 0.02 || Math.abs(lag - wantLag) > 0.05 || Math.abs(lagV) > 0.1 || Math.abs(tx - wx) > 0.02 || Math.abs(ty - wy) > 0.02;
      if (moving || now < quietUntil) raf = requestAnimationFrame(frame);
      else lastT = 0;
    };
    const kick = () => {
      quietUntil = performance.now() + 400;
      if (!raf && !calm) raf = requestAnimationFrame(frame);
    };
    const onScroll = () => {
      const top = el.scrollTop;
      // Open where the page begins and where it ends; in between the door is folded.
      const atEdge = top < el.clientHeight * 0.3 || top + el.clientHeight > el.scrollHeight - el.clientHeight * 0.45;
      setEdge((was) => (was === atEdge ? was : atEdge));
      // Scrolled well away from the door with the cursor still in an empty field of it: the keys go back to the page.
      const at = document.activeElement as HTMLInputElement | null;
      if (!atEdge && at && at.tagName === 'INPUT' && !at.value && rig.current?.contains(at) && !rig.current.matches(':hover') && Math.abs(top - focusedAt.current) > el.clientHeight * 0.6) el.focus({ preventScroll: true });
      kick();
    };
    const onMove = (e: PointerEvent) => {
      px = e.clientX / window.innerWidth;
      py = e.clientY / window.innerHeight;
      kick();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('pointermove', onMove, { passive: true });
    onScroll();
    if (calm) {
      angle = lag = tx = ty = 0;
      apply();
    }
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('pointermove', onMove);
    };
  }, [calm]);

  const fold = () => {
    if (rig.current?.contains(document.activeElement)) scroller.current?.focus({ preventScroll: true });
    setPinned(false);
    setHover(false);
    setTyping(false);
  };
  // Opened on purpose: the cursor goes where the typing starts (once the fields are back within its reach).
  const wantsCursor = useRef(false);
  const unfold = () => {
    wantsCursor.current = true;
    setPinned(true);
  };
  useEffect(() => {
    if (!open || !wantsCursor.current) return;
    wantsCursor.current = false;
    rig.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
  }, [open, pinned]);
  // Under the pointer the door opens by itself (not for a pointer that is only passing), and folds again a moment
  // after the pointer has left.
  const leaving = useRef(0);
  const onEnter = () => {
    window.clearTimeout(leaving.current);
    leaving.current = window.setTimeout(() => setHover(true), 140);
  };
  const onLeave = () => {
    window.clearTimeout(leaving.current);
    leaving.current = window.setTimeout(() => setHover(false), 450);
  };
  useEffect(() => () => window.clearTimeout(leaving.current), []);
  // It does not fold under somebody who is typing in it.
  const onFocus = (e: React.FocusEvent) => {
    if ((e.target as HTMLElement).tagName !== 'INPUT') return;
    focusedAt.current = scroller.current?.scrollTop ?? 0;
    setTyping(true);
  };
  const onBlur = (e: React.FocusEvent) => {
    if (!rig.current?.contains(e.relatedTarget as Node | null)) setTyping(false);
  };

  const stage = wide && drawable && layout;
  const style = useMemo(() => ({ '--m': `${ppu}px`, '--lane': `${lane}px`, '--sin': SIN }) as React.CSSProperties, [ppu, lane]);

  return (
    <div ref={scroller} className={`ent ${calm ? 'ent-calm' : ''} ${staged ? 'ent-staged' : ''} ${wide ? '' : 'ent-narrow'} ${flat ? 'ent-flat' : ''}`} style={style} tabIndex={-1}>
      {/* The door: first in the page for the keyboard and for a screen reader, hanging on the right for the eye. */}
      <div className="ent-rail">
        <aside ref={rig} className={`ent-rig ${open ? 'is-open' : 'is-folded'}`} aria-label={`The door of ${office}: sign in, or ask to come in`} onPointerEnter={onEnter} onPointerLeave={onLeave} onFocus={onFocus} onBlur={onBlur}>
          <span className="ent-cable ent-cable-l" aria-hidden />
          <span className="ent-cable ent-cable-r" aria-hidden />
          <div ref={tilt} className="ent-rig-tilt">
            <Door office={office} onOwnToken={onOwnToken} folded={!open} onWaiting={setKnocking} />
            {/* What it does is decided by whether somebody opened the door on purpose — not by a pointer on its way to this button. */}
            <button type="button" className="ent-fold" aria-expanded={open} onClick={() => (pinned || typing ? fold() : unfold())} hidden={open && ((wide && edge) || !(pinned || typing))}>
              {open && (pinned || typing) ? 'Fold the door away' : 'Sign in or knock'}
            </button>
          </div>
        </aside>
      </div>

      <div ref={page} className="ent-page">
        {stage && (
          <Quiet onFail={() => setDrawable(false)}>
            <Suspense fallback={null}>
              <Stage geo={layout.geo} slots={layout.slots} scroller={scroller.current!} still={calm} onReady={() => setStaged(true)} />
            </Suspense>
          </Quiet>
        )}

        <main className="ent-main">
          <header className="ent-hero ent-row">
            <div className="ent-col">
              <div className="ent-brand">
                <img src={logo} alt="" width={40} height={40} />
                <span>ORCHESTRATOR</span>
              </div>
              <p className="ent-eyebrow">
                You are standing at the door of <b>{office}</b>
              </p>
              <h1>
                You hire. They code. <span className="ent-grad">You walk around and look important.</span>
              </h1>
              <p className="ent-lead">
                Behind this door is a 3D office in which real Claude Code sessions sit at desks and work as employees. Each of them is a real <code>claude</code> process, in a real tmux session, in a real git worktree.
              </p>
              <div className="ent-stickers" aria-hidden>
                <span className="ent-sticker ent-sticker-pink">ZERO NPCS</span>
                <span className="ent-sticker ent-sticker-gold">100% REAL TERMINALS</span>
              </div>
              <p className="ent-hint">
                <span className="ent-hint-arrow" aria-hidden>
                  ↓
                </span>{' '}
                {stage && !calm ? 'Scroll. The intern will keep up with you.' : 'Scroll for the tour. The door comes along.'}
              </p>
              <Place id="pod" w={6.4} h={3.3} r={3.3} ax={0.5} ay={0.62} className="ent-slot-pod" />
            </div>
            <div className="ent-lane">
              <div className="ent-lane-mark" />
              <Place id="lobby" w={3.9} h={3.2} r={2.4} ay={0.5} className="ent-slot-lobby" />
            </div>
          </header>

          <section className="ent-row" aria-labelledby="ent-h-real">
            <div className="ent-col">
              <p className="ent-kicker">01 — Zero NPCs</p>
              <h2 id="ent-h-real">Everyone at a desk is a real session.</h2>
              <p>
                Every person in the office is a persistent identity with a real <code>claude</code> process behind it. This is not a dashboard with mascots, and it is not a simulation: nothing in the office moves unless a hook, an MCP call, a tmux observation or something you did says it happened.
              </p>
              <p className="ent-aside">
                <span className="ent-chip ent-chip-unknown">UNKNOWN</span> If the office does not know what somebody is doing, that is what their tag says. Never “working”.
              </p>
              <Shot src={shotDesks} w={1800} h={1125} alt="The office floor: employees at their desks, each under a tag with their name and what their session is doing — thinking, blocked, needs a decision, available." caption="The engineering floor. The tags are the state of real sessions, not decoration." />
            </div>
            <div className="ent-lane">
              <Place id="desk" w={3.9} h={3} r={2.2} />
            </div>
          </section>

          <section className="ent-row" aria-labelledby="ent-h-walk">
            <div className="ent-col">
              <p className="ent-kicker">02 — Walk the floor</p>
              <h2 id="ent-h-walk">Sit down at somebody’s terminal.</h2>
              <p className="ent-keys">
                <span>
                  <Key>W</Key>
                  <Key>A</Key>
                  <Key>S</Key>
                  <Key>D</Key> walk
                </span>
                <span>
                  <Key>F</Key> talk
                </span>
                <span>
                  <Key wide>Space</Key> their terminal
                </span>
              </p>
              <p>
                Walk up to a desk and press <b>F</b>: your words are pasted into that employee’s real session, and the reply you get is the final message of their turn. Press <b>Space</b> and you are looking at their live terminal, read-only. Take control, and your keystrokes go to that same tmux session — the Claude process is never replaced.
              </p>
              <Shot src={shotTerminal} w={1800} h={1125} tilt="right" alt="Sitting at an employee’s terminal: the live screen of their session with its tool calls, a button to take the keyboard, and beside it their status, their task and what you can do." caption="A live terminal, streamed from tmux. Here it is the demo office’s scripted stand-in — which says so itself, in the first line." />
            </div>
            <div className="ent-lane" />
          </section>

          <section className="ent-row" aria-labelledby="ent-h-hand">
            <div className="ent-col">
              <p className="ent-kicker">03 — A hand goes up</p>
              <h2 id="ent-h-hand">A raised hand is a real question.</h2>
              <p>
                When somebody raises a hand, their agent asked the boss something, or Claude Code raised a permission request. The real request is held open until you decide. Your answer goes back as the tool result or the hook decision.
              </p>
              <p className="ent-flow" aria-label="An answer moves from queued, to sent, to confirmed">
                <span>queued</span>
                <i aria-hidden>→</i>
                <span>sent</span>
                <i aria-hidden>→</i>
                <span className="is-on">confirmed</span>
                <em>only when the runtime acts on it</em>
              </p>
              <Shot src={shotHand} w={1800} h={1125} alt="The office’s inbox, over the floor where two employees have a hand up: a permission request with a Review button, a question with an Answer button, and somebody who is blocked." caption="Held open until somebody answers: a permission request, a question, and one person who is stuck." />
            </div>
            <div className="ent-lane">
              <Place id="hand" w={3.9} h={3} r={2.3} />
            </div>
          </section>

          <section className="ent-row" aria-labelledby="ent-h-quests">
            <div className="ent-col">
              <p className="ent-kicker">04 — Quests</p>
              <h2 id="ent-h-quests">Done means the tests ran.</h2>
              <p>
                A task gets a worktree and a branch. It turns <b>DONE</b> when the office itself found a clean tree and real commits, ran your verification command on the machine, got the review where one is required, and merged without conflict. Not when somebody said so.
              </p>
              <Shot src={shotBoard} w={1800} h={1125} tilt="right" alt="The task board: columns from backlog and ready through in progress, review and blocked to done, with a card for each task and who has it." caption="The board. Cards move by themselves as work is done and checked." />
            </div>
            <div className="ent-lane">
              <Place id="trophies" w={3.9} h={2.8} r={2.1} />
            </div>
          </section>

          <section className="ent-row" aria-labelledby="ent-h-foreman">
            <div className="ent-col">
              <p className="ent-kicker">05 — The foreman</p>
              <h2 id="ent-h-foreman">One supervisor keeps the floor moving.</h2>
              <p>
                The foreman has no desk. It walks the office, looks at people’s real terminals, answers the operational questions and hands out work that is ready — so you are asked only about direction. It never approves anything: permission requests stay with you.
              </p>
              <p className="ent-aside">A quiet office starts no round and costs nothing.</p>
              <Shot src={shotForeman} w={1800} h={1125} alt="The foreman standing at an employee’s desk, beside a colleague with a hand up; its tag reads FOREMAN, whole office, and what it is doing: checking that employee." caption="The foreman on a round. Its tag says who it is with." />
            </div>
            <div className="ent-lane">
              <Place id="foreman" w={3.9} h={3} r={2.4} />
            </div>
          </section>

          <section className="ent-row" aria-labelledby="ent-h-command">
            <div className="ent-col">
              <p className="ent-kicker">06 — Command center</p>
              <h2 id="ent-h-command">Top-down, like a proper strategy game.</h2>
              <p>Who needs you, who is blocked, which machine is sweating: the whole office from above, with everybody’s state beside it.</p>
              <Shot src={shotCommand} w={1800} h={1125} tilt="right" alt="The office seen from above, beside a panel that lists who needs the owner, everybody’s state and the machines." caption="From above: who needs an answer, what everybody is doing, and the machines." />
            </div>
            <div className="ent-lane" />
          </section>

          <section className="ent-row" aria-labelledby="ent-h-together">
            <div className="ent-col">
              <p className="ent-kicker">07 — Multiplayer</p>
              <h2 id="ent-h-together">Bring people. Their computers come too.</h2>
              <p>
                Invite people with a link that works once. Owners, colleagues, visitors: the office enforces each role for every request. A colleague’s own computer becomes a room of its own while they are in, and what runs there stays theirs.
              </p>
              <Shot src={shotRoom} w={1800} h={1125} alt="A room in the office with a member’s name on it, and that member’s own employees at its desks." caption="A member’s room: their computer, their employees, for as long as they are in." />
            </div>
            <div className="ent-lane">
              <Place id="guests" w={3.9} h={2.8} r={2.2} />
            </div>
          </section>

          <section className="ent-row" aria-labelledby="ent-h-break">
            <div className="ent-col">
              <p className="ent-kicker">08 — The break room</p>
              <h2 id="ent-h-break">A hi-fi, a television, and a whip.</h2>
              <p>
                Internet radio for the whole office. A television with a real browser in it. And <b>R</b>, next to an employee: a crack, a flinch, a “jao!”. It sends nothing to anybody’s session. It stays in.
              </p>
              {stage && !calm && <p className="ent-aside">Try it on the intern. One click.</p>}
              <Shot src={shotLounge} w={1800} h={1125} tilt="right" alt="The break room: a hi-fi between two loudspeakers, a television on the wall, a sofa and a low table." caption="The break room. The radio is real; so is the browser in the television." />
            </div>
            <div className="ent-lane">
              <Place id="lounge" w={3.9} h={3.2} r={2.6} />
            </div>
          </section>

          <section className="ent-rules" aria-labelledby="ent-h-rules">
            <p className="ent-kicker">The house rules</p>
            <h2 id="ent-h-rules">Honesty the code enforces.</h2>
            <ul>
              <li className="ent-reveal">
                <b>The backend is the source of truth.</b>
                <span>The 3D layer is given what to show and nothing else. It cannot reach sessions or tasks.</span>
              </li>
              <li className="ent-reveal">
                <b>Unknown is shown as unknown.</b>
                <span>A session without hooks, or on a machine that is offline, is UNKNOWN.</span>
              </li>
              <li className="ent-reveal">
                <b>Delivered is not confirmed.</b>
                <span>Messages, tasks and answers move queued → sent → confirmed, and confirmed needs a signal from Claude Code.</span>
              </li>
              <li className="ent-reveal">
                <b>Measured, reported, unavailable.</b>
                <span>Verification is measured on the machine; an agent’s summary is only “reported”. Cost is never invented.</span>
              </li>
              <li className="ent-reveal">
                <b>High-risk commands stop at every level.</b>
                <span>However much autonomy an employee has, the office’s high-risk gate stands in front of it.</span>
              </li>
            </ul>
          </section>

          <section className="ent-end ent-row" aria-labelledby="ent-h-door">
            <div className="ent-col">
              <p className="ent-kicker">That was the tour</p>
              <h2 id="ent-h-door">
                This is the door of <span className="ent-grad">{office}</span>.
              </h2>
              <ul className="ent-ways">
                <li>
                  <b>Have a password?</b> Sign in. You come in as the member you are, with that member’s role.
                </li>
                <li>
                  <b>Just looking?</b> Knock. Somebody inside lets you in to look around: you can watch, not change anything.
                </li>
                <li>
                  <b>Work here every day?</b> The Orchestrator desktop app comes in with an invitation link and brings your own computer.
                </li>
              </ul>
              <footer className="ent-footer">
                <img src={logo} alt="" width={40} height={40} />
                <p>
                  <b>ORCHESTRATOR</b> — the baton conducts, the prompt plays. No employees were harmed by the whip. It sends nothing.
                </p>
                <p className="ent-small">
                  Every picture on this page is the real app, taken in a demo office whose employees are scripted stand-ins, so no Claude usage was spent on looking good. The little people standing on the page are the office’s own figures, drawn in your browser; they are an illustration, not anybody’s session.
                </p>
                <p className="ent-small">
                  <button type="button" className="ent-link" aria-pressed={calm} onClick={() => setCalm(!calm)}>
                    {calm ? 'Let things move again' : 'Hold everything still'}
                  </button>
                  {systemCalm && calm ? ' — your system asks for less motion, so the page started still.' : ''}
                </p>
              </footer>
            </div>
            <div className="ent-lane">
              <Place id="door" w={3.9} h={3.2} r={2.4} ay={0.5} className="ent-slot-door" />
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
