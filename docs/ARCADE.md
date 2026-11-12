# The arcade: a Mega Drive in the break room

The arcade cabinet in the office plays Sega Mega Drive games from cartridge files the members bring. The games are kept with the office, so everyone has them on every computer; and two people in the office play one game together, each at their own computer. Read this before changing anything under `apps/desktop/src/arcade/`, the window `hud/panels/arcade.tsx`, `apps/server/src/arcade.ts`, or how the office serves `assets/arcade.html`.

_Built on 2026-11-12 on the owner's requests. First: "make it so I can play ROM games from the Sega Mega Drive 2 on the arcade (I will supply the ROMs), with 2 player support". Then, the same day: "the games from the arcade must stay on the server when they are uploaded, and it must support multiplayer — of the players who are in the office right now, not the local one on one computer: we both stand in front of the arcade and play"._

## What a person sees

- **The cabinet** stands in the break room once the office has delivered ten tasks (the milestone "Momentum"; it is a decoration, so an owner can move or remove it in *Floor plan*). Walk up to its screen and press the interact key, or click it. Where a cabinet stands, the menu has **Arcade** under *Break room* too.
- **The shelf** is the office's: the games anybody brought, the one you played last first. **Add games…** or a drop takes `.md`, `.gen`, `.bin`, `.smd` (and `.sms`, `.gg`: the core also runs Master System and Game Gear cartridges), or a `.zip` with one inside. A game is named by what its cartridge says of itself, or by its file. The same cartridge twice is one game. **Remove** takes it off the shelf for everyone. A visitor plays what is there and neither brings nor removes.
- **Playing**: the screen, and above it *← Games*, *Open to the office ✓*, *Pause*, *Reset*, *Save*, *Load*, *Sound on/off*, *Full screen*. **Escape** leaves the game for the shelf; the next Escape closes the window.
- **Playing with somebody in the office.** A game is open to the office from the moment it runs — nothing to press (the button *Open to the office ✓* closes it for somebody who wants to play alone; that choice is remembered). Everyone is told ("Branko is playing … at the arcade — walk up to it to join"), and in the Arcade window of everybody else the game stands under *Being played now* with **Join** and **Watch**. **Two play**: whoever presses Join first sees and hears the game on their own computer and is player 2; **anybody after that looks on** (eight at most). **The keys are the same for everyone**: W A S D to move, J K L for A B C, U I O for X Y Z, Enter for Start — for the one who started the game and for the one who joined, each at their own keyboard. The host's line says who plays along. Getting up (Escape, *← Games*) frees the pad; the host closing the game, or leaving the office, ends it for everyone at it.
- **Two players at one computer** still works: under the screen each player chooses **Keyboard** or a **gamepad** (the second can be *Nobody*). When somebody has joined from another computer, the second pad is theirs and is not chosen here.

  | Who is on the keyboard | Move | A B C | X Y Z | Start |
  |---|---|---|---|---|
  | **Everyone, unless they choose otherwise** — the one who started a game and the one who joined it, each at their own keyboard | W A S D (or the arrows) | J K L | U I O | Enter |
  | Player 1 when both are at one computer (left half) | W A S D | F G H | R T Y | 1 |
  | Player 2 when both are at one computer (right half) | the arrows | J K L | U I O | Enter |
  | A gamepad | d-pad or left stick | X A B | LB Y RB | Start |

  Keys are read by where they are on the keyboard, not by the letter the layout prints. What a player holds is the keyboard unless they choose a gamepad (a gamepad that is plugged in is not taken by itself: the keys are the same for everyone until somebody decides otherwise); the choice is remembered on this computer. A browser shows a gamepad only after a button on it has been pressed.
- **What is kept, and where**: the *games* are the office's. *Where you stopped* is yours, on the computer you played on: leaving a game keeps the exact moment and the shelf offers **Continue** with a picture of it, beside **Start over**; the moment is also kept every half minute and by *Save*. What the cartridge itself saves (its battery memory) is kept apart and survives *Start over*. In a game played together all of that is the host's: the one who joined keeps nothing.
- While a game is on, the keys of whoever plays are the game's: the office does not hear them (nobody walks off). Every other key is still the office's — push-to-talk (V) works while playing, which is how two people playing together talk — unless it was bound to a key a player holds, in which case that key is the game's. Typing in another window's text box still types.

