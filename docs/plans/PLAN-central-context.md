# Plan: the central context — what every employee always knows

_Status: **proposed, not started** (2026-11-16). The owner: "can we make a kind of central context so that more or less all agents have certain same information… we already have memory, but the point is that every agent always keeps the same context, no matter whom it talks to, whether it is rented or not, on another Claude account, on OpenAI, DeepSeek, Z.AI — that they always know everything they need to know. Make a good plan, tell me, and we will see whether it is good before we start."_

## The problem, as it stands today

| What exists | What it gives | Why it is not enough |
| --- | --- | --- |
| System prompt at launch (`systemPromptFor`) | role, instructions, project, a few lessons | written **once, at start**; a session that runs for days never sees a change; after Claude Code compacts the conversation, what was said in it is gone |
| Lessons / playbook (`improve.ts`) | rules learned from work | rules, not facts; chosen per task |
| Long memory (MemPalace) | the record, found by meaning | **on demand** (`recall`): an employee has to know it should ask, and what to ask |
| Project docs, CLAUDE.md in repos | per repository | each project's own, nothing shared across the office |

So the same fact ("we deploy with X", "the client Lazar wants Serbian copy", "the server is reached so") is known by whoever was told, until their session forgets it.

## The idea in one paragraph

The office keeps one **central context**: short, curated facts in layers (the office, a project, a client, a role, the employee themselves). For each employee it compiles their **context pack** — the layers that apply to them, filtered by what they may know — with a **version**. The pack is put in front of the model **by the office's machine agent at every point a session can lose it**: when it starts, when it is resumed, after every compaction, and — when the pack has changed — at the next prompt, as a short "what changed". It travels as text through Claude Code's own hooks, so it is the same whatever model is behind Claude Code (a Claude account, Z.AI, DeepSeek, OpenAI through a translating proxy), and it is mirrored into a file for any other runtime. The office shows, per employee, which version they hold.

## 1. What is in it — layers

| Layer | Who gets it | Examples |
| --- | --- | --- |
| **Office** | everyone (a "client-safe" subset for rented employees) | who the owner is and how they want to work; the team and who does what; servers and how they are reached (never secrets — names in the vault); conventions (language, commits, deploys); current priorities |
| **Project** | everyone on the project (and those who build on it) | stack, where it runs, how it is deployed, its state, its decisions |
| **Client** | only employees that client rents | who the client is, what was agreed, what was delivered, their preferences ("copy in Serbian", "never touch production on Fridays") |
| **Role** | everyone with the role | how a reviewer, a PM, a devops engineer works here |
| **Self** | the employee | what they are in the middle of, their own handover note (written by them) |

Each **fact** is a short entry: text, layer and scope, *always* (in the pack) or *on demand* (found with a tool), who wrote it and when, optional *review by* date. Facts are small on purpose: the pack stays within a budget (say 3–4k tokens; the window warns when a layer grows past its share). Anything longer is a document the pack points to, read with `get_context`.

Derived parts are written by the office itself, never typed: the roster (who is here, on what, on which machine), the list of projects, who rents whom.

## 2. Where facts come from

