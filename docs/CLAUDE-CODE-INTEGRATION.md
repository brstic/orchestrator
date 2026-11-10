# Claude Code integration

What Orchestrator uses from Claude Code, how, and what was observed with the real CLI (2.1.321).

## Two runtimes, different capabilities

| | Interactive CLI worker | SDK-managed worker |
| --- | --- | --- |
| What it is | a real interactive `claude` process in a tmux pane | the real `claude` binary driven through the Claude Agent SDK by a small runner process in a tmux pane |
| What the terminal shows | Claude Code's own TUI | a plain transcript of the turn (prompts, tool calls, results, replies) |
| Terminal observation and takeover | yes — the point of this mode | observation yes; with control you can type a prompt, answer an approval (`y`/`n`) or interrupt (Esc) — not the Claude Code TUI |
| Messages and tasks | typed into the terminal as a paste, or handed over as Stop-hook feedback | handed to the SDK as structured streaming input; nothing is typed |
| Approvals | `PermissionRequest` hook, with Claude Code's terminal prompt as fallback | the SDK's `canUseTool` callback, with a `y/N` prompt in the pane as fallback |
| Interrupt | Escape sent to the pane | the SDK's `interrupt()` |
| Activity | Claude Code hooks (shell commands in `--settings`) | the same hook events, as SDK hook callbacks |
| Workspace trust prompt | shown by Claude Code, surfaced as a question | not shown (the SDK runs non-interactively) |
| Cost | not available | the SDK's running estimate, shown as an estimate |
| Needs on the host | Claude Code | Claude Code **and** the Agent SDK (`orchestrator-agent sdk install`) |
| Status in this repository | **implemented and verified** with the real CLI | **implemented and verified** with the real SDK and CLI; the default remains the interactive runtime |

The runtime is chosen per employee (Team → profile → Runtime). Hosts report which runtimes they can provide; if an employee is configured for the SDK runtime on a host without the SDK, they are started as an interactive worker and the office says so (an event, a notification and a "fallback" badge) rather than pretending.

Capabilities are detected per session and shown in the UI (`terminal`, `hooks`, `mcp`, `structuredApproval`, `structuredMessaging`, `usage`). An **attached** session that was not launched by Orchestrator starts with `terminal` only.

The owner can always tell these apart:

| Action | What it is | How it is confirmed |
| --- | --- | --- |
| Direct terminal control | your keystrokes → `tmux send-keys` into the pane | you see the terminal |
| Structured task assignment | prompt pasted into the session (or handed over via a Stop hook) | `UserPromptSubmit` hook with the task's marker |
| Message to an agent | same delivery queue | hook marker, or `check_messages` pull |
| Permission approval | decision written to the held `PermissionRequest` hook | `PostToolUse` for that tool |
| Process interruption | Escape sent to the pane (Claude Code's interrupt key); for an SDK-managed worker, the SDK's `interrupt()` | terminal output; state shows `PAUSED`; the event records which was used |
| Visual event | an avatar walking, raising a hand | always derived from one of the above — never free-standing |

## SDK-managed workers

```
/usr/bin/env -u CLAUDECODE -u CLAUDE_CODE_… \
  node orchestrator-agent.mjs managed-run --spec <agent-home>/sessions/<id>/managed.json
```

The runner (`apps/host-agent/src/managed-runner.ts`) is the process in the pane. It imports the Agent SDK installed on that host and calls `query()` with:

| SDK option | Value |
| --- | --- |
| `prompt` | an async stream of user messages: what the office sends, plus anything typed in the pane |
| `pathToClaudeCodeExecutable` | the host's own `claude` (the SDK's bundled binary is not installed) |
| `permissionMode`, `allowedTools`, `disallowedTools`, `settings.permissions` | exactly the mode and allow/deny/ask rules an interactive worker would get. Never `bypassPermissions` |
| `canUseTool` | asks the office (a held `PermissionRequest`, like the hook); if nobody answers within the host's approval wait, asks `Allow this? [y/N]` in the pane |
| `hooks` | callbacks for `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `SubagentStart`, `SubagentStop`, `SessionEnd`, forwarded to the same hook receiver; the host's high-risk gate and `AskUserQuestion` answering work unchanged |
| `mcpServers`, `strictMcpConfig` | the Orchestrator MCP server with the session's bearer token; your own connectors only if you turned on inheritance |
| `settingSources` | `['project']`: the project's `CLAUDE.md` and settings apply; your personal settings do not |
| `systemPrompt` | the Claude Code preset with the same appended role/standing instructions |
| `sessionId` / `resume` | a fixed session id, so a stopped worker resumes the same conversation |

The runner talks to the agent over the same private unix socket as the hooks, authenticated with that session's token: it long-polls an inbox for prompts and interrupts, and reports the SDK's cost figure after each turn.

Observed with Agent SDK 0.3.321 and Claude Code 2.1.321 (`pnpm test:real:sdk`):

- A message from the office arrived as SDK input and was confirmed by the `UserPromptSubmit` callback; the reply came back through the `Stop` callback (`last_assistant_message`).
- With supervised autonomy, a `Write` reached `canUseTool`; the file did not exist until "Allow" was clicked in the office.
- With nobody answering in the office, the runner asked `Allow this? [y/N]` in the pane after the host's approval wait; `y` typed there let the write happen.
- An interrupt from the office reached the SDK's `interrupt()` in the middle of a long answer; the turn ended, the process (same PID) stayed up.
- After stop and start, `resume` continued the same conversation: the worker recalled a fact from before the restart without reading any file.
- A tracked task was delivered as SDK input, done in the folder, committed, and verified by Orchestrator. On the way the model chose a compound `git add … && git commit -m "$(…)"`, which Claude Code's rules do not pre-approve even at standard autonomy — it became an approval in the office. A real model does not always pick the pre-approved form of a command; an unanswered approval is the usual reason a task appears to "hang".
- `total_cost_usd` on the result message is cumulative for the process, so the latest value is shown, not a sum. It restarts when the worker is restarted.
- The CLI's ask-first mode is called `manual`; the SDK's name for it is `default`. The runner translates.
- The SDK prints a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` notice because the office's own MCP tools are pre-approved by an allow rule; that is intended and the notice is silenced.
- A `system/init` message is emitted at the start of every turn, not once.

