# Architecture

Orchestrator is three layers with a strict direction of truth:

| Layer | What it is | Owns |
| --- | --- | --- |
| **A. Execution** | Real Claude Code processes in tmux panes on enrolled machines, observed and driven by `orchestrator-agent` | The actual work |
| **B. Orchestration** | The server: registries, hook receiver, scheduler, approvals, collaboration, persistence | The truth about that work |
| **C. Office** | The 3D scene and HUD | Nothing. It renders B and sends the owner's intent back |

The office is never a source of execution state. `packages/office-3d` receives view models (`PersonView`, `BoardView`, …) and callbacks; it has no import path to sessions, tasks or the network.

## Core concepts

- **Employee** — persistent identity: name, role, appearance, desk, autonomy, playbook, XP. Outlives any session.
- **Agent session** — one real process in one tmux pane. `managed` (started by Orchestrator) or `attached` (an existing tmux session connected non-destructively).
- **Host** — a machine running `orchestrator-agent`, enrolled with a revocable credential.
- **Task** — work with acceptance criteria, a branch, dependencies and evidence.

An employee whose session ends stays in the office, shown `OFFLINE`, until the session is resumed (same Claude conversation, same tmux session) or replaced.

## Layer A — execution (`packages/execution`, `apps/host-agent`)

### Terminals: tmux control mode

Each tracked session gets one `tmux -C attach` control client (`ControlClient`). tmux pushes every byte the pane emits as `%output` notifications; input goes in with `send-keys`. No PTY wrapper, no process in between — Orchestrator is just another tmux client, so attaching, detaching, crashing or restarting the agent never touches the Claude process.

- **Stream** (`PaneStream`): output chunks are numbered with a monotonic `seq` (seeded from the clock so it keeps increasing across agent restarts).
- **Snapshot**: a late-joining viewer gets scrollback + visible screen (`capture-pane -e`), terminal modes and cursor position. The capture runs through the control connection, so it is ordered against `%output`; the `seq` recorded at the instant the capture completes tells the viewer exactly which chunks to apply afterwards. Viewers buffer recent chunks and replay any that overtook the snapshot.
- **Monitor frames**: a low-rate plain capture (at most ~1/s per session, only when output changed) drives the in-world monitors. The server throttles frames further for sessions a client is not standing next to; the client redraws by distance and falls back to coloured bars far away.
- **Input**: raw xterm.js data is translated to `send-keys -H` (ASCII bytes, including escape sequences) and `send-keys -l` (non-ASCII). Prompts are delivered as one bracketed paste (`load-buffer` + `paste-buffer -p`) followed by Enter.

### Launching Claude Code

`planClaudeLaunch` turns a `LaunchSpec` from the server into exact argv and per-session files (mode 0600, in the agent's state directory — the project's own `.claude/` is never modified):

- `settings.json` — permission rules and **hooks**. Each hook is a `curl` to the agent's private unix socket carrying the session's token and `$TMUX_PANE`. If the agent is down the hook is a no-op and Claude Code behaves as if no hook were installed.
- `mcp.json` — the Orchestrator MCP server (HTTP) with a bearer token scoped to this session. With `--strict-mcp-config` by default, so workers do not inherit the owner's personal MCP connectors.

- `claude-launch.sh` — the command itself, each argument in single quotes. The pane runs `/bin/sh` on this file instead of being given the command: tmux refuses a command longer than about 16 KB, and the instructions in `--append-system-prompt` alone outgrow that (DECISIONS.md, "A session's command is run from a file…").

Flags: `--session-id <uuid>` (or `--resume <uuid>` after a crash), `--permission-mode`, `--append-system-prompt`, `--model`, `--name`. Environment markers of a parent Claude Code session are stripped so each worker is a top-level session.

Hook events are version-gated (`HOOK_EVENTS`): events newer than the installed CLI are not written into settings.

### Git and verification

`ensureWorktree`, `startBranch`, `mergeBranch` and `runVerify` run on the host. Repository mutations by Orchestrator are serialised per host. A merge that conflicts is aborted and reported. Operations are refused outside the agent's `allowedRoots`.

### Agent ⇄ server

One outbound WebSocket per host, authenticated by its first message. Non-blocking hook events go through a persisted outbox and are redelivered until acknowledged (at-least-once); the server deduplicates by event id (exactly-once effect). Blocking hooks (`PermissionRequest`, `AskUserQuestion`, `Stop`) are held open by the agent while the server — possibly the owner — decides; if the link drops they resolve to "no decision" and Claude Code falls back to its own terminal prompt.

## Layer B — orchestration (`packages/orchestration`)

| Module | File | Responsibility |
| --- | --- | --- |
| Host registry | `registry.ts` | enrollment tokens, credentials, connect/disconnect, revocation, resources |
| Session registry | `registry.ts` | reports from hosts, start/stop/resume, attach/bind, pause/resume, trust prompt |
| Employee registry | `registry.ts` | identities, desks, appearance |
| Terminal gateway | `packages/terminal` | viewers, snapshots, **input ownership** |
| Claude Code adapter | `prompts.ts`, `packages/execution/claude.ts` | autonomy → permission mode/rules, system prompt, launch plan |
| Hook event receiver | `hook-receiver.ts`, `packages/integrations/hooks.ts` | raw hook → normalized events, activity, blocking decisions |
| Task scheduler | `tasks.ts` | dependencies, routing, starting work |
| Workflow engine | `tasks.ts`, `meetings.ts` | completion → verification → review → merge; meeting rounds |
| Project manager | `tasks.ts` | projects, policy, planning |
| Permission & approval manager | `comms.ts` | questions, approvals, delivery states |
| Collaboration bus | `comms.ts` | messages, collaboration requests, delivery queue |
| Event store | `packages/database` | append-only, idempotent, redacted |
| Notification manager | `comms.ts` | the owner's inbox |
| Office state manager | `engine.ts`, `core.ts` | full-state snapshots, entity broadcasts, layout |
| Progression engine | `packages/game-systems` | XP ledger, levels, milestones |
| Self-improvement | `improve.ts` | playbooks, project knowledge, routing, proposals |
| Routines | `routines.ts` | standing instructions repeated for one employee: when a run is due, delivered, skipped or held |
| Sleep | `sleep.ts`, `registry.ts` (`wake`), `comms.ts` (`pump`) | stopping sessions that have no work; starting them again for what they are needed for |
| Work log | `work-log.ts` | how long each employee has worked this month, and who has worked the most (`CompanyStats.employeeOfMonth`; the "Employee of the month" decoration shows them) |
| Waiting for a colleague | `waits.ts` | tool calls held open for a colleague's answer or the end of a task; what may be waited for, when a wait is cut short, what stands after the call |
| Commands in the background | `background.ts`; `shells.ts` (execution) | which commands of a session run in the background (machine: the process table; office: the hooks), and the state `waiting_command` |
| Persistence & recovery | `core.ts`, `engine.ts` | everything is rebuilt from the database on start |

