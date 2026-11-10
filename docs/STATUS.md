# Status

_Last updated: 2026-11-10. Update this file with every piece of work (see `CLAUDE.md`)._

## Now
**Plan:** [UPDATE — central office](plans/UPDATE-central-office.md) — all phases built, passing the automated suites, and tried against a real Linux server in a container (`pnpm test:central`, 23/23, with the real Claude Code CLI started on the member's side). **One item is open and needs the owner:** the same on their own server with a second person on another computer.

Next steps, in order:
1. Install on the owner's Linux server following `INSTALL.md` section 0; invite the owner as `owner` and the collaborator as `colleague`; note what breaks.
2. Rebuild the desktop bundles for the collaborator's platform (`.dmg`, Linux/Windows bundles are stale).
3. From that trial: fix, then extend the UI suite with role-by-role clicks (see "Not verified").

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
- The UPDATE plan has run against a Linux server only as a container on this Mac, with both people's desktop apps on this Mac. Real Claude Code was started on the member's computer (hooks and MCP reached the server) but did no work; on the server the worker was the scripted one. Not yet: the owner's server, a physically separate second computer, real work.
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
