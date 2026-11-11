# Picking up the work

For a collaborator who continues where someone else stopped. It says what you need, how a change gets from your editor into the running office, and where the rest is written down. Everything here was true on 2026-11-11; `STATUS.md` is the page that is kept current.

## 1. What there is

- **One office, on one server.** The office everybody uses runs on the owner's server ("Sparkcan") as a systemd service. People open it with the desktop app; the page the app shows is served by the server. So **most changes go live by updating the server only**.
- **The code** is `https://github.com/brstic/orchestrator` (private), branch `main`. There are no other long-lived branches; work is committed to `main` and pushed.
- **The documents** in `docs/` describe what the code does now. Start with [`STATUS.md`](STATUS.md) (what is live, what is built but not live, what was never checked), then [`OPERATIONS.md`](OPERATIONS.md) (the server, the domain, every command) and [`DEVELOPMENT.md`](DEVELOPMENT.md) (build, test, rules).

## 2. What you need

| | How you get it |
| --- | --- |
| The repository | You are a collaborator on GitHub. `git clone https://github.com/brstic/orchestrator` |
| Node.js 22.18 or newer, pnpm | Node runs the TypeScript sources directly; older versions do not. `corepack enable` gives pnpm |
| tmux, git, openssl | The tests start real tmux sessions and make a real certificate. macOS: `brew install tmux` |
| A place in the office | An invitation link from an owner (**Access → Invite**), pasted into the app under *Connect to an office*. This is separate from the next line: being an owner of the office does not give you a shell on the server |
| **SSH to the server** — only needed to deploy | Your public key in `~/.ssh/authorized_keys` of the user `sparkcan` on the server. The owner adds it (`ssh-copy-id -p <ssh-port> <user>@<address>` from a machine that already has access, or by pasting the key). Check: `ssh -p <ssh-port> <user>@<server> true` |
| A network path to the server's SSH | The server's SSH port is in the private notes. `<server-lan-ip>` works on the owner's LAN; from elsewhere use the Tailscale address `<server-vpn-ip>` (you have to be in the owner's tailnet). The public domain `office.sparkcan.com` is for the office itself (port 443), not for SSH |
| Claude Code on your computer | Only for your own room in the office (sessions that run on your computer), and if you work on this code with it |

Nothing secret is in the repository. The office's own owner token, the door's certificate and the database are on the server in `~/.orchestrator-office/server/`.

## 3. Your computer, once

```sh
git clone https://github.com/brstic/orchestrator && cd orchestrator
pnpm install
pnpm build                 # the office page and the bundled server and agent
pnpm typecheck && pnpm test   # should be clean before you change anything
pnpm desktop               # the desktop app from source: Connect to an office → paste your invitation link
```

`pnpm desktop` is enough to use the office. A packaged app (`node scripts/package.mjs`, macOS on Apple Silicon) is only a convenience; the Windows and Linux bundles are stale and untested.

Your computer gets a room in the office when the app can run sessions on it: it needs macOS or Linux, tmux and Node.js 22.18+ — or, on Windows, WSL2 with those inside it (the app itself runs on Windows; see INSTALL.md, "Linux and Windows"). If the room does not appear, **Menu → My room** says why in one line.

## 4. From a change to the running office

```
read STATUS.md → change → tests → docs → commit → push → deploy → look → write down what you saw
```

1. **Read** `docs/STATUS.md` and, for the area you touch, the document that covers it (`docs/README.md` is the map).
2. **Change** the code. Product text is English. Every permission decision goes through `apps/server/src/access.ts`.
3. **Test.** Nothing here spends Claude usage; the workers are scripted (`tests/fixtures/fake-claude.mjs`).
   ```sh
   pnpm typecheck && pnpm --filter @orchestrator/desktop typecheck
   pnpm test                      # unit, ~15 s
   pnpm test:e2e                  # real server, real agent, real tmux, scripted workers, ~5 min
   pnpm build:ui && node scripts/build.mjs && node tests/ui/run.mjs --out /tmp/ui-run    # the UI in Electron, real clicks, ~4 min; screenshots land in --out
   node tests/ui/guest-app.mjs    # only when the app's start screen, joining or one's own room changed
   ```
   Do not run the UI suite and a packaging run at the same time: both use `apps/desktop/dist`.
4. **Docs, in the same piece of work**: a line in `docs/CHANGELOG.md`, the truth in `docs/STATUS.md` (including what you did *not* check), `docs/DECISIONS.md` when you chose something a later reader would have to guess, and the subject's own document.
5. **Commit and push** to `main`. If someone pushed meanwhile: `git pull` (merge, do not force-push).
6. **Deploy** — next section.
7. **Look** at the result in the office, and say in `STATUS.md` what is live.

## 5. Deploying

### The server (almost every change)

From your checkout, at the commit you want live:

```sh
pnpm deploy:server
# from outside the owner's LAN:
ORCH_DEPLOY_HOST=<user>@<server-vpn-ip> pnpm deploy:server
```

