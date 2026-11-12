/**
 * What people do with their characters among each other: gestures, the whip (at each other, and — where the owners
 * switched it on — as an approval), and talking: a voice is passed on to those near the speaker's character, and
 * a meeting room keeps what is said in it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import type { ServerToClient } from '@orchestrator/contracts';
import { createHarness, waitFor, sleep, type Harness } from './harness.ts';

// The door's certificate is made on this machine (the tests reach it by its port, not through a domain).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.removeAllListeners('warning');

let h: Harness;
let doorUrl = '';
let projectId = '';
const tokens: Record<string, string> = {};

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const decode = (code: string) => JSON.parse(Buffer.from(code.replace(/^orch-invite-v1\./, ''), 'base64url').toString('utf8'));

/** A person's window: the client WebSocket through the door, with what it was sent. */
async function join(who: string) {
  const ws = new WebSocket(`${doorUrl.replace('https', 'wss')}/ws/client`, ['orch.v1', `orch.token.${tokens[who]}`]);
  const got: ServerToClient[] = [];
  ws.onmessage = (ev) => got.push(JSON.parse(String(ev.data)));
  ws.onerror = () => undefined;
  const until = <T extends ServerToClient['t']>(t: T, pred: (m: Extract<ServerToClient, { t: T }>) => boolean = () => true) => waitFor(async () => got.find((m) => m.t === t && pred(m as any)) as Extract<ServerToClient, { t: T }> | undefined, { label: `a ${t} message for ${who}` });
  const ready = await until('ready');
  const person = {
    who,
    id: ready.clientId,
    ws,
    got,
    until,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    /** Stand somewhere, and wait until the office has it. */
    stand: async (x: number, z: number) => {
      ws.send(JSON.stringify({ t: 'presence', x, z, rot: 0, moving: false }));
      await waitFor(async () => got.some((m) => m.t === 'people' && m.people.some((p) => p.id === ready.clientId && Math.abs(p.x - x) < 1e-6 && Math.abs(p.z - z) < 1e-6)) || undefined, { label: `${who} at ${x}, ${z}` }).catch(() => undefined);
    },
    /** What arrived since a moment in time (an index into `got`). */
    since: (n: number) => got.slice(n),
  };
  return person;
}
const frame = (n = 512) => Buffer.alloc(n, 0x7f).toString('base64');
const voices = (list: ServerToClient[], from: string) => list.filter((m) => m.t === 'voice' && m.from === from).length;

before(async () => {
  h = await createHarness();
  const repo = h.makeRepo('shop');
  projectId = (await h.project('Shop', repo)).id;
  const port = await freePort();
  await h.api('POST', '/sharing', { open: true, port });
  doorUrl = `https://127.0.0.1:${port}`;
  for (const [name, role] of [['Jovan', 'colleague'], ['Ana', 'colleague'], ['Mila', 'visitor']] as const) tokens[name] = decode((await h.api<any>('POST', '/guests', { name, role })).invite).t;
});
after(async () => {
  await h.cleanup();
});

test('a gesture is seen by everyone in the office, and only a gesture the characters know', async () => {
  const [ana, jovan, mila] = await Promise.all([join('Ana'), join('Jovan'), join('Mila')]);
  ana.send({ t: 'emote', name: 'wave' });
  for (const p of [ana, jovan, mila]) {
    const m = await p.until('emoted', (x) => x.name === 'wave');
    assert.deepEqual([m.from.id, m.from.name, m.from.role], [ana.id, 'Ana', 'colleague']);
  }
  // A visitor can wave too: it is between people, not work.
  await sleep(450);
  mila.send({ t: 'emote', name: 'dance' });
  assert.equal((await jovan.until('emoted', (x) => x.name === 'dance')).from.name, 'Mila');
  // Not something else, and not faster than a person can pick one.
  const seen = jovan.got.length;
  for (const name of ['explode', '', 12, null, 'constructor']) ana.send({ t: 'emote', name });
  await sleep(450);
  ana.send({ t: 'emote', name: 'bow' });
  ana.send({ t: 'emote', name: 'clap' });
  await jovan.until('emoted', (x) => x.name === 'bow');
  await sleep(300);
  assert.deepEqual(jovan.since(seen).filter((m) => m.t === 'emoted').map((m: any) => m.name), ['bow'], 'the second one came too soon after the first');
  for (const p of [ana, jovan, mila]) p.ws.close();
});

