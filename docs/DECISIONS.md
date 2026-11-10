# Decisions

Newest first. Each entry: what was decided, why, and what was rejected. Add one whenever a later reader would otherwise have to guess.

## 2026-11-10 — Member rooms (UPDATE plan, phase 4)
- **Derived on each client, never stored.** The rooms follow from the stored layout and from which personal hosts are online; a pure function gives every client the same answer. Rejected: writing rooms into the layout when someone connects — the layout is the owner's, and a crash would leave rooms behind.
- **Outside the outer wall, growing away from the building.** A room has a fixed width along the wall and gets deeper with more desks, so neither the office nor the neighbouring rooms move when a member hires. Rejected: growing along the wall (every later room would shift).
- **West wall first, then north, then east; never the entrance wall.** The brief said "the wall with the fewest things on it"; by that count the east wall wins in the default office, but the command centre's panel covers the east side of the picture, and the rooms must be seen from the overhead cameras. Doors are cut only where nothing hangs or stands, and a door that opens into a hall or the open floor is preferred to one into a room; the CEO's office is the last resort.
- **A place belongs to the n-th connected member**, not to a person: when someone leaves, those who enrolled after them move up one place. Rejected: remembering places per member on the client (clients would disagree about where a room is, and other people's characters are shown at shared coordinates).
- **At most 12 desks in a room.** A member with more personal employees sees the first twelve in the room and the number on the plaque; the rest are listed in the Team panel only.
- **Cameras are not changed for the rooms.** A room three pods deep on the west side reaches beyond the command centre's picture; the camera staying put mattered more (the owner's standing preference for a calm camera).

## 2026-11-10 — Members, roles and personal hosts (UPDATE plan)
- **An invitation stays the credential.** No passwords or SSO. An invitation carries the office's addresses, the certificate fingerprint and a token; only the token's hash is stored. Rejected: accounts — more surface, nothing the owner asked for.
- **Three roles, one access module.** `visitor` reads, `colleague` works on everything shared and on their own personal employees, `owner` does everything. Every HTTP route and WebSocket message is classified once in `access.ts`. Rejected: per-route checks scattered through `server.ts` (how the old guest rules began to grow).
- **Visitors may watch shared terminals.** The owner's brief says a visitor has read-only access; earlier, visitors saw no terminals at all. Terminal output can contain secrets, so invite visitors accordingly (noted in SECURITY.md).
- **Colleagues may approve permission requests of shared employees.** "Works on all shared projects" includes the terminal, where an approval can be typed anyway. Approvals for someone else's personal employee stay with that person and with owners.
- **The root owner token never crosses the network.** Remote owners are members with the role `owner`. The first one is invited from a terminal on the server (`pnpm office invite`).
- **"Shared" and "personal" are a property of the host.** An employee, session or project is personal exactly when its host belongs to a member. No per-object ownership field to keep in sync.
- **A personal host is a normal host agent** started by the desktop app, enrolled through an endpoint only its member can call, and reached through a relay on the member's own loopback that pins the office's certificate. Rejected: teaching the agent and Claude Code's MCP client to trust a self-signed certificate.
- **A member's room exists while their host is online.** Closing the app stops the agent; the tmux sessions stay and are adopted again next time.
- **Graphics, keys and office extras are per client,** stored by the desktop app (per computer). Office-wide settings stay with owners.

## 2026-11-10 — Member rooms are permanent and the member's to arrange
- Owner's words: "let me make my room the way I want, make it bigger etc." and "all of it must stay on the server; when I am not there my office should be visible but grey and locked". So a room stands for every member computer the office knows, whether connected or not; away means no door opening, no lights, grey carpet and signs, employees shown asleep. This replaces "a member's room exists while their host is online".
- Choices are stored per member on the server (`memberRooms` in the key-value store) and copied onto each of their hosts (`Host.room`), so the client needs nothing extra to draw them. They are validated on the way in (`sanitizeMemberRoom`): what a member sends is drawn in everyone's office.
- A room grows only away from the building (more desks, open floor), never along the wall: neighbours never move. Width along the wall stays fixed at 6.8 m.
- An away computer with nobody on it gets no room when its member has another computer: a re-enrollment would otherwise leave an empty room behind.

## 2026-11-10 — Rendering and movement
- Even rhythm over raw frame rate: draw on every refresh or on every second one (`pace.ts`). A steady 60 looks smoother than an unsteady 90.
- Things that lie on a surface get a polygon offset (`surface.ts`); surfaces are kept centimetres apart, not millimetres.
- Walk speed 2.5 u/s (was 3.4): above ~3 the legs slide. Constants `WALK` / `RUN` in `Rig.tsx`.

## 2026-11-10 — Foreman
- Rounds are started by the engine from a zero-token digest; a quiet office costs nothing. Off by default.
- The foreman answers questions, never permission requests; cannot edit files; is never given tasks.

## 2026-11-10 — Per-client preferences
- Graphics, keys and extras belong to the computer, not the office: one `prefs.json` in the app's data folder, shared by every office that computer opens (a preference about your GPU and your keyboard does not depend on whose office you are in).
- First run copies the office's values, so the owner's existing choices carry over; afterwards the office's values for those four fields are ignored. The fields stay in `OwnerSettings` for that reason only.
- The Electron handler that writes the file keeps only the four known fields in their expected shapes: the page asking may have been served by someone else's office.

## Earlier (see `plans/2026-original-brief.md`)
- Workers are interactive Claude Code sessions in tmux, launched with per-session `--settings`; the project's own `.claude` is never modified.
- "Done" means verification ran and passed; XP counts only verified work.
- No ORM: a small document store with SQLite and PostgreSQL back ends.
- Visual extras and camera behaviour are opt-in (owner preference).
