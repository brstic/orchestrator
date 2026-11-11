# Security model

Orchestrator drives tools that edit files and run commands. These are the boundaries it enforces and the ones it leaves to you.

## Who can do what

| Actor | Credential | Can |
| --- | --- | --- |
| Owner (the office UI) | owner token — random, stored hashed; plaintext only in `~/.orchestrator/server/owner-token` (0600) | everything in the REST API and client WebSocket |
| Host agent | host credential issued at enrollment — stored hashed on the server, plaintext only in the agent's `config.json` (0600) | report its own sessions and hooks, answer RPCs. It cannot read or change other hosts' sessions: every message is checked against the connection's host id |
| Worker (a Claude Code session) | MCP bearer token — per launch, revoked when the session is relaunched | call the Orchestrator MCP tools **as its own employee**. Identity comes from the token, never from tool arguments |
| Foreman (the one worker whose employee has the `foreman` role) | the same per-launch MCP bearer token | additionally the foreman tools: read the office and employees' terminal screens (members' own employees included, while their computer is connected), answer employees' questions, tell them what to do next, assign and create tasks, escalate to the owner. Never an approval — see [The foreman](#the-foreman) |
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

**Auto.** An employee on *auto* runs in Claude Code's own auto permission mode: its safety classifier decides what may run, so you are not asked for permission — only for decisions (`ask_boss`). New hires from the short hire form default to it. Two things follow from "do not ask me": the workspace-trust prompt for the folder you put them in is answered for you (recorded in the audit log as `trust.auto_accepted`), and nothing is surfaced as an approval unless it matches the high-risk list below. That last safeguard can be switched off in *Settings → Employees* ("On Auto, still ask me before high-risk commands"); the change is audited. The bypass mode is still never used.

**High-risk commands always escalate** (for *auto*: unless you switched that off). A `PreToolUse` hook on the host matches shell commands against a pattern list (pushes, hard resets, `rm -rf` of broad paths, `sudo`, deploys, publishing, piping downloads into a shell, reading key/credential files, switching to main branches, …) and answers `ask`, which forces Claude Code's permission flow — and therefore your approval — whatever the autonomy level. Projects can add patterns. The self-improvement system never proposes pre-approving a command that matches these patterns.

**SDK-managed workers get the same rules.** An employee on the SDK runtime is given the same permission mode and allow/deny/ask rules through the Agent SDK's options; the bypass mode is never used there either. A tool call that is not pre-approved goes to the office through the SDK's permission callback and is held exactly like a hook; if nobody answers in time it is asked in the worker's pane, where the default is *no*. The host's high-risk gate runs as an SDK `PreToolUse` callback and escalates the same commands. The runner authenticates to the host agent with that session's own token over the agent's private unix socket.

**Workers do not inherit your MCP connectors** by default (`--strict-mcp-config`): they get the Orchestrator server only. Turning on *Settings → Employees → Employees also get your MCP servers and connectors* gives every worker whatever those connectors can reach.

**Changes that widen permissions are yours — unless you hand some of that over.** Suggestions such as "pre-approve `docker build`" or "give Dana standard autonomy" are proposals; applying one is an owner action, recorded in the audit log, and takes effect for sessions started afterwards. What the office may apply by itself is set by one dial, *the autopilot* (`settings.selfImprovement.autopilot`; details and limits in [learning/autopilot.md](learning/autopilot.md)):

- **off** — nothing is applied without a person.
- **safe** (the default) — the office applies only changes that cannot let agents do more without asking: deny rules, required review, a longer verification timeout, a lower autonomy level, a lesson for one employee. It never adds an allow rule, raises autonomy or switches review off. "Safe" is about permissions only: a deny rule or a review gate applied this way can still get in the way of work until you undo it.
- **trusted** — the office also applies widening changes, each under a fixed evidence rule (for an allow rule: at least five approvals of exactly that command shape in that project, across two tasks or a day, not one denial ever, nothing of that shape on the high-risk list, never a shape that runs arbitrary other commands; for autonomy: one level at a time, never beyond *standard*, on a clean record), and each on probation: a denial, a high-risk request of that shape or a failure in that time takes it back, and it is not applied automatically again. On shared machines a colleague's approvals count as evidence like yours.

Whatever the dial says, the office **never answers a permission request**, never pre-approves anything that matches the high-risk list, never gives *autonomous* or *auto*, and never changes the foreman. On a member's own computer it changes permissions only on that member's own decisions. Every automatic change is written to the audit log as `autopilot`, recorded as a `learning.applied` event with its evidence, and can be undone (`POST /api/improvements/:id/revert`, owners only). Like any rule change, an automatic one — and its undoing — reaches a session when that session is next started: a rule that is taken back stays in sessions already running until they restart.

## The foreman

