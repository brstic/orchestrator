# A member's team lead

Asked for by a co-owner (2026-11-12): "one of ours who is in charge of my agents only — I tell him 'look at the tickets for Xenon Studio' or 'check that domain', and he knows which agent to give it to, so that we do not run round handing out work ourselves. He must not guess: if he is not sure, he asks. He may hire whom he needs — find where the project is, and ask if he cannot — with a guard so that he cannot make five hundred of them: five."

## What it is

One more employee in a member's room, with the role **Team Lead** (`lead`). The member talks to it like to anyone (the Talk window); it hands what was asked to the one of the member's employees whose it is.

| | The foreman | A team lead |
| --- | --- | --- |
| Whose | the office's; the owners' alone | one member's |
| How many | one | one for each member who wants one |
| Where | on a machine of the office, no desk | on the member's own computer or server; on its feet, among its own team's desks |
| When it works | in rounds the office calls it for | only when somebody speaks to it |
| What it reaches | everybody, members' rooms included | that member's employees; the shared ones too if the member says so |
| Hires | no | yes: onto the member's own machines, five people at a time at most |

It is not a second foreman on purpose. "One foreman" is a recorded decision (`DECISIONS.md`), the foreman's privacy rules are built on it being nobody's, and a lead needs none of the foreman's machinery (rounds, attention, timers).

## Getting one, and talking to it

**Menu → My work → Team lead → Hire a team lead** (it opens what a lead is and a name for it; then *Hire onto <your machine>*). (Or Team → Hire, role *Team Lead*, on your own computer.) It is put on your computer if it is in the office now, else on a server of yours; its folder is the first one that machine lets the office into — only where its session runs, never a project.

Then **Talk**. What it does with a request (its prompt, `packages/orchestration/src/prompts.ts`):

1. `team_overview` — who is on the team, each one's project and folder, what they are doing, the last three things they finished.
2. One person clearly owns it → hands it over: `team_tell` for a look, a check or a question; `team_task` for work to be tracked on a board.
3. Two could own it, or none clearly → `team_look` at the likely ones (their task, what they were told and answered lately, their terminal now). Still unsure → **asks the member** (`ask_boss`) with the candidates named, and stops until answered. It is told never to guess and never to give one thing to two people to be safe.
4. Nobody fits and it is real work → `team_folders` to find where it lives, then `team_hire` — or it asks where.
5. Tells the member in two or three lines whom it gave it to and why.

"Tickets" means what the employee on that project can reach: the office has task boards and no connection to an outside tracker, so the lead passes the request to the employee who works in that project's folder.

**Shared employees you look after** — *Team → Everyone → Mine* on a shared employee's row (`Employee.keptBy`). They are in your lead's team from then on, with the shared projects they work on, and nobody else from the shared office comes along. They stay shared for everyone else (`DECISIONS.md`, "Mine on a shared employee…").

**All the office's shared employees** — the checkbox under the lead's line in *My work* (`Employee.leadScope: 'office'`). Then its team is the member's own employees first and the shared ones after, and it may tell them things and put tasks on shared projects — what the member may do themselves. Work still does not cross: a member's employee is not given a shared project's task, nor the other way (the office refuses, and the lead is told why).

## In the office

The owner's word, the day it went live: "why does the lead sit at a desk — it should walk about and watch over mine." So a lead is drawn the way the foreman is (`packages/office-3d/src/Foreman.tsx`, with `title`, `stopsOf` and `homeDeskId` on its view), by `leadViews` in `apps/desktop/src/lib/views.ts`:

- **Its walk** is the desks of its own team and no others: its member's own employees in their room, and the shared employees that member looks after, out on the shared floor. The whole shared office is not on it, even with `leadScope: 'office'`.
- **When it acts** — `team_look`, `team_tell`, `team_task` with an assignee, `team_assign` — the office records a `lead.visit` event and its character goes straight to that desk and stays a while, as the foreman's does. The event is about the lead, so it is sent to whoever may read what happens on that member's computer: other colleagues see the lead walk its round, not whom it was called to.
- **With nobody to look after** it stands at its own seat in the room. While its member's computer is away it is away with the room.
- The walking costs nothing: it is drawn from the clock, like the foreman's. A lead still runs only when spoken to.

## What it costs

A lead exists to save its member time, not to spend their Claude account:

