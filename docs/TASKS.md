# Tickets: review, the conversation on a ticket, sending back, working together

What the owner asked for on 2026-11-12: every task goes to review unless they chose otherwise; a Tasks window that
is simple; comments on a ticket, written by the employees too — they ask there when they are not sure, and instead
of "blocking" they ask in a comment and the ticket waits; tickets can be sent back; several employees can work on one
ticket, split it and help each other; in comments employees tag the owner and each other.

A "ticket" is a `Task` (`packages/contracts/src/entities.ts`). The engine is `packages/orchestration/src/tasks.ts`
(the life of a task) and `task-talk.ts` (`Engine.talk`: the conversation and what follows from it). The window is
`apps/desktop/src/hud/panels/tasks.tsx` (the board) with `task-view.tsx` (one task), `task-new.tsx`, `task-work.tsx`, `task-shared.tsx`.
Tests: `tests/e2e/45-tickets.test.ts`; the task steps of `tests/ui/driver.cjs`.

## 1. Review

- **`Task.reviewBy`**: `'both'` — a colleague, then the boss (the owner's choice of 2026-11-12: "Agent pa ja");
  `'boss'`; `'peer'` — a colleague, the boss only when there is nobody to review; `'none'`.
  `Task.requiresReview` stays and always equals `reviewBy !== 'none'`. Tasks from before have no `reviewBy`:
  `reviewByOf(task)` reads them as `'peer'`, which is how review worked then.
- **The default** for every new task, whoever makes it (a person, an employee's `propose_tasks`, a routine, the
  foreman): `OwnerSettings.reviewDefault`, read with `reviewDefaultOf` — `'both'` when the owner set nothing.
  *Settings → Employees → "Finished work is reviewed by"*. It applies to every kind of task, research and planning
  included. Chosen for one task: `reviewBy` (the New ticket form; "Reviewed by" on the ticket until it is done), or
  the older `requiresReview: false`. Not reviewed, by the office's own decision: a review task itself, the planning
  task of "Plan project" (its proposals are released by hand), and a **part** of a divided ticket (the whole is
  reviewed, section 4).
- **One project can be reviewed differently** (`ProjectPolicy.review`, read with `reviewUsualOf(settings, project)`;
  *Project → Policy → "Finished work is reviewed by"*, first choice "As the office"). Set, it stands in for the
  office's default for the new tasks of that project alone — made by a person (the New ticket form starts from it),
  by an employee or by a routine; cleared (`null`), the project follows the office again. Nothing else changes: what
  is chosen for one task still wins, a part is still not reviewed on its own, a task that passed its checks after
  changing them still goes to a colleague, and tasks that exist keep what they have. Choosing fewer checks than the
  project had is asked about when the policy is saved, like a wider allow rule.
- Only in an office whose owner set the default to "No review" does a project's `policy.requireReview` still decide
  (for a project that follows the office; one set to "No review" itself is not reviewed),
  as it did before (for work that makes commits, by a colleague). The test suites run such offices
  (`createHarness({ reviewDefault })`, `dev-office.ts --review`), so that their scripted tasks finish when they pass.
- **Once**, at the first start with this code (`tasks.reviewByDefault` in the office's key-value store,
  `TaskManager.adoptReviewDefault`): every task that is not done, not already in review, and neither a review nor a
  part gets the default. Finished tasks are left as they are.
- **A review is open only while the task still waits for a colleague's verdict** (`closeStaleReviews`, after every
  verdict and at every scheduler pass). Approved by somebody else, by the boss, sent back, stopped: a review somebody
  was reading is finished as "Not needed any more: …" and they are told in their session; one not yet started is
  removed. The reviewer whose verdict it was completes their own. A verdict from an asked reviewer that comes after
  that is kept on the ticket as a note beginning "Second opinion (would approve / would ask for changes)" and decides
  nothing (`secondOpinion`).
- **On the ticket**: "Reviews" in the side column lists the reviews asked for on it — key, who has it, how it stands
  (`apps/desktop/src/lib/reviews.ts`). In Tasks, review tickets stay behind "Show review tasks", except one whose key
  is what was searched for.
