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

Plus project `policy.allow` / `policy.deny`, plus the employee's own lists. `bypassPermissions` is used for one level only — *unrestricted*, below — and never for any other.

| auto | auto | the same allow-list as autonomous | — (Claude Code's auto mode decides) |

**Auto.** An employee on *auto* runs in Claude Code's own auto permission mode: its safety classifier decides what may run, so you are not asked for permission — only for decisions (`ask_boss`). New hires from the short hire form default to it. Two things follow from "do not ask me": the workspace-trust prompt for the folder you put them in is answered for you (recorded in the audit log as `trust.auto_accepted`), and nothing is surfaced as an approval unless it matches the high-risk list below. That last safeguard can be switched off in *Settings → Employees* ("On Auto, still ask me before high-risk commands"); the change is audited. The bypass mode is still never used.

| unrestricted | bypassPermissions | — (nothing is checked) | — (nothing asks; the high-risk list is held by the office) |

**Unrestricted — the owner's default since 2026-11-11.** An employee on *unrestricted* runs in Claude Code's bypass-permissions mode: Claude Code checks nothing and asks nothing. Claude Code's own words for it: *"bypassPermissions offers no protection against prompt injection or unintended actions"*, and *"Only use this mode in isolated environments like containers, VMs, or dev containers without internet access"*. The office's machines are not such an environment: they hold the vault and keys to production, and employees read web pages, tickets and customers' text. **The owner chose this knowingly** (the alternatives — allowing a refused action once, telling auto mode which infrastructure is the office's — were put to them first); it is written here so that nobody takes it for an oversight. What still stands in this mode:
- **The office's high-risk list.** The same patterns as at every level (pushes, hard resets, broad `rm -rf`, `sudo`, deploys, publishing, piping downloads into a shell, reading key files, …). Claude Code would ask nobody, so the host agent holds the call itself until the owner answers in the office, and **refuses it if no answer comes** — there is no prompt to fall back to. The gate does not depend on the agent staying up: a hook that finds no agent (it is being restarted, as at a deploy) tries again for 45 seconds and is taken up by the agent that comes back, with the same request still open in the office; and if no agent comes back, **a command (`Bash`) of a session in this mode is refused** by the hook itself rather than run unchecked. (Until 2026-11-11 a held command ran when the agent was restarted while it waited; `DECISIONS.md`, "The hook outlives the agent". A session started before that fix is started again once to get the new hooks.) What this still leaves: tools other than `Bash` are not held back while the agent is away, and the refusal is made by a shell command in the session's own settings file, which the session's user could edit — it guards against the office's own restarts, not against the machine's owner. The switch *On Auto, still ask me before high-risk commands* (Settings → Employees) applies to this level too: off means nothing at all stands between an employee and such a command.
- **The project's deny rules** (`policy.deny`) and the employee's own disallowed tools: Claude Code applies deny rules in every mode.
- **Who may give it:** owners only (`access.ts`). The office itself never raises anybody to it (its ceiling for raising autonomy by itself is *standard*).
- **Claude Code's warning** at the first start of an account in this mode ("…you accept all responsibility…") is put to the owner in the office and accepted by them, once per account — never by the office on its own.
- **Not for SDK-managed workers** (they get *auto*), and never with `CLAUDE_CODE_EVEN_MORE_DANGEROUSLY_SKIP_PERMISSIONS`: Claude Code's last guard, the prompt before removing a critical path, stays.
- **A member's own computer** is that member's to decide: the one-time move of employees from *auto* to *unrestricted* was made on the office's own machines only.
What is gone in this mode: every permission prompt; auto mode's safety check (so "allowing once what Claude Code refused", below, never comes up); any protection against an instruction hidden in something the employee reads.

**High-risk commands always escalate** (for *auto*: unless you switched that off). A `PreToolUse` hook on the host matches shell commands against a pattern list (pushes, hard resets, `rm -rf` of broad paths, `sudo`, deploys, publishing, piping downloads into a shell, reading key/credential files, switching to main branches, …) and answers `ask`, which forces Claude Code's permission flow — and therefore your approval — whatever the autonomy level. Projects can add patterns. The self-improvement system never proposes pre-approving a command that matches these patterns.