- **It never runs by itself.** No rounds, no timer, no nudges; the foreman does not ask about it and the scheduler gives it no work. A lead that nobody talks to uses nothing.
- **The lightest model, working lightly**: `haiku`, effort `low`, unless the member picks otherwise in its profile (`LEAD_MODEL`, `LEAD_EFFORT` in `packages/contracts/src/roles.ts`).
- **A short tool list.** A lead is shown its seven tools and six ordinary ones (`ask_boss`, `wait_for_answer`, `report_status`, `send_message`, `check_messages`, `respond_to_request`) instead of the whole list an employee gets; every tool description is read on every turn.
- **Short answers.** `team_overview` is one line a person; `team_look` shows 25 terminal lines and 8 events, where the foreman's shows 40 and 12.
- Its prompt tells it to look only as far as it needs to know whose something is, and not to read code.

Not measured: what a request really costs with real Claude Code (see "Not verified").

## The rules the office enforces

Whatever the model in the lead's session decides, these hold on the server (`packages/orchestration/src/lead.ts`, `registry.ts`):

- **A member's, one each.** A lead is hired only onto a member's own computer or server (`assertCanBeLead`), and a member has one. Making an existing employee a lead is held to the same.
- **Its tools refuse anybody else** (`only()`, audited as `lead.tool_refused`), and nobody else is shown them.
- **The team is worked out, not named**: employees on machines whose member is the lead's member, shared employees that member looks after (`keptBy`), and the other shared ones only with `leadScope: 'office'`. Never the foreman, another lead, or a person's own session. Another member's employees are never in it.
- **It cannot edit files** (the role's refused tools, as for the foreman) and **is never Unrestricted** — refused at hire and at change.
- **It is not given work**: assigning it a task is refused, the scheduler and the reviewer picker skip it.
- **Hiring** (`team_hire`): onto the member's own machines only, never a shared one; a role from the catalogue except foreman and lead; a project of the team's or a folder on that machine; a reason, which the member reads. The new employee is on Standard, the least of the three levels (so never Unrestricted through a lead) and no model of the lead's choosing. **Five at a time**: counted from `Employee.hiredBy` over those still here (`LEAD_HIRE_LIMIT`); when one of them is archived or deleted a place is free again. The member's own hiring is not limited by this.
- **The member is told of every hire** (a notification with the reason, and `lead.hired` in the audit log) — after, not before: the owner's word was "hire, then tell".
- **Folders** (`team_folders`) are listed by the member's own machine, inside what that machine lets the office into (`fs.browse`), like the folder picker.
- **Privacy** is the room's: a lead is an employee on a member's computer, so its terminal, its conversation and its questions are that member's and the owners', and nobody's but the member's when the room is closed.

## Where the code is

| What | Where |
| --- | --- |
| The role, the limit, the model | `packages/contracts/src/roles.ts` (`lead`, `LEAD_ROLE`, `LEAD_HIRE_LIMIT`, `LEAD_MODEL`, `LEAD_EFFORT`, `directsOthers`) |
| `hiredBy`, `leadScope` | `packages/contracts/src/entities.ts` (`Employee`) |
| Team, tools, hiring | `packages/orchestration/src/lead.ts` (`Lead`: `team`, `hired`, `handlers`) |
| One each, on a member's machine, defaults | `packages/orchestration/src/registry.ts` (`assertCanBeLead`, `create`, `update`) |
| Tool descriptions | `packages/integrations/src/mcp.ts` (`LEAD_TOOLS`) |
| Which tools a lead is shown | `packages/orchestration/src/mcp-tools.ts` (`listed`, `LEAD_ALSO`) |
| What it is told about itself | `packages/orchestration/src/prompts.ts` (the `lead` branch) |
| Its card, hiring one, the checkbox | `apps/desktop/src/hud/panels/mine.tsx` (`LeadCard`) |
| Tests | `tests/e2e/46-team-lead.test.ts` |

## Not verified

- **It has never run with real Claude Code.** The test calls the tools as its session would, against a real office with a second machine; and in the development office a scripted session was started for a lead (on `haiku`, effort `low`), was sent a message, called `team_overview` and `team_tell` through the real MCP connection, and the message reached the employee. Whether a real small model picks the right person, asks when it should, and stays short — the whole point — is not known, nor what a request costs.
- **The walk was not watched.** In the development office the lead was drawn standing at a desk of its team, with its four stops (three of its member's own, one shared employee looked after) and its tag; the browser it was looked at in was not drawing frames, so the walking from desk to desk and to a visit — the foreman's code, used unchanged — was not seen for a lead.
- A lead on a member's **server** (not their computer) was not tried; nor a lead whose member's computer leaves the office mid-request.
- The checkbox for the shared employees was exercised through the API in the test, not clicked in a window.