- **`Task.reviewStage`** while a task is in REVIEW: `'peer'` — a colleague was asked (a review task exists for
  them) — or `'boss'`. `both` and `peer` start with a colleague when `pickReviewer` finds one, otherwise with the
  boss; `boss` never asks a colleague. A colleague's approval of a `both` task does not finish it: it is kept in
  `evidence.peerReview`, the stage becomes `'boss'`, the boss is notified, and no colleague can approve it again.
  The boss's approval finishes it (merge included) at either stage. "Request changes" by anybody returns it to its
  author; the next hand-in starts with a colleague again.
- **Who reviews: a code reviewer first** (the owner, 2026-11-18: "the code reviewers have priority, and only then
  somebody else"; `TaskManager.reviewersByTrade`, `codeReviewerFor`, `isCodeReviewer`). A code reviewer is an
  employee with the Code Reviewer role (`reviewer`), and for a security task one with the Security role too. Order:
  1. **A code reviewer** — the project's own (or one lent to it), else one of no project, else one of another project
     on the machine the project lives on (one on another machine could not open the repository). Among them, the
     free one first. One from another project is **lent** to this one for the review (`lend`: they keep their own
     project; the next review here is theirs as the team's). A colleague the author named in `request_review`, or the
     reviewer of an earlier round, who is not a code reviewer gives way to one — the ticket's history says so, and
     the author is told when they name somebody ("… by Rita, the code reviewer … Sarah is not asked").
  2. **An architect, a security engineer or a QA of the project**, as before (only of the project or of no project).
  3. **A colleague of the team** (where employees keep the board themselves: `pickReviewer`'s peers, ranked as
     before), or one the author named.
  4. **The boss**, when there is nobody.
  Never the author, the foreman, a team lead, or somebody across the line to a member's own computer.
  `packages/orchestration/test/review-goes-to-code-reviewer.test.ts`.
- **What a reviewer is asked** (`reviewPrompt`, since 2026-11-16): one thing — does the diff do what the task asked,
  and is it safe to use. Changes are asked for only for what would make it wrong in use (a bug, a case the task
  names that does not work, a security hole, a test weakened so that it passes), each with its file. Style, naming,
  "how I would have built it", more tests for completeness and anything outside the task are named as **no reason
  to send work back**: left out, or at most three under "Not blocking:" beside an approval, for the author to take
  or leave. Where the office ran the project's check and it passed, the reviewer is told not to run it again.
  (Before, the prompt said "correctness, tests, security and maintainability", and a reviewer asked that widely
  always finds something.)
- **What was checked, said** (2026-11-23, after measuring the live office: of 320 hand-ins the office had checked
  none — no project had a verification command — half of the colleagues' reviews ran nothing, a few reviewers had
  done part of the work themselves, and owners approved almost always without a word). Three rules:
  1. **The office checks what it can** (`syntax-check.ts`). A project with no verification command of its own gets,
     at every code hand-in, a **syntax check of the files the task changed**: `php -l`, `node --check`, plain JSON
     parsed, Python parsed with `ast` (nothing is written into the folder), `bash -n`; other kinds are passed over.
     In the owner's folder (`in_place`) only the files this task's session wrote (`Task.touched`) — colleagues commit
     on the same branch. It runs on the employee's machine through `verify.run`, like a command. A file that does not
     parse **refuses the hand-in** ("Not complete: a file … does not parse", with what the checker said; counted in
     `friction.failedVerifications`); a checker not installed there is skipped and said so; when nothing could be
     checked, or the check could not run at all, the work goes on unchecked (`provenance: 'unavailable'`). On record as
     `VerificationResult.kind: 'syntax'`. It is not a test: it gives no "tests passed" XP, does not count as verified
     in what the office learns, and the improver still proposes a verification command for the project. Off for a
     project with `policy.syntaxCheck: false`.
  2. **A colleague's approval says what they checked** (`submit_review.checked`). Approving code (any kind but
     review, research, planning) that the office did not test with the project's own command (`testedByOffice`) is
     refused without it: "run what shows it works … and give checked". The reviewer is told so in `reviewPrompt`; a
     Codex reviewer, who reads and runs nothing, is asked what it read and compared. Kept in `evidence.peerReview.checked`
     / `evidence.review.checked`, and on the ticket ("Checked: …"). Sending back needs no "checked". A session started
     before the field existed has `submit_review` without it (Claude Code reads the tools at start): a last line
     "Checked: …" in the comments counts the same, and the refusal says so.
  3. **Who worked on a ticket does not review it**: its helpers (`helperIds`) are never picked, a named one gives way,
     and their `submit_review` is refused ("you worked on T-… with its author").

  *Seen on the live office the same evening:* a code reviewer's first approval without "checked" was refused; nine
  seconds later it approved with what it had run — DNS lookups, the sites fetched publicly and from the team's own
  machine, the served certificate read — and what it could not check, and why.

  The owner sees it in **Your verdict → What was checked**: what the office ran ("The changed files parse — the office
  ran no tests"; "`npm test` passed"; "Nothing") and what the colleague says they ran — or that they approved it
  without saying. `packages/orchestration/test/review-checked.test.ts`, `tests/e2e/68-office-checks.test.ts`.
- **Two rounds between colleagues, then the boss** (`REVIEW_SEND_BACKS` = 2, `TaskManager.contest`): a colleague
  may send the same task back twice (`friction.reviewRejections`). The next "request changes" from a colleague does
  not send it back and is not counted as a rejection: the task stays in REVIEW with stage `'boss'`, what was asked
  for is kept in `evidence.contested` and written on the ticket, the boss is notified ("… needs your decision"),
  and no colleague can give a verdict on it any more. The boss approves it as it is, or sends it back themself —
  as often as they like; the limit is on colleagues only. It is a constant, not a setting.

## 2. The conversation

`Task.comments: TaskComment[]` (the last 300), each `{ id, ts, from, body, kind, mentions, questionId?, answeredBy?,
answerTo? }`.

| `kind` | written when |
| --- | --- |
| `note` | somebody says something |
| `question` | an employee asks and cannot go on without the answer (`answeredBy`: the comment that answered it) |
| `answer` | the answer to a question (`answerTo`) |
| `handed_in` | the employee handed the work in (their summary) |
| `approved`, `sent_back` | a review verdict; `sent_back` also when a finished ticket is opened again |
| `handoff`, `split`, `part_done` | passed to a colleague · divided into parts · a part was finished |

- **People**: `POST /api/tasks/:id/comments { body }` (`TaskTalk.byPerson`). **Employees**: the tool
  `comment_on_task { text, task?, to?, ask? }` (`TaskTalk.byEmployee`); without `task` it is the ticket they are
  working on.
- **Tags** (`TaskTalk.mentionsIn`): `@Name` in the text — an employee's name may have spaces, the longest name that
  matches wins, a first name is enough when it is nobody else's — and `@boss` / `@owner` / the owner's name for the
  people of the office. The tool also takes `to: [...]`. `something@somewhere` is an address, not a tag. A tagged
  employee gets the comment as a message (`MessageKind: 'comment'`) that says by whom, on which ticket, and how to
  answer; a tagged boss gets a notification (`NotificationKind: 'mention'`, in the Inbox). **Nobody is told about a
  comment that tags nobody** — except whoever is working on the ticket, who reads everything written on it (a
  person's comment, or a colleague's) when their turn ends.
- The rules a message between employees has hold for a tag: not the foreman, not into a closed room, not across the
  line to a member's own computer, and no more than 120 comments an hour per employee.
- **Asking instead of blocking.** `ask: true` means "I am not sure, or I cannot go on, without this" and is allowed
  only on the ticket the employee is working on. Without a tag it goes to the boss.
  - *To the boss* it is one of the office's questions (`Question`, the Inbox, the icon over the employee, the phone)
    **and** a `question` comment linked to it (`questionId`). It is answered in either place — a person's comment on a
    ticket with an open question *is* the answer (`byPerson` → `Comms.answer`), and an answer given in the Inbox is
    written on the ticket (`TaskTalk.questionAnswered`).
  - *To a colleague*: they get the question as a message that says the one who asks is waiting (and are started if
    they are not at their desk); their next comment on that ticket is the answer.
  - The call waits (`timings.askBossWaitMs`, four minutes). Answered in time, the answer is the call's result and the
    ticket never stopped. Not answered: the ticket is **parked** — `BLOCKED` with
    `waitingFor: { kind: 'answer', commentId }`, shown as "Asks you" or "Waiting" — no alarm is raised (a question
    is not a blocker), **and whoever asked waits too**: an employee with a question of theirs about a task open — a
    task parked on one, or a question to the boss about a task, also one that has been handed in since — is given
    no new task until it is answered (`TaskManager.awaitingAnswer`,
    read by `isFree`; the owner's rule of 2026-11-12, after an employee parked a task on a question and was
    handed, and finished, another one meanwhile). The card of what they would do next says so. The answer brings
    the ticket back to them
    (`TaskManager.unblock(..., { threaded: true })`): in the same session if they are still there, otherwise as the
    task handed to them again, with the conversation in its prompt.
  - `ask_boss` asked while on a ticket is written into its conversation too. `report_blocker` — now for what no
    answer can solve — is written there as a `question`; what the boss replies on the ticket unblocks it, as the
    Unblock button and a colleague's `unblock_task` still do (each closes that question with what was said).
- **A question that is a choice carries its choices.** `comment_on_task` takes `options` (`[{ label, description?,
  consequence? }]`, up to six) with `ask`; they are kept on the comment (`TaskComment.options`) and on the office's
  question (which is then of kind `decision`), so the boss answers **with one click** wherever they are: at the
  employee's desk and in the Inbox (the question card, as for `ask_boss`), and in the task — the box at the bottom
  lists the choices above the text field. Clicking one is answering with its words. `context` and `why` go to the
  question card. The tool's description and the system prompt tell the employee to always give options when the
  question is a choice — **and when it does not**, and writes them into the question ("… A) keep it: … B) drop it —
  … C) something else"), the office reads them out of the text (`optionsIn` in `contracts/util.ts`: letters from A
  in order, written `A)` or `(A)`; a numbered list is not a set of answers) and offers them the same way. That
  holds for `ask_boss` too, and questions that were already waiting get their choices when the office starts.
- **A comment carries its pictures.** `comment_on_task` takes `files` — paths on the employee's machine; each is
  copied into the office (as `attach_file` does) and tied to the comment (`TaskComment.attachmentIds`). A picture's
  path that only stands in the text of a comment is fetched the same way: a path shows nobody anything. A file that
  was named and cannot be read is said to the employee; one that was only found in the text is passed over.
- A task's prompt carries the last twelve entries of its conversation (`TaskTalk.promptLines`), so whoever gets a
  ticket — again, or after somebody else — reads what was said on it. `get_task` shows them as well.

### Gathering what colleagues write (`ProjectPolicy.gatherSec`)
Every prompt typed into an idle session is a whole turn of its model over everything the session holds. Three notes
from a colleague a minute apart are three such turns. A project can have them gathered: *Project → Policy →
"Colleagues' messages reach an idle employee"* — at once (the default: nothing changes for a project that does not
choose), or after 30 seconds, one, two or five minutes (`gatherSecOf`, at most 600 seconds).
- **What waits**: a message (`send_message`) or a comment on a ticket that one employee writes to another employee
  of a project that gathers (`Comms.gathered`; the recipient's project decides). The delivery carries `holdUntil`.
- **What never waits**: anything a person wrote (the boss, a member, a Telegram chat), a task, a review request, an
  answer, a meeting, a routine, the office's own notices, and a request for help — waited on or not.
- **How it goes**: an idle session is not typed into while everything that waits for it is being gathered
  (`nextToType`); when the first is due it is typed, and the others are handed over at the end of that turn through
  the Stop hook, as queued prompts always are. A session that is working is not affected at all: what is queued for
  it reaches it at the end of its turn, as before, gathered or not.
- *Checked:* `packages/orchestration/test/gather-messages.test.ts` — what waits and what does not, the choice of what
  is typed next, the bounds of the number. *Not checked:* in a running office with real sessions (the two paths it
  rides on — typing into an idle session, and the Stop hook — are covered by the e2e suite as they were).

## 3. Sending back

`POST /api/tasks/:id/send-back { note }` (`TaskTalk.sendBack`); the note is required and becomes a `sent_back`
comment.

| the ticket is | what happens |
| --- | --- |
| in review | changes are requested (the same as a review that rejects) |
| done | **opened again** (`TaskManager.reopen`): READY for whoever did it (for whoever fits, if they are gone), the note as the feedback of the next attempt, `reopened` counted. What was done stays merged and committed; the new work is measured from where the folder stands when it starts, on a fresh branch (`…-r1-…`) where the project uses branches, and is checked and reviewed like any other |
| waiting for an answer, or blocked | the note is the answer |
| in progress | a correction, delivered now (the employee's turn is interrupted) |
| not started | a comment |

## 4. Several employees on one ticket

- **`Task.helperIds`**: colleagues a person puts on a ticket with its assignee, who leads it (the New ticket form;
  "With → + Add" on the ticket). The lead's prompt names them and says to divide the work; added while the lead is
  already at work, the lead is told at once.
- **`split_task { parts: [{ title, description, acceptance?, assignee? }] }`** (`TaskTalk.split`): the assignee of a
  ticket in progress divides it — because the boss put colleagues on it, or because it is too much for one. Each
  part is a ticket of its own (`parentId`) for a colleague: the one named, else the colleague on the ticket with the
  fewest parts, else whoever fits and is free. One to six parts at once, eight open at a time, a real description
  each; a part is not reviewed on its own and **cannot be split again**; a split that is refused creates nothing.
- The lead keeps a part for themselves in the ticket. `complete_task` while parts are open does not finish it: the
  ticket waits (`waitingFor: { kind: 'parts' }`) and the lead is free. Every finished part is said on the ticket
  (`part_done`, and as a message to a lead who is still working); the last one brings the ticket back to the lead
  (`TaskTalk.partSettled`) to bring the whole together and hand it in — and the whole goes to review. Where the
  project uses branches the lead is told to merge the integration branch first: the parts were merged there.
- Deleting a ticket leaves its parts as tickets of their own; deleting a part counts as that part being settled.

## 4b. A task for a person

The owner, 2026-11-20: "the assignee fields in tasks, everywhere — making, editing, looking at a task — must be searchable; and a task must be assignable to an owner or a colleague, a real person, and then they get a notification in their Inbox that they have a new task".
- **Whom a task is for** is one searchable field wherever it is chosen — the new task, the task's own window, the board's filter (`assignee-picker.tsx`): a few letters of a name, a title or a role, arrows and Enter; employees with their faces, then **People** — the owners and the colleagues who are still here (`GET /people/assignable`, `Comms.people`: no visitors).
- **A person's task** (`Task.personId`, its name kept in `personName`): exclusive with an employee — choosing one clears the other. The office **never hands it to an employee**, starts it, makes a branch for it or checks it (the scheduler skips it, `TaskManager.runSchedule`); auto-assign leaves it alone.
- **They are told, and only they**: a notification of kind `task_assigned` addressed to them (`Notification.for`), under *Needs you* in their Inbox — "A new task for you: T-12 …", who assigned it and the beginning of the text; a click opens it. When it is reassigned to another person, the other is told.
- **They move it on themselves**: in the task's window *On it* (IN_PROGRESS — for a person's task the board allows it by hand) and *Done* (marked done, as theirs: no "unverified" question). It is theirs among *Mine* (`taskIsMine`). The board shows their initials and name where an employee's face would be.
- Tests: `packages/orchestration/test/person-task.test.ts` (made for a colleague: she alone is told, the scheduler leaves it, she moves it on; reassigned person ↔ employee; nobody who is not in the office; not both at once). Seen in a development office: the picker found Mike, Mil-1 and the colleague Mila for "mi"; a task made for Mila was in her Inbox under *Needs you* and not in the owner's.

## 4c. Cancelling a task

The owner, 2026-11-20: "in the agents' tools there is no cancelling a task; we must have that too". `cancel_task { task, reason }`, one of the board tools (shown while employees manage the board): the task is **closed as cancelled, not deleted** — DONE, with who cancelled it and why (`Task.cancelled`), in its history and in the feed; what was on its way to anybody for it is taken back; **the boss is told** (a notification) and can **reopen** it by moving it back on the board (it is then no longer cancelled). The board and the task's window say *Cancelled by … : why*. Refused: a reason that says nothing, a task somebody else is in the middle of (tell them, or the boss), one in review (its review decides), one being checked, one the boss blocked, a person's task (`Task.personId`: theirs to close). The foreman is not offered it: it escalates to the boss instead. Test: `tests/e2e/20-employees-manage.test.ts` ("an employee cancels a task that is no longer wanted…").

## 4d. The release gate

With the release gate on, work handed in with a `release_plan` always waits for an owner (`peer` becomes `both`, `none` becomes `boss`), the owner reads the plan in *Your verdict*, and the approval opens the release for its author and the colleagues on the ticket; `report_released` closes it. Nothing reaches a protected branch or production before that. [RELEASE-GATE.md](RELEASE-GATE.md).

## 5. The windows

The first version of this work replaced the board with one window that listed tickets by "what they need". The owner
sent that back the same day: the board by columns was better, and what was wanted was only to *go into* a ticket and
talk there, as in Plane or Trello. So:

- **The board is as it was** (`TasksPanel` in `tasks.tsx`, the panel `tasks`): six columns — Backlog, Ready, In
  progress, Review, Blocked, Done — cards that move by themselves and can be dragged, search, project, employee,
  "Show review tasks", "Release … proposed tasks", "New task". New on a card: what it waits for when it waits for
  the person at the window ("Your review · Rev approved it — now you", "Asks you · Sarah: …", with an amber outline),
  what a waiting one waits for, how many comments and parts it has, who is on it with its assignee. New in the
  toolbar: "Needs me (n)" shows only those cards. (A ticket parked on a question or on its parts is `BLOCKED`, so it
  stands in that column; its card says which.)
- **A click on a card opens that task** (`Ticket` → `TicketView` in `task-view.tsx`, the panel `task`;
  `openPanel('task', '<id>' | '<id>:diff')`; "All tasks" goes back to the board).
  - *In the middle*: the task's text, **its pictures** — every picture on the task, newest first, large enough to
    tell what is on it (`Pictures` in `task-files.tsx`); a click enlarges one, the arrows and the arrow keys go
    through the rest, Escape closes the picture and not the task — the other files behind "All n files", the parts,
    then the **conversation**, where a comment's own pictures stand under it and a question shows its choices — comments, with the office's own
    lines of the story between them — and **one box at the bottom** whose first button is what the task is waiting
    for: *Answer* (a question, or a task parked on one), *Unblock*, otherwise *Comment* — with *Send back* on a
    finished task and *Tell them now* on one in progress. `@` offers the office's people. ⌘/Ctrl+Enter presses the
    first button.
  - **In review the box is only for talking it over** (the owner's word of 2026-11-17: talk with the agents on the
    left until everything is settled, approve or send back on the right, so that neither is pressed by accident).
    Its one button is *Comment*, and what is written there goes to the task's author even untagged
    (`TaskTalk.byPerson`): they are told it is in review, to answer on the ticket with `comment_on_task`, and not to
    change the work for it — changes come by sending it back. Their answer, untagged, is brought to the boss when the
    review is the boss's (`reviewStage: 'boss'`; a `mention` notification "… answered on T-n"). Tagging somebody
    else brings it to them instead. **The verdict is at the side** ("Your verdict", `Verdict` in `task-view.tsx`),
    in two steps: *Approve…* opens a note (optional) and *Approve and finish*; *Send back…* opens what should change
    (required) and *Send it back*; *Cancel* closes either. Nothing there answers to ⌘/Ctrl+Enter. Tabs beside the conversation: **Work** (the measured evidence and
    the technical details), **Changes** (the diff, read live), **History** (every recorded event).
  - *At the side*: what it needs, in a pill and a sentence; assignee, who is on it with them ("+ Add"), who reviews
    it, priority — each changed right there; project, kind, what it is a part of, dates; and the **⋯** menu: change
    its text, stop it and put it on hold, move it by hand, delete it.
- **A new task** is its own window again (`NewTicket` → `TicketNew` in `task-new.tsx`,
  `openPanel('task', 'new' | 'new:<employeeId>')`): title, description, files, project, assignee, who works on it
  with them, who reviews it; the rest under "More options". Creating it opens the task.
- `needOf` (`task-shared.tsx`) is the one place that says what a task needs and in which words; the card and the
  task's side both read it.
- Roles: a visitor reads; whoever may work on the task's machine (an owner, a colleague on the shared office or on
  their own computer) writes — the rule every task route has (`apps/server/src/access.ts`).

## What is not there

- Reviewing a part on its own is possible only by choosing "Reviewed by" on that part after it is made.
- A comment cannot be edited or deleted.
- A person cannot split a ticket from the window; they put colleagues on it and its lead does.
- "Tagged you" is a notification in the Inbox; a card on the board has no unread mark of its own.