### Activity state

An employee's visible state is derived in exactly one place — `interpretHook`, a pure function over the real hook payload — plus MCP reports and process state. Tool → state: Read/Grep/Glob → `reading`; Edit/Write → `coding` (or `debugging` after a failed test run); a test command → `testing`; `ask_boss`/`AskUserQuestion` → `waiting_answer`; `PermissionRequest` → `needs_approval`; and so on. Unknown hook → no change. No hooks → `unknown`.

One state is set by the office rather than read from a hook: while a tool call is held open for a colleague (`waits.ts`), and when a turn ends with that wait still standing, the session is `waiting_input` with the caption "Waiting for Sarah (T-12)". The hook of that call says `waiting_input` too, without knowing for whom; hooks of other tool calls that arrive while the call is held do not change it.

Another is set from the process table (`background.ts`): the machine's agent reports, at each two-second look, the shells Claude Code started for the session's commands that are still alive (`toolShells` in `packages/execution/src/shells.ts`, sent as `shells` when the set changes and once after every reconnect). Those not belonging to a Bash call in front of the session — begun and not ended, by its hooks — run in the background; they are kept on the session as `background` (what each is, since when). Between turns, a session that would be `idle` or `waiting_input` (with a task, not for a colleague) is `waiting_command` while any run, and goes back to what it was when the last ends. `SessionRegistry.setActivity` asks `Background.instead` on every change, so no caller has to know.

Separately, `session.inTurn` records whether Claude is mid-turn (`UserPromptSubmit` … `Stop`). It — not the display state — decides when Orchestrator may hand the session a prompt.

### Input ownership

`TerminalGateway` holds, per session: viewers, at most one controller, and a paused flag.

```
AGENT_CONTROLLED → HUMAN_OBSERVING → HUMAN_CONTROLLED
        ↑                 ↑                 │
        └────── release / viewer leaves ────┘        PAUSED (owner interrupted)   DISCONNECTED (host or pane unreachable)
```

Keystrokes from a client that is not the controller are dropped on the server. While a human controls a terminal (or it is paused), Orchestrator's own deliveries wait.

### Delivery

Everything Orchestrator says to a session goes through one queue per employee: task prompts, messages, answers, meeting rounds, retrospectives.

1. If a `Stop` hook is waiting and something is queued, it is handed over as the hook's "continue" reason — no typing.
2. Otherwise, when the session is between turns and not human-controlled, it is pasted into the terminal with a correlation marker (`[ORCH:TASK:…]`); the `UserPromptSubmit` hook carrying that marker confirms it.
3. Sessions without hooks get the paste immediately and stay at `sent` — receipt cannot be confirmed, and the UI says so.

### A task's life

```
BACKLOG ─(released, dependencies done)→ READY ─(employee free)→ IN_PROGRESS
   IN_PROGRESS ─ complete_task ─→ [clean tree? commits? verification command passes?]
        │ no → the tool call returns the failure; the agent keeps working
        └ yes → REVIEW (if required) ─ approve → merge into integration → DONE
                                      └ changes requested → back to the author with the comments
                 merge conflict → aborted, BLOCKED, the owner decides (author resolves / owner resolves + retry)
```

Projects have one of two workspace modes:

- **`in_place`** — the "cubicle": an employee is hired into a folder, the folder becomes their project, and they work directly in it on whatever branch is checked out. Orchestrator creates no worktree, switches no branch and merges nothing; completion is still verified (clean tree, commits since the task started, the verification command). Several employees can live in the same folder and work in it **at the same time**: each is told who else is there (and to stage only their own files, by path), and from the moment a folder is shared a task counts as its uncommitted work only the files its own session wrote (`Task.touched`, from the Write/Edit hooks) — a colleague's work in progress never stops a completion. An employee whose own folder lies *inside* the project's folder (one of several repositories under one root, a package of a monorepo) works in that subfolder, not at the root. A project can ask for the old rule instead — one at a time, the next task waits its turn (`policy.oneAtATime`, Projects → Policy).
- **`worktrees`** — for projects several employees share, described next.

In a `worktrees` project each employee works in `<repo-parent>/.orchestrator-worktrees/<repo>/<employee>` on `orch/<employee>/<task>`. Finished work is merged with `--no-ff` into `orchestrator/integration` inside a dedicated `_integration` worktree; your own checkout and `main` are never touched. Dependent tasks branch from integration, so they start with their dependencies' work.

### Integration branch

After every merge the project's verification command also runs in the `_integration` worktree (`testIntegration` in `tasks.ts`; switch it off per project with the *Integration tests* policy). A failure raises a critical notification — each task passed alone, together they do not — and clears when a later run passes. The owner has three controls (Projects → Integration, or `POST /projects/:id/integration/sync|test` and `/promote`): bring the base branch into the integration branch (a real merge, aborted on conflict), run the tests now, and promote. Promotion is only ever a fast-forward of the base branch (`promoteIntegration` in `packages/execution/src/git.ts`): it refuses while the last integration run failed (unless forced), when the base has commits the integration branch lacks, and when the base branch is checked out with uncommitted changes. If the base is checked out, the fast-forward happens in that working tree; otherwise only the ref moves, compare-and-swap. Nothing is pushed.

### Tickets: review, conversation, parts

`TASKS.md` is the page. In short: every task is reviewed unless chosen otherwise (`Task.reviewBy`, default `OwnerSettings.reviewDefault` = a colleague, then the boss; `Task.reviewStage` says whose turn it is). A task carries its conversation (`Task.comments`): people write through `POST /tasks/:id/comments`, employees through `comment_on_task`, with `@` tags that become messages (employees) or Inbox notifications (the boss). A question an employee cannot go on without parks the task (`BLOCKED` + `waitingFor`) until it is answered — on the task or in the Inbox, one question. `POST /tasks/:id/send-back` returns a task with what should change, a finished one included (`reopen`). The assignee can divide a task into parts for colleagues (`split_task`, `parentId`); the task waits for them and comes back to its lead. All of it is `packages/orchestration/src/task-talk.ts` (`Engine.talk`), called from `tasks.ts` and `comms.ts` at the points where a task is blocked, unblocked, handed in, reviewed and finished.

### Handoffs

