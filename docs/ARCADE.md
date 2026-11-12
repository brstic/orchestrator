# The arcade: a Mega Drive in the break room

The arcade cabinet in the office plays Sega Mega Drive games from cartridge files a person brings themselves, with one or two players. Read this before changing anything under `apps/desktop/src/arcade/`, the window `hud/panels/arcade.tsx`, or how the office serves `assets/arcade.html`.

_Built on 2026-11-12 on the owner's request: "make it so I can play ROM games from the Sega Mega Drive 2 on the arcade (I will supply the ROMs), with 2 player support"._

## What a person sees

- **The cabinet** stands in the break room once the office has delivered ten tasks (the milestone "Momentum"; it is a decoration, so an owner can move or remove it in *Floor plan*). Walk up to its screen and press the interact key, or click it. Where a cabinet stands, the menu has **Arcade** under *Break room* too.
- **The shelf**: the games brought to this computer, the one played last first. **Add games…** or a drop takes `.md`, `.gen`, `.bin`, `.smd` (and `.sms`, `.gg`: the core also runs Master System and Game Gear cartridges), or a `.zip` with one inside. A game is named by what its cartridge says of itself, or by its file. The same cartridge twice is one game.
- **Playing**: the screen, and above it *← Games*, *Pause*, *Reset*, *Save*, *Load*, *Sound on/off*, *Full screen*. **Escape** leaves the game for the shelf; the next Escape closes the window.
- **Two players**: under the screen each player chooses **Keyboard** or a **gamepad** (the second player can be *Nobody*). The line under each choice says the keys.

  | Who is on the keyboard | Move | A B C | X Y Z | Start |
  |---|---|---|---|---|
  | One player (the whole keyboard) | W A S D or the arrows | J K L | U I O | Enter |
  | Player 1 when both are (left half) | W A S D | F G H | R T Y | 1 |
  | Player 2 when both are (right half) | the arrows | J K L | U I O | Enter |
  | A gamepad | d-pad or left stick | X A B | LB Y RB | Start |

  Keys are read by where they are on the keyboard, not by the letter the layout prints. With no gamepad the usual is one player on the whole keyboard; with one, the gamepad is player 1 and the keyboard player 2; with two, both. A choice is remembered on this computer. A browser shows a gamepad only after a button on it has been pressed.
- **What is kept**: leaving a game (by *← Games*, Escape or closing the window) keeps the exact moment, and the shelf then offers **Continue** with a picture of it, beside **Start over**. The moment is also kept every half minute while playing, and by *Save*. What the cartridge itself saves (its battery memory) is kept apart and survives *Start over*. **Remove** deletes the game and everything kept of it.
- While a game is on, the keys of whoever plays are the game's: the office does not hear them (nobody walks off). Every other key is still the office's — push-to-talk (V) works while playing, unless it was bound to a key a player holds, in which case that key is the game's. Typing in another window's text box still types.

## Where things are, and why nothing is sent to the office

