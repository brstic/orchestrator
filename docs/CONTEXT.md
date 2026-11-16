# The central context — what every employee always knows

_Built on 2026-11-17 from `plans/PLAN-central-context.md`, on the owner's request: "a kind of central context so that more or less all agents have certain same information… that every agent always keeps the same context, no matter whom it talks to, whether it is rented or not, on another Claude account… that they always know everything they need to know." The owner's answers to the plan's questions: owners **and colleagues** write it; employees' proposals go **straight in for some** layers; **rented employees get it too**; only Claude Code for now (other providers later); the size was left to us._

Short facts in layers, kept by the office and put in front of every employee **whatever conversation they are in**: when their session starts, again **after every compaction** (the moment a session loses what it was told), and as **the change** at their next prompt when a fact changes. Read this before touching `packages/orchestration/src/context.ts`, `packages/contracts/src/context.ts`, the context part of the host agent's `onHook`, or `apps/desktop/src/hud/panels/context.tsx`.

## The layers

| Layer | Who holds it | Examples |
| --- | --- | --- |
| **Office** | every employee — rented ones too, but for facts marked *Keep from rented employees* | how we deploy, conventions, who is who, priorities |
| **Project** | everyone on the project, or building on it (`alsoProjectIds`) | stack, where it runs, its state, its rules |
| **Role** | everyone with the role | how a reviewer or a PM works here |
| **Client** | the employees that client rents — **with each of that client's messages** (`rent.ts`), not in the pack, since one employee may answer several clients | what was agreed, what they want |
| **Self** | one employee | what they are in the middle of — their own notes |

Besides what is typed, the office writes two items itself into every pack: **the team you can reach** (the people this employee may work with — the Rent wall respected) and **the projects**.

Each fact: a title, the text (Markdown, short), **Always** (in the pack) or **On demand** (found with `get_context`), *Keep from rented employees* (office facts), *Look again by* (a date; past it the window says *look again*), who wrote and changed it. Credentials never stay: the vault's capture runs on every fact, as on a message.

## Size

**About 4,000 tokens** (`CONTEXT_BUDGET_CHARS`, 16,000 characters) is what the window treats as the pack's healthy size: the office layer is warned about past half of it, a project's, role's or employee's past 30%. The pack is cut at a hard cap of 24,000 characters (`CONTEXT_HARD_CAP_CHARS`): what does not fit is counted *on demand* and found with `get_context`. Why 4k: it is given again at every start and every compaction, and a model reads every word of it — much more is paid for over and over; much less would not hold an office, a project and a role.

## How it reaches the model

```
 the office (context.ts)                       the machine's agent                    Claude Code
 ┌──────────────────────────────┐  session.     ┌─────────────────────────────┐ hook  ┌──────────────────────────┐
 │ a fact changes / who works   │  context      │ holds the pack per session  │ out-  │ SessionStart (startup,   │
 │ where changes → packFor(e)   ├──────────────▶│ (and the one last given)    ├──────▶│  resume, compact): whole │
 │ (rev = hash of its items)    │  (live)       │ answers locally, no waiting │ put   │ UserPromptSubmit: the    │
 │ at a start: LaunchSpec.context│              │ reports the rev it gave     │       │  change, if any          │
 └──────────────────────────────┘               └─────────────────────────────┘       └──────────────────────────┘
          ▲  session.contextRev  ◀── the hook's event carries `orch_context` (the version given)
```

- **The pack** (`packFor`): office facts first (with the two derived items), then the project's, the role's, one's own; a version `rev` (a hash of the items). Sent to the machine when it differs from what was sent (`pushAll`, a quarter of a second after anything changes: a fact, an employee, a project, a rental; and again to a machine that connects).
- **The machine's agent** keeps it per session (`Tracked.context`) and answers the two hooks itself, as it answers the fence: on `SessionStart` the whole pack (`renderContext`), on `UserPromptSubmit` only the change since what this session was last given (`renderContextChange`: new, changed, no longer holds) — nothing when nothing changed. The hook's event carries the version (`orch_context`); the office records it on the session (`contextRev`), so it knows who holds what.
- **On demand**: `get_context { topic }` (MCP) — the employee's facts whose words match; with no topic, the titles of what is kept on demand.
- **The launch's system prompt** tells every employee that the context exists, that it is the newest word, and to keep their own notes in it.

## Where facts come from

1. **People**: the **Context** window (menu → Work → *Context*). Owners and colleagues write the office's, a role's, a project's (if they may work on it) and an employee's (if they may work with them); a client's are an owner's.
2. **Employees**: `propose_context { layer, title, text }`. **Straight in** for their own notes (`self`) and their project (`project`) — `CONTEXT_STRAIGHT_IN`; the office's, a role's and a client's (a client's only while answering that client) wait in **Proposals** (and a line in the Inbox): *Take in*, *Edit* then take in, *Drop*. Thirty proposals an hour per employee at most.
3. **The office notices** — each offered once as a proposal, never put in by itself, and never what is on a member's own computer:
   - a meeting that reached a decision → its project (or the office);
   - **the boss's answer that sounds standing** — "always", "never", "from now on", "every time", "by default", or in Serbian "uvek", "nikad", "od sada", "ubuduće", "svaki put", "standardno" (`STANDING`) → the asker's project (or the office); an answer for this once is not offered, nor the foreman's;
   - **a lesson for the office or a project**, once it is active (`noticeLesson`).
