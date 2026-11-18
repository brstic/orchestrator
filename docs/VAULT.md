# The vault

Where the office keeps passwords, tokens and keys, how they get in and out, and how to work on it. Read this before touching `packages/orchestration/src/vault.ts` or `vault-detect.ts`.

_Built on 2026-11-11 on the owner's request, after the vault of the owner's Ahoy project. Why it is built this way: `DECISIONS.md`, "The vault". What protects what, and what does not: `SECURITY.md`, "The vault". Who may do what: `ACCESS.md`, "The vault"._

## The idea in one paragraph

A credential gets a short **name** (`github-deploy-token`). The **value** is encrypted on the server and nothing else ever carries it: messages, tasks, events, the audit log and the vault's own list say `{{vault:github-deploy-token}}`. An employee uses a credential by asking for it *inside a command* — `$("$ORCH_VAULT" get github-deploy-token)` — so the value goes into the command and not into the model's conversation.

## How a credential gets in

| Way | Who | Code |
| --- | --- | --- |
| Typed into the Vault window (Menu → Office → Vault, or Space at the safe in the Server Room) | an owner or a colleague | `POST /api/vault` → `Vault.put(…, 'added')` |
| **A new value under the same name** (a changed password, a rolled key): *Put in a new value…* in the window | an owner | `PUT /api/vault/:id/value` → `Vault.replaceValue`; employees go on using the same name, the old value is deleted, `vault.changed` in the audit log. Refused when the value is already in the vault under another name |
| `vault_store { name, value, … }` | an employee that was given, found or made one | `mcp-tools.ts` → `Vault.put(…, 'stored')` |
| `… \| "$ORCH_VAULT" put name` | a command in an employee's session; the value never passes through the model | the helper → `vault_store` |
| **By itself, out of a text somebody wrote**: a message to an employee, a task's description or acceptance criteria, an answer to a question, a note for the long memory | the office | `Vault.capture` — called from `comms.sendMessage`, `tasks.createTask`, `comms.answer`, the `remember` tool. The text goes on with `{{vault:name}}` where the value was |
| **By itself, seen in a session**: a prompt, a command, what a tool returned | the office | `Vault.noticed` — called from `hook-receiver.ts`; only formats that cannot be mistaken |

The same value twice is one entry (recognised by a keyed hash, never by reading it). A taken name gets a qualifier (`github-token-deploy`), then a number.

## What is recognised (`vault-detect.ts`, `detectSecrets`)