Everything is on the computer of whoever plays, in the browser's own storage for the office's address (IndexedDB, database `orchestrator-arcade`; in the desktop app that is the app's profile, which an update of the app keeps):

| Store | Holds |
|---|---|
| `games` | title, file name, size, when added and played, when a moment was kept and its picture |
| `roms` | the cartridge's bytes |
| `kept` | battery memory (`sram`) and the moment to continue from (`state`) |

A game's id is the SHA-1 of its bytes. Nothing of this reaches the server: no endpoint, no event, no state. That is on purpose — the cartridges are the person's own, and the office has no business holding or passing them on. The cost: a game added on one computer is not on another, and another member cannot see or join it (see "Not built").

## The frame

The emulator is somebody else's program (below) running a file from outside, on a page that otherwise holds a credential to the whole office. So it does not run on that page:

```
the office's page (hud/panels/arcade.tsx)                 the console (arcade/frame.ts)
  keyboard, gamepads, the shelf, what is kept               <iframe src="assets/arcade.html" sandbox="allow-scripts">
        │  postMessage: boot {core, cartridge, kept}  ───▶    RetroArch + Genesis Plus GX (WebAssembly), one canvas
        │  postMessage: pad {player, button, down}    ───▶    no keyboard, no network, no storage
        ◀─── postMessage: running | kept {sram, state, picture} | sound {heard}
```

- **`sandbox="allow-scripts"` and nothing else**: the frame is no origin at all (`self.origin === "null"`). It cannot read the office's storage, its credential, its DOM or its cookies, and a request it made to the office would carry nothing.
- **A policy of its own** (`<meta>` in the page, written by `arcadeFrame()` in `apps/desktop/vite.config.ts`): `default-src 'none'; script-src 'self' blob: 'wasm-unsafe-eval'; connect-src blob: data:; …`. WebAssembly and the script it is handed, and no network. The office's own page keeps `script-src 'self'`; it only gained `frame-src 'self'`.
- **It is handed everything**: the window fetches the core (two packed files beside the app, unpacked in the page with `DecompressionStream`) and reads the cartridge from storage, and posts the bytes. What should be kept comes back the same way.
- **It never has the keyboard**: the frame takes no pointer events and its canvas's `focus()` does nothing. The window listens for keys (capture phase, so the office's own handlers never see a key that is a player's button; the one handler that listens earlier, push-to-talk, asks `keyTaken` first), reads gamepads every frame, and sends only changes. RetroArch reads pads as keys, so each player's buttons are bound to keys of their own that nothing but those messages ever sends; all of RetroArch's own shortcuts are tied to a key that is never sent.
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
| `apps/desktop/src/arcade/protocol.ts` | The messages between window and console; the pad's buttons |
| `apps/desktop/src/arcade/input.ts` | Seats (keyboard, gamepad, nobody), key layouts, gamepad → pad, who gets what by default. Pure |
| `apps/desktop/src/arcade/roms.ts` | Is this file a cartridge; zip; the game's name; its id. Pure |
| `apps/desktop/src/arcade/library.ts` | The three stores in IndexedDB |
| `apps/desktop/src/arcade/console.ts` | The window's hold on the frame: load the core, boot, pad, keep |
| `apps/desktop/src/arcade/frame.ts` | The page inside the frame |
| `apps/desktop/src/arcade/stands.ts` | Whether a cabinet stands in this office (for the menu) |
| `apps/desktop/src/lib/keys-taken.ts` | Which keys a game holds right now, for the office's shortcuts that listen before the window does (push-to-talk, `hud/people-acts.tsx`) |
| `apps/desktop/src/hud/panels/arcade.tsx`, `arcade.css` | The window |
| `apps/desktop/vite.config.ts` (`arcadeFrame`) | Writes `assets/arcade.html` and builds the frame's script |
| `packages/office-3d/src/world.ts` | The spot in front of a cabinet (`kind: 'arcade'`); `Environment.tsx`: the click |

## Tests

- Unit: `apps/desktop/test/arcade-input.test.ts` (seats, layouts, gamepad), `arcade-roms.test.ts` (files, zip, names, ids), `packages/office-3d/test/world.test.ts` (the spot in front of the cabinet).
- e2e: `tests/e2e/49-arcade-frame.test.ts` (the three server rules, also through the door).
- UI suite, one step: a cartridge is added, played, and both players' buttons are read back from the screen — one player on the whole keyboard, two on its halves, a gamepad beside the keyboard — the owner does not move in the office, the frame is sandboxed, Continue is offered, Escape leaves, Remove removes.
- **The test cartridge** (`tests/fixtures/md-test-rom.mjs`) is our own: a few dozen 68000 instructions assembled in that file. It shows what both pads hold as the colour of the whole screen, so a test reads one pixel. No game of anybody's is in the repository, and none may be added.

## Not verified

- **No real game has been run by a test, and none by the person who built this**: only the test cartridge. It proves the core runs, the picture is shown and both pads arrive; it has no sound, no sprites, no battery memory and no timing demands. Sound, saving to battery memory, *Save*/*Load* of a real game's state and how a real game feels to play (input delay, frame pacing) are for the owner to try.
- **No real gamepad was used.** The UI step shows the page a pad that is not there. A pad that does not report the browser's standard arrangement (some 6-button Mega Drive-style pads) will have its buttons somewhere else; there is no screen to rebind them.
- **Only in Electron.** The window was never opened in a plain browser tab (the browser at hand could not be driven on the day): the sandboxed frame, its policy and the storage are the browser's own machinery and should behave the same, but that is an expectation.
- A screen with two device pixels to one (the owner's Mac) was imitated with a zoom of 2, not seen: the picture filled the canvas and the canvas had twice the dots.
- Sound in a plain browser tab may wait for a click (the window says so and offers the click); in the desktop app it should not. Neither was listened to.
- The desktop app does not grant the console a wake lock, so with only a gamepad in hand the display may go to sleep as it would otherwise.
- Not looked at as a visitor or a colleague on screen (the window is the same for every role: it is in a visitor's list of windows, and nothing in it depends on the role).

## Not built

- **Playing with somebody on another computer.** Two players means two people at one computer. Over the network it would need the same cartridge on both sides and the two consoles kept in step; nothing of that exists.
- Rebinding keys or gamepad buttons; more than one kept moment per game; cheats; other consoles.
- Others in the office see nothing of a game being played (the cabinet's screen in the 3D office is still its own little animation).
