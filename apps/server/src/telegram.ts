/**
 * An employee's own Telegram bot: talk to them from your phone (`docs/TELEGRAM.md`).
 *
 * Each employee may have a bot of their own (made with @BotFather; its token is pasted into their profile). The office
 * reads the bot's messages itself — long polling, so nothing on the server or the router is opened — and:
 *
 *   - lets in only the people who paired with it, each with a one-time link (`pair`) made by somebody who may work with
 *     that employee; anybody else is told the bot is private. Every message checks again that the person still may;
 *   - delivers what they write (and the pictures and files they send) into the employee's real session, as a message
 *     from that person — starting the session first if nobody is at the desk — shows "typing…" while the employee works
 *     on it, and sends back what the employee says when the turn ends;
 *   - sends the employee's questions and permission requests there too, with buttons, and answers them as that person;
 *   - `/status` says what the employee is doing, `/help` what the bot does.
 *
 *   - takes part in groups it was added to with a one-time group link (`?startgroup=`): there it answers when it is
 *     talked to — a mention, its name as a word, a reply to it, or a follow-up from the person it just answered — or,
 *     in a group set to "everything", is handed what was said once the conversation pauses and decides itself whether
 *     to say anything (`NO_REPLY` posts nothing). The last messages of the group go with it as context. A group nobody
 *     connected is told the bot is private, and the bot leaves.
 *
 * The token is kept under the vault's key (`Vault.seal`); it is never sent to a window, an event or a log.
 */
import crypto from 'node:crypto';
import { EngineError, type Engine } from '@orchestrator/orchestration';
import type { Notification, Question } from '@orchestrator/contracts';
import { ACTIVITY_LABEL, notificationFor } from '@orchestrator/contracts';
import type { Storage } from '@orchestrator/database';

/** Who may use an employee's bot is decided as for anything else in the office: by the server (`access.ts`). */
export interface TelegramPerson {
  /** The member's id ('owner' for the office's own owner) and how they are named to the employee. */
  id: string;
  name: string;
  /** An owner of the office (else a colleague): how the employee is told who is speaking. */
  owner: boolean;
}

interface Paired {
  /** Telegram's user and chat (the same number in a private chat), and how Telegram names them. */
  tgId: number;
  chatId: number;
  name: string;
  username: string | null;
  /** Who in the office this is: the person who made the link they paired with. */
  as: TelegramPerson;
  since: string;
}

/** A Telegram group the employee takes part in, connected by somebody who may work with them. */
interface Group {
  chatId: number;
  title: string;
  /** Who connected it: the group speaks with that person's say in the office. */
  as: TelegramPerson;
  /** 'addressed': only what is said to them (a mention, their name, a reply to them, a follow-up); 'all': everything, and they decide. */
  mode: 'addressed' | 'all';
  since: string;
}

interface Bot {
  employeeId: string;
  /** The token, under the vault's key. */
  sealed: string;
  botId: number;
  username: string;
  name: string;
  /** The next update to ask Telegram for. */
  offset: number;
  people: Paired[];
  /** Send the employee's questions and permission requests to Telegram too. */
  questions: boolean;
  /** A pairing link waiting to be used: the hash of its code, until when, and who made it. */
  pairing: { hash: string; until: number; by: TelegramPerson } | null;
  /** What went wrong with the bot, in words for a person (null: nothing). */
  error: string | null;
  /** Groups the bot takes part in. */
  groups: Group[];
  /** Telegram lets the bot read every message of a group (its privacy mode is off). Else only mentions and replies. */
  hearsAll: boolean;
}

/** What a window is shown of an employee's bot: never the token. */
export interface TelegramView {
  connected: boolean;
  bot: { username: string; name: string; link: string } | null;
  people: Array<{ tgId: number; name: string; username: string | null; as: string; since: string }>;
  questions: boolean;
  error: string | null;
  /** Until when the last pairing link works, while one is waiting (`pair` makes one, and shows it once). */
  pairing: { until: string } | null;
  groups: Array<{ chatId: number; title: string; as: string; mode: 'addressed' | 'all'; since: string }>;
  /** False: in a group the bot sees only mentions and replies (its privacy mode is on, in @BotFather). */
  hearsAll: boolean;
}

export const TELEGRAM_LIMITS = {
  /** A pairing link works once, for this long. */
  pairingMs: 10 * 60_000,
  /** Telegram's limit for one message's text. */
  textChars: 4096,
  /** What a file from Telegram may be (Telegram's own limit for a bot to fetch is 20 MB). */
  fileBytes: 20 * 1024 * 1024,
  /** "typing…" is shown at most this long for one message. */
  typingMs: 15 * 60_000,
};

const STORE_KEY = 'telegram.bots';
const TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

/** A long text in Telegram-sized pieces, cut at a paragraph or a line where it can be. */
export function pieces(text: string, size = TELEGRAM_LIMITS.textChars - 96): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    const cut = Math.max(rest.lastIndexOf('\n\n', size), rest.lastIndexOf('\n', size), rest.lastIndexOf(' ', size));
    const at = cut > size / 2 ? cut : size;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out.length ? out : [''];
}

/** What a `/start` carries after it (the pairing code), if anything. */
export function startPayload(text: string): string | null {
  const m = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text.trim());
  return m ? (m[1] ?? '') : null;
}

const hash = (code: string) => crypto.createHash('sha256').update(code).digest('hex');

/** In a group that sends them everything, what is said is handed over once the conversation pauses this long. */
export const GATHER_MS = 8000;
/** A follow-up from the person they just answered counts as said to them for this long. */
export const FOLLOW_UP_MS = 3 * 60_000;

/**
 * Is a message in a group said to the employee? A mention of the bot, their name as a word, a reply to one of the
 * bot's messages, or a follow-up from the person they just answered.
 */
export function addressedTo(m: { text: string; botUsername: string; botId: number; name: string; replyToFrom: number | null; entities: Array<{ type: string; offset: number; length: number; user?: { id: number } }>; from: number; lastAnswer: { to: number; at: number } | null; now?: number }): boolean {
  const text = m.text.toLowerCase();
  if (text.includes(`@${m.botUsername.toLowerCase()}`)) return true;
  if (m.entities.some((e) => e.type === 'text_mention' && e.user?.id === m.botId)) return true;
  if (m.replyToFrom === m.botId) return true;
  const first = m.name.trim().split(/\s+/)[0]?.toLowerCase();
  if (first && first.length >= 2) {
    const escaped = first.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
    if (new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'u').test(text)) return true;
  }
  const now = m.now ?? Date.now();
  return !!m.lastAnswer && m.lastAnswer.to === m.from && now - m.lastAnswer.at < FOLLOW_UP_MS;
}

