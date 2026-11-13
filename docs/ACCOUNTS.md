# Several Claude accounts on one machine

How a machine of the office gets more than one Claude account, how employees are spread over them, and how the office moves an employee off an account that has run out. Read this before touching the accounts code in `packages/orchestration/src/registry.ts` (`addAccount`, `failover`, `onLimitHit`) or `describeAccount` in `apps/host-agent/src/agent.ts`.

_Built on 2026-11-11 on the owner's request: every employee on the server ran on one Claude account, and when it reached its limit the whole office waited for the reset. Why it is built this way: `DECISIONS.md`, "Several Claude accounts". **Run with the scripted worker only — see "Not verified" at the end before relying on it.**_

## The idea in one paragraph

To Claude Code an account is a **config folder**: `~/.claude` by default, any other folder when `CLAUDE_CONFIG_DIR` points at it. Each folder has a login of its own and an allowance of its own. The office keeps, per machine, a list of such folders (`Host.claudeAccounts`); every employee runs on one of them (`Employee.claudeConfigDir`, empty = the machine's default login). When the account an employee runs on is used up and another account **on the same machine** has room and somebody logged in, the office puts the employee on that one and starts their session again there — continuing the same conversation — and tells them to go on with the task they had.

## Adding an account (an owner) — all of it from the office

**Company → Claude → Add an account…** on the machine's line (the office's own machines that are online; a member's computer is theirs to arrange). Two kinds:

### A Claude account — signed in to from the window

1. **A Claude account**. The office chooses the folder (`~/.claude-2`, `-3`, …), has the machine make it (mode 700, with `projects` linked to the default account's so that conversations are shared — see "Continuing the conversation") and puts it on the machine's list.
2. The machine starts **Claude Code's own sign-in** for that folder (`claude auth login`, with `CLAUDE_CONFIG_DIR` at the folder) in a terminal of its own. The window shows what that terminal shows and turns the address it prints into a button: **Open the sign-in page** — it opens in *your* browser, on the computer you sit at.
3. Sign in there with the account you want, and **paste the code** the page gives into the window → *Send*.
4. The window says who is signed in. Done: the account takes employees from now on.

Nothing is done on the machine by hand: no folder to make, no `ssh`, no command. An account that is on the list and not signed in (or is to be signed in to as somebody else) has **Sign in…** / **Sign in again…** in its row — the same sheet; so has the machine's default login.

How it is built, and what passes through the office:
- On the machine: RPC `claude.login` (`start` / `screen` / `input` / `stop`) in `apps/host-agent/src/agent.ts` (`accountLogin`). The sign-in runs in a tmux session on **a tmux server of its own** (socket `<the agent's>-login`), so it is never listed, discovered or taken for an employee's session; it is 420 columns wide so that the long address is printed in one piece; it is killed when the sheet closes, when the agent stops, and after thirty minutes if nobody finished it.
- A Claude Code that has no `auth login` (the agent asks its `auth --help` once) is started as it is instead: in a folder nobody is signed in to it begins with its sign-in by itself. The window shows whatever the terminal shows either way, with ↑ ↓ Enter Esc for a choice it may ask for — it does not depend on the exact words.
- In the office: `SessionRegistry.accountLogin`; `POST|GET|DELETE /api/hosts/:id/accounts/login`, `POST …/login/input` — **owners only** (no rule in `access.ts`). The window asks for the screen every second and a half while the sheet is open.
- **What the office handles:** the text of that terminal (the address of the sign-in page, which is not a secret by itself) and the code you paste, on their way between your window and that machine. Neither is stored, logged, audited or sent to anybody else; the audit log says only that a sign-in was started, by whom, for which folder. The login itself — the token Claude Code gets for the code — is written by Claude Code into its own folder on the machine and never leaves it. (Until 2026-11-13 the rule was "the office never sees anything of a login"; the owner asked to do it from the office, and a code typed into a remote terminal passes through whatever shows that terminal.)

### Z.AI — GLM Coding Plan (Claude Code on another service's models)

**Z.AI — GLM Coding Plan**, then the **API key** from z.ai (and, folded away, which of Z.AI's models stand for *opus*, *sonnet* and *haiku*; empty = Z.AI chooses). The office chooses the folder (`~/.claude-zai`), and the machine writes into that folder's own `settings.json`, readable by its user only (mode 600):

```json
{ "env": { "ANTHROPIC_BASE_URL": "https://api.z.ai/api/anthropic", "ANTHROPIC_AUTH_TOKEN": "<the key>", "API_TIMEOUT_MS": "3000000" } }
```

(what Z.AI's own instructions for Claude Code say — <https://docs.z.ai/devpack/tool/claude>; their helper tool `@z_ai/coding-helper` writes the same into `~/.claude`) and marks the folder as set up (`hasCompletedOnboarding` in its `.claude.json`) so that the first session does not stop at Claude Code's first-run screens. A session started with `CLAUDE_CONFIG_DIR` at that folder talks to Z.AI; nobody signs in.

- An employee is put on it **by a person**: their Settings → *Claude account* → **Z.AI**. **The office never moves anybody onto it or off it by itself**: when an account runs out, its people go to another account *of the same service* on that machine (`failover` compares `AccountUsage.provider`). Taking somebody from Claude's models to another service's — or back — is a decision, not housekeeping.
- **The key** goes from your window to the server to that machine, and is written there. It is not kept by the office, not in the audit log (which says that an account was added, of which kind, in which folder), not in any event, and no answer contains it; the list knows the account as "Z.AI · with an API key" and whether a key is set. Changing the key is adding the account again with the same folder.
- No allowance is shown for it: Claude Code reports the 5-hour and weekly figures for a Claude subscription only.
- RPC `claude.provider` (`setAccountProvider`); `SessionRegistry.addProviderAccount`; `POST /api/hosts/:id/accounts/provider` (owners only). The same call with `provider: "custom"` and a `baseUrl` (https only) makes an account of any other service that speaks Claude Code's protocol; the window offers Z.AI only.

### By hand, as before

An account can still be made on the machine (`CLAUDE_CONFIG_DIR=~/.claude-second claude`, `/login`) and an employee put on it in their Settings (*Claude account → Another folder…*). The office moves people *to* an account only when it is on the machine's list, so add it there too: `POST /api/hosts/:id/accounts { "dir": "~/.claude-second" }` puts an existing folder on the list (and changes nothing in it except the `projects` link when it has none).

**Remove from the list** (open the account's row) takes an account nobody is on off the list. Nothing on the machine is deleted.

## An account is called by who is signed in to it

Everywhere an account is named — the Claude tab, an employee's Settings, the clocks on the wall — it is the **e-mail address** signed in to it (or "Z.AI"), and the folder is the quiet line under the name. The folder alone showed whenever the office did not know who was signed in, which was often: it learned it only from a running session's report, or when somebody pressed Check, and forgot it at a restart. Now the machine is asked (`claude.accounts`: its default login, the accounts on its list and every folder an employee there is on) **when it comes into the office**, when an employee is put on a folder, and after every sign-in; what it says — who, which organisation, which service — is kept with the account's record (`SessionRegistry.noteAccount`, in the store), so it is known after a restart too. An account nobody is signed in to is "Not signed in yet". In an employee's Settings the account is **chosen by that name** from the accounts of their machine (`lib/accounts.ts`: `accountName`, `accountChoices`).

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

**Move … to another account** (open the account's row) does the same at once for that account, whatever its figures, the ten minutes and the setting (`POST /api/hosts/:id/accounts/move`).

## Continuing the conversation

Claude Code keeps conversations in `<config folder>/projects/<folder name>/<session id>.jsonl`. An account folder made by the office has `projects` linked to the default account's, so `claude --resume <id>` finds the conversation whichever account it runs on. If it does not (a folder made by hand, with a `projects` of its own), the resumed start ends at once; the office already handles that case — "the earlier conversation could not be continued", and the next start is a new conversation in which the task is handed over again.

## Where things are

| | |
| --- | --- |
| The pool, the signals, the move | `packages/orchestration/src/registry.ts` — `addAccount`, `removeAccount`, `checkAccounts`, `onLimits`, `onLimitHit`, `failover`, `accountUsage`, `exhausted` |
| The refused turn | `packages/orchestration/src/hook-receiver.ts` (the `StopFailure` line near the end of `handle`) |
| The minute's look | `Engine.start` in `packages/orchestration/src/engine.ts` (`accountsTimer`) |
| On the machine | `apps/host-agent/src/agent.ts` — RPC `claude.accounts`, `describeAccount` (folder, link, who is logged in — two fields of `.claude.json` — and which service its `settings.json` names); `claude.login` (`accountLogin`), `claude.provider` (`setAccountProvider`) |
| Types | `Host.claudeAccounts`, `AccountUsage.{loggedIn, exhausted, spentUntil}`, `OwnerSettings.accountFailover` in `packages/contracts/src/entities.ts`; the RPC in `protocol.ts` |
| For people | `POST /api/hosts/:id/accounts` (add), `POST …/accounts/check`, `POST …/accounts/move`, `DELETE …/accounts?dir=` — **owners only** (no rule in `access.ts`); `GET /api/usage` as before |
| The window | `ClaudeAccounts`, `AddAccount`, `SignIn` and `ZaiAccount` in `apps/desktop/src/hud/panels/ceo.tsx`; the names in `apps/desktop/src/lib/accounts.ts`; `AccountField` in `team.tsx`; the toggle in `settings.tsx`; the folder field in `team.tsx` suggests the machine's accounts |

## Testing it

- `tests/e2e/25-account-failover.test.ts` — real sessions with the scripted worker in a home folder of its own: adding (folder, mode, link, refusals, owners only); nobody moved while no other account has a login; the move with a running session (same conversation, new `CLAUDE_CONFIG_DIR`, told to go on) and without one; a refused turn with figures that say 5 %; the switch off and on; the ten minutes; the owner's move; removing; a restart.
- `tests/e2e/13-claude-accounts.test.ts` — the reporting underneath.
- `tests/e2e/51-account-sign-in.test.ts` — the name known as soon as the machine is in the office; a new account signed in to from the office (the folder, the whole address in one line, a refused code, the right one, nothing left running, nothing typed or shown on the record); the default login signed in to again; owners only; a Z.AI account (the file, its mode, the key nowhere in the office, models added later with the rest of the settings kept, refusals); nobody moved to Z.AI by the office, and an employee put there by hand started with that folder. The scripted worker has `auth --help` and `auth login` (the "code" is the name the account gets).
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
- **Signing in from the office has never met the real sign-in.** It was built against Claude Code 2.1.323's `claude auth login --help` (which exists, takes `--claudeai`, `--console`, `--email`, `--sso`) and tried with the scripted worker, whose sign-in prints an address and waits for a code. What the real one prints, whether it asks anything before the address (the window has ↑ ↓ Enter Esc for that), whether the code it wants is exactly what the page shows, and whether it exits by itself when done, have not been seen. The first real sign-in is the test; if the window cannot finish it, the old way still works (the command is in the account's record as before).
- **A Z.AI account has never run a session.** What is written is what Z.AI's instructions say; that Claude Code started in such a folder goes straight to work — no first-run screen, no question about the key — and that the office's hooks, status line and `--resume` behave there as with a Claude login, has not been seen. Nor has a model name been tried: the three fields are passed on as typed.
