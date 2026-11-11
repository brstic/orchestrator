import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REMOTE_DELAY, RemoteTrack } from '../src/remote-motion.ts';

/** Sample a track every 16 ms over a span and return the speeds between samples (m/s). */
function speeds(track: RemoteTrack, from: number, to: number): number[] {
  const out: number[] = [];
  let prev = track.sample(from)!;
  for (let t = from + 16; t <= to; t += 16) {
    const p = track.sample(t)!;
    out.push(Math.hypot(p.x - prev.x, p.z - prev.z) / 0.016);
    prev = p;
  }
  return out;
}

test('someone walking at a steady pace is drawn at a steady pace, however unevenly their reports arrive', () => {
  const track = new RemoteTrack();
  // 3.8 m/s along x, reported every 100 ms by the sender's clock; on the way here each report is held up by 20…180 ms.
  const delays = [40, 180, 20, 150, 90, 30, 170, 60, 110, 25, 160, 45, 130, 70, 20, 175, 95, 35, 140, 55];
  // (One connection: a report never overtakes the one before it.)
  const arrivals: Array<{ at: number; seen: number; x: number }> = [];
  delays.forEach((d, i) => arrivals.push({ at: 1_000_000 + i * 100, seen: Math.max(5000 + i * 100 + d, (arrivals[i - 1]?.seen ?? 0) + 1), x: 0.38 * i }));
  const all: number[] = [];
  let prev: { x: number; z: number } | null = null;
  let next = 0;
  for (let now = 5000; now <= 7300; now += 16) {
    while (next < arrivals.length && arrivals[next]!.seen <= now) {
      const r = arrivals[next++]!;
      track.push({ x: r.x, z: 0, rot: 0, moving: true, at: r.at }, r.seen);
    }
    const p = track.sample(now);
    if (p && prev && now > 5600 && now < 6900) all.push((p.x - prev.x) / 0.016);
    if (p) prev = p;
  }
  assert.ok(all.length > 50);
  const min = Math.min(...all);
  const max = Math.max(...all);
  // (Within a tenth either way: the clock that maps the sender's time onto ours is allowed to settle that fast.)
  assert.ok(min > 3.3 && max < 4.3, `speed stays near 3.8 m/s (was ${min.toFixed(2)}…${max.toFixed(2)})`);
});

test('without the sender\'s clock the arrival times are used, and the character still never jumps backwards', () => {
  const track = new RemoteTrack();
  for (let i = 0; i < 15; i++) track.push({ x: 0.3 * i, z: 0, rot: 0, moving: true }, 1000 + i * 100 + (i % 3) * 30);
  const v = speeds(track, 1500, 2300);
  // (Uneven, because the unevenness of the way here cannot be told from the walk — but always forward, never a leap.)
  assert.ok(v.every((s) => s >= 0 && s < 9), `forward only, no leaps (${Math.min(...v).toFixed(1)}…${Math.max(...v).toFixed(1)})`);
});

test('standing for a while and then setting off: no drifting during the wait', () => {
  const track = new RemoteTrack();
  track.push({ x: 1, z: 1, rot: 0, moving: false, at: 0 }, 100);
  // Five seconds later the first report of the walk, then the rest.
  for (let i = 1; i <= 6; i++) track.push({ x: 1 + 0.38 * i, z: 1, rot: 0, moving: true, at: 5000 + i * 100 }, 5100 + i * 100);
  for (const now of [600, 2000, 4000, 5050 + REMOTE_DELAY]) assert.deepEqual(track.sample(now), { x: 1, z: 1, rot: 0 }, `still standing at ${now}`);
  const mid = track.sample(5100 + 300 + REMOTE_DELAY)!;
  assert.ok(mid.x > 1.9 && mid.x < 2.3, `under way (${mid.x.toFixed(2)})`);
});

test('a long step between two reports of someone under way is walked evenly, not stood through and then leapt', () => {
  const track = new RemoteTrack();
  // The office passed on only every third report: 300 ms apart, all of them "moving".
  for (let i = 0; i < 8; i++) track.push({ x: 1.14 * i, z: 0, rot: 0, moving: true, at: i * 300 }, 40 + i * 300);
  const v = speeds(track, 700 + REMOTE_DELAY, 1700 + REMOTE_DELAY);
  assert.ok(Math.min(...v) > 3.4 && Math.max(...v) < 4.2, `3.8 m/s throughout (${Math.min(...v).toFixed(2)}…${Math.max(...v).toFixed(2)})`);
});

test('when the reports stop the character waits where it last was — it never runs ahead of what was reported', () => {
  const track = new RemoteTrack();
  for (let i = 0; i < 5; i++) track.push({ x: 0.4 * i, z: 0, rot: 0, moving: true, at: i * 100 }, 50 + i * 100);
  for (const later of [0, 100, 5000]) assert.equal(track.sample(450 + REMOTE_DELAY + later)!.x, 1.6);
  // …and goes on from there, forwards, when the next one comes.
  track.push({ x: 2.0, z: 0, rot: 0, moving: true, at: 500 }, 50 + 5800);
  const v = speeds(track, 5850, 6400);
  assert.ok(v.every((s) => s >= 0), 'never backwards');
});

test('a jump across the office is a jump, and a turn goes the short way round', () => {
  const track = new RemoteTrack();
  track.push({ x: 0, z: 0, rot: 3.0, at: 0 }, 10);
  track.push({ x: 0, z: 0, rot: -3.0, at: 100 }, 110);
  const half = track.sample(60 + REMOTE_DELAY)!.rot;
  assert.ok(Math.abs(half) > 3.0, `through ±π, not back through 0 (${half.toFixed(2)})`);
  track.push({ x: 40, z: 12, rot: 0, at: 200 }, 210);
  assert.deepEqual(track.sample(215), { x: 40, z: 12, rot: 0 }, 'put there at once');
  assert.equal(new RemoteTrack().sample(0), null);
});
