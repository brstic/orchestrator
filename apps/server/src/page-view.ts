import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

/**
 * A page an employee made — an HTML file (payment slips with QR codes, a report with a chart), an SVG — shown as the
 * page it is, not as its source (the owner, 2026-11-24: "the accountant sent me HTML; we need a way to see the HTML
 * pages and the like that agents make"). `docs/ATTACHMENTS.md`, "Pages".
 *
 * Its file is served once a person who may open it asked for it: they get a ticket for that one file, good for a few
 * minutes, and the page is loaded from `/view/<ticket>/<name>` in a frame of the office's window. What the page is
 * allowed is set by its own response, not by the office's: it runs in a **sandbox** — an origin of its own, so it
 * reaches nothing of the office (no token, no storage, no window around it; the API it could call answers it as a
 * stranger) — with its scripts, styles, pictures and fonts, inline or from the web, as the pages agents write use
 * them. It cannot be framed by another site, and nothing it does leaves its frame but a link it opens in a new window.
 */
const TICKET_MS = 10 * 60_000;
const PAGE_MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.svg': 'image/svg+xml' };

/** Is this a file shown as a page (`/view`)? By its name. */
export function isPage(name: string): boolean {
  return path.extname(name).toLowerCase() in PAGE_MIME;
}

/** What a page may do, in its own frame. */
export const PAGE_POLICY = [
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-forms',
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: data: blob:",
  "style-src 'unsafe-inline' https: data:",
  'img-src https: http: data: blob:',
  'font-src https: data:',
  'media-src https: data: blob:',
  'connect-src https:',
  'frame-src https: data: blob:',
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

export class PageViews {
  private readonly tickets = new Map<string, { file: string; name: string; until: number }>();

  /** A ticket for this one file: the address its page is loaded from, for a few minutes. */
  issue(file: string, name: string): { url: string; until: string } {
    if (!isPage(name)) throw Object.assign(new Error('this file is not a page (.html, .htm, .svg)'), { statusCode: 400 });
    const now = Date.now();
    for (const [k, v] of this.tickets) if (v.until < now) this.tickets.delete(k);
    const ticket = crypto.randomBytes(24).toString('base64url');
    const until = now + TICKET_MS;
    this.tickets.set(ticket, { file, name, until });
    return { url: `/view/${ticket}/${encodeURIComponent(name)}`, until: new Date(until).toISOString() };
  }

  register(app: FastifyInstance): void {
    app.get('/view/:ticket/*', async (req, reply) => {
      const t = this.tickets.get(String((req.params as { ticket?: string }).ticket ?? ''));
      if (!t || t.until < Date.now() || !fs.existsSync(t.file)) return reply.code(404).type('text/plain').send('This page is no longer open here. Open it again from the office.');
      reply
        .header('content-type', PAGE_MIME[path.extname(t.name).toLowerCase()]!)
        .header('content-security-policy', PAGE_POLICY)
        .header('x-content-type-options', 'nosniff')
        .header('referrer-policy', 'no-referrer')
        .header('cache-control', 'no-store');
      return reply.send(fs.createReadStream(t.file));
    });
  }
}