`hand_off_task` passes the task an employee is working on to a teammate. The work so far must be committed (own files only — what was already uncommitted in an in-place folder is the owner's); in a worktree project the first employee's worktree steps back to its home branch so the teammate's worktree can check the task branch out. The notes are appended to the task description, sent as a `handoff` message, and recorded as `task.handoff`. The task keeps its branch, base and history, and is verified as one piece of work.

### Hosts under pressure

A host that stays at or above 95% memory or CPU for 30 seconds is exhausted (`checkPressure` in `registry.ts`): a `host.resource_warning` event and a notification are raised, and the scheduler starts no new work there (`isFree`). Sessions already running are left alone. When the figures drop, the warning resolves and held-back work is scheduled.

### Security alerts

`comms.securityAlert` records a `security.alert` event and a `security` notification, at most once per ten minutes per kind of incident: an action Claude Code refused (`PermissionDenied`), a value in a known credential format seen in a prompt, command or reply, a host turned away at `/ws/agent`, and five or more requests with a wrong owner token within a minute.

### MCP server

`POST /mcp` — Streamable HTTP, JSON responses, stateless; authenticated by the session's bearer token, which resolves to the employee (identity never comes from tool arguments). Tools: `get_current_task`, `get_project_context`, `report_status`, `report_progress`, `ask_boss`, `wait_for_answer`, `report_blocker`, `comment_on_task`, `split_task`, `complete_task`, `submit_result`, `request_review`, `submit_review`, `send_message`, `request_collaboration`, `request_help`, `respond_to_request`, `wait_for_colleague`, `check_messages`, `get_team`, `get_available_tasks`, `claim_task`, `propose_tasks`, `meeting_contribute`, `meeting_conclude`, `record_lesson`, `get_playbook`.

### Normalized events

Every event has `id` (dedupe key), `seq` (store order), `ts`, `type`, `source` (`hook`/`mcp`/`host`/`server`/`owner`), `correlationId`, and host/session/employee/task/project ids. Types include `worker.connected`, `session.started|resumed|stopped|lost`, `terminal.output` (how many bytes a watched terminal printed, at most once a minute per session — never the content), `terminal.control_acquired|released`, `task.assigned|started|progress|blocked|verifying|merged|completed`, `agent.tool_started|tool_finished|question|permission_requested|message`, `meeting.*`, `improvement.*` (see `packages/contracts/src/events.ts`). Summaries and payloads are redacted for secrets before they are stored.

### Self-improvement (`improve.ts` and `learning/`)
`Improver` is the entry point; each concern is a module under `packages/orchestration/src/learning/` with a page of its own under `docs/learning/`: `capture.ts` (what is learned from: retrospectives, corrections, rejections, repeats, failures; onboarding; measured skills), `playbook.ts` (which lessons a task prompt carries; merging, promotion, contradictions), `outcomes.ts` (task outcomes, trends, verdicts on lessons and applied changes), `autopilot.ts` (what the office applies by itself, probation, undo), `detect.ts` (further findings from recorded history). They meet in a few places: a task records the lessons it was given (`Task.playbookLessonIds`), which outcomes judges; a lesson shown to help (`Lesson.proven`) or asked about again (`Lesson.captureMustInclude`) is preferred by the playbook; a detector's change is classified in the autopilot's one table (`AUTOPILOT_TABLE`) and undone from its own record (`Improvement.previous`); accepting a "take it back" suggestion from outcomes calls the autopilot's revert. Everything automatic is a `learning.*` event carrying what, why, the evidence and how to undo it — the Growth window's "Done by itself" lists those.


- **Playbooks** — `afterTask` asks the author's real session to reflect when the task had friction; `record_lesson` stores the lesson with the task as evidence. Employee-scoped lessons are active immediately; project-scoped proposals wait for the owner. `playbookBlock` injects active lessons into the system prompt and every task prompt and counts each use.
- **Knowledge** — `captureOwnerAnswer` turns each answered question into a project lesson citing the question.
- **Routing** — `performance()` counts outcomes per employee and task kind from task records; `routingBonus` nudges the scheduler toward the better first-pass record (needs ≥ 2 completed tasks of that kind). The reason is written into the task history.
- **Proposals** — `analyze()` reads approvals, tasks and events and proposes: allow/deny rules for command shapes decided the same way ≥ 3 times (never for high-risk commands), a review gate where work keeps failing, a verification command where there is none, a longer verification timeout after repeated timeouts, sequencing for files that keep conflicting, acceptance criteria where vague tasks fail more. Applying is always an owner action.

### Routines (`routines.ts`)

A `Routine` (`employeeId`, `instruction`, `everyMinutes`, `enabled`, `nextRunAt`, `runs`, last outcome) is stored like any entity (collection `routine`, in the state and broadcast as `entity` messages; filtered for members' own employees like messages are). A timer (`timings.routineTickMs`, 20 s) looks for those whose `nextRunAt` has passed. A look comes to one of:

| Outcome | When | Next look |
| --- | --- | --- |
| `delivered` | the session is between turns with nothing waiting on the owner — or there is no session and the machine is there (the session is then started for it) | one interval after this look |
| `skipped_busy` | mid-turn; a question or approval open; waiting for a colleague; someone at the terminal; other things queued for them; the run before this one not delivered yet | one interval after this look |
| `not_run` | the employee or the project is paused, the employee is archived or outside working hours | unchanged: it runs once when the hold is over |
| `skipped_offline` | no session and the machine is away (or out of resources, or there is no folder) | unchanged: once when it is back |
| `failed` | the session could not be started for a run that is still waiting | one interval after this look |

A run is `Comms.sendMessage` with `routineId` set: the message body is `Routine (every N min): <instruction>`, and the prompt typed into the session adds `ROUTINE_GUIDE` (use `propose_tasks` with a `dedupe_key` for what is found; one line when there is nothing new). `propose_tasks` with a `dedupe_key` adds nothing when the project already has a task with that key (`TaskManager.propose`), and holds what it adds for the owner's release.

### Waiting for a colleague (`waits.ts`)

`request_collaboration` / `request_help` with `wait: true`, and `wait_for_colleague`, end in `Waits.forRequest` or `Waits.forTask`. Both first decide whether waiting is allowed (`cannotWaitFor`: oneself, a circle through calls held right now, the foreman, archived, paused, a machine that is away, a session without the office's tools, the shared / own-computer line; for a task also `canSee`, an assignee, and that it is released), return at once when the answer or the end is already there, and otherwise `hold`: a promise per waiting employee, a timer for the bound (`timings.colleagueWaitMs`), and `AgentSession.waitingOn = { employeeId, requestId | taskId, since, held: true }`.

A held call ends in one of four ways:

| | What ends it | The wait afterwards |
| --- | --- | --- |
| the answer | `Comms.respondToRequest` calls `Waits.answered` once the answer, the task it may have created and the reply message are on record; the reply is marked as returned by the tool (`delivery.via: 'mcp_pull'`) instead of being queued for the terminal | over |
| the task ended | any change to a task is looked at (`bus` `entity` events for tasks, sessions, employees and hosts trigger `sweep`): `DONE`, `BLOCKED` or removed | over |
| cut short | the same sweep finds the awaited colleague paused or archived, or — after `timings.waitGoneGraceMs` — still without a session that can be started | over; the request stays open |
| the bound, or the caller hung up | the timer; or the HTTP connection of `POST /mcp` closed before the reply (`McpContext.signal`) | stands: `held: false` |

A wait that stands is settled by the same sweep: when its task ends the office sends the waiting employee a message; when its request is answered the ordinary reply message is on its way already. `Waits.restore` (on start) turns every `held` into `false` — the calls are gone — so `wait_for_colleague` with no arguments (`Waits.resume`) can continue from the record.

Who reads `waitingOn`: the hook receiver (the caption at the end of a turn; no "you stopped" nudge), `Sleeper.keptAwake`, `Routines.busy`, `get_team`, the foreman's attention list (never `stalled` / `idle`; `waiting` when `Waits.idleTarget` says the awaited colleague is not at it), and the windows (`waitingForLines` in `apps/desktop/src/lib/views.ts`). A request that is waited for is delivered with `wake: true`, so `Comms.pump` starts the colleague's session if there is none.

### The work log and the employee of the month (`work-log.ts`)
Every half minute (`timings.workTickMs`) each running session that is in a working state (`isWorking` in contracts: thinking, reading, coding, testing, running a command, researching, planning, reviewing, delegating, in a meeting) and was heard from in the last quarter of an hour gets the time since the last look, added to its employee's count for the calendar month (UTC). Waiting — for an answer, an approval, a colleague — and being between turns count for nothing. The counts are kept in the store (`work.month`), so a restart loses half a minute at most. The leader — never a foreman, a team lead or somebody archived; a minute of work at least; a tie stays with whoever leads — is `company.employeeOfMonth` (`{ employeeId, month, ms }`), sent to the clients when somebody else leads or the leader's whole hours change. A new month starts everybody from nothing, and last month's stays up until somebody has worked. The first time an office runs this in a month, the month so far is estimated from the stored `session.activity` events (each stretch in a working state up to the next change, a quarter of an hour at most). On the client `lib/award.ts` turns the record into what the board shows; the board is the decoration `employee_of_month` (`models/decor.ts` `awardStand`, `Environment.tsx` `AwardBoard`/`drawAward`), placed from Floor plan like any other; a click on it opens the employee.

### Sleep and wake (`sleep.ts`, `registry.ts`, `comms.ts`)

`Sleeper.tick` (every `timings.sleepTickMs`, 30 s) stops managed sessions on shared machines that have rested for `OwnerSettings.sleepAfterMinutes` (`keptAwake` lists every reason not to). The stop is `SessionRegistry.stop(…, { asleep: true })`: `session.kill` on the host, then the record becomes `exited` with `asleepSince` and `exitReason: "asleep after N min without work"` — no `session.lost` event, no notification, not counted as a lost session; a `session.asleep` event instead.

Waking is in one place: `Comms.pump`. When something is queued for an employee with no session, `wakeFor` starts it (`SessionRegistry.wake`) if the employee is asleep, or if the delivery asks for it (a routine's run). `wake` picks the folder (`wakeCwd`: the task in hand's, else the last one if it is still theirs), calls the ordinary `start` — which resumes the conversation of the previous record in that folder — and records `session.woken` with whether it resumed. Starts of one employee are shared (`starting`); one that needs a particular folder looks again once the shared start is through. A resumed session that ends before any hook arrives had nothing to resume: `lastEventAt` is cleared so the next start is a new conversation, the feed says so, and the queue is pumped once more.

Meetings and report requests use `SessionRegistry.present` (running, or asleep and startable) where they used to require a running session.

## Layer C — office (`packages/office-3d`, `apps/desktop`)

- Procedural world from layout data (`world.ts`): walls with merged shared segments and door gaps, obstacles, a navigation grid with A* and string-pulling, points of interest.
- Procedural characters: `Character.tsx` is the component (a small jointed rig, the pose applied to it each frame with inertial blending, what is drawn for a look); the rest is under `src/character/`. `motion.ts` — seated poses as functions of time, the gait generator with leg IK, the one-shot reactions, the whip; it knows only the lengths of the bones. `shape.ts` — the tools: surfaces from rings and rows of points, lofts, limbs skinned to two bones, vertex paint, cloth coordinates, and `finish()` (shared corners). `head.ts` — the head as one sculpted, painted surface (three faces), eyes per iris colour, the lid, brows, hair per style (also under a cap, and mirrored for the other parting), glasses, headphones, cap. `body.ts` — trunk per garment, collars, hems and cuffs, neck, skinned arms and legs, hands, shoes. `look.ts` — materials cached by colour and finish (cloth grains, the suit's stripe, painted skin, wet eyes), and `traitsOf`, which derives outfit, face, brows, eye colour, parting, head width and girth from a look. Every geometry is built once and shared by everyone. The pose is chosen from the real activity state; unknown/paused states sit still rather than act. `test/character.test.ts` checks the surfaces, a triangle budget and that a look always gives the same person.
- Procedural furniture (`src/models/`): `kit.ts` holds the shapes everything is built from (soft boxes that can be puffed and bent, lathed profiles, bevelled slabs, tubes), the materials (one per look for the whole office: wood with a painted grain, cloth with a woven bump, leather, metals, glass, glow) and `Build`, which fuses all shapes of one material into one geometry — a chair of thirty parts is five draw calls, and forty chairs are the same five (`InstancedModel` in `Model.tsx`). Parts that throw no shadow (keys, handles, cups) are kept in a geometry of their own, out of the shadow pass. `workplace.ts` (chair, desk, monitor, keyboard, divider), `decor.ts` (plants, sofas, shelves, lamp, earned decorations, small things on desks), `rooms.ts` (reception, meeting table, owner's desk, kitchen, racks, the vault, console, hi-fi, media cabinet), `surfaces.ts` (floors per kind of room, the ceiling). Sizes are tied to the floor areas `world.ts` reserves and to the heights the characters are posed against (seat 0.51 m, desk top `DESK_TOP`); `test/models.test.ts` checks them.
- Sitting and jumping (2026-11-12): `world.ts` lists the places to sit (`World.seats`: the rooms' sofas and armchairs, a sofa an owner put down, the chairs at the meeting and team tables). In `Rig.tsx` the interact key in front of one sits the owner's character on it (the seated `idle` pose; a step or the key again gets up, onto the nearest floor) and, with nothing in reach, starts a jump. A jump is a clock (seconds since the key) that `Rig.tsx` — and `Humans.tsx`, for other people — hands to the character every frame, plus a lift of the whole body (`jumpY`: 0.62 m, in the air from 0.15 s to 0.65 s); everything else is the pose, in `character/motion.ts` ("the jump"): `jumpSink` (the hips: down for the push, down again for the landing), `jumpFeet` (on the toes; hanging, tucked or striding in the air; back to the gait's feet before the floor) and `jumpBody` (trunk, head, arms), all laid over the gait in `upright`. A jump begun while the last one is landing is blended like any change of pose (`Character.tsx`, `again`). The others are told through what is already sent: `presence` carries `sit`, and a jump is one message (`jump` → `jumped`), as a gesture is. `Humans.tsx` draws both for other people.
- People's acts: gestures (`motion.ts` `emote()`, laid over standing or walking; `character/acts.ts` times whip, flinch and gesture for one's own and other people's characters), the gesture wheel and push-to-talk (`apps/desktop/src/hud/people-acts.tsx`, pure parts in `lib/people-acts.ts`), voice capture and playback (`lib/voice.ts`, `lib/voice-codec.ts`: 16 kHz µ-law frames over the office WebSocket; loudness by `office-3d/src/voice-sound.ts`; the gate of a microphone that is always on in `lib/voice-gate.ts`), the device the office's sound comes out of (`lib/sound-devices.ts`: `routeOutput` for the voices, `radio.ts` and `sfx.ts`; chosen in Settings → Sound, kept in `prefs.ts`), and who hears whom (`apps/server/src/voice.ts`, used by `hubs.ts` for `voice`, `emote` and `whip`).
- Performance: repeated furniture is instanced; monitors redraw only on new frames and by distance; characters far from the camera stop animating; walls cut away for overhead cameras; quality setting controls shadows and pixel ratio. With the modelled furniture and the remodelled people the development office (twelve employees, one member's room) is about 790 000 triangles and 710 draw calls a frame from the entrance (shadow pass included), and holds 144 frames a second on the development MacBook. People far from the camera lose their smallest parts by size, in two steps (`People.tsx`); eyes, lids and brows go together.
- Where the office stands (`src/surroundings/`, `SURROUNDINGS.md`): `OwnerSettings.surroundings` — the office's own, not a computer's preference — picks one of six places. `Surroundings` sets the scene's background, fog and far plane and mounts a sky (one shader shell drawn where it is seen from), the place (a plain function that builds three.js objects: instanced buildings, cars, trees; everything that moves is moved in shaders from the time) and a footing under the floor (`plateOf`); `Lights` takes the place's tint; `Building` draws `glazed(world)` — the outer walls with windows where nothing hangs or stands — and drops its own dark ground. The world (walls to walk into, navigation) is the same in every place.
- Camera modes: CEO (third person), first person, management, free, workstation, command center.
- Terminals up close are real xterm.js instances fed by the stream; at most the ones you opened exist.

### A member's team lead
`packages/orchestration/src/lead.ts` (`Engine.lead`). An employee with role `lead` on a member's own machine; its member is `HostRegistry.memberOfHost(lead.hostId)`. `Lead.team(lead)` is worked out from that — employees on that member's machines, plus shared ones when `leadScope === 'office'` — and every tool (`LEAD_TOOLS` in `packages/integrations/src/mcp.ts`: `team_overview`, `team_look`, `team_tell`, `team_task`, `team_assign`, `team_folders`, `team_hire`) goes through it. Nothing calls a lead: it has no rounds and no state of its own; a message to it is an ordinary message. `directsOthers(roleKey)` (contracts) is what keeps both the foreman and a lead out of scheduling, reviewing and the foreman's idle checks. In the scene it is drawn like the foreman, by the same component (`leadViews` → `OfficeScene.leads`), walking between its own team's desks; `lead.visit` events take it to a desk. `docs/TEAM-LEAD.md`.

### One's own first, on the page
`apps/desktop/src/lib/mine.ts` says whose a thing is for the person at the window (`whoseEmployee`, `whoseProject`, `whoseTask`, `taskIsMine`, `scoped`) — pure, tested in `apps/desktop/test/mine.test.ts`. `apps/desktop/src/hud/mine.tsx` holds the "Mine / Everyone" switch (`useScope`, kept in `localStorage` as `orch.scope`) and the badge; `hud/panels/mine.tsx` is the *My work* window. What a visitor may open is `lib/visitor-panels.ts`, asked by the menu and by `openPanel`.

### The foreman on the floor
The foreman (role `foreman`, at most one) has no desk and is not among the seated people: `personViews` leaves it out, `foremanView` (`apps/desktop/src/lib/views.ts`) builds its own view model, and `packages/office-3d/src/Foreman.tsx` draws it.

- **During a round** it stands beside whoever it is dealing with. The server records a `foreman.visit` event each time the foreman's session looks at, answers, assigns to or tells an employee (`data.action`); the client plays these one after the other (8 s each, the last one until the round ends) — the same events everyone receives, so nothing new is on the wire. `GET /api/foreman` also reports `visiting` for owners.
- **Between rounds**, while rounds are on, it walks from desk to desk: `foremanStops(world, people)` is everyone who has a desk that can be walked to from the entrance, in desk order — the shared floor, then each member's room; a locked room has no door and is passed by. Which stop it is time for is `floor(now / 16 s) % stops`: a function of the clock and the seating only, so every client shows it at the same desk without any message. It finishes the way to a desk and stands there at least 6 s before going on to the one it is time for, so between two desks far apart (or on a slow computer) it skips one rather than never standing still. The walk itself reads nothing and sends nothing.
- **With rounds paused** it waits by the entrance.
- It can be clicked and right-clicked like anyone (the employee card; its terminal is for owners). Not yet: walking up to it and pressing Space/F, and the camera's "go to" jump — both look people up by desk (`Rig.tsx`).
- **For tests** — `window.__orchScene.foreman()` = `{ id, stops, key, x, z, arrived, visitingId, patrolling }`.

### Per-client preferences
Graphics quality, key bindings and the office extras (project areas on the floor, the closer camera at a desk) belong to the person at a computer, not to the office: `apps/desktop/src/lib/prefs.ts` holds them in a small store of its own (`usePrefs`, `setPrefs`), and `App.tsx`, the HUD and the Settings panel read them from there. In the desktop app they are kept in `prefs.json` (mode 0600) in the app's data folder through two IPC calls (`orch:prefs-get` / `orch:prefs-set` in `electron/main.cjs`, which keeps only the known fields; the hi-fi's volume and mute are among them, and are also kept in the page's storage for a desktop app installed before they existed), so the same preferences apply in every office that computer connects to; in a plain browser tab they are kept in `localStorage`. On a computer with nothing stored yet, the values in the office's `OwnerSettings` (`quality`, `keybindings`, `projectZones`, `approachZoom`) are copied once and stored; after that the office's values are ignored, and changing a preference sends nothing to the server — so every role, a visitor included, can change their own. The Settings panel shows these under "This computer" and the office's own settings under "The office", read-only unless `me.role` is `owner`.

### Member rooms
While a member's own computer (a personal host, `Host.memberId`) is online, a room for that member is attached to the office and their personal employees sit in it. **Nothing of this is stored**: every client derives it from the stored layout and from which personal hosts are online, so the stored office never changes and all clients arrive at the same rooms.

- **Derivation** — `packages/office-3d/src/member-rooms.ts`, `withMemberRooms(layout, hosts, unlocked)`: a pure function. `hosts` is the list of online personal hosts in enrolment order, each with its employees' ids (built in `apps/desktop/src/lib/views.ts`, `officeWithRooms`, which returns the same object until that list changes — hosts report every few seconds). The result is an *effective layout*: the stored rooms, desks and decorations first and untouched, then one `RoomDef` per member (`m:<hostId>`), its desks (`m:<hostId>:<n>`, n from 1) and two decorations (`m:<hostId>:plant`, `m:<hostId>:shelf`), plus `base` (the stored layout itself), `memberRooms` (geometry for drawing: door, plaque, floor lettering, ceiling lights, colour) and a map employee → desk. With nobody connected it returns the stored layout object itself.
- **Placement** — rooms stand *outside* an outer wall with a door cut through it; the entrance (south) wall is never used. The places a layout offers are worked out once per layout: along each wall, rooms 6.8 m wide are packed wherever a door can be cut — the doorway must be clear on the office side (no furniture, no inner wall meeting the outer wall, nothing hanging there: boards, wall screens, signs; see `wallFixtures` in `world.ts`) and reachable on foot. Walls are used in the order west, north, east (the command centre's panel covers the east side of the picture); on a wall the first door goes first, then its neighbours. **Only places whose door opens into the shared part of the office are used** — a hall, the open floor, reception; never a closed room (DECISIONS, "Members' rooms: only off the shared floor"). In the default office that is four places: two on the west wall, two on the east. The n-th connected member gets the n-th place, so a member's place depends only on who enrolled before them and is still online. Hosts beyond the available places get no room (`unplaced`) and their employees are not drawn.
- **Size** — two desks at least, then by pairs up to 12 (three pods of four). A room keeps its width and its door and grows *away from the building* (6 m, 10 m, 14 m deep), so neighbours never move when someone hires. Employees beyond 12 are not drawn; the plaque says "12 of N employees here".
- **World** — `buildWorld` given an effective layout returns the stored office's world (`world.base`, same walls, spawn, furniture, interactables) extended with the rooms: walls recomputed (the generic wall builder cuts the doors, since a member room is an ordinary closed room that shares a wall line with the building), obstacles for the new desks, `bounds` widened and a navigation grid over it that grows by whole cells at the low corner so every existing cell keeps its place. `moveWithCollision` lets the owner stand in the building, in front of the entrance and in member rooms only. `deskBox` honours quarter turns (desks in east/west rooms are turned).
- **Drawing** — `OfficeScene` keeps the stored office's world while members come and go and builds the extended one from it; `Building` draws floors, slab, ceiling and ceiling lights of the building from `world.base` (not rebuilt), walls keyed by position (only the wall that gets a door is replaced), and per member room a floor in the member's colour, slab, ceiling with its own painted light panels, door frame, threshold, a name plaque by the door (over it where there is no free wall beside it) and the name painted on the floor for the overhead cameras. The office's desks and the member rooms' desks are two `Desks` instances sharing geometries and materials. People, name tags, zones, documents, walking and focus work from `world.layout.desks`, which includes the member desks.
- **Who is drawn** — `personViews` gives a personal employee the desk `withMemberRooms` assigned (their stored `deskId` is null) and leaves out personal employees whose host is offline or unplaced. Panels read the store and still list them.
- **When a room goes** — the owner's character, if it stood in that room, is put back inside the building by that wall (`Rig`).
- **For tests** — `window.__orchScene.memberRooms` = `[{ hostId, memberName, desks, side, x, z, w, d, door }]`. `node scripts/dev-office.ts --member-room "Mila:3"` (repeatable, dev only) adds a member with a personal host and employees; `kill -USR1 <pid>` disconnects/reconnects those hosts, `-USR2` only the last.


**Seats:** an employee on a member's computer may carry `deskId = m:<hostId>:<n>` (`memberSeatId` / `memberSeatOf` in contracts); `withMemberRooms` seats those first and the rest in order, and sizes the room to the furthest chosen seat. A shared employee's `deskId` is always a desk of the stored layout.

**Since 2026-11-10:** a room is derived for every member computer the office knows (not only the connected ones); `MemberHost.locked` makes it dark and doorless, and `MemberHost.prefs` (from `Host.room`, set with `PUT /api/me/room`, validated by `sanitizeMemberRoom` in contracts) decides its title, colour, minimum desks, extra depth and furniture. `apps/desktop/src/lib/views.ts: officeWithRooms` builds that list.

## People, the door and personal hosts

```
 member's computer                                   office server
 ┌─────────────────────────────┐                   ┌──────────────────────────────────┐
 │ desktop app (Electron)      │── https (pinned) ─▶ door :4610 (TLS, self-signed)    │
 │  office window              │   /, /api, /ws/client                │               │
 │  relay 127.0.0.1:(kept) ────┼── tls (pinned) ───▶  /ws/agent, /mcp ─▶ server :4600  │
 │      ▲            ▲         │                   │                    (loopback)     │
 │  host agent    claude (MCP) │                   │ host agent (shared machine)       │
 │  tmux sessions (personal)   │                   │ tmux sessions (shared)            │
 └─────────────────────────────┘                   └──────────────────────────────────┘
```

- `packages/orchestration/src/memory.ts` — the long memory: records of what was done, decided and learned, kept and searched by MemPalace on the server's machine through its command line ([MEMORY.md](MEMORY.md)).
- `packages/orchestration/src/vault.ts`, `vault-detect.ts` — the vault ([VAULT.md](VAULT.md)): credentials encrypted in the office's store, found in text by format and by wording, used by sessions through a helper (`docs/SECURITY.md`, "The vault").
- `apps/server/src/guests.ts` — members (name, role, hashed credential). `invites.ts` — invitation links: a code (stored hashed, one use, a week) that the member's app exchanges at the door (`POST /join`) for that credential; the page a browser gets at the link. `access.ts` — the one place that decides requests and terminal messages. `door.ts` — the TLS listener and what it forwards.
- A host with `memberId` is a member's own computer. It is enrolled with a token from `POST /api/me/host` and may connect through the door; shared hosts may not. Its employees have no desk in the stored layout; the client derives a room for each online personal host (see "Member rooms").
- **A member's own servers**: `apps/desktop/electron/member-servers.cjs` (the app's side: probe, install the agent, enrol with a token from `POST /api/me/servers`, start it; `orch:servers*` in `main.cjs`, `window.orchestrator.servers` in the page, `hud/panels/my-servers.tsx`). The host enrols with a `member-server:` enrollment and carries `ownerId`/`ownerName`; `HostRegistry.shareMemberServer` flips `memberId`. `views.ts: officeWithRooms` seats a member's server employees in that member's room; `hostViews` marks private servers (`HostView.private`): the machine room draws the rest, and each member room draws its own as small racks (`MemberRoom.servers`, placed by `buildRoom` along the back wall; `SmallServer`).
- **A closed room**: `MemberRoomPrefs.locked` → `HostRegistry.isClosed` → `closedTo` in `access.ts` (requests, terminals, events, messages, questions, routines, outcomes), `Foreman.closed` (attention and tools), `MemberRoom.closed` in `office-3d` (no door opening for other people's windows; `Rig`, `world.moveWithCollision`, `foreman-route` treat it like a locked room).
- **On Windows** the same host runs inside WSL2: `apps/desktop/electron/wsl-host.cjs` starts one `wsl.exe` with a script on its standard input, which writes `personal-host.cjs`, `personal-host-cli.cjs` and the bundled agent into `~/.orchestrator/desktop-host/`, finds a Node.js ≥ 22.18 and becomes the host. The office to join and the member's token follow on the same input; the host's state comes back as JSON lines; closing the input stops it. The relay is inside WSL as well (WSL2 does not reach the app's loopback). Folders: the WSL home, the Windows profile under `/mnt`, and `ORCH_PERSONAL_ROOTS`.
- `apps/desktop/electron/personal-host.cjs` — started by the desktop app after joining as a colleague or owner: a loopback relay that pins the door's certificate, and a host agent (state under `~/.orchestrator/offices/<hash of the fingerprint>/agent`) pointed at the relay. Both stop when the office window closes.
- `scripts/start-local.mjs --door` (`pnpm serve`) is the server entry point; `scripts/office-admin.mjs` (`pnpm office`) manages members from the server's own terminal with the root owner token.

### The hi-fi
What is playing is the office's: `HiFi` in `apps/server/src/radio.ts` holds `RadioNow` (station, since, by) in memory, `POST /api/radio/play` / `stop` change it (a saved station by id; `work`), and the client hub tells every window (`{ t: 'radio' }`, also when one walks in; null = off). It follows the list of stations: a removed station stops, a changed address is passed on. No audio goes through the server. In the window, `store.hifi` is that state and `apps/desktop/src/lib/radio.ts` is the player: one `<audio>` element that tunes in when `hifi` says a station is on and this computer is not muted, with its volume eased twenty times a second towards `prefs.radioVolume × hifiLoudnessAt(ownerPosition)`. The curve and the hi-fi's place (`hifiPosition`, set by `OfficeScene` from the world it draws) are in `packages/office-3d/src/hifi-sound.ts`. `store.radio` is this window's copy (`loading` / `playing` / `blocked` / `error`); the 3D hi-fi (`HiFi.tsx`) is driven by `store.hifi`, so it moves in every window. `hud/radio-bits.tsx` has the top bar's buttons and the "click to listen" notice shown when a browser refuses to start sound.

### Knocking
`apps/server/src/knocks.ts` holds the doorstep in memory: `POST /knock` (through the door only) makes a pending knock with a secret for the knocker and a code for both sides; the client hub tells owners and colleagues (`{ t: 'knocks' }`, also when they walk in); `POST /api/knocks/:id/admit` makes a member through `Guests.invite` (a free name, `via`, and `expiresAt` for a browser) and parks the credential for the knocker's next poll. The browser side is `apps/desktop/src/Knock.tsx` (`useKnock`; drawn by `entrance/Door.tsx` on the entrance page, which `Entrance` in `App.tsx` shows when there is no token and the page came through a door — `ENTRANCE-PAGE.md`); the app side is `orch:knock*` in `electron/main.cjs` and the start screen, ending in the same `joinOffice` an invitation uses. The bell inside is `DoorBell` in `hud/core.tsx`.

### The answer cue
`store.ts` keeps `asks` (I said something to this employee: the message id) and `replies` (their turn has ended since: the text), in `localStorage`. `noteReply` moves an ask to a reply on `agent.turn_finished` once the message's delivery is no longer queued. Shown by `Replies` (cards, top right) and `TalkMarks.tsx` in the 3D scene (dots / bubble over the employee, placed from the people's shared `positions` map).

## Persistence and recovery

SQLite (`node:sqlite`), WAL mode, file mode 0600: entity documents, the event store, processed-hook ids, credentials (SHA-256 hashes only) and the audit log. With `--database postgres://…` the same data lives in PostgreSQL instead (`PgStore`, behind the same `Storage` interface); an advisory lock allows one server per database.

| Failure | Behaviour |
| --- | --- |
| Server restart | State rebuilt from the database. Sessions are shown as `host_offline`/`UNKNOWN` until their host re-reports them. Held hooks are marked superseded; open `ask_boss` questions stay open and their answers are delivered through the terminal |
| Agent restart | tmux sessions keep running; the agent re-attaches from its state file and re-reports. Hooks fired meanwhile are lost (Claude Code treats the dead socket as "no hook") and state is `UNKNOWN` until the next hook |
| Network drop | Agent reconnects with backoff; queued hook events are flushed; viewers get a fresh snapshot |
| Claude process exits | Pane is kept (`remain-on-exit`), session `exited`, employee `OFFLINE`; "Resume session" respawns the pane with `--resume` |
| Session put to sleep | The tmux session and the process are ended on purpose; the record keeps the folder and the Claude conversation id. The next thing the employee is needed for starts a new tmux session of the same name with `--resume` |
| Server restart while someone waits for a colleague | The held tool call is cut. What the session waits for is on its record (`waitingOn`, now `held: false`): the answer arrives as a message, or `wait_for_colleague` picks the wait up |
| Server restart with routines | Routines and their `nextRunAt` are stored; one that came due meanwhile runs once (after its machine has reconnected) |
| Duplicate events | Ignored by id |
| Merge conflict | Aborted; task blocked; owner decides |
| Host revoked | Cut off immediately; credential invalid; tmux sessions untouched |

## Status

Verified on macOS 26 (arm64), Node 26, tmux 3.8, Claude Code 2.1.321 and 2.1.322 (the CLI updated itself during the work):

- `pnpm test`: 32 unit tests (two of them against a real PostgreSQL when its binaries are installed).
- `pnpm test:e2e`: 73 end-to-end scenarios in nine suites — a real server, real host agents, real tmux, hooks over the unix socket, MCP over HTTP, git worktrees and merges — with the scripted `fake-claude` worker. This includes three host agents in one office (enrollment, isolation between hosts, revocation), a full office on PostgreSQL across a server restart, and the SDK-managed runtime with a scripted stand-in for the SDK.
- With the real Claude Code CLI (model: haiku):
  - `pnpm test:real` (23 checks): launch, trust prompt, hooks, task delivery confirmation, `ask_boss` round trip, verified completion and merge, measured usage, observe/take control/return control with the same PID.
  - `pnpm test:real:approvals` (10): a real `PermissionRequest` as an approval; allow, deny, and `AskUserQuestion` answered from the office.
  - `pnpm test:real:talk` (5): hire into a folder, say something, get the real reply.
  - `pnpm test:real:team` (11) and `pnpm test:real:team:sdk` (11): one real session implements, a second read-only one reviews the real diff, the work merges only after approval; then both hold a meeting that ends in a recorded decision — in the interactive runtime and with both as SDK-managed workers.
  - `pnpm test:real:flows` (11): an approval nobody answers (hook gives up, Claude Code's own prompt is answered in the terminal), a message sent mid-turn delivered through the Stop hook, a failed verification followed by a retrospective in which the model recorded a lesson, a merge conflict handed back to its author and resolved.
  - `pnpm test:real:flows2` (11): a dependent task waiting for and building on its dependency, an employee who stops early being nudged to finish, one employee asking another through Orchestrator and getting the answer back, a review that requests changes followed by rework and approval, and a server restart plus a host-agent restart in the middle of work.
  - `pnpm test:real:sdk` (17): the real Claude Agent SDK (0.3.321, the copy installed by `orchestrator-agent sdk install`) — structured delivery, reply, approval through the SDK callback, keyboard fallback, interrupt, resume after restart, a verified task, usage and the cost estimate.
- `pnpm test:ui`: 98 checks — the built UI driven in Electron with real clicks, typing and key presses against a live development office, each effect confirmed on the server and on disk. Every panel and camera mode; walking up to an employee, talking (F), sitting down (E) and walking away by keyboard; the right-click menu (every entry); the command center; questions, approvals, owner review; hiring, profile, appearance and schedule; tasks (form, detail tabs, board move — drag events are dispatched, since a hidden window has no OS drag session); talk; terminal control; settings and key bindings; machines (token, rename, remove, attaching an existing tmux session); desks; lessons (teach, edit, retire) and suggestions; meetings; projects and their policy; list filters and search; deleting a task, marking one done by hand, cancelling a meeting, removing a desk and archiving an employee (their confirmations included); executing a typed command; terminal wall; inbox.
- Packages, each run from its packaged form:
  - `pnpm package` + `pnpm package:smoke` (15 checks): the portable tarball; the macOS `.app` starting its own office; and the app as a pure client through its connect screen (plain http to another machine refused, wrong token refused, right token opens the office, the saved connection reused). The automated check keeps the saved token in an owner-only file so that it never touches the real keychain; the keychain-encrypted storage path was exercised once during development and is not part of the repeatable check.
  - `pnpm package:linux`: a `.deb` (installed with dpkg on Debian 12, the installed commands ran a working office, removed cleanly — `pnpm test:linux:deb`) and Linux desktop bundles for arm64 and x64 from Electron's official builds, SHA-256 verified (both started on Ubuntu 24.04 under a virtual display and rendered the office — `pnpm test:linux:desktop`; the x64 one under x86-64 emulation, `ORCH_DESKTOP_ARCH=x64`).
  - `pnpm package:windows`: Windows desktop bundles (x64, arm64), assembled and checksum-verified but **never run**.
- `pnpm test:linux` (16 checks): the bundled agent on Debian 12 (Node 22, tmux 3.3a) in a container over TLS, including an SDK-managed worker from the bundle (scripted SDK). Two Linux-only bugs were found and fixed this way (tmux needs `-u`; a non-ASCII field separator was mangled by tmux 3.3a).
- `pnpm test:machines` (17 checks): three machines on three operating systems in one office — this Mac, Debian 12 and Ubuntu 24.04 (tmux 3.4; the userland a default WSL2 install provides) — the Linux machines reaching the server at the Mac's LAN address over TLS. Simultaneous verified work, a request and a meeting that cross machines, terminals from all three in one client, an SDK-managed worker on Ubuntu, a silent network partition (noticed after about 75 s; back with the same sessions 30–40 s after the link returned, queued work then ran), and revocation.

Defects these runs turned up, all fixed and covered by a test:

- A session stopped and immediately started again could be reported as ended by a stale check on the host, so the office briefly lost it and an in-flight delivery with it. Every start now carries a launch id issued by the server; the host leaves a session alone while it is being launched, and reports about an older launch are ignored.
- `complete_task` in an in-place folder refused because of files that were already uncommitted there before the task — the reason a real task once appeared to stall. Those files are now recorded as the owner's when the task starts and never block it or get touched.
- A pause made from a panel could not be resumed there (a stale per-viewer control state hid "Resume work").
- Owner changes to settings, including whether workers inherit the owner's MCP connectors, were not written to the audit log.
- An answer to a colleague's request was not linked to the request's thread.
- Packaged launchers did nothing when installed behind a symlink; an agent shutdown could hang while an SDK worker was connected.

The usual reason a real task *appears* to hang is an approval or question nobody answered: a real model does not always choose the pre-approved form of a command (for example a compound `git add … && git commit -m "$(…)"`). The office shows it as waiting on you.

Not verified, because the development machine cannot do it:

- **Anything on Windows.** There is no Windows system here. What stands in for it: Ubuntu 24.04 — the default WSL2 distribution — is verified for the agent, the workers, the `.deb`-style install and the desktop bundle; and the Windows desktop app's code path (connect to an office elsewhere) is the same one verified on macOS. The WSL2 kernel, Windows networking and the Windows bundle itself were never executed. Native Windows workers are not supported (they need tmux).
- **Physically separate computers.** Three operating-system instances with their own network addresses were verified over the LAN address with TLS, including a real partition — all hosted by one Mac (two as containers in one VM).
- **A notarized macOS installer.** The `.app`/`.dmg` are ad-hoc signed; this machine has no Developer ID identity, and notarization needs an Apple developer account. `pnpm package:notarize` does the whole job once you have both (`--check` lists what is missing). Its signing step — every binary inside the app, inside out, with the hardened runtime and Electron's entitlements — was verified with an ad-hoc identity (the signed app still starts and renders); the submission to Apple was not.

Other limits: every desktop bundle needs a system Node 22.18+ for a local office (Electron's embedded Node is older); there is no `.rpm` or AppImage. The app's icon is the logo (`apps/desktop/electron/icons/`, made by `pnpm icons` from `docs/assets/logo.svg`): in the macOS bundle, in `Orchestrator.exe` and on every window. PostgreSQL is functionally tested (PostgreSQL 17), not load-tested, and stores the same JSON documents as SQLite rather than a normalised schema. Only Claude Code 2.1.321/2.1.322 and Agent SDK 0.3.321 were run. A few paths ran only with the scripted worker — for example priority decisions escalated to the owner and the Stop-hook nudge budget on Auto — and the UI run, broad as it is, answers the app's native confirmation dialogs in-page (a hidden window cannot click them) and does not press literally every control (for example the remaining graphics and game-mechanics settings). The office and characters are procedural geometry, not authored assets.
