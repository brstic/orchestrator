# Growth: what the office notices, and the Growth window

Area "detect" of the Growth work. Code: `packages/orchestration/src/learning/detect.ts`, tests `packages/orchestration/test/learning-detect.test.ts`, the window `apps/desktop/src/hud/panels/growth.tsx`.

## Part A — detectors

`Improver.analyze()` already proposed eight things (allow rule, deny rule, autonomy — no longer, since there are three levels —, review policy, missing verify command, verify timeout, sequencing per file, acceptance criteria). It now also runs the detectors below. Each one:

- reads **recorded history only** (task records and their histories, questions, the event log, host records). Nothing is delivered to a session, so none of it costs Claude usage. It runs where `analyze()` already ran: shortly after every finished task, and on "Look again now".
- hands its finding to the existing `propose` path, so the result is an ordinary `Improvement` with evidence refs, a stable `dedupeKey`, an `improvement.proposed` event and a notification.
- never acts by itself. Whether a proposal is applied without the owner is the autopilot's business, not this module's.
- reads only the last **30 days** (`DETECT.lookbackDays`), so a proposal describes how the office works now.

All thresholds are the constants in `DETECT` at the top of the module.

| # | Detector | Fires when (defaults) | Proposal | Action |
|---|---|---|---|---|
| 1 | Task size — split | ≥ 3 large tasks of a project (description + acceptance ≥ 1500 characters, or ≥ 15 files changed) that needed ≥ 3 attempts or ≥ 2 review rejections, **and** large tasks needed rework more often than the project's smaller ones | `task_size`, key `task-size:split:<project>` | advice |
| 1 | Task size — batch | ≥ 5 completed tasks that were tiny (in progress ≤ 10 min, ≤ 2 files, no friction) and depend on another tiny task, and they are ≥ 60 % of the project's completed code tasks | `task_size`, key `task-size:batch:<project>` | advice |
| 2 | Dependencies — folder habit | ≥ 2 merge conflicts in one folder where another employee's task, **in progress at the same time**, changed the same file(s) — over ≥ 2 different files (one file colliding repeatedly is the existing "sequencing" finding) | `dependencies`, key `deps:area:<project>:<folder>` | advice naming the folder |
| 2 | Dependencies — link two tasks | the folder threshold above is met, and two tasks that have **not started** each depend on one side of such a conflict | `dependencies`, key `deps:link:<later>:<earlier>` | `task.dependsOn` |
| 3 | Routing | in one project and kind: someone completed ≥ 3 with ≤ 1/3 passing first time, and a colleague who may be given that project's work completed ≥ 3 with ≥ 80 % first time. Off when "learned routing" is off | `routing`, key `routing:<project>:<kind>:<colleague>` | `project.routing`; advice when the colleague's role is not one the scheduler gives that kind to |
| 4 | Questions that should not be needed | a question that was answered is asked again ≥ 2 times in the same project (same wording: ≥ 60 % of the distinctive words in common) | `missing_context`, key `context:<project>:<first question>` | `project.notes.append` (the decision, in the owner's words) |
| 5 | Stalls | ≥ 3 incidents with the same cause in one project (see below) | `stall`, key `stall:<project>:<cause>` | advice naming the cause and the remedy |
| 6 | Verification — proves nothing | a verify command with ≥ 5 measured passes and no failure at all, of which ≥ 2 tasks were then sent back by review or reopened after DONE | `verify_quality`, key `verify-weak:<project>:<command hash>` | advice |
| 6 | Verification — environment | ≥ 3 failed verifications (timeouts excluded), ≥ 80 % showing the same environment error, on ≥ 2 tasks | `verify_quality`, key `verify-env:<project>:<error>` | advice quoting the line |
| 7 | Machine load | ≥ 2 separate resource warnings of one machine during which a session stopped mid-task or a verification timed out (10 minutes of slack either side) | `machine_load`, key `load:<host>` | advice |
| 8 | Idle capacity | an employee with no event and no assigned work for ≥ 3 days, while ≥ 2 unreleased backlog tasks of a kind they take have waited ≥ 1 day in a project they can work on | `idle_capacity`, key `idle:<project>` | advice |

### Stall causes (detector 5)

A stall is only counted when the record shows it need not have happened; a ready task waiting because everyone suitable is busy is a queue, not a stall.

| Cause | What is read |
|---|---|
| `waiting_approval` / `waiting_answer` | a permission request / question that waited ≥ 30 min for an answer (or is still open) |
| `machine_offline` | a ready task waited ≥ 60 min while its assignee's machine (or every free suitable employee's machine) was disconnected, from `worker.disconnected`/`worker.connected`. Members' own computers are not counted: they go when the member does |
| `unassigned_no_auto` | a ready, unassigned task waited ≥ 60 min, the project does not auto-assign, and someone suitable had nothing in progress for at least that long (from the tasks' own histories) |
| `nobody_qualified` | a ready, unassigned task waited ≥ 60 min and nobody who can work on the project has a role that takes its kind |
| `assignee_unavailable` | a ready task still waits for someone marked "not available for work" |
| `project_paused` | released tasks have been ready ≥ 24 h in a project that is paused now |
| `session_down` | a session stopped while its employee had a task in progress and stayed down ≥ 30 min |
| `quiet_after:<event type>` | a task in progress, no event at all from its employee for ≥ 45 min, grouped by the last event before the silence ("after the same step"). Silences explained by a waiting question, a stopped session or a disconnected machine are left to those causes. Sessions that report fewer than 3 events in a stretch (no hooks) are skipped |
| `ready_unexplained` | someone suitable was free, the project auto-assigns, and the task still waited; proposed **only** when the incidents cluster at one time of day |

"At the same hour": when ≥ 60 % of a cause's incidents began inside one 4-hour window, the rationale says which (the office's clock).

