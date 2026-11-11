# The entrance page

What a browser gets at an office's own address before anybody is signed in: one long page that shows what this place is, with the door — sign in, or knock — hanging beside it all the way down. Read this before touching `apps/desktop/src/entrance/`, the hooks in `apps/desktop/src/Knock.tsx`, or the pictures the page shows.

_Built on 2026-11-11 on the owner's word: a playful page for the office's own address, made from the project and its README, with real screenshots, the office's own figure running along with the scroll, and a sign-in that comes along. It is not the marketing site; that is to be a separate thing._

## The idea in one paragraph

The page **is the floor of a little office at night**. The text and the pictures lie on it, and on its right-hand side stand a few pieces of the real office — its own desks, chairs, plants, its own people — each in a pool of light. One of them, **the intern**, keeps up with whoever scrolls: walks when the page moves slowly, runs when it moves fast, sits down at a desk when the page stops there, looks over a shoulder where a hand is up, dances in the break room, and waves at the door at the end. **The door** is a card hanging from the top of the window: open at the top and at the bottom of the page, folded to its name in between, swinging a little against the scroll and leaning toward the pointer. Everything that moves reads the scroll position; the page itself scrolls natively.

## Who sees it

`Entrance` in `apps/desktop/src/App.tsx`: the connection is `unauthorized`, this is not the desktop app, and `GET /knock` answered — which it does only through the office's door (`apps/server/src/door.ts`). On the office's own computer, and in the desktop app, the owner-token form is shown as before. A phone is still turned away before any of this (server and `main.tsx`); nothing about that rule changed.

## What is on it

| Part of the page | What it says (all of it from `README.md`) | What stands beside it |
| --- | --- | --- |
| Top | "You hire. They code. You walk around and look important." — and whose door this is | four desks with three people at work; a shut door with a neon "knock, knock."; the intern, waving |
| 01 Zero NPCs | everyone is a real session; UNKNOWN is shown as unknown | the intern's own desk — it sits down and types |
| 02 Walk the floor | `W A S D`, `F`, `Space`, take control | — |
| 03 A hand goes up | a raised hand is a held request; queued → sent → confirmed | somebody with a hand up, the lamp on their desk pulsing |
| 04 Quests | done means clean tree, commits, verification, review, merge | the trophy case |
| 05 The foreman | walks, answers the operational questions, never approves | the foreman pointing at somebody asleep at a desk |
| 06 Command center | the office from above | — |
| 07 Multiplayer | invitations, roles, a colleague's computer becomes a room | two people on a rug |
| 08 The break room | hi-fi, television, the whip | the hi-fi, a sofa, the arcade; the intern dances |
| The house rules | five of the README's honesty rules | — |
| Bottom | the three ways in | the door again, ajar, with the light on |

**Text.** English, taken from `README.md` and said shorter. Only what the README and the code say the product does: when the README changes, read this page against it. It names no person, no server and no project; the office's own name comes from `GET /knock` at run time. One sentence of the README is deliberately *not* repeated — that `--dangerously-skip-permissions` is never used — because the Unrestricted level now exists (`DECISIONS.md`); the page says only that high-risk commands stop at every level, which both say.

**The figures are an illustration, and say so.** Nobody standing on the page is a session, the screens show coloured bars (as the office draws a screen from across the floor) and not terminal text, and the footer says it in words. What proves the product is the pictures.

## The pictures

Eight real captures of the real app, `apps/desktop/src/entrance/shots/*.webp` (1800 × 1125, about 1 MB together, loaded as they are reached). They are from a **made-up office** — *Paper Lantern Works*; people called Alex, Sarah, Mike, David, Emma, Ava, Rev, Noor, Zed, Juno, Pip, Odo; members Bea, Dan, Vik; a foreman called Mira; projects *Customer Platform* and *Field notes* — whose employees are the scripted stand-in (`tests/fixtures/fake-claude.mjs`). The terminal picture therefore begins `FAKE CLAUDE — test fixture, not Claude Code`; its caption says so too. Nothing is drawn over them; the page adds a frame and a caption.

**Never take them from a real office.** No real person, company, project, machine or address may appear on this page.

To take them again (about three minutes; no Claude usage):

```sh
pnpm build:ui
node scripts/entrance-office.ts --room        # prints one line of JSON; take "owner" from it. Start it fresh: its people are busiest in their first minutes.
apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/entrance-shots.cjs "<owner>" apps/desktop/src/entrance/shots
# Ctrl-C (or SIGTERM) on the office when done.
```