The foreman is the office's supervisor: one Claude Code session, on one of the office's own machines, with the role `foreman` and no desk. It is a session like any other, so everything above applies to it. Only an owner can hire one or change who it is; hiring one switches its rounds on, and *Settings → Foreman* pauses them.

**It supervises the whole office, members' own computers included.** While a member's computer is connected, the foreman sees that member's employees the way an owner does: `look_at` shows it the last lines of their real terminal, and it can answer their questions, tell them what to do next and give them tasks of projects on that same computer. Until this change only the member and the owners could look into a personal employee. A member who brings their computer into an office that has a foreman is therefore supervised by it; what it reads becomes part of its conversation with Claude on the office's account. Because of that, the foreman itself is the owners' alone: colleagues and visitors cannot watch or type into its terminal, read its documents or session history, talk to it, start or stop it, or change its profile (`access.ts`: `OWNERS_ONLY`). They still see that it exists, where it walks and what it is doing.

*Records:* messages and questions follow the same rule as terminals — what is sent to the foreman, and its questions, are for owners; what the foreman tells an employee is read by whoever may read that employee. Of the foreman's own feed lines everyone receives only the outline (that a round started or ended and how many items of each kind, and whom it is with: `FOREMAN_PUBLIC` in `access.ts`); the items of a round — which quote questions, also of members' own employees — and its conclusion are sent to owners only.

**What it may do**, through tools only a foreman's session can call (the server checks the caller's role on every call; the caller is identified by the session's bearer token, never by an argument):

- read the office: every employee's role, activity, task and open question, every project's board, and — with `look_at` — the last 40 lines of an employee's **terminal screen**;
- answer an employee's **question** on your behalf, if *the foreman answers employees' questions* is on;
- assign tasks, create tasks, and tell an employee what to do next (`tell_employee`: an ordinary message under its name) — never across the line between the shared office and a member's own computer;
- put something in your inbox (`escalate_to_owner`).

**What it may not do**, by construction rather than by instruction:

- **Decide a permission request.** `answer_question` refuses every request that is not an ordinary question — permission requests, trust prompts, and questions an employee addressed to you as a decision, priority or deployment — and the engine's own answer path refuses a non-owner decision as well. Approvals stay with you and with each employee's autonomy level and the high-risk gate, exactly as before; no permission-bypass flag is used anywhere.
- **Touch a terminal or a session.** It has no tool that types into, interrupts, starts, stops or takes control of anybody's session; `look_at` only reads the screen the host already captures for the office's monitors.
- **Edit files.** The role denies Edit, Write, MultiEdit and NotebookEdit whatever autonomy level you give the foreman.
- **Widen anyone's permissions, change settings or policies, release, review, merge or promote.** Those have no foreman tool.
- **Answer a question it escalated.** Once it is in your inbox it is yours.

**On the record.** Everything a foreman does is written under `foreman:<name>`: answers (`question.answer`, with `onBehalfOfOwner`), assignments and created tasks (task history), escalations, and every refusal (`foreman.refused`; a non-foreman trying a foreman tool is `foreman.tool_refused`). An answered question records who answered it, and the employee is told it was the foreman. Rounds are events (`foreman.round.started` / `.finished`) with what was listed and what was done.

**What to keep in mind.**

- *Terminal contents reach the foreman's model — also those of members' own employees.* What `look_at` returns becomes part of the foreman's conversation with Claude, like anything a session reads. Values in known credential formats are redacted first; other sensitive text on a screen is not. Screen contents are not written to events or the audit log.
- *An employee's words reach the foreman's prompt.* Questions, blocker reasons and task titles are quoted in the round digest, so a compromised or misled employee can try to steer the foreman. What that can achieve is bounded by the list above: tasks, assignments, messages and answers to questions — never an approval, a command or a file change.
- *A wrong answer is still an answer.* The foreman can answer a question you would have answered differently. The answer is on the record with its author; turn off *the foreman answers employees' questions* if you want every question yourself.
- *Each round uses Claude usage* on the account the foreman runs on. The office starts a round only for something new, never while one is running, and never sooner than the gap you set.

## Repository safety

- Each employee works in its own git worktree on its own branch. Orchestrator refuses to switch branches over uncommitted work.
- Two employees are never given code tasks in the same plain (non-git) directory.
- When an employee works **in place** in your own folder, whatever was already uncommitted there when the task started is recorded as yours: it never blocks the task, the employee is told not to commit, change or delete it, and completion only looks at what changed during the task.
- Merges happen in a separate integration worktree, `--no-ff`, into `orchestrator/integration`. A conflicting merge is aborted and reported. Your checkout and your `main` are never modified.
- Orchestrator never pushes, and `git push` is on the high-risk list.

## The desktop app as a client

