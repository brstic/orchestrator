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

## 2026-11-11 — asked again: "integrate it where it helps self-improvement"

The owner asked whether MemPalace itself should be integrated to help the office improve itself. Looked at again (its README and site; still not installed or run). **Nothing was built; this is the assessment and two ways to go.**

**Where things stand since this page was written.** Growth has in the meantime built ideas 1 and 5 its own way: lessons are chosen by how well they fit the task (`learning/playbook.ts`), merged when they say the same, and retired when the record shows they hurt (`learning/outcomes.ts`). What is still missing is everything about *what was said and done*, as opposed to rules: an employee cannot ask "what do we know about X" (idea 3), nothing is written down when a task ends or before a session is compacted (ideas 2 and 4). That is exactly what MemPalace is for, so the answer to "would it help" is **yes, for recall — not for the rules, the measuring or the autopilot, which it does not do.**

**What it is, for our purposes.** A Python program (3.10+) with ChromaDB and a local embedding model (about 300 MB, or 30 MB for the English-only one), MIT. It stores text word for word and searches it by meaning. It offers a command line (`mempalace mine`, `mempalace search`), an MCP server with some 47 tools (search, diaries per agent, a knowledge graph), and hooks for Claude Code that save on *Stop* and before compaction (`mempalace init` registers them). Its palace lives in `~/.mempalace` on the machine.

**Way A — use MemPalace itself, optionally, per machine.** Where it is installed on a machine, the office gives each employee's session its MCP server next to the office's own, and its hooks; employees are told to search it before starting and to file what they learned. Where it is not installed, nothing changes. Cost: Python and the model on every machine that should remember (the server first); memory is per machine, so a member's own computer has its own; what it stores is verbatim, so it has to stay behind the vault's capture and off machines the text should not be on; and there is a second thing to back up. Needs doing first, with the owner's word: installing it on the server (and on the development Mac, to try it — the exact command that starts its MCP server without Docker was not found in what was read and has to be seen on a real install).

**Way B — the same ideas in the office's own store, no new dependency.** A `recall` tool over what the office already records (task summaries and outcomes, the owner's answers, messages, lessons), a short diary entry per employee when a task ends and before compaction (`PreCompact` reaches the office already), and the last entries given to a session when it starts. Search by words (SQLite FTS), not by meaning. Cost: ours to build and keep; weaker search than embeddings. Gain: works on every machine as it is, one store, one backup, the office's access rules and the vault's capture apply by construction.

**Recommendation:** B first (it closes the gap for everyone with nothing to install), built so that the search behind `recall` can be MemPalace on machines that have it (A) later.