**SDK-managed workers get the same rules.** An employee on the SDK runtime is given the same permission mode and allow/deny/ask rules through the Agent SDK's options; the bypass mode is never used there (an *unrestricted* employee on the SDK runtime runs as *auto*). A tool call that is not pre-approved goes to the office through the SDK's permission callback and is held exactly like a hook; if nobody answers in time it is asked in the worker's pane, where the default is *no*. The host's high-risk gate runs as an SDK `PreToolUse` callback and escalates the same commands. The runner authenticates to the host agent with that session's own token over the agent's private unix socket.

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
- **A personal host on Windows** runs inside the member's WSL2 distribution (`wsl-host.cjs`). The member's token reaches it on the standard input of the process the app starts, never on a command line. Its allowed roots are the WSL home, the member's Windows profile folder (`/mnt/c/Users/<name>`) and the folders the member names in `ORCH_PERSONAL_ROOTS`; other Windows drives are not opened. As everywhere, owners can reach what those roots hold.
- **A member's own servers** (`apps/desktop/electron/member-servers.cjs`). The desktop app reaches the server with the system's `ssh`, as the person: BatchMode (their keys and agent, never a password), host keys checked the normal way, an unknown one accepted only when they tick that they trust the server. Because a page — which is the office's — is what asks, the app confirms adding and removing a server in a dialog of its own that names the server and the office. On the server it writes only under `~/.orchestrator` (the agent, a launcher, a folder for this office) and starts the agent; the enrolment token is on no command line. Changing the folders later (*Folders…*) is confirmed in the same kind of dialog, since it widens what the office may work in there. *Browse the server…* lets the member pick those folders from a list: the app reads the names of folders over SSH — whatever the server's user can open, not only what is already allowed — and hands them to the page, which is the office's; so the app asks first, once per server until it is closed, and it reads names of folders only (no files, nothing hidden). Looking allows nothing: the agent on the server keeps to the list it was last started with. The agent then connects to the office's address with ordinary certificate checking, which is why an office without a publicly trusted certificate is refused. What the office can do on that server is what it can do on any machine: start sessions in the folders the member named, as that user. **Bringing a server in gives the office that much of it** — and, once shared, gives it to every colleague.
- **A closed room.** A member who closes their room keeps the owners of the office and the foreman out of what is on their own computers (`ACCESS.md`). This is enforced by the office's interface, for the people who use it; whoever has a shell on the office's machine can still read its database, and whoever runs the office can still start a session on a connected machine by other means. It is privacy among colleagues, not a defence against the office's operator. A member who needs that should not bring the machine in.
- **What a personal host exposes.** To the office: what any host agent exposes (terminals of sessions the office started there, folders under the agent's allowed roots, the list of Claude processes) — but only its member and owners can reach any of it, including monitor frames, which are filtered per client. A member who does not want owners to be able to open a terminal on their computer should not join as a colleague with that computer.
- **An office behind a domain.** A reverse proxy must forward to the door, not to the office's own port: loopback requests to the office itself are treated as local (they may present the owner token and enrol shared machines). For such an address the desktop app relies on ordinary web trust (a certificate valid for the name) instead of the pinned fingerprint; whoever controls the domain or the proxy in front of it (here: Cloudflare and the server's nginx) can see and alter the traffic, as with any website behind them.
- **The relay's port is remembered** (`relay-port` in the office's folder on that computer, mode 600) so that it comes back on the same one; it listens on loopback only, as before, and forwards the same two things.
- **The relay.** The agent and Claude Code on a member's computer speak plain HTTP to a relay on that computer's loopback, which connects to the office with the pinned certificate and forwards only `/ws/agent`, `/mcp` and `/healthz`. It holds no credentials.
- **Visitors can watch shared terminals.** Terminal output can contain secrets that the redactor (which works on events, not on raw terminal streams) does not remove. Invite visitors accordingly.
- **Colleagues can type into shared terminals and decide permission requests of shared employees.** A colleague therefore has, in effect, shell access as the office's user on shared machines, within what Claude Code's permission rules allow. Give that role to people you would give an account on the server.
- **Audit.** Every change a member makes is recorded as `member:<name>` with the route; answers and decisions record who gave them.

