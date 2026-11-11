# A request that waits: hooks, holds, and what survives a restart

How a permission request, a question Claude Code asks, or a high-risk command gets from an employee's session to the owner and back; who is holding what while the owner thinks; and what happens to it when the office, the machine's agent, or the session itself is restarted. Read this before touching `hookCommand` in `packages/execution/src/claude.ts`, `onHook` in `apps/host-agent/src/agent.ts`, or the hook part of `packages/orchestration/src/comms.ts`.

_Most of it was built or rebuilt on 2026-11-11, after a day of deploys showed what each restart dropped. Why: `DECISIONS.md` — "A held request outlives a restart of the office", "The hook outlives the agent…", "Every start of a session has a name…", "Asking the same question again…". What it protects: `SECURITY.md`, "Agent permissions" and "A permission prompt in the terminal"._

## The chain

```
Claude Code ──runs──▶ hook command (sh + curl, in the session's settings.json)
                         │  POST over a unix socket, the event as JSON; waits for the answer
                         ▼
                   host agent (one per machine)  ── applies the high-risk list; answers at once, or holds
                         │  hook.request {requestId, event} over its link to the office
                         ▼
                   office: HookReceiver.onHookRequest → a Question (Inbox) → the owner answers
                         │  hook.response {requestId, output}
                         ▼
                   agent answers the HTTP request → the hook command prints it → Claude Code acts on it
```

Three things are held this way (`HookPending.kind` in `comms.ts`):

| What | Hook | If nobody answers in time |
| --- | --- | --- |
| A permission request | `PermissionRequest` | Claude Code shows its own prompt in the terminal; the office reads it from the screen and asks again (`permissionPrompt`, `promptOnScreen`) |
| A question Claude Code asks (`AskUserQuestion`) | `PreToolUse` | Claude Code asks in the terminal; the office **tells the owner** who waits there and what was asked — it does not press keys at that dialog |
| A high-risk command of an Unrestricted employee | `PreToolUse`, held by the agent (`orchHold`) | **refused** — in bypass mode there is no prompt to fall back to |

"In time" is the agent's `approvalWaitSeconds` (30 minutes by default). The hook command's own limit is that plus 30 seconds, and Claude Code's limit for the hook 5 more.

Besides these, an employee asks the boss through the office's own tool (`ask_boss`, channel `mcp_tool`). That is a tool call that waits, not a hook; see "The same question twice" below.

## What each restart does

| What goes away | What happens to a request that is waiting | Code |
| --- | --- | --- |
| **The office** (a deploy, a crash), the agent stays | The agent keeps holding the hook for `linkGraceSeconds` (90) and sends the request again when the office is back. The office recognises it by the event's id (`Question.hookEventId`) and takes the **same question** up again; an answer given while the machine was away is delivered then. A request made during those seconds waits too. | agent: `dropLink`, `releaseHeld`, the `welcome` case; office: `restore`, `rejoinHook`, `hostGone`, `heldBack`, `giveUpHeld` |
| **The agent** (on the office's server it is restarted together with the office) | The hook command itself tries again once a second for `HOOK_RETRY_SECONDS` (45), sending the same name (`x-orch-hook`), from which the new agent derives the same event id. The new agent holds it; the office keeps the same question. | `hookCommand`; agent: `onHook` (the event id, `x-orch-left`), `start` (the start-up grace), `stop` (held hooks are not answered) |
| **The agent, for longer than the hook tries** | The hook leaves a mark (`agent.sock.away`) so later hooks do not wait again, and gives up. In a session in **bypass mode a `Bash` command is refused** by the hook itself; everything else goes on by Claude Code's own rules (a prompt in the terminal on the other levels). The office gives the question up once the machine has reported in without it. | `hookCommand` (`failClosed`, `agentAwayMark`), `giveUpHeld`, `fellToTerminal` |
| **The session's process** (stopped and started, moved to another account, restarted for a change) | The old process may still report its end after the new one was started. Every start has a name (`hookLaunch`, sent as `x-orch-launch`); the agent drops hooks of another start, so they are not taken for the new process being alive or between turns. | agent: `onHook`, `Tracked.hookLaunch` |

Bounded on every side: the agent lets go after its grace, the hook after its retries and in any case within its own time limit, and the office gives a question up `hookRejoinGraceMs` (10 s) after its machine has reported in without it, or `hookRejoinMs` (2 min) with no machine at all.

## The hook command

For most events it is one `curl`. For `PreToolUse`, `PermissionRequest` and `Stop` it is a loop in plain `sh` around the same `curl` (see the comment at `hookCommand`): read the event once; try; on curl's 7, 52 or 56 (nobody listens, or the connection ended without an answer) try again; anything else, or out of time, stop. Headers: `x-orch-session`, `x-orch-token`, `x-tmux-pane`, `x-orch-launch` (which start of the session), `x-orch-hook` (this hook's own name, the same at every try), `x-orch-left` (seconds the hook has left, so the agent answers before it runs out).

