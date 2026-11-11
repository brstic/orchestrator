/**
 * The door: how other people reach an office that otherwise listens on this computer only.
 *
 * When it is open, a second listener runs on the network with TLS and a certificate made on this
 * computer. It forwards what a person's desktop app needs — the page, the owner API (where the
 * member's role decides what is allowed), the client WebSocket — and what that member's own
 * computer needs to take part: the agent WebSocket (personal hosts only) and the worker endpoint
 * (`/mcp`, per-session tokens). No downloads, no installer. Requests that came through the door
 * are marked, and the office never accepts its own owner token from there.
 *
 * Guests do not trust the certificate through a certificate authority; an invitation link to this
 * computer's own address carries the start of its fingerprint, and the joining app accepts exactly
 * that certificate. (Behind a reverse proxy with a certificate for the office's name, the app checks
 * that one the way a browser does.)
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface DoorStatus {
  open: boolean;
  port: number | null;
  /** Addresses of this computer on its networks, as https URLs. */
  addresses: string[];
  /** SHA-256 fingerprint of the door's certificate (what an invitation pins). */
  fingerprint: string | null;
  error: string | null;
}

/** What may pass. Everything else is answered 404 at the door. */
// `/mcp` is how a worker on a member's own computer talks to the office; it answers only to a session's own token.
const ALLOWED = [/^\/$/, /^\/index\.html$/, /^\/assets\/[A-Za-z0-9._-]+$/, /^\/favicon\.[a-z]+$/, /^\/healthz$/, /^\/api\/[^?#]*$/, /^\/mcp$/, /^\/knock(\/[A-Za-z0-9-]{1,64})?$/, /^\/join(\/[A-Za-z0-9.-]{1,80})?$/, /^\/login$/];
// `/ws/agent`: the office accepts only a member's own computer there when the connection comes through the door.
const ALLOWED_UPGRADE = /^\/ws\/(client|agent)$/;

export class Door {
  /** Sent with every forwarded request; the office uses it to know a request came from outside. */
  readonly secret = crypto.randomBytes(24).toString('hex');
  private server: https.Server | null = null;
  private port: number | null = null;
  private fingerprint: string | null = null;
  private error: string | null = null;
  private sockets = new Set<net.Socket>();
  private opts: { dataDir: string; hubPort: number; log: (level: 'info' | 'warn' | 'error', msg: string) => void };

  constructor(opts: Door['opts']) {
    this.opts = opts;
  }

  status(): DoorStatus {
    const addresses: string[] = [];
    if (this.server && this.port) {
      // Not the bridges of containers and virtual machines on this computer: nobody outside can reach those,
      // and an invitation full of them makes the joining app try each in turn.
      for (const [name, list] of Object.entries(os.networkInterfaces())) {
        if (/^(docker|br-|veth|virbr|cni|flannel|lxc|podman|vmnet|bridge\d)/.test(name)) continue;
        for (const a of list ?? []) if (!a.internal && a.family === 'IPv4') addresses.push(`https://${a.address}:${this.port}`);
      }
    }
    return { open: !!this.server, port: this.port, addresses, fingerprint: this.fingerprint, error: this.error };
  }

  /** The door's key and certificate, made once with the system's openssl and kept (mode 600) in the data folder. */
  private async certificate(): Promise<{ key: Buffer; cert: Buffer }> {
    const keyFile = path.join(this.opts.dataDir, 'door-key.pem');
    const certFile = path.join(this.opts.dataDir, 'door-cert.pem');
    if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
      await new Promise<void>((resolve, reject) =>
        execFile('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=Orchestrator office'], { timeout: 60_000 }, (err, _out, stderr) =>
          err ? reject(new Error(`could not create a certificate for the guest door (openssl is needed): ${String(stderr || err.message).trim().split('\n').pop()}`)) : resolve(),
        ),
      );
      fs.chmodSync(keyFile, 0o600);
    }
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }

  async open(port: number): Promise<DoorStatus> {
    if (this.server) {
      if (this.port === port) return this.status();
      await this.close();
    }
    this.error = null;
    try {
      const { key, cert } = await this.certificate();
      this.fingerprint = new crypto.X509Certificate(cert).fingerprint256;
      const server: https.Server = https.createServer({ key, cert }, (req, res) => this.forward(req, res));
      server.on('upgrade', (req, socket, head) => this.upgrade(req, socket as net.Socket, head));
      server.on('secureConnection', (s: net.Socket) => {
        this.sockets.add(s);
        s.on('close', () => this.sockets.delete(s));
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => resolve());
      });
      this.server = server;
      this.port = (server.address() as net.AddressInfo).port;
      this.opts.log('info', `guest door open on port ${this.port} (certificate ${this.fingerprint.slice(0, 23)}…)`);
    } catch (e) {
      this.error = (e as NodeJS.ErrnoException).code === 'EADDRINUSE' ? `port ${port} is already in use on this computer` : (e as Error).message;
      this.server = null;
      this.port = null;
      throw new Error(this.error);
    }
    return this.status();
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.opts.log('info', 'guest door closed');
  }

  private headers(req: http.IncomingMessage): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    // Whatever the caller claims, the mark is ours; and the office sees who is really calling.
    delete headers['x-orch-door'];
    headers['x-orch-door'] = this.secret;
    // Behind a reverse proxy on this same computer the caller is the proxy; the address it reports (the last one
    // in its list — the one it saw itself) is who is really calling. From anywhere else, only the socket counts.
    const peer = req.socket.remoteAddress ?? '';
    const reported = String(req.headers['x-forwarded-for'] ?? '').split(',').pop()!.trim();
    headers['x-forwarded-for'] = /^(127\.|::1$|::ffff:127\.)/.test(peer) && /^[0-9a-fA-F:.]{3,45}$/.test(reported) ? reported : peer;
    headers.host = `127.0.0.1:${this.opts.hubPort}`;
    return headers;
  }

  private forward(req: http.IncomingMessage, res: http.ServerResponse): void {
    const pathname = (req.url ?? '/').split('?')[0]!;
    if (!ALLOWED.some((re) => re.test(pathname)) || pathname.includes('..')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify({ error: 'not available through the guest door' }));
    }
    const upstream = http.request({ host: '127.0.0.1', port: this.opts.hubPort, method: req.method, path: req.url, headers: this.headers(req) }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'the office is not answering' }));
    });
    req.pipe(upstream);
  }

  private upgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const pathname = (req.url ?? '/').split('?')[0]!;
    if (!ALLOWED_UPGRADE.test(pathname)) return void socket.destroy();
    const upstream = net.connect(this.opts.hubPort, '127.0.0.1', () => {
      const headers = this.headers(req);
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`) : v === undefined ? [] : [`${k}: ${v}`]))];
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    const end = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', end);
    socket.on('error', end);
    upstream.on('close', end);
    socket.on('close', end);
  }
}

/**
 * Everything a member's app keeps about an office, in one string: its addresses, the certificate to trust and
 * the member's credential. The app is handed this when an invitation link is used or a knock is answered; an
 * office that has no address set still gives it out directly, as an invitation to paste.
 */
export function inviteCode(input: { office: string; guest: string; role: string; token: string; addresses: string[]; fingerprint: string }): string {
  const json = JSON.stringify({ n: input.office, g: input.guest, r: input.role, t: input.token, a: input.addresses, f: input.fingerprint });
  return `orch-invite-v1.${Buffer.from(json, 'utf8').toString('base64url')}`;
}
