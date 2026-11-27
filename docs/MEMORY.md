# The long memory (MemPalace)

What the office remembers, how, and how to work on it. Read this before touching `packages/orchestration/src/memory.ts`.

_Built on 2026-11-11 on the owner's word ("install MemPalace on the server and give it to the agents"). Why it is built this way: `DECISIONS.md`, "The long memory is MemPalace, behind two tools of the office's own". What was and was not checked: `STATUS.md`._

## What it is for

Growth (`improve.ts`, `learning/*`) keeps **rules** — lessons — and measures whether they help. It does not keep what was *said and done*. A session that is compacted or replaced forgets why the cache was removed, how the shop is deployed, what the owner answered last month.

The long memory keeps the **record**, word for word, and finds in it by meaning:

- an employee asks it a question in plain words and is given what bears on it (`recall`);
- an employee writes down what should outlive the session (`remember`);
- a task is handed over with what the office already knows about its subject;
- everything worth keeping is filed without anybody deciding to file it.

## The parts

```
 employee's session (any machine)            the office's server                       MemPalace (same machine)
 ┌──────────────────────────────┐   MCP     ┌───────────────────────────────────┐      ┌───────────────────────────┐
 │ recall { query }             ├──────────▶│ mcp-tools.ts  →  Memory.recall()  │ CLI  │ mempalace search "…"      │
 │ remember { about, note }     │           │                  Memory.note()    ├─────▶│ mempalace mine <records>  │
 └──────────────────────────────┘           │ engine.ts: on every saved record  │ one  │                           │
                                            │   task DONE      → Memory.task()  │ at a │ palace/   its own store   │
   a task is handed over                    │   answer given   → Memory.answer()│ time │ config/   its settings    │
 ┌──────────────────────────────┐           │   lesson in use  → Memory.lesson()│      └───────────────────────────┘
 │ "From the office's memory —" │◀──────────┤   meeting decided→ Memory.meeting()│
 │  up to three related records │           │ tasks.ts: unblock → Memory.unblocked()
 └──────────────────────────────┘           │ records/<room>/<key>.md  (what the office wrote)
                                            └───────────────────────────────────┘
```

- **MemPalace** (`github.com/MemPalace/mempalace`, MIT, Python) is a separate program. It stores text as it is and searches it by meaning with a local embedding model. Nothing leaves the machine.
- **The office does not embed it and does not give employees its MCP server.** The office's server calls MemPalace's command line; employees call the office. So there is one palace, on the server; an employee on any machine — a member's own computer included — reaches it with the tools it already has a connection for; and the office's own rules decide what goes in.
- Where MemPalace is not installed, `Memory.available()` is false: the two tools are not offered, nothing is filed, nothing else changes.

## What is filed, and what is not

Each record is one Markdown file, written once, under `<data folder>/palace/records/<room>/`. The first line is a title that says what it is; MemPalace returns the text as filed.

| Room | Filed when | What the record says | Code |
| --- | --- | --- | --- |
| `tasks` | a task becomes DONE (not review tasks) | key, title, project, who, the date; what was asked; acceptance criteria; what the employee reported; files changed; how it was verified (and whether it changed its own checks); the review; what went wrong on the way | `Memory.task` |
| `answers` | a question gets its answer | who answered whom, in which project and task; the question, its context, why it was asked; the answer | `Memory.answer` |
| `blockers` | a blocked task is unblocked with a note | what it was blocked on; who resolved it and how | `Memory.unblocked` |
| `lessons` | a lesson is in use (`active`) | the rule, when it applies, why, whose it is | `Memory.lesson` |
| `meetings` | a meeting has a decision | topic, context, who was there, the decision document | `Memory.meeting` |
| `notes` | an employee calls `remember` | whose note, the subject, the note | `Memory.note` |

**Never filed:**

- anything from a **member's own computer** — its projects, its employees' questions and notes (`Memory.personal`). What is said there stays theirs (`ACCESS.md`). Such an employee can still *ask* the memory: what it holds is the shared office's.
- **permission requests** (they are not knowledge), **terminal output**, the owner's messages as such.
- **credentials**: every record goes through `redactSecrets`, and a note goes through the vault's capture first, so a password in a note becomes `{{vault:name}}` (`docs/VAULT.md`).

**At the first start** (and when the owner switches the memory back on) the office files what is already on its record: finished tasks, answered questions, lessons in use, meeting decisions — the newest 1,500 of each (`Memory.catchUp`). A record is identified by a key (`task-<id>`, `answer-<id>`, …) kept in the office's store (`memory.filed`), so nothing is written twice.