/** What the employee is given from a group: the conversation so far, and what is for them (or all of it, to judge). */
export interface Heard {
  who: string;
  text: string;
  /** Telegram's message id in that chat (0 when not known): what `[reply #id]` points at. */
  id: number;
}
const line = (h: Heard) => `${h.id ? `#${h.id} ` : ''}${h.who}: ${h.text}`;
/** As a window shows it: who said what, without the numbers. */
const plain = (hs: Heard[]) => hs.map((h) => `${h.who}: ${h.text}`).join('\n');

/**
 * What the employee is given from a group: where it is, what was said there that they have not seen yet (all of the
 * recent chat the first time, in a conversation of theirs), what is for them — or, in a group that sends everything,
 * what is new, for them to judge — and how to answer. Every line carries its number, for `[reply #n]`.
 */
export function groupPrompt(g: { group: string; me: string; earlier: Heard[]; first: boolean; who: string | null; new: Heard[]; everything: boolean }): string {
  const lines = [`On Telegram, in the group "${g.group}" — you are ${g.me} there.`];
  if (g.earlier.length) lines.push('', g.first ? 'Earlier in the chat:' : 'Meanwhile in the chat:', ...g.earlier.map(line));
  if (g.everything) lines.push('', 'New:', ...g.new.map(line));
  else lines.push('', `${g.who} to you:`, ...g.new.map(line));
  lines.push(
    '',
    (g.everything ? '(You follow this chat; nobody may be talking to you. Say something only if it is for you or you have something useful to add — otherwise reply exactly NO_REPLY. ' : '(') +
      'Your reply is posted in the group as a chat message: short and plain, as people write there. When it answers one message in particular — a question asked earlier, one of several people — start it with [reply #n] and it goes as a reply to that one; otherwise just write.)',
  );
  return lines.join('\n');
}