- **By format**: Anthropic, OpenAI, AWS, GitHub, GitLab, Slack, Google and Stripe keys; JWTs; private keys (`-----BEGIN … PRIVATE KEY-----`); `Bearer …` / `Basic …`; `Authorization:` and `X-Api-Key:` header lines; a password inside an address (`https://user:password@host`).
- **By a field's name**: `DB_PASSWORD=…`, `"api_key": "…"`, `token: …` — when the value is strong or long, and is not code.
- **By the sentence**, in English and Serbian: "the password for X is …", "lozinka za X je …", "token: …" — when the value has the shape of a password (letters, digits and a capital or a symbol, eight or more).
- **Left alone on purpose**: `process.env.API_KEY`, `$TOKEN`, `${SECRET}`, `<your-token>`, `getToken()`, `changeme`, plain words, `{{vault:…}}` itself. A bare password with nothing around it that says so is *not* caught — the server reads no sentence for its meaning. The employee who reads it is told to store what is plainly a credential.
- **Sizes** (so that looking takes time in step with the text — it runs on the office's one thread, over text a session can shape; `DECISIONS.md`, "Patterns that read other people's text…"): a field's name may have 64 characters before and after the word that makes it one (`password`, `token`, …) and begins where a word begins; a part of a JWT has at most 8,000 characters, a private key block 20,000. Longer ones are not recognised. `vault.test.ts` times the detector on text built to be slow.
- The login and the site mentioned nearby become the entry's `username` and `service`, and its name is built from them (`nameFor`: service, login, kind — `example-branko-password`).
- `Vault.noticed` keeps only the unmistakable formats (provider keys, private keys, passwords in addresses), because what goes through a session is full of things that merely look like fields.

Adding a format: one line in `TOKENS` (name, pattern, kind, service) and a case in `packages/orchestration/test/vault.test.ts` — both that it is found and, in the "left alone" list, what must not be.

## How a credential gets out

- **To a command in an employee's session.** At launch the host agent writes two files into the session's own folder (`vaultHelper` in `packages/execution/src/claude.ts`): `vault` (a two-line shell script) and `vault.mjs`, and sets `ORCH_VAULT` to the first. `"$ORCH_VAULT" get NAME` prints the value and nothing else; `put NAME` stores what comes in on a pipe; `list` shows names. The helper calls the office's worker endpoint with the session's own token (from the `mcp.json` beside it) — the unlisted tool `vault_read`. Every use is recorded (`vault.used` in the audit log, under the employee's name); the feed shows the first use of each entry.
- **To an owner who asks to see one.** `POST /api/vault/:id/reveal` — owners only, recorded (`vault.revealed`), never cached. The window shows it for half a minute.
- There is **no tool that hands a value to the model**. That is the point (see DECISIONS for what was rejected).

Employees are told all of this in their system prompt (`prompts.ts`): what `{{vault:NAME}}` means, how to use one in a command, to store what they are given or make, and never to print one.

## Where things are

| | |
| --- | --- |
| Storage, encryption, capture | `packages/orchestration/src/vault.ts` — `Vault` (`put`, `update`, `remove`, `use`, `list`, `capture`, `noticed`, `mentioned`) |
| Recognition and naming | `packages/orchestration/src/vault-detect.ts` — `detectSecrets`, `nameFor`, `uniqueName`, `serviceWord`, `PLACEHOLDER` |
| Employees' tools | `VAULT_TOOLS` in `packages/integrations/src/mcp.ts`; handlers in `packages/orchestration/src/mcp-tools.ts` |
| The helper | `vaultHelper` in `packages/execution/src/claude.ts`; written at launch in `apps/host-agent/src/agent.ts` |
| For people | `GET`/`POST /api/vault`, `PATCH`/`DELETE /api/vault/:id`, `POST /api/vault/:id/reveal` in `apps/server/src/server.ts`; rules in `access.ts` |
| The window | `apps/desktop/src/hud/panels/vault.tsx` (and `vault.css`); its words and shelves in `apps/desktop/src/lib/vault.ts` (`apps/desktop/test/vault.test.ts`) — see "The window" below |
| The safe in the office | `packages/office-3d/src/Vault.tsx`, `vault()` in `models/rooms.ts`; `nearby.kind === 'vault'` → `openPanel('vault')` |
| On disk | entries in the office's database (key `vault` of its key-value store), each value AES-256-GCM under the key in `<data folder>/vault.key` (mode 600, made at first use) or `ORCH_VAULT_KEY`. **The key belongs in the backup; without it nothing in the vault can be read** |

## The window

Built as a vault on the owner's word of 2026-11-18 ("make the vault's interface actually look like a vault, very clear and easy to use"), in the kit of `UI.md`:

- **The head:** the vault's door as its emblem, how many credentials are under lock and how many times one was taken out (by an employee's command or an owner who looked). The one main button: *Add a credential*.
- **Left — the boxes, on shelves by what they open** (`byService`: "github.com 2", "db.shop.example 1", what opens nothing named last as "Other"). A box is one line: a kind's sign on a metal tile, the name, the kind and the login, and how many times it was used ("3×", or "unused"). Above them: a box to find by (every word typed must be in its name, what it opens, the login, the note or the kind) and the kinds with how many of each.
- **Right — the box that is open:** its door, a steel plate with the name, what it is and opens, the note, and **the slot** — the value as dots and its length. An owner presses *Show*: the slot opens for half a minute, says how many seconds are left ("locks in 27 s"), with *Copy* and *Hide*; that look is recorded. A colleague reads "Only an owner can open the value, change it or take it out of the vault". Under the plate: **how employees use it** — `$("$ORCH_VAULT" get name)` in a command and `{{vault:name}}` in a message or a task, each with *Copy* — and **on the record**: how it got here and when, how often it was used and by whom last, when it last changed.
- **What an owner does with it,** at the bottom: *Edit details* (name, kind, what it opens, login, note — a rename says that employees told the old name will not find it), *Put in a new value…*, and last *Remove…*, which asks first.
- **Putting one in** fills the right side: the kind as five buttons with their signs, what it opens and the login, the value in a slot of its own (hidden, *Show* to check it; a box for a private key), then the name (made from what it opens when left empty) and a note.
- Nothing moves by itself; the colours are the app's, the steel is greys, and the gold of the dial is the only warm colour — on an open slot, which is the one thing to look at.

## Testing it

- `packages/orchestration/test/vault.test.ts` — what is and is not recognised, naming, encryption (a restart with the same key reads it; another key says so), capture, noticing.
- `tests/e2e/21-vault.test.ts` — real sessions with the scripted worker: kept by name, used through the helper, moved out of a message, stored through the tool and from a pipe, noticed in a file that was read, removed, across a restart. Each step also checks that the value is nowhere in the office's state, events or audit log, and not on the terminal.
- `apps/server/test/access.test.ts` — who may list, add, look, change, remove.
- `apps/desktop/test/vault.test.ts` — the window's words, shelves and search.
- A step of the UI suite (`Vault: boxes on shelves…`, alone with `UI_ONLY='^Vault:'`): five credentials put in, the shelves and a kind's filter, a colleague's window (no value, nothing to change), one added through the window, opened with its seconds, given a new value, renamed and removed; pictures `vault.png`, `vault-add.png`, `vault-open.png`, `vault-colleague.png`.
- In tests, remember that a message is captured before it is delivered: a value written into a scripted instruction (`@@fake: …@@`) is replaced by its name too.

## Limits, plainly

- Every employee can use every credential; there are no per-project vaults and no per-credential permissions (the owner's request: "any agent can use anything").
- A command can print a credential (`echo`), and then it is on the terminal — which visitors may watch — and in the model's context. The instructions forbid it; nothing prevents it.
- Encryption protects a copied database without the key. It does not protect against someone who can read the server's data folder.
- A credential that was delivered or printed before it reached the vault is still wherever it went. Removing an entry does not change it where it is used.
- An employee on a member's own computer takes values to that computer. SDK-managed workers have `vault_list` and `vault_store` but no helper. A member's computer needs a current desktop app for the helper.
- Not verified with real Claude Code: that it writes `$("$ORCH_VAULT" get name)` instead of asking for the value, what its permission prompt shows for such a command, and that it stores what it is given.