## The shelf: games are kept with the office

| Where | What |
|---|---|
| Office: `<data folder>/arcade/<id>.rom`, `games.json` | The cartridges and the list (title, file name, size, when and by whom). `ArcadeShelf` in `apps/server/src/arcade.ts` |
| Browser, IndexedDB `orchestrator-arcade` → `roms` | A copy of each cartridge that was played on this computer, so it is fetched once |
| Browser → `kept`, `games` | Battery memory and the moment to continue from; when it was played, the picture of that moment |

- A game's id is the SHA-1 of its bytes, worked out by the office when the last piece has arrived.
- **A cartridge arrives in pieces** of 384 KB (as a file on a task does), so that it passes any proxy: `POST /api/arcade/games` says what it is, `POST /api/arcade/games/:upload/data` carries each piece. 16 MB a game, 500 games.
- `GET /api/arcade/games` and `GET /api/arcade/games/:id/rom` are for everyone who is in (a visitor too); bringing and removing is for those who work here (`access.ts`). Nothing is served without a credential: the cartridges are not on the entrance page's side of the door.
- Who brought and who removed what is in the audit log (`arcade.game_added`, `arcade.game_removed`).
- The shelf and the open tables are told to every window (`{ t: 'arcade', games, tables }`) at the start and on every change.
- **Games a browser kept from the arcade's first day** (when they lived on one computer) are put on the shelf the first time that person opens the window (`bringOldGames`).
- **Whose files these are**: the members'. The office holds what they bring and hands it to the people they let in; it is theirs to decide what belongs there.

## Playing with somebody in the office

One console runs the game — the host's. Everybody else gets its picture and sound, and whoever holds the second pad sends buttons back:

```
host's window                                   the office (hubs.ts → ArcadeTables)            guest's window
 console (frame) ── picture 640×480, ~60/s ─┐
                 ── sound, as played ───────┤
 Caster: VP8 + Opus (the browser's encoders)│
   arcade.media {cfg | v | a} ──────────────┴─▶ to those at the table, nobody else ─────────▶ Viewer: decode → canvas, loudspeaker
   machine.pad(2, …) ◀── arcade.pad ◀────────── from whoever holds pad 2, nobody else ◀────── keys / gamepad → arcade.pad
   Caster.keyframe() ◀── arcade.key ◀────────── "somebody sat down / lost the picture" ◀───── arcade.key
```

- **Why this way and not two consoles kept in step**: this emulator (RetroArch in a frame) cannot be stepped a frame at a time from outside, which is what keeping two in step needs. Showing one console to the other player needs nothing of the game, works for any cartridge, lets others look on, and the one who joins does not even need the file. Its price is the way there and back: what the guest sees and their buttons are later by the time the office takes to pass them on. `DECISIONS.md`, "The arcade over the network".
- **Through the office, not from one computer to the other.** Everybody already has a connection to the office, through whatever is between them; a direct one would need an outside server to find each other across home routers. So the picture goes host → office → guest, as base64 inside the same messages everything else uses. About 1.5 Mbit/s of picture and 0.1 of sound for each person at the table.
- **The office keeps nothing of a game** and looks into nothing: it passes pieces on to those at the table. It holds: who hosts, who has pad 2, who looks on.
- **Rules the office enforces** (`ArcadeTables`, e2e `50-arcade-shared`): only the host's pieces go to its table; only pad 2's holder's buttons go to the host, as pad 2; the pad goes to the first who asks; a pad whose holder gets up lets go of everything; a window gone is a seat freed or a table closed. A piece is 700 KB at most and a host sends 240 a second at most.
- **A picture is built on the one before it.** Somebody who sits down, or whose connection fell behind (more than 1.5 MB waiting to go out to them), is sent no picture until one that stands by itself, and the host is asked for one (once a second at most). The host sends one every four seconds regardless.
- **A guest who is behind sees fewer pictures, not older ones** (`Viewer` in `cast.ts`). Each picture carries the host's clock; one that arrives more than 300 ms later than the best the way has managed — or behind more than six still waiting to be unpacked — is let go together with the ones built on it, and the guest goes on from the next one that stands by itself. Found on the two-computer trial: a guest whose page managed one turn a second fell further behind with every picture; with this it shows about one current picture a second instead.
- **The picture and sound are taken only while somebody is at the table.** A game that is open and has nobody at it costs the host nothing.
- **Sound**: the console's sound is taken before this window's own volume, so *Sound off* at the host silences the host's loudspeaker and not what the guest hears. At the guest it is played right behind the piece before it, 40 ms ahead; when more than a quarter second has piled up, pieces are dropped until it has caught up.
- **Which browsers**: one with the WebCodecs encoders and decoders (`VideoEncoder`, `VideoDecoder`): the desktop app and Chromium browsers. Elsewhere a game is not opened to the office and *Join* says that it cannot.