`scripts/entrance-shots.cjs` holds the camera at fixed places (`window.__orchScene.cam`), opens panels the way the page's own buttons do, and — last, because it is the one thing it changes in the office — hires a foreman and photographs it on its first round. So it is run once per office; `--foreman-only` takes only that picture, `--png` also keeps the full-size originals. The window is drawn at two device pixels to one through the DevTools protocol, whatever screen the computer has (Electron's own `force-device-scale-factor` is ignored on a Mac whose main screen is an ordinary one; the first set taken that way was 1600 pixels wide blown up to 1800, and was thrown away). Look at every picture before committing it: which desk the foreman happens to be at, and what stands in front of it, differs from run to run.

`scripts/entrance-office.ts` is also the office to look at the page in, and to try the door by hand: it prints the door's address (`https://127.0.0.1:<port>/`, a self-signed certificate) and the passwords of its two members. It starts `scripts/dev-office.ts` and adds the open door, the members and — with `--room` — the colleague's "own computer" with three employees.

## How it is built

| | |
| --- | --- |
| `apps/desktop/src/entrance/EntrancePage.tsx` | the page: its text, where it leaves room for the scene (`Place`), measuring those places, the door's opening and folding and its swing, calm mode. Default export, loaded by `App.tsx` with `lazy()` |
| `apps/desktop/src/entrance/Door.tsx` | the card: the two forms (member / visitor) and the waiting state. Real `<form>`s, labelled inputs, `autocomplete="username"` / `"current-password"` |
| `apps/desktop/src/Knock.tsx` | `useSignIn`, `useKnock`, `signedInBefore`: the requests (`POST /login`, `POST /knock`, the poll, `DELETE`), what is kept in the browser (`orch.token`, `orch.login-name`, `orch.knock-name`), what counts as an answer. Moved here unchanged from the components that used to draw the old page |
| `apps/desktop/src/entrance/Stage.tsx` | the scene: places, people, the intern, the light. Loaded with `lazy()` from the page, after the page is readable and only where WebGL exists and the window is at least 860 px wide |
| `apps/desktop/src/entrance/geometry.ts` | how a point of the page is a point of the floor (no three.js: the page needs it first) |
| `apps/desktop/src/entrance/entrance.css` | every style of the page, under `.ent`; leans on nothing in `styles.css` |
| `packages/office-3d/src/parts.ts` (`@orchestrator/office-3d/parts`) | the office's `Character`, `Model` and furniture, exported without the office |

### The page is the floor

`geometry.ts`: the floor is looked at from above and in front at 40° with **no perspective**, so a point `(x, y)` pixels from the page's top-left corner is the floor point `(x / ppu, 0, y / (ppu · sin 40°))`, and something `h` metres tall is drawn `h · ppu · cos 40°` pixels high. `ppu` (pixels per metre) follows from the width of the right-hand lane: `laneOf(vw)`, 300 to 460 px wide, 3.9 m across. The page sets it as the CSS variable `--m`, and everything that has to line up with the scene is measured in it: the room left for each place (`.ent-slot`, sized in metres), the pool of light under it (a CSS ellipse, so it is there before the scene has loaded and scrolls with the page for free), the faint tiles of the floor (60 cm squares, flattened by `--sin`).

