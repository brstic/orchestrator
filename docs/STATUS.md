# Status

_Last updated: 2026-11-10. Update this file with every piece of work (see `CLAUDE.md`)._

## Now
**Plan:** [UPDATE — central office](plans/UPDATE-central-office.md) — **finished**: built, tested, running on the owner's server, and tried there with two members at once and real Claude Code doing a small real task on the server and on a member's computer. Handed over: a second human joining from their own computer (see the plan's "Handed over" section).

**The office on the server ("Sparkcan", Ubuntu 22.04):**
- Program: `~/orchestrator-office/app` (portable package). State: `~/.orchestrator-office/{server,agent}` — separate from `~/.orchestrator`, where the agent of the owner's Mac office (the SSH link) lives.
- Service: `systemctl --user status orchestrator-office` (linger on). Node from nvm (`~/.nvm/versions/node/v22.23.4`).
- Door: port 4610, TLS; addresses `https://<server-vpn-ip>:4610` (Tailscale) and `https://<server-lan-ip>:4610` (LAN); `ufw allow 4610/tcp` was added.
- Manage: `cd ~/orchestrator-office/app && ORCH_SERVER_HOME=~/.orchestrator-office/server node scripts/office-admin.mjs status|invite|role|revoke`.
- Update: build a package here (`node scripts/package.mjs --no-app`), copy `release/orchestrator-<version>.tar.gz`, unpack over `~/orchestrator-office/app`, `systemctl --user restart orchestrator-office`.
- Members: Branko (owner; invitation at `~/Desktop/Orchestrator-moja-pozivnica-OWNER.txt`) and Fenix (colleague; invitation, installer and instructions in `~/Desktop/Orchestrator-za-kolegu/`). Neither has been used by a person yet.

**The owner's Mac app** (`release/Orchestrator.app`) runs the latest build (replaced 2026-11-10 after the owner closed it; smoke 15/15, sessions re-adopted, SSH link connected). `release/` also holds the matching `.dmg` and portable tarball.

Next steps:
1. The owner connects with their invitation and passes `~/Desktop/Orchestrator-za-kolegu/` to the collaborator (macOS Apple Silicon installer + invitation). For another platform, build the bundle (`node scripts/package.mjs --linux --windows`; those in `release/` are stale).
3. Decide what moves from the Mac's local office to the server office (the two are separate offices; nothing was migrated).
4. From real use: fix what breaks; extend the UI suite with role-by-role clicks.

## What exists (verified by the automated suites)
- **Office on a server**: `pnpm serve` (server + shared host agent + TLS door), `pnpm office …` to invite and manage members from the server's terminal, a systemd unit generator.
- **Members and roles**: visitor (reads shared), colleague (works on shared, own computer), owner (everything). One access module (`apps/server/src/access.ts`); see `ACCESS.md`.
- **Personal hosts and member rooms**: the desktop app of a colleague/owner enrolls their computer through the door (pinned relay + host agent); their employees run there and sit in a room attached to the office while they are connected. "My room" panel to add folders and adopt local Claude sessions.
- **Per-client preferences**: graphics, keys, office extras per computer; everyone can change their own.
- Local office (one machine) as before: 3D office, real Claude Code sessions in tmux, tasks, reviews/merges, meetings, questions and approvals, self-improvement, XP.
- Other shared machines: enrolled hosts, servers linked over SSH, adoption of running Claude sessions.
- Claude usage per account (CEO desk, wall clocks); foreman role with rounds (off until hired and enabled; shared employees only).
- Extras: radio, TV, whip, seating editor, sleeping pose. Storage: SQLite (default) and PostgreSQL.

## Not verified / known problems
- On the real server both trial members were app instances on this one Mac; the real work was one trivial task per side. Not yet: a second human on another computer, sustained work (tasks, reviews, merges) through the server office, a server restart while real sessions are working.
- The server office and the owner's local Mac office are two separate offices; the Mac office still reaches the same server through its SSH link, so two agents run on Sparkcan side by side (they do not share sessions).
- Usage per account did not arrive from a real CLI session that had made no request yet (Claude Code gives the status line no limits until it knows them); it does once the session has worked.
- Role-dependent controls (People panel with the owner role, hidden/disabled buttons for visitors and for other members' employees) are covered by API tests and type checks, not by UI tests that click as each role. Hi-fi and TV panels are not role-aware (a visitor can try to add a station and is refused by the office).
- Member rooms: default layout and High quality only; more than 10 members online get no room; places are per position (when someone leaves, later members move up one).
- A personal host's default allowed root is the member's home folder.
- Two windows on the same computer do not pick up each other's preference changes until reopened.
- "Janky" movement and flicker: measured causes fixed (CHANGELOG 2026-11-10); the owner has not yet confirmed on their machine.
- Foreman, SSH links and usage reporting: scripted worker only (parts tried with the real CLI at zero tokens).
- Windows and Linux desktop bundles and the `.dmg` are stale; Windows never ran on a real machine; no notarisation. A Windows client can connect but cannot host sessions (no tmux).
- GitHub: `brstic/orchestrator` (private). The collaborator could not be added by e-mail; needs their GitHub username. This machine pushes over HTTPS through `gh` (its SSH key is a deploy key for another repository).

## How the owner runs it today
The packaged app `release/Orchestrator.app` (Desktop shortcut is a symlink to it) as a local office, state in `~/.orchestrator`, one SSH-linked server ("Sparkcan"). Shipping procedure: `DEVELOPMENT.md`.

## Suites (last full run, working tree after the UPDATE plan)
unit 62/62 · e2e 117/117 · UI 146/146 · desktop join (`tests/ui/guest-app.mjs`) 27/27 · Linux server trial (`pnpm test:central`) 23/23 · TV (`tests/ui/tv-app.mjs`) 12/12.
