# Rent: employees the office rents out

_Built on 2026-11-16 on the owner's request: "we need a new thing — a new section in Access: we invite a person, but that person does not come into the office; they stay on the site (the office's address) and get access to certain agents we assign them. We basically 'rent' agents, and people talk to them and tell them things instead of us. In that space a rented agent may use only its own folder and the folders of the other rented agents that user has; it talks and coordinates only with them. A classic chat — a sidebar with options and the list of rented agents. What I say to the agents and what those users say must be kept apart — we talk to them separately — but the agents have the context and know everything in all the chats. And I can set the agent's permissions — what it may and may not do. The UI must be beautiful, on the office's address, in its design; the Rent UI in Access must be excellent and easy to use." The same day: "make the complete implementation of Rent in Access, with the UI on the office's address and the whole invitation system."_

A **client** is somebody the office rents employees to. They are not a member: they never come into the office. They get a link, choose a password, and talk to the employees they rent on the **Rent portal** — a chat at the office's address (`https://<the office's address>/rent`), on a computer or a phone. Read this before touching `packages/orchestration/src/rent.ts`, `apps/server/src/rent-door.ts`, the fence in `apps/host-agent/src/agent.ts` (`rentFence`), `apps/desktop/src/rent/` or `apps/desktop/src/hud/panels/rent.tsx`.

## Using it (the owner)

**Access → Rent** (the second tab; owners only):

1. **New client** → their name (they sign in with it), a company if you like (the employees are told whom they work for), the **employees they rent** (one client per employee), and **what they may do** (below). **Make the client and a link.**
2. **Send the link** that is shown (`https://<address>/r/K7QF-M2XP-9TRD`). It works **once, for a week**. The client opens it, sees whom they get, chooses a password — and is in the portal. Afterwards they sign in at `<address>/rent`, or at the office's own front door with their name (the door sends a client to the portal).
3. Opening a client's row: their employees, each with **what they may do** as switches (changed at once — in the session that is running, no restart), **Conversation** (what the client and that employee said, read-only), **×** to release one, **Another employee for them**, **your note** (for you only; never shown to the client or the employees), **New link** (what they came in with ends — password and sessions — and they set a new password with the link) and **End the rental…** (they are signed out, their employees are the office's again; the conversations stay to read under *ended rentals*).

The address people come to must be saved first (Access → Members): the link starts with it.

### What a rented employee may do

| Switch | On (default) means | Off means |
| --- | --- | --- |
| **Commands** | runs shell commands | Bash is refused |
| **Edit files** | changes files | only reads |
| **Web** | fetches pages, searches | WebFetch and WebSearch refused |
| **Teamwork** | talks to and works with the client's other rented employees, and reaches their folders | alone: neither |
| **Files** | the client sends files; the employee gives the client files (`attach_file`) | no files either way |
| **Vault** (off by default) | uses the office's credentials | — |
| **Memory** (off by default) | reads and writes the office's long memory | — |
| **Anywhere** (off by default) | past their folders: the whole machine and the servers the work needs (ssh, deploys); only the switches above hold — and the office's own files stay fenced | fenced to their folder (and co-rented colleagues', with Teamwork) |
| **Never waits** (off by default) | the client never waits for the owner: what the switches allow runs without an approval — the high-risk hold too — and they ask the owner nothing (`ask_boss` is not theirs); what is the client's to decide they ask the client | approvals and the high-risk hold as for any employee |

_Anywhere and Never waits were added on 2026-11-16 after the owner's first client waited: "I rented IsoStudio and Tracks3D; IsoStudio keeps asking me questions — that must not happen, the client must not wait: if I gave it permissions, it may do all of it — the server and everything else." IsoStudio had been asked to set up a staging site on a server; every command it ran to reach the server named paths outside its folder (the key in `~/.ssh`, paths on the server) and the fence refused it, so it asked the owner — four times — while the client waited. Rentals made before the two switches existed take both **on where every other switch was on** (the owner had given everything) and stay off otherwise (`Rent` constructor)._

Vault and memory are the **whole office's**, not this client's: off unless you mean it (the switch turns amber when on).

## What the client gets

