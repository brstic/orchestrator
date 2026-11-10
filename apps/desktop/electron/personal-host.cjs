/**
 * This computer's place in an office someone else hosts.
 *
 * While a member (a colleague or an owner) has an office open, the app runs a host agent here:
 * the same agent a shared machine runs, enrolled as this member's own computer. Claude Code
 * sessions started through it run on this computer, in this person's folders, and sit in their
 * room in the office. Closing the office stops the agent; the tmux sessions stay and are picked
 * up again next time.
 *
 * The office's door has a certificate made on the host's machine, which neither the agent nor
 * Claude Code's MCP client would trust. So both talk to a relay on this computer's loopback
 * instead; the relay connects to the office and accepts exactly the certificate the invitation
 * named. It forwards two things and nothing else: the agent's WebSocket and the worker endpoint.
 */
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');

/** A server name for TLS: not sent when the office is addressed by IP (an IP is not a valid one). */
const sni = (hostname) => (net.isIP(hostname) ? {} : { servername: hostname });

const FORWARD_HTTP = /^\/(mcp|healthz)$/;
const FORWARD_UPGRADE = /^\/ws\/agent$/;

/** A TLS connection to the office that exists only if the certificate is the pinned one. */
function connectPinned(office, fingerprint) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: office.hostname, port: Number(office.port) || 443, ...sni(office.hostname), rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
    socket.setTimeout(10000, () => socket.destroy(new Error('the office did not answer')));
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      if (socket.getPeerCertificate().fingerprint256 !== fingerprint) return socket.destroy(new Error('the certificate at that address is not the one from the invitation'));
      socket.setTimeout(0);
      socket.removeListener('error', reject);
      resolve(socket);
    });
  });
}

/**
 * An HTTPS request to the office that is sent only once the certificate has been checked against the pinned one.
 * `send(req)` writes the body and ends the request.
 */
function requestPinned(office, fingerprint, options, send, onResponse, onError) {
  const req = https.request({ host: office.hostname, port: Number(office.port) || 443, ...sni(office.hostname), rejectUnauthorized: false, agent: false, timeout: 60000, ...options });
  req.on('socket', (socket) =>
    socket.once('secureConnect', () => {
      if (socket.getPeerCertificate().fingerprint256 !== fingerprint) return req.destroy(new Error('the certificate at that address is not the one from the invitation'));
      send(req);
    }),
  );
  req.on('timeout', () => req.destroy(new Error('the office did not answer')));
  req.on('response', onResponse);
  req.on('error', onError);
}

const head = (first, headers) => `${[first, ...Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v === undefined ? [] : [`${k}: ${v}`]))].join('\r\n')}\r\n\r\n`;

/** The relay: plain HTTP on this computer only, pinned TLS to the office. Resolves to { port, close }. */
function startRelay(address, fingerprint) {
  const office = new URL(address);
  const sockets = new Set();
  const pipeTo = async (client, firstLine, headers, body) => {
    let upstream;
    try {
      upstream = await connectPinned(office, fingerprint);
    } catch (e) {
      client.end(`HTTP/1.1 502 Bad Gateway\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n${JSON.stringify({ error: `this computer could not reach the office: ${e.message}` })}`);
      return;
    }
    sockets.add(upstream);
    const end = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(upstream);
    };
    upstream.on('error', end);
    client.on('error', end);
    upstream.on('close', end);
    client.on('close', end);
    upstream.write(head(firstLine, { ...headers, host: office.host }));
    if (body && body.length) upstream.write(body);
    client.pipe(upstream);
    upstream.pipe(client);
  };
  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (!FORWARD_HTTP.test(pathname)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: 'not forwarded' }));
    }
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () =>
      requestPinned(
        office,
        fingerprint,
        { method: req.method, path: req.url, headers: { ...req.headers, host: office.host, connection: 'close' } },
        (up) => up.end(Buffer.concat(chunks)),
        (up) => {
          res.writeHead(up.statusCode || 502, up.headers);
          up.pipe(res);
        },
        (e) => {
          if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `this computer could not reach the office: ${e.message}` }));
        },
      ),
    );
  });
  server.on('upgrade', (req, socket, first) => {
    const pathname = (req.url || '/').split('?')[0];
    if (!FORWARD_UPGRADE.test(pathname)) return void socket.destroy();
    void pipeTo(socket, `${req.method} ${req.url} HTTP/1.1`, req.headers, first);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close: () => {
          for (const s of sockets) s.destroy();
          server.close();
        },
      }),
    );
  });
}

/** One request to the office's API through a pinned connection (the token is sent only after the certificate is checked). */
function askOffice(address, fingerprint, token, method, route, body) {
  const payload = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) =>
    requestPinned(
      new URL(address),
      fingerprint,
      { method, path: `/api${route}`, timeout: 15000, headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } },
      (req) => {
        req.setHeader('authorization', `Bearer ${token}`);
        req.end(payload);
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode, body: json });
        });
      },
      reject,
    ),
  );
}

