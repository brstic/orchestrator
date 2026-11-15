# The public demo office (office-demo.sparkcan.com)

_Built on 2026-11-14 on the owner's request: "another subdomain, office-demo.sparkcan.com, in the README; that demo office open to everybody, everybody gets in at once as a visitor and watches how the agents work, simulated — the point is a showcase." The same evening the owner widened it: "lots is missing that would really show how good this is… no F to talk, no machines, no my company — it must have everything, all the features… and make the rooms of colleagues who came in, as before", and "add chat too". It starts fresh every night._

A second, separate office on the same server, open to anybody on the internet. Whoever opens its address walks in at once — no knock, no invitation, no account — **as an owner of the office, to try everything**: talk to anybody (`F`), hand out tasks, answer the hands that go up, approve, hold meetings, set goals and routines, hire, open every window (Machines, Company, the board, the Command center), chat with the other people walking about. Its employees are the **scripted stand-in** (`tests/fixtures/fake-claude.mjs`), not Claude Code: no Claude account is used and nothing is spent. Every page says so. Read this before touching `scripts/demo-office.ts`, `ServerOptions.showcase`, `SHOWCASE_WORK`, the stand-in's key, or the demo's service and site on the server.

## What somebody who walks in gets

- **The same front page, an open door.** The address shows the office's entrance page (`ENTRANCE-PAGE.md`) — the same page as any office's door — but its door says *Live demo* and has one way in: **Walk in** (a name if one likes; otherwise "Guest 1234"). `GET /knock` answers `showcase: true`; `Door` draws `DemoDoor`, whose button knocks (`useWalkIn` in `Knock.tsx`), and the office lets every knock in at once **as an owner for twelve hours** (`POST /knock` in `apps/server/src/server.ts`).
- **Everything to try — and nothing to spoil.** Through the door, a showcase accepts only the **work of the office** (`SHOWCASE_WORK` in `server.ts`): talking to employees, starting, pausing and stopping them, tasks and comments and reviews, answering questions and requests, meetings, goals, routines, notifications, the hi-fi, pausing a project, previewing a command — and **hiring, up to 30 people**; at most 80 open tasks (`SHOWCASE_LIMITS`). Everything else is refused with "Not in the demo office: this would change it for everybody else": settings, access and invitations, the vault, Claude accounts, machines, SSH links, the floor plan, uploads (files, cartridges), radio stations, running a command, and **every delete**. The director works on the office's own address (127.0.0.1), not through the door, and is not limited.
- **Chat, not voice.** People chat as in any office (Enter); the office passes no voice on in a showcase (`ClientHub`, `case 'voice'`), and the page's talk key does nothing there (`voiceOff`).
- **Employees who never run anybody's words.** The stand-in carries out scripts written into what it is told (`@@fake: …@@`) — real commands, real files. In the demo it is started with a key of that start's own (`ORCH_FAKE_KEY`, written into its launcher, `demo-office.ts`) and then carries out **only scripts signed with it** (`@@fake#<key>: …@@`): the director's. A message, a task, a comment or keys typed into its terminal by anybody else get the demo's harmless stand-in work instead (`demoBehaviour` in `fake-claude.mjs`): to a message, a short reply that says what this is; to a task, reading the readme, writing a note named after the task, running the project's tests, committing, completing. `tests/e2e/58-showcase.test.ts` sends a message carrying `@@fake: bash touch …@@` and checks that nothing was touched and the reply came — and that a signed task is done.
- **Told what it is.** A line across the top: "Live demo — try everything", how (`F` to talk…), that the employees are scripted stand-ins and that what would spoil it for others is switched off; a link to the repository.
- **The city.** The demo stands over the Skyline; the terrace, the parachute and the city (`CITY.md`) are all there.

## What happens in it

`scripts/demo-office.ts` (bundled as `apps/server/dist/orchestrator-demo.mjs`; the stand-in travels with the package as `demo/fake-claude.mjs`):

