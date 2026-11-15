# Ideas: a leaner way for a team of employees to work

_Written on 2026-11-16 after a co-owner asked for a wide reading of what people who run coding agents say in public
(about fifty talks and interviews read from their transcripts, about forty articles and documentation pages:
Anthropic's own engineers and docs, Andrej Karpathy, practitioners who write about their daily work, the popular
channels on AI automation, and the teams that built many-agent systems and wrote down what broke). The question
was: what would make a team in this office finish the same work with fewer rounds, fewer words and less usage —
judged against what we measured in our own office, not taken on anybody's word._

**Not a plan.** What was built from it is in the first section. The rest are ideas with the reason for each and
what would have to be measured before it is worth building.

## What the reading agreed on

Where sources that do not share an interest say the same thing, it is listed; where only people with free or
sponsored usage say it, it is left out.

1. **Time and usage go to coordination, not to writing code.** A team split by job title (planner, builder,
   tester, reviewer) passes work along like a whispered message; one maker of the tools measured such a team
   spending more on coordination than on the work. Several people who built a team of personas went back to one
   implementer and one reviewer.
2. **A second employee helps as fresh eyes, and only so.** A reviewer who sees the task and the diff, and not the
   author's reasoning, finds what the author could not. The same task given to a second employee is not done better.
3. **A reviewer asked to find problems always finds some.** Acted on, the small findings become more code and more
   tests for cases that cannot happen; one team measured each closed item giving birth to a quarter to a half of a
   new one. Those who solved it report only findings above a level of severity and let the author decline them.
4. **Many agents cost three to fifteen times one agent**, and pay for themselves only on wide, independent work
   that can be checked mechanically. On work done in sequence they made results worse.
5. **A person approves a short design and looks at proof, not at every diff.** Proof is a command with its output, a
   screenshot, a recording.
6. **Left alone, agents test too much.** A handful of end-to-end tests for a change, depth by how much can break,
   and the output of a test run kept out of the context.
7. **A remark made twice becomes a mechanical rule** (a lint, a hook, a check), not one more sentence in a guide.
8. **A short guide.** Under two hundred lines, holding only what the code does not show; pruned when the model changes.

What was **not** taken: "always the highest effort", "use every token you have", swarms and workflows that start
dozens of sessions, loops that run until a second model gives full marks, and merging with no check at all (the one
team that tried it threw the code away after two weeks).

## Built from this (2026-11-16)

- **What a reviewer is asked** — `reviewPrompt`: whether the diff does what the task asked and is safe to use;
  style, naming and "more tests" are named as no reason to send work back (`docs/TASKS.md`, section 1).
- **Two rounds, then the boss** — `REVIEW_SEND_BACKS`: a colleague's third "request changes" on the same task does
  not send it back; it waits for the boss (`docs/TASKS.md`, section 1).
- **Messages between employees can be gathered** — `ProjectPolicy.gatherSec`: off unless a project chooses it
  (`docs/TASKS.md`, section 2).

The rest of what could be done at once needed no code: it is wording in a team's own guide (what a hand-in carries,
how deep to test, when a ticket skips review, what a ticket must say).

## Ideas, in the order they seem worth trying

Each is to be tried on one team, alone, and measured against that team's numbers from before: how many times a task
was sent back, how long finished work waited for a person, how many times an idle session was woken.

### 1. A cheaper model for simple tickets
The docs of the tool itself recommend its middle model for most coding; every employee here runs on the strongest.
The evidence that "the strong one plans and reviews, the cheaper one builds" costs less at the same quality is thin
(one sponsored demonstration, one vendor's figure). The solid part is arithmetic: a subscription counts the week of
its strongest model apart from the week of everything, so work moved to the middle model draws on the other
allowance. **Try:** one employee who only takes tickets marked simple. **Measure:** send-backs and failed checks
against the same kind of ticket before. **Would need:** nothing new — the model is already set per employee.

### 2. A fresh session at the end of a ticket, when the cache is gone anyway
Every turn sends the whole conversation again; what makes that cheap is the cache, which — as its documentation was
read at the time of writing, to be checked before anything is built on it — lasts an hour on a subscription. An
employee who waited longer than that pays for all of it again at the next prompt. People disagree on fresh sessions
in general (a fresh one has to learn the codebase again; a long one drifts), but that disagreement does not touch
this case: when the cache has expired, starting clean costs nothing extra and the next turn is small. **Would
need:** the office to know when a session last had a turn (it does) and how large its context is (it does not
today), a hand-over note written before the session is cleared, and the lessons of the playbook to carry what was
learned. **Risk:** an employee in the middle of a longer piece of work loses its thread — only between tickets, never inside one.

### 3. A team lead that plans and does not pass messages along
The role every source describes as the weakest is the manager agent: it prescribes without knowing the code,
assumes the others know what it knows, declares work finished early, and every message to it is a full turn. What
worked for those who kept one: it cuts the work into tickets with a clear end and what is out of scope, the
developers do not talk to it or to each other in passing, and each sends one note back (done, what differs from the
ticket, what worries them). **Would need:** the lead's standing prompt and tools narrowed (`docs/TEAM-LEAD.md`);
mentions of the lead on tickets counted first, to see whether the gathering built now already takes most of it away.

### 4. One short design approved by a person, then tickets that need no person
For a larger feature: a design of at most two pages, read fully by the person once; the tickets cut from it are
then reviewed by a colleague only. One practitioner found that a long plan is as long as the code it produces, so
reviewing the plan and then the code is the work done twice; another, that an approved plan nobody read carries
instructions nobody wanted. **Would need:** a planning ticket whose approval releases its parts with the lighter
review — close to what "Plan project" does today.

### 5. Proof as a field of a hand-in
Today the summary is free text. A hand-in that must carry a command and its output, or a picture, lets a person
approve at a glance — every team that reduced reading of diffs did it with proof. **Would need:** `complete_task`
to ask for it where the project has no verification command; attachments already exist.

### 6. A digest for the person
One team that let its agents run overnight added limits on how much may reach the person per hour, after a hundred
finished items arrived at once and a batch had to be rolled back unseen. Here the same would be: finished work of
one team gathered into one notice at set times. **Would need:** the Inbox to group by team and time — to be weighed
against the Inbox filter "Mine", which already exists.

### 7. Sorting a ticket by size when it is made
A small-model step, or simply a field, that says "trivial / ordinary / risky", from which review and the depth of
testing follow. Several builders added it after seeing a one-line change go through the same half hour as a
feature. **Would need:** a field on the ticket and the review default read from it; the person who makes the
ticket can already choose "No review", so this is worth it only if they are seen not to.

## What the reading could not answer

Nobody has a neutral measurement of how productive several agents are compared with one: the one independent
group that measures such things says it cannot do it for a developer who runs several agents at a time. Every
figure above is one team's own, most of them from companies that sell the usage. That is why each idea says what to
measure here.