## How employees use it

Two tools, shown only while the memory is available (`MEMORY_TOOLS` in `packages/integrations/src/mcp.ts`; handlers in `packages/orchestration/src/mcp-tools.ts`):

- **`recall { query }`** → up to six records, closest first, each with its room and how close it is: `1. (answers, match 0.68)` and the text. Only records at or above `RELEVANT` (0.42 cosine similarity) are shown; below that the answer is "nothing close", naming the nearest thing so the employee can see it is about something else.
- **`remember { about?, note }`** → a note in `notes`. Refused when it is too short to be understood without the conversation, and for an employee on a member's own computer.

The system prompt tells them when (`prompts.ts`, the `longMemory` lines): ask before starting something that may have been done, decided or tried before; write down a decision and its reason, how something really works, what was tried and dropped. It also says what they need not write down, because the office does.

**A task's hand-over** (`tasks.ts`, where the task prompt is built): the office searches for the task's title and the start of its description and appends up to three records at or above `RELEVANT` under "From the office's memory — earlier work, answers and decisions that look related. They may be out of date…". It waits at most twelve seconds (`timings.memoryRecallMs`); if the memory has nothing, is slow or is down, the task goes out without the block. Not done for projects on a member's own computer.

An employee on a member's own computer cannot write into the shared memory (`remember` refuses: what is said there
stays there); the refusal points it to its own notes instead — `propose_context` with layer `self`, which go in at once
and come with it at every start (`docs/CONTEXT.md`).

## How MemPalace is run

Everything goes through `Memory.run` — read it first.

