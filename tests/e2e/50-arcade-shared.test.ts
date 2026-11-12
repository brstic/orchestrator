/**
 * The arcade's shared side (docs/ARCADE.md): the games are on the office's shelf, so what one member brings is there
 * for everyone on every computer; and a table — a game one window plays, its picture and sound passed to those who
 * sat down at it, and the second pad's buttons passed back from whoever holds that pad and from nobody else.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ARCADE_BUTTONS, ARCADE_PIECE_BYTES, type ArcadeGame, type ArcadeTable, type ClientToServer, type ServerToClient } from '@orchestrator/contracts';
import { buildTestRom } from '../fixtures/md-test-rom.mjs';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

// The door's certificate is made on this machine (a real office is behind a name with a trusted certificate).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.removeAllListeners('warning');

let h: Harness;
/** Members come in through the door, as they do in a real office. */
let door = '';
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const tokens: Record<string, string> = {};
const decode = (code: string) => JSON.parse(Buffer.from(code.replace(/^orch-invite-v1\./, ''), 'base64url').toString('utf8'));
const rom = buildTestRom();
const romId = crypto.createHash('sha1').update(rom).digest('hex');

const as = async (who: string, method: string, p: string, body?: unknown) => {
  const r = await fetch(`${door}/api${p}`, { method, headers: { authorization: `Bearer ${tokens[who]}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') ?? '';
  return { status: r.status, body: type.includes('json') ? ((await r.json().catch(() => null)) as any) : Buffer.from(await r.arrayBuffer()), headers: r.headers };
};
/** Bring a cartridge the way the window does: say what it is, then its bytes in pieces. */
async function bring(who: string, file: string, bytes: Buffer, title = 'Orchestrator Pad Test') {
  const begun = await as(who, 'POST', '/arcade/games', { title, file, size: bytes.length });
  if (begun.status !== 200) return begun;
  let last = begun;
  for (let offset = 0; offset < bytes.length; offset += ARCADE_PIECE_BYTES) last = await as(who, 'POST', `/arcade/games/${begun.body.upload}/data`, { offset, dataBase64: bytes.subarray(offset, offset + ARCADE_PIECE_BYTES).toString('base64') });
  return last;
}

/** A window in the office. */
function windowOf(who: string) {
  const ws = new WebSocket(`${door.replace('https', 'wss')}/ws/client`, ['orch.v1', `orch.token.${tokens[who]}`]);
  const got: ServerToClient[] = [];
  ws.onmessage = (ev) => got.push(JSON.parse(String(ev.data)));
  ws.onerror = () => undefined;
  const until = <T extends ServerToClient['t']>(t: T, pred: (m: Extract<ServerToClient, { t: T }>) => boolean = () => true, label: string = t) =>
    waitFor(async () => got.find((m) => m.t === t && pred(m as any)) as Extract<ServerToClient, { t: T }> | undefined, { label: `${who}: ${label}`, timeout: 8000 });
  return {
    ws,
    got,
    until,
    send: (m: ClientToServer) => ws.send(JSON.stringify(m)),
    id: async () => (await until('ready')).clientId,
    arcade: () => got.filter((m) => m.t === 'arcade').pop() as Extract<ServerToClient, { t: 'arcade' }> | undefined,
    media: () => got.filter((m) => m.t === 'arcade.media') as Array<Extract<ServerToClient, { t: 'arcade.media' }>>,
    pads: () => got.filter((m) => m.t === 'arcade.pad') as Array<Extract<ServerToClient, { t: 'arcade.pad' }>>,
    close: () => ws.close(),
  };
}

before(async () => {
  h = await createHarness();
  const port = await freePort();
  await h.api('POST', '/sharing', { open: true, port });
  door = `https://127.0.0.1:${port}`;
  for (const [name, role] of [['Branko', 'owner'], ['Mila', 'visitor'], ['Fenix', 'colleague'], ['Vera', 'colleague']] as const) tokens[name] = decode((await h.api<any>('POST', '/guests', { name, role })).invite).t;
});
after(async () => {
  await h?.cleanup();
});

test('a game brought by one member is on the office\'s shelf for everyone, byte for byte; a visitor plays but does not bring or remove', async () => {
  assert.deepEqual((await as('Branko', 'GET', '/arcade/games')).body.games, []);
  const done = await bring('Fenix', 'C:\\Games\\Pad Test (World).md', rom);
  assert.equal(done.status, 200);
  assert.equal(done.body.done, true);
  const game: ArcadeGame = done.body.game;
  assert.deepEqual([game.id, game.title, game.file, game.size, game.addedBy], [romId, 'Orchestrator Pad Test', 'Pad Test (World).md', rom.length, 'Fenix'], 'named by its bytes; the folder it came from is nobody\'s business');
  // Everyone sees it, a visitor too, and gets the same bytes.
  for (const who of ['Branko', 'Mila', 'Vera']) {
    assert.deepEqual((await as(who, 'GET', '/arcade/games')).body.games.map((g: ArcadeGame) => g.id), [romId], who);
    const got = await as(who, 'GET', `/arcade/games/${romId}/rom`);
    assert.equal(got.status, 200);
    assert.ok(Buffer.isBuffer(got.body) && got.body.equals(rom), `${who} gets the cartridge as it was brought`);
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.match(got.headers.get('content-disposition') ?? '', /^attachment/);
  }
  // The same cartridge again, under another name: one game.
  const again = await bring('Branko', 'another name.gen', rom, 'Something else');
  assert.deepEqual([again.body.done, again.body.already, again.body.game.title], [true, true, 'Orchestrator Pad Test']);
  assert.equal((await as('Branko', 'GET', '/arcade/games')).body.games.length, 1);
  // A visitor looks and plays; the shelf is not theirs to change.
  assert.equal((await bring('Mila', 'mine.md', rom)).status, 403);
  assert.equal((await as('Mila', 'DELETE', `/arcade/games/${romId}`)).status, 403);
  // Nobody without a way in gets anything.
  assert.equal((await fetch(`${door}/api/arcade/games`)).status, 401);
  assert.equal((await fetch(`${door}/api/arcade/games/${romId}/rom`)).status, 401);
  // On the record: who brought what.
  const audit = await h.api<any[]>('GET', '/audit?limit=50');
  assert.ok(audit.some((a) => a.action === 'arcade.game_added' && a.target === romId && /Fenix/.test(a.actor)), 'the audit log says who brought it');
});

test('what is not a cartridge is refused in words, and a piece out of place does not make a game', async () => {
  assert.match((await bring('Fenix', 'notes.txt', rom)).body.error, /not a cartridge file/);
  assert.match((await as('Fenix', 'POST', '/arcade/games', { file: 'tiny.md', size: 10 })).body.error, /too small/);
  assert.match((await as('Fenix', 'POST', '/arcade/games', { file: 'huge.bin', size: 17 * 1024 * 1024 })).body.error, /too large/);
  const other = Buffer.concat([rom.subarray(0, 0x300), Buffer.from('another game'), rom.subarray(0x30c)]);
  const begun = await as('Fenix', 'POST', '/arcade/games', { title: 'Other', file: 'other.md', size: other.length });
  assert.equal((await as('Fenix', 'POST', `/arcade/games/${begun.body.upload}/data`, { offset: 4096, dataBase64: other.subarray(0, 100).toString('base64') })).status, 409, 'a piece from the middle first');
  assert.equal((await as('Fenix', 'POST', `/arcade/games/${begun.body.upload}/data`, { offset: 0, dataBase64: Buffer.alloc(other.length + 5000).toString('base64') })).status, 400, 'more than it was said to be');
  assert.equal((await as('Fenix', 'POST', `/arcade/games/${begun.body.upload}/data`, { offset: 0, dataBase64: 'AAAA' })).status, 404, 'and that attempt is over');
  assert.equal((await as('Fenix', 'GET', '/arcade/games/not-an-id/rom')).status, 404);
  assert.equal((await as('Fenix', 'GET', `/arcade/games/${'0'.repeat(40)}/rom`)).status, 404);
  assert.equal((await as('Branko', 'GET', '/arcade/games')).body.games.length, 1);
});

test('the shelf is the office\'s: it is there after a restart, and a game taken off is gone for everyone', async () => {
  const other = Buffer.concat([rom.subarray(0, 0x300), Buffer.from('another game'), rom.subarray(0x30c)]);
  const second = (await bring('Vera', 'other.md', other, 'Other Game')).body.game as ArcadeGame;
  await h.restartServer();
  const games = (await as('Branko', 'GET', '/arcade/games')).body.games as ArcadeGame[];
  assert.deepEqual(games.map((g) => g.title).sort(), ['Orchestrator Pad Test', 'Other Game']);
  assert.ok((await as('Mila', 'GET', `/arcade/games/${second.id}/rom`)).body.equals(other));
  // A window that is open hears of the change without asking.
  const mila = windowOf('Mila');
  await mila.until('arcade', (m) => m.games.length === 2, 'the shelf at the start');
  assert.equal((await as('Fenix', 'DELETE', `/arcade/games/${second.id}`)).status, 200);
  await mila.until('arcade', (m) => m.games.length === 1, 'the shelf after a game was taken off');
  assert.equal((await as('Branko', 'GET', `/arcade/games/${second.id}/rom`)).status, 404);
  assert.ok(!fs.readdirSync(path.join(h.tmp, 'server', 'arcade')).some((f) => f.startsWith(second.id)), 'its file is gone from the office\'s folder');
  mila.close();
});

test('a table: the host\'s picture and sound reach those who sat down and nobody else; the second pad is one person\'s', async () => {
  const host = windowOf('Branko');
  const fenix = windowOf('Fenix');
  const mila = windowOf('Mila');
  const vera = windowOf('Vera');
  const [hostId, fenixId, milaId] = [await host.id(), await fenix.id(), await mila.id()];
  await vera.id();
  const table = (w: ReturnType<typeof windowOf>): ArcadeTable | undefined => w.arcade()?.tables[0];

  // Nothing is a table until somebody opens one; then everyone in the office sees it.
  assert.deepEqual(host.arcade()?.tables ?? [], []);
  host.send({ t: 'arcade.open', title: 'Orchestrator Pad Test', gameId: romId });
  for (const w of [host, fenix, mila, vera]) await w.until('arcade', (m) => m.tables.length === 1, 'the table is open');
  assert.deepEqual([table(vera)!.id, table(vera)!.host.name, table(vera)!.title, table(vera)!.gameId, table(vera)!.player2], [hostId, 'Branko', 'Orchestrator Pad Test', romId, null]);

  // Fenix takes the second pad; Mila asks for it too and looks on instead. The host is asked for a picture that stands by itself, for each.
  fenix.send({ t: 'arcade.join', table: hostId, as: 'player' });
  await host.until('arcade.key', (m) => m.to === fenixId, 'asked for a first picture for Fenix');
  mila.send({ t: 'arcade.join', table: hostId, as: 'player' });
  await host.until('arcade.key', (m) => m.to === milaId, 'asked for a first picture for Mila');
  await vera.until('arcade', (m) => m.tables[0]?.player2?.name === 'Fenix' && m.tables[0]?.watching.length === 1, 'who is at the table');
  assert.deepEqual(table(vera)!.watching.map((w) => w.name), ['Mila'], 'the pad was taken: a second one who asks for it looks on');

  // A picture built on one they never got is not passed on; from one that stands by itself on, everything is.
  host.send({ t: 'arcade.media', kind: 'cfg', ts: 0, data: 'Y2Zn' });
  host.send({ t: 'arcade.media', kind: 'v', ts: 1, data: 'ZGVsdGE=' });
  host.send({ t: 'arcade.media', kind: 'v', key: true, ts: 2, data: 'a2V5' });
  host.send({ t: 'arcade.media', kind: 'v', ts: 3, data: 'bmV4dA==' });
  host.send({ t: 'arcade.media', kind: 'a', ts: 3, data: 'c291bmQ=' });
  for (const w of [fenix, mila]) {
    await waitFor(() => w.media().length >= 4, { label: 'the pieces arrived', timeout: 8000 });
    assert.deepEqual(w.media().map((m) => [m.kind, m.key === true, m.ts, m.data, m.table]), [['cfg', false, 0, 'Y2Zn', hostId], ['v', true, 2, 'a2V5', hostId], ['v', false, 3, 'bmV4dA==', hostId], ['a', false, 3, 'c291bmQ=', hostId]]);
  }
  await sleep(300);
  assert.equal(vera.media().length, 0, 'somebody who is not at the table gets none of it');
  assert.equal(host.media().length, 0, 'and the host is not sent its own');

  // The second pad: Fenix's buttons reach the host; Mila's (looking on), Vera's (not there) and nonsense do not.
  fenix.send({ t: 'arcade.pad', button: 'b', down: true });
  mila.send({ t: 'arcade.pad', button: 'c', down: true });
  vera.send({ t: 'arcade.pad', button: 'a', down: true });
  fenix.send({ t: 'arcade.pad', button: 'turbo' as never, down: true });
  fenix.send({ t: 'arcade.pad', button: 'b', down: false });
  await waitFor(() => host.pads().length >= 2, { label: 'the pad reached the host', timeout: 8000 });
  await sleep(300);
  assert.deepEqual(host.pads().map((p) => [p.button, p.down]), [['b', true], ['b', false]]);
  // Somebody who is not the host cannot send pictures to a table.
  fenix.send({ t: 'arcade.media', kind: 'v', key: true, ts: 9, data: 'ZmFrZQ==' });
  await sleep(300);
  assert.ok(!mila.media().some((m) => m.data === 'ZmFrZQ=='));

  // Fenix gets up with a button held: the pad lets everything go, and the seat is free for Mila.
  fenix.send({ t: 'arcade.pad', button: 'start', down: true });
  fenix.send({ t: 'arcade.leave' });
  await waitFor(() => host.pads().filter((p) => !p.down).length >= 1 + ARCADE_BUTTONS.length, { label: 'everything let go', timeout: 8000 });
  await vera.until('arcade', (m) => m.tables[0]?.player2 === null, 'the pad is free');
  mila.send({ t: 'arcade.join', table: hostId, as: 'player' });
  await vera.until('arcade', (m) => m.tables[0]?.player2?.name === 'Mila' && m.tables[0]?.watching.length === 0, 'Mila has the pad now');

  // The host leaves the office: the table is over, and those at it are told.
  host.close();
  await mila.until('arcade.closed', (m) => m.table === hostId, 'told that it is over');
  await vera.until('arcade', (m) => m.tables.length === 0 && m.games.length === 1, 'no table any more');
  for (const w of [fenix, mila, vera]) w.close();
});
