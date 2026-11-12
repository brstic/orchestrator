import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MutableRefObject } from 'react';
import type { ArcadeTable } from '@orchestrator/contracts';
import { Button, Empty, Window, timeAgo } from '@orchestrator/ui';
import { Caster, Viewer, canCast } from '../../arcade/cast.ts';
import { ArcadeConsole } from '../../arcade/console.ts';
import { KEY_LEGEND, PAD_LEGEND, buttonOfKey, buttonsOfPad, changes, layoutOf, seatName, settleSeats, type Seat, type Seats } from '../../arcade/input.ts';
import { bring, bringOldGames, forgetState, keep, keptOf, locals, remove, romOf, shelfOf, type Game } from '../../arcade/library.ts';
import { onTableNews } from '../../arcade/net.ts';
import { FRAME_PAGE, type PadButton, type Player, type SoundState } from '../../arcade/protocol.ts';
import { ROM_ACCEPT } from '../../arcade/roms.ts';
import { connection } from '../../lib/api.ts';
import { takeKeys } from '../../lib/keys-taken.ts';
import { useOffice } from '../../lib/store.ts';
import { registerPanel } from './index.tsx';
import './arcade.css';

/**
 * The arcade cabinet's window (docs/ARCADE.md): the office's shelf of games, a Mega Drive to play them on, and the
 * tables — a game somebody is playing that others in the office sat down at. Whoever starts a game runs the console
 * (in a frame of its own); somebody who joins from another computer is sent its picture and sound and holds the
 * second pad. This window owns the keys, the gamepads and what is kept.
 */

// ───────────── what this computer remembers ─────────────

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A browser that keeps nothing: the choice holds for as long as the window is open.
  }
}

interface PadSeen {
  index: number;
  name: string;
}

/** The gamepads this page can see. A browser shows one only after a button on it has been pressed. */
function usePads(): PadSeen[] {
  const [pads, setPads] = useState<PadSeen[]>([]);
  useEffect(() => {
    const look = () => {
      const seen: PadSeen[] = [];
      for (const p of navigator.getGamepads?.() ?? []) if (p?.connected) seen.push({ index: p.index, name: p.id });
      setPads((had) => (had.length === seen.length && had.every((h, i) => h.index === seen[i]!.index && h.name === seen[i]!.name) ? had : seen));
    };
    look();
    const every = window.setInterval(look, 1000);
    window.addEventListener('gamepadconnected', look);
    window.addEventListener('gamepaddisconnected', look);
    return () => {
      window.clearInterval(every);
      window.removeEventListener('gamepadconnected', look);
      window.removeEventListener('gamepaddisconnected', look);
    };
  }, []);
  return pads;
}

function useObjectUrl(blob: Blob | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return setUrl(null);
    const made = URL.createObjectURL(blob);
    setUrl(made);
    return () => URL.revokeObjectURL(made);
  }, [blob]);
  return url;
}

const sizeOf = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const typing = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
/** A button that was clicked keeps no hold on Enter: Enter is Start. */
const letGoOfTheButton = () => (document.activeElement as HTMLElement | null)?.blur?.();

/**
 * The keys and gamepads of whoever plays at this computer, as buttons of a pad. While `active`, a key that is a
 * player's button is the game's: the office does not hear it. Gamepads are read every frame, and only what changed
 * is passed on.
 */
