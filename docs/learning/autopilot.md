# Learning — the autopilot

The office applies what it has learned by itself, where that is safe, and takes it back when it was wrong.

Code: `packages/orchestration/src/learning/autopilot.ts` (class `Autopilot`, reachable as `engine.improver.autopilot`).
Tests: `packages/orchestration/test/learning-autopilot.test.ts` (18 unit tests), `tests/e2e/23-learning-autopilot.test.ts` (4, scripted worker), one assertion in `apps/server/test/access.test.ts`.

It costs nothing to run: it reads the office's own records (questions, tasks, events, the audit log). No model, no prompt, no Claude usage.

## What it does

`Improver.analyze()` still proposes improvements exactly as before. After every analysis the autopilot looks at **every open proposal** (not only new ones — evidence grows, and the daily allowance refills) and applies the ones the dial allows, through `Improver.apply` — the same path as the owner's click — under the actor name `autopilot`.

Analysis runs when it always did: a moment after each permission decision, after each finished task, and when somebody clicks *Re-analyse now*. There is no timer of the autopilot's own.

### The dial

One office-wide setting, `settings.selfImprovement.autopilot`:

| Position | In plain words |
| --- | --- |
| `off` | Nothing is applied without a person. Every suggestion waits, as before this existed. |
| `safe` (default) | The office applies by itself only changes that cannot let agents do more without asking: deny rules, turning required review on, a longer verification timeout, a lower autonomy level, and switching on a lesson that concerns one employee only. Anything that widens permissions waits for you. |
| `trusted` | Additionally the office applies changes that *do* widen permissions — an allow rule, one step more autonomy, review off — but only when the record passes a fixed evidence rule, and each such change starts on probation: a denial or a failure in that time takes it back. |

`safe` is the default **for new and for existing offices** (the owner asked for autonomy). An office updated to this version therefore starts applying its open non-widening suggestions at the next analysis, at most three per project per day.

With self-improvement as a whole switched off (`selfImprovement.enabled: false`) the autopilot is off whatever the dial says. Counter-signals for changes already on probation are still acted on: taking something back only narrows.

Second setting: `settings.selfImprovement.autopilotMaxPerDay` — at most this many automatic changes per project in any 24 hours (default 3, kept between 1 and 20). Changes about an employee count against that employee's project; lessons too. What does not fit stays proposed and is looked at again at the next analysis. Oldest proposal first.

Both are sanitised in `core.ts` (`sanitizeAutopilot`): an unknown word or a non-number changes nothing.

### The table: widening or not

One table in code, `AUTOPILOT_TABLE`, classifies every `ImprovementKind` (which actions it may carry) and every `ImprovementAction` (widening or not). `classify()` reads it.

| Action | Widening? |
| --- | --- |
| `project.policy.allow` | yes, always |
| `project.policy.deny` | no |
| `project.requireReview` | `true`: no · `false`: yes |
| `project.verifyTimeout` | longer than now: no · anything else (shorter, equal, unknown project): **counts as yes** |
| `employee.autonomy` | lower than now: no · higher, equal, or unknown employee: yes |
| `advice` | no |

| Kind | May carry |
| --- | --- |
| `allow_rule` | `project.policy.allow` |
| `deny_rule` | `project.policy.deny` |
| `autonomy` | `employee.autonomy` |
| `review_policy` | `project.requireReview` |
| `verify_timeout` | `project.verifyTimeout` |
| `verify_command`, `sequencing`, `acceptance_criteria`, `routing` | `advice` |

**Anything unknown counts as widening**: a kind that is not in the table, an action that is not in it, or an action its kind is not expected to carry. And a widening change with no evidence rule (below) is never automatic. So a new kind of proposal is inert for the autopilot until somebody gives it a row — on purpose. `kinds` is typed `Record<ImprovementKind, …>`: adding a kind to the contracts without a row is a compile error, which is the reminder.

"Widening" means permission to act unasked: more pre-approved commands, a higher autonomy level, less review. It is not a judgement about whether a change is a good idea.

### What `safe` applies, precisely