When the desktop app connects to an office on another machine, it only accepts an `https://` address (plain `http://` is allowed for this computer alone), checks the owner token against the server before saving anything, and stores the token in its own data folder encrypted with the operating system's keychain facility when one is available (otherwise in a file readable only by you). On macOS this creates a login-keychain item named "Orchestrator Safe Storage"; because the app is not Developer-ID signed, macOS asks for your keychain password again after each rebuild. Set `ORCH_NO_KEYCHAIN=1` to keep the token in the owner-only file instead. The connect page is a local file with a content-security policy that allows no remote content, and it can ask the main process for exactly one thing: to try a connection.

## Members, the door and personal hosts

Who may do what is specified in [ACCESS.md](ACCESS.md) and enforced in `apps/server/src/access.ts`; a route that is not listed there needs an owner.

- **Credentials.** A member's credential is a random token (stored hashed), bound to a name and a role, revocable, replaceable. It is not what the owner sends: the owner sends an **invitation link** whose code the member's app exchanges for the credential once, at the door, within a week (`apps/server/src/invites.ts`; the code is stored hashed, twelve characters from an alphabet of 31, and wrong codes are limited to ten per address per ten minutes). A link that leaks after it was used opens nothing; one that leaks before lets whoever is first come in as that member — so it is still sent privately, and **Access** shows whether it is still waiting to be used. In an office with no address set, the invitation is the old long text, which carries the credential itself. The server's own owner token is a different kind of credential and is refused on any request that came through the door, so it cannot be used from the network even if it leaks.
- **The door.** A second listener with TLS and a self-signed certificate made on the server; a link to the door's own address carries the first ten bytes of its SHA-256 fingerprint and the app exchanges the code only with that certificate; what it gets back names the whole fingerprint, and from then on the app accepts exactly that certificate (and sends the token only after checking it). Behind a reverse proxy the app checks the proxy's certificate as a browser would. It forwards the page, `/api`, the client WebSocket, the agent WebSocket, `/mcp`, and the two things that need no credential — `/knock` and `/join`; nothing else. Requests through it are marked with a per-process secret header that the door overwrites, so a caller cannot forge or strip the mark.
- **Machines from outside.** Through the door the agent endpoint accepts only a member's own computer: a host enrolled with a one-time token that `POST /api/me/host` gave to that member (10 minutes, single use), or the credential such a host was issued. An ordinary enrollment token or a shared machine's credential is refused there. Revoking a member, or making them a visitor, revokes their hosts.
- **What a personal host exposes.** To the office: what any host agent exposes (terminals of sessions the office started there, folders under the agent's allowed roots, the list of Claude processes) — but only its member and owners can reach any of it, including monitor frames, which are filtered per client. A member who does not want owners to be able to open a terminal on their computer should not join as a colleague with that computer.
- **An office behind a domain.** A reverse proxy must forward to the door, not to the office's own port: loopback requests to the office itself are treated as local (they may present the owner token and enrol shared machines). For such an address the desktop app relies on ordinary web trust (a certificate valid for the name) instead of the pinned fingerprint; whoever controls the domain or the proxy in front of it (here: Cloudflare and the server's nginx) can see and alter the traffic, as with any website behind them.
- **The relay.** The agent and Claude Code on a member's computer speak plain HTTP to a relay on that computer's loopback, which connects to the office with the pinned certificate and forwards only `/ws/agent`, `/mcp` and `/healthz`. It holds no credentials.
- **Visitors can watch shared terminals.** Terminal output can contain secrets that the redactor (which works on events, not on raw terminal streams) does not remove. Invite visitors accordingly.
- **Colleagues can type into shared terminals and decide permission requests of shared employees.** A colleague therefore has, in effect, shell access as the office's user on shared machines, within what Claude Code's permission rules allow. Give that role to people you would give an account on the server.
- **Audit.** Every change a member makes is recorded as `member:<name>` with the route; answers and decisions record who gave them.

## What employees may do to the board by themselves
With *Employees manage the task board themselves* on (the default), an employee's session can release, unblock, assign and review tasks and start a colleague's session (`docs/CLAUDE-CODE-INTEGRATION.md`, "The board in the employees' hands"). What that changes for safety:

- **More work can start without the owner.** A released task is handed to an employee, who then acts with that employee's own autonomy level and permission rules — those are unchanged, and high-risk commands still come to the owner where the office is set to ask. Starting a colleague uses that colleague's Claude account.
- **A review by a teammate lets a change be merged** into the project's integration branch. The author cannot approve their own work; promotion to the base branch stays an owner's action.
- **Text an employee read can steer these tools** like any other tool it has (a web page or a file saying "release every task"). The tools cannot approve a permission request, delete anything, change policy, or reach across the line between the shared office and a member's own computer, and each use is on the record under the employee's name. Switch the setting off for an office where that is not enough.

