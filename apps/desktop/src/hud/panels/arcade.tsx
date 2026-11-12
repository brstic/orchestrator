import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MutableRefObject } from 'react';
import { Button, Empty, Window, timeAgo } from '@orchestrator/ui';
import { ArcadeConsole } from '../../arcade/console.ts';
import { KEY_LEGEND, PAD_LEGEND, buttonOfKey, buttonsOfPad, changes, layoutOf, seatName, settleSeats, type Seat, type Seats } from '../../arcade/input.ts';
import { addFile, forgetState, games, keep, keptOf, remove, romOf, type Game } from '../../arcade/library.ts';
import { FRAME_PAGE, type PadButton, type Player, type SoundState } from '../../arcade/protocol.ts';
import { ROM_ACCEPT } from '../../arcade/roms.ts';
import { takeKeys } from '../../lib/keys-taken.ts';
import { useOffice } from '../../lib/store.ts';
import { registerPanel } from './index.tsx';
import './arcade.css';

/**
 * The arcade cabinet's window (docs/ARCADE.md): the games somebody brought, kept on this computer, and a Mega Drive
 * to play them on with one or two players. The emulator is in a frame of its own; this window owns the keys, the
 * gamepads and what is kept.
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

// ───────────── who plays with what ─────────────

function Players({ seats, pads, onChange }: { seats: Seats; pads: PadSeen[]; onChange: (wanted: Seats, by: Player) => void }) {
  const names = Object.fromEntries(pads.map((p) => [p.index, p.name]));
  const value = (s: Seat) => String(s);
  const read = (v: string): Seat => (v === 'keys' || v === 'none' ? v : Number(v));
  const legend = (player: Player) => {
    const seat = player === 1 ? seats.p1 : seats.p2;
    if (seat === 'none') return 'Choose the keyboard or a gamepad here for a second player.';
    const layout = layoutOf(seats, player);
    return layout ? KEY_LEGEND[layout] : PAD_LEGEND;
  };
  return (
    <div className="arc-players" data-arcade-players>
      {([1, 2] as const).map((player) => (
        <label key={player} className="arc-player">
          <span className="arc-player-who">Player {player}</span>
          <select
            value={value(player === 1 ? seats.p1 : seats.p2)}
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
      ))}
      {pads.length === 0 && <span className="small faint arc-players-note">A gamepad appears here once a button on it has been pressed.</span>}
    </div>
  );
}

// ───────────── the shelf ─────────────

function Cartridge({ game, onPlay, onRemoved }: { game: Game; onPlay: (game: Game, resume: boolean) => void; onRemoved: () => void }) {
  const shot = useObjectUrl(game.shot);
  const [sure, setSure] = useState(false);
  return (
    <div className="arc-game" data-arcade-game={game.title}>
      <button type="button" className="arc-game-shot" onClick={() => onPlay(game, !!game.stateAt)} title={game.stateAt ? 'Continue where you stopped' : 'Play'}>
        {shot ? <img src={shot} alt="" /> : <span aria-hidden>MEGA DRIVE</span>}
      </button>
      <div className="arc-game-name truncate" title={game.file}>
        {game.title}
      </div>
      <div className="small muted truncate">
        {sizeOf(game.size)}
        {game.playedAt ? ` · played ${timeAgo(game.playedAt)}` : ' · not played yet'}
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
        {sure ? (
          <Button
            variant="danger"
            small
            onBlur={() => setSure(false)}
            onClick={() => void remove(game.id).then(onRemoved)}
            title="The game, its saves and where you stopped are deleted from this computer"
            data-arcade-remove-sure
          >
            Remove for good
          </Button>
        ) : (
          <Button variant="ghost" small onClick={() => setSure(true)} data-arcade-remove>
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

function Shelf({ list, onPlay, onChanged, note }: { list: Game[]; onPlay: (game: Game, resume: boolean) => void; onChanged: () => void; note: (text: string, kind?: 'success' | 'error') => void }) {
  const pick = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const bring = async (files: File[]) => {
    if (!files.length || busy) return;
    setBusy(true);
    let added = 0;
    for (const f of files) {
      const r = await addFile(f).catch((e: Error) => ({ ok: false as const, why: e.message }));
      if (!r.ok) note(`${f.name}: ${r.why}`, 'error');
      else if (r.already) note(`${r.game.title} is already here`);
      else added++;
    }
    if (added) note(added === 1 ? 'Game added' : `${added} games added`, 'success');
    setBusy(false);
    onChanged();
  };
  const drop = (ev: DragEvent) => {
    ev.preventDefault();
    setOver(false);
    void bring([...ev.dataTransfer.files]);
  };
  return (
    <div
      className={`arc-shelf ${over ? 'over' : ''}`}
      onDragOver={(ev) => {
        if (![...ev.dataTransfer.types].includes('Files')) return;
        ev.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={drop}
      data-arcade-shelf
    >
      <div className="row arc-shelf-head">
        <Button variant="primary" onClick={() => pick.current?.click()} disabled={busy}>
          {busy ? 'Adding…' : 'Add games…'}
        </Button>
        <span className="small muted">Mega Drive cartridge files of your own (.md, .gen, .bin, .smd, or a .zip of one) — or drop them here. They stay on this computer.</span>
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
            void bring(files);
          }}
        />
      </div>
      {list.length === 0 ? (
        <Empty title="No games yet">Add a Mega Drive cartridge file to play it here, alone or with a second player.</Empty>
      ) : (
        <div className="arc-games">
          {list.map((g) => (
            <Cartridge key={g.id} game={g} onPlay={onPlay} onRemoved={onChanged} />
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────── a game being played ─────────────

function Play({
  game,
  resume,
  seats,
  sound,
  onSound,
  onLeft,
  leaver,
  note,
}: {
  game: Game;
  resume: boolean;
  seats: Seats;
  sound: boolean;
  onSound: (on: boolean) => void;
  onLeft: () => void;
  leaver: MutableRefObject<(() => Promise<void>) | null>;
  note: (text: string, kind?: 'success' | 'error') => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const machine = useRef<ArcadeConsole | null>(null);
  const [phase, setPhase] = useState<'starting' | 'running' | 'failed'>('starting');
  const [why, setWhy] = useState('');
  const [paused, setPaused] = useState(false);
  const [heard, setHeard] = useState<SoundState | null>(null);
  const [keptAt, setKeptAt] = useState<string | null>(null);
  const seatsNow = useRef(seats);
  seatsNow.current = seats;
  const soundNow = useRef(sound);
  soundNow.current = sound;
  const phaseNow = useRef(phase);
  phaseNow.current = phase;

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
    });
    machine.current = c;
    let off = false;
    void (async () => {
      const [bytes, kept] = await Promise.all([romOf(game.id), keptOf(game.id)]);
      if (!bytes) throw new Error('this game is no longer on this computer');
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
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      onLeft();
    })();
    return leaving.current;
  }, [keepNow, onLeft]);
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

  // The keyboard: the keys of whoever holds it are the game's, and the office does not hear them.
  useEffect(() => {
    if (phase !== 'running') return;
    const c = machine.current!;
    const keys = new Map<string, { player: Player; button: PadButton }>();
    const count = new Map<string, number>();
    const press = (hit: { player: Player; button: PadButton }, down: boolean) => {
      const k = `${hit.player}:${hit.button}`;
      const n = (count.get(k) ?? 0) + (down ? 1 : -1);
      count.set(k, Math.max(0, n));
      // Two keys may mean one button (W and the up arrow): it is held while either is.
      if (down ? n === 1 : n === 0) c.pad(hit.player, hit.button, down);
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const hit = buttonOfKey(seatsNow.current, e.code);
      if (!hit) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat || keys.has(e.code)) return;
      keys.set(e.code, hit);
      press(hit, true);
    };
    const up = (e: KeyboardEvent) => {
      const hit = keys.get(e.code);
      if (!hit) return;
      keys.delete(e.code);
      e.preventDefault();
      e.stopImmediatePropagation();
      press(hit, false);
    };
    const letGo = () => {
      for (const hit of keys.values()) press(hit, false);
      keys.clear();
      // The console never holds the keyboard: a click that landed in it gives the keys back to this window.
      if (document.activeElement === frame.current) window.focus();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', letGo);
    // (For the office's shortcuts that listen before this one does: push-to-talk bound to a key a player holds.)
    const giveBack = takeKeys((code) => !!buttonOfKey(seatsNow.current, code));
    return () => {
      giveBack();
      letGo();
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', letGo);
    };
  }, [phase]);

  // Gamepads: read every frame, and only what changed is passed on.
  useEffect(() => {
    if (phase !== 'running') return;
    const c = machine.current!;
    const before: Record<Player, Set<PadButton>> = { 1: new Set(), 2: new Set() };
    let frameId = 0;
    const read = () => {
      frameId = requestAnimationFrame(read);
      const all = navigator.getGamepads?.() ?? [];
      for (const player of [1, 2] as const) {
        const seat = player === 1 ? seatsNow.current.p1 : seatsNow.current.p2;
        const pad = typeof seat === 'number' ? all[seat] : null;
        const now = pad ? buttonsOfPad(pad) : new Set<PadButton>();
        for (const ch of changes(before[player], now)) c.pad(player, ch.button, ch.down);
        before[player] = now;
      }
    };
    read();
    return () => {
      cancelAnimationFrame(frameId);
      for (const player of [1, 2] as const) for (const b of before[player]) c.pad(player, b, false);
    };
  }, [phase]);

  useEffect(() => {
    if (phase === 'running') machine.current?.sound(sound);
  }, [sound, phase]);

  const running = phase === 'running';
  const act = (what: () => void) => () => {
    what();
    // A button that was clicked keeps no hold on Enter: Enter is Start.
    (document.activeElement as HTMLElement | null)?.blur?.();
  };
  return (
    <div className="arc-play" data-arcade-play-view data-arcade-phase={phase} data-arcade-paused={paused || undefined} data-arcade-sound-state={heard ?? undefined}>
      <div className="row arc-bar">
        <Button onClick={() => void leave()} title="Back to the games (Esc). Where you are is kept." data-arcade-back>
          ← Games
        </Button>
        <span className="arc-bar-title truncate">{game.title}</span>
        <span className="grow" />
        {keptAt && <span className="small faint">Kept {timeAgo(keptAt)}</span>}
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
        <Button small onClick={act(() => onSound(!sound))} aria-pressed={sound} data-arcade-sound>
          {sound ? 'Sound on' : 'Sound off'}
        </Button>
        <Button small disabled={!running} onClick={act(() => void wrap.current?.requestFullscreen().catch(() => undefined))} title="Esc leaves full screen">
          Full screen
        </Button>
      </div>
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

// ───────────── the window ─────────────

function ArcadePanel({ onClose }: { arg: string | null; onClose: () => void }) {
  const toast = useOffice((s) => s.toast);
  const note = useCallback((text: string, kind?: 'success' | 'error') => toast(text, kind), [toast]);
  const [list, setList] = useState<Game[] | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  const [playing, setPlaying] = useState<{ game: Game; resume: boolean } | null>(null);
  const [sound, setSound] = useState(() => stored('arcade.sound', true));
  const [wanted, setWanted] = useState<Partial<Seats> | null>(() => stored<Partial<Seats> | null>('arcade.seats', null));
  const pads = usePads();
  const seats = useMemo(() => settleSeats(wanted, pads.map((p) => p.index)), [wanted, pads]);
  const leaver = useRef<(() => Promise<void>) | null>(null);

  const reload = useCallback(() => {
    games()
      .then(setList)
      .catch((e: Error) => setBroken(e.message));
  }, []);
  useEffect(reload, [reload]);

  const play = async (game: Game, resume: boolean) => {
    if (!resume && game.stateAt) await forgetState(game.id).catch(() => undefined);
    setPlaying({ game, resume });
  };
  const left = useCallback(() => {
    setPlaying(null);
    reload();
  }, [reload]);
  // Closing the window while a game is on keeps where the player is first.
  const close = useCallback(() => {
    if (leaver.current) void leaver.current().then(onClose);
    else onClose();
  }, [onClose]);

  return (
    <Window title="Arcade" subtitle="A Mega Drive for the games you bring — one or two players, on this computer" onClose={close} width={playing ? 1040 : 900}>
      <div className="arc" data-arcade>
        {broken ? (
          <Empty title="The arcade has nowhere to keep games">This browser gave it no storage ({broken}). A private window does that; an ordinary one does not.</Empty>
        ) : playing ? (
          <Play
            key={`${playing.game.id}:${playing.resume}`}
            game={playing.game}
            resume={playing.resume}
            seats={seats}
            sound={sound}
            onSound={(on) => {
              setSound(on);
              store('arcade.sound', on);
            }}
            onLeft={left}
            leaver={leaver}
            note={note}
          />
        ) : list === null ? (
          <div className="small muted">Looking at the shelf…</div>
        ) : (
          <Shelf list={list} onPlay={(g, resume) => void play(g, resume)} onChanged={reload} note={note} />
        )}
        {!broken && (
          <Players
            seats={seats}
            pads={pads}
            onChange={(next, by) => {
              const settled = settleSeats(next, pads.map((p) => p.index), by);
              setWanted(settled);
              store('arcade.seats', settled);
            }}
          />
        )}
      </div>
    </Window>
  );
}

registerPanel('arcade', ArcadePanel);