- **Deny rule** — when the record *as it is now* still says "always no": at least 3 denials of exactly that command shape in that project and not one approval. Only rules of the form `Bash(<one or two plain words>:*)`. Not when the shape is a single everyday word (`git`, `npm`, `node`, `ls`, `rm`, `cat`, …: the list `NEVER_DENY_ALONE`) — blocking that would stop the work itself, which is for a person to decide.
- **Review on** — as proposed.
- **Longer verification timeout** — up to 3600 s, and only when at least two verifications have timed out *since the limit was last raised by an improvement*. (The analyser counts every timeout on record; without this check each new reading would double the limit again on the same old evidence.)
- **Lower autonomy** — as proposed. (Nothing proposes this today.)
- **A lesson scoped to one employee** that is still `proposed` is switched to `active`, if that employee, an owner or the office wrote it. A lesson another employee wrote about them waits, and so do the foreman's. Each lesson is switched on by itself once only. (Today workers' own lessons are active from the start, so this mostly matters for lessons other learning modules propose.)

**Advice is not applied.** Proposals whose action is `advice` (set a verification command, sequence work on a file, write acceptance criteria, routing) change nothing when applied — in the UI the button reads "Mark as taken on board". The office marking its own advice as taken on board would hide it from the one person it is meant for and record something that did not happen, so these wait. They become automatic the day they get a real action with a row in the table.

### What `trusted` adds, and the evidence each needs

The numbers are `Timings` (so tests can lower them); the defaults:

