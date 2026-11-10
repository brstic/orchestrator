# Decisions

Newest first. Each entry: what was decided, why, and what was rejected. Add one whenever a later reader would otherwise have to guess.

## 2026-11-10 — The hi-fi plays for the whole office
- **What is playing is the office's state; the sound is not.** The server keeps which station is on, since when and who switched it, tells every window (`{ t: 'radio' }`, also when one walks in), and each window plays the stream itself with its own audio element. Rejected: the server relaying audio — it would carry every listener's stream through the office's connection, need transcoding or buffering to keep people together, and add nothing a radio does not already do. The price: two people are not in sync to the second (each tuned in at its own moment), which for background radio nobody can hear unless they sit in the same real room.
- **In memory only.** After a restart of the office the hi-fi is off; nothing starts playing in people's windows because a server came back. The office does note which station was last played (`lastStationId`, as before).
- **Owners and colleagues switch it; visitors listen.** Switching is `work` on the shared office (the same line as the door bell and everything else colleagues do). The list of stations stays in the settings, so adding or removing one stays an owner's act: a station's address is loaded by every window in the office, so a play request names a saved station by id and can never carry an address of its own. Rejected: letting visitors switch (a 12-hour browser visit should not be able to change what everyone hears), and owners-only switching (the hi-fi is the office's, like the break room).
- **Loudness = my volume × distance.** Full within 3 m of the hi-fi, then a smooth fall (a smoothstep over a bent distance: no step, no kink, most of the fall in the first third) to a floor of 14% from 36 m on — the far corners of the standard office. A floor rather than silence because music for the whole office was asked for; a fixed reach rather than one scaled to the building, so adding member rooms does not make the hi-fi louder everywhere. Walls do not count in this version. The three numbers are constants in `packages/office-3d/src/hifi-sound.ts`.
- **The listener is the character, in every camera mode.** In the overview, free camera, command center and at someone's terminal the character stays where it was left, and that is where the music is heard from. Rejected: the camera's point of interest — flying the camera over the office would make the volume swing while the person, as everyone else sees them, has not moved.
- **Volume and mute are each computer's** (`prefs.json` / the page's storage), never the office's. Mute stops this window's download of the stream altogether instead of playing it at zero. The 3D hi-fi keeps moving in a muted window: it shows what the office is doing.
- **The element's own volume, eased twenty times a second** (a fifth of the way each step). Rejected: Web Audio gain nodes — routing a cross-origin stream through Web Audio needs the station to send CORS headers, and most do not (the output would be silence).
- **A refused autoplay is a notice, not an error.** In a browser that wants a click first, one calm line offers "click to listen"; the click is the gesture the browser wants.

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

