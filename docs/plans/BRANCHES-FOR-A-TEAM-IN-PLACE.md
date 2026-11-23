# Plan: a team that works in place moves to branches of its own

_Status: the owner chose on 2026-11-23 (below); what the office needed is built; the pilot is in "The pilot"._

The owner asked for it after the measurements of 2026-11-23 (`docs/TASKS.md` §1, "What was checked, said"; the
release gate, `docs/RELEASE-GATE.md`): every ticket of the live office's biggest team was worked **in place** — several
employees in one shared checkout, on the shared `master` — so the office merged nothing, checked nothing of the order
in which work landed, and the release gate has to read command text to keep `master` and production closed.

## What the team does today (read from its own repository instructions)

- One checkout per repository on the office's server; several employees work in it at once (`in_place`,
  `Task.touched` tells their files apart).
- Work is committed on `master` (sometimes on a long-lived feature branch) and pushed to the team's Git server.
- **The development server is a clone of `master`**: "push master, pull on dev, test there, then pull on production".
  Production is a checkout of `master` too, pulled by hand after the boss's go.
- Since 2026-11-23 the release gate refuses the push to `master` and the pull on production until an owner approved
  the ticket. Trying work on the development server before that means checking the employee's **own branch** out there
  (free); employees are told so in the gate's instructions.

## What changes (the office's `worktrees` workspace, which exists: `docs/ARCHITECTURE.md`)

- Each employee gets a worktree of their own next to the repository (`.orchestrator-worktrees/<repo>/<employee>`) and a
  branch per task (`orch/<employee>/<task>`) from the integration branch. Nobody edits the shared checkout; nothing of a
  colleague's half-done work is in their way.
- **Before approval:** commit and push the task branch; try it on the development server by checking that branch out
  there; hand in with `release_plan`. The office verifies the branch (the project's command, or the syntax check).
- **On approval:** the office merges the branch (`--no-ff`) into `orchestrator/integration` and runs the checks there;
  a conflict blocks the ticket for its author.
- **Release:** `master` is fast-forwarded to integration — by the owner (*Projects → Integration → Promote*, as today),
  or by the author as the first step of the approved release plan (the gate is open for them) — then pushed, pulled on
  development and on production, and reported with `report_released`.

## What was decided (the owner, 2026-11-23)

1. **Trying on the development server from the task's branch** (checked out there), not from `master`: yes.
2. **Who moves `master`:** the author, as the approved release plan says (`git merge --ff-only` of the integration
   branch in the repository, then `git push origin master`; the gate is open for them after the approval).
3. **Long-lived feature branches:** not in the pilot (its repository has only `master`).
4. **The pilot:** the repository with the fewest branches and the least shared work, for a week; then the
   measurements again (`checkHealth` on the operations wall; conflicts; time from approval to release).

## Measuring it

`node --no-warnings scripts/measure-work.mjs <the office's orchestrator.db> --days 14 --project <the pilot's project>`
(read-only; on the server, with its Node). The baseline, read on the live office on 2026-11-23 for all projects over 14
days: 173 work tickets (147 code), checked by the office with its tests 0 (2 only parsed, the syntax check being new
that evening); colleagues' approvals 131, 3 saying what they checked (the rule being new that evening); owners'
approvals 107, 4 with a word; sent back at least once 12%; work 18 min median (1.9 h p90), in review 19 min median
(2.6 h p90); merged by the office 0; released and reported 0. The pilot's project had no tickets yet.

## What was built for it

- With the gate on, in a project of worktrees, an employee is told (standing, and with each task —
  `Release.branchRelease`, `systemPromptFor(… branchPush)`, `taskPrompt(… branchPush)`): push only your task branch, to
  try it on the development server (check it out there); when approved, the office merges it into the integration
  branch; then release as planned — `git merge --ff-only <integration>` in the repository (on its base branch),
  `git push origin <base>`, the development server back on the base branch and pulled, then production, then
  `report_released`. Without the gate, or in place, nothing changes ("never push" stands).
- `tests/e2e/69-branches-and-gate.test.ts`: a real remote — the task branch pushed, `main` refused before approval, the
  approval merges into integration, the author fast-forwards `main` and pushes it, reported out.

## How the switch is made (once decided)

- Only when the team has nothing in progress in that repository: the project's *Workspace* goes from `in_place` to
  `worktrees`, base branch `master`. Uncommitted files in the shared checkout stay where they are (they were never the
  office's). To build: the employees are told of the change in their next task prompt.
- Nothing in production or on the development server changes by the switch.
- Back: the project's *Workspace* set to `in_place` again; the worktrees stay until removed by hand.

## Not covered

- Repositories that deploy by a CI pipeline on push (the gate's limit stands: protect the branches it deploys from).
- Members' own computers: their projects keep what their owner chose.
