/**
 * ORCHESTRATOR desktop shell.
 *
 * Which office it opens, in this order:
 *   1. ORCH_SERVER_URL + ORCH_TOKEN, if set;
 *   2. the office saved from the connect screen (an office running on another machine, or in WSL);
 *   3. a local office: the server and this machine's host agent, started through
 *      scripts/start-local.mjs (not on Windows — workers need tmux);
 *   4. otherwise the connect screen.
 *
 * The server needs Node.js 22.18+ (built-in SQLite, native TypeScript), which
 * is newer than the Node inside Electron, so it runs as a normal `node`
 * process next to the app rather than inside it.
 */
const { app, BrowserWindow, shell, dialog, Menu, ipcMain, safeStorage, session } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const readline = require('node:readline');

const root = path.resolve(__dirname, '..', '..', '..');
// Workers run in tmux, which Windows does not have: there the app only connects to an office elsewhere.
const canStartLocal = process.platform !== 'win32' && !process.env.ORCH_REMOTE_ONLY;
if (process.env.ORCH_USER_DATA) app.setPath('userData', process.env.ORCH_USER_DATA);
let backend = null;
let win = null;
let connectWin = null;
let connectContext = { url: '', reason: '' };

function findNode() {
  const candidates = [process.env.ORCH_NODE, 'node', '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'].filter(Boolean);
  for (const bin of candidates) {
    const r = spawnSync(bin, ['-p', 'process.versions.node'], { encoding: 'utf8' });
    if (r.status !== 0) continue;
    const [major, minor] = r.stdout.trim().split('.').map(Number);
    if (major > 22 || (major === 22 && minor >= 18)) return bin;
  }
  return null;
}

let backendInfo = null;