/** What the employee said, and whether they chose to post it as a reply to one message (`[reply #id]` at the start; only an id that chat has). */
export function answerOf(said: string, known: ReadonlySet<number>): { text: string; replyTo: number | null } {
  const m = /^\s*\[reply #(\d+)\]\s*/i.exec(said);
  if (!m) return { text: said.trim(), replyTo: null };
  const id = Number(m[1]);
  return { text: said.slice(m[0].length).trim(), replyTo: known.has(id) ? id : null };
}

/** How a message from a group is named to the employee. */
function groupFrom(who: string | null, g: { title: string; as: TelegramPerson }, as: TelegramPerson): string {
  return `${who ?? 'the people'} in the Telegram group "${g.title}" (connected by ${as.id === 'owner' ? 'the boss' : as.name})`;
}

export interface TelegramDeps {
  engine: Engine;
  store: Storage;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Telegram's Bot API (tests point this at a stand-in). */
  api: string;
  /** How long one `getUpdates` waits for something (s). */
  pollSeconds: number;
  /** May this person (an id as in `TelegramPerson`) still work with this employee? Asked on every message. */
  mayWork: (personId: string, employeeId: string) => TelegramPerson | null;
  /**
   * Is this person in the office now (a window of theirs in front and used)? Then questions, requests and messages to
   * them stay in the office; if they leave while one is still open or unread, it is sent then. Absent: never.
   */
  here?: (personId: string) => boolean;
  /** How often what was kept back is looked at again (default `HELD_SWEEP_MS`). */
  heldSweepMs?: number;
}

/** How often what was kept back while somebody was in the office is looked at again. */
const HELD_SWEEP_MS = 30_000;
/** A message to a person kept back while they were in the office goes to Telegram later only while this fresh. */
const HELD_MESSAGE_MS = 2 * 3600_000;

export class Telegram {
  private bots = new Map<string, Bot>();
  private loops = new Map<string, AbortController>();
  /** Chats waiting for what an employee says when the current turn ends, and their "typing…" timers. */
  private waiting = new Map<string, { chats: Map<number, { replyTo: number | null; group: boolean }>; since: number; timer: NodeJS.Timeout }>();
  /** What was said lately in each group (for context), and whom the employee last answered there, when. */
  private heard = new Map<number, Array<Heard & { at: number }>>();
  private lastAnswer = new Map<number, { to: number; at: number }>();
  /** In a group that sends them everything: what has come since the last delivery, and the timer that delivers it. */
  private gathering = new Map<number, { lines: Heard[]; replyTo: number; timer: NodeJS.Timeout; first: number }>();
  /** Questions sent to Telegram: where, so the message can say when it was answered. */
  private sent = new Map<string, Array<{ employeeId: string; chatId: number; messageId: number; text: string }>>();
  /** Which Telegram message stands for which question (a reply to it answers the question). */
  private replyTo = new Map<string, string>();
  /** When somebody unknown was last told the bot is private (so they are told once in a while, not every time). */
  private toldPrivate = new Map<number, number>();
  private closed = false;
  private readonly deps: TelegramDeps;

  constructor(deps: TelegramDeps) {
    this.deps = deps;
    const saved = deps.store.kvGet<Record<string, Bot>>(STORE_KEY, {});
    for (const b of Object.values(saved)) if (deps.engine.core.employees.get(b.employeeId)) this.bots.set(b.employeeId, b);
    const core = deps.engine.core;
    core.bus.on('event', (e: { type: string; employeeId: string | null; data: Record<string, unknown> }) => {
      if (e.type === 'agent.turn_finished' && e.employeeId) void this.turnEnded(e.employeeId, String(e.data?.lastMessage ?? ''));
    });
    core.bus.on('entity', (kind: string, op: string, data: unknown) => {
      if (kind === 'question' && op === 'upsert') void this.question(data as Question);
      if (kind === 'notification' && op === 'upsert') void this.personMessage(data as Notification);
      if (kind === 'employee' && op === 'remove') void this.disconnect((data as { id: string }).id);
    });
  }

  start(): void {
    for (const id of this.bots.keys()) this.listen(id);
    this.sweep = setInterval(() => this.sendHeld(), this.deps.heldSweepMs ?? HELD_SWEEP_MS);
    this.sweep.unref?.();
  }

  /** Questions and messages kept back while somebody was in the office (`here`), to send once they have left. */
  private readonly heldQuestions = new Set<string>();
  private readonly heldMessages = new Set<string>();
  private sweep: NodeJS.Timeout | null = null;

  private isHere(personId: string): boolean {
    return this.deps.here?.(personId) === true;
  }

  /** Whoever left the office meanwhile gets on Telegram what is still open, or still unread, for them. */
  sendHeld(): void {
    const core = this.deps.engine.core;
    const questions = [...this.heldQuestions];
    this.heldQuestions.clear();
    for (const id of questions) {
      const q = core.questions.get(id);
      if (q && q.status === 'open') void this.question(q);
    }
    const messages = [...this.heldMessages];
    this.heldMessages.clear();
    for (const id of messages) {
      const n = core.notifications.get(id);
      if (n && !n.readAt && !n.resolvedAt && Date.now() - Date.parse(n.createdAt) < HELD_MESSAGE_MS) void this.personMessage(n, true);
    }
  }

  close(): void {
    this.closed = true;
    if (this.sweep) clearInterval(this.sweep);
    for (const c of this.loops.values()) c.abort();
    for (const w of this.waiting.values()) clearInterval(w.timer);
  }

  // ───────────── what a window does ─────────────

  view(employeeId: string): TelegramView {
    const b = this.bots.get(employeeId);
    if (!b) return { connected: false, bot: null, people: [], questions: true, error: null, pairing: null, groups: [], hearsAll: false };
    const pairing = b.pairing && b.pairing.until > Date.now() ? b.pairing : null;
    return {
      connected: true,
      bot: { username: b.username, name: b.name, link: `https://t.me/${b.username}` },
      people: b.people.map((p) => ({ tgId: p.tgId, name: p.name, username: p.username, as: p.as.name, since: p.since })),
      questions: b.questions,
      error: b.error,
      // (The code itself is never kept: a link is shown once, when it is made.)
      pairing: pairing ? { until: new Date(pairing.until).toISOString() } : null,
      groups: (b.groups ?? []).map((g) => ({ chatId: g.chatId, title: g.title, as: g.as.name, mode: g.mode, since: g.since })),
      hearsAll: !!b.hearsAll,
    };
  }

  /** Give an employee a bot (or another one): checked with Telegram, kept under the vault's key, listened to at once. */
  async connect(employeeId: string, token: string, by: TelegramPerson): Promise<TelegramView> {
    const employee = this.deps.engine.core.employees.require(employeeId);
    const t = token.trim();
    if (!TOKEN.test(t)) throw this.error('That does not look like a bot token. It is what @BotFather gives you after /newbot: numbers, a colon, then about 35 letters and digits.');
    const me = await this.call<{ id: number; username: string; first_name: string; is_bot: boolean; can_read_all_group_messages?: boolean }>(t, 'getMe', {}).catch((e: Error) => {
      throw this.error(/401|404|Unauthorized|Not Found/.test(e.message) ? 'Telegram does not know this token. Copy it again from @BotFather (or make a new one with /token).' : `Telegram could not be reached: ${e.message}`);
    });
    const other = [...this.bots.values()].find((x) => x.botId === me.id && x.employeeId !== employeeId);
    if (other) throw this.error(`This bot already belongs to ${this.deps.engine.core.employees.get(other.employeeId)?.name ?? 'another employee'}. Each employee needs a bot of their own: make another one with @BotFather.`);
    // Long polling only works while the bot has no webhook.
    await this.call(t, 'deleteWebhook', { drop_pending_updates: false }).catch(() => undefined);
    this.stop(employeeId);
    const before = this.bots.get(employeeId);
    const same = before?.botId === me.id;
    const bot: Bot = { employeeId, sealed: this.deps.engine.vault.seal(t, `telegram:${employeeId}`), botId: me.id, username: me.username, name: me.first_name, offset: same ? before!.offset : 0, people: same ? before!.people : [], questions: before?.questions ?? true, pairing: null, error: null, groups: same ? (before!.groups ?? []) : [], hearsAll: !!me.can_read_all_group_messages };
    this.bots.set(employeeId, bot);
    this.save();
    this.deps.engine.core.audit(by.id === 'owner' ? 'owner' : `member:${by.name}`, 'telegram.connected', employeeId, { employee: employee.name, bot: `@${me.username}` });
    this.listen(employeeId);
    return this.view(employeeId);
  }

  /** A link that pairs one Telegram account with this employee's bot, as `by`: works once, for ten minutes. */
  pair(employeeId: string, by: TelegramPerson): { link: string; groupLink: string; until: string } {
    const b = this.require(employeeId);
    const code = crypto.randomBytes(18).toString('base64url');
    b.pairing = { hash: hash(code), until: Date.now() + TELEGRAM_LIMITS.pairingMs, by };
    this.save();
    // The same code pairs a phone (?start) or connects a group the bot is added to (?startgroup).
    return { link: `https://t.me/${b.username}?start=${code}`, groupLink: `https://t.me/${b.username}?startgroup=${code}`, until: new Date(b.pairing.until).toISOString() };
  }

  /** Ask Telegram again what the bot may read in groups (after its privacy mode was changed in @BotFather). */
  async refresh(employeeId: string): Promise<TelegramView> {
    const b = this.require(employeeId);
    const me = await this.call<{ can_read_all_group_messages?: boolean }>(this.token(b), 'getMe', {});
    b.hearsAll = !!me.can_read_all_group_messages;
    this.save();
    return this.view(employeeId);
  }

  group(employeeId: string, chatId: number, input: { mode?: unknown }): TelegramView {
    const g = (this.require(employeeId).groups ?? []).find((x) => x.chatId === chatId);
    if (!g) throw this.error('That group is not connected.', 404);
    if (input.mode === 'addressed' || input.mode === 'all') g.mode = input.mode;
    this.save();
    return this.view(employeeId);
  }

  async leaveGroup(employeeId: string, chatId: number, by: TelegramPerson): Promise<TelegramView> {
    const b = this.require(employeeId);
    const g = (b.groups ?? []).find((x) => x.chatId === chatId);
    b.groups = (b.groups ?? []).filter((x) => x.chatId !== chatId);
    this.save();
    if (g) {
      await this.send(b, chatId, `${this.nameOf(employeeId)} is leaving this group.`).catch(() => undefined);
      await this.call(this.token(b), 'leaveChat', { chat_id: chatId }).catch(() => undefined);
      this.deps.engine.core.audit(by.id === 'owner' ? 'owner' : `member:${by.name}`, 'telegram.group_left', employeeId, { group: g.title });
    }
    return this.view(employeeId);
  }

  settings(employeeId: string, input: { questions?: unknown }): TelegramView {
    const b = this.require(employeeId);
    if (typeof input.questions === 'boolean') b.questions = input.questions;
    this.save();
    return this.view(employeeId);
  }

  unpair(employeeId: string, tgId: number, by: TelegramPerson): TelegramView {
    const b = this.require(employeeId);
    const p = b.people.find((x) => x.tgId === tgId);
    b.people = b.people.filter((x) => x.tgId !== tgId);
    this.save();
    if (p) {
      void this.send(b, p.chatId, `You are disconnected from ${this.nameOf(employeeId)}. Ask in the office for a new link to talk again.`);
      this.deps.engine.core.audit(by.id === 'owner' ? 'owner' : `member:${by.name}`, 'telegram.unpaired', employeeId, { telegram: p.username ? `@${p.username}` : p.name });
    }
    return this.view(employeeId);
  }

  async disconnect(employeeId: string, by?: TelegramPerson): Promise<TelegramView> {
    const b = this.bots.get(employeeId);
    this.stop(employeeId);
    if (b) {
      for (const p of b.people) await this.send(b, p.chatId, `${b.name} is no longer connected to the office.`).catch(() => undefined);
      this.bots.delete(employeeId);
      this.save();
      if (by) this.deps.engine.core.audit(by.id === 'owner' ? 'owner' : `member:${by.name}`, 'telegram.disconnected', employeeId, { bot: `@${b.username}` });
    }
    return this.view(employeeId);
  }

  // ───────────── listening ─────────────

  private listen(employeeId: string): void {
    if (this.closed || this.loops.has(employeeId)) return;
    const ctl = new AbortController();
    this.loops.set(employeeId, ctl);
    void (async () => {
      let backoff = 1000;
      while (!ctl.signal.aborted) {
        const b = this.bots.get(employeeId);
        if (!b) break;
        try {
          const updates = await this.call<Array<Record<string, any>>>(this.token(b), 'getUpdates', { offset: b.offset, timeout: this.deps.pollSeconds, allowed_updates: ['message', 'callback_query', 'my_chat_member'] }, ctl.signal, (this.deps.pollSeconds + 15) * 1000);
          backoff = 1000;
          if (b.error) {
            b.error = null;
            this.save();
          }
          for (const u of updates) {
            b.offset = Math.max(b.offset, Number(u.update_id) + 1);
            await this.update(b, u).catch((e: Error) => this.deps.log('warn', `telegram: ${this.nameOf(employeeId)}'s bot: ${e.message}`));
          }
          if (updates.length) this.save();
        } catch (e) {
          if (ctl.signal.aborted) break;
          const msg = (e as Error).message;
          if (/401|Unauthorized/.test(msg)) {
            b.error = 'Telegram no longer accepts this bot\'s token (it was revoked, or the bot deleted). Paste a new token.';
            this.save();
            this.deps.log('warn', `telegram: ${this.nameOf(employeeId)}'s bot was refused by Telegram; not listening to it any more`);
            break;
          }
          if (/409|Conflict/.test(msg)) b.error = 'Another program is reading this bot\'s messages too (only one may). Stop it, or give this employee a bot of their own.';
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(60_000, backoff * 2);
        }
      }
      this.loops.delete(employeeId);
    })();
  }

  private stop(employeeId: string): void {
    this.loops.get(employeeId)?.abort();
    this.loops.delete(employeeId);
    const w = this.waiting.get(employeeId);
    if (w) clearInterval(w.timer);
    this.waiting.delete(employeeId);
  }

  private async update(b: Bot, u: Record<string, any>): Promise<void> {
    if (u.callback_query) return this.button(b, u.callback_query);
    if (u.my_chat_member) return this.membership(b, u.my_chat_member);
    const m = u.message;
    if (!m?.from || !m.chat) return;
    if (m.chat.type === 'group' || m.chat.type === 'supergroup') return this.inGroup(b, m);
    if (m.chat.type !== 'private') return;
    const tgId = Number(m.from.id);
    const text = String(m.text ?? m.caption ?? '').trim();
    const start = startPayload(String(m.text ?? ''));
    if (start !== null && start) return this.paired(b, m, start);
    const p = b.people.find((x) => x.tgId === tgId);
    if (!p) {
      const last = this.toldPrivate.get(tgId) ?? 0;
      if (Date.now() - last > 10 * 60_000) {
        this.toldPrivate.set(tgId, Date.now());
        await this.send(b, m.chat.id, `This bot belongs to an office and is private. If you work there, open ${this.nameOf(b.employeeId)}'s profile in the office and use "Connect your Telegram".`);
      }
      return;
    }
    // Still allowed? (A member who was let go, or whose room closed, is not any more.)
    const as = this.deps.mayWork(p.as.id, b.employeeId);
    if (!as) {
      await this.send(b, p.chatId, `You can no longer work with ${this.nameOf(b.employeeId)} in the office, so this chat is closed.`);
      return;
    }
    if (start !== null || /^\/help(@\w+)?$/.test(text)) return void (await this.send(b, p.chatId, this.help(b)));
    if (/^\/status(@\w+)?$/.test(text)) return void (await this.send(b, p.chatId, this.status(b.employeeId)));
    // A reply to a question the bot passed on answers that question.
    const repliedTo = m.reply_to_message ? this.replyTo.get(`${p.chatId}:${m.reply_to_message.message_id}`) : undefined;
    if (repliedTo && text) {
      const q = this.deps.engine.core.questions.get(repliedTo);
      if (q?.status === 'open' && q.kind !== 'permission' && !q.parts.length) {
        await this.deps.engine.comms.answer(q.id, { answer: text }, this.actor(as), null, { owner: as.owner });
        await this.send(b, p.chatId, '✓ Answered.');
        return;
      }
    }
    // Pictures and files that come with it go to the employee's machine first, as from the office's own window.
    const fileIds: string[] = [];
    const photo = Array.isArray(m.photo) && m.photo.length ? m.photo[m.photo.length - 1] : null;
    const doc = m.document ?? m.video ?? m.audio ?? m.voice ?? null;
    const attach = photo ? { id: photo.file_id, name: `photo-${m.message_id}.jpg`, size: Number(photo.file_size ?? 0) } : doc ? { id: doc.file_id, name: String(doc.file_name ?? `${m.voice ? 'voice' : 'file'}-${m.message_id}${m.voice ? '.ogg' : ''}`), size: Number(doc.file_size ?? 0) } : null;
    if (attach) {
      try {
        fileIds.push(await this.fetchFile(b, attach, as));
      } catch (e) {
        await this.send(b, p.chatId, `I could not take that file: ${(e as Error).message}`);
        if (!text) return;
      }
    }
    if (!text && !fileIds.length) return;
    await this.deliver(b, p, as, text || 'Look at this.', fileIds);
  }

  private async paired(b: Bot, m: Record<string, any>, code: string): Promise<void> {
    const ok = b.pairing && b.pairing.until > Date.now() && crypto.timingSafeEqual(Buffer.from(b.pairing.hash), Buffer.from(hash(code)));
    if (!ok) {
      await this.send(b, m.chat.id, 'This link has been used or is too old. Make a new one in the office: the employee\'s profile → Telegram → "Connect your Telegram".');
      return;
    }
    const by = b.pairing!.by;
    b.pairing = null;
    const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || String(m.from.username ?? 'Telegram user');
    b.people = [...b.people.filter((x) => x.tgId !== Number(m.from.id)), { tgId: Number(m.from.id), chatId: Number(m.chat.id), name, username: m.from.username ?? null, as: by, since: new Date().toISOString() }];
    this.save();
    this.deps.engine.core.audit(by.id === 'owner' ? 'owner' : `member:${by.name}`, 'telegram.paired', b.employeeId, { telegram: m.from.username ? `@${m.from.username}` : name });
    const e = this.deps.engine.core.employees.get(b.employeeId);
    await this.send(b, m.chat.id, `Connected. You are talking to ${e?.name ?? 'your employee'}${e?.title ? `, ${e.title}` : ''} — as ${by.name} in the office.\n\nWrite here what you need: it goes into their real session, and their answer comes back here. ${b.questions ? 'Their questions and requests come here too, with buttons.' : ''}\n\n/status — what they are doing\n/help — what I can do`);
  }

  private async deliver(b: Bot, p: Paired, as: TelegramPerson, text: string, fileIds: string[]): Promise<void> {
    await this.handOver(b, as, text, fileIds, p.chatId, null, null);
  }

  /** Into the employee's session, as from `as` (or a group connected by `as`); and wait for what they say. */
  private async handOver(b: Bot, as: TelegramPerson, text: string, fileIds: string[], chatId: number, replyTo: number | null, group: { title: string; said: string; from: string } | null): Promise<void> {
    const engine = this.deps.engine;
    const employee = engine.core.employees.require(b.employeeId);
    // Nobody at the desk: they are brought in, as the office's own window does when somebody talks to them.
    if (!engine.core.runningSessionOf(employee.id) && !engine.sessions.present(employee.id)) {
      const why = !employee.hostId ? 'they have no machine to work on' : await Promise.resolve()
        .then(() => engine.sessions.start(employee.id, { resume: true, actor: this.actor(as) }))
        .then(() => null, (e: Error) => e.message);
      if (why) {
        await this.send(b, chatId, `${employee.name} cannot start: ${why}. Fix it in the office (their profile), then write again.`, replyTo);
        return;
      }
    }
    const sent = await engine.saidFiles.deliver(employee, fileIds, as.id);
    const from = group?.from ?? (as.id === 'owner' ? 'the boss' : as.owner ? `${as.name} (an owner of this office)` : `${as.name} (a colleague the boss invited; not the boss)`);
    // The employee gets the whole of it (a group's context and how to answer); a window shows what was said.
    engine.comms.sendMessage({ from: { kind: 'owner', id: null, name: from }, toEmployeeId: employee.id, body: text + (sent.lines.length ? `\n\n${sent.lines.join('\n')}` : ''), files: sent.files, said: group?.said ?? text, channel: 'telegram', ...(group ? { chat: group.title } : {}) });
    // "typing…" while they work on it, and their answer back here when the turn ends.
    const w = this.waiting.get(employee.id) ?? { chats: new Map<number, { replyTo: number | null; group: boolean }>(), since: Date.now(), timer: setInterval(() => this.typing(employee.id), 4500) };
    w.chats.set(chatId, { replyTo, group: !!group });
    this.waiting.set(employee.id, w);
    this.typing(employee.id);
  }

  private typing(employeeId: string): void {
    const w = this.waiting.get(employeeId);
    const b = this.bots.get(employeeId);
    if (!w || !b) return;
    if (Date.now() - w.since > TELEGRAM_LIMITS.typingMs) {
      clearInterval(w.timer);
      this.waiting.delete(employeeId);
      return;
    }
    for (const chat of w.chats.keys()) void this.call(this.token(b), 'sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => undefined);
  }

  private async turnEnded(employeeId: string, last: string): Promise<void> {
    const w = this.waiting.get(employeeId);
    const b = this.bots.get(employeeId);
    if (!w || !b) return;
    clearInterval(w.timer);
    this.waiting.delete(employeeId);
    for (const [chat, how] of w.chats) {
      // Posted as an ordinary message; as a reply only to the message they chose (`[reply #id]`) — in a group.
      const { text: said, replyTo } = answerOf(last, new Set(how.group ? (this.heard.get(chat) ?? []).map((h) => h.id).filter(Boolean) : []));
      // In a group they may decide that nothing was for them: then nothing is posted.
      if (how.group && (!said || /^NO_REPLY\b/.test(said))) continue;
      let first = 0;
      for (const [i, part] of pieces(said || '(They finished without a word.)').entries()) {
        const id = await this.send(b, chat, part, i === 0 ? replyTo : null).catch(() => 0);
        if (i === 0) first = id;
      }
      if (how.group) {
        this.remember(chat, this.nameOf(employeeId), said, first);
        if (how.replyTo !== null) this.lastAnswer.set(chat, { to: this.repliedUser.get(`${chat}:${how.replyTo}`) ?? 0, at: Date.now() });
      }
    }
  }

  // ───────────── groups ─────────────

  /** Who wrote the message an answer goes to, by group and message: a follow-up from them is meant for the employee too. */
  private repliedUser = new Map<string, number>();

  /** What of a group's chat the employee has been given, in which conversation of theirs (Claude Code's session id). */
  private given = new Map<string, { conversation: string | null; last: number }>();

  /**
   * The chat's lines the employee has not seen, besides those handed over now: all the recent ones the first time — or
   * when their conversation is another one than the one that saw them — and after that only what was said since.
   * Their own answers are not given back to them.
   */
  private unseen(employeeId: string, chatId: number, now: Heard[]): { earlier: Heard[]; first: boolean } {
    const key = `${employeeId}:${chatId}`;
    const conversation = this.deps.engine.core.runningSessionOf(employeeId)?.claudeSessionId ?? null;
    const was = this.given.get(key);
    const first = !was || !conversation || was.conversation !== conversation;
    const ids = new Set(now.map((h) => h.id));
    const me = this.nameOf(employeeId);
    const all = (this.heard.get(chatId) ?? []).filter((h) => !ids.has(h.id));
    const earlier = first ? all : all.filter((h) => h.id > was!.last && h.who !== me);
    this.given.set(key, { conversation, last: Math.max(was?.last ?? 0, ...all.map((h) => h.id), ...now.map((h) => h.id)) });
    return { earlier: earlier.slice(-30).map(({ who, text, id }) => ({ who, text, id })), first };
  }

  private remember(chatId: number, who: string, text: string, id: number): void {
    const list = this.heard.get(chatId) ?? [];
    list.push({ who, text: text.slice(0, 600), id, at: Date.now() });
    while (list.length > 30) list.shift();
    this.heard.set(chatId, list);
  }

  /** The bot was added to a group, or taken out of one. Added without a code: it says it is private and goes. */
  private async membership(b: Bot, u: Record<string, any>): Promise<void> {
    const chatId = Number(u.chat?.id);
    const status = String(u.new_chat_member?.status ?? '');
    if (status === 'left' || status === 'kicked') {
      if ((b.groups ?? []).some((g) => g.chatId === chatId)) {
        b.groups = b.groups.filter((g) => g.chatId !== chatId);
        this.save();
      }
      return;
    }
    if (status !== 'member' && status !== 'administrator') return;
    // (Added through the office's link, the code arrives a moment later as /start: give it time.)
    setTimeout(() => {
      if ((b.groups ?? []).some((g) => g.chatId === chatId) || !this.bots.has(b.employeeId)) return;
      void this.send(b, chatId, `This bot belongs to an office and is private. To bring ${this.nameOf(b.employeeId)} into a group, use "Add to a group" in their profile in the office.`)
        .catch(() => undefined)
        .then(() => this.call(this.token(b), 'leaveChat', { chat_id: chatId }).catch(() => undefined));
    }, 45_000).unref();
  }

  private async inGroup(b: Bot, m: Record<string, any>): Promise<void> {
    const chatId = Number(m.chat.id);
    const text = String(m.text ?? m.caption ?? '').trim();
    const start = startPayload(text);
    b.groups ??= [];
    let g = b.groups.find((x) => x.chatId === chatId);
    if (start) {
      const ok = b.pairing && b.pairing.until > Date.now() && crypto.timingSafeEqual(Buffer.from(b.pairing.hash), Buffer.from(hash(start)));
      if (!ok) return void (await this.send(b, chatId, 'This link has been used or is too old. Make a new one in the office: the employee\'s profile → Telegram → "Add to a group".'));
      const by = b.pairing!.by;
      b.pairing = null;
      g = { chatId, title: String(m.chat.title ?? 'a group'), as: by, mode: 'addressed', since: new Date().toISOString() };
      b.groups = [...b.groups.filter((x) => x.chatId !== chatId), g];
      this.save();
      this.deps.engine.core.audit(by.id === 'owner' ? 'owner' : `member:${by.name}`, 'telegram.group_connected', b.employeeId, { group: g.title });
      const e = this.deps.engine.core.employees.get(b.employeeId);
      await this.send(b, chatId, `Hi, I'm ${e?.name ?? 'here'}${e?.title ? ` (${e.title})` : ''} — connected to this group by ${by.name}. I answer when you talk to me: mention @${b.username}, say my name, or reply to one of my messages.${b.hearsAll ? '' : `

(Right now Telegram shows me only messages that mention me or reply to me. To let me follow the conversation, the bot's owner turns privacy off in @BotFather: /setprivacy → @${b.username} → Disable, then adds me to the group again.)`}`);
      return;
    }
    if (!g) {
      const last = this.toldPrivate.get(chatId) ?? 0;
      if (Date.now() - last > 10 * 60_000) {
        this.toldPrivate.set(chatId, Date.now());
        await this.send(b, chatId, `This bot belongs to an office and is private. To bring ${this.nameOf(b.employeeId)} into a group, use "Add to a group" in their profile in the office.`).catch(() => undefined);
        await this.call(this.token(b), 'leaveChat', { chat_id: chatId }).catch(() => undefined);
      }
      return;
    }
    if (m.chat.title && m.chat.title !== g.title) {
      g.title = String(m.chat.title);
      this.save();
    }
    const as = this.deps.mayWork(g.as.id, b.employeeId);
    if (!as) {
      const last = this.toldPrivate.get(chatId) ?? 0;
      if (Date.now() - last > 60 * 60_000) {
        this.toldPrivate.set(chatId, Date.now());
        await this.send(b, chatId, `${g.as.name}, who connected this group, can no longer work with ${this.nameOf(b.employeeId)} in the office: I am not taking anything from here.`).catch(() => undefined);
      }
      return;
    }
    if (/^\/status(@\w+)?$/.test(text)) return void (await this.send(b, chatId, this.status(b.employeeId), m.message_id));
    if (/^\/help(@\w+)?$/.test(text)) return void (await this.send(b, chatId, `I'm ${this.nameOf(b.employeeId)}'s line to the office. Talk to me — mention @${b.username}, say my name, or reply to me — and I answer here.${g.mode === 'all' ? ' I also follow the whole conversation and speak up when something is for me.' : ''}\n/status — what I am doing`, m.message_id));
    const who = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || String(m.from.username ?? 'someone');
    if (!text && !m.photo && !m.document) return;
    this.remember(chatId, who, text || '(a picture or a file)', Number(m.message_id));
    if (addressedTo({ text, botUsername: b.username, botId: b.botId, name: this.nameOf(b.employeeId), replyToFrom: m.reply_to_message?.from?.id ?? null, entities: m.entities ?? m.caption_entities ?? [], from: Number(m.from.id), lastAnswer: this.lastAnswer.get(chatId) ?? null })) {
      this.repliedUser.set(`${chatId}:${m.message_id}`, Number(m.from.id));
      const fileIds: string[] = [];
      const photo = Array.isArray(m.photo) && m.photo.length ? m.photo[m.photo.length - 1] : null;
      const attach = photo ? { id: photo.file_id, name: `photo-${m.message_id}.jpg`, size: Number(photo.file_size ?? 0) } : m.document ? { id: m.document.file_id, name: String(m.document.file_name ?? `file-${m.message_id}`), size: Number(m.document.file_size ?? 0) } : null;
      if (attach) await this.fetchFile(b, attach, as).then((id) => fileIds.push(id)).catch(() => undefined);
      const pending = this.gathering.get(chatId);
      if (pending) {
        clearTimeout(pending.timer);
        this.gathering.delete(chatId);
      }
      const said: Heard[] = [{ who, text: text || 'Look at this.', id: Number(m.message_id) }];
      await this.handOver(b, as, groupPrompt({ group: g.title, me: this.nameOf(b.employeeId), ...this.unseen(b.employeeId, chatId, said), who, new: said, everything: false }), fileIds, chatId, m.message_id, { title: g.title, said: plain(said), from: groupFrom(who, g, as) });
      return;
    }
    // Not said to them: in a group that sends them everything, what is said is gathered and handed over in one go
    // once the conversation pauses — and they decide whether it needs them.
    if (g.mode !== 'all') return;
    const pending = this.gathering.get(chatId) ?? { lines: [] as Heard[], replyTo: Number(m.message_id), timer: setTimeout(() => undefined, 0), first: Date.now() };
    clearTimeout(pending.timer);
    pending.lines.push({ who, text: text || '(a picture or a file)', id: Number(m.message_id) });
    pending.replyTo = m.message_id;
    this.repliedUser.set(`${chatId}:${m.message_id}`, Number(m.from.id));
    const wait = Date.now() - pending.first > 25_000 ? 0 : GATHER_MS;
    pending.timer = setTimeout(() => {
      this.gathering.delete(chatId);
      void this.handOver(b, as, groupPrompt({ group: g!.title, me: this.nameOf(b.employeeId), ...this.unseen(b.employeeId, chatId, pending.lines), who: null, new: pending.lines, everything: true }), [], chatId, pending.replyTo, { title: g!.title, said: plain(pending.lines), from: groupFrom(null, g!, as) }).catch(() => undefined);
    }, wait);
    this.gathering.set(chatId, pending);
  }

  // ───────────── questions and requests ─────────────

  private async question(q: Question): Promise<void> {
    if (!q.employeeId) return;
    const b = this.bots.get(q.employeeId);
    if (!b) return;
    const already = this.sent.get(q.id);
    if (q.status !== 'open') {
      // Answered (here or in the office): the message says so, and its buttons go.
      if (!already) return;
      this.sent.delete(q.id);
      const how = q.kind === 'permission' ? (q.decision === 'allow' ? '✅ Allowed' : q.decision === 'deny' ? '⛔ Denied' : '— closed') : q.answer ? `✅ Answered: ${q.answer.slice(0, 200)}` : '— closed';
      for (const s of already) await this.call(this.token(b), 'editMessageText', { chat_id: s.chatId, message_id: s.messageId, text: `${s.text}\n\n${how}` }).catch(() => undefined);
      return;
    }
    if (!b.questions) return;
    // Waiting for a project manager's answer first: not the boss's yet (it comes here if the manager passes it on).
    if (q.managerId) return;
    const name = this.nameOf(q.employeeId);
    let text: string;
    let buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    if (q.kind === 'permission') {
      const input = q.tool ? JSON.stringify(q.tool.input) : '';
      text = `🔐 ${name} asks to run ${q.tool?.name ?? 'something'}:\n${(q.text || input).slice(0, 1500)}`;
      buttons = [q.tool?.notShown ? [{ text: '⛔ Deny', callback_data: `p:${q.id}:deny` }] : [{ text: '✅ Allow', callback_data: `p:${q.id}:allow` }, { text: '⛔ Deny', callback_data: `p:${q.id}:deny` }]];
      if (q.tool?.notShown) text += '\n\n(Too long to show in full: it can only be denied here, or decided at the terminal.)';
    } else if (q.parts.length) {
      text = `❓ ${name} asks:\n${q.parts.map((p) => `• ${p.question}`).join('\n')}\n\n(Several answers are needed: answer in the office.)`;
    } else {
      text = `❓ ${name} asks:\n${q.text}${q.context ? `\n\n${q.context.slice(0, 800)}` : ''}${q.options.length ? '' : '\n\n(Reply to this message to answer.)'}`;
      // (The choice that opens the release gate says so here too: a button has no room for its consequence.)
      buttons = q.options.slice(0, 8).map((o, i) => [{ text: `${o.releases ? '🚀 ' : ''}${o.label}`.slice(0, 60), callback_data: `q:${q.id}:${i}` }]);
      if (q.options.some((o) => o.releases)) text += `\n\n🚀 = lets ${name} release for an hour.`;
    }
    const out: Array<{ employeeId: string; chatId: number; messageId: number; text: string }> = [];
    for (const p of b.people) {
      if (already?.some((s) => s.chatId === p.chatId)) continue;
      if (!this.deps.mayWork(p.as.id, q.employeeId)) continue;
      // In the office now: they see it there. Sent here if they leave while it is still open.
      if (this.isHere(p.as.id)) {
        this.heldQuestions.add(q.id);
        continue;
      }
      const r = await this.call<{ message_id: number }>(this.token(b), 'sendMessage', { chat_id: p.chatId, text: text.slice(0, TELEGRAM_LIMITS.textChars), ...(buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {}) }).catch(() => null);
      if (r) {
        out.push({ employeeId: q.employeeId, chatId: p.chatId, messageId: r.message_id, text: text.slice(0, 3500) });
        this.replyTo.set(`${p.chatId}:${r.message_id}`, q.id);
      }
    }
    if (out.length) this.sent.set(q.id, [...(already ?? []), ...out]);
  }

  /**
   * What an employee wrote to a person (`message_person`): also sent by that employee's own bot, privately, to the
   * people it is for who talk to it there. A reply in that chat goes to the employee, as everything said there does.
   */
  private async personMessage(n: Notification, late = false): Promise<void> {
    // What an employee wrote to a person; or work that waits for an owner's verdict (the owner, 2026-11-23: "yes, when
    // I am not there" — a ticket had waited five days).
    const review = n.kind === 'review' && !!n.taskId && / needs your (?:review|decision)$/.test(n.title);
    if ((n.kind !== 'message' || !n.for?.length) && !review) return;
    if (!n.employeeId || n.readAt || n.resolvedAt) return;
    // (Only as it is written — or, kept back while its person was in the office, when they leave: not again when the
    // office starts, or when it is read.)
    if (!late && Date.now() - Date.parse(n.createdAt) > 120_000) return;
    const b = review ? this.botForTask(n.taskId!, n.employeeId) : this.bots.get(n.employeeId);
    if (!b) return;
    if (this.toldPeople.size > 2000) this.toldPeople.clear();
    for (const p of b.people) {
      const key = `${n.id}:${p.chatId}`;
      if (this.toldPeople.has(key)) continue;
      const who = this.deps.mayWork(p.as.id, b.employeeId);
      if (!who || !notificationFor(n, { id: who.id, owner: who.owner }) || (review && !who.owner)) continue;
      if (this.isHere(p.as.id)) {
        this.heldMessages.add(n.id);
        continue;
      }
      this.toldPeople.add(key);
      const text = review ? `🔎 ${n.title}\n${n.body}\n\nDecide it in the office (Tasks → ${this.deps.engine.core.tasks.get(n.taskId!)?.key ?? 'the ticket'}).` : `${n.severity === 'warning' ? '❗ ' : ''}${n.body}`;
      await this.call(this.token(b), 'sendMessage', { chat_id: p.chatId, text: text.slice(0, TELEGRAM_LIMITS.textChars) }).catch(() => undefined);
    }
  }
  /**
   * The bot a ticket waiting for an owner is told through: its author's own, or else a colleague's on its project (or on
   * the author's) — the one who leads first, as an owner talks to a team's manager. None: it stays in the office.
   */
  private botForTask(taskId: string, authorId: string): Bot | undefined {
    const own = this.bots.get(authorId);
    if (own) return own;
    const core = this.deps.engine.core;
    const task = core.tasks.get(taskId);
    const author = core.employees.get(authorId);
    const projects = new Set([task?.projectId, author?.projectId, ...(author?.alsoProjectIds ?? [])].filter((x): x is string => !!x));
    const on = [...this.bots.values()].filter((b) => {
      const e = core.employees.get(b.employeeId);
      return !!e && !e.archived && [e.projectId, ...(e.alsoProjectIds ?? [])].some((p) => !!p && projects.has(p));
    });
    const leads = (b: Bot) => {
      const e = core.employees.get(b.employeeId)!;
      return /lead|manager|pm\b/i.test(`${e.roleKey} ${e.title ?? ''} ${e.name}`) ? 0 : 1;
    };
    return on.sort((a, b) => leads(a) - leads(b))[0];
  }

  /** The messages to people already sent on (`personMessage`). */
  private readonly toldPeople = new Set<string>();

  private async button(b: Bot, cb: Record<string, any>): Promise<void> {
    const reply = (text: string) => this.call(this.token(b), 'answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => undefined);
    const p = b.people.find((x) => x.tgId === Number(cb.from?.id));
    const as = p ? this.deps.mayWork(p.as.id, b.employeeId) : null;
    if (!p || !as) return void (await reply('This bot is private.'));
    const [kind, id, choice] = String(cb.data ?? '').split(':');
    const q = id ? this.deps.engine.core.questions.get(id) : undefined;
    if (!q || q.employeeId !== b.employeeId) return void (await reply('That is no longer here.'));
    if (q.status !== 'open') return void (await reply('Already answered.'));
    try {
      if (kind === 'p' && (choice === 'allow' || choice === 'deny')) await this.deps.engine.comms.answer(q.id, { decision: choice }, this.actor(as));
      else if (kind === 'q' && q.options[Number(choice)]) await this.deps.engine.comms.answer(q.id, { answer: q.options[Number(choice)]!.label }, this.actor(as), null, { owner: as.owner });
      else return void (await reply('That button does not fit this question.'));
      await reply('Done.');
    } catch (e) {
      await reply((e as Error).message.slice(0, 190));
    }
  }

  // ───────────── helpers ─────────────

  private help(b: Bot): string {
    return `I am ${this.nameOf(b.employeeId)}'s line to the office.\n\nWrite anything: it goes into their real Claude Code session, and their answer comes back here. Send a picture or a file and it goes to them too.${b.questions ? '\nTheir questions and permission requests come here with buttons; reply to a question to answer it in words.' : ''}\n\n/status — what they are doing now\n/help — this`;
  }

  private status(employeeId: string): string {
    const core = this.deps.engine.core;
    const e = core.employees.get(employeeId);
    if (!e) return 'They are no longer in the office.';
    const s = core.runningSessionOf(employeeId);
    const activity = s ? (ACTIVITY_LABEL[s.activity as keyof typeof ACTIVITY_LABEL] ?? s.activity) : 'asleep — no session running';
    const task = [...core.tasks.all()].find((t) => t.assigneeId === employeeId && t.status === 'IN_PROGRESS');
    const open = [...core.questions.all()].filter((q) => q.employeeId === employeeId && q.status === 'open').length;
    return `${e.name}${e.title ? ` · ${e.title}` : ''}\nNow: ${activity}${task ? `\nTask: ${task.key} ${task.title}${task.progress?.note ? ` — ${task.progress.note}` : ''}` : ''}${open ? `\nWaiting for an answer: ${open}` : ''}`;
  }

  private async fetchFile(b: Bot, f: { id: string; name: string; size: number }, as: TelegramPerson): Promise<string> {
    if (f.size > TELEGRAM_LIMITS.fileBytes) throw new Error('it is larger than 20 MB (Telegram lets a bot fetch no more)');
    const info = await this.call<{ file_path: string; file_size?: number }>(this.token(b), 'getFile', { file_id: f.id });
    const r = await fetch(`${this.deps.api}/file/bot${this.token(b)}/${info.file_path}`, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`Telegram answered ${r.status}`);
    const data = Buffer.from(await r.arrayBuffer());
    if (!data.length) throw new Error('it is empty');
    const said = this.deps.engine.saidFiles.begin(b.employeeId, { name: f.name, size: data.length }, as.id);
    this.deps.engine.saidFiles.append(b.employeeId, said.id, 0, data, as.id);
    return said.id;
  }

  /** A message from the bot; its id in that chat. */
  private async send(b: Bot, chatId: number, text: string, replyTo: number | null = null): Promise<number> {
    const r = await this.call<{ message_id?: number }>(this.token(b), 'sendMessage', { chat_id: chatId, text: text.slice(0, TELEGRAM_LIMITS.textChars), ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) });
    return Number(r?.message_id ?? 0);
  }

  /** One call to Telegram's Bot API. Errors never carry the token (it is part of the address). */
  private async call<T = unknown>(token: string, method: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let r: Response;
    try {
      r = await fetch(`${this.deps.api}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (e) {
      throw new Error(`${method}: ${(e as Error).name === 'TimeoutError' ? 'no answer in time' : 'Telegram could not be reached'}`);
    }
    const j = (await r.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string; error_code?: number } | null;
    if (!r.ok || !j?.ok) throw new Error(`${method}: ${j?.error_code ?? r.status} ${String(j?.description ?? r.statusText).replace(token, '…')}`);
    return j.result as T;
  }

  private token(b: Bot): string {
    return this.deps.engine.vault.unseal(b.sealed, `telegram:${b.employeeId}`);
  }

  private require(employeeId: string): Bot {
    const b = this.bots.get(employeeId);
    if (!b) throw this.error('This employee has no Telegram bot yet.', 404);
    return b;
  }

  private nameOf(employeeId: string): string {
    return this.deps.engine.core.employees.get(employeeId)?.name ?? 'This employee';
  }

  private actor(as: TelegramPerson): string {
    return as.id === 'owner' ? 'owner' : `member:${as.name}`;
  }

  private error(message: string, status = 400): Error {
    return new EngineError(message, status);
  }

  private save(): void {
    this.deps.store.kvSet(STORE_KEY, Object.fromEntries(this.bots));
  }
}
