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
| `pnpm typecheck` and `pnpm --filter @orchestrator/desktop typecheck` | both must be clean (the second covers `App.tsx` and panels) |
| `pnpm test` | unit |
| `pnpm test:e2e` | end to end with `tests/fixtures/fake-claude.mjs` (no tokens) |
| `pnpm build:ui` then `node tests/ui/run.mjs` | UI suite in Electron against a dev office |
| `node tests/ui/guest-app.mjs`, `node tests/ui/tv-app.mjs` | desktop join flow, TV |
| `pnpm test:ssh`, `pnpm test:machines` | containers; need Docker/Colima |
| `pnpm test:central` | the office on a Linux container from the portable package (`pnpm package` first), two desktop apps from this machine; starts the real `claude` on the member's side without sending anything (`--no-real-cli` to avoid) |
| `node scripts/dev-office.ts --port N [--ui <dist>]` | a populated office with scripted workers for manual work and probes |

## Shipping
The owner's Mac runs `release/Orchestrator.app` as a client of the office on the server ("Sparkcan"); there is no local office any more.

**The desktop app (client):**
1. All suites green.
2. The app must not be running (`pgrep -f release/Orchestrator.app/Contents/MacOS`). Ask it to quit (`osascript -e 'quit app id "local.orchestrator.desktop"'`); it asks the person to confirm, so it may stay open. Never force it: build next to it with `node scripts/package.mjs --out release-next` and swap when it is closed.
3. `node scripts/package.mjs` → `node scripts/smoke-package.mjs` (15/15).
4. `open release/Orchestrator.app` — it walks into the server office by itself.
5. Check on the server that the owner and their computer are in (`/api/people`, hosts).

**The office on the server:** `node scripts/package.mjs --no-app`, copy `release/orchestrator-<version>.tar.gz` to the server, unpack over `~/orchestrator-office/app`, `systemctl --user restart orchestrator-office` (employees' tmux sessions survive; invitations stay valid). Details and addresses: `STATUS.md`.

Then update `docs/STATUS.md` and `docs/CHANGELOG.md`.

## Rules that protect the live office
- Do not touch `~/.orchestrator` (the Mac's personal host lives in `~/.orchestrator/offices/`), `~/.orchestrator-office` on the server, the default tmux servers or `orch-*` sessions on either machine. Tests make their own tmux sockets and temp dirs.
- No `pkill` / `killall`. Stop only processes you started, by pid.
- The real `claude` CLI spends the owner's subscription. Use the scripted worker; zero-token probes of the real CLI (start it, send no prompt) are fine.
- A UI test run and a packaging run both use `apps/desktop/dist`; do not run them at the same time, and do not start a UI run while the app is starting.

## Measuring instead of guessing
- **Flicker:** compare composited frames (`webContents.capturePage()` in a loop, count pixels that change and change back). Reading the WebGL canvas mid-frame produces false differences.
- **Stutter:** frame-interval evenness matters more than fps. `window.__orchPace` (`every`, `fps`), `window.__orchPerf`.
- **Cost:** `Profiler` over the DevTools protocol on an unminified build (`vite build --minify false --outDir …`, served with `dev-office.ts --ui`).
- `window.__orchScene.three` exposes `{gl, scene, camera, THREE}`; `window.__office` is the store; `window.__orchPlayer.goto = {x,z,rot}` places the owner.

## Conventions
- Comments say why, in plain words. No narration of the change itself.
- New owner-visible behaviour that is automatic (camera, overlays, effects) ships switched off behind a setting.
- Every permission decision goes through `apps/server/src/access.ts`; do not add ad-hoc role checks in routes.
