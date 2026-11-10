# Operations: where everything runs and how to update it

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
| Machine | "Sparkcan", Ubuntu 22.04, user `sparkcan` |
| Reach it | `ssh -p <ssh-port> <user>@<server>` (LAN) — or the Tailscale address `<server-vpn-ip>` |
| Program | `~/orchestrator-office/app` (the portable package). Previous version: `~/orchestrator-office/app.old`. `app/BUILD` says which commit is running |
| State | `~/.orchestrator-office/server` (database `orchestrator.db`, door certificate, the office's own owner token) and `~/.orchestrator-office/agent` (the shared host agent) |
| Service | systemd user unit `orchestrator-office` (`~/.config/systemd/user/orchestrator-office.service`), lingering enabled so it survives logout and reboot |
| Node.js | `~/.nvm/versions/node/v22.23.4/bin/node` (the system's `node` is too old) |
| Ports | 4600 on loopback (the office itself), **4610/tcp open in ufw** (the door, TLS) |
| Members reach it at | **`https://office.sparkcan.com`** (through Cloudflare and the server's nginx — see "The domain" below) · `https://<server-vpn-ip>:4610` (Tailscale) · `https://<server-lan-ip>:4610` (LAN). New invitations list them in that order; the app uses the first that answers |
| Claude Code | `/usr/local/bin/claude`, logged in as `sparkcan`: this is the account shared employees use |
| Shared sessions | the default tmux server of `sparkcan`, sessions named `orch-<employee>-<id>` |
| Not ours | `~/.orchestrator-mac-link-backup-2026-11-10` — the agent of the old Mac office, stopped and set aside. Safe to delete |

### The domain
`office.sparkcan.com` → DNS record in Cloudflare (`office`, A, `<server-public-ip>`, **DNS only** — not proxied) → the server's public address, port 443 → nginx (CloudPanel site `office.sparkcan.com`, type *reverse proxy*) → `https://127.0.0.1:4610`, the office's door.

- **Certificate:** Let's Encrypt, installed and renewed by CloudPanel (`sudo clpctl lets-encrypt:install:certificate --domainName=office.sparkcan.com` to do it by hand). The desktop app trusts an office when its certificate is the one named in the invitation (addresses with a port: the door's own certificate) **or** one the system trusts for that name (the domain) — so renewals need nothing. If the DNS record is ever switched to proxied, Cloudflare's certificate is trusted the same way.
- **The proxy must point at the door (4610), never at the office's own port (4600):** the door is what marks a request as coming from outside, and only that keeps the office's own owner token from being usable over the network. Checked after setup: the owner token gets 401 through the domain.
- **CloudPanel:** site user `<site-user>`; its password is in `~/.orchestrator-office/cloudpanel-site-user.txt` on the server (mode 600). Vhost: `/etc/nginx/sites-enabled/office.sparkcan.com.conf`; WebSocket headers and 900 s timeouts come from CloudPanel's reverse-proxy template. One line was added by hand in `location @reverse_proxy`: `access_log off;` (older clients carry their token in the WebSocket address; current ones send it as a subprotocol). A copy of the original is in `/root/office.sparkcan.com.conf.bak-2026-11-10`. **If the vhost is saved from the CloudPanel UI, check that this line is still there.**
- Verified 2026-11-10 from the owner's Mac: the desktop app joins over the domain (API, WebSocket, and the relay for the Mac's own room all go to `<server-public-ip>:443`).
- **People without an invitation** open `https://office.sparkcan.com` in a browser (they can ask to look around) or type `office.sparkcan.com` into the desktop app's start screen (they can be let in as visitor, colleague or owner). Whoever is inside answers from the card at the top right of the office window.
- The office limits knocks per caller address, which it takes from the last entry of `X-Forwarded-For` as set by this nginx (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` in CloudPanel's template). If that line is ever removed, every caller looks like `127.0.0.1` and shares one limit.
- Old invitations keep working through the Tailscale/LAN addresses; `reinvite` gives one that tries the domain first.

### A person's computer (client)
| | |
| --- | --- |
| App | built from this repository. On the owner's Mac: `release/Orchestrator.app` in the checkout (`/Users/brstefanovic/Projects/office`), with `~/Desktop/Orchestrator.app` linking to it |
| App data | macOS: `~/Library/Application Support/Orchestrator/` — `joined.json` (saved offices and invitations, mode 600), `prefs.json` (graphics, keys, extras for this computer) |
| Their own room | `~/.orchestrator/offices/<id>/agent` — the host agent for their own sessions in that office (one folder per office). Their sessions: their default tmux server, `orch-*` |
| Old local office (owner's Mac) | `~/.orchestrator-local-office-backup-2026-11-10/` — set aside, not used. Safe to delete |

### The code
`https://github.com/brstic/orchestrator` (private), branch `main`. Collaborators: `brstic`, `fenixf4`, `nikolajanko`. The owner's Mac pushes over HTTPS through `gh` (its SSH key is a deploy key for another repository).

## Updating

### 1. The server (the usual update)
From a checkout with the change, on a machine that can ssh to the server:

```sh
pnpm typecheck && pnpm test && pnpm test:e2e     # at least these; UI changes: pnpm build:ui && node tests/ui/run.mjs
pnpm deploy:server                               # = sh scripts/deploy-server.sh
```

What it does: builds the portable package (`scripts/package.mjs --no-app`), copies it over, unpacks it to `app.new`, moves the running `app` to `app.old`, swaps, restarts the service, and prints the status. It takes about half a minute.

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

On the owner's Mac:

```sh
pgrep -f release/Orchestrator.app/Contents/MacOS    # must print nothing: the app has to be closed
node scripts/package.mjs                            # builds release/Orchestrator.app and the .dmg
node scripts/smoke-package.mjs                      # 15/15
open release/Orchestrator.app                       # walks into the server office by itself
```

The packager refuses to replace an app that is running. The app asks before it quits, so do not script the quit: close it yourself, or build next to it and swap later:

```sh
node scripts/package.mjs --out release-next && node scripts/smoke-package.mjs --out release-next
# after closing the app:
rm -rf release/Orchestrator.app && mv release-next/Orchestrator.app release/ && open release/Orchestrator.app
```

A collaborator, from their own checkout:

```sh
git pull && pnpm install && pnpm build
pnpm desktop                 # run from source — or: node scripts/package.mjs  → release/Orchestrator.app
```

Closing the app leaves their own Claude Code sessions running in tmux; they are back in their room the next time they connect.

### 3. Both
When a change touches the protocol between the app's own agent and the server (rare; `packages/contracts/src/protocol.ts`, `PROTOCOL_VERSION`): update the server first, then the clients. An older client can still open the office; its own room may not connect until it is updated.

## Day to day on the server

All commands as `sparkcan` on the server:

```sh
N=~/.nvm/versions/node/v22.23.4/bin/node
A="env ORCH_SERVER_HOME=$HOME/.orchestrator-office/server $N $HOME/orchestrator-office/app/scripts/office-admin.mjs"

$A status                                   # open? addresses, certificate fingerprint, members and when they were last in
$A invite "Name" --role colleague           # owner | colleague | visitor — prints the invitation once
$A reinvite "Name"                          # new invitation; the old one stops working
$A role "Name" visitor                      # change what they may do (their window reconnects)
$A revoke "Name"                            # take their access and their computer's place away

systemctl --user status orchestrator-office
systemctl --user restart orchestrator-office
journalctl --user -u orchestrator-office -f         # the log
tmux ls                                             # shared sessions; attach: tmux attach -t orch-<name>-<id>
```

Owners can do the member part from the app as well: Menu → People.

### Backup and restore
The whole office is `~/.orchestrator-office/server/` (database, certificate, credentials). The certificate matters: with a new one every invitation has to be made again.

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
| "My room" says this computer is not in the office | The reason is written there. Needs tmux, Node.js 22.18+ and Claude Code on that computer; a browser tab or Windows cannot host sessions |
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
