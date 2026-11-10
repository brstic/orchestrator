import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Tmux, PaneStream, decodeControlOutput, inputToSendKeys, tmuxQuote } from '../src/index.ts';

const SOCK = `orch-test-${process.pid}`;
const tmux = new Tmux({ socketName: SOCK });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 5000, label = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(40);
  }
  throw new Error(`timed out waiting for ${label}`);
}

before(async () => {
  await tmux.exec(['kill-server']).catch(() => undefined);
});
after(async () => {
  await tmux.exec(['kill-server']).catch(() => undefined);
  const { rmSync } = await import('node:fs');
  rmSync(`${process.env.TMUX_TMPDIR ?? '/tmp'}/tmux-${process.getuid?.() ?? 0}/${SOCK}`, { force: true });
});

test('decodeControlOutput decodes octal escapes and leaves UTF-8 intact', () => {
  assert.equal(decodeControlOutput(Buffer.from('a\\015\\012b\\134c')).toString(), 'a\r\nb\\c');
  assert.equal(decodeControlOutput(Buffer.from('héllo \\033[1m')).toString(), 'héllo \x1b[1m');
});

test('inputToSendKeys splits ASCII bytes from non-ASCII literals', () => {
  assert.deepEqual(inputToSendKeys('%1', 'a\r'), ['send-keys -H -t %1 61 0d']);
  assert.deepEqual(inputToSendKeys('%1', 'é\x1b[A'), ["send-keys -l -t %1 -- 'é'", 'send-keys -H -t %1 1b 5b 41']);
  assert.equal(tmuxQuote("it's"), `'it'\\''s'`);
});

test('PaneStream streams output, takes consistent snapshots and injects input', async () => {
  const pane = await tmux.newSession({ name: 'stream', cwd: process.cwd(), cols: 90, rows: 24, argv: ['/bin/bash', '--norc', '--noprofile'], env: { PS1: '$ ' } });
  const stream = new PaneStream(tmux, 'stream', pane.paneId, { screenIntervalMs: 200 });
  let received = '';
  const seqs: number[] = [];
  stream.on('output', (seq, data) => {
    seqs.push(seq);
    received += data.toString('utf8');
  });
  const screens: string[] = [];
  stream.on('screen', (s) => screens.push(s.lines.join('\n')));
  await stream.open();
  assert.equal(stream.cols, 90);
  assert.equal(stream.rows, 24);

  await stream.input('echo marker-$((40+2))-ünï\r');
  await waitFor(() => received.includes('marker-42-ünï'), 5000, 'echo output');
  assert.ok(seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1), 'seq is gapless and ordered');

  const snap = await stream.snapshot();
  assert.equal(snap.cols, 90);
  assert.equal(snap.rows, 24);
  assert.equal(snap.seq, stream.seq);
  const text = snap.data.toString('utf8');
  assert.match(text, /marker-42-ünï/);
  assert.match(text, /\x1b\[\d+;\d+H/, 'snapshot restores the cursor position');

  await waitFor(() => screens.some((s) => s.includes('marker-42-ünï')), 5000, 'monitor screen capture');

  // Multi-line paste arrives as one bracketed paste and Enter submits it.
  await stream.paste('printf "%s\\n" pasted-ok', true);
  await waitFor(() => received.includes('pasted-ok\r\n'), 5000, 'paste output');

  await stream.resize(100, 30);
  await waitFor(() => stream.cols === 100 && stream.rows === 30, 5000, 'resize');

  // Closing our client must not disturb the session or its process.
  const pidBefore = pane.panePid;
  stream.close();
  await sleep(300);
  const still = (await tmux.listPanes()).find((p) => p.paneId === pane.paneId);
  assert.ok(still, 'session survives detaching');
  assert.equal(still!.panePid, pidBefore, 'same process is still running');
  assert.equal(still!.dead, false);
});

test('a second PaneStream sees state produced before it connected (reconnect without replacing the process)', async () => {
  const pane = (await tmux.listPanes()).find((p) => p.sessionName === 'stream')!;
  const stream = new PaneStream(tmux, 'stream', pane.paneId);
  await stream.open();
  const snap = await stream.snapshot();
  assert.match(snap.data.toString('utf8'), /pasted-ok/);
  let got = '';
  stream.on('output', (_s, d) => (got += d.toString()));
  await stream.input('echo again\r');
  await waitFor(() => got.includes('again'), 5000, 'output after reconnect');
  stream.close();
});

test('PaneStream reports closure when the tmux session ends', async () => {
  const pane = await tmux.newSession({ name: 'ending', cwd: process.cwd(), cols: 80, rows: 24, argv: ['/bin/cat'] });
  const stream = new PaneStream(tmux, 'ending', pane.paneId);
  let reason = '';
  stream.on('closed', (r) => (reason = r));
  await stream.open();
  await tmux.killSession('ending');
  await waitFor(() => reason !== '', 8000, 'closed event');
  assert.match(reason, /ended|reattach/);
});

test('dead panes are kept and reported (remain-on-exit)', async () => {
  const pane = await tmux.newSession({ name: 'dying', cwd: process.cwd(), cols: 80, rows: 24, argv: ['/bin/sh', '-c', 'echo bye; sleep 0.3; exit 7'] });
  await waitFor(async () => !!(await tmux.listPanes()).find((p) => p.paneId === pane.paneId && p.dead), 5000, 'pane death');
  const dead = (await tmux.listPanes()).find((p) => p.paneId === pane.paneId)!;
  assert.equal(dead.deadStatus, 7);
  // tmux scrolls the final output into history when it prints the death notice.
  assert.match(await tmux.capture(pane.paneId, { historyLines: 100 }), /bye/);
});

test('a snapshot taken while output is streaming loses nothing and duplicates nothing', async () => {
  const pane = await tmux.newSession({ name: 'busy', cwd: process.cwd(), cols: 80, rows: 24, argv: ['/bin/sh', '-c', 'i=0; while [ $i -lt 4000 ]; do echo "line-$i"; i=$((i+1)); done; echo END-OF-STREAM; sleep 30'] });
  const stream = new PaneStream(tmux, 'busy', pane.paneId);
  const chunks: Array<{ seq: number; text: string }> = [];
  stream.on('output', (seq, data) => chunks.push({ seq, text: data.toString('utf8') }));
  await stream.open();
  // Take several snapshots mid-stream, as a viewer joining at an arbitrary moment would.
  const snaps = [];
  for (let i = 0; i < 6; i++) {
    snaps.push(await stream.snapshot(20000));
    await sleep(15);
  }
  await waitFor(() => chunks.some((c) => c.text.includes('END-OF-STREAM')), 15000, 'end of stream');
  for (const snap of snaps) {
    // What a viewer ends up with: the snapshot plus every chunk after it.
    const after = chunks.filter((c) => c.seq > snap.seq).map((c) => c.text).join('');
    const combined = snap.data.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') + after;
    const seen = [...combined.matchAll(/line-(\d+)\b/g)].map((m) => Number(m[1]));
    const last = seen[seen.length - 1];
    assert.equal(last, 3999, 'the stream is complete');
    // From the first line the viewer has, every line appears exactly once, in order.
    for (let i = 1; i < seen.length; i++) assert.equal(seen[i], seen[i - 1]! + 1, `gap or duplicate after line-${seen[i - 1]} (snapshot seq ${snap.seq})`);
  }
  stream.close();
});
