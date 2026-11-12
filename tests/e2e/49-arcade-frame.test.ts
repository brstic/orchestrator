/**
 * The arcade's console is a page the office's own page shows in a frame (docs/ARCADE.md, "The frame"). Three things
 * about how the office serves it are what make that work and keep it narrow: that one page may be framed (by the
 * office, by nobody else) while nothing else of the office may be; the app's built files can be read by a page that
 * is no origin, and nothing else can; and all of it passes the door as it is.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer } from '../../apps/server/src/server.ts';

// The door's certificate is made on this machine (a real office is behind a name with a trusted certificate).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
process.removeAllListeners('warning');

let server: RunningServer;
let tmp = '';
let doorUrl = '';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const head = async (base: string, p: string, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${p}`, { headers });
  await r.arrayBuffer();
  return { status: r.status, frame: r.headers.get('x-frame-options'), anyone: r.headers.get('access-control-allow-origin'), type: r.headers.get('content-type'), encoding: r.headers.get('content-encoding') };
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir().length > 40 ? '/tmp' : os.tmpdir(), 'orch-arcade-'));
  const ui = path.join(tmp, 'ui');
  fs.mkdirSync(path.join(ui, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>office</title>');
  fs.writeFileSync(path.join(ui, 'assets', 'arcade.html'), '<!doctype html><canvas></canvas>');
  fs.writeFileSync(path.join(ui, 'assets', 'arcade-frame-abc123.js'), 'export {};');
  fs.writeFileSync(path.join(ui, 'assets', 'genesis_plus_gx_libretro.wasm-abc123.gz'), Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0]));
  server = await startServer({ dataDir: path.join(tmp, 'server'), host: '127.0.0.1', port: 0, quiet: true, uiDir: ui });
  const port = await freePort();
  const opened = await fetch(`${server.url}/api/sharing`, { method: 'POST', headers: { authorization: `Bearer ${server.ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ open: true, port }) });
  assert.equal(opened.status, 200);
  doorUrl = `https://127.0.0.1:${port}`;
});
after(async () => {
  await server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the console page may be framed by the office itself and by nobody else; nothing else of the office may be framed at all', async () => {
  for (const base of [server.url, doorUrl]) {
    assert.deepEqual([(await head(base, '/assets/arcade.html')).status, (await head(base, '/assets/arcade.html')).frame], [200, 'SAMEORIGIN'], base);
    assert.equal((await head(base, '/assets/arcade.html?x=1')).frame, 'SAMEORIGIN', 'whatever is written after the name');
    for (const p of ['/', '/index.html', '/assets/arcade-frame-abc123.js', '/api/state', '/healthz']) assert.equal((await head(base, p)).frame, 'DENY', `${base}${p}`);
  }
});

test('a page that is no origin can read the app\'s built files, and nothing else of the office', async () => {
  // What a browser sends for a script module asked for by the sandboxed console.
  const asNobody = { origin: 'null' };
  for (const base of [server.url, doorUrl]) {
    for (const p of ['/assets/arcade-frame-abc123.js', '/assets/arcade.html', '/assets/genesis_plus_gx_libretro.wasm-abc123.gz']) {
      const r = await head(base, p, asNobody);
      assert.deepEqual([r.status, r.anyone], [200, '*'], `${base}${p}`);
    }
    for (const p of ['/', '/index.html', '/api/state', '/healthz']) assert.equal((await head(base, p, asNobody)).anyone, null, `${base}${p} is not readable from another origin`);
  }
});

test('the packed core is handed over as the bytes it is: nobody on the way unpacks it or says it is packed', async () => {
  for (const base of [server.url, doorUrl]) {
    const r = await head(base, '/assets/genesis_plus_gx_libretro.wasm-abc123.gz');
    assert.equal(r.status, 200);
    assert.equal(r.encoding, null, 'no content-encoding: the page unpacks it itself');
    const bytes = Buffer.from(await (await fetch(`${base}/assets/genesis_plus_gx_libretro.wasm-abc123.gz`)).arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b]);
  }
});