1. **The owner** — a **Context** window: layers as tabs, facts as rows, *always / on demand*, who sees it, history with diffs ("who changed what, when"), *review by*.
2. **Employees propose** — a tool `propose_context` ("this should be known by everyone on Shop: …"). A proposal lands in the Inbox as one line with *Add / Edit / Drop*; an owner may let some layers take proposals without asking (e.g. a project's own state).
3. **The office notices** — an answer the boss gave that is a standing rule ("always deploy from main"), a meeting's decision, a lesson that proved itself: offered as proposals, never added silently.
4. **Imported once** — from what exists: `DECISIONS`-like files, project READMEs, the owner's standing instructions per employee (which become the "self/role" layers), lessons with office scope.

Credentials never enter: the vault's capture runs on every fact, as on messages.

## 3. How it reaches every session — the same way for every model

The machine agent (host agent) keeps, per session, the **pack and its version**, sent by the office (`session.context` — the same live channel as `session.fence`). It answers Claude Code's hooks **locally**, so nothing waits on the server:

| When | Hook | What the model is given |
| --- | --- | --- |
| a session starts or is resumed | `SessionStart` (source startup / resume) | the whole pack |
| Claude Code compacted the conversation | `SessionStart` (source compact) | the whole pack again — the moment today's context is lost |
| the pack changed since this session last got it | `UserPromptSubmit` | "The office's context changed (v41 → v42):" and only the changed facts |
| the employee needs more | MCP `get_context { topic }` | an on-demand fact or a pointed-to document |

The launch's system prompt keeps only what does not change (who they are, the role); everything that can change lives in the pack. Each injection carries the version; the hook reports it back, so the office **knows** which version each session holds.

### Providers

Everything the office runs today is **Claude Code**, whatever answers it, and hooks are Claude Code's — so the pack is the same for:

- **Claude accounts** (any number) — as today;
- **Z.AI** — already Claude Code with another base URL;
- **DeepSeek** — has an Anthropic-compatible endpoint: added as a "custom" provider account (exists: `addProviderAccount` with `custom` + base URL);
- **OpenAI** (and anything without an Anthropic-compatible API) — through a translating proxy on the machine (LiteLLM, claude-code-router), added as a custom provider pointing at it. The employee is still Claude Code with hooks and MCP, so the pack and the tools are the same. Recommended over a second runtime.
- **Another runtime** (Codex CLI, Aider, a later SDK worker): the pack is also written to a file in the working folder (`.orchestrator/CONTEXT.md`, linked from `AGENTS.md`), which those read at start; their updates are weaker (no compaction hook) — said so in the window.

## 4. Who may know what — the rules stay

- **Rented employees**: the office layer reduced to facts marked *client-safe*; a client's layer only to employees that client rents; with several clients, each client's layer is put in with that client's message rather than in the pack (so one client's facts are not handed to an employee while it answers another — it already knows them, but it is not reminded).
- **A member's own computer**: facts about a member's own projects go only to that member's employees (as messages and events do now); closed rooms stay closed.
- **The foreman** gets everything an owner sees.
- Visitors and colleagues see the Context window as far as they may read what it is about; editing the office layer is an owner's, a project's layer whoever may work on the project.

## 5. Seeing that it works

- In an employee's profile: **Context v42 ✓** (or *v40 — gets the change at their next turn*), and a *Show what they know* view: the pack exactly as it was given.
- In the Context window: per fact, how many sessions hold it; facts past *review by*; layers over budget.
- A test that matters: change a fact → the next prompt of every running session gets the diff; compact a session → it gets the whole pack; an employee on a "custom" provider gets it the same; a rented employee never gets a non-client-safe fact or another client's.

## 6. Phases

| Phase | What | Rough size |
| --- | --- | --- |
| **1. Core** | facts (office + project + self layers), the pack and its version, `session.context`, `SessionStart` and `UserPromptSubmit` injection by the host agent, `get_context`, the Context window (edit, history), the version in the profile | the largest part; e2e with the scripted stand-in (it learns to read `additionalContext`) |
| **2. Who knows what** | client and role layers, client-safe, several clients, members' own projects, budget warnings | medium |
| **3. Where facts come from** | `propose_context`, proposals in the Inbox, the office noticing answers / decisions / lessons, the one-time import | medium |
| **4. Providers** | DeepSeek and OpenAI (proxy) as custom accounts, documented and tried; the file mirror for other runtimes | small to medium; needs real keys to try |
| **5. Health** | "who holds which version", stale facts, *Show what they know* | small |

## Open questions for the owner

1. **Who writes the office layer** — owners only, or colleagues too (with an owner's approval)?
2. **Employees' proposals** — always through the Inbox, or straight in for some layers (a project's state, one's own notes)?
3. **Rented employees** — do they get the office layer at all (the client-safe part), or only their client's and their project's?
4. **OpenAI** — through a proxy into Claude Code (recommended: everything stays the same), or a second runtime (Codex CLI) with weaker guarantees?
5. **Budget** — about 3–4k tokens always in front of every employee (it costs on every compaction and start, and a little on every changed turn): enough, or larger?

## Not in this plan

Replacing MemPalace (it stays the archive, searched on demand) or the lessons (they stay rules measured by results; a proven office-wide lesson can be *proposed* as a fact).
