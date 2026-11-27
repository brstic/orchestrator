# Growth — capture

*Nothing the office could have learned from is lost.*

Module: `packages/orchestration/src/learning/capture.ts` (class `Capture`, held by the Improver as `engine.improver.capture`).
Tests: `packages/orchestration/test/learning-capture.test.ts` (14 unit tests), `tests/e2e/2x-learning-capture.test.ts` (5 tests with the scripted worker).

Before this, the office learned from two things: a retrospective after a task with friction, and the owner's answers to questions. Capture adds six sources that were already on the record, and makes the one paid step better.

## What it costs

**One step spends a Claude turn: the retrospective.** It existed before, its setting is unchanged (`selfImprovement.retrospectives`: `off` / `friction` / `always`), and it is now sent *less* often than before (see "no asking twice"), never more. Everything else in this document reads the office's own records and costs nothing. All of it is off when `selfImprovement.enabled` is off.

A refused lesson costs the session one more tool call inside the same turn, not a new turn.

## What it does

### 1. Better retrospectives

- **Facts in a structured form.** `Capture.facts(task)` returns typed facts, each printed as `- [kind] …`:

  | kind | what it says | new |
  | --- | --- | --- |
  | `attempts` | how many attempts, and what sent the work back | new |
  | `verification` | each *distinct* way verification failed, how often, exit code or timeout, and the exact end of the output (up to 900 characters, cut at a line) | before: only the last failure, cut from the front |
  | `review` | the reviewer's words, and who it was (the boss or a named reviewer) | reviewer was not named |
  | `merge` | the files that conflicted | as before |
  | `blocked` | the blocker, and the note the boss unblocked it with | the note is new |
  | `question` | what was asked, and who answered what (the boss, or — in records from before 2026-11-27 — the foreman) | foreman was not distinguished |
  | `denial` | each denied command and the boss's note | the note is new |
  | `nudge` | stopped without finishing | as before |
  | `told` | up to three messages a person sent the employee while the task ran | new |

  The events are queried by type, so a long task's early failures are no longer pushed out by tool events (the old query took the last 400 events of any type).

- **A lesson in a fixed shape.** `record_lesson` takes `lesson` (the rule, as an instruction), `applies_when` (the concrete trigger), `why` (the evidence) and `scope` (`self` / `project` / `company`) — or `none=true` with a `reason`. `checkLesson` refuses, at the tool boundary and with a message that says what is missing:
  - a rule that does not say what to do: fewer than four words, or fewer than two words left once words like "careful", "better", "always", "check" are taken out ("be more careful", "Always double check everything very carefully");
  - a trigger that is missing or means "always" ("every task", "whenever possible", "when working on code");
  - no evidence sentence;
  - `none=true` without a reason.

  Each refusal is recorded (`learning.lesson_refused`), and "nothing to learn" is recorded with its reason (`learning.nothing_to_learn`). The tool's description (`packages/integrations/src/mcp.ts`) shows what a good lesson looks like.

- **No asking twice.** Every lesson recorded by a session keeps what friction it is about (`captureOrigin.signatures`). When a finished task's friction is all covered by an active lesson of the same employee:
  - the task began *before* that lesson existed → no retrospective is sent (`learning.retro_skipped`): they could not have used it yet;
  - the task began *with* the lesson in the prompt → the retrospective says "You already recorded a lesson about this (id …): "…". It was in your prompt for this task, and the same thing happened again. Anything to change?" and offers `replaces="<id>"`. A lesson recorded with `replaces` retires the old one (own, employee-scoped, active lessons only; `learning.lesson_revised`, with the undo).

  If only part of the friction is covered, the ordinary retrospective is sent with a line naming the lesson they already hold.

### 2. Corrections, free

`detectCorrection(text)` decides whether a message reads as a correction or a standing preference. When a person (the owner, another owner, or an invited colleague — `from.kind === 'owner'`, message kind `chat`) writes such a message to an employee, the sentence that states the rule becomes a lesson: for that employee, or for the project when it is phrased for everybody ("we use…", "everyone must…"). The message is the evidence (`EvidenceRef.kind: 'message'`), with the task it was said during when there was one.

