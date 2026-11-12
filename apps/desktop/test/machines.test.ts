import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aboutLine, cpuMeter, elapsedWords, kindOf, memoryMeter, missingOn, onlineLine, stateOf, systemLine } from '../src/lib/machines.ts';

/** The words and numbers of the Machines window (docs/UI.md): one line per machine has to say enough. */
const GB = 1024 ** 3;
const info = { platform: 'darwin', arch: 'arm64', cpus: 10, totalMemBytes: 16 * GB, hostname: 'mac', user: 'dev', agentVersion: '0.1.0', tmuxVersion: '3.8', claudeVersion: '2.1.0' } as any;
const ago = (iso: string) => `<${iso}>`;

test('what a machine is: its system in words a person uses, and nothing for one that never reported', () => {
  assert.equal(systemLine(info), 'macOS · arm64 · 10 cores · 16 GB');
  assert.equal(systemLine({ ...info, platform: 'linux', arch: 'x64', cpus: 1, totalMemBytes: 3.5 * GB }), 'Linux · x64 · 1 core · 3.5 GB');
  assert.equal(systemLine({ ...info, platform: 'plan9' }), 'plan9 · arm64 · 10 cores · 16 GB');
  assert.equal(systemLine(null), null);
  assert.equal(systemLine({ ...info, platform: '' }), null);
});

test('whose a machine is and how it came in is one phrase', () => {
  assert.equal(kindOf({ local: true }), "The office's own machine");
  assert.equal(kindOf({ local: false, memberId: 'm', memberName: 'Mila' }), "Mila's computer");
  assert.equal(kindOf({ local: false, memberId: 'm', memberName: 'Mila', ownerName: 'Mila' }), "Mila's server");
  assert.equal(kindOf({ local: false, memberId: null, ownerName: 'Mila' }), "Mila's server, shared with the office");
  assert.equal(kindOf({ local: false }, { target: 'deploy@box', status: 'connected' }), 'Over SSH · deploy@box');
  assert.equal(kindOf({ local: false }), 'Joined with a token');
  // The office's own machine is that, however else it is reached.
  assert.equal(kindOf({ local: true }, { target: 'x', status: 'connected' }), "The office's own machine");
});

test('how a machine is: nothing to add while it is online, and why not otherwise', () => {
  assert.equal(stateOf({ status: 'online', lastSeenAt: 't' }, null, ago), null);
  assert.equal(stateOf({ status: 'offline', lastSeenAt: 't' }, null, ago), 'offline, last seen <t>');
  assert.equal(stateOf({ status: 'offline', lastSeenAt: null }, null, ago), 'has never connected');
  assert.equal(stateOf({ status: 'revoked', lastSeenAt: 't' }, null, ago), 'revoked');
  // A linked server says what the link is doing, which is more than "offline".
  assert.equal(stateOf({ status: 'offline', lastSeenAt: 't' }, { target: 'x', status: 'idle' }, ago), 'disconnected');
  assert.equal(stateOf({ status: 'offline', lastSeenAt: 't' }, { target: 'x', status: 'connecting', step: 'copying the agent' }, ago), 'connecting — copying the agent');
  assert.equal(stateOf({ status: 'online', lastSeenAt: 't' }, { target: 'x', status: 'reconnecting' }, ago), 'reconnecting');
  assert.equal(stateOf({ status: 'offline', lastSeenAt: 't' }, { target: 'x', status: 'error' }, ago), 'offline, last seen <t>');
  assert.equal(stateOf({ status: 'online', lastSeenAt: 't' }, { target: 'x', status: 'connected' }, ago), null);
});

