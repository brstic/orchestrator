// Two players on two computers, for real: one game, its host in a window on this computer, the second player in a
// browser on another computer, both in the same office. What `docs/ARCADE.md` says was measured was measured with this.
//
//   1. An office the two can reach. For a trial that touches nobody's office, start one on the other computer:
//        bin/orchestrator-server --port 4731 --data /tmp/arcade-trial/data --ui <a built UI>
//      and a browser there that can be driven from outside:
//        google-chrome --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/arcade-trial/chrome \
//          --mute-audio --autoplay-policy=no-user-gesture-required --window-size=1100,760 --enable-unsafe-swiftshader about:blank
//   2. From this computer, a way to both (nothing is opened on the other computer's firewall):
//        ssh -N -L 14731:127.0.0.1:4731 -L 19333:127.0.0.1:9333 user@other
//   3. The host's window here, drivable from outside on port 9444:
//        apps/desktop/node_modules/.bin/electron tests/arcade/host-window.cjs "http://127.0.0.1:14731/?token=<that office's owner token>"
//   4. node tests/arcade/two-computers.mjs "http://127.0.0.1:14731/?token=…" "http://127.0.0.1:4731/?token=…" 9444 19333
//
// It brings the test cartridge (tests/fixtures/md-test-rom.mjs) to that office's shelf, plays it, has the other
// browser join, checks both players' buttons at the host's console and in the guest's picture, measures how long the
// guest waits to see what its own key did, counts pictures and sound, and takes the cartridge off the shelf again.
// Stop the trial office and browser afterwards and delete their folder.
import fs from 'node:fs';
import { buildTestRom, padsOf } from '../fixtures/md-test-rom.mjs';

