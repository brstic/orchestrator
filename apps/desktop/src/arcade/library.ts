import { romFrom, romId, titleOf } from './roms.ts';

/**
 * The games somebody has brought to the arcade, kept in this browser's own storage on this computer: the cartridges,
 * what each one's battery memory holds, and where the player last stopped. None of it is sent to the office.
 */

export interface Game {
  id: string;
  title: string;
  /** The cartridge's file name, as the console is told it. */
  file: string;
  size: number;
  addedAt: string;
  playedAt?: string;
  /** When the moment to continue from was kept, and a picture of it. */
  stateAt?: string;
  shot?: Blob;
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

/** Every game, the one played last first. */
export async function games(): Promise<Game[]> {
  const all = await tx([GAMES], 'readonly', (t) => done(t.objectStore(GAMES).getAll() as IDBRequest<Game[]>));
  return all.sort((a, b) => (b.playedAt ?? b.addedAt).localeCompare(a.playedAt ?? a.addedAt));
}

/** A file somebody brought: kept as a game, or the reason it is not one. The same cartridge twice is one game. */
export async function addFile(file: { name: string; arrayBuffer(): Promise<ArrayBuffer> }): Promise<{ ok: true; game: Game; already: boolean } | { ok: false; why: string }> {
  const found = await romFrom(file.name, new Uint8Array(await file.arrayBuffer()));
  if (!found.ok) return found;
  const id = await romId(found.rom.bytes);
  const game: Game = { id, title: titleOf(found.rom), file: found.rom.name, size: found.rom.bytes.length, addedAt: new Date().toISOString() };
  const bytes = found.rom.bytes.slice().buffer;
  return tx([GAMES, ROMS], 'readwrite', async (t) => {
    const had = await done(t.objectStore(GAMES).get(id) as IDBRequest<Game | undefined>);
    if (had) return { ok: true as const, game: had, already: true };
    t.objectStore(GAMES).put(game, id);
    t.objectStore(ROMS).put(bytes, id);
    return { ok: true as const, game, already: false };
  });
}

export async function romOf(id: string): Promise<ArrayBuffer | null> {
  return (await tx([ROMS], 'readonly', (t) => done(t.objectStore(ROMS).get(id) as IDBRequest<ArrayBuffer | undefined>))) ?? null;
}

export async function keptOf(id: string): Promise<Kept> {
  return (await tx([KEPT], 'readonly', (t) => done(t.objectStore(KEPT).get(id) as IDBRequest<Kept | undefined>))) ?? {};
}

/** What the console handed back of a game: its battery memory always, and the moment to continue from when given. */
export async function keep(id: string, now: { sram?: ArrayBuffer; state?: ArrayBuffer; shot?: ArrayBuffer }): Promise<Game | null> {
  return tx([GAMES, KEPT], 'readwrite', async (t) => {
    const game = await done(t.objectStore(GAMES).get(id) as IDBRequest<Game | undefined>);
    if (!game) return null;
    const had = (await done(t.objectStore(KEPT).get(id) as IDBRequest<Kept | undefined>)) ?? {};
    t.objectStore(KEPT).put({ sram: now.sram ?? had.sram, state: now.state ?? had.state } satisfies Kept, id);
    const next: Game = { ...game, playedAt: new Date().toISOString(), ...(now.state ? { stateAt: new Date().toISOString(), shot: now.shot ? new Blob([now.shot], { type: 'image/png' }) : game.shot } : {}) };
    t.objectStore(GAMES).put(next, id);
    return next;
  });
}

/** Starting a game over: the moment to continue from is dropped, the cartridge's battery memory stays. */
export async function forgetState(id: string): Promise<void> {
  await tx([GAMES, KEPT], 'readwrite', async (t) => {
    const game = await done(t.objectStore(GAMES).get(id) as IDBRequest<Game | undefined>);
    const had = await done(t.objectStore(KEPT).get(id) as IDBRequest<Kept | undefined>);
    if (had) t.objectStore(KEPT).put({ sram: had.sram } satisfies Kept, id);
    if (game) {
      const { stateAt: _a, shot: _s, ...rest } = game;
      t.objectStore(GAMES).put(rest, id);
    }
  });
}

/** A game taken out, with everything kept of it. */
export async function remove(id: string): Promise<void> {
  await tx([GAMES, ROMS, KEPT], 'readwrite', (t) => {
    for (const store of [GAMES, ROMS, KEPT]) t.objectStore(store).delete(id);
  });
}