## The frame

The emulator is somebody else's program (below) running a file from outside, on a page that otherwise holds a credential to the whole office. So it does not run on that page:

```
the office's page (hud/panels/arcade.tsx)                 the console (arcade/frame.ts)
  keyboard, gamepads, the shelf, what is kept               <iframe src="assets/arcade.html" sandbox="allow-scripts">
        │  postMessage: boot {core, cartridge, kept}  ───▶    RetroArch + Genesis Plus GX (WebAssembly), one canvas
        │  postMessage: pad {player, button, down}    ───▶    no keyboard, no network, no storage
        ◀─── postMessage: running | kept {sram, state, picture} | sound {state} | frame {bitmap} | pcm {…}
```

- **`sandbox="allow-scripts"` and nothing else**: the frame is no origin at all (`self.origin === "null"`). It cannot read the office's storage, its credential, its DOM or its cookies, and a request it made to the office would carry nothing.
- **A policy of its own** (`<meta>` in the page, written by `arcadeFrame()` in `apps/desktop/vite.config.ts`): `default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; connect-src blob: data:; …`. WebAssembly and the script it is handed, and no network. The office's own page keeps `script-src 'self'`; it only gained `frame-src 'self'`.
- **It is handed everything**: the window fetches the core (two packed files beside the app, unpacked in the page with `DecompressionStream`) and the cartridge, and posts the bytes. What should be kept comes back the same way. **Also when the game is shown to others**: the frame hands pictures and sound to the window, and the window — not the frame — sends them to the office.
- **It never has the keyboard**: the frame takes no pointer events and its canvas's `focus()` does nothing. The window listens for keys (capture phase, so the office's own handlers never see a key that is a player's button; the one handler that listens earlier, push-to-talk, asks `keyTaken` first), reads gamepads every frame, and sends only changes. RetroArch reads pads as keys, so each player's buttons are bound to keys of their own that nothing but those messages ever sends; all of RetroArch's own shortcuts are tied to a key that is never sent.
- **Two things are changed under the emulator** (`frame.ts`): its canvas keeps what was drawn (`preserveDrawingBuffer`), so a picture can be taken at any moment; and whatever it connects to a sound output goes through a point of ours, from where it reaches the loudspeaker through this window's volume and, separately, the listener that hands it over.
- **In development** (`pnpm dev:ui`) the frame is `allow-scripts allow-same-origin`: Vite's server does not hand a script module to a page with no origin. The built UI, which every test and every office uses, has the real sandbox.

Three things on the server make the frame possible, each as narrow as it could be made (`apps/server/src/server.ts`, e2e `49-arcade-frame`):

1. `X-Frame-Options` is `DENY` for everything, and `SAMEORIGIN` for exactly `/assets/arcade.html`.
2. Files under `/assets/` are sent with `Access-Control-Allow-Origin: *`: a script module is only given to a page with no origin when the file says anyone may read it. These are the app's built files, which the door already hands to anybody.
3. Everything is under `/assets/` with flat names because that is what the door lets through (`ALLOWED` in `door.ts`, unchanged).

