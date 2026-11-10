# ORCHESTRATOR

**Your code. Your company. Your world.**

A 3D virtual office where real Claude Code sessions work as employees. Each employee is a persistent identity backed by a real `claude` process in a real tmux session, in a real git worktree. You walk the office, look over a shoulder at a live terminal, sit down and take the keyboard of that exact session, answer questions, approve actions, assign work — and everything the office shows is derived from what the runtime actually reported.

This is not a dashboard with mascots and it is not a simulation: nothing in the UI is animated unless a hook, an MCP call, a tmux observation or an owner action says it happened.

```
 ┌──────────────── 3D office (Electron / browser) ────────────────┐
 │  React Three Fiber scene · HUD panels · xterm.js terminals     │
 └───────────────▲───────────────────────────────▲────────────────┘
        entities, events, monitor frames      terminal stream + input
                 │            WebSocket + REST  │
 ┌───────────────┴────────── Orchestrator server ─────────────────┐
 │ hosts · sessions · employees · terminal gateway (ownership)    │
 │ hook receiver · tasks/scheduler · approvals · collaboration    │
 │ meetings · progression · self-improvement · MCP endpoint       │
 │ SQLite or PostgreSQL: entities, events, credentials, audit     │
 └───────────────▲────────────────────────────────────────────────┘
                 │ one outbound, authenticated WebSocket per machine
 ┌───────────────┴──── orchestrator-agent (per machine) ───────────┐
 │ tmux control mode · Claude Code launcher · hook socket          │
 │ git worktrees · verification runner · resource sampling         │
 └───────────────▲─────────────────────────────────────────────────┘
                 │ tmux panes
        claude   claude   claude   …   (real interactive sessions,
                                        or SDK-managed workers)
```

## Quick start (one machine, nothing leaves localhost)

Requirements: **Node.js 22.18+**, **tmux**, **git**, the **Claude Code CLI** (`claude`) logged in, and pnpm.

```bash
pnpm install
pnpm build          # bundles the server + agent and builds the office UI
pnpm start --open   # server + local host agent; opens the office in your browser
```

or, as a desktop app: `pnpm desktop`. To get something you can hand to another machine, `pnpm package` builds a portable tarball (macOS/Linux) and a macOS `.app`/`.dmg` in `release/`.

Then in the office, either way of working is fine — they share the same state:

**Talk to an employee directly (the "cubicle" model).** Every employee can live in a folder and own the project in it.

1. **Menu → Team → Hire** — a name, a role and a **folder** (use *Browse…*). That folder becomes their project, and they work in it in place. New hires are on **Auto**: they do not ask for permission, only for decisions.
2. Walk to their desk (`W`/`S` to walk, `A`/`D` to turn, `Q`/`E` to sidestep) and press `F` to **talk**: tell them what to do in plain words. Your message goes into their real Claude Code session; their reply comes back in the conversation. Tick *Track as a task* when you want the work verified before it counts as done.
3. Press `Space` instead to sit at their terminal and watch it, and **Take control** if you want the keyboard. The folders on their desk are the Markdown files in their folder — click them to read.

**Extras.** The **hi-fi** in the break room (or **Menu → Hi-fi**) plays internet radio in your window: pick a station, or add any direct stream address; a small player in the top bar shows what is on and stops it. `R` next to an employee cracks a whip — a sound, a flinch and a “jao!”, and nothing else: it sends nothing to their session.

**Let Orchestrator manage a team on a shared project.**

1. **Projects → New project** — point it at a git repository and give it a verification command (e.g. `npm test`). Shared projects give each employee an isolated worktree and merge finished work for you.
2. **Team → Hire** several roles into that project.
3. **Tasks → New task**, or press `G` and type *“Assign Alex to fix the authentication bug”* / *“Build the customer system. Split the work between backend, frontend, QA and security.”*

To set up a whole example team in one go:

```bash
pnpm apply-config examples/team.json --repo ~/code/your-repo --plan
```

More: [docs/INSTALL.md](docs/INSTALL.md) (remote machines, TLS, services, Windows/WSL).

## What you can do