test('sitting down and jumping are seen by everyone: where somebody sits, and each jump once', async () => {
  const [ana, jovan, mila] = await Promise.all([join('Ana'), join('Jovan'), join('Mila')]);
  await ana.stand(3, 4);
  await jovan.stand(5, 4);
  await mila.stand(8, 4);
  const of = (p: Awaited<ReturnType<typeof join>>, id: string) => (p.got.filter((m) => m.t === 'people').pop() as Extract<ServerToClient, { t: 'people' }> | undefined)?.people.find((x) => x.id === id);
  // Ana sits down on a sofa: the others are told that she sits, and where.
  ana.send({ t: 'presence', x: 6.5, z: 4.45, rot: Math.PI, moving: false, sit: true });
  for (const p of [jovan, mila]) await waitFor(() => of(p, ana.id)?.sit === true || undefined, { label: `${p.who} sees Ana sit` });
  assert.deepEqual([of(jovan, ana.id)!.x, of(jovan, ana.id)!.z, of(jovan, ana.id)!.sit], [6.5, 4.45, true]);
  assert.equal(of(mila, jovan.id)?.sit, undefined, 'somebody on their feet is not said to sit');
  // She gets up: sitting is said only while it is so, and only `true` means it.
  ana.send({ t: 'presence', x: 6.5, z: 3.7, rot: Math.PI, moving: false, sit: 'yes' });
  await waitFor(() => (of(jovan, ana.id)?.z === 3.7 && of(jovan, ana.id)?.sit === undefined) || undefined, { label: 'Ana is up' });
  // A jump: everyone sees it, a visitor's too, each once — and not more often than somebody can land.
  const seen = jovan.got.length;
  ana.send({ t: 'jump' });
  for (const p of [ana, jovan, mila]) assert.equal((await p.until('jumped', (m) => m.from === ana.id)).from, ana.id);
  ana.send({ t: 'jump' });
  ana.send({ t: 'jump' });
  await sleep(450);
  mila.send({ t: 'jump' });
  await jovan.until('jumped', (m) => m.from === mila.id);
  // (Somebody who is not in the room as a character — a window that never said where it is — has nothing to jump with.)
  assert.deepEqual(jovan.since(seen).filter((m) => m.t === 'jumped').map((m: any) => m.from), [ana.id, mila.id], 'the two that came while she was in the air were not passed on');
  for (const p of [ana, jovan, mila]) p.ws.close();
});

test('people crack the whip at each other: only at someone standing next to them, and nobody at themselves', async () => {
  const [ana, jovan, mila] = await Promise.all([join('Ana'), join('Jovan'), join('Mila')]);
  await ana.stand(-10, 2);
  await jovan.stand(-9, 3);
  await mila.stand(15, 10);
  ana.send({ t: 'whip', personId: jovan.id });
  for (const p of [ana, jovan, mila]) {
    const m = await p.until('whipped', (x) => x.personId === jovan.id);
    assert.deepEqual([m.from.name, m.employeeId ?? null, m.approved ?? null], ['Ana', null, null]);
  }
  // In the chat, as what it is.
  const late = await join('Mila');
  assert.ok((await late.until('chat.history')).lines.some((l) => l.emote && l.text === 'cracks the whip at Jovan' && l.from.name === 'Ana'));
  late.ws.close();
  // Too far, oneself, nobody: nothing happens.
  await sleep(700);
  const seen = mila.got.length;
  ana.send({ t: 'whip', personId: mila.id });
  ana.send({ t: 'whip', personId: ana.id });
  ana.send({ t: 'whip', personId: 'no-such-window' });
  ana.send({ t: 'whip' });
  await sleep(500);
  assert.equal(mila.since(seen).filter((m) => m.t === 'whipped').length, 0);
  // A visitor may too (a gag), next to someone.
  await mila.stand(-9.5, 2.5);
  mila.send({ t: 'whip', personId: ana.id });
  assert.equal((await ana.until('whipped', (x) => x.personId === ana.id)).from.name, 'Mila');
  for (const p of [ana, jovan, mila]) p.ws.close();
});

