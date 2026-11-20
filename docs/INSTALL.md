# Installation and deployment

## Requirements

| Where | Needs |
| --- | --- |
| Server machine | Node.js **22.18+** |
| Every machine that runs employees | Node.js 22.18+, **tmux** (3.2+), **git**, **curl** |
| Interactive Claude Code workers | The **Claude Code CLI** logged in for the host account |
| Codex-managed workers | The **Codex CLI** and a local login. See [Codex workers](CODEX.md). |
| SDK-managed workers (optional) | additionally the Claude Agent SDK on that machine: `orchestrator-agent sdk install` |
| PostgreSQL storage (optional) | a PostgreSQL database for the server (tested with 17); the default is a local SQLite file |
| Building from source | pnpm 9+ |

The office UI runs in the bundled desktop app or any modern browser.

## 0. An office on a server (the usual setup)

The office runs on one always-on machine — ideally a Linux server — and everyone walks in with the desktop app. Sessions and folders on the server are shared by the people you invite; each person's own computer joins as *their* room while they are in.

**On the server** (Linux; needs Node.js 22.18+, tmux, git, curl, openssl and the Claude Code CLI logged in as the user that will run the office):

```sh
git clone <this repository> orchestrator && cd orchestrator
pnpm install && pnpm build          # server, agent and the office UI
pnpm serve -- --address https://office.example.com:4610
```

`pnpm serve` starts the server, a host agent for this machine (the shared one) and opens the door to members on port 4610 with TLS. `--address` is how people reach the server from outside (a DNS name or public IP, a VPN name, or leave it out on a LAN); invitation links start with it. Open that TCP port in the firewall. The office's own port (4600) stays on loopback.

Invite the first owner — yourself — from the same machine:

```sh
pnpm office invite Ana --role owner     # prints the invitation link once
pnpm office status                         # addresses, certificate fingerprint, members
```

Keep it running across reboots and logouts:

```sh
mkdir -p ~/.config/systemd/user
pnpm -s office service -- --address https://office.example.com:4610 > ~/.config/systemd/user/orchestrator.service
systemctl --user daemon-reload && systemctl --user enable --now orchestrator
loginctl enable-linger "$USER"
journalctl --user -u orchestrator -f
```

If the machine already runs an Orchestrator agent for another office (for example it is linked over SSH to an office on your own computer), give this office folders of its own before starting it and before generating the unit: `export ORCH_SERVER_HOME=~/.orchestrator-office/server ORCH_AGENT_HOME=~/.orchestrator-office/agent` (the unit generator writes them into the service).

A restart of the service does not stop anyone's work: employees' tmux sessions keep running and are picked up again. The door keeps its certificate, so invitations stay valid.

**On each person's computer:** install the desktop app, choose **Connect to an office**, paste the invitation link. The office is remembered on the start screen; tick **open at start** there and the app walks into it by itself from then on (Office → Switch office… brings the start screen back). A colleague or owner whose computer has tmux, Node.js and Claude Code also gets **Menu → My room**: folders on their own computer become employees that run there, under their own Claude account, visible in their room while they are connected (see [ACCESS.md](ACCESS.md)).

**Without an installer (from the repository):** on macOS or Linux with Node.js 22.18+ and pnpm:

```sh
git clone https://github.com/brstic/orchestrator && cd orchestrator
pnpm install && pnpm build
pnpm desktop            # opens the start screen: Connect to an office → paste the invitation link
```

For a room of your own (sessions on your computer) you also need tmux and the Claude Code CLI logged in. `node scripts/package.mjs` makes an installable app from the same checkout.

**More members:** any owner can invite from **Menu → People**, or on the server: `pnpm office invite <name> --role owner|colleague|visitor`, `pnpm office role <name> <role>`, `pnpm office reinvite <name>`, `pnpm office revoke <name>`.

Not tried yet on a real server with two people on two computers; it is covered by the automated suites on one machine (see `docs/STATUS.md`).