What the script (`scripts/deploy-server.sh`) does, in order:

1. builds the portable package on **your** computer (`node scripts/package.mjs --no-app` → `release/orchestrator-<version>.tar.gz`) — the server never runs `git` or `pnpm`;
2. copies it to the server with `scp`;
3. unpacks it to `~/orchestrator-office/app.new`, writes the commit and the time into `app.new/BUILD`;
4. moves the running `app` to `app.old`, puts `app.new` in its place;
5. restarts the service (`systemctl --user restart orchestrator-office`) and prints the status: which build, open or closed, the members.

It deploys **your working tree as it is**: if there are uncommitted changes, `BUILD` says `+uncommitted`. Commit and push first, so that what runs is something everybody can check out.

What people in the office notice: it is unreachable for a few seconds; their apps reconnect by themselves; shared Claude Code sessions keep running in tmux and are picked up again. **A new UI appears for them after they reload the window (Cmd/Ctrl+R).**

```sh
sh scripts/deploy-server.sh --status      # what is running: build, door, members
sh scripts/deploy-server.sh --rollback    # the previous build back (app.old), and a restart
ssh -p <ssh-port> <user>@<server> 'journalctl --user -u orchestrator-office -n 80 --no-pager'   # the log
curl -s https://office.sparkcan.com/healthz                                                      # through the domain
```

There is one `app.old`: a rollback goes back one deploy, not two. The office's state (`~/.orchestrator-office`) is not part of a deploy and is not rolled back; back it up before a change that rewrites stored records (`OPERATIONS.md`, "Backup and restore").

Deploying has only ever been done from the owner's Mac. The script is plain `sh`, `ssh`, `scp` and `tar`, so another Mac or a Linux machine should do — that has not been tried.

### The desktop app (rarely)

Only when something under `apps/desktop/electron/` or `apps/host-agent/` changed — the start screen, joining, the relay and agent for one's own room, the TV. **Everybody updates their own**: there is no auto-update.

```sh
git pull && pnpm install && pnpm build
pnpm desktop                      # from source
# or a packaged app (macOS, Apple Silicon); the app must be closed while this runs:
node scripts/package.mjs && node scripts/smoke-package.mjs
```

Say in `STATUS.md` and to the people concerned when a change needs a new app. The last such change: invitation links (2026-11-11, `326f677`) — an app built before it does not understand a link.

### Order when both changed
Server first, then the apps. An older app can still open the office.

## 6. What must not be touched

These protect an office people are working in. They are also in `DEVELOPMENT.md` and `CLAUDE.md`.

- On the server: nothing in `~/.orchestrator-office` by hand, and nothing that is not ours (the server runs other things). Never kill the tmux server or an `orch-*` session: those are employees at work. No `pkill` / `killall`; stop only what you started, by pid.
- The reverse proxy points at the door (port 4610), never at the office's own port (4600). The office's own owner token must never be usable from the network.
- No permission-bypass flags for workers, ever (`--dangerously-skip-permissions` and the like). No unauthenticated access to a terminal.
- The real `claude` CLI and `tests/real/*` spend a real subscription: run them only when the owner asks.
- Never package over a desktop app that is running, and never script its quit (it asks the person first).
- Nothing mocked is presented as a feature. If something was not verified, the document says so.

## 7. Working on this code with Claude Code

`CLAUDE.md` in the repository root is read by Claude Code at the start of a session: what to read first, the standing rule about documents, the hard rules above. That is all the context that travels with the repository — a previous person's Claude Code memory and conversation history stay on their computer. So anything the next person needs has to be in `docs/`: when you (or Claude) learn something that is not obvious from the code, write it into `STATUS.md` or `DECISIONS.md` before you stop.

A session that works well here: ask for the change in plain words, let it run the suites that apply, look at the screenshots of the UI suite for anything visible, and have it update the documents and tell you what it did not check.

## 8. Where things stood on 2026-11-11

Read `STATUS.md` for the current version of this list.

- **Live on the server** (build `326f677`): everything up to and including the Access window and invitation links.
- **Built, not live**: see "Built but not on the server yet" in `STATUS.md` (at the time of writing: deleting a project).
- **Built but never watched working with real Claude Code**: Growth (the office improving itself), routines, sessions that sleep and wake, an employee waiting for a colleague. They pass with scripted workers only.
- **Never checked**: the Windows and Linux desktop bundles; the Linux server trial (`pnpm test:central`) and the TV test since the foreman rework.
- **Waiting for the owner's word**: how the people look (head and eye size are single constants in `packages/office-3d/src/character/`); whether a waited request should start a colleague the owner stopped; whether a wait should end on the answer or on the finished task; walking pace; who may let people in at the door.
- **Ideas, not plans**: `docs/plans/IDEAS-from-t3code.md`, `docs/plans/IDEAS-memory-from-mempalace.md`.