function usePadInput(active: boolean, seats: MutableRefObject<Seats>, press: (player: Player, button: PadButton, down: boolean) => void, frame?: MutableRefObject<HTMLIFrameElement | null>): void {
  const pressNow = useRef(press);
  pressNow.current = press;
  useEffect(() => {
    if (!active) return;
    const keys = new Map<string, { player: Player; button: PadButton }>();
    const count = new Map<string, number>();
    const hold = (hit: { player: Player; button: PadButton }, down: boolean) => {
      const k = `${hit.player}:${hit.button}`;
      const n = (count.get(k) ?? 0) + (down ? 1 : -1);
      count.set(k, Math.max(0, n));
      // Two keys may mean one button (W and the up arrow): it is held while either is.
      if (down ? n === 1 : n === 0) pressNow.current(hit.player, hit.button, down);
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const hit = buttonOfKey(seats.current, e.code);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat || keys.has(e.code)) return;
      keys.set(e.code, hit);
      hold(hit, true);
    };
    const up = (e: KeyboardEvent) => {
      const hit = keys.get(e.code);
      if (!hit) return;
      keys.delete(e.code);
      e.preventDefault();
      e.stopImmediatePropagation();
      hold(hit, false);
    };
    const letGo = () => {
      for (const hit of keys.values()) hold(hit, false);
      keys.clear();
      // The console never holds the keyboard: a click that landed in it gives the keys back to this window.
      if (frame?.current && document.activeElement === frame.current) window.focus();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', letGo);
    // (For the office's shortcuts that listen before this one does: push-to-talk bound to a key a player holds.)
    const giveBack = takeKeys((code) => !!buttonOfKey(seats.current, code));

    const before: Record<Player, Set<PadButton>> = { 1: new Set(), 2: new Set() };
    let frameId = 0;
    const read = () => {
      frameId = requestAnimationFrame(read);
      const all = navigator.getGamepads?.() ?? [];
      for (const player of [1, 2] as const) {
        const seat = player === 1 ? seats.current.p1 : seats.current.p2;
        const pad = typeof seat === 'number' ? all[seat] : null;
        const now = pad ? buttonsOfPad(pad) : new Set<PadButton>();
        for (const ch of changes(before[player], now)) pressNow.current(player, ch.button, ch.down);
        before[player] = now;
      }
    };
    read();
    return () => {
      giveBack();
      letGo();
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', letGo);
      cancelAnimationFrame(frameId);
      for (const player of [1, 2] as const) for (const b of before[player]) pressNow.current(player, b, false);
    };
  }, [active, seats, frame]);
}

// ───────────── who plays with what ─────────────

/**
 * `second`: who holds the second pad from another computer (then it is not chosen here). `alone`: only one player
 * is at this computer at all (somebody who sat down at another's table).
 */
function Players({ seats, pads, onChange, second, alone }: { seats: Seats; pads: PadSeen[]; onChange: (wanted: Seats, by: Player) => void; second?: string | null; alone?: boolean }) {
  const names = Object.fromEntries(pads.map((p) => [p.index, p.name]));
  const read = (v: string): Seat => (v === 'keys' || v === 'none' ? v : Number(v));
  const legend = (player: Player) => {
    const seat = player === 1 ? seats.p1 : seats.p2;
    if (seat === 'none') return 'Choose the keyboard or a gamepad here for a second player at this computer — or let somebody in the office join from theirs.';
    const layout = layoutOf(alone ? { p1: seats.p1, p2: 'none' } : seats, player);
    return layout ? KEY_LEGEND[layout] : PAD_LEGEND;
  };
  return (
    <div className="arc-players" data-arcade-players>
      {([1, 2] as const)
        .filter((player) => player === 1 || !alone)
        .map((player) =>
          player === 2 && second ? (
            <div key={player} className="arc-player" data-arcade-second={second}>
              <span className="arc-player-who">Player 2</span>
              <span className="arc-player-far">{second}, from their computer</span>
              <span className="small muted">They hold the second pad for as long as they sit at this game.</span>
            </div>
          ) : (
            <label key={player} className="arc-player">
              <span className="arc-player-who">{alone ? 'You play with' : `Player ${player}`}</span>
              <select
                value={String(player === 1 ? seats.p1 : seats.p2)}
                data-arcade-seat={player}
                onChange={(e) => {
                  const seat = read(e.target.value);
                  // The keys are the game's again as soon as the choice is made.
                  e.currentTarget.blur();
                  onChange(player === 1 ? { ...seats, p1: seat as Seats['p1'] } : { ...seats, p2: seat }, player);
                }}
              >
                {player === 2 && <option value="none">Nobody</option>}
                <option value="keys">Keyboard</option>
                {pads.map((p) => (
                  <option key={p.index} value={p.index}>
                    {seatName(p.index, names)}
                  </option>
                ))}
              </select>
              <span className="small muted" data-arcade-legend={player}>
                {legend(player)}
              </span>
            </label>
          ),
        )}
      {pads.length === 0 && <span className="small faint arc-players-note">A gamepad appears here once a button on it has been pressed.</span>}
    </div>
  );
}

