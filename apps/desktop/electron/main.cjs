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
  if (!m) throw new Error('That does not look like an invitation. Paste the whole link you were sent, for example office.example.com/join/ABCD-EFGH-JKLM.');
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
  // Servers this person brought into that office stay in it; only the means to look after them go with the window.
  myServers = null;
}

function bringThisComputer(target) {
  leaveWithThisComputer();
  if (process.env.ORCH_NO_PERSONAL_HOST) return;
  const agentEntry = [path.join(root, 'apps/host-agent/dist/orchestrator-agent.mjs'), path.join(root, 'apps/host-agent/src/cli.ts')].find((p) => fs.existsSync(p));
  const PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', path.join(require('node:os').homedir(), '.local/bin')].filter(Boolean).join(path.delimiter);
  const forWindow = win;
  myServers = { office: new URL(target.address).host, forWindow, servers: memberServers({ office: target, file: path.join(app.getPath('userData'), 'servers.json'), agentBundle: agentEntry && /\.mjs$/.test(agentEntry) ? agentEntry : null }) };
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

// ───────────── what the office's page is handed when it starts ─────────────
const { staysInOffice, externalUrl, pageMay, tvPartition } = require('./guards.cjs');
/** Per office window: the office's address, the person's credential for it, its TV's storage. */
const boots = new Map();
// Asked by the preload, once, before the page runs. Answered only for the window's own top frame while it shows
// the office itself: a page the window was led to somewhere else gets nothing.
ipcMain.on('orch:boot', (event) => {
  const boot = boots.get(event.sender.id);
  const frame = event.senderFrame;
  const url = frame ? frame.url : '';
  const top = !!frame && frame === event.sender.mainFrame;
  event.returnValue = boot && top && staysInOffice(url, boot.inOffice) ? { serverUrl: boot.serverUrl, token: boot.token, tvPartition: boot.tvPartition } : {};
});

// ───────────── this person's own servers in someone else's office ─────────────
// The page asks; the app does the reaching, over SSH, as the person. A page is the office's, not the person's, so
// before the app connects anywhere it asks in a dialog of its own — one a page cannot draw or answer.
const { memberServers, parseTarget, cleanRoots } = require('./member-servers.cjs');
let myServers = null;
const serversChanged = () => myServers && myServers.forWindow && !myServers.forWindow.isDestroyed() && myServers.forWindow.webContents.send('orch:servers-changed');
/** Asks the person in a dialog of the app's own. With `checkbox`, also something to tick: `{ ok, trust }` then. */
const confirmServer = async (message, detail, button, checkbox) => {
  // (The automated tests answer for themselves; ORCH_TRUST_NEW_SERVER is their tick.)
  if (process.env.ORCH_NO_SERVER_CONFIRM) return checkbox ? { ok: true, trust: process.env.ORCH_TRUST_NEW_SERVER === '1' } : true;
  const res = await dialog.showMessageBox(myServers.forWindow, { type: 'question', buttons: [button, 'Cancel'], defaultId: 1, cancelId: 1, message, detail, ...(checkbox ? { checkboxLabel: checkbox, checkboxChecked: false } : {}) });
  return checkbox ? { ok: res.response === 0, trust: res.response === 0 && res.checkboxChecked === true } : res.response === 0;
};
ipcMain.handle('orch:servers', () => (myServers ? myServers.servers.list() : null));
ipcMain.handle('orch:servers-add', async (_e, input) => {
  if (!myServers) return { error: 'This computer is not in an office as a member.' };
  const mine = myServers;
  try {
    const { dest, port } = parseTarget(input && input.target);
    // Everything the page passed along is said here, in the app's own words: the page is the office's, and "the
    // folders you named" must be the folders that are really sent. Whether a server this computer has not met
    // before is trusted is asked here too — not taken from the page.
    const roots = cleanRoots(input && input.roots);
    const folders = roots.length ? roots.join('\n  ') : '~/ (the whole home folder)';
    const { ok, trust } = await confirmServer(
      `Bring ${dest}${port ? ` (port ${port})` : ''} into the office at ${mine.office}?`,
      `Orchestrator will connect to ${dest}${port ? ` on port ${port}` : ''} over SSH with the keys on this computer, install the office's agent there (in ~/.orchestrator) and start it. The agent then stays connected to ${mine.office} by itself: people you allow can start Claude Code sessions on that server, in these folders:\n\n  ${folders}\n\nOnly do this for an office you trust with that server.`,
      'Connect and bring it in',
      'This computer has not connected to that server before: trust the key it shows',
    );
    if (!ok) return { cancelled: true };
    const server = await mine.servers.add({ target: input.target, name: input.name, roots, trustNewHost: trust }, serversChanged);
    serversChanged();
    return { ok: true, warnings: server.warnings };
  } catch (e) {
    serversChanged();
    return { error: e.message };
  }
});
ipcMain.handle('orch:servers-reconnect', async (_e, id) => {
  if (!myServers) return { error: 'This computer is not in an office as a member.' };
  try {
    serversChanged();
    return await myServers.servers.reconnect(String(id));
  } catch (e) {
    return { error: e.message };
  } finally {
    serversChanged();
  }
});
ipcMain.handle('orch:servers-roots', async (_e, id, roots) => {
  if (!myServers) return { error: 'This computer is not in an office as a member.' };
  const mine = myServers;
  const rec = mine.servers.list().find((r) => r.id === String(id));
  if (!rec) return { error: 'That server is not in this computer\'s list.' };
  try {
    const wanted = (Array.isArray(roots) ? roots : []).map((r) => String(r).trim()).filter(Boolean);
    // More folders is more of the server for the office to work in: asked here, where a page cannot answer.
    const ok = await confirmServer(`Let the office at ${mine.office} work in these folders on ${rec.name}?`, `${wanted.length ? wanted.join('\n') : 'Your home folder on the server'}\n\nOrchestrator will connect to ${rec.target} over SSH and start the office's agent there again with this list. Whoever may work on that server can then start Claude Code sessions in these folders, and nowhere else. Sessions that are running keep running.`, 'Change the folders');
    if (!ok) return { cancelled: true };
    serversChanged();
    return await mine.servers.setRoots(rec.id, wanted);
  } catch (e) {
    return { error: e.message };
  } finally {
    serversChanged();
  }
});
// Looking through a server's folders, to choose from. The names are shown in the office's page, so the person is
// asked first — once for each server, until the app is closed.
const browseAllowed = new Set();
ipcMain.handle('orch:servers-browse', async (_e, id, dir) => {
  if (!myServers) return { error: 'This computer is not in an office as a member.' };
  const mine = myServers;
  const rec = mine.servers.list().find((r) => r.id === String(id));
  if (!rec) return { error: 'That server is not in this computer\'s list.' };
  try {
    const key = `${mine.office}|${rec.id}`;
    if (!browseAllowed.has(key)) {
      const ok = await confirmServer(`Show the folders on ${rec.name} in this window?`, `Orchestrator will connect to ${rec.target} over SSH with the keys on this computer and read the names of the folders there, so that you can pick the ones employees may work in. Only names of folders are read; nothing on the server is changed, and nothing more is allowed to the office until you change the folders.\n\nThe window they are shown in is the office's (${mine.office}). Asked once, until the app is closed.`, 'Show the folders');
      if (!ok) return { cancelled: true };
      browseAllowed.add(key);
    }
    return { ok: true, ...(await mine.servers.browse(rec.id, dir == null ? '' : String(dir))) };
  } catch (e) {
    return { error: e.message };
  }
});
ipcMain.handle('orch:servers-remove', async (_e, id) => {
  if (!myServers) return { error: 'This computer is not in an office as a member.' };
  const mine = myServers;
  const rec = mine.servers.list().find((r) => r.id === String(id));
  if (!rec) return { ok: true, cleaned: false };
  try {
    const ok = await confirmServer(`Take ${rec.name} out of the office at ${mine.office}?`, `Orchestrator will connect to ${rec.target} over SSH, stop the office's agent there and delete what it installed for this office. The office forgets the machine. Claude Code sessions on the server keep running in tmux; nothing else there is touched.`, 'Remove it');
    if (!ok) return { cancelled: true };
    return await mine.servers.remove(rec.id);
  } catch (e) {
    return { error: e.message };
  } finally {
    serversChanged();
  }
});

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

/**
 * A folder picked in the system's dialog, as the machine that will work in it names it. On Windows the sessions of
 * this computer run in WSL, which knows `D:\Work` as `/mnt/d/Work`; a folder WSL cannot see is passed on as it is
 * and refused there, in words.
 */
const asHostPath = (p) => (process.platform === 'win32' ? require('./wsl-host.cjs').toWslPath(p) || p : p);

ipcMain.handle('orch:pick-folder', async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(parent, { title: 'Choose the folder this employee works in', buttonLabel: 'Choose folder', properties: ['openDirectory', 'createDirectory'] });
  return res.canceled || !res.filePaths.length ? null : asHostPath(res.filePaths[0]);
});
// Several folders at once: one employee is hired for each.
ipcMain.handle('orch:pick-folders', async (event) => {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const res = await dialog.showOpenDialog(parent, { title: 'Choose the project folders — one employee is hired for each', buttonLabel: 'Choose folders', properties: ['openDirectory', 'multiSelections'] });
  return res.canceled ? [] : res.filePaths.map(asHostPath);
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
    voiceVolume: typeof p.voiceVolume === 'number' && Number.isFinite(p.voiceVolume) ? Math.min(1, Math.max(0, p.voiceVolume)) : 1,
    voiceMuted: p.voiceMuted === true,
    voiceMode: p.voiceMode === 'open' ? 'open' : 'hold',
    micGate: typeof p.micGate === 'number' && Number.isFinite(p.micGate) ? Math.min(0.1, Math.max(0.004, p.micGate)) : 0.02,
    micDevice: typeof p.micDevice === 'string' && p.micDevice.length <= 256 ? p.micDevice : '',
    outputDevice: typeof p.outputDevice === 'string' && p.outputDevice.length <= 256 ? p.outputDevice : '',
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

/**
 * An invitation link ("https://office.example.com/join/K7QF-M2XP-9TRD", with or without the https://) → where to
 * ask and with what, or null if it is not one. A link to an office's own address ends in the start of the
 * fingerprint of its certificate ("….3fa9c01b22d4e6a17c05"): the only certificate to accept there.
 */
function linkOf(text) {
  const m = /^(?:https:\/\/)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(:\d{1,5})?\/join\/([A-Za-z0-9-]{4,40})(?:\.([0-9a-fA-F]{20}))?\/?$/.exec(String(text || '').trim());
  return m ? { origin: `https://${m[1].toLowerCase()}${m[2] || ''}`, code: m[3], pin: m[4] ? m[4].toLowerCase() : null } : null;
}

/** An https origin from what was typed ("office.example.com", "https://office.example.com/"), or null if it is not an address. */
function addressOf(text) {
  const t = String(text || '').trim().replace(/\/+$/, '');
  if (!t || /\s/.test(t) || /^orch-invite-v1\./.test(t)) return null;
  const m = /^(?:https:\/\/)?([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)(:\d{1,5})?$/.exec(t);
  return m ? `https://${m[1].toLowerCase()}${m[2] || ''}` : null;
}

/**
 * One request to an office's door, made only after its certificate has been checked: it must be one this computer
 * trusts for that name, or the one an invitation link names (`pin`: the start of its fingerprint). (ORCH_KNOCK_PIN
 * names one exact certificate to accept as well — for an office that has only its own certificate, in tests.)
 * Nothing — not even the name — is sent to anything else.
 */
function askDoor(origin, method, pathname, headers, body, pin) {
  return new Promise((resolve) => {
    const u = new URL(origin);
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request({ host: u.hostname, port: u.port || 443, path: pathname, method, rejectUnauthorized: false, timeout: 10000, agent: false });
    let checked = false;
    req.on('socket', (socket) => {
      socket.on('secureConnect', () => {
        const seen = String(socket.getPeerCertificate().fingerprint256 || '');
        const named = !!pin && seen.replace(/:/g, '').toLowerCase().startsWith(pin);
        if (!socket.authorized && !named && !(process.env.ORCH_KNOCK_PIN && seen === process.env.ORCH_KNOCK_PIN)) return req.destroy(new Error(pin ? 'PIN' : 'TRUST'));
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
          e.message === 'PIN'
            ? `The computer at ${u.host} is not the one this invitation was made for (its certificate is different). Nothing was sent to it.`
            : e.message === 'TRUST'
              ? `The office at ${u.host} has no certificate this computer trusts, so it cannot be asked by its address alone. Ask someone inside for an invitation link: it names the exact computer to trust.`
              : `Could not reach ${u.host}.`,
      }),
    );
  });
}

let knocking = null;
ipcMain.handle('orch:knock', async (_event, input) => {
  const origin = addressOf(input && input.address);
  const name = String((input && input.name) || '').trim().slice(0, 40);
  if (!origin) return { error: 'Type the address of the office, for example office.example.com — or paste an invitation link.' };
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

/**
 * An invitation link: its code is exchanged at the office's door, once, for what this computer keeps (where the
 * office is, which certificate is its own, and this person's credential). From then on it is a saved office.
 */
async function joinByLink(link) {
  const res = await askDoor(link.origin, 'POST', '/join', {}, { code: link.code }, link.pin);
  if (res.error) return { error: res.error };
  const said = res.json && typeof res.json.error === 'string' ? res.json.error : null;
  if (res.status === 410 || res.status === 429) return { error: said || 'This invitation link no longer works. Ask for a new one.' };
  if (res.status !== 200 || !res.json || !res.json.invite) return { error: `There is no Orchestrator office at ${new URL(link.origin).host}, or it is not open to people from outside.` };
  let invite;
  try {
    invite = parseInvite(res.json.invite);
  } catch (e) {
    return { error: e.message };
  }
  // The address the link names is known to work from here: try it first.
  return joinOffice({ ...invite, addresses: [link.origin, ...invite.addresses.filter((x) => x !== link.origin)] }, true);
}

ipcMain.handle('orch:join', async (_event, input) => {
  const link = linkOf(input && input.invite);
  if (link) return joinByLink(link);
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
      // (The office's address and the credential are asked for by the preload, over a channel that answers only
      // the office's own page: on a command line every other user of this computer could read them.)
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
  // The office never navigates away; a web address opens in the real browser, and nothing else is opened at all
  // (a page must not be able to make the system open a file, a share or another program).
  const inOffice = [target.url, process.env.ORCH_UI_DEV_URL].filter(Boolean);
  win.webContents.setWindowOpenHandler(({ url }) => {
    const web = externalUrl(url);
    if (web) void shell.openExternal(web);
    return { action: 'deny' };
  });
  for (const ev of ['will-navigate', 'will-redirect']) {
    win.webContents.on(ev, (e, url) => {
      if (!staysInOffice(url, inOffice)) e.preventDefault();
    });
  }
  // What the page is given when it asks the system for something: the microphone (talking), the clipboard
  // (terminals), the mouse, full screen, a choice of loudspeaker — and only the office's own page. Electron's
  // answer to everything is yes unless it is told otherwise.
  const ses = next.webContents.session;
  ses.setPermissionRequestHandler((wc, permission, done, details) => done(pageMay(permission, (details && details.requestingUrl) || (wc && !wc.isDestroyed() ? wc.getURL() : ''), details, inOffice)));
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => pageMay(permission, requestingOrigin || (wc && !wc.isDestroyed() ? wc.getURL() : ''), details, inOffice));
  // What the preload hands the page (see `orch:boot`).
  const wcId = next.webContents.id;
  boots.set(wcId, { serverUrl: target.url, token: target.token, tvPartition: tvPartition(target.url, target.pin), inOffice });
  next.webContents.once('destroyed', () => boots.delete(wcId));
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

/** The TV's storage of the office that is open now (each office has its own: see `tvPartition`). */
let tvPartitionNow = null;

/**
 * The TV in the office is a web browser inside the window (a <webview>). It is a guest: its own
 * storage partition, no Node, no preload, sandboxed, http(s) only. It cannot open windows, cannot
 * reach the office's own server, and is refused camera, microphone, location and notifications.
 * What it shows is sent to the page about once a second, so the TV in the 3D office shows the real picture.
 */
function setupTv(officeWin, target) {
  const partition = tvPartition(target.url, target.pin);
  tvPartitionNow = partition;
  const tv = session.fromPartition(partition);
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
    // Only this office's own TV storage: the page that embeds the TV controls it, and must not get at what a person
    // signed in to on the TV of another office.
    if (params.partition !== partition || !web(params.src)) event.preventDefault();
    webPreferences.partition = partition;
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
  if (!tvPartitionNow) return false;
  const tv = session.fromPartition(tvPartitionNow);
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

// Closed to be replaced by a newer build (`scripts/update-mac-app.mjs`, run by the person whose app this is, or at
// their word): SIGUSR2 quits the app the way "Leave" does, without the question — there is nobody at the dialog to
// answer it, and the app is opened again a moment later. Only the same user of this computer can send it, which is
// whoever could close the app anyway. Employees' sessions keep running in tmux, as at any quit.
if (process.platform !== 'win32') {
  process.on('SIGUSR2', () => {
    app.isQuitting = 'confirmed';
    if (win && !win.isDestroyed()) win.forceClose = true;
    app.quit();
  });
}
