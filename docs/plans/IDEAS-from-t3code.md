# Ideas — what to take from T3 Code

_Written 2026-11-10 from a conversation with a co-owner. **Ideas only: nothing here is decided or built.** When one is picked up, it becomes a plan of its own and a line in `DECISIONS.md`._

**Source:** `github.com/pingdotgg/t3code` at commit `17a6a01d` (MIT, so logic may be reused with attribution). It was read, not run; where a point rests on their documentation rather than their code, it says so. A local copy is in `/srv/marko/t3code` on Sparkcan.

**What it is:** a control surface for coding agents on one's own machines — server, desktop, web and mobile clients. It is single-owner: no roles, no shared/personal split, no office. It has solved what we have not: installation, Windows, updates.

Only the items that fit Orchestrator as it is are listed. Each names the gap in `STATUS.md` or `INSTALL.md` it closes.

## 1. Installation and updates (our largest gap)

| Idea | What they do | What it gives us |
| --- | --- | --- |
| **Run the server on Electron's own Node** | The desktop app starts the server as a child of the Electron binary with `ELECTRON_RUN_AS_NODE=1` (`apps/desktop/src/backend/DesktopBackendConfiguration.ts:524-536`) | No system Node 22.18+ on a member's computer. We are on Electron 33, they are on 44; which Electron release carries a Node new enough for us has to be checked first |
| **electron-builder + electron-updater** | dmg/zip, NSIS, AppImage/deb from one config; notarisation; auto-update from GitHub Releases; stable and nightly channels | Real installers and auto-update, replacing `scripts/package.mjs` for the desktop app. Their build script is tied to their toolchain — take the configuration, not the code |
| **`curl \| sh` installer** | `scripts/install.sh`: plain POSIX sh, downloads a release archive, checks sha256, installs under the home folder, never edits shell rc files | A one-line server install. The script is self-contained and could be adapted almost as it is |
| **`service install` command** | Writes the systemd user unit (with linger) or the launchd agent itself (`apps/server/src/cloud/bootService.ts:100-160`) | Replaces the manual unit step in `INSTALL.md` section 0. We already have `pnpm office service`; this makes it one command that also enables it |
| **Protocol version handshake** | Client and server compare one integer on connect and refuse or offer an update on mismatch (`packages/client-runtime/src/connection/compatibility.ts:11-30`) | Needed as soon as clients update on their own schedule. About 30 lines |
| **Smoke test of the packaged app before release** | The packaged app is started against an old seeded database; a Windows artifact is checked on a real Windows host | Our Windows bundle has never been run |

## 2. Accounts and access

| Idea | What they do | What it gives us |
| --- | --- | --- |
| **One Claude login per person through `CLAUDE_CONFIG_DIR`** | A "provider instance" per account, each with its own config folder; `HOME` is left alone so the macOS keychain still works (`apps/server/src/provider/Drivers/ClaudeHome.ts:26-44`) | Shared employees on the server could run under the Claude account of whoever hired them, instead of one account used by everybody. Usage reporting already keys accounts by machine + config folder |
| **Scopes under the roles** | A session carries a list of scopes; every RPC declares the one it needs (`apps/server/src/auth/RpcAuthorization.ts:40`) | A finer layer under visitor / colleague / owner in `access.ts`, e.g. a colleague without terminal input |
| **Short-lived WebSocket tickets** | A ticket minted over authenticated HTTPS opens the socket; the long-lived token never appears in a handshake | Removes the reason for `access_log off` in the nginx vhost (`OPERATIONS.md`, "The domain") |

## 3. Working with agents

| Idea | What they do | What it gives us |
| --- | --- | --- |
| **A typed reply to a pending approval means "no, and here is why"** | Text sent while an approval is pending declines it and passes the text on as feedback (their docs) | One natural gesture instead of refuse-then-explain |
| **Handoff as a budgeted summary plus a tool to read the rest** | A new session gets a size-limited selection of the previous conversation and can fetch what was left out (their docs) | A replacement session for an employee starts informed. Ties in with [IDEAS-memory-from-mempalace.md](IDEAS-memory-from-mempalace.md) |

## 4. Development process

| Idea | What they do | What it gives us |
| --- | --- | --- |
| **"Hit every surface" checklist; a bug fix starts with a failing test** ✅ _taken 2026-11-11_ | A checklist in their `AGENTS.md` that must be walked and reported for each change | Added to `CLAUDE.md` ("Checking a change"): roles, shared vs personal, local vs server office, desktop vs browser, both runtimes, and a bug fix starts with a failing test |
| **`check:changed`** ✅ _taken 2026-11-11_ | Lint, typecheck and only the tests beside what changed (`scripts/check-changed.ts`) | Faster loop than running every suite. Built as `scripts/check-changed.mjs` (`pnpm check:changed`), written for our layout; no lint step (no linter here). See `DECISIONS.md`. |
| **Isolation per worktree** | Ports derived from the worktree path, state in the worktree, seeded test data (`scripts/dev-runner.ts:256-263`) | Several agents can work on Orchestrator at once on one machine without colliding |

## Considered and left out

- **Driving Claude through the Agent SDK as the main runtime.** It is why they run natively on Windows. For us the interactive `claude` in tmux stays primary: a person signing in to the unmodified Claude Code with their own subscription is what Anthropic's terms explicitly allow, while products built on the Agent SDK are pointed at API keys (`code.claude.com/docs/en/legal-and-compliance`, read 2026-11-10). Windows goes through WSL; our SDK-managed runtime stays an option for API-key users.
- **Their server design** (event sourcing on Effect): deeply tied to their stack.
- **Their relay** (Cloudflare tunnel, hosted sign-in): puts a third party in the path; our door is direct.
- **Mobile push notifications**: attractive, but needs a relay service of our own.
- **"Do not commit plans or notes"**: the opposite of our standing rule that the docs follow every change.

## A sensible order

1. Electron's own Node, then electron-builder with auto-update.
2. `install.sh` and `service install` for the server; the protocol version handshake with them.
3. A Claude login per person.
4. Scopes and WebSocket tickets.