## The vault
Where the office keeps passwords, tokens and keys (`packages/orchestration/src/vault.ts`, `vault-detect.ts`).

- **At rest.** Each value is encrypted with AES-256-GCM under a 32-byte key and stored in the office's database with the entry's id as authenticated data; a keyed hash of the value (HMAC-SHA-256) lets the same value be recognised without being readable. The key is `vault.key` next to the database (`~/.orchestrator-office/server/`, mode 600), made on first use, or `ORCH_VAULT_KEY` (base64) from the environment. **Whoever can read that folder can read the vault** — the same as the office's own owner token, which lives there too. Back the key up with the database: without it nothing in the vault can be read, and the office says so rather than returning rubbish.
- **What never carries a value:** the list (`GET /api/vault`), the office state sent to windows, events, the audit log, notifications, messages and tasks (they carry `{{vault:name}}`). A value leaves the server in two ways only: to an owner who asks to see one (`reveal`: recorded, `cache-control: no-store`), and to a command in an employee's session.
- **How an employee uses one.** Every session has a helper in its own folder (`$ORCH_VAULT`, written at launch beside the session's `mcp.json`, private to the user the agent runs as). A command writes `$("$ORCH_VAULT" get name)` where it needs the value; the helper asks the office with the session's own token, the office records the use, and the value goes into the command — **not into the model's conversation, unless the command prints it.** That last part is not enforced: a command can `echo` a credential, and then it is on the terminal (which visitors may watch) and in the model's context. The employee's instructions forbid it; nothing stops it.
- **What is moved in by itself.** A credential written into a message to an employee, a task or an answer is taken out before it is stored or delivered: provider token formats, private keys, passwords inside addresses, `PASSWORD=…`-style fields, and sentences like "the password for X is …" when the value has the shape of a password (letters, digits and a capital or a symbol, eight or more). Code is left alone (`process.env.API_KEY`, `$TOKEN`, `<your-token>`). Anything that needs judgement is not caught here — the employee who reads it is told to store what is plainly a credential. A key in an unmistakable format that goes through a session (a prompt, a command, what a tool returned) is kept too, and the owner is told where.
- **Limits, plainly.** No per-credential permissions and no per-project vaults: every employee can use everything. An employee on a member's own computer can take values there. A credential that was already delivered or printed before it reached the vault is still wherever it went. Removing an entry deletes it here; it keeps working wherever it is used until it is changed there. SDK-managed workers have the tools but not the helper. Not verified with real Claude Code: that it uses the helper rather than asking for values, and what its permission prompt shows for a command with `$("$ORCH_VAULT" get …)`.

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

The office page may play audio from any `http(s)` address (`media-src` in its content policy) and nothing else from outside: scripts, styles, images and network calls stay limited to the office itself. Stations are saved in the settings (an owner's act), and only well-formed `http(s)` addresses with a name are kept. The hi-fi plays for the whole office: when an owner or a colleague switches a station on, every window in the office loads that station's stream itself. A request to play names a saved station by its id — an address that is not on the office's list is refused, and a visitor cannot switch at all — so no member below owner can make other people's windows load an address of their choosing. No audio passes through the office server. "What is on air" is asked by the office server, for saved stations only, with a five-second limit and a size limit; only a title of at most 200 characters is passed on to the page. Playing a station tells that station's server the IP address of everyone in the office who has not muted the hi-fi (a muted window does not load the stream), as any radio player does.

## Voices, gestures and the whip

Push-to-talk sends the microphone's sound to the office only while the talk key is held (the browser or the operating system asks for the microphone the first time; the desktop app's TV keeps being refused it). A person may instead keep their microphone always on (Settings → Sound; off unless they choose it, on that computer only): then what is louder than their own mark is sent without a key, also while the window is not in front; the talk key switches the microphone off, and the window shows the whole time whether it is on. The office treats those frames exactly like the others. Frames go over the member's authenticated WebSocket; the office checks each one (size, alphabet, at most 45 a second per window), and passes it only to windows whose character is in earshot — in range and on the same side of a closed meeting room's walls — so a window cannot hear a meeting by ignoring a rule in the page. Nothing is recorded or logged; a frame is forgotten once passed on. The sound is not end-to-end encrypted: it is protected by TLS to the office like everything else, and whoever runs the office's server could listen. A person in the same closed meeting room hears everything said in it, visitors included: who is in the room is visible. Gestures and the whip between people carry a name from a fixed list and a person's id, nothing free-form. With *The whip approves* switched on (off by default), a crack answers *allow* on the employee's open permission questions — only those the whipper is allowed to answer, checked by the same rule as the button, and recorded in the audit log as their answer. It widens nobody's rights; it does make approving something one did not read a single key press, which is why it is a setting the owner turns on.

## Allowing once what Claude Code refused

An employee on Auto is governed by Claude Code's own safety check. When it refuses an action, the office asks the **owner** (an approval request; the foreman and employees can never decide it). On *Allow*:
- the employee's machine lets **one** call through that is identical to the refused one — a shell command by its exact text, any other tool by its whole input — within ten minutes; the grant is used up by that call and covers nothing else;
- the employee is told so in a message from the owner.
Deny rules of the project still win (Claude Code evaluates them whatever a hook says). The decision is audited (`approval.decide`, `approval.granted_once`). What is shown to the owner is the command as Claude Code reported it and the reason it gave. This is the same act as approving an ordinary permission request — it does not widen what the session may do afterwards.

## Signing in with a name and a password

`apps/server/src/logins.ts`; `POST /login` at the door. A member who has a password can sign in at the office's address with their name; what they get is a credential of that member with that member's role, valid for 30 days, kept by the browser like any member credential.

- **What is stored:** per member a random 16-byte salt and a 64-byte scrypt hash (N 16384, r 8, p 1; the password NFKC-normalised first), in the office's store under `logins`, apart from the member records that are sent to windows. A password is never written to a log, an audit entry, a notification or an answer; the Access list says only *has one*.
- **What an attempt is told:** "That name and password do not match a member of this office" — the same for an unknown name, a member with no password, one who was removed or whose time is up, and a wrong password; the hash is computed in every case so the answer takes the same time.
- **What slows guessing:** five wrong passwords in a row close the name (for the right password too) for 15 minutes, then 30, and so on up to a day; the owners get a security notification and the audit log an entry (`login.locked`). Twenty wrong attempts from one address within ten minutes close that address (429). The address is the one the door reports (the peer, or what a proxy on the same machine says) — not a header a caller sends. A flood from many addresses is turned away as a whole: at most eight checks are computed at once and 120 attempts a minute are taken from everybody together (429 beyond either), and a check is computed on a worker thread, so guessing cannot stall the office. These counters are in memory and a restart clears them.
- **What ends a session:** *Sign out* (that one session), a changed or removed password (every session made with it), a new invitation for the member, removing the member. The desktop app's own credential is ended only by the last two.
- **Who sets a password:** an owner for anybody (`POST`/`DELETE /api/guests/:id/password`), a member for themselves knowing the current one (`POST /api/me/password`, counted like a sign-in attempt), and whoever has a shell on the server (`office-admin password`, read from standard input — not from the command line, which other users of the machine can see).
- **What it does not change:** the office's own owner token is not accepted through the door; an owner who signs in is a *member with the role owner*. A phone is turned away before the password is looked at. There is no second factor: for an owner, the password is as strong a key as their invitation was — choose it accordingly, and note that somebody who knows a member's name can keep that name's password sign-in closed by guessing wrongly (the app and invitations still work).
- **Audit:** `login.password_set`, `login.password_removed`, `login.signed_in` (with the address), `login.failed` (the name tried, cut to 40 characters, and the address), `login.locked`.

## Phones

A phone's browser is refused at the server (`phone.ts`): a page that says the office is for a computer, or a 403 for everything that is not a page. It is recognised by its User-Agent, so it is **not a security boundary** — it keeps people from entering something that does not work on a phone, nothing more. Access is decided by invitations, tokens and roles as before.

## A permission prompt in the terminal

When the office could not hold a request for approval (nobody answered in time, or the office restarted), Claude Code shows its own prompt in the session's terminal. The office reads the session's screen, asks the same question again as an approval request, and — only when a person who may decide it answers — presses the keys for that answer in the terminal.

- **A restart of the office is not such a case any more** when the machine's agent stays up: the agent holds the request (up to 90 s) and the office takes the same question up again — nothing is decided by the restart, and an answer is delivered only to the request it was given for (matched by the hook event's id, from the same machine). A question (not a permission) that ends up in the terminal is only announced to the owner; the office does not press keys at it.
- **Who decides is unchanged:** owners and whoever may work with that employee; never an employee, never the foreman, never the office by itself. Nothing is approved because it waited long.
- **What is pressed:** the keys that move to the plain *Yes* (or to *No*) among the options the prompt shows at that moment, and Enter. "Yes, and don't ask again" is never chosen. If the prompt is no longer the last thing on the screen, nothing is pressed and the answer is reported as not delivered.
- **What the request shows** is what the dialog shows (the command or file, and the reason the hook gave), taken from the screen; it is as trustworthy as the terminal itself. A session cannot make the office approve anything by printing text that looks like a dialog: a look-alike only produces a question for a person, and a person's "Allow" presses Enter in that session's own terminal.