- **The invitation page** (`/r/<code>`): the office's name, "Welcome, Ana", whom they get, a password twice. A used or old link says so and offers to sign in.
- **The employee's desk, in 3D** (2026-11-16, the owner: "make the chat look nicer, after office.sparkcan.com — use the agents' 3D models somewhere, beautiful, interactive, interesting"): beside the conversation (a band over it on a narrower screen or a phone) the employee sits at their desk — the office's own figure and furniture (`@orchestrator/office-3d/parts`) in a pool of light. They type while they write, read while they read, think while they think, rest when free, sleep at the desk when away; a thumbs-up and a word over their head ("Done!") when an answer comes; **a click is a hello** — they wave, "Hi Ana! 👋"; dragging turns the desk. Over it a tag like the office's: the name and what they are doing (AVAILABLE, READING, WRITING…); under it when they have worked for the client since and whether files go both ways. A button in the header hides the desk (remembered in the browser). The words for what they do are the client's own (`RentDoing`: thinking, reading, writing, running something, looking things up, waiting on the office) — never the office's inside names. The invitation page shows the whole team on their feet, waving in turn. three.js is loaded only when the 3D is shown (`AgentStage.tsx`, its own chunk), and not at all in a browser that cannot draw it.
- **The portal** (`/rent`): the office's name and *Rent portal* at the top of a side bar; **Your team** — each employee with their face, a dot (green available, gold working, grey away), the last word and an unread mark; the client's name and a menu (**Change password**, **Sign out**) at the bottom. Beside it, one conversation: the employee's face and state; the lines by day; the client's own in a violet bubble with *Sent* / *Seen*; the employee's answers with Markdown, pictures shown and other files to download; three dots while the employee works on it; a box that grows, **Enter** to send, **Shift+Enter** for a new line, files by the clip, by dropping them or by pasting a screenshot. Before the first word: the employee's face and a line saying what to do.
- **On a phone**: the team, and a conversation with a back arrow — one at a time. The office's own page tells a phone that the office is for a computer and links the portal.
- It looks like the entrance page: the office at night, the gold of the baton, the logo's violet and teal.

## What happens

- **A client writes** → `Rent.say`: the line is kept; if the employee has no session it is started (as the office's own window does); the message goes into their **real session** as `Message.channel: 'rent'` with `clientId`, with a frame the employee reads:

  ```
  On the Rent portal, Ana Client (Acme) writes — a client of the office who rents you:
  <what Ana wrote>

  (Your reply goes to Ana Client on the portal; they see only what you reply and the files you give them with
  attach_file, nothing of the office. While rented you work only in your own folder (/work/kira) and in those of
  Mila (/work/mila), whom Ana Client rents too — coordinate with them with send_message; the owner set that you
  run no commands. What the boss tells you in the office is not for clients unless the boss says so.)
  ```
- **Whose a turn is**: the office notes what began each turn — the message marker in `UserPromptSubmit`, or a message handed over as the Stop hook's feedback (`Rent.turnStarted`) — and tags that turn's events with `rentClientId`. The end of a client's turn (`agent.turn_finished`) becomes the employee's line in **that client's** conversation; a file given in it (`attach_file`, no task) goes there too. A turn begun by anything else (the owner's message, a task, a person at the keyboard) is the office's.
- **Kept apart**: the owner's **Talk** leaves out messages with `channel: 'rent'` and events with `rentClientId`; the client's portal shows only their conversation. The employee is one session and knows both — told that what the boss says in the office is not for clients unless the boss says so. The feed says only "Ana wrote to Kira on the Rent portal".
- **One client per employee**: on the office's own machines, or on **the renting owner's own computer** (added the same day, the owner: "it must have my agents from my computer too — of course they work only while my computer is connected"). Not another member's own employee (only that member could rent them), not the foreman, not a team lead; a computer whose app is older than Rent is refused (its agent could not fence them — `HostInfo.rentFence`). While that computer is off the employee is **away**: what a client writes is kept and waits (the conversation says so; files wait for them to be back), and when the computer connects again, the rented employees who have a client's words waiting are started (`wakeWaiting`). A colleague's folder is reached only on the same machine. While rented an employee is **not** given office work by the scheduler, the foreman (`assign_task`) or a member's team lead; the owner still talks to them and can give them a task by hand.

## The wall and the fence

