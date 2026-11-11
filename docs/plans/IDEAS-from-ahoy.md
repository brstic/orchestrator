# Ideas — what to bring over from Ahoy

_Written 2026-11-11. The owner said: "if there is something smart in Ahoy, bring it over if it can be used here." Ahoy is the owner's chat assistant (a separate repository); it was read, not run. **Two of these are built (marked); the rest are ideas only** — when one is picked up it becomes a plan and a line in `DECISIONS.md`._

## Built on 2026-11-11

| Idea | In Ahoy | Here |
| --- | --- | --- |
| **The vault** | `backend/ahoyyy/vault.py`: credentials named, encrypted, never in the conversation | `packages/orchestration/src/vault.ts` (see `SECURITY.md`, "The vault") |
| **Changed tests are not proof** | `bench.py` hashes the protected test files; a task that changed them counts as failed even when they pass | A task whose diff touches its own tests, the runner's settings or the script it is verified by is flagged and sent to review; the reviewer is told what to look at first (`checksTouched` in `tasks.ts`) |
| **Going in circles** | `tools/agents.py` (`failure_key`): the same failed call gets a note at the third time and stops the agent at the sixth | The same failure (tool, command, first line of the error, numbers removed) is counted per task: the employee is told at the third, the owner at the sixth. Nobody is stopped (`failureKey` in `hook-receiver.ts`) |

## Worth doing next, in this order

1. **Routines that check first and stay quiet when nothing is new.** Ahoy's schedules (`schedules.py`) can run a command first (`check_command`, modes `changed` / `output` / `exit`) and call the model only when it says something happened, with only the new lines; a reply of "nothing new" or one like the last report is filed without telling anyone; missed runs are skipped, not fired in a burst. Here a routine is a full turn every time (`routines.ts`) — a five-minute routine is 288 turns a day, the cost is not measured and there is no daily cap. Build: `checkCommand` / `checkMode` on a routine, run through the host's `verify.run`, keep the last output, send what changed; a cap per day. Only an owner may set the command (it runs on the host). Medium.
2. **What a task cost.** Ahoy traces every task: each model round has token counts and an estimated cost (`observability/tracing.py`, `pricing.py`), names and numbers only. Here a session has usage but a task does not (`TaskOutcome` leaves tokens `null`). Build: snapshot the session's usage when a task starts and ends, show the difference on the task, and let Growth judge lessons by cost too. Small to medium; the numbers are estimates read from transcripts.
3. **Approvals that reach the owner away from the desk.** Ahoy has one chat bridge for Telegram, Discord and Slack with approval buttons (`integrations/chatbridge.py`) and Web Push with Approve / Reject in the notification (`push.py`); a problem is told once, resolved after two calm rounds, told again only after twelve hours (`findings.py`). Here everything waits inside the app, and an open approval holds a session until someone looks. Build: an outbound channel for questions, approvals and "needs you" notifications with the same once / resolve / re-tell rule. Medium to large, and a new way in: signed one-time links, owners only, never the text of a command that carries a credential.
4. **A benchmark with real Claude Code.** `ahoyyy bench` runs twenty small tasks, each with a reference fix and a test that fails before and passes after, and compares the report with the last one. Here everything is tested with a scripted worker, and `STATUS.md` says "not verified with real Claude Code" in many places. Build: a script that makes a scratch project, hires one employee, hands out each task and judges by the project's tests (with the changed-tests guard above). Large; the only real way to measure a change to prompts or to Growth. Spends Claude usage: run only when the owner asks.
5. **Deploys that check themselves.** Ahoy's updater refuses while work is running and goes back by itself if the health check fails within five minutes (read in its notes, not in the script). Here `scripts/deploy-server.sh` waits seven seconds and prints the status; rollback is by hand. Build: wait for `/healthz`, roll back when it does not come up, and say how many employees are in the middle of a turn before restarting. Small.

## Smaller ones

- **Webhooks that make a proposed task** (`triggers.py`): a secret address, size and rate limits, unknown and disabled look the same from outside, the payload is marked as untrusted in the prompt. Here: a CI failure or an issue becomes a proposed task with a `dedupe_key`. Medium; the risk is instructions hidden in the payload.
- **Instructions with a history** (`brain.py`): the prompts are editable with versions, diff and revert, and an edit that drops a `{placeholder}` is refused. Here the prompts are constants in `prompts.ts`. Medium.
- **Machine health as a trend** (`health.py`): IO pressure, a busy disk, swap, "memory reaches the limit within three hours"; an alert on the second bad sample, resolved after two calm ones. Here: only above 95 % for thirty seconds. Small to medium.
- **Files that change together** (`tools/cochange.py`), mined from git history, given to a reviewer as "these usually change with those". Medium.
- **Sharper filters for what counts as a lesson** (`memory/worknotes.py`): never a log of the work, a line number, a TODO, a secret. Could tighten `learning/capture.ts`. Small.

## Looked at and left

- **Prompts frozen for the model's cache**: Claude Code manages its own cache; lessons are given once, at the start of a session.
- **Diary, dossiers, notes at hand**: they are about one person's history with a chat assistant. What an *office* needs from that is in `IDEAS-memory-from-mempalace.md` (a `recall` tool and a diary per employee).
- **The night shift** (work in a copy, accept or reject in the morning): worktrees, review and merge already do that.
- **The guard against fetching internal addresses**: employees fetch with Claude Code's own tool; the server fetches nothing an employee chose.
