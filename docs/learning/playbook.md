# Learning — the playbook

Area `playbook` of the Growth work. Code: `packages/orchestration/src/learning/playbook.ts`. Tests: `packages/orchestration/test/learning-playbook.test.ts`.

**Goal:** the right lesson reaches the right task, and the lessons stay free of duplicates by themselves.

**Cost:** none in Claude usage. Everything here is arithmetic over text the office already holds (lessons, task records). No prompt is delivered to any session, no model is asked anything.

## What it does

### 1. Relevance — which lessons a task prompt carries

Before, a task prompt carried the twelve newest active lessons by scope (the employee's own, then the project's, then the company's), whatever the task was about. Now, when a prompt is for a task (`TaskManager` hands the task to `Improver.playbookBlock`), the lessons are chosen by `selectLessons`:

- **The candidates** are the same as before: active lessons that are the employee's own, the task's project's, or the company's.
- **Text relevance (0–1).** The task is turned into weighted words: title 1, acceptance criteria 0.8, file paths it is known to touch 0.8, description 0.6, kind 0.5, project name 0.4, directories of what its dependencies changed 0.3. Each lesson is its `text` (weight 1) and its `appliesWhen` (weight 1.5). Words are lower-cased, stop-words dropped, lightly stemmed (plurals, -ing, -ed, -ion, a few developer short forms such as db → database). For every word a lesson shares with the task: rarity of the word among the candidate lessons (0–1, a small TF-IDF) × its weight in the lesson × its weight in the task. The sum `m` gives `relevance = m / (m + 2 × length factor)`, where the length factor (0.75–1.5) asks a little more of long lessons. One rare word of an "applies when" note found in a task title gives about 0.43; one common word from a description gives under 0.1.
- **Boosts**, added to the relevance: the employee's own lesson +0.15, a project lesson +0.08, a company lesson +0; learned on a task of the same kind +0.08; learned on a task that changed the same file +0.20, or a file in the same directory +0.10 (a lesson's files are the `filesChanged` of the tasks it cites, plus paths written in its text).
- **What a task is "known to touch":** `evidence.filesChanged` of its earlier attempts, the same of the task it reviews (a review is matched on the work under review: its title, description, acceptance and files), and file paths written in its title, description or acceptance. What its dependencies changed counts by directory only.
- **Newest-own quota:** the employee's two newest lessons get a place whatever they score, so a lesson just learned is tried before it has matched anything. The single best-fitting lesson is always placed first; the quota never displaces it.
- **Character budget instead of a count:** lessons are added best first until the next one would pass the budget (default 2400 characters of lesson lines; twelve lessons at their maximum length were about 6900). A lesson that does not fit is passed over and shorter ones further down may still go in. The best one always goes in.
- **Told once:** a lesson that says the same as one already chosen (an employee's own copy of a project lesson, for instance) is left out and listed as a duplicate.
- **Deterministic:** the same lessons and task give the same lessons in the same order, whatever order they are stored in (ties: higher score, then newer, then id).

**No task** (the system prompt at session start, a Talk message, the `get_playbook` tool): unchanged — the newest twelve by scope, counted the old way. The same happens for task prompts when `playbookRelevance` is switched off.

### 2. Say why — what is recorded per delivery

Each task prompt that carries lessons records:

- **On each lesson:** `appliedCount` +1 (this existing field is "times included"; it is not duplicated under another name), `playbook.lastIncludedAt`, and either `playbook.matchedCount` +1 (it fitted the task: relevance ≥ 0.12, or learned on the same file/directory) or `playbook.unmatchedStreak` +1.
- **On the task:** `Task.playbookLessonIds` — the ids of every lesson its prompts carried, over all deliveries of the task, in the order first given (best fit first). One line in the task's `history`: `Prompt carried N playbook lessons (best fit: "…")`.
- **One event** `learning.lessons_delivered` (with `taskId`, `employeeId`, `projectId`; `quiet`, so it does not fill the office feed). `data`: `{ auto, area: 'playbook', what, why, evidence, undo: null, key, attempt, budgetChars, usedChars, considered, lessons: [{ id, score, relevance, matched: [task words], reasons: [plain sentences], fits, newestOwn }], leftOut: [{ id, score, why: 'budget' | 'duplicate', of? }] }`.

`reasons` are ready to show, for example: `fits the task: migration, write` · `project knowledge` · `learned on a bug task` · `learned on src/billing/invoice.ts` · `one of their newest lessons` · `ranked down: included 8 task prompts in a row without fitting the task`.

**For the "outcomes" agent:** read `task.playbookLessonIds`. An id may belong to a lesson that was later folded into another one: that lesson is `retired` and its `playbook.mergedInto` names the lesson that carries on. Per-delivery detail (which attempt, which scores) is in the task's `learning.lessons_delivered` events (`GET /api/events?taskId=…`).

### 3. No duplicates

`Improver.saveLesson` (lessons from an agent, the owner, a captured answer, a meeting) now asks `Playbook.absorb` first. A lesson that is already in the **same scope** (same scope, employee and project) in the same or in other words is folded into the existing one:

- the clearer wording is kept (the owner's wording over an employee's; otherwise the one with more meaningful words; otherwise the longer), with its `appliesWhen` (or the other's when it has none);
- evidence is the union (at most 24 references); `createdAt` is the earlier; `status` is `active` if either was; `appliedCount` is added up;
- `playbook.mergedCount` +1 and `playbook.mergedFrom` gets `{ ts, lessonId, by, text, similarity }` (the last 8 are kept);
- event `learning.lesson_merged` with `undo` data. The very same call repeated with nothing new to cite records nothing.

**What counts as the same lesson** (`compareTexts`): the same words in the same order; or sharing at least 72% of their meaningful words — counted both plainly and weighted by rarity, the lower figure decides — or the shorter one being at least 90% inside the longer one (with four or more meaningful words). On top of that the two must have the same polarity and the same figures (see contradictions). Fewer than three meaningful words: only an exact match.

**The boss's recorded decisions** (`owner_answer`) are only ever merged when the words are the same. A different answer to the same question is never folded away.

**`consolidate()`** runs at the start of the existing periodic `analyze()` (after tasks and answers, and on `POST /api/improvements/analyze`). It does nothing when no lesson changed since the last pass. Otherwise it:

1. merges reworded copies already stored in the same scope into the older lesson (the absorbed lesson becomes `retired` with `playbook.mergedInto`);
2. promotes (below);
3. flags **contradictions** — two *active* lessons that one employee could be given together (same employee; same project; an employee and their project; anything and the company) that are alike as above but: one is a prohibition and the other is not (an odd number of words like never / not / don't / without / avoid / stop — a double negative is not a prohibition), or they give different figures or labels ("port 3000" / "port 3001", "option A" / "option B"), or they are two decisions of the boss on what reads as the same question. These are **proposed, never decided**: an `Improvement` of kind `playbook_contradiction` with action `advice`, citing both lessons (`EvidenceRef.kind: 'lesson'`), plus a quiet event `learning.contradiction_flagged`. Both lessons stay active. When the owner retires or rewords one, the next pass closes the suggestion (`applied`, event `learning.contradiction_closed`). A dismissed one is not raised again.

### 4. Promotion

When the same lesson (a near-duplicate, as above) is active in the own playbooks of two different employees of one project, it becomes a **project lesson**: `source: 'orchestrator'`, the clearer wording, the union of the evidence, `playbook.promotedFrom` = the employees' lesson ids. It is `active` when `autoApproveSharedLessons` is on, otherwise `proposed` (the existing "waiting for your approval" state, with a notification). Event `learning.lesson_promoted` either way (`data.proposed` says which). It happens the moment the second employee's lesson is saved, and in `consolidate()` for lessons already stored.

The employees' own lessons stay theirs. In a prompt they are told once (rule "told once" above). A project of an employee's own lesson is the project of the task it cites, else the project the employee works on. It is not promoted again if the project (or the company) already has that lesson in any state — including `retired`, which is how the owner says no.

### 5. Staleness

A lesson included in `STALE_AFTER` = 8 task prompts in a row without once fitting the task (`playbook.unmatchedStreak ≥ 8`) is **ranked down**: its score is halved for tasks it does not fit, and it loses its newest-lesson place. It is never retired here, it still goes in while there is room, and a task it does fit gets it at full strength (which also resets the streak). A lesson whose `appliesWhen` says it always applies ("always", "every task", …) is exempt.

### Undo

`POST /api/playbook/revert { eventId }` (owners only; `Playbook.revert`) takes back a `learning.lesson_merged` or `learning.lesson_promoted` event: an unmerge restores what that merge changed and makes the folded-in lesson a lesson of its own again (the two are marked `playbook.distinctFrom` each other and are not merged a second time); undoing a promotion retires the project lesson. It records `learning.reverted`. Reactivating by hand a lesson that was folded away has the same effect: it is not folded away again.

## Settings (both optional, at the end of `SelfImprovementSettings`)

| Setting | Default | Meaning |
| --- | --- | --- |
| `playbookRelevance` | on | Off: task prompts get the newest twelve lessons by scope, as before, and nothing is recorded on tasks. |
| `playbookBudgetChars` | 2400 | Characters of lessons per task prompt. Kept within 400–8000 when read (`playbookSettings()`), so a bad stored value cannot break a prompt. |

They are not in `DEFAULT_SETTINGS` and `core.ts` was not touched; absent means default. `autoApproveSharedLessons` (existing) decides whether a promotion is automatic.

## What the Growth window should show

Nothing in `growth.tsx` / `settings.tsx` was changed. Everything below is already in the state the client receives (`lessons`, `tasks`, `improvements`, `events`) or in `GET /api/events?taskId=…`.

**On a lesson**
- "Used in N task prompts" — `appliedCount` (already shown), plus "last used 3 days ago" — `playbook.lastIncludedAt`.
- "Fitted the task M of N times" — `playbook.matchedCount` of `appliedCount`. Say what it is: a count of word/file matches, not a measure of whether the lesson helped.
- "Ranked down — included 8 times in a row without fitting a task" when `playbook.unmatchedStreak ≥ 8` and `appliesWhen` does not say always.
- "Merged from K" — `playbook.mergedCount`, expandable to `playbook.mergedFrom` (who, when, the wording that was folded in, similarity).
- On a retired lesson with `playbook.mergedInto`: "Folded into ‹that lesson›" instead of plain "retired".
- On a project lesson with `playbook.promotedFrom`: "Recorded independently by ‹names of those lessons' employees›"; when `proposed`, the existing Approve / Reject buttons are the decision.
- Source `orchestrator` already has a badge.

**On a task**
- "Lessons given (N)" — `task.playbookLessonIds`, each opening the lesson.
- "Why" — the newest `learning.lessons_delivered` event of the task: per lesson its `reasons` (sentences), `matched` words and `score`; "K more applied but were left out (budget / duplicate)" from `leftOut`; `usedChars` of `budgetChars`.

**In the list of what the office did by itself** (generic `learning.*` rendering): `learning.lesson_merged`, `learning.lesson_promoted`, `learning.reverted` are visible events; `learning.lessons_delivered`, `learning.contradiction_flagged`, `learning.contradiction_closed` are `quiet`. An "Undo" button on merged / promoted rows: `POST /api/playbook/revert { eventId }`; hide it when a `learning.reverted` event has `data.revertedEventId` equal to that id (the server answers 409 then).

**Suggestions** — kind `playbook_contradiction` renders with the existing card ("Advice only"); its evidence chips are the two lessons (`kind: 'lesson'`, the chip shows the text as its title but does not open anything yet — opening the lesson would help). Useful: show the two lessons side by side with their Retire / Edit buttons.

**Settings** — a switch "Choose lessons by how well they fit the task" (`playbookRelevance`) and a number "Lesson budget per task prompt (characters)" (`playbookBudgetChars`, 400–8000).

## Decisions, and why

- **Lexical, not semantic.** A deterministic word score costs nothing, is the same every time and can say why ("fits the task: migration"). It misses synonyms. Rejected: asking a session to pick lessons (spends turns on every task) and embeddings (a model dependency this office does not have).
- **Relevance is "how much matched", not "what share of the lesson matched".** The first version divided by the lesson's length; a long lesson with the task's key word in its "applies when" then scored lower than a short lesson sharing a common word. Rarity is scaled 0–1 so scores mean the same in a playbook of five and of five hundred.
- **Fill the budget, do not cut at a relevance threshold.** General lessons ("run the verification command yourself") share no words with any task and are still worth having. Relevance decides what falls off, not what is allowed in.
- **`appliedCount` stays the one count of inclusions.** The brief's `timesIncluded` is that field; a second counter would only be able to disagree with it.
- **Merge conservatively.** A wrong merge silently drops a lesson's wording; a missed one costs a line in a prompt (and prompts already skip duplicates). Hence 72% on both counts, same polarity, same figures, exact match only for the boss's decisions — and every merge is an event that can be undone.
- **A contradiction is a suggestion with action `advice`.** `growth.tsx` switches over every `ImprovementAction` type, so a new action type would not compile without editing a file this area must not touch; and choosing which lesson is wrong is the owner's call anyway. Nothing was added to `ImprovementAction`.
- **Promotion leaves the employees' own lessons alone.** No hook into approval is needed, undo is one retirement, and "told once" keeps prompts clean. Rejected: retiring the originals on promotion (a rejected proposal would then have to restore them).
- **Promotion reuses the `proposed` lesson state** rather than an `Improvement`: the window already has Approve / Reject for it.
- **Staleness only counts against a lesson on tasks it does not fit,** so being ranked down can never hide a lesson from the task it was written for.
- **Settings are optional fields read through one function,** so `core.ts` (one line all five areas would have edited) stays untouched.
- **`learning.${string}` was added to `EventType`** as one template type rather than a list, so every area's `learning.*` events type-check without each adding names to the same union.

## Shared files touched

- `packages/contracts/src/entities.ts`: `Task.playbookLessonIds?` (end of `Task`); `'lesson'` at the end of `EvidenceRef.kind`; `Lesson.playbook?` and the new `LessonPlaybookMeta` (after `Lesson`); `'playbook_contradiction'` at the end of `ImprovementKind`; `playbookRelevance?`, `playbookBudgetChars?` at the end of `SelfImprovementSettings`.
- `packages/contracts/src/events.ts`: `` `learning.${string}` `` at the end of `EventType`.
- `packages/orchestration/src/improve.ts`: import and `readonly playbook`; `playbookBlock` takes an optional `task`; the exact-text duplicate check in `saveLesson` is replaced by `playbook.absorb`; `playbook.afterSave` after a new lesson is stored; `playbook.consolidate()` at the start of `analyze()` (in a try/catch so a fault there cannot stop the other findings).
- `packages/orchestration/src/tasks.ts`: the two `playbookBlock` calls in `start` pass the task.
- `apps/server/src/server.ts`: `POST /playbook/revert` at the end of the self-improvement routes. No rule in `access.ts`: a route without one is owners-only.

## Not verified / known limits

- **Never run against a real Claude session** (by the rules). Whether better-chosen lessons improve outcomes is not measured here — that is the "outcomes" area. Unit tests cover the functions and an engine without sessions; the existing `tests/e2e/05-self-improvement.test.ts` and `02-orchestration`, `08-postgres` pass with the scripted worker. A one-off end-to-end check (a real delivery through HTTP records `playbookLessonIds`, the event, the history line; a reworded lesson merges; revert works and answers 409 the second time) passed and was not kept as a file, since the brief asked for unit tests only.
- **Wording, not meaning.** Synonyms and irregular forms are missed ("keep" / "stays", "write" / "written"), so some rewordings stay two lessons. Word order is ignored: "restore the database before migrating" and "migrate before restoring the database" read as the same lesson and would be merged. The polarity check counts negating words; "skip the linter" against "run the linter" is not seen as a contradiction, and a flagged pair may not conflict at all — the suggestion says it is a comparison of wording.
- **English.** Stop-words, stemming and negations are English. Text in other languages (the owner's answers may be Serbian) is matched on exact words only.
- **The thresholds are judgement, not measurement:** 0.72 / 0.9 for duplicates, 0.12 for "fits", 8 for stale, 2400 characters, the boost sizes. They are constants at the top of the module.
- **Size.** A consolidation pass over 500 lessons took about 50 ms and over 1800 about 400 ms on this machine (synthetic lessons), once per change to the lessons; choosing lessons for a task took 3–8 ms.
- **`get_playbook` and the system prompt still use the old rule** (no task is passed). An employee asking for their playbook mid-task sees the newest twelve, not the task's selection.
- **Undoing an old merge after later merges into the same lesson** restores only what that merge brought (wording, date, evidence, count); it was tested for the straightforward cases, not for long chains.
- **Members.** Lessons were already visible to everyone in the office state; the new events follow the existing per-member event rule (`eventFor`). Nothing about that was changed or separately tested.
