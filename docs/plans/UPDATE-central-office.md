# UPDATE plan — the office lives on a server, people connect to it

Owner's brief (2026-11-10, translated): *Orchestrator runs on one server instance and we connect to it with the Electron client — that is the main use; local-only still works. All Claude sessions and folders on that server are shared: whoever has access to the office has access to them. People who connect get, while they are online, a room of their own attached to the office, where they can add local sessions from their own computer and work from there. Invited people are a visitor (read-only), a colleague (works on all shared projects) or an owner (works on shared and on everyone's local workers). Every client has its own graphics and other settings.*

## Terms

- **Office server** — the always-on instance: server + a host agent on the same machine. Its sessions and folders are **shared**.
- **Member** — a person invited to the office, with a role: `visitor`, `colleague`, `owner`. (Replaces "guest".) The **root owner** is whoever holds the server's own owner token on the server machine; it never travels over the network.
- **Personal host** — the host agent the desktop app runs on a member's own computer while they are in the office. Its employees are **personal**: they belong to that member.
- **Member room** — a room attached to the office for each member whose personal host is online. It disappears when they leave; their tmux sessions keep running on their computer and are picked up next time.

## Who may do what

| | visitor | colleague | owner |
| --- | --- | --- | --- |
| See the office, people, tasks, events | yes | yes | yes |
| Watch shared terminals, read shared documents and diffs | read-only | yes | yes |
| Work on shared employees, projects, tasks (talk, type, start/stop, hire, answer, approve) | no | yes | yes |
| Have a personal host and a room; work on their own personal employees | no | yes | yes |
| See / work on another member's personal employees | no | name and state only | yes |
| Members, sharing, settings and policies, machines and SSH links, office layout, deleting shared things | no | no | yes |

Details and the route-by-route table: [../ACCESS.md](../ACCESS.md).

## Phases

### 1 — Members and roles (server)
- [x] `guests` → members with roles `visitor | colleague | owner`; existing guests migrate as they are
- [x] One access module decides every request and WebSocket message from (who, action, resource scope)
- [x] Resource scope: shared, or personal to a member (through the host an employee/session/project lives on)
- [x] Owner-role members are accepted through the door; the root owner token still is not
- [x] Unit tests for the access rules; e2e for the three roles

### 2 — Central server mode
- [x] `pnpm serve` (`scripts/start-local.mjs --door [port] --address <url>`): server + shared host agent + door open on a fixed port, public address remembered
- [x] `scripts/office-admin.mjs` (`pnpm office status|open|close|invite|reinvite|role|revoke|service`): the first owner invitation is made on the server, in a terminal
- [x] Door lets through what a personal host needs: `/ws/agent` (personal hosts only) and `/mcp`
- [x] INSTALL.md: setting up a server, inviting, connecting

### 3 — Personal hosts
- [x] `POST /api/me/host`: a colleague or owner gets a one-time enrollment for a host that is theirs
- [x] `Host.memberId` / `memberName`; personal employees are never given shared work by the scheduler or the foreman
- [x] Desktop app: on joining, a local relay (pinned certificate) and a host agent for that office start; both stop when the office window closes
- [x] A personal host with no session running costs nothing and asks for nothing

### 4 — Member rooms (3D)
- [x] A room per online personal host, attached along the office's outer wall, with the member's name on it
- [x] Their personal employees sit there; the room grows with the number of employees
- [x] Rooms appear and disappear without the rest of the office moving

*Verified in Electron against a dev office with scripted personal hosts (`dev-office.ts --member-room`), not yet against hosts enrolled through the door by a real member's desktop app (phases 3 and 6). Details: ARCHITECTURE.md, "Member rooms".*

### 5 — Per-client settings
- [x] Graphics quality, key bindings, office extras, camera options are stored per client (per person, per computer), not in the office — `apps/desktop/src/lib/prefs.ts`; `prefs.json` in the app's data folder, `localStorage` in a browser tab. The four fields remain in `OwnerSettings` only as where a new computer starts from.
- [x] Everyone, including a visitor, can open Settings and change their own — tried with a visitor in the real desktop app (`tests/ui/guest-app.mjs`): no refused request.
- [x] Office-wide settings (company name, policies, foreman, self-improvement, radio stations) stay with owners — shown read-only in Settings to everyone else, with one line saying why; the audit log is not offered to them. (The Hi-fi and TV panels themselves are not yet role-aware: phase 6.)

### 6 — Client experience
- [x] Start screen: "Connect to an office" first; saved offices; "My own office on this computer" second
- [x] People panel: invite with the three roles, change role, revoke
- [x] "My room" panel: add local folders as employees on my computer, adopt local Claude sessions
- [x] Controls a role may not use are hidden or explained, not left to fail

### 7 — Verification and shipping
- [x] Unit 62/62, e2e 117/117 (`12-members` replaces `12-guests`), UI 146/146, desktop join test 27/27 (a colleague's own computer through the real relay and agent)
- [x] Docs: STATUS, CHANGELOG, ACCESS, ARCHITECTURE, SECURITY, INSTALL, DECISIONS
- [x] Tried on a real Linux server: `pnpm test:central` (23/23) installs the portable package in a Debian container as INSTALL.md says, starts `--door`, invites an owner and a colleague from the server's terminal, and connects two real desktop apps from this Mac across the VM's network. The colleague's own session is the **real Claude Code CLI** (started, nothing sent: hooks and the worker endpoint reach the server through the relay); the server's worker is the scripted one (a container has no Claude account). Includes a restart of the office on the server.
- [x] On the owner's own server (2026-11-10): installed on "Sparkcan" (Ubuntu 22.04) from the portable package as a systemd user service with its own state folders, door on 4610 (firewall opened with the owner's approval), reachable on the LAN and over Tailscale. Joined from this Mac with the real desktop app as a temporary colleague: the Mac came in as a personal host over the network, real Claude Code started on the server (shared) and on the Mac (personal) with nothing sent, the server's terminal was watched from the Mac, the room appeared; then everything the trial made was removed and the member revoked.
- [x] Two members at once and real work, on the owner's server (2026-11-10): an owner and a colleague, each in their own desktop app, in the office on Sparkcan at the same time — they saw and heard each other; the owner gave a shared employee on the server one small real task and the colleague gave their own employee on the Mac one; **real Claude Code did both** (a file written on the server, a file written on the Mac), and both accounts' usage arrived at the office. Trial members and employees were removed afterwards.

## Handed over to the owner (not development)
- Both people in that trial were this one Mac (two app instances, two invitations). A second **human** on their own computer has not come in yet: invite them (Menu → People, or `office-admin.mjs invite <name> --role colleague` on the server). On another operating system they need a desktop build for it (the bundles in `release/` are stale) or the repository.

## What "done" does not cover
- The trials used one client computer (this Mac) for both people; the server was a separate machine. Real work was one trivial task per side.
- The People panel's owner role and the role-dependent controls were checked by type and by the API tests, not by a UI test that clicks them as each role.
- Member rooms were verified on the default layout at High quality.

## Not in this plan
- Accounts with passwords / SSO: an invitation is the credential, as before.
- A public certificate for the door (it stays self-signed and pinned by the invitation; a reverse proxy with a real certificate in front of the main port works as before).
- Windows as a personal host (no tmux); a Windows client can connect and has no room.