function startBackend() {
  // Already running (the person went to visit another office and came back): the same office, not a second one.
  if (backend && backendInfo) return Promise.resolve(backendInfo);
  return new Promise((resolve, reject) => {
    const node = findNode();
    if (!node) return reject(new Error('Orchestrator needs Node.js 22.18 or newer on this machine (set ORCH_NODE to its path if it is not on PATH).'));
    // GUI apps on macOS start with a minimal PATH; make sure tmux, git and claude can be found.
    const PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', path.join(require('node:os').homedir(), '.local/bin')].filter(Boolean).join(path.delimiter);
    backend = spawn(node, [path.join(root, 'scripts', 'start-local.mjs'), '--json', '--port', process.env.ORCH_PORT || '4600'], {
      // Not the app's own folder: whatever this starts (the tmux server above all) outlives the app, and an
      // update replaces that folder.
      cwd: require('node:os').homedir(),
      env: { ...process.env, PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let ready = false;
    backend.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
    const rl = readline.createInterface({ input: backend.stdout });
    rl.on('line', (line) => {
      try {
        const info = JSON.parse(line);
        if (info.url && info.token) {
          ready = true;
          backendInfo = info;
          resolve(info);
        }
      } catch {
        /* not the ready line */
      }
    });
    backend.on('exit', (code) => {
      backend = null;
      backendInfo = null;
      reject(new Error(`The Orchestrator backend stopped (exit ${code}).\n\n${stderr.trim()}`));
      if (ready && win && !app.isQuitting) dialog.showErrorBox('Orchestrator', `The backend stopped unexpectedly.\n\n${stderr.trim().slice(-800)}`);
    });
  });
}

function stopBackend() {
  if (backend) backend.kill('SIGTERM');
  backend = null;
  backendInfo = null;
}

// ───────────── the saved office (connect screen) ─────────────

const connectionFile = () => path.join(app.getPath('userData'), 'connection.json');
// The operating system's keychain protects the saved token. On macOS that creates a keychain item
// ("Orchestrator Safe Storage"), and an unsigned or re-signed build makes macOS ask for the
// keychain password again. ORCH_NO_KEYCHAIN=1 keeps the token in a file only the owner can read instead.
const useKeychain = () => !process.env.ORCH_NO_KEYCHAIN && safeStorage.isEncryptionAvailable();

function loadConnection() {
  try {
    const raw = JSON.parse(fs.readFileSync(connectionFile(), 'utf8'));
    if (raw.encrypted && process.env.ORCH_NO_KEYCHAIN) return null;
    const token = raw.encrypted ? safeStorage.decryptString(Buffer.from(raw.token, 'base64')) : raw.token;
    return raw.url && token ? { url: raw.url, token } : null;
  } catch {
    return null;
  }
}

function saveConnection(target) {
  const encrypted = useKeychain();
  const token = encrypted ? safeStorage.encryptString(target.token).toString('base64') : target.token;
  fs.mkdirSync(path.dirname(connectionFile()), { recursive: true });
  fs.writeFileSync(connectionFile(), JSON.stringify({ url: target.url, token, encrypted }, null, 2), { mode: 0o600 });
}

function forgetConnection() {
  fs.rmSync(connectionFile(), { force: true });
}

// ───────────── offices this person was invited to ─────────────

const joinedFile = () => path.join(app.getPath('userData'), 'joined.json');

function readJoined() {
  try {
    const list = JSON.parse(fs.readFileSync(joinedFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeJoined(list) {
  fs.mkdirSync(path.dirname(joinedFile()), { recursive: true });
  fs.writeFileSync(joinedFile(), JSON.stringify(list, null, 2), { mode: 0o600 });
}

const tokenOfJoined = (j) => (j.encrypted ? (process.env.ORCH_NO_KEYCHAIN ? null : safeStorage.decryptString(Buffer.from(j.token, 'base64'))) : j.token);

/** An invitation string → what it says, or an error a person can act on. */
function parseInvite(code) {
  const text = String(code || '').trim();
  const m = /^orch-invite-v1\.([A-Za-z0-9_-]+)$/.exec(text);
  if (!m) throw new Error('That does not look like an invitation. Paste the whole text you were sent; it starts with "orch-invite-v1."');
  let j;
  try {
    j = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
  } catch {
    throw new Error('The invitation is damaged (it may have been cut off when it was copied).');
  }
  const addresses = (Array.isArray(j.a) ? j.a : []).map(String).filter((a) => /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(a));
  if (!addresses.length || typeof j.t !== 'string' || !/^orch_guest_/.test(j.t) || !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(String(j.f))) throw new Error('The invitation is incomplete.');
  return { office: String(j.n || 'An office').slice(0, 80), guest: String(j.g || 'Guest').slice(0, 40), role: ['owner', 'colleague'].includes(j.r) ? j.r : 'visitor', token: j.t, addresses, fingerprint: j.f };
}

/**
 * Ask the office at this address who we are — accepting the certificate the invitation names, or
 * one that is publicly trusted for that name, and no other. The token is sent only after the certificate has been checked.
 */
function askAsGuest(address, token, fingerprint) {
  return new Promise((resolve) => {
    const u = new URL(address);
    const req = https.request({ host: u.hostname, port: u.port || 443, path: '/api/me', method: 'GET', rejectUnauthorized: false, timeout: 8000, agent: false });
    let checked = false;
    req.on('socket', (socket) => {
      socket.on('secureConnect', () => {
        // The office is who it says it is when its certificate is the one the invitation names (an office reached by
        // address, with a certificate of its own) or one the system trusts for that name (an office behind a domain).
        const seen = socket.getPeerCertificate().fingerprint256;
        if (seen !== fingerprint && !socket.authorized) return req.destroy(new Error('PIN'));
        checked = true;
        req.setHeader('authorization', `Bearer ${token}`);
        req.end();
      });
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        if (!checked) return resolve({ error: 'The certificate was not checked.' });
        if (res.statusCode === 401 || res.statusCode === 403) return resolve({ error: 'This invitation is no longer valid: the owner revoked it or sent you a newer one.', final: true });
        try {
          const me = JSON.parse(body);
          if (res.statusCode === 200 && me && (me.kind === 'guest' || me.kind === 'owner') && me.role) return resolve({ me });
        } catch {
          /* not an office */
        }
        resolve({ error: `Something answered at ${address}, but it is not the office from the invitation.` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) =>
      resolve({
        error: e.message === 'PIN' ? `The computer at ${address} is not the one this invitation was made for (its certificate is different). Nothing was sent to it.` : `Could not reach ${address}.`,
        final: e.message === 'PIN',
      }),
    );
  });
}

// ───────────── this computer's place in someone else's office ─────────────

const { startPersonalHost } = require('./personal-host.cjs');
let myHost = null;
let myHostState = { state: 'none', reason: null, hostId: null };

function leaveWithThisComputer() {
  if (myHost) myHost.stop();
  myHost = null;
  myHostState = { state: 'none', reason: null, hostId: null };
}

function bringThisComputer(target) {
  leaveWithThisComputer();
  if (process.env.ORCH_NO_PERSONAL_HOST) return;
  const agentEntry = [path.join(root, 'apps/host-agent/dist/orchestrator-agent.mjs'), path.join(root, 'apps/host-agent/src/cli.ts')].find((p) => fs.existsSync(p));
  const PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', path.join(require('node:os').homedir(), '.local/bin')].filter(Boolean).join(path.delimiter);
  const forWindow = win;
  myHost = startPersonalHost({
    ...target,
    node: findNode(),
    agentEntry,
    PATH,
    onState: (state) => {
      myHostState = state;
      if (forWindow && !forWindow.isDestroyed()) forWindow.webContents.send('orch:my-host-state', state);
    },
  });
}
ipcMain.handle('orch:my-host', () => myHostState);

/** Try the addresses of an invitation in turn and open the first office that answers as itself. */
async function joinOffice(invite, remember) {
  const problems = [];
  for (const address of invite.addresses) {
    const res = await askAsGuest(address, invite.token, invite.fingerprint);
    if (res.me) {
      if (remember) {
        const encrypted = useKeychain();
        const list = readJoined().filter((j) => !(j.fingerprint === invite.fingerprint && j.guest === invite.guest));
        list.unshift({ id: crypto.randomUUID(), office: res.me.office || invite.office, guest: res.me.name || invite.guest, role: res.me.role, addresses: invite.addresses, fingerprint: invite.fingerprint, token: encrypted ? safeStorage.encryptString(invite.token).toString('base64') : invite.token, encrypted, lastUsedAt: new Date().toISOString() });
        writeJoined(list.slice(0, 20));
      }
      // Your own office keeps running in the background while you visit: its employees stay looked after.
      await openOffice({ url: address, token: invite.token, pin: invite.fingerprint });
      // A colleague or an owner brings their own computer along: its sessions sit in their room while they are here.
      if (res.me.role !== 'visitor') bringThisComputer({ address, token: invite.token, fingerprint: invite.fingerprint });
      return { ok: true };
    }
    problems.push(res.error);
    if (res.final) break;
  }
  return { error: `${problems[problems.length - 1]}${invite.addresses.length > 1 && problems.length > 1 ? ` (tried ${problems.length} addresses)` : ''} Ask whoever invited you whether their office is open to guests and reachable from your network.` };
}

/** A server address the owner token may be sent to: TLS, or this computer itself. */
function normalizeUrl(raw) {
  let text = String(raw || '').trim();
  if (!text) throw new Error('Enter the address of the Orchestrator server.');
  if (!/^[a-z]+:\/\//i.test(text)) text = (/^(localhost|127\.|\[::1\])/i.test(text) ? 'http://' : 'https://') + text;
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new Error('That is not a valid address.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('The address must start with https:// (or http:// for this computer).');
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (u.protocol === 'http:' && !loopback) throw new Error('For an office on another machine the address must be https:// — the owner token would otherwise travel unencrypted.');
  return u.origin;
}

/** Null when the office answers and accepts the token; otherwise why not. */
async function probe(target) {
  try {
    const res = await fetch(`${target.url}/api/state`, { headers: { authorization: `Bearer ${target.token}` }, signal: AbortSignal.timeout(10000) });
    if (res.status === 401 || res.status === 403) return 'The server answered, but it did not accept this owner token.';
    if (!res.ok) return `The server answered with HTTP ${res.status}; is this an Orchestrator server?`;
    const body = await res.json().catch(() => null);
    if (!body || !Array.isArray(body.employees)) return 'Something answered at that address, but it is not an Orchestrator server.';
    return null;
  } catch (e) {
    const cause = e && e.cause && e.cause.code ? ` (${e.cause.code})` : '';
    return `Could not reach ${target.url}${cause}. Check the address, that the server is running, and — for https — that its certificate is trusted by this computer.`;
  }
}

function openConnect(reason, url) {
  connectContext = { url: url || connectContext.url || '', reason: reason || '' };
  if (connectWin) {
    connectWin.reload();
    connectWin.focus();
    return connectWin;
  }
  connectWin = new BrowserWindow({
    width: 760,
    height: 780,
    backgroundColor: '#0d1118',
    title: 'ORCHESTRATOR',
    autoHideMenuBar: true,
    // ORCH_HIDDEN: tests drive the windows without putting them on the person's screen.
    show: !process.env.ORCH_SMOKE_SCREENSHOT && !process.env.ORCH_HIDDEN,
    webPreferences: { preload: path.join(__dirname, 'connect-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  connectWin.on('closed', () => (connectWin = null));
  connectWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  connectWin.webContents.on('will-navigate', (e) => e.preventDefault());
  void connectWin.loadFile(path.join(__dirname, 'connect.html')).then(() => smokeConnect());
  return connectWin;
}

ipcMain.handle('orch:pick-folder', async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(parent, { title: 'Choose the folder this employee works in', buttonLabel: 'Choose folder', properties: ['openDirectory', 'createDirectory'] });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
});
// Several folders at once: one employee is hired for each.
ipcMain.handle('orch:pick-folders', async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(parent, { title: 'Choose the project folders — one employee is hired for each', buttonLabel: 'Choose folders', properties: ['openDirectory', 'multiSelections'] });
  return res.canceled ? [] : res.filePaths;
});
// This computer's preferences (graphics, keys, extras, how loud the hi-fi is here), the same in every office opened
// from here. The page that asks may be another office's, so only these fields are kept, and only in their expected shapes.
const prefsFile = () => path.join(app.getPath('userData'), 'prefs.json');
ipcMain.handle('orch:prefs-get', () => {
  try {
    return JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
  } catch {
    return null;
  }
});
ipcMain.handle('orch:prefs-set', (_event, input) => {
  const p = input && typeof input === 'object' ? input : {};
  const keys = {};
  for (const [id, code] of Object.entries(p.keybindings && typeof p.keybindings === 'object' ? p.keybindings : {}).slice(0, 64)) {
    if (typeof code === 'string' && code && code.length <= 40 && id.length <= 40) keys[id] = code;
  }
  const prefs = {
    quality: ['low', 'medium', 'high'].includes(p.quality) ? p.quality : 'medium',
    keybindings: keys,
    projectZones: p.projectZones === true,
    approachZoom: p.approachZoom === true,
    radioVolume: typeof p.radioVolume === 'number' && Number.isFinite(p.radioVolume) ? Math.min(1, Math.max(0, p.radioVolume)) : 0.6,
    radioMuted: p.radioMuted === true,
  };
  const file = prefsFile();
  // Written beside and renamed, so a crash half-way leaves the previous file.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(prefs, null, 2), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  fs.chmodSync(file, 0o600);
  return true;
});
ipcMain.handle('orch:connect-context', () => ({
  ...connectContext,
  canStartLocal,
  // A saved connection made with an owner token (an office of your own on another machine).
  ownRemote: (loadConnection() || {}).url || null,
  joined: readJoined().map((j) => ({ id: j.id, office: j.office, guest: j.guest, role: j.role, lastUsedAt: j.lastUsedAt, usable: tokenOfJoined(j) !== null, atStart: j.atStart === true })),
}));
// ───────────── knocking: only the office's address is known ─────────────
// The app asks at the door; someone inside lets the person in and says as what. What comes back is an
// invitation like any other, kept on this computer, so the next time there is nothing to ask.

/** An https origin from what was typed ("office.example.com", "https://office.example.com/"), or null if it is not an address. */
function addressOf(text) {
  const t = String(text || '').trim().replace(/\/+$/, '');
  if (!t || /\s/.test(t) || /^orch-invite-v1\./.test(t)) return null;
  const m = /^(?:https:\/\/)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(:\d{1,5})?$/.exec(t);
  return m ? `https://${m[1].toLowerCase()}${m[2] || ''}` : null;
}

/**
 * One request to an office's door, made only after its certificate has been checked: it must be one this computer
 * trusts for that name. (ORCH_KNOCK_PIN names one exact certificate to accept as well — for an office that has only
 * its own certificate, in tests.) Nothing — not even the name — is sent to anything else.
 */
function askDoor(origin, method, pathname, headers, body) {
  return new Promise((resolve) => {
    const u = new URL(origin);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({ host: u.hostname, port: u.port || 443, path: pathname, method, rejectUnauthorized: false, timeout: 10000, agent: false });
    let checked = false;
    req.on('socket', (socket) => {
      socket.on('secureConnect', () => {
        const pin = process.env.ORCH_KNOCK_PIN;
        if (!socket.authorized && !(pin && socket.getPeerCertificate().fingerprint256 === pin)) return req.destroy(new Error('TRUST'));
        checked = true;
        for (const [k, v] of Object.entries(headers || {})) req.setHeader(k, v);
        if (payload) {
          req.setHeader('content-type', 'application/json');
          req.setHeader('content-length', payload.length);
        }
        req.end(payload || undefined);
      });
    });
    req.on('response', (res) => {
      let text = '';
      res.on('data', (d) => (text += d));
      res.on('end', () => {
        if (!checked) return resolve({ error: 'The certificate was not checked.' });
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not an office */
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) =>
      resolve({
        error:
          e.message === 'TRUST'
            ? `The office at ${u.host} has no certificate this computer trusts, so it cannot be asked by its address alone. Ask someone inside for an invitation: it names the exact computer to trust.`
            : `Could not reach ${u.host}.`,
      }),
    );
  });
}

let knocking = null;
ipcMain.handle('orch:knock', async (_event, input) => {
  const origin = addressOf(input && input.address);
  const name = String((input && input.name) || '').trim().slice(0, 40);
  if (!origin) return { error: 'Type the address of the office, for example office.example.com — or paste an invitation.' };
  if (name.length < 2) return { error: 'Say who you are: the people inside see this name when you knock.' };
  const res = await askDoor(origin, 'POST', '/knock', {}, { name, via: 'app' });
  if (res.error) return { error: res.error };
  if (res.status !== 200 || !res.json || !res.json.id || !res.json.secret) return { error: res.json && res.json.error && res.status !== 404 ? res.json.error : `There is no Orchestrator office at ${new URL(origin).host}, or it is not open to people from outside.` };
  knocking = { origin, id: res.json.id, secret: res.json.secret, name };
  return { ok: true, code: res.json.code, office: res.json.office || 'the office', anyoneIn: !!res.json.anyoneIn };
});
ipcMain.handle('orch:knock-poll', async () => {
  const k = knocking;
  if (!k) return { status: 'gone' };
  const res = await askDoor(k.origin, 'GET', `/knock/${k.id}`, { 'x-knock-secret': k.secret });
  if (knocking !== k) return { status: 'gone' };
  // The office did not answer this once: still waiting, ask again.
  if (res.error || res.status !== 200 || !res.json) return { status: 'waiting' };
  const a = res.json;
  if (a.status === 'waiting') return { status: 'waiting', anyoneIn: !!a.anyoneIn };
  knocking = null;
  if (a.status !== 'admitted') return { status: a.status === 'refused' ? 'refused' : 'gone' };
  let invite;
  try {
    invite = parseInvite(a.invite);
  } catch (e) {
    return { status: 'admitted', error: e.message };
  }
  // The address that was knocked on is known to work from here: try it first.
  const joinedRes = await joinOffice({ ...invite, addresses: [k.origin, ...invite.addresses.filter((x) => x !== k.origin)] }, true);
  return { status: 'admitted', role: a.role, error: joinedRes.error };
});
ipcMain.handle('orch:knock-cancel', async () => {
  const k = knocking;
  knocking = null;
  if (k) await askDoor(k.origin, 'DELETE', `/knock/${k.id}`, { 'x-knock-secret': k.secret });
  return true;
});

ipcMain.handle('orch:join', async (_event, input) => {
  let invite;
  try {
    invite = parseInvite(input && input.invite);
  } catch (e) {
    return { error: e.message };
  }
  return joinOffice(invite, true);
});
ipcMain.handle('orch:join-saved', async (_event, input) => {
  const j = readJoined().find((x) => x.id === String(input && input.id));
  const token = j ? tokenOfJoined(j) : null;
  if (!j || !token) return { error: 'That invitation is no longer stored on this computer; paste it again.' };
  const res = await joinOffice({ office: j.office, guest: j.guest, role: j.role, token, addresses: j.addresses, fingerprint: j.fingerprint }, false);
  if (res.ok) writeJoined(readJoined().map((x) => (x.id === j.id ? { ...x, lastUsedAt: new Date().toISOString() } : x)));
  return res;
});
// One saved office may be the one the app walks into by itself when it starts (the usual case: the office on a server).
ipcMain.handle('orch:joined-at-start', (_event, input) => {
  const id = String((input && input.id) || '');
  writeJoined(readJoined().map((x) => ({ ...x, atStart: x.id === id && input.on === true })));
  return true;
});
ipcMain.handle('orch:forget-joined', (_event, input) => {
  writeJoined(readJoined().filter((x) => x.id !== String(input && input.id)));
  return true;
});
ipcMain.handle('orch:open-own', async () => {
  try {
    await startOwn();
    return { ok: true };
  } catch (e) {
    return { error: e.message };
  }
});
ipcMain.handle('orch:connect', async (_event, input) => {
  let target;
  try {
    target = { url: normalizeUrl(input && input.url), token: String((input && input.token) || '').trim() };
  } catch (e) {
    return { error: e.message };
  }
  if (!target.token) return { error: 'Enter the owner token.' };
  const problem = await probe(target);
  if (problem) return { error: problem };
  saveConnection(target);
  stopBackend();
  await openOffice(target);
  return { ok: true };
});
ipcMain.handle('orch:start-local', async () => {
  if (!canStartLocal) return { error: 'A local office cannot run on this platform.' };
  forgetConnection();
  await startOwn();
  return { ok: true };
});

// ───────────── the office window ─────────────

async function openOffice(target) {
  const next = new BrowserWindow({
    width: 1680,
    height: 1050,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0d1118',
    title: 'ORCHESTRATOR',
    autoHideMenuBar: true,
    // ORCH_HIDDEN: tests drive the windows without putting them on the person's screen.
    show: !process.env.ORCH_SMOKE_SCREENSHOT && !process.env.ORCH_HIDDEN,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep rendering and terminal streams alive when the window is in the background.
      backgroundThrottling: false,
      // The office hi-fi starts in every window when someone in the office switches it on: no click happens here first.
      // (This is Electron's default; said here because the hi-fi depends on it.)
      autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: [`--orch-server=${target.url}`, `--orch-token=${target.token}`],
      // The office TV is a real embedded browser (see setupTv): the only <webview> this window may create.
      webviewTag: true,
    },
  });
  // The new window exists before the old ones close, so the app does not quit in between.
  const old = [win, connectWin].filter(Boolean);
  // Leaving an office takes this computer out of it.
  leaveWithThisComputer();
  win = next;
  win.on('closed', () => {
    if (win === next) {
      win = null;
      leaveWithThisComputer();
    }
  });
  for (const w of old) w.destroy();
  // A guest's office has a certificate made by its owner's computer: accept exactly the one the
  // invitation named, for that host only. Everything else is judged the normal way.
  const pinned = target.pin ? { host: new URL(target.url).hostname, print: `sha256/${Buffer.from(target.pin.replace(/:/g, ''), 'hex').toString('base64')}` } : null;
  win.webContents.session.setCertificateVerifyProc(pinned ? (request, done) => done(request.hostname === pinned.host && request.certificate.fingerprint === pinned.print ? 0 : -3) : null);
  // Closing the window stops the office on this computer; it is easy to do by accident.
  win.on('close', (e) => {
    if (next.forceClose || app.isQuitting === 'confirmed' || !closeNeedsConfirming()) return;
    e.preventDefault();
    const own = !target.pin;
    const choice = dialog.showMessageBoxSync(next, {
      type: 'question',
      buttons: [own ? 'Close the office' : 'Leave', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: own ? 'Close the office?' : 'Leave this office?',
      detail: own ? 'Your employees keep working in their tmux sessions, but nobody watches them, answers their questions or hands them tasks until you open the office again.' : 'You can come back with the same invitation.',
    });
    if (choice === 0) {
      next.forceClose = true;
      app.isQuitting = 'confirmed';
      next.close();
    }
  });
  // The office never navigates away; anything else opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = [target.url, process.env.ORCH_UI_DEV_URL].filter(Boolean);
    if (!allowed.some((a) => url.startsWith(a))) e.preventDefault();
  });
  setupTv(next, target);
  await win.loadURL(process.env.ORCH_UI_DEV_URL || `${target.url}/`);

  // Self-check used by the repository's smoke tests: render, save a screenshot, quit.
  if (process.env.ORCH_SMOKE_SCREENSHOT) {
    setTimeout(async () => {
      const image = await next.webContents.capturePage();
      fs.writeFileSync(process.env.ORCH_SMOKE_SCREENSHOT, image.toPNG());
      app.quit();
    }, Number(process.env.ORCH_SMOKE_WAIT_MS || 7000));
  }
}

// ───────────── the office TV: an embedded browser ─────────────

const TV_PARTITION = 'persist:orch-tv';

/**
 * The TV in the office is a web browser inside the window (a <webview>). It is a guest: its own
 * storage partition, no Node, no preload, sandboxed, http(s) only. It cannot open windows, cannot
 * reach the office's own server, and is refused camera, microphone, location and notifications.
 * What it shows is sent to the page about once a second, so the TV in the 3D office shows the real picture.
 */
function setupTv(officeWin, target) {
  const tv = session.fromPartition(TV_PARTITION);
  const web = (url) => /^https?:\/\//i.test(String(url || ''));
  let office = null;
  try {
    office = new URL(target.url);
  } catch {
    office = null;
  }
  // A plain browser identity: some sites refuse or degrade for embedded browsers.
  tv.setUserAgent(officeWin.webContents.getUserAgent().replace(/\s(Electron|orchestrator[^\s]*|Orchestrator[^\s]*)\/[^\s]+/g, ''));
  tv.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'fullscreen'));
  tv.setPermissionCheckHandler((_wc, permission) => permission === 'fullscreen');
  tv.webRequest.onBeforeRequest((details, done) => {
    let cancel = !/^(https?|wss?|data|blob|about|chrome-extension|devtools):/i.test(details.url);
    try {
      const u = new URL(details.url);
      // Pages on the TV have no business talking to the office itself.
      if (office && /^(https?|wss?):$/.test(u.protocol) && u.hostname === office.hostname && (u.port || (u.protocol.endsWith('s:') ? '443' : '80')) === (office.port || (office.protocol === 'https:' ? '443' : '80'))) cancel = true;
    } catch {
      cancel = true;
    }
    done({ cancel });
  });

  officeWin.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    // Links that ask for a new window are let through to the handler below, which opens them in the TV itself.
    params.allowpopups = true;
    if (params.partition !== TV_PARTITION || !web(params.src)) event.preventDefault();
  });

  officeWin.webContents.on('did-attach-webview', (_event, guest) => {
    const send = (channel, payload) => {
      if (!officeWin.isDestroyed()) officeWin.webContents.send(channel, payload);
    };
    // Links that want a new window open in the TV itself.
    guest.setWindowOpenHandler(({ url }) => {
      if (web(url)) setImmediate(() => !guest.isDestroyed() && guest.loadURL(url).catch(() => undefined));
      return { action: 'deny' };
    });
    guest.on('will-navigate', (e, url) => {
      if (!web(url)) e.preventDefault();
    });
    const state = () => !guest.isDestroyed() && send('orch:tv-state', { url: guest.getURL(), title: guest.getTitle(), audible: guest.isCurrentlyAudible(), loading: guest.isLoading(), canGoBack: guest.navigationHistory ? guest.navigationHistory.canGoBack() : guest.canGoBack(), canGoForward: guest.navigationHistory ? guest.navigationHistory.canGoForward() : guest.canGoForward() });
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading', 'media-started-playing', 'media-paused']) guest.on(ev, state);
    // The picture for the TV on the wall of the 3D office: the real page, about once a second.
    let busy = false;
    const frames = setInterval(async () => {
      if (guest.isDestroyed() || officeWin.isDestroyed()) return clearInterval(frames);
      if (busy) return;
      busy = true;
      try {
        const image = await guest.capturePage();
        const size = image.getSize();
        if (size.width > 0) send('orch:tv-frame', image.resize({ width: 480 }).toJPEG(60).toString('base64'));
        state();
      } catch {
        /* the page is navigating */
      }
      busy = false;
    }, 1000);
    guest.on('destroyed', () => {
      clearInterval(frames);
      send('orch:tv-state', null);
    });
  });
}

ipcMain.handle('orch:tv-forget', async () => {
  const tv = session.fromPartition(TV_PARTITION);
  await tv.clearStorageData();
  await tv.clearCache();
  return true;
});

/**
 * Self-check used by the repository's smoke test of the connect screen (ORCH_SMOKE_CONNECT is
 * JSON {url, token, badToken}): type a wrong token, expect the refusal, then the right one.
 */
async function smokeConnect() {
  if (!process.env.ORCH_SMOKE_CONNECT || !connectWin) return;
  const plan = JSON.parse(process.env.ORCH_SMOKE_CONNECT);
  const page = (code) => connectWin.webContents.executeJavaScript(code, true);
  const submit = (url, token) => page(`(() => { document.getElementById('url').value = ${JSON.stringify(url)}; document.getElementById('token').value = ${JSON.stringify(token)}; document.getElementById('connect').click(); })()`);
  const record = (line) => process.env.ORCH_SMOKE_RESULT && fs.appendFileSync(process.env.ORCH_SMOKE_RESULT, `${line}\n`);
  const shownError = async () => {
    for (let i = 0; i < 100; i++) {
      const text = await page(`(() => { const e = document.getElementById('error'); return e.style.display === 'block' ? e.textContent : ''; })()`);
      if (text) return text;
      await new Promise((r) => setTimeout(r, 150));
    }
    return '';
  };
  await new Promise((r) => setTimeout(r, 400));
  record(`context: ${JSON.stringify(await page('window.orchConnect.context()'))}`);
  await submit('http://office.example.com', plan.token);
  record(`plain http to another machine: ${await shownError()}`);
  await submit(plan.url, plan.badToken);
  record(`wrong token: ${await shownError()}`);
  await submit(plan.url, plan.token);
  record('right token submitted');
}

/** Open the person's own office: one saved with an owner token, or the local one on this computer. */
async function startOwn() {
  if (process.env.ORCH_SERVER_URL && process.env.ORCH_TOKEN) return openOffice({ url: process.env.ORCH_SERVER_URL.replace(/\/+$/, ''), token: process.env.ORCH_TOKEN });
  const saved = loadConnection();
  if (saved) {
    const problem = await probe(saved);
    if (!problem) return openOffice(saved);
    return openConnect(`The office at ${saved.url} could not be opened.\n${problem}`, saved.url);
  }
  if (canStartLocal) {
    try {
      return await openOffice(await startBackend());
    } catch (e) {
      return openConnect(`A local office could not be started on this computer:\n${e.message}`);
    }
  }
  return openConnect(process.platform === 'win32' ? 'Claude Code workers run in tmux, so on Windows the office itself runs in WSL2 or on another machine. This app connects to it.' : '');
}

/** Tests and scripted runs go straight in; a person is asked first whose office to open. */
const scripted = () => !!(process.env.ORCH_SERVER_URL || process.env.ORCH_SMOKE_SCREENSHOT || process.env.ORCH_SMOKE_CONNECT || process.env.ORCH_SKIP_START_SCREEN);
// Skipping the start screen (ORCH_SKIP_START_SCREEN) is still a person's session: closing asks first.
const closeNeedsConfirming = () => !(process.env.ORCH_SERVER_URL || process.env.ORCH_SMOKE_SCREENSHOT || process.env.ORCH_SMOKE_CONNECT) && !process.env.ORCH_NO_CLOSE_CONFIRM;

async function start() {
  if (scripted()) return startOwn();
  // The office this person chose to open at start (Office → Switch office… still leads to the start screen).
  const usual = readJoined().find((j) => j.atStart === true);
  const token = usual ? tokenOfJoined(usual) : null;
  if (usual && token) {
    openConnect(`Connecting to ${usual.office}…`);
    const res = await joinOffice({ office: usual.office, guest: usual.guest, role: usual.role, token, addresses: usual.addresses, fingerprint: usual.fingerprint }, false);
    if (res.ok) {
      writeJoined(readJoined().map((x) => (x.id === usual.id ? { ...x, lastUsedAt: new Date().toISOString() } : x)));
      return;
    }
    return openConnect(`${usual.office} could not be opened.\n${res.error}`);
  }
  return openConnect('');
}

Menu.setApplicationMenu(
  Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Office',
      submenu: [
        { label: 'Switch office…', click: () => openConnect('', (loadConnection() || {}).url) },
        {
          label: 'Use the local office',
          enabled: canStartLocal,
          click: () => {
            forgetConnection();
            void startOwn();
          },
        },
      ],
    },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ]),
);

app.whenReady().then(() =>
  start().catch((e) => {
    dialog.showErrorBox('Orchestrator could not start', e.message);
    app.quit();
  }),
);
app.on('before-quit', (e) => {
  // Cmd+Q goes through the same question as closing the window.
  if (win && !win.isDestroyed() && !win.forceClose && app.isQuitting !== 'confirmed' && closeNeedsConfirming()) {
    e.preventDefault();
    win.close();
    return;
  }
  app.isQuitting = app.isQuitting || true;
  // Stops the server and agent. Employees' tmux sessions keep running.
  leaveWithThisComputer();
  stopBackend();
});
app.on('window-all-closed', () => app.quit());