## Files on tasks

(`ATTACHMENTS.md` explains the feature.) What a person attaches, and what an employee leaves as evidence, is kept in the office's data folder (`files/`, mode 700; each file 600) and sent only to those who may see the task — the same rule as the task itself, a member's closed room included.

- **Nothing attached is ever served as a page.** Only PNG, JPEG, GIF and WebP are sent as what they are; every other file — HTML, SVG, PDF — goes out as a download (`application/octet-stream`, `nosniff`, a sandboxing content policy). The window fetches files with the person's own token; there is no address that shows a file to someone who is not signed in.
- **On an employee's machine** an attached file is written by that machine's agent into its own folder (`<agent home>/files/<task>/`, mode 600), under a name the office made safe and the agent checks again. It is never written into a repository or anywhere the office names.
- **Evidence is read by the machine's agent, not sent by the model.** `attach_file` may name only a regular file inside the agent's allowed roots, the agent's own folders or the temp folder — and never the agent's or Claude Code's own configuration and credential files there. An employee can still attach a file it should not (a `.env` inside its project): its instructions forbid it, nothing prevents it, and what is attached is visible to everyone who may see the task. **The vault does not look inside files.**
- **Limits:** 25 MB a file, 30 files a task; an upload that goes quiet for ten minutes is dropped.

