# The public demo office (office-demo.sparkcan.com)

_Built on 2026-11-14 on the owner's request: "another subdomain, office-demo.sparkcan.com, in the README; that demo office open to everybody, everybody gets in at once as a visitor and watches how the agents work, simulated — the point is a showcase." The owner chose: visitors only watch (no chat, no voice), and the demo starts fresh every night._

A second, separate office on the same server, open to anybody on the internet. Whoever opens its address is inside at once — no knock, no invitation — as a **visitor who only watches**. Its employees are the **scripted stand-in** (`tests/fixtures/fake-claude.mjs`), not Claude Code: no Claude account is used and nothing is spent. Every page of it says so (the line across the top). Read this before touching `scripts/demo-office.ts`, `ServerOptions.showcase`, or the demo's service and site on the server.

## What a visitor gets

- **In at once.** The office's address answers `GET /knock` with `showcase: true`; the page (`ShowcaseEntry` in `apps/desktop/src/App.tsx`) knocks by itself as "Guest 1234", and the office lets every knock in immediately as a visitor for twelve hours (`POST /knock` in `apps/server/src/server.ts`) — the same visitor credential an owner hands out when they let a browser in.
- **Only watching.** A visitor sees what any visitor of any office sees (`docs/ACCESS.md`, "What a visitor is sent"): the floor, the people, the board, the terminals of shared employees. On top of that, in a showcase, **what a visitor says out loud and their voice are dropped by the office** (`ClientHub`, `case 'say'` and `case 'voice'`), and the page hides the chat box and the talk key (`watchOnly`). Visitors cannot give anybody work in any office; that matters doubly here, because the stand-in carries out what a message's `@@fake: …@@` says (`tests/e2e/58-showcase.test.ts` checks the refusal).
- **Told what it is.** A line across the top: "Live demo. The employees here are scripted stand-ins — no Claude is running, nothing is spent", with a link to the repository. It can be closed for the visit.
- **The city.** The demo stands over the Skyline; the terrace, the parachute and the city (`CITY.md`) are all there.

## What happens in it

`scripts/demo-office.ts` (bundled as `apps/server/dist/orchestrator-demo.mjs`; the stand-in travels with the package as `demo/fake-claude.mjs`):

1. **Fresh at every start.** It wipes its folder (`--home`, default `~/.orchestrator-demo`) and its own tmux server (`-L orch-demo`), then starts a real server (`showcase: true`, on 127.0.0.1) and a real host agent whose `claude` is the stand-in, with a made-up "Claude login" in a home folder of its own.
2. **The company**: *Orchestrator Demo* — two projects (*Storefront*, *Mobile API*, each a small git repository whose test fails while a file says `BROKEN`) and ten employees (architect, backend, frontend, QA, full-stack, security, DevOps, reviewer). Eight on Auto; two (David, Mike) on Standard, so their commands wait for an approval.
3. **The director**, every eight seconds: hands idle employees a task from a list for their role, a couple at a time — each a script of steps: reading, writing, `npm test`, committing, completing; about one in seven first asks the boss a question, one in ten fails its check and is fixed on the retry (`@@fake-retry`), one in twenty is blocked. It **answers** questions and approves requests 20–40 s after they appear, as an owner would, **unblocks** after about a minute, gives everybody a short rest between tasks, and **starts again** a session that never got going (the stand-in starts in no time, and its first hook can arrive before its machine knows the session; seen in the first try).
4. **Every night at 04:00 UTC** it stops; systemd starts it again, fresh.

Measured on the development machine (2026-11-14): 20 tasks done in the first four minutes, questions answered, no session left stuck.

## On the server

| | |
| --- | --- |
| Service | `systemctl --user … orchestrator-demo` (`~/.config/systemd/user/orchestrator-demo.service`), `Restart=always` |
| Program | the office's own package, `~/orchestrator-office/app/apps/server/dist/orchestrator-demo.mjs` — the same folder as the real office; **`pnpm deploy:server` restarts the demo too** (fresh) |
| Folder | `~/.orchestrator-demo` — wiped at every start; nothing in it is kept |
| Ports | the demo office 127.0.0.1:4620; its door (TLS) 4621 — **not open in ufw**: only nginx on the same machine reaches it |
| Address | `office-demo.sparkcan.com` → Cloudflare DNS record (`office-demo`, A, `<server-public-ip>`, DNS only) → nginx (CloudPanel site `office-demo.sparkcan.com`, reverse proxy to `https://127.0.0.1:4621`) → the demo's door. Let's Encrypt certificate by CloudPanel |

The demo has nothing to do with the real office: its own server, database, owner token, host agent, tmux server and folder. Its owner token never leaves the server, and through the door it is refused as everywhere (`SECURITY.md`).

## Running it elsewhere

```sh
node scripts/demo-office.ts --home /tmp/orch-demo --port 4720 --door 4721   # from a checkout
node apps/server/dist/orchestrator-demo.mjs --home ~/.orchestrator-demo --address https://office-demo.example.com   # from the package
```

On macOS keep `--home` short: the host agent's socket lives in it, and a socket's path may be at most about 104 bytes. Open the door's address (`https://127.0.0.1:4721`, a certificate made on the machine) to walk in as a visitor.

## Limits, plainly

- **Visitors see each other** walking about, as in any office; they cannot talk.
- **The knock limits stay**: six visits in ten minutes from one address (a reload with the visit still valid does not knock again).
- **The stand-in is not Claude.** Its terminals show "FAKE CLAUDE — test fixture"; its work is the director's script. The office around it — sessions, hooks, worktrees, verification, merges, questions, approvals — is the real one.
- **Not seen yet**: many visitors at once.
