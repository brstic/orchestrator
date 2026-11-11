# Ideas — a better memory, borrowing from MemPalace

_Written 2026-11-10 from a conversation with Fenix. **Ideas only: nothing here is decided or built.** When one is picked up, it becomes a plan of its own and a line in `DECISIONS.md`._

**Source:** MemPalace — `github.com/MemPalace/mempalace` (MIT), package `mempalace` on PyPI, site `mempalaceofficial.com`. Those three are the only official ones; its README warns that other domains are impostors. What follows comes from its README and site; its code was not read and it was not run.

**The decision behind this page:** we keep Orchestrator's own memory and improve it with MemPalace's ideas. We do not add MemPalace itself: it needs Python and a local embedding model of about 300 MB, which works against a simple install.

## What we have today (`packages/orchestration/src/improve.ts`)

Lessons: short rules (up to 400 characters) with an "applies when", scoped to an employee, a project or the company. They come from a retrospective after a task with friction (`record_lesson`), from every answer the owner gives to a question, or from the owner directly. Shared ones wait for the owner's approval. Active ones go into the system prompt and every task prompt.

## Where it falls short

1. The 12 newest lessons are chosen, not the relevant ones; "applies when" is printed, never used to choose (`lessonsFor`, `MAX_LESSONS_IN_PROMPT`).
2. An employee cannot ask "what do we know about X".
3. Only rules are kept. What was done, why, and what was tried and dropped lives in the Claude session and is lost when it is compacted or replaced.
4. A lesson is a duplicate only if its text is identical.
5. Lessons never expire and nothing notices two that contradict each other.

## What to take

| # | Idea | In MemPalace | In Orchestrator | Closes |
| --- | --- | --- | --- | --- |
| 1 | **Choose by relevance** | Search is scoped and ranked instead of reading a flat list | Pick the lessons for a prompt by matching the task's text against lesson text and "applies when". SQLite full-text search (FTS5) is enough to start; no new dependency | 1 |
| 2 | **A diary per employee** | Each agent has its own wing and diary | A short entry when a task ends: what was done, what is left, what to remember. A new or replaced session starts with the last few entries. Fits "an employee outlives any session" | 3 |
| 3 | **Keep the words, fetch on demand** | Original text is stored untouched and searched, rather than summarised | Store the employee's replies, the owner's decisions and task outcomes; give employees a `recall` tool. Nothing of it goes into a prompt unasked | 2, 3 |
| 4 | **Save before compaction** | Hooks on `Stop` and `PreCompact` file the conversation | We already receive Claude Code hooks; on `PreCompact` write a diary entry before the session loses its context | 3 |
| 5 | **Facts with a period of validity** | A knowledge graph with valid-from / valid-to | A lesson gets "valid until", and a new lesson that contradicts an old one retires it instead of both staying active | 5 |
| 6 | **A small always-on layer, the rest on request** | Layered memory: identity and essentials always, everything else by search | Keep the prompt short: who you are, what you are working on, a handful of rules — and `recall` for the rest | 1 |

Ideas 1 and 2 are the cheapest: server only, no new dependency, no new tool for workers. Ideas 3 and 4 give the most and need a new store and a new MCP tool.

## Rules any of this must keep

- **Shared versus personal.** What a member's own employee remembers is readable by that member and owners only, like the rest of what is said on their computer (`ACCESS.md`).
- **Secrets.** Stored text goes through the redactor that already cleans events (`packages/contracts/src/util.ts`).
- **Evidence.** A memory names where it came from (task, question, session), as lessons do now.

## Left out

- **A vector database and a local embedding model**: a large install for a gain we do not need yet. Semantic search can be added later behind the same `recall` tool.
- **The compressed index (AAAK)**: complex, and only worth it for a far larger memory than an office has.
