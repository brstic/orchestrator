# An employee writes to a person (`message_person`)

_Built on 2026-11-18 on the owner's request: "I would love it if agents had a tool with which they send messages directly to me, when something needs my attention or so… even so that I can tell an agent to send a message to a colleague of mine."_

Every employee has the tool **`message_person { to, message, urgent? }`**: it writes straight to a person of the office — **the boss** (every owner) or **a colleague by name** — and the message is in that person's **Inbox**, and on **Telegram** where they talk to that employee there. It waits for nothing: an answer, if one comes, comes to the employee as any message does (Talk, or a reply on Telegram). For a decision the employee cannot go on without there is still `ask_boss`; for another employee, `send_message`. For a **client who rents the employee** (the Rent portal), `message_client` (RENT.md, "The employee writes to the client first").

Read this before touching `message_person` in `packages/orchestration/src/mcp-tools.ts`, `Notification.for` / `notificationFor` in `packages/contracts/src/entities.ts`, the notification filters in `apps/server/src/access.ts` (`stateFor`) and `hubs.ts` (`heardBy`, `broadcast`), the notification routes in `server.ts`, or `personMessage` in `apps/server/src/telegram.ts`.

## Whom an employee may write to

| `to` | goes to |
| --- | --- |
| `"boss"` (also "the boss", "owner", "owners") | every owner of the office — the root owner and every member who is an owner |
| a person's name, whole or the first name alone if only one person has it | that owner or colleague only |
| a visitor, somebody revoked or whose time is up, an employee, nobody | refused, with the list of people one can write to (`the boss, Ana, Vera`) — nothing is sent |

- **On a member's own computer** what is said stays with that member (as everywhere else): an employee there writes to that member only — "the boss" there is them — and anything else is refused.
- **The people** are the server's to know (members are kept by `Guests` in `apps/server/src/guests.ts`); it gives the office `comms.people()`: the root owner (`'owner'`, by the office's owner name) and every owner and colleague who is in now.
- **At most 20 in an hour** per employee (`tooMany`, "message to a person"): an employee that something it read steered is otherwise a way to flood somebody's Inbox and phone.
- Given to every employee, a team lead (`LEAD_ALSO`) and a rented employee too (`RENT_TOOLS` — it waits for nothing, so also on a rental that never waits for the office).


A message to the boss that reads as a question (a line ending in "?") is sent all the same, and the employee is told to
use `ask_boss` for one next time: the answer then comes back as its answer, and a project manager who answers questions
about its work in the boss's place sees it first (2026-11-27: questions put as messages went past both).

## What the person gets

- **A notification of the kind `message`**, addressed (`Notification.for`: member ids, or `'#owners'` = `FOR_OWNERS`): title `Ava: <the first line>` (`Ava · urgent: …` when `urgent`, severity *warning*; otherwise *info*), the whole message as its body (up to 4,000 characters), the employee and the task they were on.
- **Only to whom it is for — an owner included.** What is written to a colleague is not in an owner's Inbox, and what is written to the boss is in no colleague's: in the state a window is given (`stateFor`), on the live connection (`broadcast` scopes it, `heardBy` drops it), and in what *Mark all read* and *Dismiss* touch (`POST /notifications/read` and `/:id/resolve` act only on the person's own). A notification without `for` is the office's own and goes to everyone as before.
- **In the Inbox** it is under *Needs you* until it is dismissed (`NEEDS_KINDS`), and counts as *Mine* whoever the employee is (`waitsForMe`). A click goes to the employee.
- **On Telegram**: where that employee has a bot and the person paired with it privately, the bot sends the message (with ❗ when urgent) — once, as it is written; not again when it is read or when the office restarts. Replying there talks to the employee.
- **On the record**: an event `agent.message_to_person` — who wrote to whom, not what.

## Tests

- `packages/orchestration/test/message-person.test.ts` — the boss is every owner and no colleague; a colleague by whole or first name; urgent; an unknown name, a visitor, an empty message refused with whom one can write to; on a member's computer to that member only; twenty in an hour.
- `tests/e2e/63-message-person.test.ts` — through the door, as real windows: an owner is told at once and has it in their state, a colleague and a visitor do not; a colleague's message only they see, an owner's *Mark all read* and *Dismiss* leave it for them.
- `tests/e2e/59-telegram.test.ts` — "what she writes to the boss … comes to Telegram as well": sent by her own bot, marked urgent, not sent again when read.
- `apps/desktop/test/mine.test.ts` — a message to me is mine and needs me; dismissed, it does not.

## Not done / not seen

- Not tried with real Claude Code: whether employees reach for it when they should and not otherwise rests on the tool's description.
- The Inbox shows it as one line like any notification; there is no reply box in it — the answer is given to the employee (Talk, Telegram).
- Read state is still one per notification; it is per person in effect only because an addressed notification has its people.