- **One process at a time.** Calls are chained on a promise queue; a second call waits for the first. The owner's server is shared and has frozen under memory pressure before; two embedding models loaded side by side is exactly what must not happen.
- **Nothing resident.** Each call starts `mempalace`, which loads the model, does its work and exits. Measured on the server (MemPalace 3.11.0, multilingual model): a search about 4.5 s; filing two records about 40 s the first time.
- **A time limit on every call** (search 30–45 s, `mine` ten minutes, `init` two); a call that runs over is killed and counted as failed.
- **Fail open.** `recall` returns nothing rather than throwing, and stops waiting at its own limit even when other calls are ahead of it in the queue. A failure is kept as `lastError` and shown in Settings → Growth.
- **Filing is batched.** `remember()` writes the file at once and schedules one `mine` twenty seconds later (`timings.memoryMineDelayMs`) for everything that came in meanwhile. `mine` skips files it has filed before.
- **Its settings** (environment of every call): `MEMPALACE_CONFIG_DIR=<palace>/config` (so it does not use the user's `~/.mempalace/config.json`), `MEMPALACE_EMBEDDING_MODEL=embeddinggemma` (multilingual — the owner writes Serbian, records are mostly English; the small English-only model scored a Serbian question at 0.03 against the record it should find, this one at 0.60), `MEMPALACE_EMBEDDING_THREADS=4`, `MEMPALACE_EMBEDDINGGEMMA_BATCH_SIZE=4`, `MEMPALACE_DISABLE_UPDATE_CHECK=1`. `--palace <palace>/palace`, wing `office`, agent `orchestrator`, `--direct` (no daemon).
- **`init` asks a question** ("Mine this directory now?") when it has someone to ask; the office starts it with its input closed. By hand, add `< /dev/null`.

The exact command lines, for trying by hand, are in `OPERATIONS.md` ("The long memory").

## Where things are

| | |
| --- | --- |
| The engine side | `packages/orchestration/src/memory.ts` — `Memory` (run, start, remember, recall, the six record writers), `parseSearch` (MemPalace's output → results), `RELEVANT` |
| Wiring | `packages/orchestration/src/engine.ts` (created with the engine; files on every saved task, question, lesson, meeting; started in `start()`), `tasks.ts` (`unblock`, the hand-over block) |
| Tools and prompt | `packages/integrations/src/mcp.ts` (`MEMORY_TOOLS`), `packages/orchestration/src/mcp-tools.ts` (`recall`, `remember`, listed only when available), `prompts.ts` |
| Finding the program | `apps/server/src/server.ts` (`findMemPalace`): `ORCH_MEMPALACE_BIN` (`none` switches it off), else `<install folder>/mempalace-venv/bin/mempalace`. Not looked for on `PATH`: a MemPalace somebody installed for themselves is theirs |
| The owner's switch | `OwnerSettings.longMemory` (default on); Settings → Growth → *Long memory* (`apps/desktop/src/hud/panels/settings.tsx`, `LongMemory`) |
| For people | `GET /api/memory` (state: everyone), `POST /api/memory/recall` (whoever works here) |
| On disk | `<data folder>/palace/records/` (the office's files), `palace/` (MemPalace's store), `config/` (its settings). On the server: `~/.orchestrator-office/server/palace/` — inside the office's backup. The program: `~/orchestrator-office/mempalace-venv/`. The model: `~/.cache/huggingface` (about 315 MB). MemPalace also keeps lock files in `~/.mempalace/locks` |

## Installing it

On the machine the office's server runs on (`OPERATIONS.md` has the same, with upgrade and removal):

```sh
python3 -m venv ~/orchestrator-office/mempalace-venv          # Python 3.10 or newer
~/orchestrator-office/mempalace-venv/bin/pip install mempalace
systemctl --user restart orchestrator-office
```

The office finds it at start, sets the palace up, files its history and says in the log `long memory: MemPalace 3.11.0 (…)`. A deploy of the office does not touch the environment. For a development office: `ORCH_MEMPALACE_BIN=/path/to/mempalace node scripts/dev-office.ts …`, or nothing — without it everything works as before.

## Testing it

- `packages/orchestration/test/memory.test.ts` — `parseSearch` against what MemPalace 3.11.0 really printed on the server.
- `tests/e2e/23-long-memory.test.ts` — the whole path with real sessions and a **stand-in for the MemPalace program**, `tests/fixtures/fake-mempalace.mjs`: the same commands (`--version`, `init`, `mine`, `search`) and the same output, comparing words instead of meaning. It also writes every call to `calls.log`, which is how the test proves that two never ran at once. The harness takes the program as `createHarness({ memoryBin })`; every other test runs without a memory.
- The real program is not part of any suite (it needs Python and a model). After a change to how it is called, try it by hand on a machine that has it — the commands are in `OPERATIONS.md` — and write into `STATUS.md` what you saw.
- Careful in tests: the scripted worker obeys `@@fake: …@@` wherever it reads it, and a filed task's description is given back by `recall` and by the hand-over. Keep a later task's subject away from records that carry such instructions (the test's comments say how).

## Extending it

- **A new kind of record:** add the room to `ROOMS` and `ROOM_ABOUT`, write a method like `task()` that builds the title and body and calls `remember(room, key, title, body)` with a key that is stable for that thing, and call it from where the thing is saved (the `entity` listener in `engine.ts`, or the place itself). Add it to `catchUp()` if history should be filed. A room added later needs its folder made — `start()` makes all of `ROOMS` — and MemPalace's `mempalace.yaml` in `records/` was written at the first `init`; delete that file to have the rooms detected again.
- **Changing what a record says** does not rewrite records already filed (they are written once per key). To refile everything: stop the office, delete `palace/` and the `memory.filed` key from the store, start it.
- **Making it faster:** MemPalace has a daemon (`mempalace daemon start`, and `mine --daemon`) that keeps the model loaded. It was left out on purpose (memory on a shared server); if the wait is felt, that is the place to start, behind the same `Memory.run`.
- **Its own MCP server** (`mempalace-mcp`, `mempalace serve`) exposes some 47 tools — diaries, a knowledge graph, navigation. Not given to employees (see DECISIONS). If one of those is wanted, wrap it as a tool of the office's own, like `recall`.
- **Relevance:** `RELEVANT` is one number chosen from a handful of tries. If employees are handed unrelated records, raise it; if `recall` says "nothing close" too often, lower it. Both show in what real sessions do — which nobody has watched yet.

## Limits, plainly

- It remembers what the office recorded, not what an employee thought. Whatever was only in a session's context and was not put into a task summary, an answer or a note is not there.
- Records are not updated or withdrawn: a decision that was later reversed is still found, with its date. The hand-over and `recall` both say "may be out of date".
- One palace for the whole shared office: no per-project memory, no per-employee diary. A colleague of the office can search all of it (`POST /api/memory/recall`).
- A search takes seconds and they queue: ten employees asking at once wait for each other; the hand-over gives up after twelve seconds.
- Not verified with real Claude Code: whether employees ask before starting, what they write down, whether the hand-over block helps or distracts.