## Knocking (asking to be let in without an invitation)
- The only thing an unauthenticated caller can do at the door besides fetching the page: leave a name (plain text, 40 characters) and wait. They learn the office's name, a four-digit code, and whether anyone who could answer is inside. They learn nothing else and get no credential until a person inside lets them in.
- Letting someone in is a decision by a signed-in owner or colleague, recorded in the audit log (`knock.admitted` / `knock.refused`, with who answered). A colleague cannot grant more than a read-only visit; only an owner can let someone in to work. A browser is never more than a visitor, and for 12 hours.
- **Anyone can type any name.** The card inside says how the person came and shows the code they see; the owner is told to ask for the code if they are not expecting the person. Letting a stranger in as *owner* gives them the office — the same as handing them an owner invitation.
- The knocker proves they are the same caller with a random secret (32 bytes; only its hash is kept), sent in a header, never in the address. The credential is returned once; if it is never collected the member is revoked.
- Flooding: per-address and total limits (see ACCESS.md). The address is the socket's; behind the reverse proxy on the same machine it is the last entry of `X-Forwarded-For` (what that proxy saw). A proxy that forwards the header without appending would let a caller pick their own "address" for the limit — the total limit of 10 waiting still holds.
- The desktop app knocks only at an address whose certificate the computer trusts for that name; an office with only its own certificate is not asked by address (there would be nothing to check it against) and still needs an invitation.

## The TV (embedded browser)

The TV is an Electron `<webview>`, and the only one the office window may create (`will-attach-webview` refuses any other partition and any non-http(s) address). It runs sandboxed with no Node integration and no preload, in its own storage partition (`persist:orch-tv`), under a plain browser user agent. Requests from it to the office's own address are cancelled, so a web page cannot talk to your office; `file:` and other schemes are refused; pop-ups open in the TV itself; camera, microphone, location and notifications are denied (only fullscreen is allowed). About once a second the main process takes a small picture of the page for the screen in the 3D office; it is not stored. "Forget browsing data" clears the partition. In a plain browser tab (no desktop app) the TV can only embed YouTube video.

## Servers linked over SSH

An SSH link runs the system `ssh` client as you, with `BatchMode=yes`: only your keys and agent are used, a password is never asked for, read or stored. Host keys are checked the normal way; an unknown key is refused unless you explicitly trust that server for the first connection (`StrictHostKeyChecking=accept-new`: the key is then pinned in your `known_hosts`, and a changed key is refused with a warning). What you type as the server is validated (`user@host[:port]` or a config alias) and passed as an argument, never through a shell; scripts run on the server are fixed text sent on standard input, with the few values that vary single-quoted.

The reverse tunnel puts the office's port on the server's **loopback** interface only. Any local user or process on that server can therefore reach the office's HTTP port there — and gets nothing without a credential: the owner API needs the owner token (which never leaves your computer), the agent endpoint needs the host credential, and the MCP endpoint needs a per-session token. On a server shared with people you do not trust, prefer a dedicated account. The agent enrols with a single-use, ten-minute token passed in the environment (not on a command line), and stores its credential in `~/.orchestrator/links/<id>/config.json`, mode 600. Removing the link stops the agent, deletes that folder and revokes the credential; revoking the machine under Machines has the same effect on access.

The host's `allowedRoots` (your home folder on the server unless you list others) bound where employees can be started and what the office can read there. Turning an attached session into a full employee types `/exit` into Claude Code — sessions the office did not start are never killed.

## Reading documents and browsing folders

The office can list the Markdown files in an employee's folder and show them, and can list folders on a machine so you can choose one when hiring. Both are read-only, go through the host agent, and stay inside that host's `allowedRoots`: only `.md`/`.markdown`/`.mdx` files are ever read, paths are resolved and must remain inside the employee's folder (a symbolic link that points elsewhere is not followed), files are capped at 512 KB, and hidden folders and dependency folders are skipped. What agents write is shown as formatted Markdown by a renderer that builds elements directly — no HTML from an agent is ever inserted into the page, and only `http(s)`/`mailto` links are clickable.

## The hi-fi (internet radio)

The office page may play audio from any `http(s)` address (`media-src` in its content policy) and nothing else from outside: scripts, styles, images and network calls stay limited to the office itself. Stations are saved in the settings (an owner's act), and only well-formed `http(s)` addresses with a name are kept. The hi-fi plays for the whole office: when an owner or a colleague switches a station on, every window in the office loads that station's stream itself. A request to play names a saved station by its id — an address that is not on the office's list is refused, and a visitor cannot switch at all — so no member below owner can make other people's windows load an address of their choosing. No audio passes through the office server. "What is on air" is asked by the office server, for saved stations only, with a five-second limit and a size limit; only a title of at most 200 characters is passed on to the page. Playing a station tells that station's server the IP address of everyone in the office who has not muted the hi-fi (a muted window does not load the stream), as any radio player does. The whip is local to the window: it calls nothing and records nothing.

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