// ───────────── the shelf ─────────────

function Cartridge({ game, mayChange, onPlay, onRemoved }: { game: Game; mayChange: boolean; onPlay: (game: Game, resume: boolean) => void; onRemoved: () => void }) {
  const shot = useObjectUrl(game.shot);
  const [sure, setSure] = useState(false);
  const toast = useOffice((s) => s.toast);
  return (
    <div className="arc-game" data-arcade-game={game.title}>
      <button type="button" className="arc-game-shot" onClick={() => onPlay(game, !!game.stateAt)} title={game.stateAt ? 'Continue where you stopped' : 'Play'}>
        {shot ? <img src={shot} alt="" /> : <span aria-hidden>MEGA DRIVE</span>}
      </button>
      <div className="arc-game-name truncate" title={`${game.file} — brought by ${game.addedBy}`}>
        {game.title}
      </div>
      <div className="small muted truncate">
        {sizeOf(game.size)}
        {game.playedAt ? ` · played ${timeAgo(game.playedAt)}` : ` · brought by ${game.addedBy}`}
      </div>
      <div className="row arc-game-acts">
        {game.stateAt ? (
          <>
            <Button variant="primary" small onClick={() => onPlay(game, true)} data-arcade-continue>
              Continue
            </Button>
            <Button variant="ghost" small onClick={() => onPlay(game, false)} title="From the title screen. What the cartridge itself saves stays." data-arcade-play>
              Start over
            </Button>
          </>
        ) : (
          <Button variant="primary" small onClick={() => onPlay(game, false)} data-arcade-play>
            Play
          </Button>
        )}
        <span className="grow" />
        {mayChange &&
          (sure ? (
            <Button
              variant="danger"
              small
              onBlur={() => setSure(false)}
              onClick={() =>
                void remove(game.id)
                  .then(onRemoved)
                  .catch((e: Error) => toast(e.message, 'error'))
              }
              title="The game is taken off the office's shelf, for everyone; what this computer kept of it is deleted"
              data-arcade-remove-sure
            >
              Remove for everyone
            </Button>
          ) : (
            <Button variant="ghost" small onClick={() => setSure(true)} data-arcade-remove>
              Remove
            </Button>
          ))}
      </div>
    </div>
  );
}