test('a voice is passed on to those near the speaker, and to nobody else — and never back to the speaker', async () => {
  const [ana, jovan, mila] = await Promise.all([join('Ana'), join('Jovan'), join('Mila')]);
  await ana.stand(-10, 2);
  await jovan.stand(-6, 2); // four metres from Ana
  await mila.stand(21, 13); // the far end of the office
  let n = { a: ana.got.length, j: jovan.got.length, m: mila.got.length };
  for (let i = 0; i < 5; i++) ana.send({ t: 'voice', seq: i, data: frame() });
  await waitFor(() => voices(jovan.since(n.j), ana.id) === 5 || undefined, { label: 'Jovan hears Ana' });
  const heard = jovan.since(n.j).filter((m) => m.t === 'voice') as Array<Extract<ServerToClient, { t: 'voice' }>>;
  assert.deepEqual(heard.map((m) => m.seq), [0, 1, 2, 3, 4], 'in order, as sent');
  assert.equal(heard[0]!.data, frame(), 'the sound itself, untouched');
  await sleep(250);
  assert.equal(voices(mila.since(n.m), ana.id), 0, 'Mila is too far away to hear');
  assert.equal(voices(ana.since(n.a), ana.id), 0, 'nobody hears themselves through the office');
  // A visitor talks too, and is heard by whoever is near her.
  await mila.stand(-8, 3);
  n = { a: ana.got.length, j: jovan.got.length, m: mila.got.length };
  mila.send({ t: 'voice', seq: 0, data: frame() });
  await waitFor(() => (voices(ana.since(n.a), mila.id) === 1 && voices(jovan.since(n.j), mila.id) === 1) || undefined, { label: 'a visitor is heard' });
  // Letting go of the key is told to everyone: whoever heard them shows that they stopped.
  ana.send({ t: 'voice', seq: 9, data: frame() });
  ana.send({ t: 'voice.end' });
  assert.equal((await mila.until('voice.end', (x) => x.from === ana.id)).from, ana.id);
  // Someone who has not said where they stand is neither heard nor hears.
  const ghost = await join('Jovan');
  n = { a: ana.got.length, j: jovan.got.length, m: mila.got.length };
  const g = ghost.got.length;
  ghost.send({ t: 'voice', seq: 0, data: frame() });
  ana.send({ t: 'voice', seq: 20, data: frame() });
  await waitFor(() => voices(jovan.since(n.j), ana.id) === 1 || undefined, { label: 'the others still hear Ana' });
  await sleep(250);
  assert.equal(voices(ana.since(n.a), ghost.id) + voices(ghost.since(g), ana.id), 0);
  // What is not a frame of sound is not passed on; and a window cannot flood the office.
  n = { a: ana.got.length, j: jovan.got.length, m: mila.got.length };
  for (const data of ['', 'not base64!', frame(4000), 12, null, { x: 1 }]) ana.send({ t: 'voice', seq: 1, data });
  await sleep(1100); // into a new second of the limit
  for (let i = 0; i < 120; i++) ana.send({ t: 'voice', seq: 100 + i, data: frame(64) });
  await sleep(600);
  const passed = voices(jovan.since(n.j), ana.id);
  assert.ok(passed >= 20 && passed <= 46, `${passed} of 120 frames in one second were passed on`);
  assert.ok(!(jovan.since(n.j) as any[]).some((m) => m.t === 'voice' && m.seq === 1), 'nothing that was not a frame');
  for (const p of [ana, jovan, mila, ghost]) p.ws.close();
});

test('the meeting room keeps what is said in it: heard inside, not outside — and what is said outside does not come in', async () => {
  const meeting = (await h.state()).layout.rooms.find((r) => r.kind === 'meeting')!;
  const inside = { x: meeting.x + meeting.w / 2, z: meeting.z + meeting.d / 2 };
  const alsoInside = { x: meeting.x + 1.5, z: meeting.z + 1.5 };
  const atTheDoor = { x: inside.x, z: meeting.z + meeting.d + 0.8 }; // in the hall, a step from the room's wall
  const [ana, jovan, mila] = await Promise.all([join('Ana'), join('Jovan'), join('Mila')]);
  await ana.stand(inside.x, inside.z);
  await jovan.stand(alsoInside.x, alsoInside.z);
  await mila.stand(atTheDoor.x, atTheDoor.z);
  assert.ok(Math.hypot(inside.x - atTheDoor.x, inside.z - atTheDoor.z) < 7, 'Mila stands a few metres from Ana, on the other side of the wall');
  let n = { a: ana.got.length, j: jovan.got.length, m: mila.got.length };
  for (let i = 0; i < 3; i++) ana.send({ t: 'voice', seq: i, data: frame() });
  await waitFor(() => voices(jovan.since(n.j), ana.id) === 3 || undefined, { label: 'heard in the room' });
  await sleep(300);
  assert.equal(voices(mila.since(n.m), ana.id), 0, 'not a frame of the meeting reached the hall');
  // And the other way: what is said in the hall is not heard in the meeting.
  n = { a: ana.got.length, j: jovan.got.length, m: mila.got.length };
  mila.send({ t: 'voice', seq: 0, data: frame() });
  await sleep(400);
  assert.equal(voices(ana.since(n.a), mila.id) + voices(jovan.since(n.j), mila.id), 0);
  // She walks in: now she hears them, and they hear her.
  await mila.stand(inside.x + 1, inside.z);
  n = { a: ana.got.length, j: jovan.got.length, m: mila.got.length };
  ana.send({ t: 'voice', seq: 5, data: frame() });
  mila.send({ t: 'voice', seq: 6, data: frame() });
  await waitFor(() => (voices(mila.since(n.m), ana.id) === 1 && voices(jovan.since(n.j), mila.id) === 1 && voices(ana.since(n.a), mila.id) === 1) || undefined, { label: 'everyone in the room hears everyone in it' });
  // Jovan walks out: he no longer hears the meeting.
  await jovan.stand(atTheDoor.x, atTheDoor.z);
  n = { a: ana.got.length, j: jovan.got.length, m: mila.got.length };
  ana.send({ t: 'voice', seq: 7, data: frame() });
  await waitFor(() => voices(mila.since(n.m), ana.id) === 1 || undefined, { label: 'still heard inside' });
  await sleep(300);
  assert.equal(voices(jovan.since(n.j), ana.id), 0);
  for (const p of [ana, jovan, mila]) p.ws.close();
});

