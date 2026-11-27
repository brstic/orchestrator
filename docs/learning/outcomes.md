# Outcomes — does the office know whether what it learned helped?

_Area "outcomes" of the Growth work. Module `packages/orchestration/src/learning/outcomes.ts`, tests `packages/orchestration/test/learning-outcomes.test.ts`._

Until now a lesson stayed active for ever and an applied improvement was never looked at again. This area measures both, from records the office already keeps, and acts on what it finds. Nothing here is delivered to a session, so **none of it spends Claude usage**.

## What it does

1. **The outcome of a task** — `outcomeOf(task, questions)` turns a finished task into one small record (`TaskOutcome`) with a friction score.
2. **Trends** — first-pass rate, mean friction, questions per task, approvals per task and cycle time: overall, by week, by project, by employee, by kind, and the last 20 tasks against the 20 before. `GET /api/growth/outcomes`.
3. **Did a lesson help?** — tasks that were given a lesson against comparable tasks that were not, with a verdict: `helping`, `no_effect_yet`, `not_helping`, `harmful`.
4. **Did an applied improvement help?** — tasks before it against tasks after it, judged on the measure that kind of change is about, with the same verdicts.
5. **Acting on it** — in the scheduled analysis (`Improver.analyze()`, which already runs after every finished task and every approval decision): retires lessons the record is against, marks lessons that clearly help as `proven`, and suggests undoing an applied improvement that made things worse.
6. **The employee's record** — `performance()` rows also carry the record with recent work counting more; learned routing reads that.

## The outcome of a task

Counted for tasks that are `DONE` through the office's own completion (the employee reported, the office checked: `evidence.summary` is set), have an assignee and are not reviews — the same tasks `performance()` counts. Tasks closed by hand are not measured.

| Field | Read from |
|---|---|
| `firstPass` | done with `friction.failedVerifications === 0` and `friction.reviewRejections === 0` |
| `verified` | `evidence.verification` is `measured` and passed (the office ran the command itself) |
| `failedVerifications`, `reviewRejections`, `mergeConflicts`, `blockers`, `questions` | `task.friction` |
| `approvalsAsked`, `approvalsDenied` | the `permission` questions recorded with this task's id (denials also from `friction.denials`) |
| `nudges` | `task.nudges` — **the last hand-over only**: the office resets this counter every time the task is handed over again |
| `sentBack` | `task.attempts` (a failed verification or a review that asked for changes sends the work back) |
| `cycleMs` | `completedAt − startedAt`: wall time from the first start, waiting included |
| `tokens` | `task.tokens` (a number) or `task.usage.inputTokens + outputTokens`, if a task record carries them. **It does not today**, so this is always `null` |
| `frictionScore` | the weighted sum below |

**Friction score** (`FRICTION_WEIGHTS`): failed verification 3 · review rejection 3 · merge conflict 2 · blocker 2 · approval denied 2 · question 1 · nudge 1 · approval asked 0.5. The reasoning: a failed verification or a rejected review is a whole extra round of work; a conflict, a blocker or a denial stops the work until someone steps in; a question or a nudge is one interruption; an approval request is a short one (a denied one therefore costs 2.5 in all). 0 is a clean run. The weights are a judgement, not a measurement — they order tasks sensibly, they are not minutes.

## Trends and the route

`GET /api/growth/outcomes` (needs: read) returns `OutcomesReport` (types in `packages/contracts/src/entities.ts`, end of the self-improvement block):

```
{ generatedAt, tasks, thresholds,
  trends: { overall, recent: { window: 20, last, previous }, byWeek[], byProject[], byEmployee[], byKind[] },
  lessons: LessonOutcome[], improvements: ImprovementOutcome[] }
```

Every trend row is flat — `{ key, label, tasks, firstPass, firstPassRate, meanFriction, questionsPerTask, approvalsPerTask, medianCycleMs }` — so a table or a simple chart can show it as it is. Rates and means are `null` for an empty group. Weeks start on Monday (UTC), are keyed by that day (`2026-11-09`), come oldest first, include weeks in which nothing was finished, and go back twelve weeks. A task belongs to the week it was finished in. Cycle time is the **median**, because one task that waited overnight for an answer would otherwise dominate a week.

**Who sees what.** Owners get everything. Anyone else gets the report counted only from what they may read — the same line `stateFor`/`eventFor` draw: tasks, employees and projects on another member's own computer are left out of every figure, and so are lessons and improvements about them (`outcomesScopeFor` at the end of `apps/server/src/access.ts`). A consequence: a colleague's verdict on a company-wide lesson is computed from the shared tasks only and can differ from the owner's — and it is the owner's (whole-office) verdict that the office acts on.

