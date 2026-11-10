# Security model

Orchestrator drives tools that edit files and run commands. These are the boundaries it enforces and the ones it leaves to you.

## Who can do what

| Actor | Credential | Can |
| --- | --- | --- |
| Owner (the office UI) | owner token — random, stored hashed; plaintext only in `~/.orchestrator/server/owner-token` (0600) | everything in the REST API and client WebSocket |
| Host agent | host credential issued at enrollment — stored hashed on the server, plaintext only in the agent's `config.json` (0600) | report its own sessions and hooks, answer RPCs. It cannot read or change other hosts' sessions: every message is checked against the connection's host id |
| Worker (a Claude Code session) | MCP bearer token — per launch, revoked when the session is relaunched | call the Orchestrator MCP tools **as its own employee**. Identity comes from the token, never from tool arguments |
| Hook process | per-session hook token over a 0600 unix socket | post hook events for its own session |

Unauthenticated requests get `401`; a client WebSocket without the owner token is closed (`4003`); an agent with an unknown or revoked credential is rejected.

**Enrollment** is explicit: a one-time token (expiring, single-use, hashed at rest) is created by the owner and traded for a host credential. **Revocation** is immediate: the credential is invalidated and the connection is cut; the host's tmux sessions are untouched.

## Network

- The server listens on `127.0.0.1` by default. It refuses a non-loopback address without TLS (`--tls-cert/--tls-key`) unless `--allow-insecure-remote` is given for a TLS-terminating proxy.
- The agent CLI refuses to enroll against a non-TLS, non-loopback URL unless `--insecure` is passed.
- Hosts connect outward. Nothing listens on a host except the agent's unix socket.

## Terminals

- Terminal access is bound to registered sessions. The agent offers no "run this command" or "open a shell" RPC; the only arbitrary command it runs for the server is a project's **verification command**, in an allowed directory, and that can be switched off per host (`allowVerify: false`).
- **Existing sessions**: the office can only attach tmux panes that are running Claude Code (`remoteAttach: "claude"`, the default). A shell pane attached to the office would be a remote shell for the owner, so that requires either `orchestrator-agent attach` run on the machine itself, or `remoteAttach: "any"` in that host's config. `"none"` disables office-initiated attach entirely.
- **Input ownership is enforced on the server.** One controller per session; an observer's keystrokes are dropped by the gateway regardless of what the UI does. Control is released automatically when the controller disconnects.
- Taking control, releasing it and interrupting are written to the audit log. Keystrokes are not logged.
- Terminal streams and monitor frames are never persisted.

## Agent permissions

Autonomy is expressed in Claude Code's own permission system and nothing else:

| Level | Permission mode | Pre-approved | Denied |
| --- | --- | --- | --- |
| restricted | manual (default) | read-only git, `ls`, `wc` | Edit, Write, MultiEdit, NotebookEdit |
| supervised | manual (default) | — (every edit and command asks) | — |
| standard | acceptEdits | read-only git, `git add/commit/merge`, common test commands | — |
| autonomous | acceptEdits | the above plus package managers, interpreters, build tools | — |

Plus project `policy.allow` / `policy.deny`, plus the employee's own lists. `bypassPermissions` / `--dangerously-skip-permissions` are never used.

