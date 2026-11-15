# Documentation map

| File | What it is | Update when |
| --- | --- | --- |
| [HANDOVER.md](HANDOVER.md) | For whoever continues the work: what you need, how a change gets from your editor to the running office (test, commit, push, deploy), what must not be touched | The way of working or of deploying changes |
| [STATUS.md](STATUS.md) | Where the project is right now: shipped, in progress, known problems, next steps | Every piece of work |
| [CHANGELOG.md](CHANGELOG.md) | What changed, newest first | Every shipped change |
| [plans/](plans/) | One file per plan. The active one has checkboxes | A plan item starts or finishes |
| [DECISIONS.md](DECISIONS.md) | Decision log: what was chosen, why, what was rejected | A decision is made |
| [OPERATIONS.md](OPERATIONS.md) | Where the server and the clients are, how each is updated, backup, day-to-day commands, troubleshooting | Anything about deployment changes |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Build, test, ship; tools for measuring; rules | The workflow changes |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Processes, packages, protocols, data | Structure changes |
| [ACCESS.md](ACCESS.md) | Members, roles, shared vs personal: who may do what | A permission changes |
| [MEMORY.md](MEMORY.md) | The long memory (MemPalace): what is remembered, how employees ask it, how the program is run, installed, tested and extended | Anything about the memory changes |
| [ACCOUNTS.md](ACCOUNTS.md) | Several Claude accounts on one machine: adding one and signing in to it from the office, an account of another service (Z.AI), how accounts are named, when an account counts as used up, how employees are moved, what is not verified | Anything about accounts or limits changes |
| [ATTACHMENTS.md](ATTACHMENTS.md) | Files on tasks (for the employee, and evidence from them), how an employee sees a picture, the employees' browser and how to install it on a machine | Anything about files, screenshots or the browser changes |
| [SIGN-IN.md](SIGN-IN.md) | Signing in at the office's address with a name and a password: who gives passwords, what a session is, what ends it, the limits on guessing, where the code and the tests are | Anything about sign-in, sessions or the door's `/login` changes |
| [ENTRANCE-PAGE.md](ENTRANCE-PAGE.md) | The page a browser gets at the office's address before anybody is signed in: what is on it, how the scroll drives the little office drawn on it, how the door (sign in, knock) comes along, where its pictures come from and how to take them again, what was and was not checked | Anything about that page, its pictures, or the forms at the door changes |
| [TASKS.md](TASKS.md) | Tickets: who reviews what and when, the conversation on a ticket (comments, tags, asking instead of blocking), sending a ticket back, several employees on one ticket, and the Tickets window | Anything about tasks, review, comments or the Tickets window changes |
| [SURROUNDINGS.md](SURROUNDINGS.md) | Where the office stands — by itself, a tower over a city, a park, an island, a valley under the northern lights, orbit: whose the choice is and where it is kept, how a place is built, the windows in the outer walls, the rules against shimmer, adding a place, looking at one, what it costs | Anything about what is drawn around the building changes |
| [CITY.md](CITY.md) | Out in the city under the Skyline: jumping out of a window, the parachute, walking, taking a car out of the traffic and driving, Back to Office; the endless city made block by block, traffic and walkers laid round the camera; what reaches nobody else | Anything about going out of the office, the city's blocks, the traffic or the walkers changes |
| [DEMO.md](DEMO.md) | The public demo office (office-demo.sparkcan.com): open to anybody as a visitor who only watches, scripted employees and the director that keeps them busy, fresh every night; its service and site on the server | Anything about the demo, `showcase`, or `scripts/demo-office.ts` changes |
| [TELEGRAM.md](TELEGRAM.md) | An employee's own Telegram bot: setting it up (BotFather, token, one-time link), private chats and groups (when they speak up there, privacy mode), questions and permissions with buttons, how the token is kept, where the code and the tests are, what is not verified | Anything about the Telegram bots changes |
| [HELD-REQUESTS.md](HELD-REQUESTS.md) | How a permission request, a question or a high-risk command waits for the owner — the hook command, the agent, the office — and what survives a restart of each | Anything about hooks, held requests, or what a deploy interrupts changes |
| [TEAM-LEAD.md](TEAM-LEAD.md) | A member's team lead: the employee a member tells what they want, who hands it to the right one of their employees and may hire (five at most); what it costs, what the office enforces, where the code is, what is not verified | Anything about leads changes |
| [ARCADE.md](ARCADE.md) | The arcade cabinet: a Mega Drive for cartridge files the members bring, kept on the office's shelf; playing together from two computers (one console, shown to the other player through the office); the sandboxed frame the emulator runs in, the core and its licence | Anything about the arcade, its shelf, its tables, its frame or how `assets/arcade.html` is served changes |
| [UI.md](UI.md) | The look of the windows: the rules (one line says enough, each thing once, a colour means "look here", one main button, nothing moves by itself), the kit they are built from, how a window is moved to it, which windows have been (Machines so far) and what each shows now | A window is moved to the look, or the kit or its rules change |
| [VAULT.md](VAULT.md) | The vault: how credentials get in and out, what is recognised, where the code is, its limits | Anything about the vault changes |
| [SECURITY.md](SECURITY.md) | Threat model and what protects what | Anything security-relevant changes |
| [SECURITY-REVIEW.md](SECURITY-REVIEW.md) | Review against the original brief's security section | A review is repeated |
| [INSTALL.md](INSTALL.md) | Installing and running: local office, central server, clients | Setup steps change |
| [CLAUDE-CODE-INTEGRATION.md](CLAUDE-CODE-INTEGRATION.md) | How workers are launched, hooks, MCP tools, usage, foreman | The integration changes |

Plans: [plans/UPDATE-central-office.md](plans/UPDATE-central-office.md) (active) · [plans/2026-original-brief.md](plans/2026-original-brief.md) (done; what is left is listed there).

Ideas, not yet plans: [plans/IDEAS-leaner-teamwork.md](plans/IDEAS-leaner-teamwork.md) (what a wide reading of how others run coding agents says about fewer rounds and less usage; three things are built, seven are ideas with what to measure) · [plans/IDEAS-from-ahoy.md](plans/IDEAS-from-ahoy.md) (what to bring over from the owner's Ahoy project; three of them are built) · [plans/IDEAS-from-t3code.md](plans/IDEAS-from-t3code.md) (installation, updates, accounts, process) · [plans/IDEAS-memory-from-mempalace.md](plans/IDEAS-memory-from-mempalace.md) (a better memory).