1. **Fresh at every start.** It wipes its folder (`--home`, default `~/.orchestrator-demo`) and its own tmux server (`-L orch-demo`), then starts a real server (`showcase: true`, on 127.0.0.1) and a real host agent whose `claude` is the stand-in, with a made-up "Claude login" in a home folder of its own.
2. **The company**: *Orchestrator Demo* — two projects (*Storefront*, *Mobile API*, each a small git repository whose test fails while a file says `BROKEN`) and ten employees (architect, backend, frontend, QA, full-stack, security, DevOps, reviewer). Eight on Auto; two (David, Mike) on Standard, so their commands wait for an approval. **Two colleagues came in with their own computers**: Mila (a colleague, three employees) and Vuk (an owner, two) — each a second host agent enrolled as that member's own computer, with a room on the floor and a side project of their own, as a member's desktop app makes it. They are kept busy like the rest.
3. **The director**, every eight seconds: hands idle employees a task from a list for their role, a couple at a time — each a script of steps: reading, writing, `npm test`, committing, completing; about one in seven first asks the boss a question, one in ten fails its check and is fixed on the retry (`@@fake-retry`), one in twenty is blocked. It **answers** questions and approves requests 20–40 s after they appear, as an owner would, **unblocks** after about a minute, gives everybody a short rest between tasks, and **starts again** a session that never got going (the stand-in starts in no time, and its first hook can arrive before its machine knows the session; seen in the first try).
4. **Every night at 04:00 UTC** it stops; systemd starts it again, fresh.

Measured on the development machine (2026-11-14): 20 tasks done in the first four minutes, questions answered, no session left stuck. On the server, the first minutes: tasks done, one blocked and one waiting for an answer, as scripted. Walked into from outside through `https://office-demo.sparkcan.com` (a visitor at once, the line across the top, no chat box).

## On the server

| | |
| --- | --- |
| Service | `systemctl --user … orchestrator-demo` (`~/.config/systemd/user/orchestrator-demo.service`), `Restart=always` |
| Program | the office's own package, `~/orchestrator-office/app/apps/server/dist/orchestrator-demo.mjs` — the same folder as the real office; **`pnpm deploy:server` restarts the demo too** (fresh) |
| Folder | `~/.orchestrator-demo` — wiped at every start; nothing in it is kept |
| Ports | the demo office 127.0.0.1:4620; its door (TLS) 4621 — **not open in ufw**: only nginx on the same machine reaches it |
| Address | `office-demo.sparkcan.com` → Cloudflare DNS record `office-demo`, **proxied** (orange cloud, like the `*-preview` sites; Cloudflare's SSL mode accepts the origin's certificate) → the server's nginx on 443 → `https://127.0.0.1:4621`, the demo's door |
| nginx | **written by hand, not a CloudPanel site** (this CloudPanel's `clpctl` has no command for sites): `/etc/nginx/sites-enabled/office-demo.sparkcan.com.conf`. No access log; errors in `/var/log/nginx/office-demo.error.log`. The visitor's own address reaches the office: nginx takes it from `CF-Connecting-IP` (`real_ip_header` in `/etc/nginx/nginx.conf`) and passes it in `X-Forwarded-For`, so the knock limits are per visitor, not per Cloudflare edge |
| Certificate | Let's Encrypt by **certbot** (`certbot certonly --webroot -w /var/www/office-demo-acme -d office-demo.sparkcan.com`, deploy hook `systemctl reload nginx`), renewed by `certbot.timer`. First issued 2026-11-14, valid to 2027-02-12 |
| Site user password (unused) | `(a file on the server, see the private notes)` — made for a CloudPanel site that could not be created; delete it if no CloudPanel site is ever made |

The demo has nothing to do with the real office: its own server, database, owner token, host agent, tmux server and folder. Its owner token never leaves the server, and through the door it is refused as everywhere (`SECURITY.md`).

## Running it elsewhere

```sh
node scripts/demo-office.ts --home /tmp/orch-demo --port 4720 --door 4721   # from a checkout
node apps/server/dist/orchestrator-demo.mjs --home ~/.orchestrator-demo --address https://office-demo.example.com   # from the package
```

On macOS keep `--home` short: the host agent's socket lives in it, and a socket's path may be at most about 104 bytes. Open the door's address (`https://127.0.0.1:4721`, a certificate made on the machine) to walk in as a visitor.

## Limits, plainly

- **Everybody who walked in is an owner**, and they see each other walk about and chat. What one does with the work — a task handed out, an employee paused, a goal — the others see until the night's fresh start.
- **The knock limits stay**: six visits in ten minutes from one address (a reload with the visit still valid does not knock again).
- **Things owners can open but not change** (Settings, Access, the vault, the floor plan) open, and say so when something is tried.
- **The stand-in is not Claude.** Its terminals show "FAKE CLAUDE — test fixture"; its work is the director's script. The office around it — sessions, hooks, worktrees, verification, merges, questions, approvals — is the real one.
- **Not seen yet**: many visitors at once.
