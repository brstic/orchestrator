import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ARCADE_BUTTONS,
  ARCADE_EXTENSIONS,
  ARCADE_MAX_BYTES,
  ARCADE_MAX_GAMES,
  ARCADE_MAX_WATCHING,
  ARCADE_MEDIA_MAX,
  ARCADE_MEDIA_PER_SECOND,
  ARCADE_PIECE_BYTES,
  type ArcadeButton,
  type ArcadeGame,
  type ArcadeMediaKind,
  type ArcadeTable,
  type ServerToClient,
} from '@orchestrator/contracts';

/**
 * The arcade on the office's side (docs/ARCADE.md): the shelf of games the members brought, kept with the office so
 * that a game brought on one computer is there on every other, and the tables — who is playing with whom right now.
 * The office runs no game: a table's host does, and the office passes its picture and sound to those at the table and
 * the second pad's buttons back.
 */

const ID = /^[0-9a-f]{40}$/;
const clean = (s: unknown, max: number): string =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export class ArcadeError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface Upload {
  id: string;
  tmp: string;
  size: number;
  received: number;
  title: string;
  file: string;
  by: string;
  hash: crypto.Hash;
  at: number;
}

/** The games on the shelf: a file each in the office's data folder, and a list of what they are. */
export class ArcadeShelf {
  private dir: string;
  private listFile: string;
  private games: ArcadeGame[] = [];
  private uploads = new Map<string, Upload>();
  private changed: () => void;

