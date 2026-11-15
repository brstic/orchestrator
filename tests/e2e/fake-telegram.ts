/**
 * TEST FIXTURE — a stand-in for Telegram's Bot API, for the employees' bots (`docs/TELEGRAM.md`).
 *
 * It knows the bots it is told of (`bot`), hands out the updates a test puts in (`message`, `press`, `added`) through
 * `getUpdates` — waiting for one, as Telegram's long polling does — and keeps everything a bot sent (`sent`).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Sent {
  token: string;
  method: string;
  body: Record<string, any>;
  messageId: number | null;
}

export interface FakeTelegram {
  url: string;
  sent: Sent[];
  /** A bot this stand-in knows: its token, id and name; whether its privacy mode is off. */
  bot(token: string, id: number, username: string, hearsAll?: boolean): void;
  /** A message from a person, in a private chat (chat = person) or a group (`chat` given). Returns its message id. */
  message(token: string, from: { id: number; first_name: string; username?: string }, text: string, more?: { chat?: { id: number; type: 'group' | 'supergroup'; title: string }; replyTo?: { message_id: number; from: { id: number } }; photo?: boolean }): number;
  press(token: string, from: { id: number; first_name: string }, data: string): void;
  added(token: string, chat: { id: number; title: string }, status?: 'member' | 'left'): void;
  /** Wait for something a bot sent that fits. */
  waitSent(pred: (s: Sent) => boolean, ms?: number): Promise<Sent>;
  close(): Promise<void>;
}

export async function fakeTelegram(): Promise<FakeTelegram> {
  const bots = new Map<string, { id: number; username: string; hearsAll: boolean }>();
  const queues = new Map<string, Array<Record<string, any>>>();
  const waiters = new Map<string, Array<() => void>>();
  const sent: Sent[] = [];
  let nextUpdate = 1;
  let nextMessage = 1000;
  const push = (token: string, u: Record<string, any>) => {
    (queues.get(token) ?? queues.set(token, []).get(token)!).push({ update_id: nextUpdate++, ...u });
    for (const w of waiters.get(token) ?? []) w();
    waiters.set(token, []);
  };
  const server = http.createServer(async (req, res) => {
    const reply = (status: number, j: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(j));
    };
    const file = /^\/file\/bot([^/]+)\/(.+)$/.exec(req.url ?? '');
    if (file) {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]));
    }
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? '');
    let raw = '';
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    if (!m) return reply(404, { ok: false, error_code: 404, description: 'Not Found' });
    const [, token, method] = m as unknown as [string, string, string];
    const bot = bots.get(token);
    if (!bot) return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    if (method === 'getMe') return reply(200, { ok: true, result: { id: bot.id, is_bot: true, first_name: `${bot.username} bot`, username: bot.username, can_read_all_group_messages: bot.hearsAll } });
    if (method === 'getUpdates') {
      const offset = Number(body.offset ?? 0);
      const ready = () => (queues.get(token) ?? []).filter((u) => u.update_id >= offset);
      if (!ready().length) await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(Number(body.timeout ?? 0), 5) * 1000);
        (waiters.get(token) ?? waiters.set(token, []).get(token)!).push(() => (clearTimeout(t), r()));
      });
      return reply(200, { ok: true, result: ready() });
    }
    if (method === 'getFile') return reply(200, { ok: true, result: { file_id: body.file_id, file_path: `photos/${body.file_id}.jpg`, file_size: 10 } });
    const messageId = method === 'sendMessage' ? nextMessage++ : null;
    sent.push({ token, method, body, messageId });
    return reply(200, { ok: true, result: method === 'sendMessage' ? { message_id: messageId, chat: { id: body.chat_id }, text: body.text } : true });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    sent,
    bot: (token, id, username, hearsAll = true) => void bots.set(token, { id, username, hearsAll }),
    message: (token, from, text, more = {}) => {
      const id = nextMessage++;
      const chat = more.chat ?? { id: from.id, type: 'private' as const, first_name: from.first_name };
      push(token, { message: { message_id: id, from: { is_bot: false, ...from }, chat, date: Math.floor(Date.now() / 1000), ...(more.photo ? { photo: [{ file_id: `ph${id}`, file_size: 10, width: 1, height: 1 }], caption: text } : { text }), ...(more.replyTo ? { reply_to_message: more.replyTo } : {}) } });
      return id;
    },
    press: (token, from, data) => push(token, { callback_query: { id: `cb${nextUpdate}`, from, data } }),
    added: (token, chat, status = 'member') => push(token, { my_chat_member: { chat: { ...chat, type: 'group' }, new_chat_member: { status } } }),
    waitSent: async (pred, ms = 30_000) => {
      const end = Date.now() + ms;
      for (;;) {
        const hit = sent.find(pred);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`nothing sent that fits, in ${ms} ms; sent: ${JSON.stringify(sent.map((s) => [s.method, s.body.chat_id, String(s.body.text ?? '').slice(0, 60)])).slice(0, 1500)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
