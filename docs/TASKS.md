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
- Only in an office whose owner set the default to "No review" does a project's `policy.requireReview` still decide,
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
    for: *Answer* (a question, or a task parked on one), *Approve* / *Send back* (in review), *Unblock*, otherwise
    *Comment* — with *Send back* on a finished task and *Tell them now* on one in progress. `@` offers the office's
    people. ⌘/Ctrl+Enter presses the first button. Tabs beside the conversation: **Work** (the measured evidence and
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