  constructor(dir: string, changed: () => void = () => undefined) {
    this.dir = dir;
    this.listFile = path.join(dir, 'games.json');
    this.changed = changed;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      const kept = JSON.parse(fs.readFileSync(this.listFile, 'utf8')) as ArcadeGame[];
      // A game whose file is gone is not a game.
      this.games = (Array.isArray(kept) ? kept : []).filter((g) => g && ID.test(g.id) && fs.existsSync(this.fileOf(g.id)));
    } catch {
      this.games = [];
    }
    // What a stopped office left half-brought.
    for (const f of fs.readdirSync(dir)) if (f.startsWith('.bringing-')) fs.rmSync(path.join(dir, f), { force: true });
  }

  private fileOf(id: string): string {
    return path.join(this.dir, `${id}.rom`);
  }
  private save(): void {
    const tmp = `${this.listFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.games, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.listFile);
    this.changed();
  }

  list(): ArcadeGame[] {
    return this.games;
  }

  /** Somebody starts bringing a cartridge: what it is called and how large it is. The bytes follow in pieces. */
  begin(what: { title?: unknown; file?: unknown; size?: unknown }, by: string): { upload: string; piece: number } {
    const size = Number(what.size);
    const file = clean(String(what.file ?? '').replace(/^.*[\\/]/, ''), 120);
    const ext = /\.([A-Za-z0-9]{1,5})$/.exec(file)?.[1]?.toLowerCase() ?? '';
    if (!(ARCADE_EXTENSIONS as readonly string[]).includes(ext)) throw new ArcadeError(`not a cartridge file (${ARCADE_EXTENSIONS.map((e) => `.${e}`).join(', ')})`);
    if (!Number.isInteger(size) || size < 1024) throw new ArcadeError('too small to be a cartridge');
    if (size > ARCADE_MAX_BYTES) throw new ArcadeError('too large to be a cartridge');
    if (this.games.length >= ARCADE_MAX_GAMES) throw new ArcadeError(`the shelf is full (${ARCADE_MAX_GAMES} games): take one off first`);
    // A few at a time for each office: what nobody finished in ten minutes is dropped.
    const now = Date.now();
    for (const u of this.uploads.values()) if (now - u.at > 600_000) this.drop(u);
    if (this.uploads.size >= 8) throw new ArcadeError('too many games are being brought at once: try again in a moment', 429);
    const id = crypto.randomUUID();
    const title = clean(what.title, 80) || file.replace(/\.[A-Za-z0-9]{1,5}$/, '');
    this.uploads.set(id, { id, tmp: path.join(this.dir, `.bringing-${id}`), size, received: 0, title, file, by, hash: crypto.createHash('sha1'), at: now });
    return { upload: id, piece: ARCADE_PIECE_BYTES };
  }

  private drop(u: Upload): void {
    this.uploads.delete(u.id);
    fs.rmSync(u.tmp, { force: true });
  }

  /** The next piece. With the last one the cartridge is on the shelf — or was there already, under the same bytes. */
  append(upload: string, offset: number, bytes: Buffer): { received: number; done: boolean; game?: ArcadeGame; already?: boolean } {
    const u = this.uploads.get(upload);
    if (!u) throw new ArcadeError('that cartridge is not being brought (any more): start again', 404);
    if (offset !== u.received) throw new ArcadeError(`expected the piece at ${u.received}, not at ${offset}`, 409);
    if (!bytes.length || bytes.length > ARCADE_PIECE_BYTES + 1024 || u.received + bytes.length > u.size) {
      this.drop(u);
      throw new ArcadeError('that piece does not fit the cartridge it was said to be');
    }
    fs.appendFileSync(u.tmp, bytes, { mode: 0o600 });
    u.hash.update(bytes);
    u.received += bytes.length;
    u.at = Date.now();
    if (u.received < u.size) return { received: u.received, done: false };
    const id = u.hash.digest('hex');
    this.uploads.delete(u.id);
    const had = this.games.find((g) => g.id === id);
    if (had) {
      fs.rmSync(u.tmp, { force: true });
      return { received: u.received, done: true, game: had, already: true };
    }
    fs.renameSync(u.tmp, this.fileOf(id));
    const game: ArcadeGame = { id, title: u.title, file: u.file, size: u.size, addedAt: new Date().toISOString(), addedBy: u.by };
    this.games = [...this.games, game];
    this.save();
    return { received: u.received, done: true, game };
  }

  open(id: string): { game: ArcadeGame; file: string } {
    const game = ID.test(id) ? this.games.find((g) => g.id === id) : undefined;
    if (!game) throw new ArcadeError('that game is not on the shelf', 404);
    return { game, file: this.fileOf(id) };
  }

  remove(id: string): ArcadeGame {
    const { game, file } = this.open(id);
    this.games = this.games.filter((g) => g.id !== id);
    fs.rmSync(file, { force: true });
    this.save();
    return game;
  }
}

interface Table {
  host: { id: string; name: string };
  title: string;
  gameId: string | null;
  player2: { id: string; name: string } | null;
  watching: Array<{ id: string; name: string }>;
  since: string;
  /** Pieces sent in the current second (for the limit). */
  second: number;
  pieces: number;
  /** Who waits for a picture that stands by itself: nothing of the picture is passed to them until one comes. */
  starved: Set<string>;
  /** When the host was last asked for such a picture. */
  askedAt: number;
}

/** What the tables need of the office: a way to reach a window, and to know how far behind it is. */
export interface ArcadeLink {
  send(clientId: string, msg: ServerToClient): void;
  /** Bytes waiting to go out to that window. */
  behind(clientId: string): number;
  /** Something about the tables changed: tell everyone. */
  changed(): void;
}

/** A window this far behind gets no more picture until it has caught up (and then one that stands by itself). */
const BEHIND_BYTES = 1_500_000;

/** The tables: a game one window is playing, and who else is at it. Nothing of a game is kept. */
export class ArcadeTables {
  /** By the host's window. */
  private tables = new Map<string, Table>();
  /** Where a window sits: the table's id. */
  private at = new Map<string, string>();
  private link: ArcadeLink;

  constructor(link: ArcadeLink) {
    this.link = link;
  }

  list(): ArcadeTable[] {
    return [...this.tables.entries()].map(([id, t]) => ({ id, host: t.host, title: t.title, gameId: t.gameId, player2: t.player2, watching: t.watching, since: t.since }));
  }

  /** A window lets the office in on its game. One table a window; opening again renames it. */
  open(who: { id: string; name: string }, title: unknown, gameId: unknown): void {
    this.leave(who.id);
    const had = this.tables.get(who.id);
    const name = clean(title, 80) || 'A game';
    const game = typeof gameId === 'string' && ID.test(gameId) ? gameId : null;
    if (had) Object.assign(had, { title: name, gameId: game });
    else this.tables.set(who.id, { host: who, title: name, gameId: game, player2: null, watching: [], since: new Date().toISOString(), second: 0, pieces: 0, starved: new Set(), askedAt: 0 });
    this.link.changed();
  }

  close(hostId: string): void {
    const t = this.tables.get(hostId);
    if (!t) return;
    this.tables.delete(hostId);
    for (const g of [t.player2, ...t.watching]) {
      if (!g) continue;
      this.at.delete(g.id);
      this.link.send(g.id, { t: 'arcade.closed', table: hostId });
    }
    this.link.changed();
  }

  /** Sit down at a table. The second pad goes to the first who asks for it; anybody after that looks on. */
  join(who: { id: string; name: string }, tableId: unknown, as: unknown): void {
    const t = typeof tableId === 'string' ? this.tables.get(tableId) : undefined;
    if (!t || tableId === who.id) return;
    this.leave(who.id);
    // (Hosting and sitting at somebody else's table at once is not a thing: the window shows one game.)
    this.close(who.id);
    if (as === 'player' && !t.player2) t.player2 = who;
    else if (t.watching.length < ARCADE_MAX_WATCHING) t.watching.push(who);
    else return;
    this.at.set(who.id, tableId as string);
    t.starved.add(who.id);
    this.link.changed();
    this.askKey(tableId as string, t, who.id, true);
  }

  leave(clientId: string): void {
    const tableId = this.at.get(clientId);
    if (!tableId) return;
    this.at.delete(clientId);
    const t = this.tables.get(tableId);
    if (!t) return;
    if (t.player2?.id === clientId) {
      t.player2 = null;
      // Whatever they held is let go: a pad nobody holds presses nothing.
      for (const button of ARCADE_BUTTONS) this.link.send(tableId, { t: 'arcade.pad', button, down: false });
    }
    t.watching = t.watching.filter((w) => w.id !== clientId);
    t.starved.delete(clientId);
    this.link.changed();
  }

  /** A window is gone: its table is over, and its seat at somebody else's is free. */
  gone(clientId: string): void {
    this.leave(clientId);
    this.close(clientId);
  }

  private askKey(tableId: string, t: Table, forWhom: string, now = false): void {
    const at = Date.now();
    if (!now && at - t.askedAt < 1000) return;
    t.askedAt = at;
    this.link.send(tableId, { t: 'arcade.key', to: forWhom });
  }

  /** A piece of a host's picture or sound: to those at its table, and to nobody else. */
  media(hostId: string, kind: unknown, key: unknown, ts: unknown, data: unknown): void {
    const t = this.tables.get(hostId);
    if (!t || (kind !== 'cfg' && kind !== 'v' && kind !== 'a') || typeof data !== 'string' || data.length > ARCADE_MEDIA_MAX) return;
    const second = Math.floor(Date.now() / 1000);
    if (second !== t.second) {
      t.second = second;
      t.pieces = 0;
    }
    if (++t.pieces > ARCADE_MEDIA_PER_SECOND) return;
    const msg: ServerToClient = { t: 'arcade.media', table: hostId, kind: kind as ArcadeMediaKind, ...(key === true ? { key: true } : {}), ts: Number(ts) || 0, data };
    for (const g of [t.player2, ...t.watching]) {
      if (!g) continue;
      if (kind === 'v') {
        // A picture is built on the one before it. A window that fell behind is given none until it has caught up,
        // and then starts from one that stands by itself — which the host is asked for.
        if (!t.starved.has(g.id) && this.link.behind(g.id) > BEHIND_BYTES) t.starved.add(g.id);
        if (t.starved.has(g.id)) {
          if (key === true && this.link.behind(g.id) <= BEHIND_BYTES) t.starved.delete(g.id);
          else {
            this.askKey(hostId, t, g.id);
            continue;
          }
        }
      } else if (kind === 'a' && this.link.behind(g.id) > BEHIND_BYTES) continue;
      this.link.send(g.id, msg);
    }
  }

  /** A button from the second pad: to the host, from whoever holds that pad and from nobody else. */
  pad(clientId: string, button: unknown, down: unknown): void {
    const tableId = this.at.get(clientId);
    const t = tableId ? this.tables.get(tableId) : undefined;
    if (!t || t.player2?.id !== clientId || !(ARCADE_BUTTONS as readonly unknown[]).includes(button)) return;
    this.link.send(tableId!, { t: 'arcade.pad', button: button as ArcadeButton, down: down === true });
  }

  /** Somebody at a table asks for a picture that stands by itself. */
  key(clientId: string): void {
    const tableId = this.at.get(clientId);
    const t = tableId ? this.tables.get(tableId) : undefined;
    if (t) this.askKey(tableId!, t, clientId);
  }
}