It is a **wording match, not an understanding of the message**, and it is conservative:

- counts: "don't / do not …", "never …", "always …" at the start of a sentence, "from now on", "going forward", "next time" (at either end), "stop using/adding/…", "avoid …", "no more …", "use X, not Y / instead of Y", "prefer X over Y", "we don't use / we never commit / we use X not Y", "everyone must …"; in other languages only phrases that cannot mean anything else (Serbian *od sada*, *ubuduće*, *nemoj nikad(a)*, *koristimo X a ne Y*; German *ab jetzt*, *ab sofort*; Spanish *a partir de ahora*; French *désormais*);
- does not count: questions; "don't forget / worry / bother"; a bare "don't…" or "stop…" tied to the moment or to the thing at hand ("yet", "for now", "this", "that", "just", "it"); remarks ("never seen this", "always fails on CI"); the speaker talking about themselves ("I'll handle deployments from now on"); statements that are not about practice ("we don't have a staging server"); anything inside `@@…@@` or a code fence.

The unit test holds a table of 22 corrections and 31 instructions.

**The owner's review rejection** (`submitReview('owner', …, 'request_changes', comments)`) and **a denied approval with a note** each become a candidate for the author, citing the review or the approval. If the words read as a standing rule, the rule itself is the lesson; otherwise the lesson quotes them ("Review feedback from the boss on feature work — "…"", "The boss denied "wget …" with the note: "…"").

### 3. Repeats, free

A new question from an employee is compared with the answered questions of the same project (`questionSimilarity`: shared words over all words, after dropping filler; a match at 0.6 or more).

- The earlier answer is attached: a line in the notification ("Answered before (asked by Alex), by the boss: "…"") and `Question.captureAnsweredBefore` on the question.
- If that earlier answer is active project knowledge (a lesson from `captureOwnerAnswer`), the knowledge did not reach — or did not register with — the session that asked: `learning.knowledge_missed` is recorded and the lesson's `captureMustInclude` goes up by one.
- **The question is never answered automatically.** It stays open for a person (or a project manager, for work it put on the board).

### 4. Failures, free

A failed verification is reduced to a signature: the command, and its failing lines with paths, numbers, ids, hashes, timestamps and durations taken out (`failureSignature`). Two failures are the same when the command is the same and at least 60 % of the words of those lines are shared (`sameFailure`). When the same failure is seen on a second *task* of a project, a factual lesson is proposed for the project:

> "npm test" fails with "FAIL src/cart/total.test.ts (6.02 s)" when src/cart/total.ts changes — seen in T-3, T-9.

"when … changes" is added only when every one of those tasks changed the same file or directory. Later tasks with the same failure are added to the same record. Timeouts are left out: a wrong limit is a process finding (`analyze()` already proposes that).

### 5. Onboarding

`onboardingBlock(employee, project, included?)` returns "What this team has learned on *project* so far", once per employee and project, with their first task there (`Employee.captureOnboarded`). The task prompt already carries the playbook, the verification command and the task, so the digest holds only what those leave out:

- active project and company knowledge that did not fit the playbook block (`included` defaults to `improver.lessonsFor(employee, project.id)`), must-include first;
- files where merges conflicted before;
- the most frequent verification failure seen on two or more tasks, unless it is already an active lesson.

It stays within `ONBOARDING_BUDGET` (1200 characters); lines that do not fit are left out and counted in the event (`learning.onboarded`, `omitted`). Someone who already worked on the project is not onboarded. With nothing to add, nothing is added.

Called from the two places a task prompt is assembled in `tasks.ts` (task and review), ahead of the playbook block.

### 6. Skills from work

`Employee.skills` is what was declared at hiring — the role's list, or what the owner typed — and it stays the owner's (the team panel edits it, and the system prompt says "Skills you are expected to apply"). Next to it, `Employee.captureSkills` is measured after every finished task (`MeasuredSkill[]`):

