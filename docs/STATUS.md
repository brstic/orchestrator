# Status

_Last updated: 2026-11-10. Update this file with every piece of work (see `CLAUDE.md`)._

## Now
**Plan:** [UPDATE — central office](plans/UPDATE-central-office.md) — **finished**: built, tested, running on the owner's server, and tried there with two members at once and real Claude Code doing a small real task on the server and on a member's computer. The plan is closed. Follow-up, outside the plan: the collaborator builds the client from the repository and joins with their invitation.

**The office on the server ("Sparkcan", Ubuntu 22.04):**
- Program: `~/orchestrator-office/app` (portable package). State: `~/.orchestrator-office/{server,agent}` — separate from `~/.orchestrator`, where the agent of the owner's Mac office (the SSH link) lives.
- Service: `systemctl --user status orchestrator-office` (linger on). Node from nvm (`~/.nvm/versions/node/v22.23.4`).
- Door: port 4610, TLS; addresses `https://<server-vpn-ip>:4610` (Tailscale) and `https://<server-lan-ip>:4610` (LAN); `ufw allow 4610/tcp` was added.
- Manage: `cd ~/orchestrator-office/app && ORCH_SERVER_HOME=~/.orchestrator-office/server node scripts/office-admin.mjs status|invite|role|revoke`.
- Update: `pnpm deploy:server` (details, rollback, backup and everyday commands: `OPERATIONS.md`).
- Members: Branko (owner; invitation at `~/Desktop/Orchestrator-moja-pozivnica-OWNER.txt`) and Fenix (colleague; invitation, installer and instructions in `~/Desktop/Orchestrator-za-kolegu/`). Neither has been used by a person yet.

**The owner works in the server office only (since 2026-11-10).** At their request the local office on the Mac was shut down and cleared:
- Its five running Claude sessions were asked to exit (`/exit`; the conversations remain resumable with `claude --continue` in their folders) and its tmux sessions removed.
- Its state was moved, not deleted: `~/.orchestrator-local-office-backup-2026-11-10/` on the Mac (server database + agent), and `~/.orchestrator-mac-link-backup-2026-11-10/` on Sparkcan (the SSH-link agent of that office, stopped). Nothing was migrated to the server office — the owner chose to start from zero. Delete the backups when they are no longer wanted.
- The desktop app (`release/Orchestrator.app`, latest build) now opens the server office by itself at start ("open at start" on the saved office; Office → Switch office… shows the start screen). The owner comes in as *Branko · owner*, and the Mac joins as "Branko's computer" with its room; local Claude sessions are added from Menu → My room.

Next steps:
1. The collaborator (GitHub `fenixf4`, already has access to the repository) builds the client from it (INSTALL.md, "Without an installer") and joins with the invitation in `~/Desktop/Orchestrator-za-kolegu/PROCITAJ.txt`. The owner connects with their own invitation.
4. From real use: fix what breaks; extend the UI suite with role-by-role clicks.

## What exists (verified by the automated suites)
- **Office on a server**: `pnpm serve` (server + shared host agent + TLS door), `pnpm office …` to invite and manage members from the server's terminal, a systemd unit generator.
- **Members and roles**: visitor (reads shared), colleague (works on shared, own computer), owner (everything). One access module (`apps/server/src/access.ts`); see `ACCESS.md`.
- **Rooms are permanent and arrangeable**: each member's room stays in the office when they are away (grey, locked, employees asleep) and the member sets its name, colour, desks, open floor and furniture from Menu → My room.
- **Personal hosts and member rooms**: the desktop app of a colleague/owner enrolls their computer through the door (pinned relay + host agent); their employees run there and sit in a room attached to the office while they are connected. "My room" panel to add folders and adopt local Claude sessions.
- **Per-client preferences**: graphics, keys, office extras per computer; everyone can change their own.
- Local office (one machine) as before: 3D office, real Claude Code sessions in tmux, tasks, reviews/merges, meetings, questions and approvals, self-improvement, XP.
- Other shared machines: enrolled hosts, servers linked over SSH, adoption of running Claude sessions.
- Claude usage per account (CEO desk, wall clocks); foreman role with rounds (off until hired and enabled; shared employees only).
- Extras: radio, TV, whip, seating editor, sleeping pose. Storage: SQLite (default) and PostgreSQL.

## Not verified / known problems
- On the real server both trial members were app instances on this one Mac; the real work was one trivial task per side. Not yet: a second human on another computer, sustained work (tasks, reviews, merges) through the server office, a server restart while real sessions are working.
- Usage per account did not arrive from a real CLI session that had made no request yet (Claude Code gives the status line no limits until it knows them); it does once the session has worked.
- Role-dependent controls (People panel with the owner role, hidden/disabled buttons for visitors and for other members' employees) are covered by API tests and type checks, not by UI tests that click as each role. Hi-fi and TV panels are not role-aware (a visitor can try to add a station and is refused by the office).
- Member rooms: default layout and High quality only; more than 10 member computers get no room. A room can only grow away from the building, not sideways; a very deep one runs off the edge of the Command center picture. A locked room cannot be entered by anyone, owners included.
- A personal host's default allowed root is the member's home folder.
- Two windows on the same computer do not pick up each other's preference changes until reopened.
- "Janky" movement and flicker: measured causes fixed (CHANGELOG 2026-11-10); the owner has not yet confirmed on their machine.
- Foreman, SSH links and usage reporting: scripted worker only (parts tried with the real CLI at zero tokens).
- Windows and Linux desktop bundles and the `.dmg` are stale; Windows never ran on a real machine; no notarisation. A Windows client can connect but cannot host sessions (no tmux).
- GitHub: `brstic/orchestrator` (private); collaborators: `fenixf4`, `nikolajanko`. This machine pushes over HTTPS through `gh` (its SSH key is a deploy key for another repository).

## How the owner runs it today
The packaged app `release/Orchestrator.app` (Desktop shortcut is a symlink to it) as a **client of the office on Sparkcan**; the Mac's own state is only `~/.orchestrator/offices/<id>/agent` (its personal host) and the app's data folder. Shipping procedure: `DEVELOPMENT.md`.

## Suites (last full run, working tree after the UPDATE plan)
unit 62/62 · e2e 117/117 · UI 146/146 · desktop join (`tests/ui/guest-app.mjs`) 30/30 · Linux server trial (`pnpm test:central`) 23/23 · TV (`tests/ui/tv-app.mjs`) 12/12.
