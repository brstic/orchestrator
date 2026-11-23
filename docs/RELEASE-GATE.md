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
  - a change on a **production server** (*Production servers*: a host name, an address, or a folder on one). What is
    read is **what runs there** — the command given to `ssh` (also when the ssh and the host sit in variables,
    `S="ssh -p …"; $S user@host '…'`, and the heredoc it is fed) — and what is **copied onto it** (`scp`/`rsync`/`sftp`
    to it; from it is reading): `git pull/merge/reset/checkout/…`, SQL that writes (`UPDATE … SET`, `INSERT INTO`,
    `ALTER TABLE`, …, also inside a PHP or a `mysql -e` there), installs and builds, restarting services, migrations,
    a crontab put in, a deploy script run, `rm`/`mv`/`cp`/`tee`/`mkdir`/`sed -i`/`>` on anything **outside `/tmp`**;
    a program sent from this machine to run there (`php /dev/stdin < probe.php`, `bash -s < x.sh`) is read from its
    file when the machine can, and held when it cannot; and a `git push` to a remote on a production server.
    **Not a change:** what the command does here (its findings written to a file, a request to the site), probes
    written into `/tmp` there, and reading — logs, `git log`/`status`, `crontab -l`, `SELECT`s. (Measured on a week of
    the live office's own commands, 19 771 of them: the first version held 241, most of them reads; this one holds 71
    — 28 pushes to `master`/`main`, and on production `git pull`s, files written into the application or the home
    folder, scripts sent to run there, crontab backups — and of the 174 it lets through none was found to change
    production by these rules. `packages/contracts/test/release.test.ts`.)

  The employee's machine holds such a command and the office answers at once: refused, with what to do instead
  ("hand it in with complete_task and a release_plan; when an owner approves it you are told, and this goes through"),
  and what is free meanwhile, by what was refused: for production, that reading it and probes in /tmp there are free;
  for a program sent from the machine, to put it in the command (a heredoc) so the office can read it.
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
- **A development server that follows a protected branch** (it pulls `master`): employees are told to try their work
  there from their own branch (push it, check it out there — free), not by pushing `master`.
- **A project of worktrees** (each employee a branch of their own): they push only their task branch (to try it on the
  development server), and once approved release it by fast-forwarding the base branch to the integration branch and
  pushing it (`Release.branchRelease`; `docs/plans/BRANCHES-FOR-A-TEAM-IN-PLACE.md`).
- **No separate release tickets:** employees are told not to open a ticket only to release work that is handed in or
  approved — its release is the `release_plan` of the ticket whose work it is (on the live office a manager made
  "release … to production" tickets, which were done first and reviewed afterwards).
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

- **A request to a production site is not read** (`curl -X POST https://…/api/…`): what an application's own API
  changes is the application's to guard.
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
- Tried with the scripted stand-in for Claude Code and a real Git remote, and **seen on the live office with real
  Claude Code** (2026-11-23): an employee writing a helper into a folder of its own on the production server was
  refused, and 18 seconds later put the same helper on the development server and went on. Before the rule read only
  what runs there, one false refusal was seen there too: a file of the team's own repository being written here
  merely mentioned a production site.