- **The wall** (`Rent.reaches`, used by `Comms.resolveTeammate`, `get_team`, `request_help`): a rented employee reaches only the employees the **same client** rents, both with Teamwork on. Nobody else in the office reaches a rented one — except the foreman, which supervises for the owner. A name across the wall is "No teammate matches".
- **The office's tools** (`Rent.toolAllowed`, wrapping every MCP handler and the list Claude Code is shown): a rented employee gets a fixed set — status and progress, `ask_boss`, messages and requests to colleagues (with Teamwork), goals, their own tasks — plus `attach_file` (Files), `vault_*` (Vault), `recall`/`remember` (Memory). Not the board (`propose_tasks`, `claim_task`, …), lessons, hiring, the foreman's or a lead's tools. **Anything new stays out until named in `RENT_TOOLS`.**
- **The fence on the machine** (`LaunchSpec.fence`; `session.fence` changes it live; `rentFence` in the host agent, on every `PreToolUse`):
  - the tools the owner did not allow are refused (Bash; Edit/Write/MultiEdit/NotebookEdit; WebFetch/WebSearch) — and also left out of Claude Code's own rules at the next start (`denyRulesFor`);
  - a file or folder named to a file tool (`file_path`, `path`, `notebook_path`, an absolute Glob pattern) must be inside their folder, the session's folder, a co-rented colleague's folder (with Teamwork), the files said to them, or the system's own (`/usr`, `/bin`, `/opt/homebrew`, `/dev`, `/tmp`, `/var/folders`) — links resolved;
  - a command is read for the paths it names (from the root, from home — `~`, `$HOME` — or climbing out with `..`); one outside is refused. Web addresses are not paths.
  - Co-rented colleagues' folders are also given to Claude Code as extra directories (`addDirs`).

## Coming in: links, passwords, sessions

- A client's credential is of its own kind (`client` in the credentials table). Nothing else takes it: `/api`, the office's WebSocket and `/mcp` answer it as a stranger (401). All a client reaches is `/rent/api`, and there only the employees they rent (anything else is 404).
- **Links**: the members' invitation codes, kept apart (`Invites` with `rent.invites`): 12 characters, only a hash stored, one use, a week, ten wrong codes from an address and it waits. `GET /rent/join/:code` tells whom a link is for without using it up (`peek`); `POST /rent/join` sets the password first and uses the link up only then.
- **Passwords**: the members' sign-in, kept apart (`Logins` with `rent.logins`, kind `client`): scrypt, 8–200 characters, not the name, five wrong in a row close the name for a while (doubling), limits per address and for everybody. A session is 30 days. **Changing the password** needs the current one and ends the other sessions. **A new link** takes the password away and ends every session. **Ending the rental** ends all of it.
- **One name space at the door**: a client cannot have a member's name (or the owner's, "Owner", "The boss"), and a member cannot be invited under a client's name. `POST /login` with a client's name signs in a client (`kind: "client"`); the front door's form sends them to `/rent`.
- **Phones**: `/rent`, `/r/…`, `/rent/api/…` and the page's files are not turned away from a phone (the office itself still is).

## Routes

