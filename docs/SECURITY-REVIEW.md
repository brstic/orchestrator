# Security review

A record of what was reviewed, how, what was found and what remains. It complements `SECURITY.md` (the model) — this file is about checking the implementation against it. Last pass: 2026-11-10.

## Scope and method

Reviewed by reading the code paths below and exercising them in tests (the test that covers each point is named). Not reviewed: third-party dependencies beyond their use here, Claude Code itself, tmux, OpenSSH.

| Area | Code | Checked by |
| --- | --- | --- |
| Owner authentication, wrong-token attempts | `apps/server/src/server.ts` | e2e `11` "security issues reach the owner" |
| Host enrolment, revocation, refused credentials | `packages/orchestration/src/registry.ts`, `apps/server/src/hubs.ts` | e2e `01`, `07`, `11`; `tests/linux/ssh-link.ts` (old credential refused) |
| Terminal input ownership | `packages/terminal`, `comms.ts` | e2e `01`, `04`; UI test (take / return control) |
| Approvals and high-risk commands, auto mode | `hook-receiver.ts`, `prompts.ts`, agent `localPolicy` | e2e `02`, `10`, `11`; `tests/real/approvals.ts`, `auto.ts` |
| Filesystem reads (documents, folder browsing) | `packages/execution/src/files.ts`, agent `assertAllowed` | e2e `10` (path escape, symlink, non-Markdown refused) |
| Git operations (merge, promote) | `packages/execution/src/git.ts` | e2e `03`, `11` (dirty tree, non-fast-forward, failing tests refused) |
| SSH links | `apps/server/src/ssh-links.ts` | `tests/linux/ssh-link.ts`; UI test (invalid target, refused connection) |
| Radio | `apps/server/src/radio.ts`, page CSP | e2e `10` (only http(s) stations, size and length limits, saved stations only), e2e `22` (office-wide: only saved stations are played, visitors cannot switch) |
| Secrets in records | `packages/contracts/src/util.ts` | e2e `11` (key never stored), unit tests |
| Desktop connect screen, token storage | `apps/desktop/electron` | `scripts/smoke-package.mjs` |

## Findings and what was done

1. **Radio streams were blocked, and the obvious fix would have opened the page to any network call.** The page policy had no `media-src`, so audio could not play. Fixed by allowing media only (`media-src 'self' https: http: blob:`); "what is on air" is fetched by the server for saved stations, with a 5 s limit, a 512 KB limit and a 200-character result. `connect-src` was not widened.
2. **A linked server could have named another machine as its own.** The link learned its host id from the server's output; a hostile server that knew another host's id could have pointed its link at it and had it revoked when the link was removed. Fixed: the id is accepted only if it is the link's existing machine, or one enrolled during this very attempt with the token issued for it.
3. **Enrolment token on a command line.** `orchestrator-agent login --token …` is visible in the server's process list for a moment. For SSH links the token is now passed in the environment (`ORCH_ENROLLMENT_TOKEN`), set inside a script sent on standard input; it is single-use and expires after ten minutes.
4. **What the owner types as an SSH target.** Validated against a strict pattern (`[user@]host[:port]`), never starts with `-`, and is passed to `ssh` as an argument without a shell. Covered by a test that tries an option-injection string and a shell-metacharacter string.
5. **Unknown SSH host keys.** Never accepted silently: the first connection is refused with an explanation unless the owner ticks "I trust this server", which uses `accept-new` (the key is pinned; a changed key is refused).
6. **Employee tool rules widened without a trace.** `allowedTools` / `disallowedTools` are now sanitised (short single-line strings, at most 100) and written to the audit log in full when they change.
7. **A stuck connection held the agent offline.** A connection that was accepted but never answered (a dead tunnel) was only abandoned after a minute, and the watchdog then never reconnected. Fixed with an 8-second handshake limit and an explicit drop-and-retry. Availability, not confidentiality.
8. **Nothing told the owner about refused actions, credentials in sessions, refused machines or token guessing.** Added `security` notifications for each (one per kind of incident per ten minutes).

## Residual risks (accepted, documented in `SECURITY.md`)

- An SSH link puts the office's port on the server's loopback: every local user of that server can reach it. They need a credential for anything, but a shared server widens who can try. Use a dedicated account there.
- Anyone who can act as you on this computer can read the owner token file and control the office, including typing into every terminal. The office is not a boundary against your own account.
- Employees on `auto` rely on Claude Code's own auto-mode safety check plus the high-risk patterns; with *Ask before high-risk commands* switched off, only Claude Code's check remains. Switching it off is audited.
- Detection of secrets is by known formats; an unusual credential format is not recognised (it may still be hidden by the broader redaction of `KEY=value` assignments, which is deliberately over-eager).
- The macOS app is ad-hoc signed, not notarised (no Developer ID on the build machine); Windows bundles are built but have never been run.
- No independent penetration test was done; this is a review by the implementer.