| auto | auto | the same allow-list as autonomous | — (Claude Code's auto mode decides) |

**Auto.** An employee on *auto* runs in Claude Code's own auto permission mode: its safety classifier decides what may run, so you are not asked for permission — only for decisions (`ask_boss`). New hires from the short hire form default to it. Two things follow from "do not ask me": the workspace-trust prompt for the folder you put them in is answered for you (recorded in the audit log as `trust.auto_accepted`), and nothing is surfaced as an approval unless it matches the high-risk list below. That last safeguard can be switched off in *Settings → Workers* ("On Auto, still ask me before high-risk commands"); the change is audited. The bypass mode is still never used.

**High-risk commands always escalate** (for *auto*: unless you switched that off). A `PreToolUse` hook on the host matches shell commands against a pattern list (pushes, hard resets, `rm -rf` of broad paths, `sudo`, deploys, publishing, piping downloads into a shell, reading key/credential files, switching to main branches, …) and answers `ask`, which forces Claude Code's permission flow — and therefore your approval — whatever the autonomy level. Projects can add patterns. The self-improvement system never proposes pre-approving a command that matches these patterns.

**SDK-managed workers get the same rules.** An employee on the SDK runtime is given the same permission mode and allow/deny/ask rules through the Agent SDK's options; the bypass mode is never used there either. A tool call that is not pre-approved goes to the office through the SDK's permission callback and is held exactly like a hook; if nobody answers in time it is asked in the worker's pane, where the default is *no*. The host's high-risk gate runs as an SDK `PreToolUse` callback and escalates the same commands. The runner authenticates to the host agent with that session's own token over the agent's private unix socket.

**Workers do not inherit your MCP connectors** by default (`--strict-mcp-config`): they get the Orchestrator server only. Turning on *Settings → Workers → inherit my MCP servers* gives every worker whatever those connectors can reach.

**Changes that widen permissions are always yours.** Suggestions such as "pre-approve `docker build`" or "give Dana standard autonomy" are proposals; applying one is an owner action, recorded in the audit log, and takes effect for sessions started afterwards.

## Repository safety

- Each employee works in its own git worktree on its own branch. Orchestrator refuses to switch branches over uncommitted work.
- Two employees are never given code tasks in the same plain (non-git) directory.
- When an employee works **in place** in your own folder, whatever was already uncommitted there when the task started is recorded as yours: it never blocks the task, the employee is told not to commit, change or delete it, and completion only looks at what changed during the task.
- Merges happen in a separate integration worktree, `--no-ff`, into `orchestrator/integration`. A conflicting merge is aborted and reported. Your checkout and your `main` are never modified.
- Orchestrator never pushes, and `git push` is on the high-risk list.

## The desktop app as a client

When the desktop app connects to an office on another machine, it only accepts an `https://` address (plain `http://` is allowed for this computer alone), checks the owner token against the server before saving anything, and stores the token in its own data folder encrypted with the operating system's keychain facility when one is available (otherwise in a file readable only by you). On macOS this creates a login-keychain item named "Orchestrator Safe Storage"; because the app is not Developer-ID signed, macOS asks for your keychain password again after each rebuild. Set `ORCH_NO_KEYCHAIN=1` to keep the token in the owner-only file instead. The connect page is a local file with a content-security policy that allows no remote content, and it can ask the main process for exactly one thing: to try a connection.

## Guests (other people in your office)

Nobody but you can reach the office until you open it (**People → Open the office to guests**). Opening starts a second listener on your network — the *guest door* — with TLS and a certificate created on your computer (`door-key.pem`, mode 600, in the server's data folder). The door forwards only `/`, the page's assets, `/api/*`, `/healthz` and the client WebSocket; the agent endpoint, the workers' MCP endpoint and the agent download are not reachable through it, so nobody outside can enrol a machine or act as an employee. Requests that came through the door are marked by the door itself, and the office **never accepts the owner token from there**: your owner token works only from this computer.

A guest has a credential of their own (`orch_guest_…`, stored hashed), tied to a name and a role, revocable at any time; revoking disconnects them at once. An invitation is one string holding the door's addresses, that credential and the SHA-256 fingerprint of the door's certificate. The joining app checks the fingerprint before it sends anything, and its window accepts exactly that certificate for that host — there is no certificate authority to trust and no "accept anyway" prompt. Whoever holds an invitation can come in as that guest, so send it over a channel you trust; **New invitation** replaces a leaked one.

What each role may call is an allow-list on the server (`guestMay` in `apps/server/src/guests.ts`), not something the page decides:

- **visitor** — read the office state and events, see the other people, talk to them. No terminals (not even the monitors in the 3D office), no documents, no changes.
- **colleague** — also: watch terminals read-only, read documents and diffs, message employees (who are told it is a colleague and not the boss), create and edit tasks, start meetings, answer an employee's *question*.
- **owner only** — approve or deny permission requests, take the keyboard of a terminal, hire, archive, start and stop sessions, machines and SSH links, settings and policies, reviews, merges and promotion, the layout, guests themselves, the audit log.

Every change a guest makes is written to the audit log under their name. Reaching you from outside your network is up to you (a VPN address or a forwarded port added under *Another address*); the office does not open your router or use any relay. A guest sees what happens in your office — task titles, messages, activity — so invite people you would show that to.

## The TV (embedded browser)

The TV is an Electron `<webview>`, and the only one the office window may create (`will-attach-webview` refuses any other partition and any non-http(s) address). It runs sandboxed with no Node integration and no preload, in its own storage partition (`persist:orch-tv`), under a plain browser user agent. Requests from it to the office's own address are cancelled, so a web page cannot talk to your office; `file:` and other schemes are refused; pop-ups open in the TV itself; camera, microphone, location and notifications are denied (only fullscreen is allowed). About once a second the main process takes a small picture of the page for the screen in the 3D office; it is not stored. "Forget browsing data" clears the partition. In a plain browser tab (no desktop app) the TV can only embed YouTube video.

## Servers linked over SSH

An SSH link runs the system `ssh` client as you, with `BatchMode=yes`: only your keys and agent are used, a password is never asked for, read or stored. Host keys are checked the normal way; an unknown key is refused unless you explicitly trust that server for the first connection (`StrictHostKeyChecking=accept-new`: the key is then pinned in your `known_hosts`, and a changed key is refused with a warning). What you type as the server is validated (`user@host[:port]` or a config alias) and passed as an argument, never through a shell; scripts run on the server are fixed text sent on standard input, with the few values that vary single-quoted.

The reverse tunnel puts the office's port on the server's **loopback** interface only. Any local user or process on that server can therefore reach the office's HTTP port there — and gets nothing without a credential: the owner API needs the owner token (which never leaves your computer), the agent endpoint needs the host credential, and the MCP endpoint needs a per-session token. On a server shared with people you do not trust, prefer a dedicated account. The agent enrols with a single-use, ten-minute token passed in the environment (not on a command line), and stores its credential in `~/.orchestrator/links/<id>/config.json`, mode 600. Removing the link stops the agent, deletes that folder and revokes the credential; revoking the machine under Machines has the same effect on access.

The host's `allowedRoots` (your home folder on the server unless you list others) bound where employees can be started and what the office can read there. Turning an attached session into a full employee types `/exit` into Claude Code — sessions the office did not start are never killed.

## Reading documents and browsing folders

The office can list the Markdown files in an employee's folder and show them, and can list folders on a machine so you can choose one when hiring. Both are read-only, go through the host agent, and stay inside that host's `allowedRoots`: only `.md`/`.markdown`/`.mdx` files are ever read, paths are resolved and must remain inside the employee's folder (a symbolic link that points elsewhere is not followed), files are capped at 512 KB, and hidden folders and dependency folders are skipped. What agents write is shown as formatted Markdown by a renderer that builds elements directly — no HTML from an agent is ever inserted into the page, and only `http(s)`/`mailto` links are clickable.

## The hi-fi (internet radio)

The office page may play audio from any `http(s)` address (`media-src` in its content policy) and nothing else from outside: scripts, styles, images and network calls stay limited to the office itself. Stations are saved in the settings, and only well-formed `http(s)` addresses with a name are kept. "What is on air" is asked by the office server, for saved stations only, with a five-second limit and a size limit; only a title of at most 200 characters is passed on to the page. Playing a station tells that station's server your IP address, as any radio player does. The whip is local to the window: it calls nothing and records nothing.

## Claude accounts

To show how much of each Claude account is used, the host agent reads two fields (`emailAddress`, `organizationName`) from Claude Code's own `.claude.json` on that machine, and the rate-limit percentages Claude Code gives the session's status line. It reads no credentials and never calls Anthropic itself. The account e-mail and the percentages go to your office server only; they are shown to the owner (`GET /api/usage` is not on any guest's list) and are not written into events. An employee's own account folder must be inside the home folder of the user the agent runs as.

## Filesystem

The agent operates only inside `allowedRoots` (symlinks resolved, so a link cannot escape a root). The default is the user's home directory — narrow it with `--allow-root`.

State directories are created `0700`; the database, tokens, session settings and outbox are `0600`.

## Secrets and logs

- Event summaries and payloads are passed through a redactor (API keys, tokens, private keys, `NAME=secret` assignments, JWTs) before they are stored. File contents written by agents are never stored in events.
- The audit log records actor, action and target for approvals, control changes, session lifecycle, project/employee/policy changes and applied suggestions; details are redacted the same way.
- Credentials are stored as SHA-256 hashes; plaintext is shown once.

## What this does not protect against

- **A compromised host.** The agent runs as your user; anyone with that account has the same access.
- **A malicious repository.** Claude Code's own trust prompt appears before an interactive session starts in a new folder; Orchestrator surfaces it as a question rather than accepting it for you. **SDK-managed workers do not get that prompt** (the SDK runs non-interactively) and load the project's own `CLAUDE.md` and settings: only use that runtime in folders you already trust.
- **The packaged macOS app's origin.** It is ad-hoc signed, not notarized; Gatekeeper cannot vouch for a copy you did not build yourself.
- **The verification command.** It is your shell command, executed on the host. Treat project settings as code.
- **Prompt injection through project content.** Agents read repositories and web pages. The permission system, the high-risk gate and worktree isolation limit the damage; they do not make an agent immune.
- **Multi-user separation.** There is one owner role. Do not share the owner token.