## 2026-11-10 — Furniture is sculpted in code
- No model files. Everything in the office is built at start from a small kit of shapes (`packages/office-3d/src/models/kit.ts`). Why: nothing to fetch or package, one style throughout (the characters are made the same way), and sizes are numbers — a test can say that a sofa fits the floor kept free for it and that a chair's seat is where people are posed to sit.
- One material per look for the whole office, and each model fused into one geometry per material: detail costs triangles, not draw calls. Budgets are in `test/models.test.ts`; what is drawn many times (chair, desk, cup) has the tightest.
- Fine repeated detail is kept low in contrast (the reception counter's battens stand on wood of nearly their own tone, keys are light on light). Bright thin stripes crawl while one walks past them, and that reads as the flicker the owner has complained of. Measured, not guessed: see DEVELOPMENT.md.
- Small things on desks appear with the person who sits there and are chosen from the desk's id: lively, but never changing while one looks.
- A room that lies inside another room has its floor drawn as a picture on a surface (`ON_SURFACE`), not as a second floor at the same height.
- What a milestone grants and the milestone's key are both accepted as "unlocked" (`unlockedUpgrades`). The mismatch had hidden three decorations since they were added; accepting both names needs no migration of stored layouts.
- The team room's furniture is placed only when the room's floor is free: an owner's own arrangement of that room is never overridden.

## 2026-11-10 — Rendering and movement
- Even rhythm over raw frame rate: draw on every refresh or on every second one (`pace.ts`). A steady 60 looks smoother than an unsteady 90.
- Things that lie on a surface get a polygon offset (`surface.ts`); surfaces are kept centimetres apart, not millimetres.
- Walk speed 2.5 u/s (was 3.4): above ~3 the legs slide. Constants `WALK` / `RUN` in `Rig.tsx`.

## 2026-11-10 — Foreman
- Rounds are started by the engine from a zero-token digest; a quiet office costs nothing. Off by default.
- The foreman answers questions, never permission requests; cannot edit files; is never given tasks.

## 2026-11-10 — Foreman, reworked at the owner's request
- **One foreman, server-based, for everything** (the owner: "only one should exist, server based, but it works on the shared space and on the local space — it can manage everything"). A first design had one per space; it was dropped the same day. The registry refuses a second foreman and one on a member's computer.
- **No desk.** It is not one of the seated employees: the registry clears and refuses a desk, the hire form has no desk step for it, seating lists and the map leave it out, Team shows it on a line of its own. In 3D it walks (`Foreman.tsx`): to whoever it is dealing with during a round (`foreman.visit` events), otherwise from desk to desk on a route that depends only on the clock and the seating — so every client shows it in the same place and nothing has to be sent.
- **It sees members' own employees** (terminals included) while their computer is connected. That widens who can look into a personal employee, which until now was the member and the owners. Accepted because the owner asked for one foreman that manages everything; contained by making the foreman itself owners-only (terminal, documents, history, talking to it, profile, hiring). Not contained: message records and event summaries go to every member's window, as they already did for personal employees. Written down in ACCESS.md and SECURITY.md so a member knows before bringing a computer in.
- **Work still does not cross computers.** The foreman's `assign_task` / `create_task` hold the same line as the scheduler: shared tasks never go to a member's computer and the other way round. `updateTask` itself does not check this; the two foreman tools and the HTTP rules do.
- **"Idle" is an attention kind of its own**, apart from "stalled" (idle *with* a task in progress): a running session doing nothing with no task. The owner's goal is continuous work, including sessions that were never given a task from the board. To keep a foreman and an employee with nothing to do from talking in circles, each time only the foreman's own words reached the employee since they were last shown as idle, the wait doubles (up to 32×); anything from anyone else resets it.
- **Hiring a foreman switches rounds on.** Hiring it is the explicit request; a separate switch that stays off was one step too many. The switch remains, as a pause.
- **`tell_employee` instead of `send_message` for the foreman's instructions**: same queue, but it reaches anyone in the office, is counted on the round, refuses an employee whose computer is away, and makes the visit visible.
- **A foreman's folder is never made a project**, unlike other hires: it is only where the session runs.

## 2026-11-10 — Knocking, the answer cue, private feed
- **A browser is a window to look through, never a seat.** The owner asked for a page where visitors ask to come in and can only watch; so a knock from a browser becomes a visitor whoever answers, and expires (12 h) so the member list does not fill with one-off visits. Working in the office is done with the desktop app.
- **Everyone inside who could work is asked; only owners hand out work.** The owner's words were "everyone who has access gets the notification and can let the person in" (read-only) and, for the app, "whoever is inside chooses: read-only, owner or colleague". Letting a colleague grant colleague or owner would let them raise someone above themselves, so a colleague's answer is limited to a visit; visitors are not asked.
- **A code instead of trust in a name.** There are no accounts; a knock is a typed name. The same four digits on both screens let two people who are talking confirm it is the same knock.
- **The app keeps the result as an invitation.** After being let in once, the app has an ordinary saved office; no second mechanism.
- **By address only where the certificate proves the address.** Typing an IP address of an office with its own certificate cannot be verified without the fingerprint an invitation carries, so the app refuses rather than trust on first use.
- **The answer cue is the asker's own, kept on their computer.** "I asked, they answered" is about one person's attention; the office does not need to know who is waiting for whom. A turn that ends while the message is still queued does not count as the answer.
- **Feed lines about a member's employee are that member's.** They carry the employee's replies; sending them to everyone contradicted "others see that it exists and its state". Dropped per connection rather than redacted: a line with its content removed says nothing useful.

## 2026-11-10 — Per-client preferences
- Graphics, keys and extras belong to the computer, not the office: one `prefs.json` in the app's data folder, shared by every office that computer opens (a preference about your GPU and your keyboard does not depend on whose office you are in).
- First run copies the office's values, so the owner's existing choices carry over; afterwards the office's values for those four fields are ignored. The fields stay in `OwnerSettings` for that reason only.
- The Electron handler that writes the file keeps only the four known fields in their expected shapes: the page asking may have been served by someone else's office.

## Earlier (see `plans/2026-original-brief.md`)
- Workers are interactive Claude Code sessions in tmux, launched with per-session `--settings`; the project's own `.claude` is never modified.
- "Done" means verification ran and passed; XP counts only verified work.
- No ORM: a small document store with SQLite and PostgreSQL back ends.
- Visual extras and camera behaviour are opt-in (owner preference).