test('the whip is for show — unless the owners switch it on: then it approves what an employee waits for permission to do, for whoever may decide it', async () => {
  const dana = await h.employee('Dana', 'devops', { projectId });
  const task = await h.task({ projectId, title: 'Edit pipeline', assigneeId: dana.id, kind: 'ops', verifyCommand: 'true', description: '@@fake: write ci.txt pipeline; write more.txt second; say after-permissions@@' });
  const q1 = await waitFor(() => h.openQuestion(dana.id, 'permission'), { label: 'a permission request' });
  const wt = (await h.getTask(task.id)).worktree!;
  const [ana, mila] = await Promise.all([join('Ana'), join('Mila')]);

  // As the office comes: a gag. Nothing is approved, by anyone.
  assert.notEqual((await h.state()).settings.whipApproves, true);
  ana.send({ t: 'whip', employeeId: dana.id });
  const gag = await mila.until('whipped', (x) => x.employeeId === dana.id);
  assert.equal(gag.approved, undefined);
  await sleep(500);
  assert.equal((await h.state()).questions.find((x) => x.id === q1.id)!.status, 'open');
  assert.ok(!fs.existsSync(path.join(wt, 'ci.txt')), 'nothing is written');

  // An owner switches it on (a colleague cannot).
  assert.equal((await fetch(`${doorUrl}/api/settings`, { method: 'PATCH', headers: { authorization: `Bearer ${tokens.Ana}`, 'content-type': 'application/json' }, body: JSON.stringify({ whipApproves: true }) })).status, 403);
  await h.api('PATCH', '/settings', { whipApproves: true });

  // A visitor's whip is still only a whip: they may not decide a request.
  await sleep(700);
  let seen = ana.got.length;
  mila.send({ t: 'whip', employeeId: dana.id });
  await waitFor(() => ana.since(seen).find((m) => m.t === 'whipped') || undefined, { label: 'the visitor\'s crack' });
  assert.equal((ana.since(seen).find((m) => m.t === 'whipped') as any).approved, undefined);
  await sleep(400);
  assert.equal((await h.state()).questions.find((x) => x.id === q1.id)!.status, 'open');

  // A colleague's approves it: the employee goes on, and the record says who decided.
  await sleep(400);
  seen = mila.got.length;
  ana.send({ t: 'whip', employeeId: dana.id });
  const crack = await waitFor(() => mila.since(seen).find((m) => m.t === 'whipped') as any, { label: 'the colleague\'s crack' });
  assert.deepEqual([crack.from.name, crack.employeeId, crack.approved], ['Ana', dana.id, 1]);
  await waitFor(() => fs.existsSync(path.join(wt, 'ci.txt')), { label: 'the approved write happened', timeout: 20000 });
  const decided = (await h.state()).questions.find((x) => x.id === q1.id)!;
  assert.equal(decided.decision, 'allow');
  const audit = await h.api<any[]>('GET', '/audit');
  assert.ok(audit.some((a) => a.action === 'approval.decide' && a.actor === 'member:Ana' && a.target === q1.id), 'on the record as Ana\'s decision');
  assert.ok((await join('Mila').then(async (late) => ((await late.until('chat.history')).lines.some((l) => /cracks the whip at Dana — and approves what was asked/.test(l.text)) ? (late.ws.close(), true) : (late.ws.close(), false)))), 'the chat says what the crack did');

  // The next request waits like any other: one crack approves what is open then, not what comes after.
  const q2 = await waitFor(async () => {
    const q = await h.openQuestion(dana.id, 'permission');
    return q && q.id !== q1.id ? q : undefined;
  }, { label: 'the second permission request' });
  assert.equal(q2.status, 'open');
  assert.ok(!fs.existsSync(path.join(wt, 'more.txt')));
  // With nothing to approve, a crack is a crack.
  await h.api('POST', `/questions/${q2.id}/answer`, { decision: 'deny', answer: 'Not that one.' });
  await sleep(700);
  seen = mila.got.length;
  ana.send({ t: 'whip', employeeId: dana.id });
  assert.equal(((await waitFor(() => mila.since(seen).find((m) => m.t === 'whipped') as any, { label: 'a plain crack' })) as any).approved, undefined);
  await h.api('PATCH', '/settings', { whipApproves: false });
  for (const p of [ana, mila]) p.ws.close();
});
