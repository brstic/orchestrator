# Changelog

Newest first. One line per change that someone using or developing the office would notice.

## 2026-11-10
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
