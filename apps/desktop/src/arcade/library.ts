import { ARCADE_PIECE_BYTES, type ArcadeGame } from '@orchestrator/contracts';
import { api, apiBlob } from '../lib/api.ts';
import { toBase64 } from './net.ts';
import { romFrom, romId, titleOf } from './roms.ts';

/**
 * The arcade's games as this window has them. The shelf is the office's (`/api/arcade/games`): a game brought here is
 * there on every computer. What is kept in this browser is what is one person's on one computer — where they stopped
 * in a game, what the cartridge's battery memory holds for them — and a copy of each cartridge that was played, so
 * that it is not fetched again.
 */

/** A game on the shelf, with what this computer knows of it. */
export interface Game extends ArcadeGame {
  playedAt?: string;
  /** When the moment to continue from was kept, and a picture of it. */
  stateAt?: string;
  shot?: Blob;
}

/** What this computer keeps beside a game. (`title`, `file`: from before the shelf moved to the office.) */
interface Local {
  id: string;
  playedAt?: string;
  stateAt?: string;
  shot?: Blob;
  title?: string;
  file?: string;
  size?: number;
}

export interface Kept {
  sram?: ArrayBuffer;
  state?: ArrayBuffer;
}

const DB = 'orchestrator-arcade';
const GAMES = 'games';
const ROMS = 'roms';
const KEPT = 'kept';

let opened: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      for (const store of [GAMES, ROMS, KEPT]) if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('this browser gave the arcade no storage'));
  }).catch((e) => {
    opened = null;
    throw e;
  });
  return opened;
}

const done = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

async function tx<T>(stores: string[], mode: IDBTransactionMode, work: (t: IDBTransaction) => Promise<T> | T): Promise<T> {
  const t = (await db()).transaction(stores, mode);
  const finished = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error ?? new Error('the arcade could not keep that'));
  });
  const result = await work(t);
  await finished;
  return result;
}

/** What this computer knows of each game, by id. A browser that keeps nothing knows nothing, and the shelf still shows. */
export async function locals(): Promise<Record<string, Local>> {
  try {
    const all = await tx([GAMES], 'readonly', (t) => done(t.objectStore(GAMES).getAll() as IDBRequest<Local[]>));
    return Object.fromEntries(all.map((l) => [l.id, l]));
  } catch {
    return {};
  }
}

/** The shelf as this person sees it: the one played last first, then the ones brought last. */
export function shelfOf(games: ArcadeGame[], local: Record<string, Local>): Game[] {
  return games
    .map((g): Game => ({ ...g, playedAt: local[g.id]?.playedAt, stateAt: local[g.id]?.stateAt, shot: local[g.id]?.shot }))
    .sort((a, b) => (b.playedAt ?? b.addedAt).localeCompare(a.playedAt ?? a.addedAt));
}

/** A cartridge sent to the office's shelf, in pieces. */
async function upload(title: string, file: string, bytes: Uint8Array): Promise<{ game: ArcadeGame; already: boolean }> {
  const begun = await api<{ upload: string }>('POST', '/arcade/games', { title, file, size: bytes.length });
  let last: { done: boolean; game?: ArcadeGame; already?: boolean } = { done: false };
  for (let offset = 0; offset < bytes.length; offset += ARCADE_PIECE_BYTES) last = await api('POST', `/arcade/games/${begun.upload}/data`, { offset, dataBase64: toBase64(bytes.subarray(offset, offset + ARCADE_PIECE_BYTES)) });
  if (!last.done || !last.game) throw new Error('the office did not take the whole cartridge');
  return { game: last.game, already: !!last.already };
}

/** A file somebody brought: put on the office's shelf, or the reason it is not a game. The same cartridge twice is one game. */
export async function bring(file: { name: string; arrayBuffer(): Promise<ArrayBuffer> }): Promise<{ ok: true; game: ArcadeGame; already: boolean } | { ok: false; why: string }> {
  const found = await romFrom(file.name, new Uint8Array(await file.arrayBuffer()));
  if (!found.ok) return found;
  const sent = await upload(titleOf(found.rom), found.rom.name, found.rom.bytes);
  // It is here already: no need to fetch it back to play it.
  await tx([ROMS], 'readwrite', (t) => void t.objectStore(ROMS).put(found.rom.bytes.slice().buffer, sent.game.id)).catch(() => undefined);
  return { ok: true, ...sent };
}

/**
 * Games this browser kept from before the shelf was the office's (the first day of the arcade): put on the shelf,
 * so that they are not left on one computer. Returns how many were. Somebody who may not bring games keeps theirs
 * where they are.
 */
