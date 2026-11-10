# Access: members, roles, shared and personal

Everything here is enforced in one place, `apps/server/src/access.ts` (HTTP routes and WebSocket messages). The client mirrors it in `apps/desktop/src/lib/access.ts` only to hide or explain controls; the office decides.

## Who there is

| | How they get in | Notes |
| --- | --- | --- |
| **Root owner** | The server's own owner token (`~/.orchestrator/server/owner-token`), on the server's machine | Never accepted through the door. Used by the local office, by `pnpm office …`, and by a desktop app running on the same machine |
| **Member: owner** | An invitation | Full rights from anywhere |
| **Member: colleague** | An invitation | Works on what is shared; has a computer of their own in the office |
| **Member: visitor** | An invitation | Reads what is shared |

An invitation (`orch-invite-v1.…`) carries the office's addresses, the fingerprint of the door's certificate and a token. Only the token's hash is stored. Revoking, re-inviting and changing a role take effect at once (open windows are disconnected and come back with the new role).

## Shared and personal

A machine (host) is either **shared** or **a member's own computer** (`Host.memberId`). Everything that lives on a machine takes after it: its employees, their sessions and terminals, projects whose repository is there, tasks of those projects, questions of those employees.

- The office server's own machine, enrolled machines and SSH-linked servers are shared.
- A member's own computer joins while their desktop app has the office open, and only through the door. Its employees sit in the member's room.
- Work does not cross: a personal employee works only on projects on the same computer; a shared employee is never put on a project that lives on someone's computer; the scheduler and the foreman ignore personal employees.

## The rules

`need` is what an action requires: **read** (look), **work** (change, or reach into a machine), **admin** (run the office).

| | shared | a member's own computer |
| --- | --- | --- |
| read | everyone | that member, owners |
| work | colleagues, owners | that member, owners |
| admin | owners | owners |

Other members still see that a personal employee exists and its state (name, activity, in the member's room). They do not get its terminal, monitor frames, documents, diffs or history, and cannot talk to it.

### What each level covers

- **read** — the office state, people, events, performance; how much of each Claude account is used (`GET /usage`: percentages for everyone; whose account it is only for those who may *work* on the machine it lives on); documents, git view, XP of an employee; a task's diff; a project's integration status; a session's history; watching a terminal.
- **work** (own only) — `GET`/`PUT /me/room`: how one's own room looks. Nobody arranges someone else's.
- **work** — employees: hire, edit, start/stop/pause/resume, talk, request a report; sessions: attach, adopt, bind; typing into and taking control of a terminal; browsing a machine's folders and its Claude processes; projects: create, edit, pause/resume, plan, integration sync/test; tasks: create, edit, delete, release, review, unblock, retry merge; answering questions **and deciding permission requests**; notifications; meetings; lessons; planning a command; `POST /me/host`.
- **admin** — everything else, including: members and the door, settings and policies, layout, machines (enrollment tokens, revoke, rename, remove), SSH links, foreman status, audit log, improvements, promoting to the main branch, executing a command plan.

A route that is not listed in `access.ts` needs an owner.

### Terminals (WebSocket)

- `term.open`, monitor frames (`term.screen`), `screens.focus`: **read** on the session.
- `term.input`, `term.resize`, `control.acquire`: **work** on the session.
- Frames of a session a client may not read are never sent to it.

## Per-client preferences

Graphics quality, key bindings and office extras belong to each computer (`prefs.json` in the app's data folder), not to the office; every role can change their own.

## Changing this

1. Add or change the rule in `apps/server/src/access.ts` and the matching unit test (`apps/server/test/access.test.ts`).
2. If a control should disappear for someone, use `useAccess()` / `may()` from `apps/desktop/src/lib/access.ts`.
3. Update this file and `SECURITY.md`.