const [hostUrl, guestUrl, hostPort, guestPort] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Tab {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.waiting = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.waiting.has(m.id)) {
        const { resolve, reject } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result);
      }
    };
  }
  static async open(port, pick) {
    for (let i = 0; i < 80; i++) {
      const list = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).catch(() => []);
      const t = list.find(pick);
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://127.0.0.1:${port}`));
        await new Promise((res, rej) => {
          ws.onopen = res;
          ws.onerror = () => rej(new Error('cdp socket'));
        });
        return new Tab(ws);
      }
      await sleep(250);
    }
    throw new Error(`no such tab on ${port}`);
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async js(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async until(expression, timeout = 30000, what = expression) {
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(150)) {
      const v = await this.js(`(() => { try { return (${expression}); } catch (e) { return null; } })()`).catch(() => null);
      if (v) return v;
    }
    throw new Error(`timed out waiting for ${String(what).slice(0, 160)}`);
  }
  key(type, code) {
    const letter = code.replace(/^Key/, '').toLowerCase();
    const vk = code === 'Enter' ? 13 : code.startsWith('Key') ? code.charCodeAt(3) : 0;
    return this.send('Input.dispatchKeyEvent', { type: type === 'down' ? 'rawKeyDown' : 'keyUp', code, key: code === 'Enter' ? 'Enter' : letter, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }
}

const names = (h) => (h.running ? ['p1', 'p2'].map((p) => `${p}:${['a', 'b', 'c', 'start'].filter((k) => h[p][k]).join('+')}`).join(' ') : 'not running');
const out = { steps: [] };
const say = (line) => {
  out.steps.push(line);
  console.log(line);
};

// ── the guest's browser, on the other computer ──
const guest = await Tab.open(guestPort, (t) => t.type === 'page');
await guest.send('Page.enable');
await guest.send('Page.navigate', { url: guestUrl });
// ── the host's window, on this one ──
const host = await Tab.open(hostPort, (t) => t.type === 'page' && t.url.startsWith(hostUrl.split('?')[0]));

await host.until(`window.__office && window.__office.getState().ready`, 60000, 'the office in the host window');
await guest.until(`window.__office && window.__office.getState().ready`, 120000, 'the office in the guest browser');
const where = async (tab) => tab.js(`JSON.stringify({ host: location.host, agent: navigator.userAgent.replace(/^.*?\\((.*?)\\).*$/, '$1'), cores: navigator.hardwareConcurrency, webcodecs: typeof VideoDecoder === 'function' })`);
// The guest's computer here is a server without a graphics card: drawing the 3D office in software takes its page
// a second a frame, and nothing else on the page gets a turn. The drawing of the 3D scene is switched off there
// (the page, the arcade window and everything about the game are as they are).
await guest.until(`!!(window.__orchScene && window.__orchScene.three && window.__orchScene.three.gl)`, 120000, 'the 3D scene in the guest browser');
const renderer = await guest.js(`(() => { try { const gl = window.__orchScene.three.gl.getContext(); const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; } catch (e) { return String(e); } })()`);
if (/SwiftShader|llvmpipe|Software/i.test(renderer)) {
  await guest.js(`(() => { window.__orchScene.three.gl.render = () => {}; return true; })()`);
  say(`guest has no graphics card (${renderer.slice(0, 60)}…): the 3D office is not drawn there`);
}
say(`host window:  ${await where(host)}`);
say(`guest window: ${await where(guest)}`);

// The host brings the test cartridge to the office and starts it.
await host.js(`window.__office.getState().openPanel('arcade')`);
await host.until(`!!document.querySelector('[data-arcade-add]')`);
await host.js(`(() => { const b = Uint8Array.from(atob(${JSON.stringify(buildTestRom().toString('base64'))}), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([b], 'Pad Test (World).md')); const i = document.querySelector('[data-arcade-add]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
await host.until(`!!document.querySelector('[data-arcade-game="Orchestrator Pad Test"]')`, 30000, 'the game on the shelf');
await host.js(`document.querySelector('[data-arcade-game="Orchestrator Pad Test"] [data-arcade-play]').click()`);
await host.until(`document.querySelector('[data-arcade-play-view]')?.dataset.arcadePhase === 'running'`, 60000, 'the game running at the host');
// (Before the build in which a game is open from its start, the host opens it.)
if (!(await host.until(`document.querySelector('[data-arcade-play-view]').dataset.arcadeOpen === 'true'`, 4000).catch(() => false))) {
  await host.js(`document.querySelector('[data-arcade-invite]').click()`);
  await host.until(`document.querySelector('[data-arcade-play-view]').dataset.arcadeOpen === 'true'`, 8000, 'the game open to the office');
  say('the host pressed "Play together"');
} else say('the game was open to the office from its start');

// The guest, on the other computer, finds the game on the shelf (it never had the file) and joins.
await guest.js(`window.__office.getState().openPanel('arcade')`);
await guest.until(`!!document.querySelector('[data-arcade-game="Orchestrator Pad Test"]') && !!document.querySelector('[data-arcade-table] [data-arcade-join]')`, 30000, 'the shelf and the game to join, at the guest');
say(`guest sees: "${await guest.js(`document.querySelector('[data-arcade-table]').textContent.replace(/\\s+/g, ' ').trim()`)}"`);
await guest.js(`document.querySelector('[data-arcade-table] [data-arcade-join]').click()`);
await guest.until(`document.querySelector('[data-arcade-remote]')?.dataset.arcadeRemoteAs === 'player' && Number(document.querySelector('[data-arcade-remote]').dataset.shownV) > 10`, 40000, 'the picture at the guest, with the second pad in hand');

const far = async () => {
  const [r, g, b] = await guest.js(`[...document.querySelector('[data-arcade-far]').getContext('2d').getImageData(320, 240, 1, 1).data]`);
  return names(padsOf(r, g, b));
};
const farShows = async (want, what) => {
  let got = '';
  for (const end = Date.now() + 10000; Date.now() < end; await sleep(100)) if ((got = await far()) === want) return;
  throw new Error(`${what}: the guest is shown "${got}", expected "${want}"`);
};
// What the host's own console draws: read inside its frame.
const frame = await Tab.open(hostPort, (t) => /\/assets\/arcade\.html/.test(t.url));
const near = async () => {
  const [r, g, b] = await frame.js(`(() => { const c = document.querySelector('canvas'); const gl = c.getContext('webgl2') || c.getContext('webgl'); const px = new Uint8Array(4); gl.readPixels(c.width >> 1, c.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); return [px[0], px[1], px[2]]; })()`);
  return names(padsOf(r, g, b));
};
const nearShows = async (want, what) => {
  let got = '';
  for (const end = Date.now() + 10000; Date.now() < end; await sleep(100)) if ((got = await near()) === want) return;
  throw new Error(`${what}: the host's console shows "${got}", expected "${want}"`);
};

await farShows('p1: p2:', 'the game as it stands');
say('the guest is shown the game (nothing held)');
// The guest's keys are the second pad at the host's console; the host's are the first.
await guest.key('down', 'KeyK');
await guest.key('down', 'Enter');
await nearShows('p1: p2:b+start', "the guest's K and Enter at the host's console");
await farShows('p1: p2:b+start', 'and back at the guest');
say("the guest's K and Enter are player 2's B and Start at the host's console, and the guest sees it");
await host.key('down', 'KeyJ');
await farShows('p1:a p2:b+start', "the host's J, seen by the guest");
say("the host's J is player 1's A, and the guest sees both players' buttons");
await host.key('up', 'KeyJ');
await guest.key('up', 'KeyK');
await guest.key('up', 'Enter');
await farShows('p1: p2:', 'let go');

// How long from the guest's key to the guest seeing what it did: the way to the office, to the host, through the
// console, the encoder, and back. Measured in the guest's own page, by its own clock.
const delays = [];
for (let i = 0; i < 20; i++) {
  // The key is pressed inside the guest's own page (the arcade window takes a key before anything else on the page
  // hears it, so the moment is noted right where it is pressed), and the picture is looked at every 2 ms.
  const d = await guest.js(`new Promise((done) => {
    const c = document.querySelector('[data-arcade-far]').getContext('2d');
    const t0 = performance.now();
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyL', key: 'l', bubbles: true, cancelable: true }));
    const look = () => {
      const g = c.getImageData(320, 240, 1, 1).data[1];
      if (g > 100) return done(performance.now() - t0);
      if (performance.now() - t0 > 5000) return done(null);
      setTimeout(look, 2);
    };
    look();
  })`);
  await guest.js(`window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyL', key: 'l', bubbles: true, cancelable: true })), true`);
  if (d !== null) delays.push(d);
  await farShows('p1: p2:', 'let go between two measurements');
  await sleep(200 + Math.random() * 150);
}
delays.sort((a, b) => a - b);
const mid = delays[Math.floor(delays.length / 2)];
say(`from the guest's key to the guest seeing it, ${delays.length} of 20 measured: median ${mid?.toFixed(0)} ms, fastest ${delays[0]?.toFixed(0)} ms, slowest ${delays[delays.length - 1]?.toFixed(0)} ms`);

// Pictures and sound over ten seconds.
const count = () => guest.js(`({ v: Number(document.querySelector('[data-arcade-remote]').dataset.shownV), a: Number(document.querySelector('[data-arcade-remote]').dataset.shownA), t: performance.now() })`);
const c0 = await count();
await sleep(10000);
const c1 = await count();
const secs = (c1.t - c0.t) / 1000;
say(`at the guest over ${secs.toFixed(1)} s: ${((c1.v - c0.v) / secs).toFixed(1)} pictures a second, ${((c1.a - c0.a) / secs).toFixed(1)} pieces of sound a second`);
say(`pictures let go at the guest for being behind: ${await guest.js(`Number(document.querySelector('[data-arcade-remote]').dataset.shownLate)`)}`);
say(`host: ${await host.js(`document.querySelector('[data-arcade-open-line]').textContent.trim()`)}`);

// The guest gets up; the host's game goes on alone.
await guest.js(`document.querySelector('[data-arcade-back]').click()`);
await host.until(`window.__office.getState().arcade.tables[0] && window.__office.getState().arcade.tables[0].player2 === null`, 10000, 'the second pad free again');
say('the guest got up: the second pad is free again');
await host.js(`document.querySelector('[data-arcade-back]').click()`);
await host.until(`window.__office.getState().arcade.tables.length === 0`, 15000, 'no game to join any more');
await host.js(`(async () => { const c = document.querySelector('[data-arcade-game="Orchestrator Pad Test"]'); c.querySelector('[data-arcade-remove]').click(); await new Promise((r) => setTimeout(r, 300)); document.querySelector('[data-arcade-remove-sure]').click(); return true; })()`);
await host.until(`window.__office.getState().arcade.games.length === 0`, 10000, 'the test cartridge off the shelf');
say('the host left; the test cartridge was taken off the test office\'s shelf');
if (process.env.ARCADE_TRIAL_OUT) fs.writeFileSync(process.env.ARCADE_TRIAL_OUT, JSON.stringify({ ...out, delays }, null, 2));
process.exit(0);
