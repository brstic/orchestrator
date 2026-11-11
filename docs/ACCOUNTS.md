# Several Claude accounts on one machine

How a machine of the office gets more than one Claude account, how employees are spread over them, and how the office moves an employee off an account that has run out. Read this before touching the accounts code in `packages/orchestration/src/registry.ts` (`addAccount`, `failover`, `onLimitHit`) or `describeAccount` in `apps/host-agent/src/agent.ts`.

_Built on 2026-11-11 on the owner's request: every employee on the server ran on one Claude account, and when it reached its limit the whole office waited for the reset. Why it is built this way: `DECISIONS.md`, "Several Claude accounts". **Run with the scripted worker only — see "Not verified" at the end before relying on it.**_

## The idea in one paragraph

To Claude Code an account is a **config folder**: `~/.claude` by default, any other folder when `CLAUDE_CONFIG_DIR` points at it. Each folder has a login of its own and an allowance of its own. The office keeps, per machine, a list of such folders (`Host.claudeAccounts`); every employee runs on one of them (`Employee.claudeConfigDir`, empty = the machine's default login). When the account an employee runs on is used up and another account **on the same machine** has room and somebody logged in, the office puts the employee on that one and starts their session again there — continuing the same conversation — and tells them to go on with the task they had.

## Adding an account (an owner)

1. **Company → Claude usage → Add a Claude account…** Pick the machine (the office's own machines; a member's computer is theirs to arrange), keep or change the folder (`~/.claude-2` is offered), **Add**.
   The machine's agent makes the folder (mode 700) and, inside it, a link `projects` → the default account's `projects` folder, so the conversations are shared (see "Continuing the conversation").
2. The window shows a command. **Run it on that machine, as the user the office runs as**, and log in with the other account:
   ```
   CLAUDE_CONFIG_DIR=/home/<user>/.claude-2 claude
   ```
   then `/login`, finish in the browser, `/exit`. (On the server: `ssh` in first; see `OPERATIONS.md`, "Adding a Claude account".) The office never logs in for anybody and never sees a credential — the login is between that person and Claude Code.
3. **Check** in the window (or reopen Claude usage): the account shows who is logged in. From now on it takes employees.

An account can also be made by hand as before (`CLAUDE_CONFIG_DIR=~/.claude-second claude` on the machine, then the folder in an employee's profile); such a folder works, but the office moves people *to* an account only when it is on the machine's list, so add it there too. Adding a folder that already exists changes nothing in it except the `projects` link, and that only when the folder has no `projects` yet.

**Remove from the list** takes an account nobody is on off the list. Nothing on the machine is deleted.

## When an account counts as used up

Two signals, either is enough:

| Signal | Where it comes from | Code |
| --- | --- | --- |
| A window of the status line is at **99 % or more** and its reset time has not passed (5 hours or the week) | Claude Code gives every session's status line the account's `rate_limits`; the host agent passes them on | `SessionRegistry.onLimits` → `exhausted()` |
| **Claude refused a turn** for the limit | The `StopFailure` hook with an error that says rate limit, usage limit or billing | `hook-receiver.ts` → `SessionRegistry.onLimitHit` |

The second exists because the status line does not show every limit (a model's own weekly limit, for one). An account that refused a turn counts as used up until its nearest known reset of a window that is at 90 % or more, or **for an hour** when none is known (`AccountUsage.spentUntil`).

## The move (`SessionRegistry.failover`)

Runs when a report says an account is used up, when a turn is refused, and once a minute (`timings.accountFailoverMs`) — the last because an employee in the middle of a long turn reports nothing.

For every used-up account that has employees on it:
1. The other accounts of **the same machine** that are not used up are asked, right then, whether somebody is logged in (`claude.accounts` RPC). None → everybody stays and waits, as before.
2. Each employee goes to the account with the most room (the higher of its two percentages, plus a little for everyone this round already put there).
3. `employee.claudeConfigDir` changes. If they had a running session it is stopped and started again (`stop` → `wake`): the same tmux session name, the same folder, `--resume` of the same conversation, now with `CLAUDE_CONFIG_DIR` of the new account. If they had a task in hand they get a message: *"Your session was started again on another Claude account… Go on with T-12 … from where you were."* An employee with no session only changes account; nothing is started for them.
4. An `account.switched` event is written (it shows in the feed: who, to which account, until when the old one is out) and an audit entry.

Rules that keep it calm:
- **Nobody is moved twice within ten minutes** (the figures of the new account need a session to report them).
- **Nobody is moved back** when the first account resets. They stay where they are until *that* account runs out. Spreading people by hand is the profile's *Claude account folder*.
- Only accounts on the machine's list or already in use on it are candidates, and only with somebody logged in.
- **Settings → Employees → "Move employees to another Claude account when theirs runs out"** switches it off (`OwnerSettings.accountFailover`, on by default). Off: they wait for the reset.

**Move … to another account** on an account's card does the same at once for that account, whatever its figures, the ten minutes and the setting (`POST /api/hosts/:id/accounts/move`).

## Continuing the conversation

Claude Code keeps conversations in `<config folder>/projects/<folder name>/<session id>.jsonl`. An account folder made by the office has `projects` linked to the default account's, so `claude --resume <id>` finds the conversation whichever account it runs on. If it does not (a folder made by hand, with a `projects` of its own), the resumed start ends at once; the office already handles that case — "the earlier conversation could not be continued", and the next start is a new conversation in which the task is handed over again.

## Where things are

| | |
| --- | --- |
| The pool, the signals, the move | `packages/orchestration/src/registry.ts` — `addAccount`, `removeAccount`, `checkAccounts`, `onLimits`, `onLimitHit`, `failover`, `accountUsage`, `exhausted` |
| The refused turn | `packages/orchestration/src/hook-receiver.ts` (the `StopFailure` line near the end of `handle`) |
| The minute's look | `Engine.start` in `packages/orchestration/src/engine.ts` (`accountsTimer`) |
| On the machine | `apps/host-agent/src/agent.ts` — RPC `claude.accounts`, `describeAccount` (folder, link, who is logged in — two fields of `.claude.json`, nothing else) |
| Types | `Host.claudeAccounts`, `AccountUsage.{loggedIn, exhausted, spentUntil}`, `OwnerSettings.accountFailover` in `packages/contracts/src/entities.ts`; the RPC in `protocol.ts` |
| For people | `POST /api/hosts/:id/accounts` (add), `POST …/accounts/check`, `POST …/accounts/move`, `DELETE …/accounts?dir=` — **owners only** (no rule in `access.ts`); `GET /api/usage` as before |
| The window | `ClaudeAccounts` and `AddAccount` in `apps/desktop/src/hud/panels/ceo.tsx`; the toggle in `settings.tsx`; the folder field in `team.tsx` suggests the machine's accounts |

## Testing it

- `tests/e2e/25-account-failover.test.ts` — real sessions with the scripted worker in a home folder of its own: adding (folder, mode, link, refusals, owners only); nobody moved while no other account has a login; the move with a running session (same conversation, new `CLAUDE_CONFIG_DIR`, told to go on) and without one; a refused turn with figures that say 5 %; the switch off and on; the ten minutes; the owner's move; removing; a restart.
- `tests/e2e/13-claude-accounts.test.ts` — the reporting underneath (unchanged).
- The scripted worker (`tests/fixtures/fake-claude.mjs`): an account's figures are `fake-limits.json` in its config folder; the step `limit` ends a turn the way a refused turn ends (`StopFailure`, error `rate_limit`, no `Stop`).

## Limits, plainly

- **The same machine only.** An employee is not moved to another machine; accounts of two machines are two pools.
- A member's own computer: the member's accounts are theirs. Owners can add accounts to any machine through the API, but the window offers the office's own machines only; a member has no window for it.
- An API-key account reports no percentages; only a refused turn tells.
- If every account of a machine is used up, everybody waits, as before.
- Each account is somebody's Claude subscription: who may use which account for what is between the owner and Anthropic's terms; the office only starts sessions in the folders it is given.
- SDK-managed workers get `CLAUDE_CONFIG_DIR` like the others; the move was run with interactive sessions only.

## Not verified with real Claude Code

- That `--resume` of a conversation begun on one account continues on another through the linked `projects` folder (if it does not, the fallback above applies: a new conversation, the task handed over again).
- The exact text of the `StopFailure` error when a subscription's limit is reached (the office looks for "rate limit", "usage limit" or "billing" in `error` / `error_details`), and whether the status line's percentage reaches 99 before turns are refused.
- That a turn cut off mid-way and resumed goes on sensibly after "go on with T-…".
