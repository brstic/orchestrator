/**
 * The hi-fi plays for the whole office: what is on is the office's state, told to everyone who is in it and to
 * whoever walks in later. Owners and colleagues switch it; a visitor listens. Only the office's saved stations
 * can be played — nobody can make the other windows load an address of their choosing.
 * (Each window plays the stream itself; no sound passes through the office, so none is played here.)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { RadioNow, ServerToClient } from '@orchestrator/contracts';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

// The door's certificate is made on this machine (a real office is behind a name with a trusted certificate).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.removeAllListeners('warning');

let h: Harness;
let doorUrl = '';
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};

const JAZZ = { id: 'jazz', name: 'Jazz FM', url: 'https://radio.example/jazz.mp3', nowPlayingUrl: null, page: null };
const NEWS = { id: 'news', name: 'News 24', url: 'http://radio.example/news.aac', nowPlayingUrl: null, page: null };
const EVIL = 'https://evil.example/anything.mp3';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const decode = (code: string) => JSON.parse(Buffer.from(code.replace(/^orch-invite-v1\./, ''), 'base64url').toString('utf8'));
/** A request the way a member's app makes it: to the door, with their token. */
const door = async (who: string, method: string, p: string, body?: unknown) => {
  const r = await fetch(`${doorUrl}/api${p}`, { method, headers: { authorization: `Bearer ${tokens[who]}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
type RadioMsg = Extract<ServerToClient, { t: 'radio' }>;
/** A member's office window: the client WebSocket through the door. */
function join(who: string) {
  const ws = new WebSocket(`${doorUrl.replace('https', 'wss')}/ws/client`, ['orch.v1', `orch.token.${tokens[who]}`]);
  const got: ServerToClient[] = [];
  ws.onmessage = (ev) => got.push(JSON.parse(String(ev.data)));
  ws.onerror = () => undefined;
  const heard = () => got.filter((m): m is RadioMsg => m.t === 'radio');
  return {
    ws,
    got,
    heard,
    /** What this window was last told the hi-fi is playing (undefined: nothing was said yet). */
    onAir: (): RadioNow | null | undefined => heard().at(-1)?.radio,
    ready: () => waitFor(async () => got.some((m) => m.t === 'ready') && heard().length > 0, { label: `${who} in the office` }),
    hears: (what: string | null) => waitFor(async () => heard().length > 0 && (heard().at(-1)!.radio?.station.id ?? null) === what, { label: `${who} hears ${what ?? 'the hi-fi go off'}` }),
  };
}
const office = async (): Promise<RadioNow | null> => (await h.api<{ radio: RadioNow | null }>('GET', '/radio')).radio;

let mila: ReturnType<typeof join>;
let jovan: ReturnType<typeof join>;
let vera: ReturnType<typeof join>;

before(async () => {
  h = await createHarness();
  const port = await freePort();
  await h.api('POST', '/sharing', { open: true, port });
  doorUrl = `https://127.0.0.1:${port}`;
  for (const [name, role] of [['Mila', 'visitor'], ['Jovan', 'colleague'], ['Vera', 'owner']] as const) {
    const made = await h.api<any>('POST', '/guests', { name, role });
    tokens[name] = decode(made.invite).t;
    ids[name] = made.guest.id;
  }
  await h.api('PATCH', '/settings', { radio: { stations: [JAZZ, NEWS] } });
});
after(async () => {
  for (const c of [mila, jovan, vera]) c?.ws.close();
  await h.cleanup();
});

test('the hi-fi is off to begin with, and everyone who walks in is told so', async () => {
  assert.equal(await office(), null);
  mila = join('Mila');
  jovan = join('Jovan');
  await Promise.all([mila.ready(), jovan.ready()]);
  assert.deepEqual([mila.onAir(), jovan.onAir()], [null, null]);
  // What is on is part of what everyone may read.
  assert.deepEqual((await door('Mila', 'GET', '/radio')).body, { radio: null });
});

test('a colleague switches a station on: everyone in the office hears which, since when and who', async () => {
  const before = Date.now();
  const res = await door('Jovan', 'POST', '/radio/play', { stationId: 'jazz' });
  assert.equal(res.status, 200);
  await Promise.all([mila.hears('jazz'), jovan.hears('jazz')]);
  const now = mila.onAir()!;
  assert.deepEqual(now.station, JAZZ, 'the station as the office has it saved, address included');
  assert.deepEqual(now.by, { id: ids.Jovan, name: 'Jovan' });
  assert.ok(Date.parse(now.since) >= before - 1000 && Date.parse(now.since) <= Date.now() + 1000);
  assert.deepEqual(jovan.onAir(), now, 'the one who switched it is told the same as everyone else');
  assert.deepEqual(res.body.radio, now);
  assert.deepEqual(await office(), now);
  // The office notes which station was last played, and who switched it is on the record.
  assert.equal((await h.state()).settings.radio.lastStationId, 'jazz');
  const audit = await h.api<any[]>('GET', '/audit');
  assert.ok(audit.some((a) => a.actor === 'member:Jovan' && a.action === 'member.action' && a.target === '/radio/play'));
});

test('a visitor listens and cannot switch the hi-fi', async () => {
  const told = mila.heard().length;
  for (const [p, body] of [['/radio/play', { stationId: 'news' }], ['/radio/stop', {}]] as const) {
    const r = await door('Mila', 'POST', p, body);
    assert.equal(r.status, 403, `POST ${p} as a visitor`);
    assert.match(r.body.error, /You are visiting this office: you can look, not change anything/);
  }
  assert.equal((await door('Mila', 'PATCH', '/settings', { radio: { stations: [{ id: 'mine', name: 'Mine', url: EVIL }] } })).status, 403, 'nor add a station');
  await sleep(150);
  assert.equal((await office())!.station.id, 'jazz', 'it plays on');
  assert.equal(mila.heard().length, told, 'and nobody was told anything new');
});

test('only the office’s saved stations can be played: an unknown address is refused', async () => {
  const told = [mila.heard().length, jovan.heard().length];
  for (const body of [{ url: EVIL }, { stationId: 'jazz', url: EVIL }, { stationId: 'news', url: JAZZ.url }, { stationId: 'nope' }, { stationId: 'nope', url: JAZZ.url }, { station: { id: 'x', name: 'X', url: EVIL } }, {}]) {
    const r = await door('Jovan', 'POST', '/radio/play', body);
    assert.equal(r.status, 404, `play ${JSON.stringify(body)}`);
    assert.match(r.body.error, /not in the office's list/);
  }
  // A colleague cannot put an address on the list either: the list is the owners'.
  assert.equal((await door('Jovan', 'PATCH', '/settings', { radio: { stations: [JAZZ, NEWS, { id: 'mine', name: 'Mine', url: EVIL }] } })).status, 403);
  await sleep(150);
  assert.equal((await office())!.station.id, 'jazz');
  assert.deepEqual([mila.heard().length, jovan.heard().length], told, 'nothing was sent to anyone');
  assert.ok(![...mila.got, ...jovan.got].some((m) => JSON.stringify(m).includes('evil.example')), 'no window was ever given the address');
  // A saved station may also be named by its address alone.
  assert.equal((await door('Jovan', 'POST', '/radio/play', { url: NEWS.url })).status, 200);
  await mila.hears('news');
  assert.equal((await door('Jovan', 'POST', '/radio/play', { stationId: 'jazz', url: JAZZ.url })).status, 200);
  await mila.hears('jazz');
});

test('someone who walks in later is told what is playing', async () => {
  vera = join('Vera');
  await vera.ready();
  assert.equal(vera.heard().length, 1);
  assert.deepEqual(vera.onAir(), await office());
  assert.equal(vera.onAir()!.station.url, JAZZ.url);
  // Also in a window opened on the office's own computer.
  const local = await h.client();
  const said = await waitFor(async () => local.messages.find((m): m is RadioMsg => m.t === 'radio'), { label: 'the local window is told' });
  assert.equal(said.radio?.station.id, 'jazz');
  local.close();
});

test('an owner switches to another station, and it follows the list of stations', async () => {
  assert.equal((await door('Vera', 'POST', '/radio/play', { stationId: 'news' })).status, 200);
  await Promise.all([mila.hears('news'), jovan.hears('news'), vera.hears('news')]);
  assert.deepEqual(mila.onAir()!.by, { id: ids.Vera, name: 'Vera' });
  assert.deepEqual(mila.onAir()!.station, NEWS);
  // The station's address is corrected by an owner: everyone is given the new one.
  const moved = { ...NEWS, url: 'https://radio.example/news-hq.aac' };
  await h.api('PATCH', '/settings', { radio: { stations: [JAZZ, moved] } });
  await waitFor(async () => mila.onAir()?.station.url === moved.url && jovan.onAir()?.station.url === moved.url, { label: 'the new address' });
  assert.deepEqual(mila.onAir()!.by, { id: ids.Vera, name: 'Vera' }, 'still switched on by the same person');
  // The station is taken off the list while it plays: the hi-fi stops for everyone.
  await h.api('PATCH', '/settings', { radio: { stations: [JAZZ] } });
  await Promise.all([mila.hears(null), jovan.hears(null), vera.hears(null)]);
  assert.equal(await office(), null);
  await h.api('PATCH', '/settings', { radio: { stations: [JAZZ, NEWS] } });
});

test('stop reaches everyone, and whoever walks in afterwards finds it off', async () => {
  // The root owner, at the office's own computer, switches it on.
  await h.api('POST', '/radio/play', { stationId: 'jazz' });
  await Promise.all([mila.hears('jazz'), jovan.hears('jazz'), vera.hears('jazz')]);
  assert.equal(mila.onAir()!.by.id, 'owner');
  assert.equal((await door('Jovan', 'POST', '/radio/stop', {})).status, 200);
  await Promise.all([mila.hears(null), jovan.hears(null), vera.hears(null)]);
  assert.equal(await office(), null);
  const told = mila.heard().length;
  assert.equal((await door('Jovan', 'POST', '/radio/stop', {})).status, 200, 'stopping what is off is not an error');
  await sleep(150);
  assert.equal(mila.heard().length, told, 'and tells nobody anything');
  const late = join('Mila');
  await late.ready();
  assert.equal(late.onAir(), null);
  late.ws.close();
});

test('the hi-fi does not survive a restart of the office: afterwards it is off', async () => {
  await h.api('POST', '/radio/play', { stationId: 'news' });
  assert.equal((await office())!.station.id, 'news');
  await h.restartServer();
  assert.equal(await office(), null);
  assert.equal((await h.state()).settings.radio.lastStationId, 'news', 'which station was last played is kept');
});
