# Access: members, roles, shared and personal

Everything here is enforced in one place, `apps/server/src/access.ts` (HTTP routes and WebSocket messages). The client mirrors it in `apps/desktop/src/lib/access.ts` only to hide or explain controls; the office decides.

## Who there is

| | How they get in | Notes |
| --- | --- | --- |
| **Root owner** | The server's own owner token (`~/.orchestrator/server/owner-token`), on the server's machine | Never accepted through the door. Used by the local office, by `pnpm office …`, and by a desktop app running on the same machine |
| **Member: owner** | An invitation | Full rights from anywhere |
| **Member: colleague** | An invitation | Works on what is shared; has a computer of their own in the office |
| **Member: visitor** | An invitation | Looks at the office: who is here, who works on what, how the shared work stands, the shared terminals. Is sent nothing else ("What a visitor is sent") |

An invitation is a **short link**: the address the owner set for the office and a code — `https://office.example.com/join/K7QF-M2XP-9TRD`. The person pastes it into the desktop app (**Connect to an office**); the app exchanges the code at the office's door, **once**, for what it keeps from then on: the office's addresses, the fingerprint of the door's certificate and a credential of the member's own. A link is good for a week and for one use; a new link (**Access → New link**, `pnpm office reinvite`) ends what the member had before. In a browser the link is a page that says what to do with it; opening it uses nothing up. Only hashes are stored — of the code and of the credential.

- A link to the door itself (an address with a port, e.g. `https://192.168.0.5:4610/join/K7QF-M2XP-9TRD.3fa9c01b22d4e6a17c05`) ends in the start of the fingerprint of the door's certificate, and the app accepts only that certificate. A link to an address without a port is answered by something with a certificate for that name (a reverse proxy), which the app checks the way a browser does.
- `POST /join` and `GET /join/:code` exist only at the door (404 on the office's own port) and need no credential. Ten wrong codes from one address in ten minutes and that address waits.
- An office with **no address set** cannot make a link (there is nothing to put in it): `POST /api/guests` then answers with the whole connection as one long text (`orch-invite-v1.…`) that the app also accepts. The Access window asks for the address first instead.

Revoking, re-inviting and changing a role take effect at once (open windows are disconnected and come back with the new role).

## Shared and personal

A machine (host) is either **shared** or **a member's own computer** (`Host.memberId`). Everything that lives on a machine takes after it: its employees, their sessions and terminals, projects whose repository is there, tasks of those projects, questions of those employees.

- The office server's own machine, enrolled machines and SSH-linked servers are shared.
- A member's own computer joins while their desktop app has the office open, and only through the door. Its employees sit in the member's room.
- Work does not cross: a personal employee works only on projects on the same computer; a shared employee is never put on a project that lives on someone's computer; the scheduler never routes shared work to a personal employee, and the foreman — which supervises everyone — never assigns across that line either. An employee cannot wait for a colleague on the other side either (`wait: true`, `wait_for_colleague`), and a task on the other side is answered like one that does not exist.

**Moving an employee between machines** (`MOVE.md`) takes whoever may work with them and on the machine they go to; their privacy is the new machine's from then on — moved onto a member's computer, the member's (and their room's); moved to a shared machine, everybody's who works here.

A **server a member brought in themselves** (My room → My servers; `Host.ownerId`) is that member's own machine like their computer — until they share it. Shared, it is a shared machine in every respect (`Host.memberId` is null); it stays theirs to take back or remove (`PATCH`/`DELETE /me/servers/:id`: its owner, or an owner of the office).

## The rules

`need` is what an action requires: **read** (look), **work** (change, or reach into a machine), **admin** (run the office).

| | shared | a member's own computer |
| --- | --- | --- |
| read | everyone | that member, owners |
| work | colleagues, owners | that member, owners |
| admin | owners | owners |