## 1. Local office (one machine)

```bash
git clone <this repository> orchestrator && cd orchestrator
pnpm install
pnpm build            # server + agent bundles, office UI
pnpm start --open     # starts server + local agent, opens the office
```

`pnpm start`:

- starts the server on `127.0.0.1:4600` (data in `~/.orchestrator/server`),
- enrolls and starts a host agent for this machine (state in `~/.orchestrator/agent`),
- prints the office URL with your owner token.

Options: `--port <n>`, `--open`, `--root <dir>` (repeatable; restricts the directories the agent may work in — default is your home directory).

Stopping it (`Ctrl-C`) stops the server and agent only. Employees' tmux sessions keep running and are picked up on the next start. To see them yourself: `tmux ls` (managed sessions are named `orch-<employee>-<id>`).

### Desktop app

```bash
pnpm desktop
```

This runs the Electron shell, which starts the same local backend and opens the office in a window. It needs a system `node` ≥ 22.18 on `PATH` (or `ORCH_NODE=/path/to/node`), because the server uses Node features newer than the Node embedded in Electron.

If Electron reports that it "failed to install correctly" (seen on very new Node versions, where Electron's own unzip step exits silently), run `pnpm electron:repair`; `pnpm desktop` does this automatically.

To open an office that runs elsewhere, use **Office → Connect to another office…** in the app's menu: enter the server address and the owner token. The address must be `https://` unless it is this computer (`http://localhost:…`); the token is kept in the app's data folder, encrypted by the operating system where that is available. **Office → Use the local office** goes back. (`ORCH_SERVER_URL=… ORCH_TOKEN=… pnpm desktop` does the same for one run.) If a local office cannot be started — no Node 22.18+, for instance — the app shows the connect screen with the reason instead of quitting.

### Packages

```bash
pnpm package          # → release/
pnpm package:smoke    # runs what was just built, in throwaway state directories
```

- `release/orchestrator-<version>.tar.gz` (about 1 MB, macOS and Linux): the bundled server, the bundled agent, the built UI and launchers. Unpack it anywhere on a machine with Node 22.18+, tmux, git and Claude Code, and run `bin/orchestrator --open`. `bin/orchestrator-server` and `bin/orchestrator-agent` are the two halves on their own.
- `release/Orchestrator.app` and `release/Orchestrator-<version>-<arch>.dmg` (macOS): the desktop app with the same files inside. It starts the server and this machine's agent itself and still needs a system Node 22.18+. It is **ad-hoc signed, not notarized**: on another Mac the first launch needs right-click → Open. To distribute it properly, install your "Developer ID Application" certificate and run `ORCH_SIGN_IDENTITY="Developer ID Application: … (TEAMID)" ORCH_NOTARY_PROFILE=<notarytool profile> pnpm package:notarize` (or `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` instead of the profile); `pnpm package:notarize --check` says what is still missing.
- `pnpm package:linux` additionally builds:
  - `release/orchestrator_<version>_all.deb` for Debian/Ubuntu: `sudo dpkg -i` it, then `orchestrator --open`, `orchestrator-server`, `orchestrator-agent` are on the PATH (files in `/opt/orchestrator`). It depends on tmux, git and curl; Node.js 22.18+ is only a recommendation because the distributions do not ship it yet — install it from nodejs.org or NodeSource.
  - `release/orchestrator-desktop-<version>-linux-{arm64,x64}.tar.gz`: the desktop app for Linux (Electron's official Linux build, checksum-verified, with the same files inside). Unpack and run `./orchestrator-desktop`; see the `README-LINUX.txt` inside for Chromium's sandbox requirement.
- `pnpm package:windows` builds `release/orchestrator-desktop-<version>-windows-{x64,arm64}.zip`: the desktop app for Windows as a client of an office in WSL2 or on another machine (it opens on the connect screen). **It has never been run** — it was assembled on macOS from Electron's official Windows build.

## 2. Adding machines

All machines appear in the same office; where a session runs does not change how you interact with it. Hosts dial **out** to the server — no inbound ports.

### The easy way: a server you can already ssh into

If the office runs on your own computer (the desktop app) and your Claude Code sessions run on a server, link the server over SSH — no port is opened on the server or on your computer, and no TLS certificate is needed.

**Machines → Add a machine → A server over SSH**, type the server as you would after `ssh` (`deploy@my-server.example.com`, a name from `~/.ssh/config`, optionally `:port`), **Check the server**, then **Connect**.

What happens:

1. *Check* runs one read-only script over SSH and shows what is there: operating system, Node.js, tmux, Claude Code, git, and how many Claude Code processes and tmux sessions are already running. Nothing is installed.
2. *Connect* copies the host agent (one file) to `~/.orchestrator/bin` on the server, opens a reverse SSH tunnel (`ssh -N -R 127.0.0.1:<port>:127.0.0.1:<office port>`), enrols the server with a single-use token and starts the agent there. The server then appears under Machines like any other.
3. The office keeps that `ssh` running and reopens it when the connection drops. While it is down (your computer asleep, no network) everything on the server keeps running in tmux; it reappears when the link is back.

The server needs Linux or macOS, Node.js 22.18+, tmux and curl, and Claude Code installed and logged in. Your computer needs key-based SSH access that works without typing a password (`ssh <server>` in a terminal must just work; an SSH agent or macOS keychain is fine). The office never asks for or stores passwords, and it does not accept an unknown server key unless you tick "I trust this server".

**Claude Code already running on the server** — on the server's card, **Bring in what is running there…** lists:

- *tmux panes*: attach one as an employee without restarting it. An attached session is terminal-only (watch it, take the keyboard). **Make a full employee** asks Claude Code there to `/exit` and starts it again under the office in the same folder with `claude --continue`, so it keeps its conversation and can now take tasks, ask you questions and report its work.
- *Claude Code outside tmux* (started in a plain terminal): these cannot be taken over. **Continue here as an employee** hires someone into that folder who continues the last conversation there; finish or exit the old one first.

*Folders the office may work in* defaults to your home folder on the server; add e.g. `/var/www` when linking if projects live elsewhere. **Disconnect** closes the tunnel and leaves everything running; **Remove** stops the agent, deletes `~/.orchestrator/links/<id>` on the server and revokes the machine.

The rest of this section is the manual way, for a server the office cannot ssh into or an office that is itself a server.

### On the server

The server must be reachable by the other machines over TLS. Either give it a certificate:

```bash
node apps/server/bin/orchestrator-server.mjs \
  --host 0.0.0.0 --port 4600 \
  --tls-cert /etc/ssl/office.crt --tls-key /etc/ssl/office.key \
  --public-url https://office.example.com:4600
```

or keep it on localhost behind a TLS-terminating reverse proxy (Caddy, nginx, a tunnel) and pass `--public-url https://office.example.com`. The server refuses to listen on a non-loopback address without TLS unless you pass `--allow-insecure-remote` (for the reverse-proxy case).

`--public-url` matters: it is the address workers use for the Orchestrator MCP endpoint.

When you run the server this way, start the local machine's agent yourself (`orchestrator-agent login …` + `connect`) instead of using `pnpm start`.

### On each additional machine

In the office: **Machines → Add a machine → Any machine, with a token → Create a token** makes a one-time enrollment token (valid for an hour, shown once, inside the command to run; *Options* changes how long it is valid and the address the machine is told). Then on the machine:

```bash
curl -fsSL https://office.example.com/install-agent.sh | sh     # installs ~/.orchestrator/bin/orchestrator-agent
orchestrator-agent login --server https://office.example.com --token <enrollment-token> --allow-root ~/projects
orchestrator-agent connect
```

The agent is a single JavaScript file (`apps/host-agent/dist/orchestrator-agent.mjs`, ~100 KB, no dependencies); copying that file by hand works just as well.

Keep it running as a user service:

```bash
orchestrator-agent service install
# macOS:  launchctl load ~/Library/LaunchAgents/dev.orchestrator.agent.plist
# Linux:  systemctl --user daemon-reload && systemctl --user enable --now orchestrator-agent
#         loginctl enable-linger $USER      # keep it running after logout
```

### Agent CLI

```text
orchestrator-agent login   --server <url> --token <enrollment-token> [--name <host>] [--allow-root <dir>]...
orchestrator-agent connect [--daemon] [--allow-root <dir>]...
orchestrator-agent status
orchestrator-agent sessions list
orchestrator-agent attach  --tmux-session <name> [--pane <%id>] [--employee <name>] [--role <role>]
orchestrator-agent create  --name <employee> --project <dir> [--role <role>] [--model <model>] [--autonomy <level>]
orchestrator-agent hooks install|uninstall --project <dir>
orchestrator-agent sdk status | sdk install [--version <v>]
orchestrator-agent service install|uninstall
orchestrator-agent stop | logout | version
```

`--autonomy` is `standard` (the default) or `auto`; Unrestricted is an owner's to give, in the office (the employee's profile).

- `attach` connects a tmux session that is **already running** (for example a Claude Code session you started by hand) to an employee. Nothing is restarted. Such a session is terminal-only — observe and take control — unless hooks are installed for its project.
- `hooks install --project <dir>` adds Orchestrator's hooks to `<dir>/.claude/settings.local.json` so Claude Code sessions started there (inside an attached tmux session) report real activity. `uninstall` removes exactly those entries.
- `create` makes an employee and starts a managed worker in `<dir>`.
- `sdk install` puts the Claude Agent SDK into the agent's own state directory with npm (nothing global, nothing in your projects) so this host can run **SDK-managed workers**; restart the agent afterwards. Without it the host offers interactive workers only, and an employee set to the SDK runtime falls back to an interactive worker with a visible notice. See [CLAUDE-CODE-INTEGRATION.md](CLAUDE-CODE-INTEGRATION.md#sdk-managed-workers) for how the two runtimes differ.

Agent settings live in `~/.orchestrator/agent/config.json`:

| Key | Meaning |
| --- | --- |
| `allowedRoots` | directories the agent will operate in; everything else is refused |
| `claudeBin` | path to the `claude` binary |
| `tmuxSocketName` | use a dedicated tmux server (`tmux -L <name>`) instead of your default one |
| `approvalWaitSeconds` | how long a permission/question hook waits for you before Claude Code shows its own prompt (default 1800) |
| `allowVerify` | allow the server to run project verification commands on this host |
| `allowHeadless` | allow headless `claude -p` runs for command interpretation |
| `remoteAttach` | which existing tmux sessions the office may attach by itself: `claude` (default, only panes running Claude Code), `any`, or `none` |
| `sdkPath` | where the Claude Agent SDK is, if not installed with `sdk install` (the package directory or its `sdk.mjs`) |
| `hookEvents` | override the hook events to install (default: detected from the CLI version) |

### Coming in without an invitation
If the office has an address with a trusted certificate (a domain behind a reverse proxy, as in `OPERATIONS.md`), nobody needs to be sent anything: they type the address into the desktop app's start screen with their name and wait; whoever is in the office lets them in and chooses as what. In a browser the same address shows a page to ask for a read-only visit.

### Inviting people into an office that runs on your own computer

The same members and roles work for a local office: **Menu → Access → Open**, save the address people come to, invite with a role (*visitor*, *colleague*, *owner*), send the link. For people on the same network the address is this computer's own (the window offers it); for someone elsewhere save an address they can reach (a VPN name such as a Tailscale address, or a forwarded port). The office is only there while your app is open — for something that stays up, use a server (section 0).

## 3. Linux and Windows

**Linux** hosts are supported and tested: the bundled agent was run on Debian 12 (tmux 3.3a) and Ubuntu 24.04 (tmux 3.4) in containers against a server over TLS (`pnpm test:linux`, `pnpm test:machines`). Use the tarball or the `install-agent.sh` one-liner above. The office runs in a browser or in the Linux desktop bundle (`pnpm package:linux`), which was run on Ubuntu 24.04.

**Windows, as a member of an office on a server:** run the desktop app on Windows itself (from the repository: `pnpm install`, `pnpm build`, `pnpm desktop`) and paste the invitation. For a room of your own, install WSL2 (`wsl --install`, Ubuntu) and, inside it, Node.js 22.18+, tmux and the Claude Code CLI, logged in — the app starts your computer's host there by itself and stops it when you close the office. Employees can be put into your WSL home, your Windows profile folder and the folders you name in the environment variable `ORCH_PERSONAL_ROOTS` before starting the app (`D:\Work;E:\code`). Tried on Windows 11 with Ubuntu 24.04 in WSL2, up to the computer being online in a test office; see `STATUS.md` for what was not.

**Windows, an office of your own**: run everything inside **WSL2** (Ubuntu) — install Node 22+, tmux, git and Claude Code in the distribution and follow the Linux steps. The office UI can run in a Windows browser against the server in WSL (`http://localhost:4600`), or in the Windows desktop bundle (`pnpm package:windows`), whose connect screen takes that address and the owner token. Native Windows is not supported: Claude Code workers need tmux. Ubuntu 24.04 — the default WSL2 distribution — is tested as a container; WSL2 on an actual Windows machine was not.

When several machines share one office, `--public-url` must be an address that **every** machine can reach, including the server's own machine: its workers use it too.

## PostgreSQL instead of SQLite

```bash
orchestrator-server --database postgres://user:password@db.example/orchestrator     # or ORCH_DATABASE_URL
```

The server creates its tables on first start. One server per database (it holds an advisory lock and refuses to start if another server has it). The owner token and TLS files still live in the data directory. There is no migration tool between SQLite and PostgreSQL: choose when you set the office up.

## 4. Upgrading, backup, reset

- **Data**: `~/.orchestrator/server/orchestrator.db` (+ `-wal`, `-shm`). Copy it while the server is stopped to back up. Schema migrations run on start. With PostgreSQL, back the database up with `pg_dump`.
- **Owner token**: `~/.orchestrator/server/owner-token`. Delete it and restart to rotate.
- **Reset the office**: stop the server, remove `~/.orchestrator/server`. Hosts must enroll again (the local one does so automatically with `pnpm start`).
- **Remove a machine**: Machines → click the machine's line → Revoke…. Its credential stops working immediately. (*Remove…* then deletes it from the list; a server linked over SSH has *Remove the link…*, which does both and cleans up on the server.)

## 5. Development

```bash
pnpm server            # server from source (Node runs the TypeScript directly)
pnpm agent connect     # agent from source
pnpm dev:ui            # Vite dev server on :5173, proxying to the server on :4600
pnpm dev:office        # a populated office whose workers are the scripted test fixture (UI work without tokens)
pnpm typecheck && pnpm test && pnpm test:e2e
pnpm test:ui           # the built UI clicked through in Electron against the development office
pnpm test:real         # acceptance run against the real Claude Code CLI
pnpm test:real:sdk     # an SDK-managed worker with the real Agent SDK (ORCH_SDK_PATH or `sdk install`)
```

Environment: `ORCH_SERVER_HOME`, `ORCH_AGENT_HOME`, `ORCH_PORT`, `ORCH_HOST`, `ORCH_PUBLIC_URL`, `ORCH_DEBUG_HTTP=1` (request trace without credentials), `ORCH_START_WAIT_SEC` (how long `pnpm start` / `pnpm serve` waits for the server to come up before it gives up and stops it; default 120).