## Launch (interactive worker)

```
/usr/bin/env -u CLAUDECODE -u CLAUDE_CODE_… ORCH_SESSION_ID=<id> \
  claude --settings <agent-home>/sessions/<id>/settings.json \
         --session-id <uuid>            # or --resume <uuid>
         --permission-mode <manual|acceptEdits> \
         --model <model> --name <employee> \
         --append-system-prompt <role, style, standing instructions, playbook, how to work here> \
         --strict-mcp-config --mcp-config <agent-home>/sessions/<id>/mcp.json
```

- Per-launch `--settings` carries hooks and permission rules, so the project's own `.claude/settings*.json` is never modified. Observed: hooks from `--settings` fire alongside the user's own configuration.
- `--session-id` fixes the conversation id so a crashed worker can be resumed with `--resume` in the same tmux pane.
- `manual` is the interactive default mode on 2.1.200+ (older CLIs call it `default`; chosen by version).

### Workspace trust prompt

Claude Code asks whether to trust a folder the first time it starts there, before any hook can fire. Orchestrator notices the prompt in the pane's screen capture, raises it as a question, and — if you choose "Trust this folder" — navigates to the "Yes" option based on what the prompt actually shows before pressing Enter (in 2.1.321 the default selection is **"No, exit"**). It never presses keys blind.

## Hooks

Installed per session as `command` hooks:

```
curl -sS --max-time <t> --unix-socket <agent-home>/agent.sock -X POST \
  -H 'x-orch-token: <session hook token>' -H 'x-orch-session: <id>' -H "x-tmux-pane: ${TMUX_PANE:-}" \
  --data-binary @- http://orchestrator/hook 2>/dev/null || true
```

| Event | Used for | Blocking? |
| --- | --- | --- |
| `SessionStart` | session started/resumed; employee becomes available | no |
| `SessionEnd` | session ended | no |
| `UserPromptSubmit` | confirms delivery (correlation marker); turn begins | no |
| `PreToolUse` | activity state; host-side high-risk gate (`permissionDecision: "ask"`); `AskUserQuestion` held for the owner | only for `AskUserQuestion` |
| `PostToolUse` | "modified file X", test outcomes, confirms approvals | no |
| `PostToolUseFailure` | failures; failed test runs | no |
| `PermissionRequest` | approval held open until the owner decides | **yes** |
| `PermissionDenied` | denial confirmed; the owner gets a security notification saying what was refused | no |
| `Notification` | `permission_prompt` (terminal fallback is showing), `idle_prompt` | no |
| `Stop` | turn ended; queued messages delivered as `{"decision":"block","reason":…}`; bounded nudges | briefly |
| `StopFailure`, `SubagentStart`, `SubagentStop` | error state; delegating | no |
| `TaskCreated`, `TaskCompleted` | a step of Claude Code's own task list was planned / finished (`agent.step_planned`, `agent.step_completed`). These are steps inside a turn: an Orchestrator task is only ever completed by verification | no |
| `TeammateIdle` | a teammate of a Claude Code agent team went idle (`agent.teammate_idle`) | no |