## The emulator

- **Core**: [Genesis Plus GX](https://github.com/libretro/Genesis-Plus-GX) as a libretro core inside RetroArch 1.22.2, built for the web by the `retroarch-emscripten-build` project (the build the `nostalgist` library uses by default). The two files are in `apps/desktop/src/arcade/core/`, gzip-packed (1.4 MB together), with where they came from and their checksums in `NOTICE.md` there. They are part of the repository so that a build needs no network.
- **Launcher**: [`nostalgist`](https://nostalgist.js.org) 0.23.0 (MIT), bundled into the frame's script only. It is given the core as bytes (it would otherwise fetch from a CDN, which the frame's policy forbids anyway).
- **Licences**: RetroArch is GPLv3. **Genesis Plus GX may not be sold or used in something sold** (its own non-commercial licence). That is fine for an office used by its owner and their colleagues; if Orchestrator is ever sold or distributed commercially, the core has to be replaced (ClownMDEmu, AGPL, is in the same build set) or left out. `DECISIONS.md`, "The arcade".
- **Buttons**: a Mega Drive pad's A B C X Y Z Start Mode are the core's RetroPad Y B A L X R Start Select (`RETRO` in `frame.ts`; from the core's `libretro.c`, and A B C Start for both pads are checked by the test cartridge).

## Code map

| File | What |
|---|---|
| `packages/contracts/src/arcade.ts`, `protocol.ts` (`arcade.*`) | Games, tables, limits; the messages between a window and the office |
| `apps/server/src/arcade.ts` | `ArcadeShelf` (the games) and `ArcadeTables` (who plays with whom; what is passed on) |
| `apps/server/src/server.ts`, `hubs.ts`, `access.ts` | The shelf's routes; the tables' messages; who may do what |
| `apps/desktop/src/arcade/protocol.ts` | The messages between window and console |
| `apps/desktop/src/arcade/input.ts` | Seats (keyboard, gamepad, nobody), key layouts, gamepad → pad, who gets what by default. Pure |
| `apps/desktop/src/arcade/roms.ts` | Is this file a cartridge; zip; the game's name. Pure |
| `apps/desktop/src/arcade/library.ts` | The shelf from the office, uploads, this computer's copies and saves |
| `apps/desktop/src/arcade/console.ts` | The window's hold on the frame: load the core, boot, pad, keep, cast |
| `apps/desktop/src/arcade/frame.ts` | The page inside the frame |
| `apps/desktop/src/arcade/cast.ts` | `Caster` (host: encode and send) and `Viewer` (guest: decode, draw, play) |
| `apps/desktop/src/arcade/net.ts` | Table news from the office, handed to whoever plays |
| `apps/desktop/src/arcade/stands.ts` | Whether a cabinet stands in this office (for the menu) |
| `apps/desktop/src/lib/keys-taken.ts` | Which keys a game holds right now, for the office's shortcuts that listen before the window does (push-to-talk, `hud/people-acts.tsx`) |
| `apps/desktop/src/hud/panels/arcade.tsx`, `arcade.css` | The window: `Shelf`, `Play` (host), `Remote` (guest) |
| `apps/desktop/vite.config.ts` (`arcadeFrame`) | Writes `assets/arcade.html` and builds the frame's script |
| `packages/office-3d/src/world.ts` | The spot in front of a cabinet (`kind: 'arcade'`); `Environment.tsx`: the click |

## Tests

- Unit: `apps/desktop/test/arcade-input.test.ts` (seats, layouts, gamepad, keys taken), `arcade-roms.test.ts` (files, zip, names, ids), `packages/office-3d/test/world.test.ts` (the spot in front of the cabinet).
- e2e: `49-arcade-frame` (the three server rules for the frame, also through the door); `50-arcade-shared` (the shelf: brought by one, there for all, byte for byte, a visitor's limits, refusals, a restart, removal — and the tables: who gets the picture, whose buttons count, a seat freed, a host gone), with four members coming in through the door.
- UI suite, one step, two windows: a cartridge is brought (to the office's shelf), played, and both pads are read back from the screen — one player on the whole keyboard, two on its halves, a gamepad beside the keyboard — the owner does not move in the office, the frame is sandboxed, Continue is offered; then **a second window of the office finds the game on its shelf, joins the first one's game, is shown its picture (read back as the cartridge's colours) and pieces of sound, and its keys arrive as player 2 at the first window's console**; it gets up holding a button and the pad lets go.
- `tests/arcade/two-computers.mjs` (with `host-window.cjs`): the same game between two computers, driven from outside both browsers; it says at its top how to set it up. Not part of any suite: it needs a second computer.
- `UI_ONLY=<regex> node tests/ui/run.mjs …` runs only the steps whose names match (for working on one step; the checks at the end then mostly fail).
- **The test cartridge** (`tests/fixtures/md-test-rom.mjs`) is our own: a few dozen 68000 instructions assembled in that file. It shows what both pads hold as the colour of the whole screen, so a test reads one pixel. No game of anybody's is in the repository, and none may be added.

## Not verified

- **No real game has been run by a test, and none by the person who built this**: only the test cartridge. It proves the core runs, the picture is shown and both pads arrive; it has no sound, no sprites, no battery memory and no timing demands. Sound, saving to battery memory, *Save*/*Load* of a real game's state and how a real game feels to play are for the owner to try.
- **Playing together on two computers was tried once, by a script, on one local network** (2026-11-12; `tests/arcade/two-computers.mjs`): the host in a window on the development Mac, the second player in Chrome on the office's Linux server, both in a trial office started on that server for the purpose, the Mac reaching it through an SSH tunnel (network round trip 0.6 ms). The guest found the game on the shelf without ever having the file, joined, and its keys were player 2's at the host's console while the host's were player 1's — both read back from the host's console and from the guest's picture. **From the guest's key to the guest seeing what it did: 46 ms in the middle, 35 to 66 ms over twenty tries**; 49 pictures and 50 pieces of sound a second at the guest; no picture let go for being behind. Two things about that trial: the server has no graphics card, so the drawing of the 3D office was switched off in the guest's page (with it on, that page manages one turn a second — which is how the rule for a guest who is behind was found); and the picture was the test cartridge's single colour.
- **Not tried: two people, over the internet, through the real office's door.** There the delay is the two connections' own on top of what was measured, and a moving, detailed picture needs more of the 1.5 Mbit/s than a screen of one colour. Sound was counted, never listened to.
- **No real gamepad was used.** The UI step shows the page a pad that is not there. A pad that does not report the browser's standard arrangement (some 6-button Mega Drive-style pads) will have its buttons somewhere else; there is no screen to rebind them.
- **Only in Electron.** The window was never opened in a plain browser tab: the sandboxed frame, its policy, the storage and the encoders are the browser's own machinery and should behave the same in Chrome, but that is an expectation. Firefox and Safari may lack the encoders (then playing alone works and playing together says it cannot).
- A screen with two device pixels to one (the owner's Mac) was imitated with a zoom of 2, not seen: the picture filled the canvas and the canvas had twice the dots.
- Sound in a plain browser tab may wait for a click (the window says so and offers the click); in the desktop app it should not. Neither was listened to.
- The desktop app does not grant the console a wake lock, so with only a gamepad in hand the display may go to sleep as it would otherwise.
- Not looked at on screen as a visitor or a colleague (their limits on the shelf and at a table are tested on the server's side).

## Not built

- **More than two players**, and choosing who gets the pad (it is the first who asks).
- **Saves that follow a person** to another computer: where you stopped stays where you played.
- Rebinding keys or gamepad buttons; more than one kept moment per game; cheats; other consoles.
- Others in the office see nothing of a game in the 3D office itself (the cabinet's screen there is still its own little animation); they are told in words and in the Arcade window.