export async function bringOldGames(onShelf: ArcadeGame[]): Promise<number> {
  const there = new Set(onShelf.map((g) => g.id));
  const mine = Object.values(await locals()).filter((l) => l.file && !there.has(l.id));
  let brought = 0;
  for (const l of mine) {
    const bytes = await tx([ROMS], 'readonly', (t) => done(t.objectStore(ROMS).get(l.id) as IDBRequest<ArrayBuffer | undefined>)).catch(() => undefined);
    if (!bytes) continue;
    try {
      const { game } = await upload(l.title || l.file!, l.file!, new Uint8Array(bytes));
      // Once on the shelf it is the office's game; what is kept beside it stays, under the name the office gave it.
      await rename(l.id, game.id);
      brought++;
    } catch {
      return brought;
    }
  }
  return brought;
}

/** What was kept under one id is kept under another (a browser without a digest named a cartridge its own way). */
async function rename(from: string, to: string): Promise<void> {
  await tx([GAMES, ROMS, KEPT], 'readwrite', async (t) => {
    const local = await done(t.objectStore(GAMES).get(from) as IDBRequest<Local | undefined>);
    const { title: _t, file: _f, size: _s, ...rest } = local ?? { id: from };
    t.objectStore(GAMES).put({ ...rest, id: to }, to);
    if (from === to) return;
    for (const store of [ROMS, KEPT]) {
      const v = await done(t.objectStore(store).get(from));
      if (v !== undefined) t.objectStore(store).put(v, to);
      t.objectStore(store).delete(from);
    }
    t.objectStore(GAMES).delete(from);
  });
}

/** A game's cartridge: this computer's copy, or the office's (and then a copy is kept). */
export async function romOf(id: string): Promise<ArrayBuffer> {
  const have = await tx([ROMS], 'readonly', (t) => done(t.objectStore(ROMS).get(id) as IDBRequest<ArrayBuffer | undefined>)).catch(() => undefined);
  if (have) return have;
  const bytes = await (await apiBlob(`/arcade/games/${id}/rom`)).arrayBuffer();
  await tx([ROMS], 'readwrite', (t) => void t.objectStore(ROMS).put(bytes, id)).catch(() => undefined);
  return bytes;
}

export async function keptOf(id: string): Promise<Kept> {
  return (await tx([KEPT], 'readonly', (t) => done(t.objectStore(KEPT).get(id) as IDBRequest<Kept | undefined>)).catch(() => undefined)) ?? {};
}

/** What the console handed back of a game: its battery memory always, and the moment to continue from when given. */
export async function keep(id: string, now: { sram?: ArrayBuffer; state?: ArrayBuffer; shot?: ArrayBuffer }): Promise<void> {
  await tx([GAMES, KEPT], 'readwrite', async (t) => {
    const local = (await done(t.objectStore(GAMES).get(id) as IDBRequest<Local | undefined>)) ?? { id };
    const had = (await done(t.objectStore(KEPT).get(id) as IDBRequest<Kept | undefined>)) ?? {};
    t.objectStore(KEPT).put({ sram: now.sram ?? had.sram, state: now.state ?? had.state } satisfies Kept, id);
    t.objectStore(GAMES).put({ ...local, playedAt: new Date().toISOString(), ...(now.state ? { stateAt: new Date().toISOString(), shot: now.shot ? new Blob([now.shot], { type: 'image/png' }) : local.shot } : {}) } satisfies Local, id);
  });
}

/** Starting a game over: the moment to continue from is dropped, the cartridge's battery memory stays. */
export async function forgetState(id: string): Promise<void> {
  await tx([GAMES, KEPT], 'readwrite', async (t) => {
    const local = await done(t.objectStore(GAMES).get(id) as IDBRequest<Local | undefined>);
    const had = await done(t.objectStore(KEPT).get(id) as IDBRequest<Kept | undefined>);
    if (had) t.objectStore(KEPT).put({ sram: had.sram } satisfies Kept, id);
    if (local) {
      const { stateAt: _a, shot: _s, ...rest } = local;
      t.objectStore(GAMES).put(rest, id);
    }
  });
}

/** A game taken off the office's shelf — for everyone — and everything this computer kept of it. */
export async function remove(id: string): Promise<void> {
  await api('DELETE', `/arcade/games/${id}`);
  await tx([GAMES, ROMS, KEPT], 'readwrite', (t) => {
    for (const store of [GAMES, ROMS, KEPT]) t.objectStore(store).delete(id);
  }).catch(() => undefined);
}

export { romId };
