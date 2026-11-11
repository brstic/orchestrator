# Orchestrator — working notes for Claude

A 3D office in which real Claude Code CLI sessions (in tmux) are employees. pnpm monorepo, Node ≥ 22.18 runs the TypeScript sources directly.

## Read before working
1. `docs/STATUS.md` — what is shipped, what is in progress, known problems. **Start here.**
2. The active plan under `docs/plans/` (currently `UPDATE-central-office.md`).
3. `docs/HANDOVER.md` — the whole loop for someone new to this repository: what you need, test, commit, push, deploy. `docs/OPERATIONS.md` — where the server and clients run and how each is updated (`pnpm deploy:server`). `docs/DEVELOPMENT.md` — how to build and test, and the rules that protect the live office.
4. `docs/DECISIONS.md` — why things are the way they are. Add an entry when you decide something a later reader would otherwise have to guess.

## Keep the docs true (standing rule)
Every change that alters behaviour, finishes or starts a plan item, or changes how to build/test/ship **updates the Markdown in the same piece of work**: tick the plan item, update `docs/STATUS.md`, add a line to `docs/CHANGELOG.md`, and touch `ARCHITECTURE.md` / `SECURITY.md` / `INSTALL.md` when their subject changed. Docs describe what the code does now, not what was intended. If something was not verified, say so there.

## Hard rules
- Product text is English. The owner writes Serbian; answer them in Serbian.
- Never run the real `claude` CLI or `tests/real/*` without being asked: it spends the owner's Claude usage. Tests use `tests/fixtures/fake-claude.mjs`.
- Never package (`scripts/package.mjs`) while `release/Orchestrator.app` is running; never kill the owner's tmux server or `orch-*` sessions; no `pkill`/`killall`.
- No permission-bypass flags for workers. No unauthenticated remote terminal access. Nothing mocked may be presented as a product feature.
- Commit or push only when asked.