### What it does not do, and why

- **"Answered by the task description"** (part of detector 4) is not built. Whether a description already answers a question cannot be judged from the record without a model; only "this was already answered and was asked again" is measurable.
- **Machine load is advice.** The office has no setting that limits sessions per machine (`HostRegistry.exhausted` only holds back new work above 95 % memory/CPU for 30 s). The proposal names the number the record supports (the smallest session count at which work was lost, minus one), but nothing can be switched on. The history available is the `host.resource_warning` events; memory/CPU at the moment a task started is not recorded, so "started while the machine was loaded" is approximated as "lost during a warning or within 10 minutes of it".
- **Stalls do not duplicate the foreman.** The foreman handles live items (this question, this blocked task, this ready task). The detector reports a pattern over weeks and its structural remedy.
- **No lowering of anyone's autonomy, no reassignment of work in hand.** Routing is a preference for future tasks; the repeated-questions finding adds context for everyone and says who asked only as information.

### New actions, what `apply` does, and the inverse

`Improver.apply` calls `applyDetectAction` for these and stores what it returns on the improvement as **`previous`** (new optional field `Improvement.previous`). `revertDetectAction(eng, improvement, actor)` is exported for the revert path ("autopilot"): it performs the inverse, returns one plain sentence saying what happened, and **does not change the improvement's status** — whoever calls it decides that. It is not wired to a route in this branch.

| Action | apply | `previous` | Inverse (`revertDetectAction`) |
|---|---|---|---|
| `task.dependsOn { taskId, dependsOnTaskId }` | adds the dependency. A READY task whose new dependency is not done goes back to BACKLOG and **stays released**, so the scheduler makes it READY again by itself. Refused (409, nothing decided) when the task has started or it would be a circle | `{ dependsOn: string[], status }` | removes that one id from `dependsOn` (not if it was already there before); the scheduler releases the task again |
| `project.routing { projectId, kind, employeeId }` | sets `project.detectRouting[kind] = employeeId` (new optional field on `Project`). `TaskManager.pickEmployee` adds a decisive bonus for that person when they are free and suitable; when they are not free the task goes to someone else as before. The history note reads "Auto-assigned to X (track record: preferred for bug tasks in Shop, a suggestion you accepted)" | `{ employeeId: string \| null }` (the earlier preference) | puts the earlier preference back, or removes it; left alone if someone changed it since |
| `project.notes.append { projectId, text }` | appends `text` as a line of `project.docs` (the "Documentation notes" employees read with `get_project_context`) | `{ docs: string }` | removes that one line; anything written in the notes since stays |

None of the three lets an agent do more without asking, so all are "safe" for the autopilot dial. Advice has no inverse and stores no `previous`.

### Proposing once, and not nagging (`mayPropose`)

Before: a `dedupeKey` that had ever been proposed was never proposed again — a dismissal was final, and so was "applied". Now, for **every** proposal (the eight earlier findings included):

1. not while an earlier one with the same key is undecided;
2. not for 30 days (`coolingOffDays`) after the latest one was decided — dismissed, applied or undone (`revertedAt` is honoured if another branch adds it);
3. after that, only when the new proposal cites at least 2 records (`freshEvidence`) that no earlier proposal with that key cited.

So a "no" stays a "no" until the record has really grown. Detectors with a precise action also check the state first (dependency already there, note already written, preference already set).

## Part B — the Growth window

One line at the top, then four tabs. The old tabs (Suggestions, Playbooks, Team knowledge, Track record, Teach) are gone; everything they did is still there.