After each layout the page measures where its `[data-station]` elements are and hands the scene a list of `{ id, kind, x, y }` (`measure` in `EntrancePage.tsx`; again whenever the page's size changes). `Stage.tsx` turns each into a place (`PLACES[kind]`): its furniture, how far it reaches, and the spot the intern takes there.

### One canvas, lying in the page

The canvas is not fixed to the window. It lies **in the page**, a third of a window taller than the window above and below (`overscanOf`), and before every frame it draws it is moved to where the window is (`translate3d(0, scrollTop − over)`) with the camera moved to match. Between two frames the browser scrolls it together with the text on the compositor — so furniture does not swim against the page, however the frame rate goes; only what really moves (people) can be a frame behind. The camera is orthographic with `zoom = ppu`, so one metre is `ppu` pixels and a whole pixel of scroll is a whole pixel of picture.

The floor itself is not drawn: a transparent plane with a `ShadowMaterial` receives the shadows, and they darken the page's own pools of light. The one light that casts them moves with the window in whole texels of its shadow map, so shadows do not shimmer as the page scrolls. Places off the canvas are not drawn and their people are held (`Live.seen`). The pixel ratio is capped at 1.5 and at about 4.2 million pixels in all. After a minute without a scroll, a pointer move or a key the drawing stops until there is one.

### The intern

`Intern` in `Stage.tsx`, one `useFrame` before the figure animates. The window has a **focus line** 64 % of the way down. Each place with a spot has a band around it (a fifth of the window, less where places are close): while the focus line is inside, the intern goes there and does what the place asks (sit and type; or a gesture, again after a pause); outside all bands it walks down the **walkway** — the left edge of the lane — level with the focus line. Above the first place and below the last it stays at them, which is why it waits at the door at both ends.

Into a place it goes walkway → level with the place → round the furniture (`via`, for a chair) → the spot; out the same way back. It accelerates at 30 m/s² up to 8.2 m/s (the office's own running pace is 7.4), up to 12 when far behind, and the office's gait takes it from there — `Character` reads the body's own movement and places the feet. More than 260 px beyond the window's edge it is put just beyond the edge instead and runs in from there. Standing with nothing to do, its head follows the pointer. A click on it is the office's whip: a flinch, "jao!", and nothing sent anywhere (`tests/ui/entrance.mjs` checks that no request is made). Its tag — in the manner of the office's tags — says what it is doing.

### The door

`.ent-rail` is a zero-height sticky row at the top of the scrolling page, so the card stays put without being `position: fixed` (a fixed sibling would swallow the wheel) and is first in the page for the keyboard and a screen reader. It is **open** at the top of the page and at the bottom, where the page is about it; in between it is **folded** to the office's name and one button, so the lane belongs to the scene. Folded, its forms are `inert`. It opens again under the pointer (after 140 ms, so a pointer passing by does not flap it), on a click of its button (which also puts the cursor in the first field), and stays open while the cursor is in one of its fields. Scrolling more than 60 % of a window away with the cursor in an *empty* field gives the keys back to the page.

Its swing: a spring toward an angle proportional to the scroll speed (at most 5°), a few pixels of lag the other way, and a lean of a few degrees toward the pointer — all eased to rest while the pointer is on it or the cursor in it, so nothing moves under somebody who is typing. The loop runs only while something is still moving.

Somebody who signed in here before (`orch.login-name`) gets the member form with the cursor in the password; anybody else gets the visitor form and no focus in a field, so that Space and the arrows scroll the page.

### Three ways the page is quieter

- **Less motion** — `prefers-reduced-motion`, or the reader's own switch at the foot of the page ("Hold everything still", kept in `localStorage` as `orch.entrance-calm`): nobody walks or gestures, the intern simply *is* at the door, at its desk, in the break room and at the door again; the door does not swing; nothing fades in; the scene is drawn only when the page scrolls.
- **No WebGL** — the page, the pictures and the door, with the right-hand side only as wide as the door (`.ent-flat`). If the scene throws while drawing, the same.
- **A narrow window** (under 860 px) — one column; the door is a bar across the top that opens over the page when asked.

### What had to be true for the door to let it through

- Every file is a hashed file directly under `/assets/` (images are imported from `src`, never placed in a nested public folder), because that is all the door's `ALLOWED` list gives a stranger. `tests/ui/entrance.mjs` checks every request the page made.
- No CDN, no font files, no external images (`index.html`'s Content-Security-Policy): system fonts, the logo inlined.
- The office's key handler in `App.tsx` now does nothing while nobody is signed in. Before, with the focus not in a field, it swallowed Tab, Space and Enter on the entrance — which nobody noticed while the old page put the cursor in its one field.

## Working on it

```sh
node scripts/entrance-office.ts --door 4795            # a made-up office with its door open; prints the door's address and two passwords
ORCH_DOOR_URL=https://127.0.0.1:4795 pnpm dev:ui       # the development server standing at that door: http://127.0.0.1:5173
```

With `ORCH_DOOR_URL` set, `vite.config.ts` sends `/knock`, `/login`, `/join`, `/api` and `/ws` through the door, so the page is what a stranger gets and a sign-in leads into the office, with hot reload. (Without it the development server talks to an office from the inside, where there is no door and therefore no entrance page.) For the built page, open the door's own address in a browser and accept its certificate.

Where to change what: the words and the order of the sections are the JSX of `EntrancePage.tsx`; what stands at a place, and what the intern does there, is one entry of `PLACES` in `Stage.tsx` (positions in metres, `x` to the right and `z` toward the viewer, in the place's own turned frame) plus a `<Place id="…">` in the page where it should stand; colours and type are the variables at the top of `entrance.css`.

## Sizes

From `pnpm build:ui`, 2026-11-11 (raw / gzip):

| | |
| --- | --- |
| `EntrancePage-*.js` | 31.5 kB / 10.4 kB |
| `EntrancePage-*.css` | 16.3 kB / 4.7 kB |
| `Stage-*.js` | 20.3 kB / 8.3 kB (the models and the figure are already in the office's chunk) |
| the eight pictures | 1.03 MB, each fetched when reached |
| the office's own `index-*.js` | 406.8 kB / 143.4 kB — 5 kB *smaller* than before (the old page's components left it) |

**A visitor still downloads the office first.** `main.tsx` imports `App.tsx`, which imports the whole office, so `index`, `three`, `r3f` and `xterm` (about 1.8 MB, 520 kB gzipped) arrive before the entrance's own 20 kB — as they did for the old page. Not fetching them for somebody who has no token needs a small entry of its own in front of `main.tsx` (decide from `localStorage`/`window.orchestrator` whether to load the office or only the entrance, and load the office after a sign-in). It was left out here because it has to repeat `main.tsx`'s phone rule and change how the office starts, and `main.tsx` was not to be touched in this piece of work. The page was written so that it can be done: `entrance.css` and `geometry.ts` lean on nothing of the office, and `Knock.tsx` imports only `lib/api.ts`.

## Testing it

- `node tests/ui/entrance.mjs` (after `pnpm build:ui`; about a minute and a half) — a made-up office with its door open and three browser windows with separate storage, driven with real clicks, keys and the wheel: the page and the office's name; the scene drawn; every request one the door allows; a click on the intern; Tab reaches the door first; the wheel scrolls and the canvas lies where the window is at each of seven stops; the door folded down the page and opened by one click; a wrong password refused in place; a member signed in and in the office as themselves; a knock seen inside with the same code and let in to look; an invitation link's page and its code redeemed; the still page under `prefers-reduced-motion`; no errors logged. `ORCH_SHOT_DIR=<folder>` keeps pictures.
- `tests/ui/guest-app.mjs` still knocks through this page (`.knock-card`, `.knock-code` and the button's words were kept for it).
- `tests/e2e/15-knock.test.ts`, `tests/e2e/36-password-sign-in.test.ts` — the door's side; unchanged.

Measured by hand on 2026-11-11 (Apple-silicon Mac, Electron 33, 1500 × 940):
- **Stays put while scrolling** — still page, 14 stops of 37 px at three places, composited captures compared pixel for pixel after shifting by 37 px: 0.00 % of the lane's pixels differ at two places, at most 0.01 % (a handful of pixels on the turntable's arm) at the third. The first run found the hi-fi's platter flickering between frames; the record now covers it.
- **Frame rate** — 143 per second on a 144 Hz screen, standing and scrolling, at one and at two device pixels per pixel.
- **By eye** — captures at about a dozen scroll positions at 1500 × 940, 900 × 700 and 800 × 700; with less motion; without WebGL; at two device pixels per pixel.

## Limits, plainly

- **Not for phones.** The office turns a phone away before the page is sent, and the page was not made for one: the scene is off under 860 px and the narrow layout is a fallback for a small desktop window, not a designed phone page. To show it on phones: let the door serve the page (and only the page) to a phone — today `phone.ts` answers 403 for everything — keep the office itself refused after sign-in, and design the narrow layout properly (touch targets, the door as a sheet, the pictures cropped for a tall screen; a small scene along the bottom would be possible). That is the owner's decision; see `DECISIONS.md` on phones.
- **Hover opens the door.** On a touch screen without hover the button does; nothing depends on hover.
- **The scene costs a GPU.** It stops when the tab is hidden and after a minute of nothing, but while somebody scrolls it draws every frame.
- **Fonts are the system's.** The headline is a rounded face where the system has one (macOS), and the plain interface face elsewhere; the neon sign uses whatever script face the system has. No font file is shipped.
- **The lean of the pictures** as they come and go uses CSS scroll-driven animations (`animation-timeline: view()`); where a browser has none, they simply come up into place.

## Not verified

- Any browser but Electron 33's Chromium (130). Safari and Firefox were not opened; the fallbacks for `overflow: clip`, `inert`, `animation-timeline` and `ui-rounded` are in the stylesheet but unseen.
- A password manager on the form (the markup is what one expects; none was run).
- A screen reader. The structure is there — one `h1`, an `h2` per section, the door an `aside` with a label, labelled fields, errors with `role="alert"`, the scene and its tag hidden from it — but nobody listened to it.
- A slow computer, an integrated GPU, a 4K screen.
- The page behind the real TLS door of a deployed office (it was run behind the door of throwaway offices on this computer only).
- The desktop app does not show this page, and was not started.
