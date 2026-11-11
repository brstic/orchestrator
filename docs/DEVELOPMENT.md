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
| `pnpm test:ssh`, `pnpm test:machines` | containers; need Docker/Colima |
| `pnpm test:central` | the office on a Linux container from the portable package (`pnpm package` first), two desktop apps from this machine; starts the real `claude` on the member's side without sending anything (`--no-real-cli` to avoid) |
| `node scripts/dev-office.ts --port N [--ui <dist>]` | a populated office with scripted workers for manual work and probes |

## Shipping
See [OPERATIONS.md](OPERATIONS.md): `pnpm deploy:server` for the office on the server (most changes), and the packaging steps for the desktop app (only when `apps/desktop/electron/` or the bundled agent changed). Never replace a desktop app that is running, and never script its quit — it asks the person first. After shipping, update `STATUS.md` and `CHANGELOG.md`.

## Rules that protect the live office
- Do not touch `~/.orchestrator` (the Mac's personal host lives in `~/.orchestrator/offices/`), `~/.orchestrator-office` on the server, the default tmux servers or `orch-*` sessions on either machine. Tests make their own tmux sockets and temp dirs.
- No `pkill` / `killall`. Stop only processes you started, by pid.
- The real `claude` CLI spends the owner's subscription. Use the scripted worker; zero-token probes of the real CLI (start it, send no prompt) are fine.
- A UI test run and a packaging run both use `apps/desktop/dist`; do not run them at the same time, and do not start a UI run while the app is starting.

## Measuring instead of guessing
- **Flicker:** compare composited frames (`webContents.capturePage()` in a loop, count pixels that change and change back). Reading the WebGL canvas mid-frame produces false differences. Hide the people and the overlays first when the question is about things that stand still (people move on purpose, and a name tag that shifts by a pixel counts as hundreds), let the scene settle for a second after hiding, and compare against the previous build served by `dev-office.ts --ui <its dist>`: a thin line that sweeps across the screen while walking also "changes and changes back", in any build.
- **Looking at a model:** `window.__orchScene.cam = { pos: [x,y,z], look: [x,y,z], fov? }` holds the camera there until the property is deleted (any camera mode; First person for full-height walls and the ceiling). `window.__orchScene.positions` is the map of where everyone is. Earned decorations can be previewed by marking the milestones reached in the store (`window.__office.setState`).
- **Looking at people:** `<electron> scripts/character-sheet.cjs <url-with-token> <out-dir> [sets]` against a running office (a development office will do; the Electron binary is `apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`). It stands figures on the open floor and captures every hair style with every accessory from four sides (`hair`), every outfit on three skin tones (`outfits`), collars and shoulders (`busts`), faces (`faces`), the poses (`poses`) and the same people at the overhead camera's size (`small`); `flicker` prints a count instead (each view once empty, once with people, once with them held still) and saves the first frame with the flickering pixels marked. It works through `window.__orchScene.lineup = [{ appearance, pose?, level?, x, z, rot?, offline?, whip?, still? }]`, which a capture of your own can set too; real people are found through `window.__orchScene.positions`. Take the same set before and after a change and look at both.
- **The README's pictures** (`docs/assets/`): `node scripts/dev-office.ts --port 4755 --ui apps/desktop/dist` prints the office's address; `<electron> scripts/readme-shots.cjs <that address> <dir>` takes the fixed-camera pictures; copy `whip.png` and `panel-tasks.png` from a run of the UI suite into the same folder; `<electron> scripts/readme-art.cjs <dir>` then draws the banner and the framed pictures listed in `docs/assets/readme-art.json` (title, caption, sticker, colours). `README_SHEET=1` makes one page of everything in the folder instead, for choosing. The pictures are of a development office with scripted workers, and the README says so. Stop the development office afterwards (its pid is in what it printed).
- **Sizes of models:** `node --test packages/office-3d/test/models.test.ts` — footprint, seat and desk heights, triangle budgets. It runs without a browser; surfaces are then plain.
- **Stutter:** frame-interval evenness matters more than fps. `window.__orchPace` (`every`, `fps`), `window.__orchPerf`.
- **Cost:** `Profiler` over the DevTools protocol on an unminified build (`vite build --minify false --outDir …`, served with `dev-office.ts --ui`).
- `window.__orchScene.three` exposes `{gl, scene, camera, THREE}`; `window.__office` is the store; `window.__orchPlayer.goto = {x,z,rot}` places the owner.

- **Clocks in tests:** what the office does by the clock has its interval in `Timings` (`packages/orchestration/src/core.ts`), so a test can run it fast: `routineTickMs` and `routineMinuteMs` (how long "a minute" of a routine is), `sleepTickMs` and `sleepIdleMs` (overrides the owner's "asleep after … minutes"), `wakeRetryMs`. `tests/e2e/16-routines-sleep.test.ts` runs a five-minute routine every second and a half and puts a session to sleep after two seconds.

## Conventions
- Comments say why, in plain words. No narration of the change itself.
- New owner-visible behaviour that is automatic (camera, overlays, effects) ships switched off behind a setting.
- Every permission decision goes through `apps/server/src/access.ts`; do not add ad-hoc role checks in routes.