A finished Bash command that deploys or releases something (`npm publish`, `gh release create`, a version tag, an image push, `kubectl apply`, `terraform apply`, a platform's `deploy`, `npm run deploy`, …) is also recorded as `ops.deployment` with its real outcome, from `PostToolUse` / `PostToolUseFailure`. Quoted text and `--dry-run` do not count.

Blocking decisions:

- **Approval** — `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` or `{"behavior":"deny","message":…}`.
- **AskUserQuestion** — `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{…original input…,"answers":{"<question>":"<chosen label>"}}}}`.
- No decision (timeout after `approvalWaitSeconds`, server unreachable, agent down) → empty output → Claude Code shows its own prompt in the terminal, where you can answer at the workstation. The office marks the request *superseded* rather than pretending it is still answerable.

Events newer than the installed CLI are left out of the settings file (`HOOK_EVENTS` in `packages/execution/src/claude.ts`); override with `hookEvents` in the agent config.

## MCP

The Orchestrator MCP server is an HTTP endpoint on the server (`POST /mcp`, JSON responses). Each session gets its own bearer token in `mcp.json`. Observed handshake from the real client: `server/discover` (answered "method not found", which the client accepts), `initialize`, `notifications/initialized`, a `GET` (answered 405: no server-initiated stream), `tools/list`.

`ask_boss` holds the tool call open for up to four minutes (`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` and `MCP_TOOL_TIMEOUT` are raised in the worker's environment). If you answer later, the answer is delivered into the session as a message, and `wait_for_answer` lets the agent keep waiting.

Sessions that were not launched with the MCP server (attached sessions) simply lack these tools; everything terminal-based still works. To give one the tools, add the server to it yourself:

```
claude mcp add --transport http orchestrator https://<server>/mcp --header "Authorization: Bearer <session token>"
```

## The foreman: rounds, tools and cost

The foreman is a real Claude Code session with the Orchestrator MCP server, like every employee — but there is **one** for the whole office, it runs on one of the office's own machines (never on a member's own computer), it has **no desk**, and it looks after everyone: the shared office and the employees on members' own computers while those computers are connected. What else is different is what it is sent and which tools it has. Its folder is only where its session runs; it is never made a project.

**Rounds.** Nothing is sent to a foreman unless *Settings → Foreman → Foreman rounds* is on (`settings.foreman.enabled`) and a foreman exists. The setting is off in an office with no foreman; **hiring one switches it on** (that is what hiring one asks for), and the owner can pause it. Every `foremanTickMs` (5 s) the engine computes, from its own records and without any model, what needs attention:

| Item | When |
| --- | --- |
| `QUESTION` | an employee's open question of kind `question` (asked with `ask_boss`, `request_help` or `AskUserQuestion`) that has waited a few seconds — only while *the foreman answers employees' questions* is on |
| `BLOCKED` | a task in `BLOCKED` on an active project |
| `STALLED` | a task `IN_PROGRESS` whose assignee's session is between turns and reported idle / waiting for five minutes, with no open question and not paused or controlled by you |
| `UNASSIGNED` | a `READY` task with no assignee while an employee who could take it is free (after the scheduler has had its turn). Only people on the same computer as the task's project are offered: see *Members' computers* below |
| `IDLE` | a running session that has been between turns for `idleMinutes` (default 10, `0` = never) with **no** task in progress, no open question, not paused and not controlled by a person. One item per spell of doing nothing (the key carries when the spell began). If nothing but the foreman's own words reached that employee since they were last shown as idle, the wait doubles each time (10, 20, 40 … up to 32×), and goes back to normal as soon as anyone else gives them something — a message, an answer from the owner, a task that starts — so a foreman and an employee with nothing to do never talk in circles |

Permission requests, trust prompts, and questions an employee marked as a decision, a priority or a deployment are never in that list: they are the owner's.

Each item has a key that stays the same while the item does. A round starts only when there is an item whose key the foreman has **not** been shown before, no round is running, and `minGapSeconds` (default 120, at least 30) has passed since the last one ended. Then one prompt, tagged `[ORCH:ROUND:<id>]`, goes through the normal delivery queue (typed into the terminal, as Stop-hook feedback, or through the SDK; the foreman's session is started first if none is running). It contains the digest — each new item with its ids and details, items from earlier rounds that are still open, and one line per employee — so a simple round is: read, one or two tool calls, `finish_round`. A round ends with `finish_round`, or when the foreman's turn ends (`Stop` hook) without one, or after ten minutes; a round that could not be delivered leaves its items unseen. An open item the foreman has already seen never starts another round, so nothing loops.

*Quiet check:* with nothing new, at most once every `quietCheckMinutes` (default 15, `0` = never) the foreman is sent a round that asks it to look around — only if a task changed status or assignee, a session started or stopped, or a question was opened or closed since its last round.

`foreman.round.started` and `foreman.round.finished` events carry the reason, the counts per kind, what the foreman did (looked at, answered, assigned, created, messaged, escalated) and its summary. Every time the foreman deals with one employee a `foreman.visit` event is recorded (`data.action`: `look`, `answer`, `assign` or `tell`; never what was on a screen) — that is what its character in the 3D office walks to. `GET /api/foreman` (owner only) returns the foreman, the round in flight, who it is with right now (`visiting`), the recent rounds and the current attention list.

*Members' computers.* Employees on a member's own computer are in the attention list, the overview and the digest like everyone else, marked "on <member>'s own computer". While that computer is not connected they are passed by: nothing can be seen or delivered there. Work does not cross: `assign_task` and `create_task` refuse to give a shared project's task to an employee on a member's computer, or a task of a project on a member's computer to anyone who is not on that computer (the same rule the scheduler follows).

**Tools** (declared as `FOREMAN_TOOLS` in `packages/integrations/src/mcp.ts`). Only a session whose employee has the `foreman` role is shown them in `tools/list`; a call from anyone else is refused and audited (`foreman.tool_refused`). As with every tool, the caller is the session the bearer token belongs to.

| Tool | What it really does |
| --- | --- |
| `office_overview` | reads the registries: every employee (role, project, session activity and for how long, current task, open question) and every project (tasks by status, ready and unassigned, waiting for release, blocked with reasons) |
| `look_at {employee}` | (anyone in the office, members' own employees included) the last 40 lines of that employee's terminal as last captured by the host (the same monitor frames the 3D office shows; known secret formats redacted), their task with its description, their recent events, their open question. Without a running session or a captured screen it says so. Records `foreman.visit`, which is what makes the foreman's character walk to that desk |
| `answer_question {question_id, answer}` | answers through the same path as the owner's answer (tool result, hook output or a typed message); the question records `answeredBy: foreman`, the audit actor is `foreman:<name>`, and the employee is told the foreman answered on the boss's behalf. Refused for anything that is not kind `question`, for a question the foreman escalated, and when answering is switched off |
| `assign_task {task, employee}` | the task board's own update (a task in progress cannot be reassigned; a foreman cannot be the assignee; work stays on the computer its project is on) |
| `tell_employee {employee, message}` | an ordinary message from "<name> (the foreman)" in the normal delivery queue: how it tells someone to carry on, how a blocker is resolved, what to pick up. Refused for an employee whose member's computer is away. It answers no recorded question and approves nothing |
| `create_task {project, title, description, …}` | a real task on the board, created by `foreman:<name>` |
| `escalate_to_owner {summary, detail, question_id?}` | a notification in the owner's inbox; with a `question_id` the question stays open for the owner and the foreman can no longer answer it |
| `finish_round {summary}` | closes the round and records the summary |

The foreman also has the ordinary tools.

**Cost.** The decision whether a round is due costs no tokens. A round costs what a short Claude Code turn costs on the account the foreman's session runs on: the round prompt (about 1,000 characters for a round with one item, as produced in the tests) plus the tool calls it makes, on top of the session's own context. The foreman's tool definitions are only loaded into the foreman's session. Figures were not measured with the real CLI (see *Status* below); the usage panel shows the foreman's session like any other.

**Status.** Implemented and covered by the scripted end-to-end tests (`tests/e2e/14-foreman.test.ts`) and unit tests (`packages/orchestration/test/foreman.test.ts`; members' own employees there, with a member host in the engine — not with a second real computer). **Not yet run with the real Claude Code CLI**: how a real model weighs "answer or escalate", and what it does with someone idle ("carry on" or "leave them be"), is governed by the role instructions and the round prompt and has not been observed.

## Usage data

Claude Code does not report tokens or cost through hooks. The agent reads the session's transcript file (its path arrives in every hook payload) and sums the `usage` fields Claude Code itself wrote. Shown as **measured**. Sessions without a known transcript show "not available". Cost is not shown at all.

A practical note from the real runs: workers that inherit a large personal MCP/plugin setup carry a large cached prompt on every request. This is why workers load only the Orchestrator MCP server by default.

## How much of an account is left

On a subscription plan Claude Code hands its status line command a `rate_limits` object: the percentage used of the 5-hour and the 7-day window, and when each resets. Each worker's per-launch settings carry a `statusLine` command that passes that JSON to the host agent over its local socket (authenticated with the session's own token, like a hook) and prints one line (`Orchestrator · <employee>`) for the terminal. Because it comes from `--settings`, a worker session shows this line instead of your personal status line; sessions the office did not start are not touched.

The agent keeps only the two windows. It adds who is logged in — `oauthAccount.emailAddress` and `organizationName` from `.claude.json` in that session's Claude config folder — and sends both to the office. The office stores the latest report per account (machine + config folder) and shows it at the CEO desk, on the CEO room wall, and from `GET /api/usage` (owner only).

- Nothing is estimated. An account nobody has worked on yet is listed as "not reported yet"; an account billed by API key has no such limits and never reports. A window whose reset time has passed is shown as 0%.
- Observed with 2.1.322: Claude Code runs the status line as soon as a session starts and already includes `rate_limits` then (no prompt needed), and again after each answer and once a minute. A window that is not active is simply absent (e.g. only `seven_day`). The `--settings` file is read at launch: adding the status line to the settings of a session that is already running has no effect until it is restarted.
- **Different employees on different accounts:** log in once on the employee's machine with `CLAUDE_CONFIG_DIR=~/.claude-second claude`, then write that folder in the employee's profile (*Claude account folder*). Their next session starts with `CLAUDE_CONFIG_DIR` set to it. The agent refuses a folder outside the user's home, or one nobody has logged in to. Employees on another machine (an enrolled host or an SSH link) use that machine's login unless given a folder there.

## Routines and permissions

A routine's run is an ordinary prompt typed into the employee's session (`[ORCH:MSG:…] Routine (every 5 min): …` followed by what to do with what is found). Nothing about permissions is different for it: the session runs with the permission mode and rules its employee's autonomy and project policy give it. Fetching a web page (`WebFetch`, or `curl` through `Bash`) is not on any pre-approved list below **Auto**, so on Supervised, Standard and Autonomous such a run stops at a permission request to the owner — each run, until the tool is allowed (Projects → Policy → Allow rules, e.g. `WebFetch(domain:support.example.com)`, or the employee's own allowed tools; both apply to sessions started afterwards). While that request is open, further runs are skipped. On Auto, Claude Code's own auto mode decides. This is from reading the launch code and from the scripted worker, which asks for `Bash` the same way; a real `WebFetch` from a routine has not been run.

## Sleep and resume

A session the office puts to sleep is ended with the host's `session.kill` (the tmux session is killed; Claude Code gets no chance to say goodbye and needs none: its transcript is written as it goes). The record keeps `claudeSessionId` and the folder. Waking is an ordinary start with `resume: true`: `claude --resume <id>` in the same folder, in a new tmux session of the same name; Claude Code's `SessionStart` hook then arrives with `source: "resume"` (`session.resumed` in the feed). If the process ends before any hook arrives, the office concludes that the conversation could not be continued, says so, and starts the next time with a new conversation id. Not verified with the real CLI on the server.

## Interrupt and resume

- **Interrupt / Pause** sends Escape to the pane — Claude Code's own interrupt. The process keeps running. Orchestrator does not assume a `Stop` hook follows an interrupt; it marks the session between turns itself and holds deliveries until you resume.
- **Resume** tells the employee to continue its task and releases the queue.
- Taking control does **not** interrupt anything. If Claude is mid-turn, what you type is queued by Claude Code like any typing during a turn.