- `task_kind` — finished tasks per kind, and how many passed verification and review first time;
- `file_type`, `directory` — in how many finished tasks they changed files of that type / under that directory (top five each);
- `tool` — tool uses reported by the session's hooks (top five; from the last 2000 `agent.tool_finished` events).

The `get_team` tool now shows it to colleagues ("delivered: bug 1/2 first pass, feature 1/1 first pass; mostly in src/api, .ts"), so a request for help can go to whoever has actually worked there.

## Decisions, and why

1. **Which candidates become active.** Capture adds no policy of its own (`Capture.statusFor`):
   - words that read as a rule, for one employee → active in that employee's playbook, as their own lessons always were;
   - anything for the project or the company → proposed, unless `autoApproveSharedLessons` is on; switched on (and on
     every start while it is on), the team's retrospective lessons that were waiting go in too
     (`Improver.takeInWaitingTeamLessons`, event `learning.lessons_taken_in`; 2026-11-27 — before, they waited for good);
   - words that do *not* evidently state a rule (a review comment, a denial note) → **always proposed**, even for one employee. A comment like "the empty state is missing" is true of one task; putting it into every future prompt without a person saying it generalises would be noise. *The owner may want this different* (for example: activate after the same comment twice).
2. **A correction from an invited colleague counts like the owner's** when it is for one employee (they are allowed to instruct that employee). For the project it is proposed like everything shared. Messages between employees are never treated as corrections.
3. **Corrections are captured whether or not a task is in progress.** "From now on…" said to an idle employee is still a standing rule. The brief said "during a task"; the task is cited when there is one.
4. **`company` is now a real scope for `record_lesson`.** Before, `scope: "company"` was stored as a project lesson when the employee had a project.
5. **`none=true` needs a reason.** A refusal costs one extra tool call; the reason is what later tells whether retrospectives on this kind of friction are worth sending.
6. **`LessonSource` was not extended.** `growth.tsx` has an exhaustive `Record<LessonSource, …>`, so a new source would break the desktop build from outside the window agent's lane. Derived candidates use `source: 'orchestrator'`, and `Lesson.captureOrigin.kind` says which kind.
7. **A candidate the owner retired is not offered again** in the same words (review comments, denial notes, failures). A correction the owner *repeats* is recorded again: they said it again.
8. **A proposed candidate for one employee notifies as "Orchestrator proposes a lesson for Sarah"**, not "…a team lesson" (one line changed in `saveLesson`). Every owner review rejection therefore produces one info notification; if that is too much, the notification is the place to cut, not the capture.
9. **Secrets are redacted** (`redactSecrets`) from anything quoted into a lesson: messages, notes, failure headlines.
10. **Measured skills are not put into the system prompt.** They describe; they do not instruct. They are on the employee record and in `get_team`.

## Shared types, fields and events

Added at the end of their blocks in `packages/contracts/src/entities.ts`:

- `Lesson.captureWhy?`, `Lesson.captureOrigin?` (`CaptureOrigin`), `Lesson.captureMustInclude?`
- `Question.captureAnsweredBefore?`
- `Employee.captureOnboarded?`, `Employee.captureSkills?` (`MeasuredSkill[]`)
- `EvidenceRef.kind` gains `'message'`
- `EventType` gains `` `learning.${string}` `` (`events.ts`)

No new settings and no new routes.

Events (all `data: { auto, area: 'capture', what, why, evidence, undo, … }`):

| type | when | undo |
| --- | --- | --- |
| `learning.captured` | a candidate lesson was saved from a message, review, denial or repeated failure | `{ lessonId, status: 'retired' }` |
| `learning.knowledge_missed` | a question was asked again although its answer is project knowledge | `{ lessonId, captureMustInclude: <before> }` |
| `learning.question_repeated` | asked again, earlier answer attached, no knowledge to flag | — |
| `learning.failure_seen_again` | one more task failed the way an already recorded repeat failure did; the task was added to that lesson's evidence | — |
| `learning.retro_skipped` | a retrospective was not sent: a lesson about this already exists | — |
| `learning.lesson_revised` | a lesson was retired in favour of its author's sharper version | `{ lessonId, status: 'active' }` |
| `learning.onboarded` | the digest was added to a first task prompt | `{ employeeId, captureOnboarded: <before> }` |
| `learning.lesson_refused` | `record_lesson` sent a vague lesson back | — |
| `learning.nothing_to_learn` | the session answered `none=true` with a reason (`auto: false`) | — |

