# Orchestrator — working notes for Claude

A 3D office in which real Claude Code CLI sessions (in tmux) are employees. pnpm monorepo, Node ≥ 22.18 runs the TypeScript sources directly.

## Read before working
1. `docs/STATUS.md` — what is shipped, what is in progress, known problems. **Start here.**
2. The active plan under `docs/plans/` (currently `UPDATE-central-office.md`).
3. `docs/HANDOVER.md` — the whole loop for someone new to this repository: what you need, test, commit, push, deploy. `docs/OPERATIONS.md` — where the server and clients run and how each is updated (`pnpm deploy:server`). `docs/DEVELOPMENT.md` — how to build and test, and the rules that protect the live office.
4. The page of the feature you are about to touch, where there is one (`docs/MEMORY.md`, `docs/VAULT.md`, `docs/ACCOUNTS.md`; `docs/README.md` is the map). A feature of that size gets such a page in the same piece of work.
5. `docs/DECISIONS.md` — why things are the way they are. Add an entry when you decide something a later reader would otherwise have to guess.

## Keep the docs true (standing rule)
Every change that alters behaviour, finishes or starts a plan item, or changes how to build/test/ship **updates the Markdown in the same piece of work**: tick the plan item, update `docs/STATUS.md`, add a line to `docs/CHANGELOG.md`, and touch `ARCHITECTURE.md` / `SECURITY.md` / `INSTALL.md` when their subject changed. Docs describe what the code does now, not what was intended. If something was not verified, say so there.

## Checking a change
`pnpm check:changed` is the fast loop while you work: it typechecks (only when a typechecked `.ts` changed) and runs the unit tests *beside* what you touched — the `test/` folder of each workspace a changed file belongs to — plus any changed `tests/e2e` file. It runs the tests of the packages you changed, not of the packages that depend on them, so it is a quick gate, **not** a replacement for `pnpm test:all` before shipping. `--base <ref>` measures a whole branch (e.g. `pnpm check:changed --base origin/main`); `--dry` prints the plan.

**Hit every surface.** A change is not done until you have thought about each of these and said in the work which it touches and how it was checked (or why not):
- **Roles** — visitor, colleague, owner (and the foreman). A control shown, hidden or disabled per role is checked as each role, not only as owner.
- **Shared vs personal** — a shared employee on the office's machine, and a member's own employee on their own computer (member rooms, privacy of their tasks/feed).
- **Local vs server office** — one machine, and the office running on the server behind the TLS door (deploy is the owner's call; see `OPERATIONS.md`).
- **Desktop vs browser** — the Electron app and a plain browser tab (preferences, autoplay, clipboard differ between them).
- **Both runtimes** — interactive `claude` in tmux (primary) and the SDK-managed worker.
- **A bug fix starts with a failing test** — one that fails for the bug, then passes with the fix.

## Hard rules
- Product text is English. The owner writes Serbian; answer them in Serbian.
- Never run the real `claude` CLI or `tests/real/*` without being asked: it spends the owner's Claude usage. Tests use `tests/fixtures/fake-claude.mjs`.
- Never package (`scripts/package.mjs`) while `release/Orchestrator.app` is running; never kill the owner's tmux server or `orch-*` sessions; no `pkill`/`killall`.
- No permission-bypass flags for workers. No unauthenticated remote terminal access. Nothing mocked may be presented as a product feature.
- Commit or push only when asked.