Other members still see that a personal employee exists and its state (name, activity, in the member's room). They do not get its terminal, monitor frames, documents, diffs or history, and cannot talk to it.

### A closed room
A member can close their room (`PUT /me/room` with `locked: true`). Then, for everything on that member's own computers and the servers they keep to themselves, the table above has one line: **that member, and nobody else** — at every level, for owners, the office's own computer and the foreman alike (`closedTo`). Everyone still sees that the employees are there and what state they are in. Not closed: a server the member shared; and what is about the office rather than about what is on a machine — members, machines, settings — so an owner can still revoke that member or their machines. The foreman passes a closed room by: it is not called for what happens there and its tools refuse (`look_at`, `answer_question`, `tell_employee`, `assign_task`).

### The foreman: owners only
The foreman is neither shared nor a member's. It supervises the whole office — **including members' own employees while their computer is connected**: it is shown the last lines of their terminals, answers their questions and tells them what to do next, as an owner could. So what is the foreman's is for owners alone (`memberOf` answers `OWNERS_ONLY` for its profile, its session and its questions):

- colleagues and visitors cannot watch or type into its terminal, read its documents or history, talk to it, start or stop it, or change its profile;
- only an owner can hire a foreman or make someone the foreman (`POST`/`PATCH /employees` with the role `foreman`);
- everyone still sees that it exists, where it walks and what it is doing (its events carry who it visited and why, never what was on a screen).

There is one foreman, on one of the office's own machines, never on a member's computer (the engine refuses both). Work it hands out stays on the computer its project is on, as everywhere else.

### What each level covers

- **read** — the office state (for a visitor: what a visitor is sent of it, below), people, events, what the hi-fi is playing (`GET /radio`, `GET /radio/now`, and the `radio` message every window gets), an employee's XP, a session's history, watching a terminal.
- **detail** — reading what is behind a thing, for those who work here (colleagues and owners; a visitor is refused): `GET /routines` (the routines of employees one may read); how much of each Claude account is used (`GET /usage`: percentages; whose account it is only for those who may *work* on the machine it lives on); performance; documents and git view of an employee; a task's diff and its attached files; a project's integration status; `GET /growth/log`.
- **detail** (counted from what one may see) — `GET /growth/outcomes`: whether what the office learned helped. An owner gets the whole office; anyone else gets figures counted without the tasks, employees and projects on other members' computers, and without the lessons and improvements about them (`outcomesScopeFor`; `docs/learning/outcomes.md`).
- **work** (own only) — `GET`/`PUT /me/room`: how one's own room looks. Nobody arranges someone else's.
- **work** (own only) — `GET`/`POST /me/servers`, `PATCH`/`DELETE /me/servers/:id`: bringing a server of one's own into the office, sharing it, taking it back, removing it. The route checks whose the server is; an owner may do it for any member's.
- **work** — employees: hire, edit, start/stop/pause/resume, talk, request a report; routines of an employee: `POST /routines` (the employee named in the body), `PATCH`/`DELETE /routines/:id`, `POST /routines/:id/run`; sessions: attach, adopt, bind; typing into and taking control of a terminal; browsing a machine's folders and its Claude processes; projects: create, edit, pause/resume, plan, integration sync/test; tasks: create, edit, delete, release, review, unblock, retry merge; answering questions **and deciding permission requests**; notifications; meetings; lessons; planning a command; `POST /me/host`; switching the office's hi-fi on and off (`POST /radio/play`, `POST /radio/stop`).
- **work, on one's own computer only** — deleting a project that lives there (`DELETE /projects/:id`): nobody else's work is in it. The same on a shared project is **admin**.
- **owners only, on a shared project** — changing its permission policy: what it pre-approves (`policy.allow`), refuses (`policy.deny`) and holds for approval (`policy.highRiskPatterns`). A colleague may change everything else about a shared project (the project window sends the whole policy with every save; only a *change* of those three is refused), and all of it on a project on their own computer.
- **anybody, signed in or not** — `POST /login` (at the door): a name and a password for a member's session; see `SECURITY.md`, "Signing in with a name and a password".
- **read** (own only) — `POST /me/password`: set one's own password, or change it knowing the current one; `POST /logout`: end the browser session one is signed in with. **admin** — anybody else's: `POST`/`DELETE /guests/:id/password`. `GET /me` says whether one has a password and whether this session was made with it.
- **nobody, from a phone** — whatever the role, a request whose browser says it is a phone gets the "on a computer" page (or a 403) before any rule here is looked at (`phone.ts`). Host agents, employees' sessions and health checks are not people and are not judged by it.
- **admin** — putting an employee on *Unrestricted* (bypass mode), when hiring or in the profile: `POST`/`PATCH /employees` with `autonomy: "unrestricted"`. Lowering anybody's level stays **work**.
- **work** — stepping into a task: `POST /tasks/:id/correct` (change it and tell whoever has it) and `POST /tasks/:id/stop` (interrupt them; on hold, or `then: "delete"`).
- **read** — opening a file that is on a task one may see (`GET /tasks/:id/attachments/:aid`). **work** — attaching one and removing one (`POST /tasks/:id/attachments`, `POST …/:aid/data`, `DELETE …/:aid`). An employee leaves evidence only on a task it does or reviews (`attach_file`).
- **work, on one's own computer only** — deleting an employee who lives there for good (`DELETE /employees/:id`, `?tasks=delete` to take their tasks too). The same on a shared employee is **admin**. (Archiving is an edit: **work**.)
- **work** (the shared office) — the vault's list and adding to it: `GET /vault` (names, what each is for, who put it there and who used it last — never a value), `POST /vault`. A visitor gets neither, not even the names.
- **admin** — a value out of the vault (`POST /vault/:id/reveal`, recorded), changing what is known about a credential, putting a new value in under the same name (`PUT /vault/:id/value`, recorded as `vault.changed`) and removing one (`PATCH`/`DELETE /vault/:id`).
- **admin** — a machine's Claude accounts: adding one, checking who is logged in, moving its employees to another, taking it off the list (`POST /hosts/:id/accounts`, `…/accounts/check`, `…/accounts/move`, `DELETE /hosts/:id/accounts`). Everyone still reads the percentages (`GET /usage`).
- **admin** — everything else, including: **deleting a shared employee** (`DELETE /employees/:id`), **deleting a shared project** (`DELETE /projects/:id`; a member may delete the projects on their own computer, see above), members and the door, settings and policies, layout, machines (enrollment tokens, revoke, rename, remove), SSH links, foreman status, audit log, improvements, promoting to the main branch, executing a command plan.

A route that is not listed in `access.ts` needs an owner.

### What the office changes by itself (the autopilot)
Applying an improvement, and undoing one (`POST /api/improvements/:id/apply`, `/revert`), are **admin**: owners only. Under the autopilot dial ([learning/autopilot.md](learning/autopilot.md)) the office applies some improvements itself. It keeps the line between shared and personal:

- on **shared** machines, the permission decisions of anyone who may make them (owners and colleagues) count as evidence;
- on **a member's own computer**, allow rules, deny rules and a higher autonomy level are applied only on decisions that member made themselves (each decision records who made it). An owner's approvals there do not count, and changes that rest on nobody's decision (lower autonomy, review off) are never automatic there;
- the **foreman** is never changed by it.

### The vault
The office's credentials (`packages/orchestration/src/vault.ts`; `docs/SECURITY.md`, "The vault").

- **People:** owners see the list, add, look at a value (recorded), change and remove. Colleagues see the list and add. Visitors get nothing.
- **Employees' sessions:** every employee — on the office's machines or on a member's own computer — may list what is there (`vault_list`), put a credential in (`vault_store`, or the helper's `put`) and take a value out for a command (the helper's `get`). A session is known by its own token at the worker endpoint; each use is recorded under the employee's name. There is no per-credential permission: what is in the vault is the office's, for everyone who works in it.
- **By itself:** the office moves a credential out of a message, a task or an answer somebody wrote (it goes on with `{{vault:name}}`), and keeps a key in a well-known format that went through a session.

### The door bell (knocking)
A person with no invitation can knock at the office's door — the office's page in a browser, or the desktop app given only the address. Knocking grants nothing; it puts a name and a four-digit code in front of the people inside.

- `GET /knock`, `POST /knock`, `GET /knock/:id`, `DELETE /knock/:id` — no credential; only through the door (404 on the office's own port). The knocker's poll is authorised by a secret only they hold (`x-knock-secret`); the credential they are given is handed over once.
- `GET /api/knocks`, `POST /api/knocks/:id/admit`, `POST /api/knocks/:id/refuse` — **work**, so owners and colleagues; visitors are neither told about knocks nor able to answer.
- Who may let whom in: an **owner** as visitor, colleague or owner; a **colleague** only as a visitor; **a knock from a browser only ever becomes a visitor**, whoever answers, and that member expires after 12 hours. A knock from the app becomes an ordinary member (shown in Access as "let in at the door"), revocable like any other.
- Limits: 2 waiting and 6 knocks per ten minutes per address, 10 waiting in all; a knocker who stops asking is gone after 25 s; nobody waits longer than 10 minutes; an admission nobody collects within a minute is revoked.

### The hi-fi
The hi-fi plays for the whole office, so what is on is the office's, not a window's.

- **Everyone** in the office, visitors included, is told what is playing and hears it; their own volume and mute are theirs (per computer) and need no permission.
- **Owners and colleagues** switch a station on or off for everyone (**work**). A visitor cannot: the buttons are not shown, and the office refuses the request.
- **Owners** keep the list of stations (it is in the settings: **admin**). A play request names one of the saved stations; an address that is not on the list is refused, so nobody can make the other windows load an address of their choosing.
- Who switched it is shown to everyone (the member's name) and, for members, is in the audit log like any other change.

### Talking, gestures and the whip between people
- **Everyone with a character in the office** — visitors included — may talk (push-to-talk), make gestures and crack the whip at a person nearby. None of it changes anything in the office, so it needs no level; each is rate-limited per window.
- **A voice is passed only to those in earshot**: within range of the speaker and on the same side of a closed meeting room's walls. The office decides it per frame from where the characters stand; a window without a character neither speaks nor hears.
- **The whip getting somebody up** (since 2026-11-13): a crack at an employee who is asleep or was never started starts their session, or takes up the one they left — for whoever may press *Start* for that employee anyway (the rule of `POST /employees/:id/start`: level **work**; not a visitor; not in someone's closed room; a personal employee only by its member or an owner; the foreman only by an owner), and only when they can be started. For anyone else, and at somebody who is at work, the crack stays a crack.
- **The whip approving** (Settings → Employees → *The whip approves*, an owner's setting, off by default) answers only the permission questions the whipper may answer anyway: the same check as the Allow button (level **work**, not a visitor; not in someone's closed room; a personal employee only by its member or an owner). For anyone else the crack stays a crack.

### A member's team lead
A member may have one employee with the role **Team Lead** on their own computer or server. It is an employee on a member's machine like any other — its terminal, conversation and questions are that member's and the owners' — with tools that reach **that member's employees and nobody else's**; with `leadScope: 'office'` (the member's choice) the shared employees as well, which that member may direct anyway. It hires onto the member's own machines only, five people at a time at most, never as Unrestricted. Hiring one is level **work** on one's own machine, like any hire there; the office refuses a lead on a shared machine and a second lead for the same member. `docs/TEAM-LEAD.md`.

### Files said to an employee
`POST /employees/:id/files`, `…/files/:fid/data`, `GET …/files/:fid` — level **work** on that employee, like talking to them. The upload is its sender's alone until the message that names it is sent.

### An employee's Telegram bot
`GET/PUT/PATCH/DELETE /employees/:id/telegram`, `POST …/telegram/pair` and `…/check`, `DELETE …/telegram/people/:tg`, `PATCH/DELETE …/telegram/groups/:chat` — level **work** on that employee, like talking to them (so not a visitor; a colleague for their own employees and the shared ones open to them). Whoever pairs from Telegram speaks as the member who made the link, and that member's **work** on the employee is checked again for every message (`docs/TELEGRAM.md`). Not in the public demo.

### The central context
`GET /context` and `GET /context/pack/:employee` are **detail**; writing facts (`POST`/`PATCH`/`DELETE /context/facts…`, accepting and dropping proposals) is **work**, then by layer: the office's and a role's — owners and colleagues; a project's — whoever may work on the project; an employee's own notes — whoever may work with that employee (and the employee itself, through `propose_context`); a client's — owners only, and only owners are sent them. `docs/CONTEXT.md`.

### The Rent portal's clients
A **client** is not a member and is in no table above: they never come into the office. Their credential is of its own kind (`client`) and opens only `/rent/api` — the employees they rent, and nothing of the office (`docs/RENT.md`). Everything about clients — `GET/POST/PATCH/DELETE /api/rent…`, reading their conversations — is **admin** (owners), as is what is said with them: messages with `channel: 'rent'` and events carrying `rentClientId` or of type `rent.*` are sent to owners only (`mayReadMessage`, `eventFor`). A rented employee reaches, and is reached by, only the employees the same client rents (and the foreman); they are fenced to their folders on their machine.

### A shared employee a member looks after
`POST /employees/:id/keep` and `/give-back` (level **work**; a member, not the office's own computer) set and clear `Employee.keptBy` on a shared employee. It is a mark for lists and for that member's team lead; **it gives and takes no access**. One member at a time: taking over somebody else's, or giving them back for them, is an owner's.

### What a visitor is sent
A visitor is in the office to look at it. What they may know is decided on the server (`shownTo` and `stateFor` in `access.ts`, used for `GET /api/state`, the `ready` state and every live `entity` message), not by the page hiding things: a hidden field would still be in their browser.

| Of the office | A visitor is sent |
| --- | --- |
| Employees (members' own and the foreman too) | Who they are and how they look, their role and title, skills, project, desk, level. **Not** the model and effort, the autonomy level (a fixed value is sent in its place), instructions, allowed and refused tools, the working folder, the Claude account folder |
| Sessions | That one runs and what state it is in. **Not** the folder, the branch, the tmux name, the process, Claude Code's session id, the permission mode, the model, the tokens and the cost |
| Machines | That they are there, whose they are, and the member's room. **Not** the host name, the user, versions, what runs on them, the account folders |
| Shared projects | Name, description, colour, state, milestones. **Not** where the repository is, branches, the check command, what is pre-approved or refused, the integration record. A member's own project: not at all |
| Shared tasks | Key, title, state, who has it, priority, the percentage done. **Not** the description, what counts as done, the conversation on it, branch and worktree, files, evidence, history, why it is blocked, attachments. A task is sent field by field — only the fields named for a visitor — so that whatever a task is given later stays out until somebody decides otherwise (the test puts an unknown field on a task and expects it gone). A member's own task: not at all |
| Meetings | Topic, state, who takes part. **Not** what was said or decided |
| Events | That something happened, when, and to which employee, task and project — so people move in the scene. **Not** the line for the feed nor what the event carries (so no reply, no command, no account, no vault name). A visitor's page shows no feed |
| Questions, messages, requests between employees, notifications, reports, lessons, improvements, performance, routines | Nothing |
| Settings | The office's name, the scene, the keys, the hi-fi and TV lists. The two switches that say whether high-risk requests are held are sent as "held" whatever they are |
| Terminals | The shared ones, to watch — **the owners' word of 2026-11-12**. A terminal shows whatever Claude Code prints, which can include the model, the account and folders: that is the one place a visitor can still read them. Invite visitors accordingly |
| Chat, voice, gestures, the hi-fi, who is here | As everyone, while they are in — **not** the chat's last hour on walking in (`chat.history`; the owner, 2026-11-27) |

The page follows: a visitor's menu holds only the windows they are sent something for (`lib/visitor-panels.ts` — Tasks, Team, Access, Map, Terminals, Hi-fi, TV, Settings, Help; a task's card on the board is all there is of it, so it opens nothing), the other windows do not open from the keys either, there is no Inbox, Command or feed, and an employee's window is one card (who they are, what they are on, *Watch terminal*).

**Not done:** between members nothing changed — a colleague is still sent the tasks, notifications and reports of other members' computers (the last paragraph of the next section).

### What is said on a member's own computer
Feed events about a member's own employees (they carry what the employee replied), messages to and from them and their questions are sent only to that member and to owners: filtered in `GET /api/state`, `GET /api/events`, the `ready` state and the live `event` / `entity` messages (`stateFor`, `mayReadEvent`, `mayReadMessage`, `mayReadQuestion` in `access.ts`). The same goes for their **routines** (what they are told to repeat): `mayReadRoutine`, in the state, in `GET /api/routines` and on the live connection. A routine is whose its employee is: a colleague sets routines for shared employees and for those on their own computer; the foreman's are the owners'. The sleep setting (Settings → Employees) is an office setting: owners only. Not yet filtered: their tasks, notifications and artifacts. **A notification addressed to some people** (what an employee writes with `message_person`, `Notification.for`) goes to them only — an owner included — in the state, on the live connection and in *Mark all read* / *Dismiss* (`MESSAGE-PERSON.md`).

### Terminals (WebSocket)

- `term.open`, monitor frames (`term.screen`), `screens.focus`: **read** on the session.
- `term.input`, `term.resize`, `control.acquire`: **work** on the session.
- Frames of a session a client may not read are never sent to it.

## Per-client preferences

Graphics quality, key bindings, office extras and how loud the hi-fi is here (volume, mute) belong to each computer (`prefs.json` in the app's data folder), not to the office; every role can change their own.

## Changing this

1. Add or change the rule in `apps/server/src/access.ts` and the matching unit test (`apps/server/test/access.test.ts`).
2. If a control should disappear for someone, use `useAccess()` / `may()` from `apps/desktop/src/lib/access.ts`.
3. Update this file and `SECURITY.md`.