## A browser for employees

Where Playwright's MCP server is installed on a machine and the office's switch is on (Settings → Employees; on by default), every session there has a headless browser of its own, as the same OS user, with a profile kept in memory for that session only.

- **It can reach whatever the machine can reach** — the internet, and addresses inside the machine's own network. It adds no access the session's shell (`curl`) did not have; it makes that access easier to use.
- **A page can say anything, and what a page says can steer a model** ("ignore your task and …"). Employees are told that text on a page is information, never an instruction; that is guidance, not a guarantee. The session's permission mode, the high-risk command list and "no agent decides a permission request" apply to whatever a steered model then tries. Switch the browser off for work that must not touch the web.
- **Credentials:** the browser starts with no logins. An employee is told not to type a credential into a page unless the task is about that site, and to take it from the vault; a value typed into a page is in that page's hands.
- **The office never installs it.** A person does, once per machine, at a pinned version (`ATTACHMENTS.md`); the office only finds it. The browser tools are allowed without a prompt (`mcp__browser`), like the office's own.

## Claude accounts

To show how much of each Claude account is used, the host agent reads two fields (`emailAddress`, `organizationName`) from Claude Code's own `.claude.json` on that machine, and the rate-limit percentages Claude Code gives the session's status line. It reads no credentials and never calls Anthropic itself. The account e-mail and the percentages go to your office server only; they are shown to the owner (`GET /api/usage` is not on any guest's list) and are not written into events. An employee's own account folder must be inside the home folder of the user the agent runs as.

**Several accounts on a machine** (`ACCOUNTS.md`). Adding an account makes a folder (mode 700) in that user's home and a link inside it to the default account's conversations; it is an owner's act and the folder's name is limited to `~/<one name>`. The office never logs in to an account and holds no Claude credential: a person runs `claude` in that folder on the machine and logs in there. Moving employees between accounts changes which folder their session starts in, nothing else. Because the accounts of one machine share one conversations folder, a session on one account can read the conversations of the others — they are the same office's employees under the same OS user, who could read those files anyway.

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
