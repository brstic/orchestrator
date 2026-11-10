# Changelog

Newest first. One line per change that someone using or developing the office would notice.

## 2026-11-10
- Hiring is three steps: **where** (the shared office on the server, or my own room on my computer — asked, not assumed), **the folder** on that machine (the system folder dialog only when the machine is the one the window is on; otherwise the machine's own folder list), **the desk** (any free desk in the office, or a seat in my room; "Automatic" stays). Fixes hiring from a client into the server office, which offered the client's folder dialog for the server's disk.
- Seats in a member's room can be chosen and are kept (`deskId` `m:<host>:<n>`); the room grows to the furthest chosen seat.
- A refused change to an employee no longer leaves them half-changed in memory until the next restart.
- Usage clocks: the CEO room shows the Claude accounts of the office's own (shared) machines; each member's own account hangs as a clock on a wall of their room. Everyone may read the percentages (`GET /api/usage` is now a *read*); the account's e-mail and organisation are sent only to those who may work on that machine.
- `office.sparkcan.com` is live (Let's Encrypt certificate on the server's nginx). The office window's WebSocket now presents its token as a subprotocol instead of in the address; the proxy does not log office requests.
- `office.sparkcan.com`: CloudPanel reverse-proxy site in front of the office's door; the desktop app now also accepts an office whose certificate is publicly trusted for its name (pinning stays for addresses with the office's own certificate).
- `pnpm deploy:server` (`scripts/deploy-server.sh`: build, copy, swap, restart, `--status`, `--rollback`) and `docs/OPERATIONS.md` (where everything runs, how to update server and clients, backup, troubleshooting).
- Members arrange their own room (Menu → My room → *Arrange my room*): name on the door, colour, number of desks (up to 20), open floor behind the desks, furniture. Kept by the office (`PUT /api/me/room`), drawn for everyone.
- A member's room now stays in the office when they leave: grey, dark and locked, their employees asleep at their desks; it opens again when their computer reconnects. Rooms no longer change places when someone leaves.
- A saved office can be marked "open at start": the app walks into it without the start screen. The owner's local office was shut down and set aside (see STATUS); they now work in the server office.
- Trial on the owner's server with two members at once and real Claude Code doing one small task on the server and one on a member's computer; usage of both accounts reported. UPDATE plan closed.
- The office is installed and running on the owner's server (see STATUS). Invitations no longer list container bridge addresses or duplicates; in server mode the start script no longer prints the owner token to the log; the generated systemd unit carries the office's state folders.
- `pnpm test:central`: the office installed from the portable package on a Linux container, two desktop apps connecting from this computer, the real Claude Code CLI on the member's side (zero tokens).
- **UPDATE plan (office on a server):** members with three roles and one access module (`access.ts`, `ACCESS.md`); owner-role members through the door; `pnpm serve`, `pnpm office` (invite/role/revoke/service); personal hosts (`POST /api/me/host`, relay + agent started by the desktop app, `Host.memberId`); "My room" panel; start screen leads with "Connect to an office"; role-aware employee card, context menu and workstation.
- Behaviour changes to note: visitors can now watch shared terminals and read shared documents; colleagues can type into shared terminals, hire, start/stop sessions and decide permission requests of shared employees; the API path for members is still `/guests`; audit actors are `member:<name>`.
- Member rooms (3D): while a member's own computer is connected, a room with their name is attached outside the office's outer wall, with a door into the office, and their personal employees sit there at desks with live monitors; it grows away from the building with the number of employees (2 to 12 desks) and is gone when they disconnect. Derived on each client (`member-rooms.ts`), nothing stored; the existing office, spawn, cameras and navigation do not move. `dev-office.ts --member-room "Name:N"` for trying it. Going to an employee (`focus`) no longer puts the owner inside a wall when the desk stands close to one.
- Per-client preferences: graphics quality, key bindings and the office extras (project areas, closer camera at a desk) are kept on each person's computer (`prefs.json` in the desktop app, `localStorage` in a browser), no longer in the office's settings; a computer's first run starts from the office's values. Settings has two groups, "This computer" and "The office" (read-only unless you are an owner).
- Docs restructured: `CLAUDE.md`, `docs/README.md` (map), `STATUS.md`, `DECISIONS.md`, `DEVELOPMENT.md`, `plans/`.
- Foreman role: supervising employee with its own MCP tools and engine-driven rounds (`3c71e9e`).
- Host agent re-sends a blocking hook that was in flight when the server connection dropped.
- PostgreSQL store waits for writes made during shutdown (`96bf372`).
- Movement: even render rhythm (`pace.ts`), material twins for skinned limbs, no echo of own presence, memoised scene, distance detail for people, no HUD backdrop blur (`6b0786a`).
- Claude usage per account: status line reporting, CEO desk panel, wall clocks in the CEO room; `claudeConfigDir` per employee.
- Rendering stability: depth offset for pictures on surfaces, ceiling/glass/slab no longer millimetres apart.
- Sleeping-at-desk pose; eased walking with planted feet (walk 2.5 u/s, run 6.4 u/s).
- Earlier the same day: SSH links, bulk hire, seating editor, TV, multiplayer (guest door), radio, whip, audit-gap batch.
- First commit of the repository (`64381a5`).
