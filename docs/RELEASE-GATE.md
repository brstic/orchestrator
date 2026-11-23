# The release gate

The owner, 2026-11-23, after reading how the last tickets went out: "it should not only be for production and for
pushing — review itself must be the gate: I see what they did, and if it is good I let it go on to where it has to go".
And their choices that day: the development servers stay free, the office really refuses (not only asks), and an owner
always opens the gate — a colleague's review is the first step.

## Why

On the live office the work went out before anybody approved it. An employee working **in place** (in the team's own
folder) committed, pushed to `master` and to the development branch, put it on the development server and — when the
boss said "go" on Telegram or in an answer to a question — a colleague pulled it onto production. The ticket's
**Approve** came afterwards and did nothing but close the ticket: the office merges nothing in place, and it never
pushes. So review was a formality that followed the release.

## What it does

With **Settings → Employees → "Nothing is released before I approve it (the release gate)"** on:

- **Free before approval:** working, committing, pushing one's **own branches**, putting work on the **development
  servers**, reading anything anywhere (production included).
- **Refused before approval** — a **release**:
  - a `git push` to a **protected branch** (`main`, `master` by default; *Protected branches*) — also `git push` with no
    branch named made from one, `HEAD:master`, `--all`, `--mirror`;
  - merging a pull request (`gh pr merge`, `glab mr merge`);
  - a command that names a **production server** (*Production servers*: a host name, an address, or a folder on one)
    **and changes something there**: `git pull/merge/reset/checkout/…`, `rsync`/`scp`, a database write
    (`mysql … ALTER/UPDATE/…`), installs and builds, restarting services, migrations, `sed -i`, `rm`/`mv`/`cp`/`tee`,
    writing a file with `>`; and a `git push` to a remote on a production server.

  The employee's machine holds such a command and the office answers at once: refused, with what to do instead
  ("hand it in with complete_task and a release_plan; when an owner approves it you are told, and this goes through").
  The refusal is in the feed ("… tried to release work before it was approved") and the audit log (`release.held`).
- **The hand-in:** `complete_task` takes **`release_plan`** — where the work goes once approved and how: branches,
  servers, steps, checks, who does which part. Work handed in with a plan **always waits for an owner**: a ticket
  reviewed by a colleague only (`peer`) becomes colleague-then-owner (`both`), one nobody was to review (`none`) goes to
  the owner (`boss`); the ticket's history says why.
- **In review** the owner sees what was done — the summary, the tests, the commits and the changed files (the
  *Changes* tab), the colleague's verdict — and, in **Your verdict**, *Where it goes once you approve it*.
- **Approve opens the gate** for its **author** and the **colleagues who worked on the ticket** (wrote on it, were
  named on it, helpers) — not its reviewers — for **3 hours**. Each is told: the author "Release it now, as you planned:
  …", the others that they may help. An approval by a colleague (the first step) opens nothing.
- **`report_released { task, note }`**: the author says it is out and how it was checked. It is written on the ticket
  ("Released. …"), the ticket shows *Released by … · when*, and the gate closes again for that ticket. A window that
  ran out with nothing reported says so on the ticket.
- **By hand:** in an employee's Talk, an owner has **Let release** (an hour, for a fix that cannot wait for a ticket);
  while it stands open the button reads *Release open · 14:20*, and a click closes it. On the record
  (`release.granted`, `release.closed`).

Not for a rented employee while rented (a client's work has its own terms, `docs/RENT.md`).

## How

| | |
| --- | --- |
| The rule | `packages/contracts/src/release.ts`: `ReleaseRules`, `releaseRulesOf(settings)`, `releaseOf(command, rules, cwd, branchOf)` — what a command releases, read from its text (quotes, `cd`, `git -C` followed); `pushTargets` |
| The machine | `apps/host-agent/src/agent.ts` `localPolicy`: with `LaunchSpec.release` (or as `session.release` changed it) on, a releasing Bash command is held (`orch_held_for: 'release'`, `orch_release`); `branchOf` asks git for the branch of a push that names none. `HostInfo.releaseGate` says the agent knows it |
| The office | `packages/orchestration/src/release.ts` (`Release`): `decide` (a pass or a refusal), `approved` (opens it, tells them), `reported`, `grant`/`close`, `push` (new rules to every running session at once), `instructions` (what employees are told, in their standing instructions and with every task). Passes in the key-value store (`release.passes`). Hooked in `hook-receiver.ts` (the held PreToolUse), `tasks.ts` (`completeFromAgent`: the plan and the owner's stage; `submitReview`: a person's approval opens it), `registry.ts` (the launch spec and the instructions), `mcp-tools.ts` |
| Server | `PATCH /api/settings` `{ releaseGate: { on, branches, hosts } }` (pushed to running sessions); `GET /api/release` (rules and who may release now), `POST`/`DELETE /api/employees/:id/release` `{ minutes }` — owners only (not in `access.ts`'s rules) |
| Windows | Settings → Employees (`ReleaseGateSetting`); the ticket (`Verdict`: the plan; `ReleaseState` after); Talk (`LetRelease`) |
| Model | `OwnerSettings.releaseGate`; `Task.release` (`TaskRelease`: plan, approved by/at, open until, released by/at, note); events `release.held`, `release.opened`, `task.released`; MCP `complete_task.release_plan`, `report_released` |
| Tests | `packages/contracts/test/release.test.ts` (what is a release), `packages/orchestration/test/release-gate.test.ts` (refused, opened for whom, reported, by hand), `tests/e2e/67-release-gate.test.ts` (a real session and a real remote: her branch goes and `main` does not; a plan sends the ticket to the owner; the approval lets the push through; reported out it closes; by hand) |

## Limits, plainly

- **A command is read for what it says**, like the fence of a rented employee. A push whose branch the command builds
  itself, a script that deploys on its own (`./deploy.sh` with no production server in its words), a CI pipeline that
  deploys on a push to a branch that is not protected, an HTTP call to a Git host's API that merges — none of these is
  seen. Name the production servers, and protect the branches your pipelines deploy from.
- **One pass covers all of an employee's releases while it is open**: an approval of one ticket lets its author push
  `master` for three hours — whatever is on their `master`. A shared branch carries whatever was committed on it.
- **A session started before the gate was switched on** gets it with its next command where its machine's agent is
  this build or newer (`session.release`); a member's computer with an older app does not hold anything until it is
  updated. A session gets the instructions at its next start (the refusal itself tells it the rest).
- Production servers that are not listed are not protected; read-only work on listed ones stays free.
- Tried with the scripted stand-in for Claude Code and a real Git remote, not yet with real Claude Code on the live
  office.
