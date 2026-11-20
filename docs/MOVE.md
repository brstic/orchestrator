# Moving an employee to another machine

An employee can be moved from the office's machine to a member's own computer, back, or between any two machines of the office — with everything that is theirs. The owner asked for it on 2026-11-20 ("so I can move agents from the office to my computer and back: a complete transfer — files, .md, memory, everything"), and for the office to show it ("percent over their head, they pack at their desk, and at 100 % they take the box and go and sit at the new place").

## What goes along

What the office keeps follows the employee by itself, because it is kept by their id on the server: tasks, messages, questions, lessons, routines, their goal, XP, their part of the central context. What is on the machine is carried:

| | |
| --- | --- |
| **Their own folder** — a folder of theirs, or a project only they work in, worked in place | The folder itself: git history, `.md` files, `.env`, everything — except folders an install or a build makes again: `node_modules`, `.venv`, `venv`, `__pycache__`, `.next`, `.nuxt`, `.turbo`, `.gradle`, `Pods` and the like always, and `dist`, `build`, `out`, `target`, `coverage`, `.cache` where git ignores them (a `build/` folder git tracks is theirs, and goes). The project moves with them: its tasks and settings, on the new machine. |
| **A project others work in too** | A **copy**: the repository with every branch (a git bundle), their own branch checked out (`orch/<them>/home`, when they have one), becomes a project of theirs on the new machine (`Project.copiedFrom`). The project and the others in it stay where they are. Their open tasks there (backlog, ready, blocked) go back on its board. What they had uncommitted in their worktree is committed first as work in progress, so it goes along. |
| **Back to where a copy came from** | The copy's branches go into the project it was copied from as `moved/<them>/<branch>` — nothing of the project is overwritten; merging them is a person's decision — and they work in that project again. The copy stays on the computer, with its open tasks. |
| **Their Claude conversation** | Every conversation of theirs in that folder (`~/.claude/projects/<folder>/<id>.jsonl`), and Claude Code's own memory of the folder (`memory/`), put where the new machine's Claude Code looks for them, with the old folder's path written as the new one. Their next session there continues the same conversation (`--resume`). An account folder of their own is not taken along: an account belongs to one machine, so they use that machine's default account. |

**The old folder stays where it was**, as a copy to fall back on (the owner's choice); nothing on the old machine is deleted. A Codex employee's folder moves; its thread does not (Codex keeps threads with the session on the old machine), so it starts a new one.

## How it is done

1. **Plan** (`POST /employees/:id/move/plan` `{ to }`): what would happen, or why it cannot be done. Nothing is changed. The profile shows it before anybody says yes.
2. **Start** (`POST /employees/:id/move` `{ to, parent }`): `parent` is the folder on the new machine to put theirs in (a new folder of the same name is made inside it, `name-2` if taken). The move then goes on by itself; `Employee.moving` says how far (`packing` → `sending` → `unpacking`, bytes sent of all).
3. If their session runs (between turns), it is stopped first, and started again on the new machine when the move is done — the same conversation.
4. **Pack** on the old machine (`move.pack`): `folder.tgz` (the folder, listed entry by entry so that what is left out stays out) or `repo.bundle`, and `claude.tgz`, each with its SHA-256, in `<agent home>/moves/<id>/`.
5. **Send**: the office reads a piece of 2 MiB from the old machine and writes it to the new one, until all is there. Nothing is kept on the server; both machines must be connected the whole time.
6. **Unpack** on the new machine (`move.unpack` or `move.fetchBack`): every file checked against its SHA-256; the folder made (a bundle becomes a repository with every branch and no remote); the conversation placed. A failure removes the half-made folder.
7. **The records move**: the employee onto the new machine (its desk or a seat in the member's room, as for any change of machine), their project or its copy, and a record of their last session with the same conversation id on the new machine — which is what makes their next start continue it. The move's files are removed on both machines.
8. A move that fails leaves the employee where they were, with everything, and says why (`moving.error`, a notification); *Try again* or *Dismiss* in the profile.

While a move is under way nothing is started for them and no task is handed to them.

## Who may, and what is refused

- **Who**: whoever may work with the employee *and* on the machine they go to (`access.ts`: `POST /employees/:id/move`, `work` on both). A colleague can take a shared employee onto their own computer, or bring their own to the office; an owner can move anyone, except into or out of a closed room.
- **Refused**: the foreman, a team lead, a desk somebody sits at with their own Claude Code, a rented employee; someone working on a task (in progress or in review: that work is in a worktree of the old machine — let it finish or stop it); someone in the middle of a turn; when either machine is not connected, or runs an agent too old to move (`HostInfo.moves`); a folder that is a whole allowed root or the home folder (give them a folder of their own first), or holds the office's own files.
- **Privacy changes with the machine**: moved onto a member's computer they are that member's (their room, their privacy); moved to the office's machine, what they did and do is seen by everybody who works here. The office's long memory (MemPalace) keeps what was filed while they were shared, and files nothing of a personal employee — as for any personal employee.

## In the office

While the move is under way the employee sits at their desk packing: an open cardboard box beside them fills up, and **📦 n %** stands over their head — 0 while the desk is packed (how long that takes is not known before), then what has been sent, 99 while it is unpacked. When it is done the badge turns green at **100 %**, the box is closed, and they get up and carry it in both hands to their new desk (through the door into the member's room), sit down, and the box is put away. A move between two machines of the office that keeps the same desk shows the 100 % for a moment. (`People.tsx` `MoveBox`, `Character` `carrying` → `carryBox` in `character/motion.ts`; `PersonView.moving`.) In the profile, *Session → Machine* shows the same as a line and a bar (`move-employee.tsx`, `lib/move.ts`).

## Where the code is

- `packages/orchestration/src/move.ts` — `Moves`: the plan, the run, moving the records.
- `apps/host-agent/src/move.ts` — the machine's half: pack, pieces, unpack, fetch back, drop; `HostAgent.movable` and `claudeBase` (what may be moved, where conversations are).
- `packages/contracts/src/protocol.ts` — the `move.*` RPCs; `entities.ts` — `EmployeeMoving`, `Project.copiedFrom`, `HostInfo.moves`.
- `apps/desktop/src/hud/panels/move-employee.tsx` — the profile's *Machine* part; `lib/move.ts` — the percent and the line.

## Tests

- `apps/host-agent/test/move.test.ts` — a folder whole without what is made again (and with a `build/` git tracks), links, git history, the conversation and its memory with the paths rewritten, nobody else's conversation; a project as a bundle with every branch, the employee's checked out; back, their branches beside the project's untouched ones; refused pieces, damaged files.
- `tests/e2e/65-move-employee.test.ts` — two machines: their own folder and their next session continuing the conversation (`--resume` on the new machine); a copy from a shared project, open tasks back on its board, and back again; a running session going on there by itself; what is refused.
- `apps/desktop/test/move.test.ts` — the percent and the line.
- Seen in a development office with a member's room (2026-11-20): packing at 45 %, carrying the box across the floor, 100 %, sitting down in the room.

**Not verified**: a move to or from a real member's computer through the office's TLS door, and with a real Claude Code conversation (the tests use the fake one; Claude Code's folder naming — every character but letters and digits a dash, on the real path — was read off this machine's `~/.claude/projects`). A member's computer needs a desktop app with this agent to take part.