| | |
| --- | --- |
| Public | `GET /rent`, `GET /r/:code` (the page, with `<base href="/">`), `GET /rent/join/:code`, `POST /rent/join`, `POST /login` (shared with members) |
| Client (`Authorization: Bearer <client session>`) | `GET /rent/api/me`; `GET /rent/api/chats/:eid?after=<line id>` (new lines, and how far the client's last lines got); `POST /rent/api/chats/:eid` `{text, files}`; `POST …/files` and `…/files/:fid/data` (upload in pieces, as Talk does); `GET …/files/:fid` (only a file of that conversation); `POST /rent/api/password`; `POST /rent/api/logout` |
| Owner (`/api`, owners only — not listed in `access.ts`) | `GET /api/rent`; `POST /api/rent/clients`; `PATCH`/`DELETE /api/rent/clients/:id`; `POST …/:id/link`; `POST …/:id/agents`; `PATCH`/`DELETE …/:id/agents/:eid`; `GET …/:id/chats/:eid` and `…/files/:fid` |
| At the door | `/rent…` and `/r/<code>` pass (`door.ts`, `ALLOWED`) |

Who sees what in the office: messages with `channel: 'rent'`, events with `rentClientId` and `rent.*` events are for **owners** only (`mayReadMessage`, `eventFor` in `access.ts`). Not in the public demo (its owners may not touch `/api/rent`).

## Where the code is

| | |
| --- | --- |
| Model | `packages/contracts`: `RentClient`, `Rental`, `RentPerms` (`RENT_PERMS_DEFAULT`), `RentLine`, `RentFence`; `Message.channel: 'rent'`, `Message.clientId`; `LaunchSpec.fence`; RPC `session.fence`; the event `rent.changed` |
| Engine | `packages/orchestration/src/rent.ts` (`Rent`: clients and rentals in kv `rent.clients`; conversations in kv `rent.chat.<client>.<employee>`, the last 3000 lines each); hooked in `hook-receiver.ts` (whose turn), `comms.ts` (the wall in `resolveTeammate`; a Stop-hook delivery begins a turn; a quiet feed line), `mcp-tools.ts` (tools, `get_team`, `request_help`, `attach_file` to the client), `registry.ts` (`buildSpec`: fence, deny rules, extra folders), `tasks.ts` / `foreman.ts` / `lead.ts` (no office work), `prompts.ts` |
| Machine | `apps/host-agent/src/agent.ts`: `rentFence`, `rentReach`, `session.fence` |
| Server | `apps/server/src/rent-door.ts` (`RentDoor`: client sessions, links, passwords, both sides' routes); `logins.ts` and `invites.ts` take a kind and a store of their own; `server.ts` (`/login`, phone, member names); `door.ts`; `access.ts` |
| Portal | `apps/desktop/src/rent/RentPortal.tsx`, `rent.css`; chosen by the address in `main.tsx` (which now loads the office only for the office) |
| Owner's window | `apps/desktop/src/hud/panels/rent.tsx` (`RentTab`), a tab of Access (`people.tsx`); Talk leaves the client's out (`talk.tsx`); the front door's sign-in sends a client on (`Knock.tsx`) |
| Tests | `packages/orchestration/test/rent.test.ts` (rentable, the wall, the tools, the fence and its live push, permissions, whose turn); `apps/host-agent/test/rent-fence.test.ts` (files, commands, links, the switches); `apps/server/test/access.test.ts` (owners only); `tests/e2e/60-rent.test.ts` (the whole way, with real sessions: the link and a password, a client reaches nothing else, an answer to the client and not the owner and back, the wall both ways, the fence and a live change without a restart, a file to the client, ending it); the UI suite's Rent step (Access → Rent, the link opened in a second browser, a password, a conversation, a phone, the owner reading it there and not in Talk, ending it) |

## Never waits, in the office

- A permission request of a rented employee who never waits, for a tool their switches allow, is answered **allow** at once by the office and audited (`rent.allowed_unasked`); what the machine escalated as the office's own files stays the owner's (`hook-receiver.ts`).
- The high-risk list does not hold them: it is left out of their launch (`buildSpec`), skipped by their machine while the session runs (`fence.autonomous`, live), and a held call of a session started before is let through.
- `ask_boss` and `wait_for_answer` are not theirs; the frame of each client message tells them to decide and go on, and to ask the client in their reply.

## Limits, plainly

- **The fence is a fence, not a wall.** File tools are checked exactly; a command is read for the paths it writes out. A path a command builds itself (`cat $(echo L2V0Yw== | base64 -d)/passwd`), or a program that opens files of its own accord, is not seen. For a hard boundary switch **Commands** off — or give a rented employee a machine of their own. The system's programs and `/tmp` are readable.
- **The employee is one session.** It knows what the owner said and what the client said; it is told not to pass the office's word to a client, which is an instruction, not an enforcement. Whatever the owner does not want a client to learn should not be said to an employee that client rents.
- **The office's own machines and the renting owner's own computer**, one client each. Another member's own employee cannot be rented by an owner. An employee on a computer that is off answers only once it is back.
- **Questions and permission prompts** of a rented employee go to the office's Inbox as ever (the owner decides); the client is asked in the conversation itself.
- The portal **asks** for news (every 1.5 s for the open conversation, 5 s for the team) rather than being told: fine for a handful of clients, not tried with many.
- **Tried against the scripted stand-in** (`tests/fixtures/fake-claude.mjs`), not yet with real Claude Code and a real client; the fence was tried with the stand-in's real shell commands and file tools.
