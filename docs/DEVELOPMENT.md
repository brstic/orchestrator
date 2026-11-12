# Development

## Layout
```
apps/server        HTTP + WebSocket hub, owner API, door (TLS for people outside), SSH links
apps/host-agent    one per machine: tmux, Claude Code launch, hooks, terminal streaming
apps/desktop       Electron shell (electron/) and the office UI (src/: HUD panels, store, views)
packages/contracts       shared types, roles catalogue, protocol messages
packages/orchestration   the engine: employees, sessions, tasks, comms, meetings, improve, foreman
packages/execution       tmux and Claude Code launch plans (the only layer that touches processes)
packages/database        document store: SQLite and PostgreSQL behind one interface
packages/integrations    MCP server and tool declarations
packages/office-3d       the 3D office (react-three-fiber): world, people, rig, rooms
packages/ui, terminal, game-systems
tests/e2e   real server + real agent + scripted worker      tests/ui   real Electron, real clicks
tests/linux containers (multi-machine, SSH)                 tests/real the real `claude` CLI (costs usage)
```

## Commands
| | |
| --- | --- |
| `pnpm check:changed` | the fast loop: typecheck (only when a typechecked `.ts` changed) and the unit tests *beside* what you touched, plus any changed `tests/e2e` file. Runs the tests of the packages you changed, not of their dependents — a quick gate, not a substitute for the full suites. `--base <ref>` for a whole branch, `--dry` to print the plan |
| `pnpm typecheck` and `pnpm --filter @orchestrator/desktop typecheck` | both must be clean (the second covers `App.tsx` and panels) |
| `pnpm test` | unit |
| `pnpm test:e2e` | end to end with `tests/fixtures/fake-claude.mjs` (no tokens) |
| `pnpm build:ui` then `node tests/ui/run.mjs` | UI suite in Electron against a dev office |
| `node tests/ui/guest-app.mjs`, `node tests/ui/tv-app.mjs`, `node tests/ui/radio-app.mjs` | desktop join flow, TV, the hi-fi in two windows (one that needs a click before sound) |
| `node tests/ui/entrance.mjs` | the page at the office's door in plain browser windows: the scene, the scroll, the door, signing in with a password, knocking, an invitation, less motion (`ENTRANCE-PAGE.md`) |
| `node tests/ui/surroundings.mjs` | where the office stands, in two windows of one office: the Settings page, each place chosen with a real click, the same place in both windows and in the office's state, that no shader failed to build, *Low*, nothing left behind (`SURROUNDINGS.md`) |
| `pnpm test:ssh`, `pnpm test:machines` | containers; need Docker/Colima |
| `pnpm test:central` | the office on a Linux container from the portable package (`pnpm package` first), two desktop apps from this machine; starts the real `claude` on the member's side without sending anything (`--no-real-cli` to avoid) |
| `node scripts/dev-office.ts --port N [--ui <dist>] [--member-room "Mila:3"] [--visitor "Nikola"]` | a populated office with scripted workers for manual work and probes; with a member (a computer and employees of their own) and a visitor when asked, each with an address that opens the office as them. The UI suite's office has the member Mila with three employees |
| `node scripts/entrance-office.ts [--port N] [--door M] [--room]` | the same office with an invented name, its door open and members with passwords: for looking at the entrance page, trying the door by hand, and retaking the page's pictures |

## Shipping
See [OPERATIONS.md](OPERATIONS.md): `pnpm deploy:server` for the office on the server (most changes), and the packaging steps for the desktop app (only when `apps/desktop/electron/` or the bundled agent changed). Never replace a desktop app that is running, and never script its quit — it asks the person first. After shipping, update `STATUS.md` and `CHANGELOG.md`.