4. **The import**: *Import what the office knows* (Office tab) offers, once, what already exists — each employee's standing instructions as their own notes, each project's description, goals and notes, the active lessons of the office and the projects. One line in the Inbox for all of them; *Take in all* in Proposals, after looking through them. A dropped proposal is not offered again (the history remembers where it came from).

## The window

Tabs: **Office**, **Projects** (choose one), **Roles**, **Clients** (owners only), **Employees** (one's own notes), **Proposals** (with a count), **Who holds it** (every running session, the version it holds and whether it gets the change at its next prompt; **What they know** shows the pack exactly as it is given). Each layer: what it is for, **Add a fact**, the facts as one line each (title, two lines of text, *on demand* / *not for clients* / *look again*), a click to edit or archive; how many characters the layer holds always, warned past its share. *Recent changes* folded at the bottom. In an employee's profile → Session: *Central context* and the version that session holds.

## Who may do what

| | read | write |
| --- | --- | --- |
| Office, role facts | owners, colleagues | owners, colleagues |
| A project's | whoever may read / work on the project (a member's own project: that member and owners) | the same |
| An employee's own notes | whoever may read / work with that employee | the same, and the employee itself |
| A client's | owners | owners |
| Visitors | nothing | nothing |

Routes (`access.ts`, the finer check in the route): `GET /api/context` (**detail**), `GET /api/context/pack/:employee` (**detail** on the employee), `POST /api/context/facts`, `PATCH`/`DELETE /api/context/facts/:id`, `POST …/:id/accept`, `POST …/:id/drop` (**work**, then by layer as above).

## Where the code is

| | |
| --- | --- |
| Types and rendering | `packages/contracts/src/context.ts` — `ContextFact`, `ContextPack`, `renderContext`, `renderContextChange`, the budget |
| The office | `packages/orchestration/src/context.ts` — `CentralContext` (facts in kv `context.facts`, history in `context.history`, `packFor`, `pushAll`, `propose`, `find`, `noticeMeeting`); `registry.ts` (`LaunchSpec.context` at a start); `hook-receiver.ts` (`contextRev`); `mcp-tools.ts` + `integrations/src/mcp.ts` (`get_context`, `propose_context`); `rent.ts` (a client's facts with their messages; the two tools allowed to rented employees); `prompts.ts` (the line in the system prompt) |
| The machine | `apps/host-agent/src/agent.ts` — `session.context`, and the two hooks in `onHook` |
| Server | `apps/server/src/server.ts` (the routes and `contextMay`), `access.ts` |
| Window | `apps/desktop/src/hud/panels/context.tsx`; the line in `team.tsx` (Session) |
| Tests | `tests/real/context.ts` (real Claude Code — spends usage, run only when asked: start, change, a real `/compact`, the version); `packages/orchestration/test/context.test.ts` (what a pack holds and in what order, the change, the cap, proposals and the vault, a meeting noticed, one push per change); `tests/e2e/61-context.test.ts` (real sessions: given at the start, the change at the next prompt and nothing when nothing changed, whole again after a compaction, `get_context`, proposals straight in and through a person, a rented employee and a client's facts, who may write what through the door); the UI suite's Context step; the scripted stand-in reads `additionalContext` (`ctx`, `compact` steps) |

## Limits, plainly

- **Claude Code only** (the owner's word: other providers later). Every employee the office runs is Claude Code, on any Claude account or Z.AI, so this covers them all today; an SDK-managed worker does not run these hooks and gets only what its launch prompt says.
- **A session given the context by an older machine agent** (a member's computer whose app is from before) gets nothing from the hooks: update the app there.
- **"The newest word" is an instruction.** The model is told the context replaces what it was told before; it is not forced to follow it.
- **Which answers are "standing"** is decided by words, not understood: a rule said without one of them is not offered (add it by hand), and an answer with one of them that holds only once is offered (drop it).
- **The import does not read repositories' README files**: a project's description, goals and notes in the office are what it offers.
- **Seen with real Claude Code**, twice (2026-11-17). On the live office: a running employee's next prompt was answered by its machine with the pack — the version recorded equals the current one, and the text stands in its Claude Code transcript. And with `tests/real/context.ts` (run on the owner's word, model haiku, about half a minute): a fact in the context before the start is known without reading anything; a changed fact is known at the next prompt; after a real `/compact` the context stands again in Claude Code's own transcript after the compaction, and the fact is still known; the office records the current version — 5 of 5.
