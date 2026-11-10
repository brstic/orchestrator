# Implementation plan and status

The plan follows the six phases of the product brief. Each phase lists what it had to deliver, where it lives, and which automated check proves it. "Scripted worker" means `tests/fixtures/fake-claude.mjs`, a stand-in that reads the same flags, fires the same hooks and calls the same MCP tools as Claude Code; "real" means the installed Claude Code CLI.

| Phase | Delivers | Where | Proven by |
| --- | --- | --- | --- |
| 1 — Real execution foundation | tmux sessions per employee, live terminal streaming, exclusive input ownership, hooks → normalised events, persistence and reattach after restart | `packages/execution`, `packages/terminal`, `apps/host-agent`, `packages/database` | e2e `01-foundation`, `04-recovery`; real: `tests/real/acceptance.ts` |
| 2 — Functional 3D office | Rooms with a function each, employees at desks driven by real state, camera modes, workstation view of the real terminal | `packages/office-3d`, `apps/desktop` | `tests/ui/run.mjs` (real clicks and keys in Electron; server-side checks of what each click did) |
| 3 — Agent orchestration | Projects, task board, delivery and verification, questions and approvals answered from the office, MCP server, command bar | `packages/orchestration`, `packages/integrations` | e2e `02-orchestration`, `06-cubicle`, `10-auto-docs-browse`; real: `approvals.ts`, `talk.ts`, `auto.ts` |
| 4 — Autonomous collaboration | Worktrees per employee, reviews, merges and conflicts, requests between employees, handoffs, meetings, planning, integration tests and promotion | `tasks.ts`, `comms.ts`, `meetings.ts` | e2e `03-collaboration`, `11-teamwork-ops-security`; real: `team.ts`, `flows.ts`, `flows2.ts` |
| 5 — Simulation and progression | XP from verified evidence, levels, company figures and milestones, office behaviours, project seating, self-improvement (lessons, retrospectives, suggestions) | `packages/game-systems`, `improve.ts`, `People.tsx` | unit tests; e2e `05-self-improvement`, `11` (company figures) |
| 6 — Production hardening | Multiple machines, SSH links, reconnects, resource pressure, security alerts, PostgreSQL, SDK-managed runtime, packaging and installers, documentation | `apps/server`, `ssh-links.ts`, `scripts/package.mjs`, `docs/` | e2e `07-multi-host`, `08-postgres`, `09-sdk-runtime`; `tests/linux/*` (Debian, Ubuntu, three machines with a network partition, a server linked over SSH, `.deb`, Linux desktop); `scripts/smoke-package.mjs`; `SECURITY-REVIEW.md` |

## Order of work, and why

1. The execution layer came first and is the only layer allowed to touch tmux, processes and git. Nothing above it may claim something the layer below did not report.
2. The office was built on the live event stream of layer one, not on fixtures, so that no state could be shown that the system does not have.
3. Orchestration was added as rules over recorded facts (a task is DONE when verification ran and passed), then collaboration on top of isolated worktrees.
4. Progression counts only what phases 3–4 verified. Hardening came last because it needs everything else to exist: more machines, other operating systems, packaging.

## Not done, and why

- **Windows (native or WSL2) and physically separate computers** were not available to test on. Multi-machine behaviour is tested with containers (Debian, Ubuntu) against this Mac, including a real network partition and an SSH-only server; Windows desktop bundles are assembled but have never been started.
- **Notarisation**: the macOS app is ad-hoc signed; `scripts/notarize.mjs` does the rest once a Developer ID is present.
- **The whole five-phase example as one real-CLI run across machines** is covered piecewise (real CLI on one machine; three machines with the scripted worker), because containers have no Claude account.
- **Art assets**: everything in the office is procedural geometry; `assets/` is empty on purpose.
- **An ORM**: storage is a small document store with two back ends (SQLite, PostgreSQL) behind one interface, tested against both; an ORM would have added a dependency without removing code.
