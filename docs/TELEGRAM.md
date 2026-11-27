# An employee's own Telegram bot

_Built on 2026-11-15 on the owner's request: "let me hang a different Telegram bot on every agent, so I can talk to them directly over Telegram — make it work well, a good UI around it, test it properly, and simple to set up"; the same day: "make it so it can be added to groups, and talk there not only when tagged — so it knows when it is being talked about"._

Every employee may have a Telegram bot of their own. What a person writes to it goes into the employee's **real session** (the same as *Talk*), and what the employee says back comes back to Telegram — with their questions and permission requests, which can be answered there with a button. The bot can also be **added to a Telegram group**, where the employee takes part in the conversation. Read this before touching `apps/server/src/telegram.ts`, the Telegram routes in `apps/server/src/server.ts`, or `apps/desktop/src/hud/panels/telegram.tsx`.

## Setting it up (what the owner does)

In the employee's profile → **Telegram** tab:

1. **Make a bot.** *Open @BotFather* → send `/newbot` → give it a name (the employee's, say) and a username ending in `bot`. BotFather answers with a token.
2. **Paste its token** and press **Connect**. The office checks it with Telegram (`getMe`); a wrong one is refused in words.
3. **Scan the code** the tab now shows with your phone (or open the link under it, or *Copy* it). It works **once, for ten minutes**, and pairs your Telegram with you in the office; once you are in, the code goes away by itself and you are listed under *People*. From then on, write to the bot as to the employee.

**For groups:** *Add to a group* gives a second one-time link (`t.me/<bot>?startgroup=…`); open it and pick the group. To let the employee follow the whole conversation and notice when it is about them, Telegram's *privacy mode* must be off for that bot: in @BotFather `/setprivacy` → the bot → **Disable**, then add the bot to the group again (Telegram applies it when the bot joins). Until then the tab says so, with *Check again*.

The tab, once connected (second look, the same day, after the owner's "the interface is not the best"): the bot on one line — "Listening · 1 person · 2 groups", or Telegram's error in red (a revoked token, or the same bot polled somewhere else) — and *Open in Telegram*; while nobody is paired, **Show the code** (the one main button); the one-time code as a **QR code** beside its link, *Copy*, minutes left and *Done*; **People** (*+ Connect a phone*; each with as whom they speak, since when, ×); **Groups** (*+ Add to a group*; each with a two-way switch *When talked to* / *Everything* and × to leave), with the privacy-mode advice folded under one line (open when there are groups); **Questions and approvals** as a switch; **Disconnect the bot** last, asking first. The QR code is drawn in the window (`qrcode-generator`, MIT), the link never leaves the computer.

The tab is shown to whoever may *work* with that employee (an owner; a colleague for their own employees and the shared ones they are let at — `ACCESS.md`), not to visitors and not in the public demo.

## What happens

- **Private chat.** Only people who paired are served. A stranger is told the bot is private, and nothing reaches the employee. What a paired person writes is delivered as a message **from that person** (an owner, or "a colleague, <name>") into the session — **started first** if nobody is at the desk; if it cannot be started the bot says why ("Quinn cannot start: …") instead of typing for ever. "typing…" shows while the employee works; when the turn ends, what they said is sent back (long answers in Telegram-sized pieces). Pictures and files (up to 20 MB) go in with the message, as on *Talk*. `/status` says what the employee is doing; `/help` what the bot does. The employee is told it plainly: `On Telegram, <who> writes: …`, and that the reply goes back there as a chat message (plain and short — no tables or headings), while messages without "On Telegram" come from the office as usual (`messagePrompt`, `TELEGRAM_REPLY` in `packages/orchestration/src/prompts.ts`). In *Talk* such a message shows **via Telegram**, and the answer under it **sent to Telegram**.
- **Questions and permission requests** (when the switch is on) go to everybody paired privately: a question with its options as buttons (or answered by replying to it), a permission request with **Allow** / **Deny**. A button decides **as the person who pressed it**, only if they are paired; the message is then edited to say who decided. They never go to a group.
- **What the employee writes to a person** (`message_person`, `MESSAGE-PERSON.md`) is sent too, privately, to the paired people it is for — once, as it is written (❗ when urgent).
- **While you are in the office, nothing comes to your Telegram** (the owner, 2026-11-23: "when I am present in the
  office, the agents must not send me messages on Telegram"). Questions, permission requests and `message_person` are
  kept off the Telegram of a person who is **here**: a window of theirs (the app or a browser) is visible, in front, and
  was touched (pointer, keys, wheel) in the last 10 minutes — the app stays open all day, so open alone is not enough
  (`apps/desktop/src/lib/here.ts`: `{ t: 'here', active }` when that changes and every minute while here;
  `ClientHub.isHere`, a window counts for 150 s after it last said so). They see it in the office. **If they leave** while
  a question is still open, or a message still unread (and under two hours old), it is sent to their Telegram then
  (looked at every 30 s, `Telegram.sendHeld`); answered or read in the office, it is not. Per person: somebody else
  paired with the same bot who is not here gets it at once. **Not held back:** the answer to something you wrote *on
  Telegram* — you asked there, it comes back there. The bot's tab says in one line whether the office counts *you* as here right now (`here` in `GET /api/employees/:id/telegram`).
- **Work waiting for an owner's verdict** (the owner, 2026-11-23, asked whether a ticket waiting for their Approve should
  come to Telegram when they are away: "yes, when I am not there"; one had waited five days). The Inbox line "T-… needs
  your review" / "needs your decision" is sent to the **owners** paired with a bot — its author's own, or else a
  colleague's on the ticket's or the author's project, one who leads first (`botForTask`) — as `🔎 T-… needs your
  review`, with what the colleague checked, and that it is decided in the office. Like everything else: not while they
  are here, sent if they leave with it still unread. None of the team has a bot: it stays in the office.
- **In a group**, set per group:
  - **When talked to** (the default): the employee answers when somebody mentions the bot (`@bot`), says the employee's **name as a word** (any alphabet: "Đorđe, look" counts, "Đorđević" does not), **replies** to one of the bot's messages, or writes a **follow-up** within three minutes of being answered by it. Everything else is only remembered.
  - **Everything (they decide)**: every message goes to them. What is said is gathered until the conversation pauses (8 s), then handed over at once with the instruction to answer only if it is for them or they have something useful to add — otherwise to reply exactly `NO_REPLY`, which the office does not post. Each pause is a turn of their Claude: this costs usage in a busy group.
  - **What the employee is given** (second pass, the owner: "work on how messages are sent to the agent — good context, but not messy when I talk to them again on F through Talk"):
    ```
    On Telegram, in the group "Launch team" — you are Kira there.

    Earlier in the chat:                ← the first time in a conversation of theirs: the last 30 lines
    #40 Dana: who brings the cake?        later: "Meanwhile in the chat:" — only what was said since
    #41 Ivo: me                           (their own answers are not given back to them)

    Dana to you:                         ← or "New:" in a group set to everything
    #42 Dana: kira, can you check the checkout?

    (Your reply is posted in the group as a chat message … When it answers one message in particular — a question
    asked earlier, one of several people — start it with [reply #n] …; otherwise just write.)
    ```
    What they were given is kept per group with the Claude Code conversation it went into (`claudeSessionId`); in another conversation (a new session that did not resume), the recent chat is given again (`unseen` in `telegram.ts`). The office restarting forgets it, and the chat itself (only what arrives while it runs is known).
  - **In *Talk*** (F) such a message is not the prompt above but what was said — "Dana: kira, can you check the checkout?" — in a narrow block marked with the group's name, quiet chat that got no answer merged into one block; the answer under it says **sent to Telegram · Launch team**; `NO_REPLY` turns and the `[reply #n]` mark are not shown (`Message.said`, `Message.chat`; `talk.tsx`).
  - **The answer is an ordinary message**, as people write in a group chat (the owner: "it does not have to reply-to the message every time; it can talk casually — let it choose when it suits it"). When the employee begins its answer with `[reply #1234]` it is posted as a reply to that message — the prompt leaves it to them, for when it answers one message in particular (a question asked earlier, one of several people; the owner, after the first version said "usually, do not": "let it reply sometimes too, when it should"). The mark is taken off; a number the chat does not have is ignored (`answerOf`). In a private chat answers are always plain.
  - Whoever writes in a group speaks as **the person who connected the group** (so a group has the rights of that member, not more).
  - A group the bot was added to **without** a group link is told the bot is private, and the bot leaves.
- **Rights are checked on every message**, not only at pairing: a colleague who loses access to the employee (removed from the office, or the employee closed to them) is refused at their next message; so is a group connected by them.

- **What went to a phone is on the record**: each question, message or waiting work the office puts on a person's
  Telegram by itself is an event `telegram.sent` — the employee, the person, the kind (`question`, `message`,
  `review`); never the text, and not in the feed (`quiet`). So how often a person away from the office is interrupted
  can be counted (2026-11-27: nothing was kept).

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