test('the line under a machine’s name says each thing once', () => {
  const base = { name: 'dev-mac', status: 'online', lastSeenAt: 't', local: true } as any;
  assert.equal(aboutLine(base, null, 9, ago), "The office's own machine · 9 employees");
  assert.equal(aboutLine(base, null, 1, ago), "The office's own machine · 1 employee");
  assert.equal(aboutLine(base, null, 0, ago), "The office's own machine · nobody works here yet");
  // Named for what it is: said once.
  assert.equal(aboutLine({ name: "Mila's computer", status: 'online', lastSeenAt: 't', local: false, memberId: 'm', memberName: 'Mila' }, null, 2, ago), '2 employees');
  assert.equal(aboutLine({ name: "mila's Computer ", status: 'offline', lastSeenAt: 't', local: false, memberId: 'm', memberName: 'Mila' }, null, 2, ago), 'offline, last seen <t>');
  // Offline: who works there is beside the point; why it is not there is the point.
  assert.equal(aboutLine({ ...base, status: 'offline' }, null, 9, ago), "The office's own machine · offline, last seen <t>");
  assert.equal(aboutLine({ name: 'Production', status: 'offline', lastSeenAt: null, local: false }, { target: 'deploy@box', status: 'connecting', step: 'copying the agent' }, 0, ago), 'Over SSH · deploy@box · connecting — copying the agent');
});

test('how long something has run, from what ps says', () => {
  assert.equal(elapsedWords('02-06:51:58'), '2 d 6 h');
  assert.equal(elapsedWords('03:12:09'), '3 h 12 min');
  assert.equal(elapsedWords('12:09'), '12 min 9 s');
  assert.equal(elapsedWords('00:45'), '45 s');
  assert.equal(elapsedWords('1-00:00:05'), '1 d');
  assert.equal(elapsedWords('00:00'), '0 s');
  assert.equal(elapsedWords(' 05:00 '), '5 min');
  assert.equal(elapsedWords('a while'), 'a while');
});

test('the two measurements: a number, a bar, and a colour only when it is worth a look', () => {
  const r = (cpuPercent: number | null, used: number | null, total: number | null = 16 * GB) => ({ ts: 't', cpuPercent, loadAvg1: null, memUsedBytes: used, memTotalBytes: total, sessionCount: 0, processes: [] }) as any;
  assert.deepEqual(cpuMeter(r(29.6, null)), { percent: 29.6, value: '30%', tone: 'calm' });
  assert.equal(cpuMeter(r(71, null))!.tone, 'warn');
  assert.equal(cpuMeter(r(95, null))!.tone, 'bad');
  assert.deepEqual(cpuMeter(r(180, null)), { percent: 100, value: '100%', tone: 'bad' });
  assert.equal(cpuMeter(r(null, null)), null);
  assert.equal(cpuMeter(null), null);
  assert.deepEqual(memoryMeter(r(null, 4 * GB)), { percent: 25, value: '4 / 16 GB', tone: 'calm' });
  // A healthy machine keeps most of its memory in use: that is no reason for a colour.
  assert.equal(memoryMeter(r(null, 13 * GB))!.tone, 'calm');
  assert.equal(memoryMeter(r(null, 14.8 * GB))!.tone, 'warn');
  assert.equal(memoryMeter(r(null, 15.6 * GB))!.tone, 'bad');
  assert.equal(memoryMeter(r(null, 1.5 * GB, 2 * GB))!.value, '1.5 / 2 GB');
  assert.equal(memoryMeter(r(null, null)), null);
  assert.equal(memoryMeter(r(null, 1, 0)), null);
});

test('what a machine lacks is said only once it has reported', () => {
  assert.deepEqual(missingOn(info), []);
  assert.deepEqual(missingOn({ ...info, claudeVersion: null }), ['Claude Code was not found on this machine']);
  assert.deepEqual(missingOn({ ...info, claudeVersion: null, tmuxVersion: null }).length, 2);
  assert.deepEqual(missingOn(null), []);
});

test('the window’s one line about all of them', () => {
  const h = (...s: string[]) => s.map((status) => ({ status })) as any;
  assert.equal(onlineLine(h('online', 'online')), '2 online');
  assert.equal(onlineLine(h('online', 'offline', 'offline')), '1 of 3 online');
  assert.equal(onlineLine(h('online', 'revoked')), '1 online');
  assert.equal(onlineLine(h('offline')), 'It is offline');
  assert.equal(onlineLine(h('offline', 'offline')), 'None is online');
  assert.equal(onlineLine(h('revoked')), 'None yet');
  assert.equal(onlineLine([]), 'None yet');
});