**An allow rule** (`autopilotAllowApprovals: 5`, `autopilotAllowSpreadMs: 24 h`) — all of:
- the rule is `Bash(<shape>:*)` for a shape of one or two plain words;
- at least **5 approvals** of commands that read to exactly that shape, in that project — by the owner or by a colleague (whoever may decide that employee's requests);
- **no denial, ever**, of any command in that project that contains that shape — also as one part of a chained command;
- the approvals come from **at least 2 different tasks, or span at least a day** from first to last;
- neither the shape nor any command of that shape ever *requested* in that project (approved, denied or still open) matches the **high-risk list** (`DEFAULT_HIGH_RISK_PATTERNS` plus the project's own);
- **never broader than what was observed**: approvals of `docker build …` carry `Bash(docker build:*)` and nothing else — not `Bash(docker:*)`;
- never for a word that runs other things or reaches anywhere when it stands alone (`sh`, `bash`, `env`, `xargs`, `sudo`, `ssh`, `rm`, `curl`, `node`, `python`, `git`, `npm`, `docker`, `make`, … : `NEVER_ALLOW_ALONE`), nor for a shape whose next argument names what to run (`npm run`, `npx`, `docker run`, `go run`, `git config`, … : `NEVER_ALLOW_SHAPES`).

**Autonomy up** (`autopilotAutonomyTasks: 5`) — all of:
- one level at a time, and never beyond **`standard`**: `autonomous` and `auto` are always a person's decision;
- none of the employee's permission requests was ever denied, and at least 5 were approved;
- their last 5 completed tasks all passed verification first time, were never sent back by review and had nothing denied;
- never the foreman.

**Review off** (`autopilotReviewOffTasks: 10`) — the project's last 10 reviewed tasks were all approved first time. (Nothing proposes this today; the rule exists so that the table has no widening action without one.)

Any other widening change — including everything unknown — has no evidence rule and is never automatic.

`autopilot.verdict(improvement)` returns whether it would be applied now and the reason in a sentence ("3 of the 5 approvals needed are on record"). It is not exposed over HTTP yet.

### What is recorded

For every automatic change:
- the same audit entries as a click, under `autopilot`: `improvement.applied`, and `project.updated` / `employee.updated`;
- on the improvement, `autopilot`: `{ appliedBy, auto, appliedAt, widening, undo, probation, reverted, noAuto, history[] }` (`ImprovementAutopilot` in `entities.ts`). **Improvements a person applies get the same record** (with `auto: false`, no probation), so they can be undone exactly too;
- an event `learning.applied` — summary "Applied by itself: …", `data: { auto: true, area: 'autopilot', what, why, evidence, undo: { improvementId, route, restore }, improvementId, kind, widening, bucket, probation }`. (The improver's own `improvement.applied` event is marked quiet for automatic changes so the feed does not say it twice.);
- a notification "Applied by itself: …" of severity `info` that is **created already resolved**: it is in the list, it never raises the unread count. The "Suggestion: …" notification that asked for a decision is resolved at the same moment.

### Probation and automatic rollback

Every automatic change is on probation for **7 days or the next 5 finished tasks** of the affected project (or employee), whichever comes first (`autopilotProbationMs`, `autopilotProbationTasks`; review tasks do not count). The end is recorded as `learning.kept` (quiet).

During probation these counter-signals take the change back at once:

| Change | Counter-signal |
| --- | --- |
| allow rule | a command containing that shape is **denied** in that project · a command of that shape that matches the **high-risk list** is requested (asked is enough) · a task of that project **fails verification and the output names the shape** |
| autonomy up | one of that employee's requests is **denied** · their task **fails verification** (a timeout does not count) · a **review sends their work back** |
| review off | a review **requests changes** on a task of that project · the **integration tests fail** after a merge |
| deny rule, review on, longer timeout, lower autonomy | none defined here. They are on probation for the record and the undo list; measuring whether they helped is the "outcomes" area. |

A rollback restores what was there (see *Undo*), records `learning.reverted` with the evidence (`data.auto: true`, `data.undo` = how to apply it again), writes `improvement.reverted` to the audit log under `autopilot`, and puts the improvement **back to `proposed`** with `autopilot.noAuto: true`: it waits for the owner, with its history, and is **never applied automatically again**. The owner gets an ordinary (unresolved) notification "Taken back: …".

`autopilot.rollback(id, reason, evidence)` is public so another learning module can report a counter-signal of its own.

What a person applied is not on probation: a later denial is theirs to weigh.

### Undo for the owner

`POST /api/improvements/:id/revert` — owners only, exactly like apply (neither is on a guest's list in `access.ts`, so both fail closed; asserted in `access.test.ts`). It reverses any applied improvement, whoever applied it:

| Action | Undo |
| --- | --- |
| allow / deny rule | removes exactly that rule — unless it was already in the policy before the improvement was applied (then applying added nothing and undoing removes nothing) |
| review, timeout, autonomy | restores the value stored when it was applied — unless a person has changed the setting since; then theirs stands and the record says so |
| advice | nothing to restore |

The improvement becomes `dismissed` (the person decided against it; it is not proposed again), with `autopilot.reverted = { at, by, reason, evidence, restored, note }`. Event `learning.reverted` with `auto: false`; audit `improvement.reverted` under the person's name. **Reverting twice is a no-op** (200, nothing changes); reverting something that was never applied is 409.

Improvements applied before this version have no stored previous value: a rule can still be removed exactly and review flipped back; a timeout or an autonomy level cannot be guessed, and the route says so (409) instead of guessing.

A lesson the office switched on is undone with the lesson's own switch (`PATCH /api/lessons/:id`), which the `learning.applied` event names in `data.undo`.

### What the autopilot never does

- **It never answers a permission request.** There is no call to `comms.answer` in the module; a pending request stays the owner's (tested).
- Nothing that matches the high-risk list gets an allow rule; a high-risk request of a shape on probation ends the probation.
- It never gives `autonomous` or `auto`, never touches the foreman, never applies advice, never applies anything the table does not know.
- It never re-applies what was taken back once.

### Members' own computers

A member's own computer (`Host.memberId`) is theirs; ACCESS.md says only that member and the owners decide its employees' requests. The autopilot is office-wide, so:

- **Permission changes there rest only on that member's own decisions.** Each permission decision is stamped with who made it (`Question.autopilotDecidedBy`, copied from the audit entry `approval.decide` at the moment of the decision: `owner` or `member:<name>`). For a project or employee on a member's computer, only decisions by `member:<Host.memberName>` count towards an allow rule, a deny rule or autonomy up. What an owner approved there is not the member's evidence.
- Lower autonomy and review off rest on nobody's decision, so they are never automatic there.
- A longer timeout and review on touch no permission and follow the dial as everywhere.
- Decisions made before this version carry no stamp and do not count on a member's computer (they do count on shared machines, where every human decision is evidence).

An owner who joins with their own computer is in the same position: that computer is a personal host, and the autopilot acts there on what that person approved as the member they are signed in as — not on approvals given with the server's own owner token.

## What "safe" means, and what it does not

**It means one thing: on `safe` the office does not give agents permission to do more without asking.** No allow rule, no higher autonomy, no review switched off — tested per action.

It does not mean harmless:
- A deny rule can get in the way. Three denials of `wget` in particular situations become "never `wget`" for every employee of that project until somebody undoes it. The employee is refused by Claude Code and has to work around it or ask.
- Required review slows a project down and uses a reviewer's Claude usage for every task.
- A longer timeout lets a hanging verification hold a task for longer.
- "Three denials" is a count, not an understanding of why you said no.

And **`trusted` is a real delegation**:
- Five approvals by a *colleague* count like five of yours on shared machines. SECURITY.md already says to give that role only to people you would give an account on the server; on `trusted` their approvals can become a standing rule.
- An allow rule trusts whatever the command runs. `Bash(make build:*)` trusts the Makefile, which an agent with edit rights can change. The block lists keep the obvious "runs anything" shapes out; they are block lists, not proof.
- The evidence is what was *approved*, not what was *safe*: five approvals given without reading count as five.
- The high-risk gate remains in front of every session whatever the rules say (unless the owner switched it off for `auto` employees). That gate, not the autopilot's care, is what stops `git push`.

**Rollback has a gap.** Rules and autonomy reach Claude Code when a session starts. An automatic allow rule therefore takes effect for sessions started afterwards — and a rule that is taken back stays in the settings of sessions that were started while it existed, until they are restarted. The autopilot does not restart anybody's session. The probation signal also depends on somebody still being asked: once every session has the rule, nobody asks for that shape any more, so a denial can only come from a session started before it. In practice the window in which a rollback can trigger is the time until the affected sessions restart; after that only the verification and high-risk signals remain.

"Names it" (a failed verification naming a command shape) is a plain text match of the shape in the failure output. It can fire by coincidence — which only takes a widening back — and it can miss.

## Decisions, and why

1. **`safe` is the default, also for existing offices.** Asked for by the owner. Consequence: open deny / review-on / timeout suggestions in an existing office are applied after the update, three per project per day.
2. **Advice is never auto-applied**, although the brief listed sequencing/acceptance advice under `safe`. Applying advice does nothing but record that a person took it on board. See above. Different from the brief — the owner or lead may want advice turned into team lessons instead; that needs a real action.
3. **The autopilot goes no higher than `standard`.** `auto` removes permission prompts altogether; that is not something to arrive at by counting.
4. **After a person undoes an improvement it is `dismissed`; after the office takes one back it is `proposed`.** The first is a decision, the second is a question for the owner. No new status value was added, so existing UI keeps working.
5. **Undo never overwrites a later manual change.** If a person set another value since, theirs stands, for the automatic rollback and for the owner's undo alike.
6. **Who decided is stamped on the question** rather than looked up in the audit log later (the audit API returns only the most recent entries).
7. **The member's name comes from `Host.memberName`** (set at enrolment). No server wiring is needed; a member whose access is revoked has their hosts revoked with it.
8. **The command-shape reading is copied** from `Improver.commandShape` (private there) rather than shared, to keep the edit to `improve.ts` small. If the two ever differ the shapes stop matching and nothing is applied.
9. **Counter-signals are read from the event bus** (`core.bus`), so `comms.ts` and `tasks.ts` were not touched.
10. **Thresholds live in `Timings`**, next to the foreman's, because that is how tests inject them. They are not owner settings: the dial and the daily limit are.

## Not verified

- Nothing was run against the real `claude` CLI. That an allow rule written by the autopilot reaches a real session is the same path as the owner's click, which `05-self-improvement` covers with the scripted worker; it was not re-proven for the automatic case beyond the policy change.
- Autonomy up, review off, the high-risk and verification counter-signals, probation by task count and by time, the daily allowance, members' own computers and lesson activation are unit-tested against recorded questions, tasks and events — not end to end. The e2e test covers: default `safe`; `trusted` allow rule after three approvals (thresholds lowered); rollback on a denial; no automatic re-apply; the revert route (twice, and 404).
- PostgreSQL: the module uses only `Storage` calls both stores implement (`queryEvents` with `since`/`types`, `recentAudit`), but the tests ran on SQLite only.
- The revert route was not exercised as a colleague over HTTP; `access.test.ts` asserts the rule (`mayCall`) instead.
- Behaviour across a server restart was not tested. Nothing is held in memory (probation, undo and history are on the improvement; the allowance is counted from events), so none is expected.
- No UI exists for any of this yet.

## What the UI should show (for the "window" agent)

**The dial** (Settings → self-improvement, and worth repeating at the top of Growth → Suggestions): three positions, disabled while self-improvement is off.
- **Off** — "Nothing is applied without you. Every suggestion waits."
- **Safe** — "The office applies by itself only what cannot let agents do more without asking: deny rules, required review, longer verification timeouts, lower autonomy, lessons for one employee. Anything that widens permissions waits for you."
- **Trusted** — "Also applies changes that widen permissions — pre-approving a command, one step more autonomy (never beyond standard), review off — when the record is clear (for a command: 5 approvals across 2 tasks or a day, never denied, never high-risk). Each such change is on probation for 7 days or 5 tasks; a denial or a failure in that time takes it back."
- Choosing *Trusted* deserves a confirmation that says: approvals by colleagues count; a rule that is taken back stays in sessions already running until they restart.
- Next to it: "At most [3] automatic changes per project per day" (`autopilotMaxPerDay`, 1–20).
- `PATCH /api/settings { selfImprovement: { autopilot, autopilotMaxPerDay } }`; the change is audited (`settings.changed`).

**Text that is no longer true** in `growth.tsx`: "Nothing here is applied until you say so." (true only on *off*), and the Suggestion card's implication that Apply is the only way in.

**"Applied by itself" list** (Growth): improvements with `autopilot?.auto === true`, newest first by `autopilot.appliedAt`. Per row:
- title; `autopilot.widening` as a badge ("widens permissions" / "cannot widen");
- why — the note of the last `applied` entry in `autopilot.history` (the same sentence is `data.why` of the `learning.applied` event), and the evidence (`data.evidence` of that event, or the improvement's own);
- probation: `running` → "on probation until {until} or {tasksLeft} more tasks"; `passed` → "kept"; `reverted` → "taken back by the office"; `ended` → "undone by a person";
- an **Undo** button while `status === 'applied'` → `POST /api/improvements/:id/revert`; show `autopilot.reverted.note` from the response (it says what was restored, or that a later manual change was left alone).

**Every applied improvement** (also those a person applied) can get the same Undo button: `autopilot.undo` exists for all applied since this version. For older ones the route answers 409 with a sentence to show.

**Taken back** (a suggestion with `status === 'proposed'` and `autopilot?.reverted`): show it among the open suggestions with its history — "Applied by the office on {appliedAt}; taken back on {reverted.at}: {reverted.reason}" and the evidence — and say that it will not be applied automatically again. Apply and Dismiss work as usual.

**Lessons switched on by the office**: `learning.applied` events with `data.lessonId`; undo is the lesson's existing status control.

**Events**: `learning.applied`, `learning.reverted`, `learning.kept` (quiet) carry `data.auto`, `data.area === 'autopilot'`, `what`, `why`, `evidence`, `undo`.

Not available yet and worth asking for if the window wants it: "why is this suggestion still waiting" (`autopilot.verdict()` has the sentence; there is no route).

## For the other learning areas

- A new `ImprovementKind` needs a row in `AUTOPILOT_TABLE.kinds`; a new `ImprovementAction` needs a row in `.actions`, a case in `Autopilot.before` (what to store for undo) and in `takeBack` (how to restore it). Until then it is treated as widening and never applied automatically.
- To report a counter-signal: `engine.improver.autopilot.rollback(improvementId, reason, evidence)`. It acts only on changes the office itself applied.

## Shared files touched

- `packages/contracts/src/entities.ts` — `Question.autopilotDecidedBy?` (end of `Question`); `Improvement.autopilot?` (end of `Improvement`) and its doc comment; `SelfImprovementSettings.autopilot`, `.autopilotMaxPerDay` (end); new types `AutopilotMode`, `AutopilotUndo`, `AutopilotProbation`, `ImprovementAutopilot` after it.
- `packages/contracts/src/events.ts` — `learning.applied`, `learning.reverted`, `learning.kept` at the end of `EventType`.
- `packages/orchestration/src/core.ts` — six `autopilot*` fields at the end of `Timings` and `DEFAULT_TIMINGS`; `sanitizeAutopilot` (before `DEFAULT_SETTINGS`); the two new defaults in `DEFAULT_SETTINGS.selfImprovement`; one line in the constructor and two in `updateSettings`; one type import.
- `packages/orchestration/src/improve.ts` — import; the `autopilot` field and its construction; `this.autopilot.run()` at the end of `analyze()`; in `apply()`: `before` / `after` around the change and the `improvement.applied` event's `source`/`quiet` for automatic changes; the header comment.
- `apps/server/src/server.ts` — the route `POST /improvements/:id/revert`, after `dismiss`.
- `apps/server/test/access.test.ts` — one assertion.
- `tests/e2e/05-self-improvement.test.ts` — one line in `before`: the dial set to `off`, because that file tests the owner's own decisions (on `safe` the deny rule it dismisses would already have been applied).
- `docs/SECURITY.md` (the paragraph "Changes that widen permissions…"), `docs/ACCESS.md` (a short section) — their subject changed.