/** Where this computer keeps what it needs for one office (keyed by the office's certificate, so two offices never mix). */
const homeFor = (fingerprint) => path.join(process.env.ORCH_OFFICES_HOME || path.join(os.homedir(), '.orchestrator', 'offices'), crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 16), 'agent');

/**
 * Start this computer's host in an office. `onState` is told { state, reason, hostId } as things change:
 *   starting → online          the room is there
 *   unavailable                this computer cannot host sessions (says why); the office still works
 *   stopped
 */
function startPersonalHost({ address, token, fingerprint, node, agentEntry, PATH, onState }) {
  let stopped = false;
  let relay = null;
  let child = null;
  let state = { state: 'starting', reason: null, hostId: null };
  const set = (next) => {
    state = { ...state, ...next };
    try {
      onState(state);
    } catch {
      /* the window is gone */
    }
  };
  const env = { ...process.env, PATH };
  const home = homeFor(fingerprint);
  const config = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    } catch {
      return null;
    }
  };

  const enroll = async (server) => {
    const res = await askOffice(address, fingerprint, token, 'POST', '/me/host', {});
    if (res.status !== 200 || !res.body || !res.body.token) throw new Error((res.body && res.body.error) || `the office refused (${res.status})`);
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    // Not spawnSync: the relay the login goes through lives in this very process and must keep answering.
    await new Promise((resolve, reject) => {
      let out = '';
      const login = spawn(node, ['--disable-warning=ExperimentalWarning', agentEntry, 'login', '--server', server, '--token', res.body.token], { env: { ...env, ORCH_AGENT_HOME: home }, cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'] });
      login.stdout.on('data', (d) => (out += d));
      login.stderr.on('data', (d) => (out += d));
      login.on('error', reject);
      login.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`this computer could not be enrolled: ${out.trim().split('\n').pop()}`))));
    });
  };

  /** For the automated tests only: a tmux server and a worker binary of their own, so a test never touches a person's sessions. */
  const applyTestKnobs = () => {
    if (!process.env.ORCH_TMUX_SOCKET && !process.env.ORCH_CLAUDE_BIN && !process.env.ORCH_ALLOW_ROOT) return;
    const cfg = config();
    if (!cfg) return;
    if (process.env.ORCH_TMUX_SOCKET) cfg.tmuxSocketName = process.env.ORCH_TMUX_SOCKET;
    if (process.env.ORCH_CLAUDE_BIN) cfg.claudeBin = process.env.ORCH_CLAUDE_BIN;
    if (process.env.ORCH_ALLOW_ROOT) cfg.allowedRoots = [process.env.ORCH_ALLOW_ROOT];
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  };

  const run = (server, retried) => {
    if (stopped) return;
    applyTestKnobs();
    const started = Date.now();
    let err = '';
    child = spawn(node, ['--disable-warning=ExperimentalWarning', agentEntry, 'connect', '--server', server, '--quiet'], { env: { ...env, ORCH_AGENT_HOME: home }, cwd: os.homedir(), stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    // The agent has no "connected" line to wait for; the office itself shows the host online. Give it a moment, then say so.
    const up = setTimeout(() => !stopped && child && set({ state: 'online', reason: null, hostId: (config() || {}).hostId || null }), 1500);
    child.on('exit', async (code) => {
      clearTimeout(up);
      child = null;
      if (stopped) return;
      // Exit code 2: the office does not know this computer any more (revoked, or a new office database). Enroll again, once.
      if (code === 2 && !retried && Date.now() - started < 20000) {
        try {
          fs.rmSync(path.join(home, 'config.json'), { force: true });
          await enroll(server);
          return run(server, true);
        } catch (e) {
          return set({ state: 'unavailable', reason: e.message });
        }
      }
      set({ state: 'unavailable', reason: `The host agent on this computer stopped (${code}). ${err.trim().split('\n').pop() || ''}`.trim() });
    });
  };

  (async () => {
    try {
      if (process.platform === 'win32') throw new Error('Claude Code workers run in tmux, which Windows does not have. You can use everything shared in this office; sessions on this computer need macOS, Linux or WSL2.');
      if (!node) throw new Error('Sessions on this computer need Node.js 22.18 or newer.');
      if (spawnSync('tmux', ['-V'], { env, stdio: 'ignore' }).status !== 0) throw new Error('Sessions on this computer need tmux (macOS: brew install tmux; Linux: your package manager).');
      relay = await startRelay(address, fingerprint);
      if (stopped) return relay.close();
      const server = `http://127.0.0.1:${relay.port}`;
      if (!(config() || {}).credential) await enroll(server);
      if (stopped) return;
      run(server, false);
    } catch (e) {
      set({ state: 'unavailable', reason: e.message });
    }
  })();

  return {
    state: () => state,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (child) child.kill('SIGTERM');
      if (relay) relay.close();
      set({ state: 'stopped', reason: null });
    },
  };
}

module.exports = { startPersonalHost, startRelay, askOffice, homeFor };