## Rules that protect the live office
- Do not touch `~/.orchestrator` (the Mac's personal host lives in `~/.orchestrator/offices/`), `~/.orchestrator-office` on the server, the default tmux servers or `orch-*` sessions on either machine. Tests make their own tmux sockets and temp dirs.
- No `pkill` / `killall`. Stop only processes you started, by pid.
- The real `claude` CLI spends the owner's subscription. Use the scripted worker; zero-token probes of the real CLI (start it, send no prompt) are fine.
- A UI test run and a packaging run both use `apps/desktop/dist`; do not run them at the same time, and do not start a UI run while the app is starting.

## Measuring instead of guessing
- **Flicker:** compare composited frames (`webContents.capturePage()` in a loop, count pixels that change and change back). Reading the WebGL canvas mid-frame produces false differences. Hide the people and the overlays first when the question is about things that stand still (people move on purpose, and a name tag that shifts by a pixel counts as hundreds), let the scene settle for a second after hiding, and compare against the previous build served by `dev-office.ts --ui <its dist>`: a thin line that sweeps across the screen while walking also "changes and changes back", in any build.
- **Flicker of what is around the office** (`SURROUNDINGS.md`, "Shimmer, measured"): the same, with `window.__orchScene.still = true` first — it stops the time outside, so that cars, water, clouds and snow are not counted as flicker — and with the first dozen frames after a change of camera left out (the lens eases to its new angle, and the whole picture changes while it does). One thing to get wrong: hiding overlays with a rule that also hides the canvas makes every frame the same and every count zero — check that the first and last frames differ at all.
- **Looking at a model:** `window.__orchScene.cam = { pos: [x,y,z], look: [x,y,z], fov? }` holds the camera there until the property is deleted (any camera mode; First person for full-height walls and the ceiling). `window.__orchScene.positions` is the map of where everyone is. Earned decorations can be previewed by marking the milestones reached in the store (`window.__office.setState`).
- **Looking at people:** `<electron> scripts/character-sheet.cjs <url-with-token> <out-dir> [sets]` against a running office (a development office will do; the Electron binary is `apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`). It stands figures on the open floor and captures every hair style with every accessory from four sides (`hair`), every outfit on three skin tones (`outfits`), collars and shoulders (`busts`), faces (`faces`), the poses (`poses`) and the same people at the overhead camera's size (`small`); `flicker` prints a count instead (each view once empty, once with people, once with them held still) and saves the first frame with the flickering pixels marked. It works through `window.__orchScene.lineup = [{ appearance, pose?, level?, x, z, rot?, offline?, whip?, still? }]`, which a capture of your own can set too; real people are found through `window.__orchScene.positions`. Take the same set before and after a change and look at both.
- **The README's pictures** (`docs/assets/`): `node scripts/dev-office.ts --port 4755 --ui apps/desktop/dist` prints the office's address; `<electron> scripts/readme-shots.cjs <that address> <dir>` takes the fixed-camera pictures; copy `whip.png` and `panel-tasks.png` from a run of the UI suite into the same folder; `<electron> scripts/readme-art.cjs <dir>` then draws the banner and the framed pictures listed in `docs/assets/readme-art.json` (title, caption, sticker, colours). `README_SHEET=1` makes one page of everything in the folder instead, for choosing. The pictures are of a development office with scripted workers, and the README says so. Stop the development office afterwards (its pid is in what it printed).
- **The entrance page's pictures** (`apps/desktop/src/entrance/shots/`): `node scripts/entrance-office.ts --room`, then `<electron> scripts/entrance-shots.cjs <its "owner" address> apps/desktop/src/entrance/shots`. From a made-up office only; see `ENTRANCE-PAGE.md`.
- **Sizes of models:** `node --test packages/office-3d/test/models.test.ts` — footprint, seat and desk heights, triangle budgets. It runs without a browser; surfaces are then plain.
- **Stutter:** frame-interval evenness matters more than fps. `window.__orchPace` (`every`, `fps`), `window.__orchPerf`.
- **Cost:** `Profiler` over the DevTools protocol on an unminified build (`vite build --minify false --outDir …`, served with `dev-office.ts --ui`).
- `window.__orchScene.three` exposes `{gl, scene, camera, THREE}`; `window.__office` is the store; `window.__orchPlayer.goto = {x,z,rot}` places the owner.

- **Clocks in tests:** what the office does by the clock has its interval in `Timings` (`packages/orchestration/src/core.ts`), so a test can run it fast: `routineTickMs` and `routineMinuteMs` (how long "a minute" of a routine is), `sleepTickMs` and `sleepIdleMs` (overrides the owner's "asleep after … minutes"), `wakeRetryMs`. `tests/e2e/16-routines-sleep.test.ts` runs a five-minute routine every second and a half and puts a session to sleep after two seconds.

## A review by a second reader

On 2026-11-11 six reviews of recent and older work — each by a reader that was given the code and no conclusions — found some sixty defects that the tests and the author had not: a frame that stopped the office, a tool that could put any file of the machine on a task, a held command that ran when the agent restarted. It is worth doing after every piece of work that touches who may do what, what is run where, or what crosses from one machine to another.

What made those reviews useful:
- **One subject per review, named by its files and functions** (sign-in and hooks; files on tasks and accounts; the vault, members and the door; the desktop app). A review of "the changes" finds less than a review of "what the office's page may make the app do on the person's computer".
- **The questions to ask, not the answers expected**: who can cause this, with which role, from where; what is the attacker's position (an employee steered by a web page, a member's own computer, anybody at the door); what must never happen.
- **Read-only, and said so**: no edits, no tests, no git command that changes anything, no real `claude`.
- **A finding is a scenario**: file and line, what state and input lead to what wrong outcome, how sure the reader is and what they checked — and a list of what was checked and found sound, so the next review does not repeat it.
- **Every finding is checked against the code before it is fixed**, and a fix that can be tested gets a test that fails without it (taken out with a reverse patch — see below). Some findings are decisions, not defects: those go to the owner, with a recommendation, in `SECURITY.md`.

The findings and what became of them are in `CHANGELOG.md` (2026-11-11: "After a review…", "A second review…", "A third review…", "A fourth review…") and `STATUS.md`.

## Conventions
- **Seeing a test fail without its fix: with a reverse patch, never with `git stash`.** `git diff HEAD -- <file> > /tmp/fix.patch && git apply -R /tmp/fix.patch`, run the test, `git apply /tmp/fix.patch` (for a fix that is already committed: `git show <commit> -- <file> | git apply -R`). The repository holds an old stash (`stash@{0}`, "The office remodelled…", 39 files) that belongs to whoever made it: `git stash pop` applies *that* whenever the stash you meant to make had nothing to save — which is what happened on 2026-11-11, with conflicts in twenty files (restored from HEAD; the stash was kept). Do not pop, drop or clear stashes here.
- Comments say why, in plain words. No narration of the change itself.
- New owner-visible behaviour that is automatic (camera, overlays, effects) ships switched off behind a setting.
- Every permission decision goes through `apps/server/src/access.ts`; do not add ad-hoc role checks in routes.
