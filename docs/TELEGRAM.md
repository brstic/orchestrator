# An employee's own Telegram bot

_Built on 2026-11-15 on the owner's request: "let me hang a different Telegram bot on every agent, so I can talk to them directly over Telegram — make it work well, a good UI around it, test it properly, and simple to set up"; the same day: "make it so it can be added to groups, and talk there not only when tagged — so it knows when it is being talked about"._

Every employee may have a Telegram bot of their own. What a person writes to it goes into the employee's **real session** (the same as *Talk*), and what the employee says back comes back to Telegram — with their questions and permission requests, which can be answered there with a button. The bot can also be **added to a Telegram group**, where the employee takes part in the conversation. Read this before touching `apps/server/src/telegram.ts`, the Telegram routes in `apps/server/src/server.ts`, or `apps/desktop/src/hud/panels/telegram.tsx`.

## Setting it up (what the owner does)

In the employee's profile → **Telegram** tab:

1. **Make a bot.** *Open @BotFather* → send `/newbot` → give it a name (the employee's, say) and a username ending in `bot`. BotFather answers with a token.
2. **Paste its token** and press **Connect**. The office checks it with Telegram (`getMe`); a wrong one is refused in words.
3. **Open the link** the tab now shows, on your phone. It works **once, for ten minutes**, and pairs your Telegram with you in the office. From then on, write to the bot as to the employee.

**For groups:** *Add to a group* gives a second one-time link (`t.me/<bot>?startgroup=…`); open it and pick the group. To let the employee follow the whole conversation and notice when it is about them, Telegram's *privacy mode* must be off for that bot: in @BotFather `/setprivacy` → the bot → **Disable**, then add the bot to the group again (Telegram applies it when the bot joins). Until then the tab says so, with *Check again*.

The tab, once connected: the bot (and an error, if Telegram refused it — a revoked token, or the same bot polled somewhere else), the one-time link with *Copy*, **who talks to the employee here** (each with ×), **groups** (each with *When talked to* / *Everything*, and × to leave), whether their **questions and permission requests** go to Telegram too, and **Disconnect the bot**.

The tab is shown to whoever may *work* with that employee (an owner; a colleague for their own employees and the shared ones they are let at — `ACCESS.md`), not to visitors and not in the public demo.

## What happens

- **Private chat.** Only people who paired are served. A stranger is told the bot is private, and nothing reaches the employee. What a paired person writes is delivered as a message **from that person** (an owner, or "a colleague, <name>") into the session — **started first** if nobody is at the desk; if it cannot be started the bot says why ("Quinn cannot start: …") instead of typing for ever. "typing…" shows while the employee works; when the turn ends, what they said is sent back (long answers in Telegram-sized pieces). Pictures and files (up to 20 MB) go in with the message, as on *Talk*. `/status` says what the employee is doing; `/help` what the bot does. In *Talk* such a message shows **via Telegram**.
- **Questions and permission requests** (when the switch is on) go to everybody paired privately: a question with its options as buttons (or answered by replying to it), a permission request with **Allow** / **Deny**. A button decides **as the person who pressed it**, only if they are paired; the message is then edited to say who decided. They never go to a group.
- **In a group**, set per group:
  - **When talked to** (the default): the employee answers when somebody mentions the bot (`@bot`), says the employee's **name as a word** (any alphabet: "Đorđe, look" counts, "Đorđević" does not), **replies** to one of the bot's messages, or writes a **follow-up** within three minutes of being answered by it. Everything else is only remembered.
  - **Everything (they decide)**: every message goes to them. What is said is gathered until the conversation pauses (8 s), then handed over at once with the instruction to answer only if it is for them or they have something useful to add — otherwise to reply exactly `NO_REPLY`, which the office does not post. Each pause is a turn of their Claude: this costs usage in a busy group.
  - Either way, the **last 30 messages** of the group go with it as context, and the answer is posted as a reply to the message it answers.
  - Whoever writes in a group speaks as **the person who connected the group** (so a group has the rights of that member, not more).
  - A group the bot was added to **without** a group link is told the bot is private, and the bot leaves.
- **Rights are checked on every message**, not only at pairing: a colleague who loses access to the employee (removed from the office, or the employee closed to them) is refused at their next message; so is a group connected by them.

## Security

- **The token** is kept sealed with the office's vault key (AES-256-GCM, `Vault.seal`, kv `telegram.bots`), sent once from the window and **never** returned to a window, an event, an error or a log (errors from Telegram are redacted). `tests/e2e/59-telegram.test.ts` checks that it is nowhere in what a window gets — the tab's answer, the state, the events. (The database file holds it only sealed; that is by construction, not checked by a test.)
- **Long polling** (`getUpdates`), started from the office: nothing is opened on the server or a router, no webhook (`deleteWebhook` on connect).
- **Pairing codes** are random, stored only as a SHA-256 hash, work once and for ten minutes, and are made only by somebody who may work with the employee.
- The bot is a way to **talk** to the employee, not a remote terminal: no keys reach the terminal except through the office's message delivery, and the high-risk gate, deny rules and permission prompts stand as for any message.
- The public demo refuses every Telegram route (`SHOWCASE_WORK`).

## Where the code is

| | |
| --- | --- |
| Server | `apps/server/src/telegram.ts` — `Telegram` (one poll loop per bot, pairing, delivery, turn-end replies, questions, groups), `addressedTo`, `groupPrompt`, `pieces` |
| Routes | `GET/PUT/PATCH/DELETE /api/employees/:id/telegram`, `POST …/telegram/pair`, `POST …/telegram/check`, `DELETE …/telegram/people/:tg`, `PATCH/DELETE …/telegram/groups/:chat` — all `'work'` on the employee (`access.ts`) |
| Window | `apps/desktop/src/hud/panels/telegram.tsx` (`TelegramTab`), a tab of the employee's profile (`team.tsx`) |
| Contract | `Message.channel: 'telegram'` (`packages/contracts`), set by `Comms.sendMessage` |
| Tests | `apps/server/test/telegram.test.ts` (who is talked to, the group prompt, pieces); `tests/e2e/59-telegram.test.ts` against a stand-in Bot API (`tests/e2e/fake-telegram.ts`): token, privacy, pairing, talk and typing, a picture, a question by reply, Allow/Deny, a session that cannot start, groups in both modes, an unconnected group, a colleague who loses access, taking it all away, a restart; the UI suite (`tests/ui`) clicks through the tab |
| Configuration | `ORCH_TELEGRAM_API` (default `https://api.telegram.org`) — only for tests |

## Limits, plainly

- **Not tried against the real Telegram** at the time of writing — only against the stand-in, which follows the Bot API's documented shapes. The first real bot is the real test.
- One office per bot: if the same token is polled by another program, Telegram refuses one of them (shown as the bot's error).
- A member's own employee on their own computer works the same way (the server delivers into that computer's session) but was tested only with shared employees.
- A voice message reaches the employee only as an `.ogg` file — not transcribed; stickers are ignored.
- In a group with privacy mode on, the employee sees only what mentions the bot or replies to it — "knowing when it is about them" needs privacy mode off.
