# Operations: where everything runs and how to update it

> **The repository is public (since 2026-11-15).** Real addresses, the SSH port and user, and the CloudPanel site users are replaced here with `<server>`, `<server-lan-ip>`, `<server-vpn-ip>`, `<server-public-ip>`, `<ssh-port>`, `<user>`, `<site-user>`. They are kept out of git: in `scripts/deploy.local.env` (what `pnpm deploy:server` reads) and in `docs/private/` on the owner's machine.

The practical page. Why things are built this way is in `ARCHITECTURE.md` and `DECISIONS.md`; who may do what is in `ACCESS.md`. No secrets are written here — only where they live.

## The picture

```
 each person's computer                         the server ("Sparkcan")
 ┌────────────────────────────────┐            ┌──────────────────────────────────────────┐
 │ Orchestrator desktop app       │  TLS 4610  │ orchestrator-office.service (systemd)     │
 │  · the office window ──────────┼───────────▶│  · server         127.0.0.1:4600          │
 │  · relay + host agent          │            │  · door           0.0.0.0:4610 (TLS)      │
 │    (their own room: sessions   │            │  · host agent     the shared machine      │
 │     on their computer)         │            │  tmux: shared Claude Code sessions        │
 │  tmux: their own sessions      │            │  SQLite: the office's whole state         │
 └────────────────────────────────┘            └──────────────────────────────────────────┘
```

There is one office and it lives on the server. Desktop apps are clients; the page they show is served by the server, so **most updates only need the server**.

## Where things are