A running session keeps the commands it was started with. The agent reports which version a session has (`hooksVersion`; `HOOKS_VERSION` in `packages/contracts/src/protocol.ts`), and the office starts a **bypass** session with older ones again, once, between turns (`restartDue` in `registry.ts`). Raise `HOOKS_VERSION` only when an older command is unsafe for bypass sessions — it restarts them all.

Tried by hand under `dash` with curl 7.81 (the server) and macOS's `sh`; every e2e session runs it, because the scripted worker runs the commands from its settings as Claude Code does.

## The same question twice

`ask_boss` waits inside a tool call. A restart of the office cuts that call off and the employee asks again, in the same words. `CommunicationHub.sameQuestion`: the same employee, the same text (spaces aside), still open or answered-and-not-handed-over, is the same question — the call waits on it, or returns its answer. At start the office folds identical open questions of one employee into the later one.

## Testing it

| Test | What it covers |
| --- | --- |
| `tests/e2e/37-held-through-restart.test.ts` | the office restarted once and twice under a permission request and a question; a denial; a lost link with an answer given meanwhile; a request made while the office is away; the agent away while a question waits; the office away longer than the agent's grace |
| `tests/e2e/38-hook-outlives-agent.test.ts` | the agent restarted under a held high-risk command (the test that showed the command running before the fix), allowed and denied afterwards; the agent away for good: a command refused in bypass mode, other tools and other levels not; the one-time restart of a bypass session with older hooks |
| `tests/e2e/39-stale-hooks.test.ts` | the old process's `SessionEnd` and `Stop` replayed into a restarted session that stands at the trust prompt; a hook that names no start |
| `tests/e2e/40-same-question.test.ts` | asked again while open, asked again after the answer, identical open questions folded at start |
| `tests/e2e/29-terminal-prompt.test.ts`, `04-recovery.test.ts`, `35-unrestricted.test.ts` | the fallbacks: a prompt in the terminal found on the screen, a question announced, a held command refused when nobody answers |

In tests the times are short: `approvalWaitSeconds`, `agentCfg.linkGraceSeconds`, `agentCfg.hookRetrySeconds`, and the office's `hookRejoinMs` / `hookRejoinGraceMs` (the harness's `timings`).

## Limits, plainly

- **A member's computer gets all of this with a desktop app built after 2026-11-11** (the agent is part of the app), and its sessions with their next start.
- **The refusal in bypass mode covers `Bash` only**, and it is a shell command in the session's own settings file: it guards against the office's own restarts, not against whoever owns the machine.
- **A question in the terminal cannot be answered from the office.** Only a permission prompt can.
- **With the agent switched off, an Unrestricted employee cannot run commands** until it is back.
- A hook that is retried against an agent that never went away (the connection alone broke) loses its question: the first attempt is reported as abandoned before the second arrives. Not seen; the socket is local.
- When a machine's last tmux session ends, nothing here depends on pane numbers any more (they start again from `%0`); the start's name does that work.

## Not verified with real Claude Code

- That a `deny` printed by the hook in bypass mode is treated as a refusal (the agent has answered in that shape since the level exists — also only run with the scripted worker).
- That Claude Code runs hook commands with a shell in which the loop is valid, and honours the configured time limit while it runs.
- That its `SessionEnd` hook is what arrived late in the live incident of 15:24 UTC (the log shows the typing and the exit).
- What its question dialog looks like in a terminal.