**Cost.** A finished task's outcome is worked out once and kept until that task's record changes. The verdicts for the whole office are kept until a task is finished or a lesson or improvement changes. A report for a non-owner is computed on request from the kept outcomes.

## Did a lesson help?

**Which lessons a task was given** is read through one accessor, `lessonsGivenTo(task, lessons)`:

- `task.lessonIds` when the task has it (the playbook area records it; the field does not exist in this branch and is read without being declared);
- otherwise worked out from dates: every lesson in the task's scope (its employee's, its project's, the company's) that existed when the task was first started and was not retired by then.

The fallback cannot see the cap of 12 lessons per prompt, a shared lesson that waited for the owner's approval (it counts from the day it was written), or a lesson that was retired and re-activated. Each `LessonOutcome` says which it used: `basis: 'recorded' | 'inferred'`. **With the fallback every comparison is before/after**; only recorded `lessonIds` can tell apart tasks from the same days.

**The two sides.** *With*: finished tasks given the lesson. *Without*: finished tasks the lesson could have applied to (the employee's for a playbook lesson, the project's for a project lesson, everyone's for a company lesson) that were not given it. The tasks a lesson was learned from (its `evidence`) are on neither side — they are trouble by selection, and counting them as "without" would make any lesson look good.

**Like with like.** Tasks are only compared within the same **project, kind and employee** (the brief asked for project and kind; the employee was added because who did the work is the largest difference between tasks, and a newcomer or a reshuffle would otherwise be read as the lesson's effect). Each such cell with tasks on both sides gives a difference; the differences are averaged using the with-side's share of tasks per cell. So "against 61% without" means: what the tasks without it did, for the same mix of work. Tasks in cells with only one side are left out, and the counts say so (`given` is every task given it; `firstPass.tasksA` is how many of them could be compared).

**The test.** Two measures: first-pass rate (should rise) and friction score (should fall). For each, the difference and its standard error — for the rate, from each cell's pooled proportion with one pass and one fail added (so a cell where everything passed does not claim certainty); for friction, from the spread of values around their own cell-and-side mean. A measure is **clearly better or worse** only when both hold:

- the difference is at least the minimum that matters — 15 points of first-pass rate; for friction, a fifth of the without-side's mean and at least 0.25;
- it is at least 1.645 standard errors from zero (95%, one-sided).

| Verdict | When |
|---|---|
| `no_effect_yet`, reason `too_few` | fewer than **8 comparable tasks on either side**. `needed` says how many are missing on each side. Always — 2 clean tasks against 12 failed ones is "not enough data" |
| `harmful` | first-pass clearly worse; or friction clearly worse and first-pass not clearly better |
| `helping` | first-pass clearly better and friction not clearly worse; or friction clearly better |
| `no_effect_yet`, reason `mixed` | first-pass clearly better but friction clearly worse |
| `no_effect_yet`, reason `no_room` | the tasks without it already go so well (first-pass above 85%, friction below the minimum that matters) that no improvement could show |
| `not_helping` | at least **20** comparable tasks were given it, and for every measure that had room to improve, a worthwhile improvement is ruled out: the minimum that matters is more than 0.84 standard errors above what was measured (80%, one-sided) |
| `no_effect_yet`, reason `unclear` | everything else |

What that means in tasks, for a first-pass rate around 50%: to be called helping or harmful the difference has to be about 41 points with 8 tasks a side, 34 with 12, 26 with 20, 18 with 40, and the floor of 15 from about 60. "Not helping" on equal rates typically takes 50–60 tasks a side, because friction is noisy. This is slow on purpose.

`not_helping` uses a lower bar (80%) than the other verdicts (95%). The reason is what it leads to: retiring a lesson, which is recorded and undone with one click, whereas at 95% it would take well over a hundred tasks a side and never happen in a small office.

Each `LessonOutcome` carries a ready line, e.g.

- `given to 12 tasks: 92% first-pass, against 42% without — helping`
- `given to 10 tasks: 100% first-pass, against 100% without; friction 0.1 a task, against 2 without — helping`
- `given to 2 tasks — not enough data: 2 of them can be compared with 12 tasks without it (same project, kind and employee); 8 are needed on each side`
- `not given to any finished task yet — not enough data: 8 comparable tasks are needed with it and 8 without`

Lessons still `proposed` were never in a prompt and are not judged. Retired lessons stay in the report with their figures.

## Did an applied improvement help?

For each `Improvement` with status `applied`: the **last 20 tasks finished before** `decidedAt` against the **first 20 started after** it, among the tasks it touches (the project or employee its action names; for advice, the one the suggestion was about). Tasks under way when it was applied belong to neither side. Compared like with like, as above. The verdict stops moving once 20 tasks have been done after the change: it answers "did it help when it was made".

| Kind | Judged on | Better is | Guard |
|---|---|---|---|
| `allow_rule` | approvals asked per task | lower | first-pass rate must not clearly fall |
| `autonomy` | approvals asked per task | lower | first-pass rate must not clearly fall |
| `deny_rule` | approvals denied per task | lower | — |
| `review_policy` (review switched on) | review rejections per task, shown as "problems caught by review per task" | **higher** | — |
| `review_policy` (review switched off) | review rejections per task | lower | first-pass rate |
| `verify_command` | share of tasks with a verification the office ran itself and that passed | higher | — |
| `verify_timeout` | failed verifications per task | lower | — |
| `sequencing` | merge conflicts per task | lower | — |
| `acceptance_criteria`, `routing` | first-pass rate | higher | — |
| any other kind (added by other areas) | friction per task | lower | — |
| `revert_improvement` | not measured | | |

`harmful`: the measure is clearly worse, **or the guard is** (more freedom that made the work worse is harmful even though it asked for fewer approvals). `helping`: the measure is clearly better. `not_helping`: 20 tasks after, room to improve, and a worthwhile improvement ruled out. Same minimums and confidence as for lessons; same 8 tasks a side before anything is said.

The report gives `before` and `after` as full stats blocks, the judged `metric` with its before/after values, and a line, e.g. `approvals asked per task: 2 before (10 tasks), 0 after (10 tasks); first-pass rate fell from 90% to 20% — harmful`.

## Acting on it

`Outcomes.act()` runs at the end of `Improver.analyze()`. It does nothing while self-improvement is off.

- **Retire.** A lesson is set to `retired` when `retirable(lesson, outcome)`:
  - verdict `harmful` with at least **12** comparable tasks given it (and 8 without), or verdict `not_helping` (which needs 20);
  - the lesson is the office's own (`retrospective`, `meeting`, `orchestrator`) — **never the owner's words** (`owner`, `owner_answer`): those get a verdict in the report and are left for the owner;
  - it has not been retired by the office before. The lesson keeps `outcomesRetired: { at, verdict, why }`; once somebody re-activates it, it is theirs and is **never retired automatically again**.
  - Setting **`selfImprovement.outcomesAutoRetire`** (default on) switches this off entirely.
  - Recorded as event `learning.retired` (and in the audit log, actor `orchestrator`) with `data: { auto: true, area: 'outcomes', what, why, evidence, undo, lessonId }`: `why` is the verdict line, `evidence` the numbers (both comparisons, counts, basis), `undo` is `{ type: 'lesson.status', lessonId, status: 'active' }` — which is `PATCH /api/lessons/:id { "status": "active" }`.
- **Proven.** A lesson whose verdict is `helping` gets `proven: true` (event `learning.proven`, quiet, undo `{ type: 'lesson.proven', lessonId, proven: false }`). A proven lesson whose verdict later becomes `harmful` or `not_helping` loses the mark (`learning.unproven`) — also when it is not retired. A verdict that merely drops back to `no_effect_yet` leaves the mark, so it does not flicker. Not behind the setting: it changes nothing an employee is told.
- **Suggest undoing.** An applied improvement whose verdict is `harmful` gets one suggestion of kind `revert_improvement` (added at the end of `ImprovementKind`), action `advice`, with `outcomesRevertOf` naming the improvement, the before/after line in its rationale and up to 8 of the tasks after the change as evidence. It appears in Growth like any suggestion and notifies the owner. **Nothing is reverted here.** Proposed once per improvement (dedupe key `revert:<id>`), also after a dismissal. Recorded with the existing `improvement.proposed` event, whose data also carries `auto`, `area: 'outcomes'`, `why`, `evidence`, `revertOf` and `undo: { type: 'improvement.dismiss', improvementId }`.

## The employee's record and routing

`performance()` returns the same rows and counts as before; each row now also has

```
outcomes: { weight, firstPassRate, routingRate, meanFriction, lastCompletedAt }
```

- every finished task weighs `0.5 ^ (age / 45 days)`; `weight` is their sum, `firstPassRate` and `meanFriction` are weighted the same way;
- `routingRate` is that first-pass rate with one pass and one fail added.

`routingBonus(employee, kind)` keeps its signature and its formula `(rate − 0.5) × 4`; what changed is the rate it reads:

| | Before | Now |
|---|---|---|
| Has a say from | 2 completed tasks of the kind | 2 completed tasks whose weights add up to at least 1.5 — two recent ones, or more older ones |
| 2 of 2 passed | +2 (the maximum) | about +1; 10 of 10 gives +1.67, 20 of 20 +1.82 |
| Six clean tasks ten months ago | +2 | no say |
| Failed six in a row four months ago, passed the last three | −0.67 | about +0.7 |
| Reason on the task | `2/2 bug tasks passed first time` | the same, plus `, 76% counting recent work more` when the weighted rate differs from the plain one by 10 points or more |

The bonus still only breaks ties between suitable employees (role fit is worth 4–5, the bonus at most ±2).

## Decisions, and why

- **Slow to speak.** 8 comparable tasks a side before any verdict, a minimum effect, and a significance test. The comparisons are observational, so the rules err towards "not enough data".
- **Compared within project, kind and employee** — stricter than asked; see above.
- **The tasks a lesson was learned from count on neither side.**
- **The owner's own lessons are never retired by the office**, and neither is anything a person re-activated.
- **"Not helping" requires room to improve.** Without it, a lesson in a project that already runs well would be retired for not improving on 95%.
- **A lower bar for "not helping" (80%) than for "helping"/"harmful" (95%)**, because the only consequence is a reversible retirement.
- **A review gate switched on is judged on what it catches** (more is better), not on "fewer rejections": before it there were no reviews, so rejections could only go up and every review gate would look harmful. The brief's "review rejections for a review change" is kept as the measure; the direction is the decision.
- **`verify_command` is judged on the share of tasks the office verified itself**, not on failed verifications, for the same reason (before it, nothing could fail).
- **Reverting is suggested as advice with `outcomesRevertOf`** rather than a new action type: a new member of `ImprovementAction` breaks the exhaustive `switch` in `growth.tsx`, which this area does not edit.
- **Retiring a harmful lesson is not announced with a notification**, only with the event in the feed. A suggestion to undo an improvement does notify (warning), like every suggestion.
- **Types of the report live in `contracts`** so the Growth window can use them.

## What the Growth window should show

(Specification for the area that owns `growth.tsx` and `settings.tsx`; nothing of this is built here.) Fetch `GET /api/growth/outcomes`; refetch when a `task.completed`, `learning.*` or `improvement.*` event arrives.

- **Per lesson**, under its text: `LessonOutcome.line` as it is — e.g. "given to 14 tasks: 86% first-pass, against 61% without — helping". Tone by `verdict`: helping = success, harmful = danger, not_helping = warning, no_effect_yet = muted. A "proven" badge when `lesson.proven`. For `basis: 'inferred'` a hint: "worked out from dates: tasks before the lesson against tasks after it". For a lesson with `outcomesRetired`: "Retired by Orchestrator on <date>: <why>" and a **Re-activate** button (`PATCH /lessons/:id {status:'active'}`), with the note that it will then not be retired automatically again.
- **Per applied improvement**: `ImprovementOutcome.line`, and on demand the before/after blocks (`before`, `after`: tasks, first-pass rate, friction, questions, approvals, median cycle time) side by side. When `revertProposalId` is set, link to that suggestion.
- **A `revert_improvement` suggestion**: show the improvement named by `outcomesRevertOf` and say plainly that applying it only records the decision unless reverting has been wired in by the area that owns it.
- **The trend table**: `trends.byWeek` as a small chart of first-pass rate with task counts (weeks with 0 tasks are gaps, not zeros), and tables for `byProject`, `byEmployee`, `byKind` with columns Tasks · First-pass · Friction · Questions/task · Approvals/task · Cycle time (median). Above them `trends.recent`: "last 20 tasks: 80% first-pass (the 20 before: 65%)".
- **How to read it**: a short note built from `thresholds` — "A verdict needs 8 comparable tasks on each side. Tasks are compared with tasks of the same project, kind and employee. This is before/after counting, not an experiment."
- **Events** `learning.retired`, `learning.proven`, `learning.unproven` follow the shared shape (`data.what`, `data.why`, `data.evidence`, `data.undo`).
- **Settings**, self-improvement section: a toggle for `outcomesAutoRetire` — "Retire lessons that do not help. When finished tasks show, with enough of them, that a lesson the office learned makes no difference or makes things worse, Orchestrator retires it and says so in the feed. Your own lessons and answers are never retired, and you can re-activate any lesson."

## For the lead: connecting the areas

- **playbook** — write `task.lessonIds: string[]` (the ids actually put in the prompt, `[]` for none) when a task is handed over; `lessonsGivenTo` picks it up with no change here. `Lesson.proven` is the flag retrieval can prefer. Leaving a lesson out of some prompts on purpose is the only thing that turns these before/after comparisons into something closer to an experiment, and the only way a lesson that predates a project's work ever gets a "without" side.
- **autopilot** — reverting: suggestions of kind `revert_improvement` carry `outcomesRevertOf` (the applied improvement's id; its `action` says what to reverse). If autopilot applies or reverts things by itself, `improvementOutcomes` already measures anything with status `applied` and a `decidedAt`. A reverted improvement should stop being `applied`, or it will keep being measured.
- **detect** — new improvement kinds are judged on friction per task unless a row is added to `judgedOn()` in `outcomes.ts`.
- **window** — the section above.

## Shared files touched

- `packages/contracts/src/entities.ts` — `Lesson`: `proven?`, `outcomesRetired?` (end of the type); `PerformanceStat`: `outcomes?` (end); `ImprovementKind`: `'revert_improvement'` (end); `Improvement`: `outcomesRevertOf?` (end); `SelfImprovementSettings`: `outcomesAutoRetire` (end); new types after it: `TaskOutcome`, `OutcomeStats`, `OutcomeTrendRow`, `OutcomeTrends`, `OutcomeVerdict`, `OutcomeUndecided`, `OutcomeComparison`, `LessonOutcome`, `ImprovementOutcome`, `OutcomesReport`.
- `packages/contracts/src/events.ts` — `'learning.retired' | 'learning.proven' | 'learning.unproven'` at the end of `EventType`.
- `packages/orchestration/src/core.ts` — `outcomesAutoRetire: true` at the end of the default `selfImprovement` settings (existing offices get it through the merge with defaults at start).
- `packages/orchestration/src/improve.ts` — import; field `outcomes` and its construction; `performance()` returns the rows through `outcomes.decorate`; `routingBonus` body calls `routingEvidence`; one line at the end of `analyze()`.
- `packages/orchestration/src/index.ts` — export of the module (last line).
- `apps/server/src/server.ts` — the route, after the improvements routes; one name added to the `access.ts` import.
- `apps/server/src/access.ts` — rule `GET /growth/outcomes` at the end of `RULES`; `outcomesScopeFor` at the end of the file; one type added to an import.
- `apps/server/test/access.test.ts` — one test at the end; one name added to the import.
- `docs/ACCESS.md` — one line under "What each level covers" for the new route.
- Not touched, by the shared rules: `STATUS.md`, `CHANGELOG.md`, `DECISIONS.md`, `ARCHITECTURE.md` — this file is what the lead folds into them.

## Not verified, and limits

- **Never run on real work.** Everything is tested on fabricated records (and the existing self-improvement end-to-end test with the scripted worker still passes). No real office has enough finished tasks yet for any verdict; whether the thresholds are right for how the owner's office really works is a guess until it has run for some weeks.
- **Observational.** Before/after cannot separate a lesson from anything else that changed at the same time: another lesson, a different kind of work within the same kind, a new model. Lessons recorded together (one retrospective can record three) have identical sides and get identical verdicts — if that verdict is harmful, all of them are retired. Work that gets better over time by itself flatters every lesson.
- **The verdict is looked at after every finished task.** Repeated looks make a chance crossing likelier than the nominal 5% (or 20% for "not helping"). The minimum effect and minimum counts limit this; it is not corrected for.
- **Small-sample approximation.** The test uses the normal curve; for friction with few tasks a t-test would ask for slightly more (about 1.76 instead of 1.645 standard errors at 8 a side).
- **`lessonIds` does not exist yet**, so `basis` is always `inferred` today; the `recorded` path is tested with fabricated tasks only.
- **Tokens are never available today** (`tokens` is always `null`); there is no per-task token record to read.
- **Nudges** are those of the last hand-over only.
- **The route** is covered by the access test (who gets which scope, and that nothing of a member's computer is in a non-owner's report) and by unit tests of the report; it was called once by hand as the owner through a test office with the scripted worker (two tasks, one lesson: the figures and the "not enough data" line came back as expected), not as a member through the door, and there is no committed end-to-end test for it.
- **The Growth window shows none of this yet** — the report, `proven`, `outcomesRetired` and the setting have no UI until the window area adds it. Until then the setting can only be changed through `PATCH /api/settings`.
- **Reverting** an improvement does not exist in this branch: applying a `revert_improvement` suggestion only records that the owner took it on board.