| In the office | What really happens |
| --- | --- |
| Walk up to a desk, press `F` and say what you need | Your words are pasted into that employee's real session; the reply shown is the final message of the turn, as reported by Claude Code's `Stop` hook |
| Walk up to a desk, press `Space` | Your client subscribes to that pane's output through tmux control mode; you see the live terminal, read-only |
| **Take control** | The server grants you exclusive input ownership; your keystrokes go to that same tmux session with `send-keys`. The Claude process is never replaced |
| **Return control** | Ownership is released; anything Orchestrator held back while you typed is delivered |
| Assign a task | A worktree and task branch are created, the session is started if needed, the prompt is pasted into the terminal, and delivery is confirmed by Claude Code's `UserPromptSubmit` hook |
| An employee raises a hand | The agent called `ask_boss`, or Claude Code raised a `PermissionRequest` / `AskUserQuestion` — the real request is held open until you answer |
| Answer from the office | The answer is returned as the tool result or hook decision; it is marked confirmed only when the runtime acts on it |
| A task turns DONE | Orchestrator itself checked a clean tree, real commits, ran your verification command on the host, got review approval if required, and merged without conflict |
| An employee walks to a colleague | A real `request_collaboration` was sent through the MCP server and delivered into the colleague's session |
| The start screen: **My office** / **Join someone's office** | Your own office starts on this computer. Joining needs an invitation: the app connects only to the computer whose certificate the invitation names, with a guest credential that is not the owner's token |
| Menu → People → **Open the office to guests**, **Invite** | A second, TLS listener starts on your network that forwards only the page, the API and the client socket. A *visitor* can look and talk to people; a *colleague* can also watch terminals, talk to employees and create tasks. Approvals, terminal keyboards, hiring, machines and settings stay with you |
| Other people walking around | Each person's app reports where their character is; the office relays it. What they say (Enter) is heard by the people present — never typed into an employee's session |
| Team → **Hire for several projects** | One employee per folder you tick, named after the folder; each folder becomes that employee's own project. Nobody's session is started by hiring: it starts when you first talk to them or give them work |
| An empty chair → `Space`; right-click → **Move to another desk…**; Office → **Who sits where** | Only the employee's desk changes (a swap if someone sits there). Their session, project and work are untouched |
| The TV in the break room | A real browser inside the window (desktop app): its own storage, no access to the office or your files, camera and microphone refused. Put away, it keeps playing; the screen on the wall shows its real picture |
| Machines → Connect a server over SSH | The office runs `ssh` as you (keys only), copies the host agent to the server and keeps a reverse tunnel open; the server enrols with a single-use token and its Claude Code sessions become employees. No port is opened anywhere |
| An employee hands a task to a colleague | The agent called `hand_off_task`: its work had to be committed, the task branch moves to the colleague's worktree, and the notes travel with the task |
| Projects → Integration | After each merge your verification command also runs on the integration branch; **Bring in main** merges the base branch in, **Promote to main** fast-forwards the base branch to it — refused while tests fail, when it is not a fast-forward, or over uncommitted changes. Nothing is ever pushed |
| Terminals → Operations | Build results are the office's own verification runs; deployments are commands that really ran in a terminal, with their exit status; git activity is commits and merges measured on the machines |
| A security notification | Claude Code refused an action, a known credential format went through a session (it is redacted in the records), a machine was refused a connection, or someone presented wrong owner tokens |
| A **Foreman** walks to someone's desk | The foreman's own session called `look_at` for that employee and was shown the last lines of their real terminal, their task and their open question. It walks back when its round is over |
| An employee's question is answered without you | The foreman's session called `answer_question`; the employee gets the answer as usual and the record says the foreman gave it. Approving or denying an action is never the foreman's |
| Meeting room | Each participant's session writes a proposal and a response; the facilitator's session writes the decision document and follow-up tasks |
| Growth | Workers record lessons after real friction; Orchestrator proposes policy and process changes from its own history |

## Honesty rules the code enforces

- **Backend is the source of truth.** The 3D layer receives view models and callbacks; it cannot reach sessions or tasks.
- **Unknown is shown as unknown.** A session without hooks, or on a host that is offline, is `UNKNOWN` — never “working”.
- **Delivered ≠ confirmed.** Messages, tasks and answers move `queued → sent → confirmed`, and *confirmed* requires a signal from Claude Code.
- **Measured, reported, unavailable.** Verification results are measured on the host; an agent's summary is “reported”; token usage is read from the real transcript or shown as “not available”. Cost is never invented. **How much Claude is left** on each account (5-hour and weekly percentages, exactly as Claude Code reports them) is shown at the CEO desk; employees can be put on different Claude accounts.
- **Autonomy never bypasses permissions.** Autonomy levels map to Claude Code's own permission modes and allow-rules. High-risk commands are escalated at every level. `--dangerously-skip-permissions` is never used.

## The foreman

Hire an employee with the role **Foreman** (give them any folder: it is only where their Claude Code session runs) and switch on **Settings → Foreman → Foreman rounds**. From then on the office is run for you between your own visits:

- **The office decides when, without any model.** Every few seconds it works out from its own records what needs attention: an employee's question nobody has answered, a blocked task, someone idle for five minutes with a task in progress, ready work that nobody has while somebody is free. Only when that list holds something *new* — and the previous round is over, and the gap you set has passed — is **one** prompt delivered to the foreman's session. The prompt carries the digest itself, so a simple round needs a handful of tool calls. A quiet office starts no round and costs nothing.
- **The foreman acts through its own tools**: `office_overview`, `look_at` (an employee's real terminal screen, task and recent events), `answer_question`, `assign_task`, `create_task`, `send_message`, `escalate_to_owner`, `finish_round`. Everything it does is on the record under its name.
- **You are asked only about direction.** The foreman answers operational questions itself and escalates what is yours: direction, product or policy, anything destructive or irreversible, anything it is not sure about. An escalated question stays open in your inbox. You can always answer first — whoever answers first counts.
- **It never approves anything.** Permission requests stay with you and with each employee's autonomy level; the foreman has no tool that could decide one, and cannot edit files or type into anybody's terminal.
- **Cost.** Each round is a real turn in the foreman's Claude Code session and uses the Claude usage of the account that session runs on (you can put the foreman on its own account). An item the foreman has already seen does not start another round. Optionally, with nothing waiting, it takes one look around every *N* minutes if tasks or sessions changed since its last round (default 15; 0 = never).

Off by default. *Settings → Foreman* shows who the foreman is, the last round and its summary, and what currently needs attention (`GET /api/foreman`).

## Self-improvement

- **Workers**: after a task that hit real friction (failed verification, rejected review, merge conflict, a question, a denial), the employee's own session is shown the recorded facts and asked what it would do differently. Lessons are stored with their evidence, fed back into that employee's future prompts, and counted. Your answers to questions become project knowledge so nobody asks twice.
- **Orchestrator**: routes unassigned work using measured first-pass rates per employee and task kind, and proposes changes from its record — pre-approve a command you keep approving, require review where work keeps failing, sequence tasks that keep colliding. Anything that widens what agents may do waits for you.

## Repository

```
apps/
  server/        HTTP + WebSocket server, MCP endpoint
  host-agent/    orchestrator-agent CLI and daemon
  desktop/       Electron shell + React app
packages/
  contracts/     shared types, event schema, protocol
  execution/     tmux control client, Claude Code launcher, git, verification
  orchestration/ engine: registries, hooks, tasks, approvals, meetings, commands, self-improvement
  terminal/      terminal gateway and input ownership
  integrations/  hook normalisation, MCP protocol + tool catalogue
  database/      SQLite store, event store, credentials, audit
  game-systems/  XP, levels, milestones
  office-3d/     the 3D scene (pure view)
  ui/            UI primitives
tests/
  e2e/           end-to-end tests against real tmux, hooks, MCP and git
  fixtures/      scripted stand-ins for the CLI and the Agent SDK, used only by tests
  real/          checks against the real Claude Code CLI and the real Agent SDK
  ui/            the built UI driven in Electron with real clicks against a live office
  linux/         the agent on Debian in a container, enrolled over TLS
docs/            architecture, install, security, Claude Code integration
```

## Tests

```bash
pnpm test                  # unit tests
pnpm test:e2e              # 111 end-to-end scenarios: real server, real agents, real tmux, real git; scripted worker
pnpm test:ui               # the UI used for real in Electron (clicks, typing, keys) against a live development office
pnpm package && pnpm package:smoke   # build the tarball and macOS app, then run them (incl. the connect screen)
pnpm package:linux         # .deb and Linux desktop bundles;  pnpm test:linux:deb / test:linux:desktop run them (Docker)
pnpm package:windows       # Windows desktop bundles (not runnable here)
pnpm package:notarize      # sign with your Developer ID and notarize the macOS app (--check lists what is missing)
pnpm test:linux            # the agent on Debian in a container (needs Docker)
pnpm test:ssh              # a server reachable only over SSH is linked, used, disconnected, reconnected and removed (needs Docker)
pnpm test:machines         # three machines, three operating systems, one office; includes a real network partition (needs Docker)
pnpm test:real             # the acceptance scenario against the real Claude Code CLI (uses a little of your usage)
pnpm test:real:approvals   # real permission approval / denial / AskUserQuestion answered from the office
pnpm test:real:talk        # hire into a folder, say something, get the real reply
pnpm test:real:team        # two real sessions: implement, review by the second one, merge, then a meeting (…:team:sdk for SDK workers)
pnpm test:real:flows       # unanswered approval, Stop-hook delivery, retrospective, merge conflict — with the real model
pnpm test:real:flows2      # dependent task, nudge, request between employees, rejected review → rework, restarts mid-work
pnpm test:real:sdk         # an SDK-managed worker with the real Agent SDK (needs `orchestrator-agent sdk install`)
```

`tests/fixtures/fake-claude.mjs` behaves like Claude Code at the protocol level (runs the configured hooks, calls the MCP endpoint, edits files, commits) and `tests/fixtures/fake-agent-sdk` does the same for the Agent SDK's `query()`, so the whole system can be tested deterministically without tokens. Neither is ever used by the product.

## Status and limits

Working and verified on macOS (Apple silicon) with Claude Code 2.1.321/2.1.322 and tmux 3.8; the host agent, the `.deb` and the desktop bundle are also verified on Linux (Debian 12, Ubuntu 24.04). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#status) for exactly what was and was not validated. In short: both worker runtimes; reviews, rework, meetings, retrospectives, merge conflicts, nudges and restarts with real sessions; three machines on three operating systems with a real network partition; PostgreSQL; and every package except the Windows one were run for real. Three things could not be done on the development machine: running anything on Windows itself, testing on physically separate computers, and notarizing the macOS app.