/** The games being played that somebody may sit down at. */
function Tables({ tables, onJoin }: { tables: ArcadeTable[]; onJoin: (table: ArcadeTable, as: 'player' | 'watch') => void }) {
  const can = canCast();
  if (!tables.length) return null;
  return (
    <div className="arc-tables" data-arcade-tables>
      <div className="arc-section">Being played now</div>
      {tables.map((t) => (
        <div key={t.id} className="arc-table" data-arcade-table={t.host.name}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="strong truncate">
              {t.host.name} is playing {t.title}
            </div>
            <div className="small muted truncate">
              {t.player2 ? `${t.player2.name} holds the second pad` : 'The second pad is free'}
              {t.watching.length ? ` · ${t.watching.length} looking on` : ''}
            </div>
          </div>
          {!can ? (
            <span className="small faint">This browser cannot show a game played elsewhere.</span>
          ) : (
            <>
              {!t.player2 && (
                <Button variant="primary" small onClick={() => onJoin(t, 'player')} title="You play from this computer, with the second pad" data-arcade-join>
                  Join as player 2
                </Button>
              )}
              <Button small onClick={() => onJoin(t, 'watch')} data-arcade-watch>
                Watch
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function Shelf({ list, tables, mayChange, onPlay, onJoin, onChanged, note }: { list: Game[]; tables: ArcadeTable[]; mayChange: boolean; onPlay: (game: Game, resume: boolean) => void; onJoin: (table: ArcadeTable, as: 'player' | 'watch') => void; onChanged: () => void; note: (text: string, kind?: 'success' | 'error') => void }) {
  const pick = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const add = async (files: File[]) => {
    if (!files.length || busy || !mayChange) return;
    setBusy(true);
    let added = 0;
    for (const f of files) {
      const r = await bring(f).catch((e: Error) => ({ ok: false as const, why: e.message }));
      if (!r.ok) note(`${f.name}: ${r.why}`, 'error');
      else if (r.already) note(`${r.game.title} is on the shelf already`);
      else added++;
    }
    if (added) note(added === 1 ? "Game added to the office's shelf" : `${added} games added to the office's shelf`, 'success');
    setBusy(false);
    onChanged();
  };
  const drop = (ev: DragEvent) => {
    ev.preventDefault();
    setOver(false);
    void add([...ev.dataTransfer.files]);
  };
  return (
    <div
      className={`arc-shelf ${over ? 'over' : ''}`}
      onDragOver={(ev) => {
        if (!mayChange || ![...ev.dataTransfer.types].includes('Files')) return;
        ev.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      data-arcade-shelf
    >
      <Tables tables={tables} onJoin={onJoin} />
      {mayChange ? (
        <div className="row arc-shelf-head">
          <Button variant="primary" onClick={() => pick.current?.click()} disabled={busy}>
            {busy ? 'Adding…' : 'Add games…'}
          </Button>
          <span className="small muted">Mega Drive cartridge files of your own (.md, .gen, .bin, .smd, or a .zip of one) — or drop them here. They are kept with the office: everyone in it can play them, on any computer.</span>
          <input
            ref={pick}
            type="file"
            multiple
            accept={ROM_ACCEPT}
            hidden
            data-arcade-add
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              e.target.value = '';
              void add(files);
            }}
          />
        </div>
      ) : (
        <div className="small muted">The games on the office's shelf. Those who work here bring them; you can play any of them.</div>
      )}
      {list.length === 0 ? (
        <Empty title="No games yet">{mayChange ? 'Add a Mega Drive cartridge file to play it here — alone, or with somebody else in the office.' : 'Nobody has brought a game yet.'}</Empty>
      ) : (
        <div className="arc-games">
          {list.map((g) => (
            <Cartridge key={g.id} game={g} mayChange={mayChange} onPlay={onPlay} onRemoved={onChanged} />
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────── a game being played here ─────────────

function Play({
  game,
  resume,
  seats,
  sound,
  onSound,
  onLeft,
  leaver,
  note,
  onSecond,
}: {
  game: Game;
  resume: boolean;
  seats: Seats;
  sound: boolean;
  onSound: (on: boolean) => void;
  onLeft: () => void;
  leaver: MutableRefObject<(() => Promise<void>) | null>;
  note: (text: string, kind?: 'success' | 'error') => void;
  /** Who holds the second pad from another computer, as it changes. */
  onSecond: (name: string | null) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const machine = useRef<ArcadeConsole | null>(null);
  const caster = useRef<Caster | null>(null);
  const [phase, setPhase] = useState<'starting' | 'running' | 'failed'>('starting');
  const [why, setWhy] = useState('');
  const [paused, setPaused] = useState(false);
  const [heard, setHeard] = useState<SoundState | null>(null);
  const [keptAt, setKeptAt] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const me = useOffice((s) => s.clientId);
  const table = useOffice((s) => s.arcade.tables.find((t) => t.id === s.clientId)) ?? null;
  const second = open ? (table?.player2?.name ?? null) : null;
  // Somebody at another computer holds the second pad: nobody here does.
  const seatsNow = useRef(seats);
  seatsNow.current = second ? { ...seats, p2: 'none' } : seats;
  const soundNow = useRef(sound);
  soundNow.current = sound;
  const phaseNow = useRef(phase);
  phaseNow.current = phase;
  useEffect(() => onSecond(second), [second, onSecond]);

  useEffect(() => {
    const c = new ArcadeConsole(frame.current!, {
      running: () => {
        // The keys are this window's, whatever the console did while it started.
        if (document.activeElement === frame.current) {
          frame.current?.blur();
          window.focus();
        }
        setPhase('running');
      },
      failed: (message) => {
        setWhy(message);
        setPhase('failed');
      },
      sound: setHeard,
      frame: (bitmap, ts) => (caster.current ? caster.current.frame(bitmap, ts) : bitmap.close()),
      pcm: (rate, left, right) => caster.current?.pcm(rate, left, right),
    });
    machine.current = c;
    let off = false;
    void (async () => {
      const [bytes, kept] = await Promise.all([romOf(game.id), keptOf(game.id)]);
      if (!off) await c.start({ name: game.file, bytes }, { sram: kept.sram, state: resume ? kept.state : undefined }, soundNow.current);
    })().catch((e: Error) => {
      if (off) return;
      setWhy(e.message);
      setPhase('failed');
    });
    return () => {
      off = true;
      c.dispose();
      machine.current = null;
    };
  }, [game.id, game.file, resume]);

  // ── the table: this game, open to the office ──
  const close = useCallback(() => {
    if (!caster.current) return;
    caster.current.close();
    caster.current = null;
    machine.current?.cast(false);
    connection.send({ t: 'arcade.close' });
    setOpen(false);
  }, []);
  const invite = useCallback(() => {
    if (caster.current || phaseNow.current !== 'running') return;
    caster.current = new Caster((m) => connection.send(m));
    connection.send({ t: 'arcade.open', title: game.title, gameId: game.id });
    machine.current?.cast(true);
    setOpen(true);
  }, [game.id, game.title]);
  useEffect(() => close, [close]);
  // This window came back to the office under a new name (the connection dropped): the table is opened again.
  useEffect(() => {
    if (open && me) connection.send({ t: 'arcade.open', title: game.title, gameId: game.id });
  }, [me]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    return onTableNews((m) => {
      if (m.t === 'arcade.pad') machine.current?.pad(2, m.button, m.down);
      else if (m.t === 'arcade.key') caster.current?.keyframe();
    });
  }, [open]);

  /** What the console holds, put away on this computer. */
  const keepNow = useCallback(
    async (withState: boolean): Promise<boolean> => {
      const c = machine.current;
      if (!c || phaseNow.current !== 'running') return false;
      const now = await c.keep(withState);
      if (!now.sram && !now.state) return false;
      await keep(game.id, now);
      if (now.state) setKeptAt(new Date().toISOString());
      return !!now.state;
    },
    [game.id],
  );

  const leaving = useRef<Promise<void> | null>(null);
  const leave = useCallback((): Promise<void> => {
    leaving.current ??= (async () => {
      await keepNow(true).catch(() => false);
      close();
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      onLeft();
    })();
    return leaving.current;
  }, [keepNow, onLeft, close]);
  useEffect(() => {
    leaver.current = leave;
    return () => {
      leaver.current = null;
    };
  }, [leave, leaver]);

  // Where the player is, put away every half minute: a window closed any other way loses little.
  useEffect(() => {
    if (phase !== 'running' || paused) return;
    const every = window.setInterval(() => void keepNow(true).catch(() => false), 30_000);
    return () => window.clearInterval(every);
  }, [phase, paused, keepNow]);

  // Escape leaves the game for the shelf (the window itself closes on the next one).
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.fullscreenElement) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void leave();
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [leave]);

  usePadInput(phase === 'running', seatsNow, (player, button, down) => machine.current?.pad(player, button, down), frame);

  useEffect(() => {
    if (phase === 'running') machine.current?.sound(sound);
  }, [sound, phase]);

  const running = phase === 'running';
  const act = (what: () => void) => () => {
    what();
    letGoOfTheButton();
  };
  return (
    <div className="arc-play" data-arcade-play-view data-arcade-phase={phase} data-arcade-paused={paused || undefined} data-arcade-sound-state={heard ?? undefined} data-arcade-open={open || undefined}>
      <div className="row arc-bar">
        <Button onClick={() => void leave()} title="Back to the games (Esc). Where you are is kept." data-arcade-back>
          ← Games
        </Button>
        <span className="arc-bar-title truncate">{game.title}</span>
        <span className="grow" />
        {keptAt && <span className="small faint">Kept {timeAgo(keptAt)}</span>}
        <Button
          small
          variant={open ? 'success' : 'default'}
          disabled={!running || !canCast()}
          onClick={act(() => (open ? close() : invite()))}
          aria-pressed={open}
          title={!canCast() ? 'This browser cannot show a game to others' : open ? 'Close the game to the office again' : 'Let somebody in the office join from their own computer, with the second pad — or look on'}
          data-arcade-invite
        >
          {open ? 'Open to the office ✓' : 'Play together'}
        </Button>
        <Button
          small
          disabled={!running}
          onClick={act(() => {
            if (paused) machine.current?.resume();
            else machine.current?.pause();
            setPaused(!paused);
          })}
          data-arcade-pause
        >
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button small disabled={!running} onClick={act(() => machine.current?.reset())} title="The console's reset button">
          Reset
        </Button>
        <Button small disabled={!running} onClick={act(() => void keepNow(true).then((ok) => note(ok ? 'Kept: Continue starts from here' : 'Nothing could be kept just now', ok ? 'success' : 'error')))} title="Keep this exact moment" data-arcade-save>
          Save
        </Button>
        <Button
          small
          disabled={!running}
          onClick={act(
            () =>
              void keptOf(game.id).then((k) => {
                if (k.state) machine.current?.restore(k.state);
                else note('Nothing was kept of this game yet');
              }),
          )}
          title="Go back to the moment that was last kept"
          data-arcade-load
        >
          Load
        </Button>
        <Button small onClick={act(() => onSound(!sound))} aria-pressed={sound} title="Sound at this computer. Somebody who joined hears the game either way." data-arcade-sound>
          {sound ? 'Sound on' : 'Sound off'}
        </Button>
        <Button small disabled={!running} onClick={act(() => void wrap.current?.requestFullscreen().catch(() => undefined))} title="Esc leaves full screen">
          Full screen
        </Button>
      </div>
      {open && (
        <div className="arc-open small" data-arcade-open-line>
          {table?.player2 ? (
            <>
              <strong>{table.player2.name}</strong> plays with you, from their computer.
            </>
          ) : (
            'Open to the office: whoever walks up to the arcade can join with the second pad.'
          )}
          {table && table.watching.length > 0 && ` ${table.watching.map((w) => w.name).join(', ')} ${table.watching.length === 1 ? 'is' : 'are'} looking on.`}
        </div>
      )}
      {/* `data-esc-first`: while a game is on, Escape is this view's (back to the shelf), not the window's. */}
      <div className="arc-screen" ref={wrap} data-esc-first data-arcade-screen>
        {/* The console can run its script and nothing more: it is no origin, so nothing of the office is in its reach. */}
        <iframe ref={frame} src={FRAME_PAGE} title="Arcade console" sandbox={import.meta.env.DEV ? 'allow-scripts allow-same-origin' : 'allow-scripts'} allow="autoplay; screen-wake-lock" tabIndex={-1} />
        {phase === 'starting' && <div className="arc-over">Switching on…</div>}
        {phase === 'failed' && (
          <div className="arc-over arc-over-bad" data-arcade-failed>
            <strong>This game did not start.</strong>
            <span>{why}</span>
          </div>
        )}
        {running && paused && <div className="arc-over">Paused</div>}
      </div>
      {running && sound && heard === 'waiting' && (
        <button type="button" className="arc-sound-wait" onClick={act(() => machine.current?.sound(true))}>
          The browser waits for a click before it plays sound — click here to hear the game.
        </button>
      )}
    </div>
  );
}

// ───────────── a game played at somebody else's computer ─────────────

function Remote({ tableId, wanted, seats, sound, onSound, onLeft, leaver, note }: { tableId: string; wanted: 'player' | 'watch'; seats: Seats; sound: boolean; onSound: (on: boolean) => void; onLeft: () => void; leaver: MutableRefObject<(() => Promise<void>) | null>; note: (text: string, kind?: 'success' | 'error') => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const [seen, setSeen] = useState(false);
  const [shown, setShown] = useState({ v: 0, a: 0 });
  const me = useOffice((s) => s.clientId);
  const table = useOffice((s) => s.arcade.tables.find((t) => t.id === tableId)) ?? null;
  const playing = table?.player2?.id === me;
  const playingNow = useRef(playing);
  playingNow.current = playing;
  // One player at this computer, whatever was chosen for a second one.
  const mine = useRef<Seats>({ p1: seats.p1, p2: 'none' });
  mine.current = { p1: seats.p1, p2: 'none' };
  const sat = useRef(false);

  useEffect(() => {
    const v = new Viewer(canvas.current!, () => connection.send({ t: 'arcade.key' }), sound);
    v.onFirst = () => setSeen(true);
    viewer.current = v;
    const off = onTableNews((m) => {
      if (m.t === 'arcade.media' && m.table === tableId) v.hear(m.kind, m.key === true, m.ts, m.data);
      else if (m.t === 'arcade.closed' && m.table === tableId) {
        note('That game is over');
        onLeft();
      }
    });
    connection.send({ t: 'arcade.join', table: tableId, as: wanted });
    const count = window.setInterval(() => setShown({ ...v.shown }), 500);
    return () => {
      window.clearInterval(count);
      off();
      v.close();
      viewer.current = null;
      connection.send({ t: 'arcade.leave' });
    };
  }, [tableId, wanted]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => viewer.current?.sound(sound), [sound]);
  // The table is gone from the office (its host left without a word reaching here): so is this view.
  useEffect(() => {
    if (table) sat.current = true;
    else if (sat.current) onLeft();
  }, [table, onLeft]);

  const leave = useCallback(async () => {
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    onLeft();
  }, [onLeft]);
  useEffect(() => {
    leaver.current = leave;
    return () => {
      leaver.current = null;
    };
  }, [leave, leaver]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.fullscreenElement) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      void leave();
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [leave]);

  // This computer's keys and gamepad are the second pad at the host's console.
  usePadInput(playing, mine, (_player, button, down) => playingNow.current && connection.send({ t: 'arcade.pad', button, down }));

  return (
    <div className="arc-play" data-arcade-remote data-arcade-remote-as={playing ? 'player' : 'watch'} data-shown-v={shown.v} data-shown-a={shown.a}>
      <div className="row arc-bar">
        <Button onClick={() => void leave()} title="Get up from this game (Esc)" data-arcade-back>
          ← Games
        </Button>
        <span className="arc-bar-title truncate">{table ? `${table.title} — at ${table.host.name}'s console` : 'A game'}</span>
        <span className="grow" />
        <span className="small faint">{playing ? 'You hold the second pad' : wanted === 'player' && table?.player2 ? `${table.player2.name} holds the second pad: you are looking on` : 'You are looking on'}</span>
        <Button
          small
          onClick={() => {
            onSound(!sound);
            letGoOfTheButton();
          }}
          aria-pressed={sound}
          data-arcade-sound
        >
          {sound ? 'Sound on' : 'Sound off'}
        </Button>
        <Button
          small
          onClick={() => {
            void wrap.current?.requestFullscreen().catch(() => undefined);
            letGoOfTheButton();
          }}
          title="Esc leaves full screen"
        >
          Full screen
        </Button>
      </div>
      <div className="arc-screen" ref={wrap} data-esc-first data-arcade-screen>
        <canvas ref={canvas} className="arc-far" data-arcade-far />
        {!seen && <div className="arc-over">Waiting for the picture…</div>}
      </div>
    </div>
  );
}

// ───────────── the window ─────────────

type Seated = { at: 'game'; game: Game; resume: boolean } | { at: 'table'; table: string; as: 'player' | 'watch' };

function ArcadePanel({ onClose }: { arg: string | null; onClose: () => void }) {
  const toast = useOffice((s) => s.toast);
  const note = useCallback((text: string, kind?: 'success' | 'error') => toast(text, kind), [toast]);
  const onShelf = useOffice((s) => s.arcade.games);
  const me = useOffice((s) => s.clientId);
  const role = useOffice((s) => s.me?.role);
  const tables = useOffice((s) => s.arcade.tables);
  const others = useMemo(() => tables.filter((t) => t.id !== me), [tables, me]);
  const mayChange = role !== 'visitor';
  const [local, setLocal] = useState<Awaited<ReturnType<typeof locals>> | null>(null);
  const [seated, setSeated] = useState<Seated | null>(null);
  const [second, setSecond] = useState<string | null>(null);
  const [sound, setSound] = useState(() => stored('arcade.sound', true));
  const [wanted, setWanted] = useState<Partial<Seats> | null>(() => stored<Partial<Seats> | null>('arcade.seats', null));
  const pads = usePads();
  const seats = useMemo(() => settleSeats(wanted, pads.map((p) => p.index)), [wanted, pads]);
  const leaver = useRef<(() => Promise<void>) | null>(null);

  const reload = useCallback(() => void locals().then(setLocal), []);
  useEffect(reload, [reload]);
  // Games this computer kept from before the shelf was the office's go onto the shelf, once.
  const moved = useRef(false);
  useEffect(() => {
    if (moved.current || !mayChange || !me) return;
    moved.current = true;
    void bringOldGames(useOffice.getState().arcade.games)
      .then((n) => {
        if (!n) return;
        note(n === 1 ? "Your game is on the office's shelf now: everyone can play it" : `Your ${n} games are on the office's shelf now: everyone can play them`, 'success');
        reload();
      })
      .catch(() => undefined);
  }, [mayChange, me, note, reload]);
  const list = useMemo(() => shelfOf(onShelf, local ?? {}), [onShelf, local]);

  const play = async (game: Game, resume: boolean) => {
    if (!resume && game.stateAt) await forgetState(game.id).catch(() => undefined);
    setSeated({ at: 'game', game, resume });
  };
  const left = useCallback(() => {
    setSeated(null);
    setSecond(null);
    reload();
  }, [reload]);
  // Closing the window while a game is on keeps where the player is first.
  const close = useCallback(() => {
    if (leaver.current) void leaver.current().then(onClose);
    else onClose();
  }, [onClose]);
  const saySound = (on: boolean) => {
    setSound(on);
    store('arcade.sound', on);
  };

  return (
    <Window title="Arcade" subtitle="A Mega Drive for the games the office brought — alone, two at one computer, or with somebody in the office from theirs" onClose={close} width={seated ? 1040 : 900}>
      <div className="arc" data-arcade>
        {seated?.at === 'game' ? (
          <Play key={`${seated.game.id}:${seated.resume}`} game={seated.game} resume={seated.resume} seats={seats} sound={sound} onSound={saySound} onLeft={left} leaver={leaver} note={note} onSecond={setSecond} />
        ) : seated?.at === 'table' ? (
          <Remote key={`${seated.table}:${seated.as}`} tableId={seated.table} wanted={seated.as} seats={seats} sound={sound} onSound={saySound} onLeft={left} leaver={leaver} note={note} />
        ) : local === null ? (
          <div className="small muted">Looking at the shelf…</div>
        ) : (
          <Shelf list={list} tables={others} mayChange={mayChange} onPlay={(g, resume) => void play(g, resume)} onJoin={(t, as) => setSeated({ at: 'table', table: t.id, as })} onChanged={reload} note={note} />
        )}
        <Players
          seats={seats}
          pads={pads}
          second={seated?.at === 'game' ? second : null}
          alone={seated?.at === 'table'}
          onChange={(next, by) => {
            const settled = settleSeats(next, pads.map((p) => p.index), by);
            setWanted(settled);
            store('arcade.seats', settled);
          }}
        />
      </div>
    </Window>
  );
}

registerPanel('arcade', ArcadePanel);