### The server
| | |
| --- | --- |
| Machine | "Sparkcan", Ubuntu 22.04, the server's user |
| Reach it | `ssh -p <ssh-port> <user>@<server>` (LAN) — or the Tailscale address `<server-vpn-ip>` |
| Program | `~/orchestrator-office/app` (the portable package). Previous version: `~/orchestrator-office/app.old`. `app/BUILD` says which commit is running |
| State | `~/.orchestrator-office/server` (database `orchestrator.db`, door certificate, the office's own owner token) and `~/.orchestrator-office/agent` (the shared host agent) |
| Service | systemd user unit `orchestrator-office` (`~/.config/systemd/user/orchestrator-office.service`), lingering enabled so it survives logout and reboot |
| Node.js | `~/.nvm/versions/node/v22.23.4/bin/node` (the system's `node` is too old) |
| Ports | 4600 on loopback (the office itself), **4610/tcp open in ufw** (the door, TLS) |
| Members reach it at | **`https://office.sparkcan.com`** (through Cloudflare and the server's nginx — see "The domain" below) · `https://<server-vpn-ip>:4610` (Tailscale) · `https://<server-lan-ip>:4610` (LAN). Invitation links start with the first (it is the address saved in **Access**); once someone is in, their app keeps all three and uses the first that answers |
| Claude Code | `/usr/local/bin/claude`, logged in as `sparkcan`: this is the account shared employees use |
| Shared sessions | the default tmux server of the server's user, sessions named `orch-<employee>-<id>` |
| Not ours | `~/.orchestrator-mac-link-backup-2026-11-10` — the agent of the old Mac office, stopped and set aside. Safe to delete |

### The domain
`office.sparkcan.com` → DNS record in Cloudflare (`office`, A, **DNS only** — not proxied; it pointed at `<server-public-ip>` when made and at `<server-public-ip>` — the server's public address — on 2026-11-14) → the server's public address, port 443 → nginx (CloudPanel site `office.sparkcan.com`, type *reverse proxy*) → `https://127.0.0.1:4610`, the office's door.

- **Certificate:** Let's Encrypt, installed and renewed by CloudPanel (`sudo clpctl lets-encrypt:install:certificate --domainName=office.sparkcan.com` to do it by hand). The desktop app trusts an office when its certificate is the one named in the invitation (addresses with a port: the door's own certificate) **or** one the system trusts for that name (the domain) — so renewals need nothing. If the DNS record is ever switched to proxied, Cloudflare's certificate is trusted the same way.
- **The proxy must point at the door (4610), never at the office's own port (4600):** the door is what marks a request as coming from outside, and only that keeps the office's own owner token from being usable over the network. Checked after setup: the owner token gets 401 through the domain.
- **CloudPanel:** site user `<site-user>`; its password is in `(a file on the server, see the private notes)` on the server (mode 600). Vhost: `/etc/nginx/sites-enabled/office.sparkcan.com.conf`; WebSocket headers and 900 s timeouts come from CloudPanel's reverse-proxy template. One line was added by hand in `location @reverse_proxy`: `access_log off;` (older clients carry their token in the WebSocket address; current ones send it as a subprotocol). A copy of the original is in `/root/office.sparkcan.com.conf.bak-2026-11-10`. **If the vhost is saved from the CloudPanel UI, check that this line is still there.**
- Verified 2026-11-10 from the owner's Mac: the desktop app joins over the domain (API, WebSocket, and the relay for the Mac's own room all go to `<server-public-ip>:443`).
- **People without an invitation** open `https://office.sparkcan.com` in a browser (they can ask to look around) or type `office.sparkcan.com` into the desktop app's start screen (they can be let in as visitor, colleague or owner). Whoever is inside answers from the card at the top right of the office window.
- The office limits knocks per caller address, which it takes from the last entry of `X-Forwarded-For` as set by this nginx (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` in CloudPanel's template). If that line is ever removed, every caller looks like `127.0.0.1` and shares one limit.
- Invitations made before 2026-11-11 (one long text) keep working until they are replaced; `reinvite` or **Access → New link** gives a short link instead.

### A person's computer (client)
| | |
| --- | --- |
| App | built from this repository. On the owner's Mac: `release/Orchestrator.app` in the checkout (`~/Projects/office`), with `~/Desktop/Orchestrator.app` linking to it |
| App data | macOS: `~/Library/Application Support/Orchestrator/` — `joined.json` (saved offices and invitations, mode 600), `prefs.json` (graphics, keys, extras for this computer) |
| Their own room | `~/.orchestrator/offices/<id>/agent` — the host agent for their own sessions in that office (one folder per office). Their sessions: their default tmux server, `orch-*` |
| Old local office (owner's Mac) | `~/.orchestrator-local-office-backup-2026-11-10/` — set aside, not used. Safe to delete |

### The code
`https://github.com/brstic/orchestrator` (private), branch `main`. Collaborators: `brstic`, `fenixf4`, `nikolajanko`. The owner's Mac pushes over HTTPS through `gh` (its SSH key is a deploy key for another repository).

## Updating

### 1. The server (the usual update)
(New here? [`HANDOVER.md`](HANDOVER.md) walks through the whole loop, including what you need before the first deploy.)

From a checkout with the change, on a machine that can ssh to the server (your public key in `~/.ssh/authorized_keys` of the server's user; from outside the LAN: `ORCH_DEPLOY_HOST=<user>@<server-vpn-ip>`):

```sh
pnpm typecheck && pnpm test && pnpm test:e2e     # at least these; UI changes: pnpm build:ui && node tests/ui/run.mjs
pnpm deploy:server                               # = sh scripts/deploy-server.sh
```

What it does: builds the portable package **on your computer, from your working tree as it is** (`scripts/package.mjs --no-app`; the server never runs `git` or `pnpm`, so commit and push first — `app/BUILD` says `+uncommitted` otherwise), copies it over, unpacks it to `app.new`, moves the running `app` to `app.old`, swaps, restarts the service, and prints the status. It takes about half a minute.

What happens to people: the office is unreachable for a few seconds. Shared Claude Code sessions keep running in tmux and are picked up again. Members' apps reconnect by themselves; their invitations and the door's certificate do not change. **To get a new UI they reload the window: View → Reload (Cmd/Ctrl+R).**

```sh
sh scripts/deploy-server.sh --status      # is it active, which build, who is a member
sh scripts/deploy-server.sh --rollback    # put app.old back and restart
```

Another server: `ORCH_DEPLOY_HOST=user@host ORCH_DEPLOY_PORT=22 pnpm deploy:server` (first-time setup: `INSTALL.md` section 0).

By hand, if the script cannot be used:

```sh
node scripts/package.mjs --no-app
scp -P <ssh-port> release/orchestrator-0.1.0.tar.gz <user>@<server>:/tmp/o.tar.gz
ssh -p <ssh-port> <user>@<server> 'cd ~/orchestrator-office && rm -rf app.new app.old && mkdir app.new \
  && tar xzf /tmp/o.tar.gz -C app.new --strip-components=1 && mv app app.old && mv app.new app \
  && systemctl --user restart orchestrator-office'
```

### 2. The desktop app (client)
Needed only when something under `apps/desktop/electron/` changed (the start screen, joining, the relay and agent for one's own room, the TV, packaging) or the bundled host agent (`apps/host-agent`, used for one's own room). The office UI itself comes from the server.

On the owner's Mac — the app is built next to the one that runs, checked, and then swapped in by a script that closes the running app and opens the new one (the owner's standing word of 2026-11-12: "close the app for me and start the new one, every time"):

```sh
node scripts/package.mjs --out release-next         # builds release-next/Orchestrator.app; release/ is not touched
node scripts/smoke-package.mjs --out release-next   # 15/15
node scripts/update-mac-app.mjs                     # closes the app, swaps the build in, opens it again — only if it was running
```

`update-mac-app.mjs` never kills the app. A build since 2026-11-12 quits without its "Leave this office?" question when it gets SIGUSR2 from the same user (`main.cjs`); an older build is asked to quit and shows the question, which the script answers where the terminal is allowed to (macOS Accessibility) and which otherwise waits for the person — if the app is still running after a minute and a half, nothing is replaced. The build that was in `release/` is kept as `release-next/Orchestrator.app.previous-HHMM` (each is a whole app; delete old ones by hand). Employees' sessions keep running in tmux; the Mac is back in the office when the app is.

The packager itself still refuses to replace an app that is running (`node scripts/package.mjs` without `--out` writes into `release/`).

A collaborator, from their own checkout:

```sh
git pull && pnpm install && pnpm build
pnpm desktop                 # run from source — or: node scripts/package.mjs  → release/Orchestrator.app
```

Closing the app leaves their own Claude Code sessions running in tmux; they are back in their room the next time they connect.

**Which computers still run an older app:** the office tells its owners in the Inbox — "*<machine>* runs an older
Orchestrator", with what does not work there until it is updated (the release gate and the central context, moving
employees, a rented employee's fence, the high-risk switches) — once per machine, gone when it connects updated
(`hostLacks` in `packages/contracts`, `Registry.olderApp`); the machine's *Agent* line in the machines window says it too.
Every build reports version 0.1.0, so this is read from what the machine's agent says it can do.

**How the work went** (tickets, checks, reviews, times — read-only): `node --no-warnings scripts/measure-work.mjs
~/.orchestrator-office/server/orchestrator.db --days 14 [--project <name>]` on the server (its Node has `node:sqlite`).

### 3. Both
When a change touches the protocol between the app's own agent and the server (rare; `packages/contracts/src/protocol.ts`, `PROTOCOL_VERSION`): update the server first, then the clients. An older client can still open the office; its own room may not connect until it is updated.

## Day to day on the server

All commands as `sparkcan` on the server:

```sh
N=~/.nvm/versions/node/v22.23.4/bin/node
A="env ORCH_SERVER_HOME=$HOME/.orchestrator-office/server $N $HOME/orchestrator-office/app/scripts/office-admin.mjs"

$A status                                   # open? addresses, certificate fingerprint, members and when they were last in
$A invite "Name" --role colleague           # owner | colleague | visitor — prints the invitation link once (works once, for a week)
$A reinvite "Name"                          # new link; what they had stops working at once
printf '%s' 'the password' | $A password "Name"   # let them sign in at the office's address with that name; read from standard input, never an argument
$A password "Name" --remove                 # no more signing in with a password (the app and invitations still work)
$A role "Name" visitor                      # change what they may do (their window reconnects)
$A revoke "Name"                            # take their access and their computer's place away

systemctl --user status orchestrator-office
systemctl --user restart orchestrator-office
journalctl --user -u orchestrator-office -f         # the log
tmux ls                                             # shared sessions; attach: tmux attach -t orch-<name>-<id>
```

Owners can do the member part from the app as well: Menu → Access.

**Sessions that sleep.** Shared sessions with no work for 30 minutes are stopped by the office to free memory (Settings → Employees → *Put idle sessions to sleep after*; 0 = never). So `tmux ls` on the server shows only the employees who are awake: a missing `orch-<name>-<id>` session of someone shown as *Sleeping* in the office is expected, not a crash. It comes back under the same name when they are next needed. The log line is `session.asleep` in the audit (actor `office`); a wake is `session.resumed` by `office`. To see what the setting gives back, compare `free -m` (or the Machines panel) before and after an idle half hour — this has not been measured yet.

### The employees' browser
Sessions on the server have a headless browser (Playwright's MCP server on the server's own Chrome), installed on 2026-11-11 in `~/orchestrator-office/browser/` — beside `app`, so a deploy does not touch it. How it was installed, how to update or remove it, and what it may reach: `ATTACHMENTS.md`, "A browser". The office's agent looks for it when it starts and says so in Machines (and `GET /api/state` → the host's `info.browser`). Screenshots a session takes land in `~/.orchestrator-office/agent/sessions/<id>/browser/`; files attached to tasks in `~/.orchestrator-office/agent/files/<task>/` on the machine and in `~/.orchestrator-office/server/files/` in the office (**the last one belongs in the backup**).

### Adding a Claude account
So that employees do not wait when the server's one account reaches its limit (`ACCOUNTS.md` explains all of it):

1. In the office: **Company → Claude → Add an account…** on the server's line → **A Claude account**. The office makes `~/.claude-2` there (the next free one) and starts Claude Code's sign-in on the server.
2. In the same window: **Open the sign-in page** (it opens in your browser), sign in with the other account, and **paste the code** the page gives → *Send*. The window says who is signed in.

Nothing is done on the server by hand. (If the window cannot finish a sign-in — it has not met the real one yet, see `ACCOUNTS.md` "Not verified" — the old way works: `ssh -p <ssh-port> <user>@<server>`, `CLAUDE_CONFIG_DIR=$HOME/.claude-2 claude`, `/login`, `/exit`.) A **Z.AI** account is the other choice in the same sheet: paste the API key; employees are put on it in their Settings.

From then on employees on an account that runs out are moved to one that has room, by themselves (Settings → Employees switches that off). `journalctl --user -u orchestrator-office | grep -i account` shows the moves; the feed shows them too ("… was put on another Claude account"). Nothing about accounts is in the deploy package: the folders live in the server user's home and stay across updates. They are logins — treat them like `~/.claude`, and keep them out of anything you share.

### The long memory (MemPalace)
The office's long memory is MemPalace (`github.com/MemPalace/mempalace`), a Python program, installed on the server in an environment of its own beside the office program — a deploy does not touch it:

```sh
python3 -m venv ~/orchestrator-office/mempalace-venv
~/orchestrator-office/mempalace-venv/bin/pip install mempalace      # 3.11.0 on 2026-11-11; about 520 MB with its libraries
systemctl --user restart orchestrator-office                        # the office finds it at start
```

At its first start the office sets up `~/.orchestrator-office/server/palace/` (`records/` — what the office wrote, one Markdown file each; `palace/` — MemPalace's own store; `config/` — its settings), so it is inside the office's backup. The embedding model is downloaded once to `~/.cache/huggingface` (about 315 MB). Settings → Growth → *Long memory* shows the version, how many records were written and the last problem. To upgrade: `pip install -U mempalace` in that environment and restart. To remove: stop the office, delete `mempalace-venv` (and `palace/` if the memory should go too), start it. By hand, the way the office calls it:

```sh
D=~/.orchestrator-office/server/palace; M=~/orchestrator-office/mempalace-venv/bin/mempalace
MEMPALACE_CONFIG_DIR=$D/config MEMPALACE_EMBEDDING_MODEL=embeddinggemma MEMPALACE_DISABLE_UPDATE_CHECK=1 $M --palace $D/palace search "how do we deploy the shop" --wing office < /dev/null
```

(`< /dev/null` matters for `init`: it asks a question when it has someone to ask.) It is not the MemPalace that Ahoy runs in Docker on the same machine; they share nothing.

### Backup and restore
The whole office is `~/.orchestrator-office/server/` (database, certificate, credentials, the files attached to tasks in `files/`, and `vault.key` — the key to everything in the vault; a backup without it cannot open the vault). The certificate matters: with a new one every invitation has to be made again.

```sh
systemctl --user stop orchestrator-office
tar czf ~/office-backup-$(date +%F).tar.gz -C ~ .orchestrator-office
systemctl --user start orchestrator-office
```

Restore: stop the service, unpack the archive in `~`, start the service. Employees' code is in their own folders and git repositories — it is not part of this backup.

### Moving the office to another server
Install there (`INSTALL.md` section 0), stop both services, copy `~/.orchestrator-office` across, start the new one with the new `--address`, and re-issue invitations (`reinvite`) so they carry the new address. Shared sessions do not move; they belong to the old machine's tmux.

## When something is wrong

| What you see | Look at |
| --- | --- |
| `office.sparkcan.com` does not answer | `dig +short office.sparkcan.com` (is the DNS record there and proxied?); on the server `curl -sk --resolve office.sparkcan.com:443:127.0.0.1 https://office.sparkcan.com/healthz` (nginx → door); `sudo nginx -t`. The Tailscale and LAN addresses keep working meanwhile |
| App: "could not be opened" / cannot reach the office | Is the service active (`deploy-server.sh --status`)? Are you on Tailscale or the LAN? Is 4610 open (`sudo ufw status`)? |
| App: "the certificate is different" | The server's certificate changed (state folder replaced). Make new invitations |
| "This invitation is no longer valid" | It was revoked or re-issued: `office-admin status`, then `reinvite` |
| "This invitation link has been used already, or it is more than a week old" | A link works once. Make another: **Access → New link**, or `reinvite` |
| "My room" says this computer is not in the office | The reason is written there. Needs tmux, Node.js 22.18+ and Claude Code on that computer — on Windows, inside WSL2 (an app built from `a3aa698` or later; an older one cannot host sessions on Windows). A browser tab cannot host sessions |
| A shared employee will not start | On the server: is `claude` logged in for `sparkcan` (`claude --version`, then start it once by hand)? `journalctl --user -u orchestrator-office -n 100` |
| New UI did not appear after a deploy | Reload the window (Cmd/Ctrl+R). `app/BUILD` on the server shows what is deployed |
| The update made things worse | `sh scripts/deploy-server.sh --rollback` |
| Office state looks broken after a crash | Stop the service, restore the last backup of `~/.orchestrator-office`, start it |

## What a release consists of

| Artifact | Made by | Used for |
| --- | --- | --- |
| `release/orchestrator-<version>.tar.gz` | `node scripts/package.mjs --no-app` | the server (and any machine that runs an office or an agent without the desktop app) |
| `release/Orchestrator.app`, `release/Orchestrator-<version>-arm64.dmg` | `node scripts/package.mjs` (on macOS) | the desktop app for Apple Silicon Macs |
| Linux / Windows desktop bundles, `.deb` | `node scripts/package.mjs --linux --windows --deb` | other platforms — **currently stale and untested on real machines** |

The version number is `version` in the root `package.json`; `app/BUILD` on the server records the commit and time of the deploy.

## The public demo office

A second, separate office on the same server — `orchestrator-demo` (user service), `office-demo.sparkcan.com`, fresh at every start and every night at 04:00 UTC; `pnpm deploy:server` restarts it with the real one. Everything about it: [DEMO.md](DEMO.md).