- **Top line — the dial** (`AutopilotDial`, also under Settings → Growth): a sentence saying what the office does now, and three choices bound to `selfImprovement.autopilot`: "Ask me first" (`off`), "Apply what is safe" (`safe`, default), "Apply more on a clean record" (`trusted`). When learning is off it says so, with "Switch on". Owners only. "More settings" opens Settings → Growth (retrospectives, team lessons, learned routing).
- **Waiting for you**: proposed improvements and lessons proposed for the team, each with what it is based on (first three records, "Show all"), what saying yes does, one primary button ("Yes, do it" / "Yes, allow it" when agents get more freedom / "Got it" for advice / "Yes, use it" for a lesson) and "No". "Look again now" re-reads the record. "Decided earlier" is folded underneath, with Undo on applied changes.
- **Done by itself**: every `learning.*` event, newest first — `data.what` (or the summary), `data.why`, evidence chips, and **Undo** when `data.undo` is present. Read from `GET /api/growth/log` plus the events that arrive live.
- **What the team knows**: all lessons, searchable, grouped People / Projects / Company, with "Add a lesson" (the former Teach form), Edit, Retire, Reactivate, Approve/Reject. Each lesson shows how many prompts it was put into; `timesIncluded`, `lastUsedAt` / `lastIncludedAt` / `lastAppliedAt`, and `verdict` (string or `{ label | state | status, note }`) / `proven` are shown when the lesson record carries them.
- **Results**: the track record ("Who delivers what"), what learned routing does with it, accepted routing preferences, and — when `GET /api/growth/outcomes` exists — its trends under "Is it getting better?". When that route answers 404 the section is not rendered.

### What the Undo button understands (`undoStep` in growth.tsx)

- `data.undo.improvementId`, or `data.improvementId` with any non-null `data.undo` → `POST /api/improvements/:id/revert`. The server's message is shown if it refuses. Undo is hidden once the improvement is no longer `applied`.
- `data.undo.lessonId` (or `data.undo.lessons: [...]`, or `data.lessonId` with a non-null `undo`), each with the `status`, `text` and/or `appliesWhen` to put back → `PATCH /api/lessons/:id`. With no status given, a retired lesson is made active again and an active one retired.
- Anything else: the entry is shown without Undo.

### What `GET /api/growth/outcomes` should look like for the trends to show

A list, or `{ trends | outcomes | metrics | rows: [...] }`, of rows with `label` (or `title`/`name`/`metric`), figures as `before`+`after` (or `previous`+`value`), optional `unit` (`%` with a 0–1 figure is shown as a percentage), `note`, and `better: boolean` (or `direction`/`trend`/`verdict` text). Rows it cannot read are left out.

## Shared files touched

- `packages/contracts/src/entities.ts`: `ImprovementKind` (+7, at the end), `ImprovementAction` (+3, at the end), `Improvement.previous`, `SelfImprovementSettings.autopilot`, `Project.detectRouting`.
- `packages/orchestration/src/improve.ts`: import; the dedupe line in `propose` now calls `mayPropose`; `analyze()` calls `runDetectors` before returning; three `case`s at the end of `apply`.
- `packages/orchestration/src/tasks.ts`: import; three lines in `pickEmployee` (the routing preference).
- `packages/orchestration/src/core.ts`: `autopilot: 'safe'` in the defaults; `sanitizeSelfImprovement` used where settings are loaded and updated.
- `packages/database/src/index.ts`, `postgres.ts`: `EventQuery.typePrefix`.
- `apps/server/src/server.ts`: `GET /growth/log`; `apps/server/src/access.ts`: its rule (`read`, filtered per event like `/events`).
- `tests/ui/driver.cjs`: the Growth steps.

## Not verified

- Every detector is verified on **fabricated histories** in unit tests (fires on one that fits; silent on a single incident, other files, too few records, old records). None has been seen firing on a real office's history, so the thresholds are reasoned defaults, not tuned ones.
- The question matching is a measure of wording (shared distinctive English words), not of meaning; the proposal says so and shows the questions. Questions in other languages are compared without a stopword list.
- `quiet_after` depends on sessions reporting events through hooks; how noisy it is with a real Claude Code session that thinks for a long time without a tool call has not been observed.
- The dial is only a control in this branch: nothing here applies anything by itself. It becomes true once the "autopilot" branch is merged. Likewise Undo calls `POST /improvements/:id/revert`, which this branch does not have (it answers "Not Found" until then), and the outcomes section has only been exercised against a 404.
- The "Done by itself" log and the lesson numbers were written against the convention in COMMON.md and the field names in the brief, not against the other branches' actual data.
- `GET /growth/log` was checked by hand against a running test office (empty, then two `learning.*` events newest first); it has no test of its own in the repository.