The undo data is recorded; nothing in this branch *performs* an undo from it (retiring a lesson is already possible through `PATCH /lessons/:id`).

`Employee.captureSkills` is recomputed from the task records after each finished task and records no event of its own: it is a count that can be derived again at any time, not a decision.

## What the window should show

- **A lesson's origin**, from `captureOrigin`:
  - `correction` — "from your message to Alex on T-12: "…"" (`from`, `toEmployeeId`, `taskKey`, `quote`), and that it was matched on the words `matched`;
  - `review_rejection` — "from your review of T-12: "…"";
  - `denial` — "from a request you denied: `command` — "note"";
  - `repeat_failure` — "the same failure on T-3, T-9" with the output in `quote`;
  - `retrospective` — "recorded by Alex after T-12".
- **`captureWhy`** under the rule: the evidence sentence.
- **Must-include**: a mark on lessons with `captureMustInclude > 0` ("asked again 2× although this was known").
- **Proposed candidates** should be approvable/dismissable for *employee* scope too (today's proposals are all shared). Dismissing = `status: 'retired'`.
- **On a question card**: `captureAnsweredBefore` — "Answered before (asked by Alex), by the boss: "…"", with a button that copies that answer into the reply box. It must stay the owner's click.
- **Employee profile**: "Measured from work" next to the declared skills, from `captureSkills` — kinds with first-pass counts, file types, directories, tools. Label the tool counts as "uses reported by hooks".
- **Evidence chips**: `kind: 'message'` could open the conversation with that employee (today it shows the word "message").
- **Activity**: the `learning.*` events above, generically; `retro_skipped`, `lesson_refused` and `nothing_to_learn` are what explain a retrospective that produced no lesson.

## For whoever merges this

- **Retrieval does not honour `captureMustInclude` on this branch.** `lessonsFor` is the playbook agent's; I set the flag and did not touch the ranking. Until retrieval sorts by it, a flagged lesson is only preferred inside the onboarding digest.
- `onboardingBlock` takes an optional third argument, `included`: pass it the lessons the playbook actually selected for that prompt if selection stops being `lessonsFor(employee, projectId)`.
- Candidates go through `Improver.saveCandidate` → `saveLesson`, so duplicate merging there applies to them. Capture relies on `saveLesson` returning the existing lesson for an exact repeat.
- `Improver.frictionFacts` was removed; `Capture.facts` replaces it.
- `tests/fixtures/fake-claude.mjs`: the scripted retrospective answers now carry `why` / `reason` (and `replaces` when asked "Anything to change?"), and there is a new directive `saw <text>` that prints whether the delivered prompt contained the text.

## Not verified

- **No real Claude session was run.** How a real model reacts to the new retrospective text, how often it is refused at the tool boundary, and whether refused sessions retry sensibly is untested. `tests/real/flows.ts` (which includes a retrospective) was not run: it spends the owner's usage.
- **The correction patterns are tested against a table I wrote**, not against the owner's real messages. Expect misses (it is conservative) and some false positives ("Don't change the API" said as a one-off, with none of the one-off words, would be kept for that employee).
- **Similarity thresholds (0.6 for questions and failures, 0.5 for other friction) are judgement**, checked on a handful of examples. Short outputs differ more easily: "x.txt is broken" and "y2.txt is broken" do not group.
- The "revise" retrospective and `replaces` are covered by the unit test, not end to end.
- Nothing was checked against PostgreSQL storage (`tests/e2e/08-postgres.test.ts` was not run); capture uses only `queryEvents` and the entity collections.
- The desktop app was typechecked, not opened: nothing in the UI shows the new fields yet.
