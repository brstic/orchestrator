# Access: members, roles, shared and personal

Everything here is enforced in one place, `apps/server/src/access.ts` (HTTP routes and WebSocket messages). The client mirrors it in `apps/desktop/src/lib/access.ts` only to hide or explain controls; the office decides.

## Who there is

| | How they get in | Notes |
| --- | --- | --- |
| **Root owner** | The server's own owner token (`~/.orchestrator/server/owner-token`), on the server's machine | Never accepted through the door. Used by the local office, by `pnpm office …`, and by a desktop app running on the same machine |
| **Member: owner** | An invitation | Full rights from anywhere |
| **Member: colleague** | An invitation | Works on what is shared; has a computer of their own in the office |
| **Member: visitor** | An invitation | Reads what is shared |

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

## The rules

`need` is what an action requires: **read** (look), **work** (change, or reach into a machine), **admin** (run the office).

| | shared | a member's own computer |
| --- | --- | --- |
| read | everyone | that member, owners |
| work | colleagues, owners | that member, owners |
| admin | owners | owners |

Other members still see that a personal employee exists and its state (name, activity, in the member's room). They do not get its terminal, monitor frames, documents, diffs or history, and cannot talk to it.

### The foreman: owners only
The foreman is neither shared nor a member's. It supervises the whole office — **including members' own employees while their computer is connected**: it is shown the last lines of their terminals, answers their questions and tells them what to do next, as an owner could. So what is the foreman's is for owners alone (`memberOf` answers `OWNERS_ONLY` for its profile, its session and its questions):

- colleagues and visitors cannot watch or type into its terminal, read its documents or history, talk to it, start or stop it, or change its profile;
- only an owner can hire a foreman or make someone the foreman (`POST`/`PATCH /employees` with the role `foreman`);
- everyone still sees that it exists, where it walks and what it is doing (its events carry who it visited and why, never what was on a screen).

There is one foreman, on one of the office's own machines, never on a member's computer (the engine refuses both). Work it hands out stays on the computer its project is on, as everywhere else.

### What each level covers

- **read** — the office state, people, events, performance; `GET /routines` (the routines of employees one may read); what the hi-fi is playing (`GET /radio`, `GET /radio/now`, and the `radio` message every window gets); how much of each Claude account is used (`GET /usage`: percentages for everyone; whose account it is only for those who may *work* on the machine it lives on); documents, git view, XP of an employee; a task's diff; a project's integration status; a session's history; watching a terminal.
- **read** (counted from what one may see) — `GET /growth/outcomes`: whether what the office learned helped. An owner gets the whole office; anyone else gets figures counted without the tasks, employees and projects on other members' computers, and without the lessons and improvements about them (`outcomesScopeFor`; `docs/learning/outcomes.md`).
- **work** (own only) — `GET`/`PUT /me/room`: how one's own room looks. Nobody arranges someone else's.
- **work** — employees: hire, edit, start/stop/pause/resume, talk, request a report; routines of an employee: `POST /routines` (the employee named in the body), `PATCH`/`DELETE /routines/:id`, `POST /routines/:id/run`; sessions: attach, adopt, bind; typing into and taking control of a terminal; browsing a machine's folders and its Claude processes; projects: create, edit, pause/resume, plan, integration sync/test; tasks: create, edit, delete, release, review, unblock, retry merge; answering questions **and deciding permission requests**; notifications; meetings; lessons; planning a command; `POST /me/host`; switching the office's hi-fi on and off (`POST /radio/play`, `POST /radio/stop`).
- **admin** — everything else, including: members and the door, settings and policies, layout, machines (enrollment tokens, revoke, rename, remove), SSH links, foreman status, audit log, improvements, promoting to the main branch, executing a command plan.

A route that is not listed in `access.ts` needs an owner.

### What the office changes by itself (the autopilot)
Applying an improvement, and undoing one (`POST /api/improvements/:id/apply`, `/revert`), are **admin**: owners only. Under the autopilot dial ([learning/autopilot.md](learning/autopilot.md)) the office applies some improvements itself. It keeps the line between shared and personal:

- on **shared** machines, the permission decisions of anyone who may make them (owners and colleagues) count as evidence;
- on **a member's own computer**, allow rules, deny rules and a higher autonomy level are applied only on decisions that member made themselves (each decision records who made it). An owner's approvals there do not count, and changes that rest on nobody's decision (lower autonomy, review off) are never automatic there;
- the **foreman** is never changed by it.

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

### What is said on a member's own computer
Feed events about a member's own employees (they carry what the employee replied), messages to and from them and their questions are sent only to that member and to owners: filtered in `GET /api/state`, `GET /api/events`, the `ready` state and the live `event` / `entity` messages (`stateFor`, `mayReadEvent`, `mayReadMessage`, `mayReadQuestion` in `access.ts`). The same goes for their **routines** (what they are told to repeat): `mayReadRoutine`, in the state, in `GET /api/routines` and on the live connection. A routine is whose its employee is: a colleague sets routines for shared employees and for those on their own computer; the foreman's are the owners'. The sleep setting (Settings → Employees) is an office setting: owners only. Not yet filtered: their tasks, notifications and artifacts.

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
