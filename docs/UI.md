# The look of the windows

_Started 2026-11-12, with the owner's "a complete overhaul of the UI: elegant, modern, clear, without piles of unnecessary information — start with the Machines window". The windows are moved to this look **one at a time**; this page is the rule they are moved by, and the list of which have been._

## The rules

1. **One line says enough.** A thing in a list (a machine, a person, a task) is one line: its name, one phrase about what it is and how it is, and the one or two numbers worth a glance. Everything else opens on a click on that line.
2. **Each thing is said once.** Not a green dot *and* an "online" badge; not "CPU 30%" in the header *and* a CPU bar below; not a machine called "Mila's computer" with "Mila's computer" under it.
3. **One list, not boxes in boxes.** Rows share one frame with a hairline between them. A card is not put inside a card.
4. **A colour means "look here".** The normal state has none: an online machine is a small lit dot, a measurement is the accent colour. Orange and red appear only when something is close to a limit or wrong. Badges are for exceptions, not for labels.
5. **One main button per window.** The blue button is what the window is most often opened for besides looking (Machines: *Add a machine*). Everything else is a quiet button; what destroys something comes last in the row and asks first.
6. **Rare things are folded, and say what is inside.** "Options", "3 already in the office", "1 revoked machine" — a line that opens. A folded part that holds something that matters *now* (an address that will not work) starts open.
7. **Nothing moves by itself.** A window hangs from the top of the screen and grows downward, so opening a row does not move what is above it; the scrollbar's room is kept from the start; nothing slides or fades in. (The owner's standing preference: calm, nothing popping in or out.)
8. **Numbers are numbers, text is text.** Measurements use tabular figures of the ordinary font; the monospaced font is for what is typed or copied (addresses, paths, commands, versions).
9. **Words a person uses.** "macOS · arm64 · 10 cores · 16 GB", not `darwin / arm64 · 10 CPUs`; "running for 2 d 6 h", not `02-06:51:58`. How a number was obtained (measured on the machine, when) is in the tooltip, not printed beside every number.

What must **not** be lost when a window is moved: anything a person could do there before (a control may move or be folded, not disappear), what each role may see and do, and the warnings that keep somebody from a mistake (a destructive action still says what it does before it does it).

## The kit

`apps/desktop/src/hud/panels/kit.css` (class names start with `k-`; loaded with the other panel styles in `all.ts`) and `kit.tsx`.

| Piece | What it is |
| --- | --- |
| `<Window kit>` (`packages/ui`) | The window in this look: `win-kit`. Larger title, 24 px of air, hangs from the top (`.win-backdrop:has(> .win-kit)`), `scrollbar-gutter: stable`. A window without `kit` looks as it did |
| `.k-stack` | The window's parts top to bottom, 20 px apart |
| `.k-group` › `.k-row` | The list: one frame, hairlines between rows. `.k-row-click` for a row that opens (give it `role="button"`, `tabIndex`, `aria-expanded`), `.k-row-sm` for a list inside something already open, `.k-main` for the name and the phrase under it |
| `.k-title`, `.k-sub`, `.k-text`, `.k-label` | A name; the phrase under it; a sentence of explanation (at most 68 characters wide); a small capital label over a section |
| `button.k-row` | A row that is only a way to somewhere (a task, a project): the whole row is the button |
| `.k-head` › `.k-link` | A section's label with, at its right, the quiet way to the whole of what the section shows a part of ("The board") |
| `.k-cols` | Two lists side by side; one under the other where there is no room |
| `.k-key`, `.k-aside`, `.k-title-note`, `.k-title-sm` | What the office calls a thing (`T-12`) before its name; a quiet phrase at the end of a row; something more about a thing on its name's own line; a smaller name for a row in a list of many |
| `.k-line` | The line under a name when it begins with how the thing is: a `<State>`, then a phrase |
| `.k-row-head` | The row that names what the rows under it belong to (a project over its tasks) |
| `.k-nobody`, `.k-chip-dot` | A dashed ring where a face would be, when there is nobody; a chip with a dot instead of a face |
| `<State>` (`.k-state`) | How somebody or something is: a dot and a word, or the word alone at the end of a row; coloured only when somebody is wanted |
| `.k-dot` (`-off`, `-busy`, `-bad`) | How it is, as a dot: lit, a ring when away, orange while something is in progress, red when it failed |
| `.k-chev` | The mark at the end of a row that opens; turns with `aria-expanded` on the row |
| `.k-detail` › `.k-section` | What a row opens to, indented under the name |
| `<Meter>` | A measurement: name, number, a thin bar; coloured only for `warn` / `bad` |
| `<Faces>` | Who is there, as overlapping faces and "+N" |
| `.k-chips` › `.k-chip` | People by name, each a button |
| `.k-spec` | Facts: a small name over each value, three or four to a row |
| `.k-actions`, `.k-quiet` | A row of buttons; the quiet ones are grey until pointed at |
| `.k-sheet`, `.k-options` › `.k-option`, `.k-form` | What the main button opens, inside the window: first a choice between ways (each a title and a line), then that way's few fields |
| `.k-code` | Something to copy and run, with its Copy button in the corner |
| `<More>` | A line that opens (`<details>`), remembering how it was left |
| `.k-note`, `.k-notice`, `.k-warn`, `.k-bad` | A warning in a sentence; a list that wants a decision; text in the warning and the error colour |
| `.k-empty` | Nothing here yet: a title, a sentence, the main button |

Colours, fonts and the old classes (`.btn`, `.badge`, `.field`, `.avatar`) are the app's own (`styles.css`); the kit adds nothing of its own to them. Note the cascade: the panel stylesheets come *before* `styles.css`, so a kit rule that ties with an element rule there (an `input`'s width) loses — give the element the style directly.

## Moving a window

1. Look at it as it is, **with a real amount of content** — eight people, a dozen tasks, not three and two (My work was first moved while looking at three employees, and came back as "too tall, unorganised") — with real content (`node scripts/dev-office.ts --port <free> --member-room "Mila:2" --visitor "Nikola"` prints an address for the owner, the member and the visitor) and write down what a person comes to this window *for*. That is the line and the main button.
2. **Decide the arrangement before the rows.** What does a person look at together here? Two things looked at together stand side by side; a window is wide before it is long. Restyling the rows of a long page gives a long page.
3. Everything else: is it said twice (drop one), is it rarely needed (fold it), is it only for when something is wrong (show it only then)?
4. Words and numbers that are worked out go into `apps/desktop/src/lib/` as plain functions with a unit test (`lib/machines.ts`, `lib/my-work.ts` and their tests); the component only arranges.
5. `<Window kit>`, build from the kit, add to the kit only what a second window will also need.
6. Look at it as owner, colleague and visitor, with the list empty, with one thing, with something wrong.
7. The UI suite's steps for that window follow the new controls, and one step says what the window no longer prints until asked (`tests/ui/driver.cjs`, "Machines: one line per machine…"). A window that only a member has is opened in a second window as the suite's member ("My work (a member's own window)…": the office of the suite has one, Mila, with three employees).
8. Tick it below.

## Which windows have been moved

| Window | Moved | Notes |
| --- | --- | --- |
| Machines | 2026-11-12 | The first; see below |
| My work | 2026-11-13 | See below |
| every other | — | As they were |

## Machines

`hud/panels/hosts.tsx`, `ssh-links.tsx` (the SSH form, the links, Claude Code outside tmux), `lib/machines.ts`.

**The line:** a dot, the name, a phrase — whose machine it is and how it came in ("The office's own machine", "Mila's computer", "Over SSH · deploy@box", "Joined with a token"), why it is not there if it is not ("offline, last seen 2h ago", "has never connected", "connecting — copying the agent"), and how many work on it — then their faces, CPU and memory. A machine without Claude Code or tmux says so on its line, in orange, since nothing can run there. With several machines all start folded; the only machine of an office starts open.

**A click opens:** who works there by name (a click opens that employee), what the machine is (system, address, Claude Code, tmux, agent, SDK-managed workers, the employees' browser, sessions, when it was added), and what can be done: *Bring in what is running there…* (whoever may work on the machine, while it is online), and for an owner *Rename*, *Revoke…*, *Remove…* (a machine that is away), or for a server linked over SSH *Disconnect* and *Remove the link…*. A linked server that is disconnected or failed has *Reconnect* / *Try again* on its line.

**Add a machine** (owners; the one main button) opens a sheet in the window: *A server over SSH* or *Any machine, with a token*. The token's three options (the office's address as that machine sees it, how long the token is valid, a label for the audit log) are folded under *Options* — and start open when the address is a loopback one or plain http, with the sentence that says why that will not do. The token is no longer shown in a box of its own beside the command: it is in the command, which is what is copied.

**Bring in what is running there** lists what can still be done something with — a tmux session the office does not have, or one it only watches (*Make a full employee*). The sessions the office started itself are one folded line ("8 already in the office"). Claude Code found outside tmux follows, when there is any.

**Above the list, only when there are any:** sessions without an employee (choose one, *Bind*). **Below it:** revoked machines, as one folded line.

**What is no longer printed for every machine:** the "online" badge (the dot), the load average, "Tracked sessions" (the same number as the sessions), the "measured" badge and "on the machine, just now" (the tooltip of the two measurements), "Worker runtimes: interactive CLI" (every machine has it), "Last seen: connected · just now", the pane number, size and command of every tmux pane (tooltip; the pane number is shown when a session has several), the terminal and process number of a Claude Code outside tmux (tooltip), the five capability badges of a session without an employee (they are in that session's own view once it has one), and the two cards "Servers over SSH" and "Any other machine" that stood under the list whether or not anybody was adding a machine. Memory turns orange at 90% and red at 96% (it was 80% and 92%): a healthy machine keeps most of its memory in use, and a colour that is always on says nothing.

**Roles.** A visitor has no Machines window. A colleague sees the list and the details (for a machine they may not look into, the office sends no details and the line shows none), may bring in what runs on a machine they may work on, and has no *Add a machine*, *Rename*, *Revoke…* or *Remove…* — those calls were always the owner's on the server; the window used to offer them to everybody and answer with an error.

**Checked:** unit `apps/desktop/test/machines.test.ts`; the UI suite's five "Machines:" steps (the list and what is not on it, the token, rename and remove, attach, the SSH check); looked at as owner and as colleague in a development office with an online, an offline and a revoked machine. **Not looked at:** a real server linked over SSH in its states (connecting, failed, disconnected) — there is none in a development office, so those lines were only read in the code; the window in a plain browser tab at a narrow width (under 820 px the two measurements are hidden); a machine without Claude Code.

## My work

`hud/panels/mine.tsx`, `lib/my-work.ts` (the words, the order, the grouping), `lib/mine.ts` (whose a thing is — unchanged). A member's own part of the office; the office's first owner, who has no computer of their own in it, has no such window.

The first version of this window in the new look (five lists one under the other, three buttons on every employee) was sent back by the owner the same night: "still ugly, still crowded, too tall, unorganised". What stands now:

**The window's line:** "8 employees, 7 working · 10 open tasks", and "· 1 waiting for you" when something does. **The one main button** is *Hire*; *My room* is beside it, quiet.

**Across the top, only when something waits:** a question or a request for approval from one of mine, or something stuck around them or my machines — the face of who asks, what they ask for, how long ago; a click opens it. With nothing waiting there is nothing there.

**Two columns, side by side** — the window is wide, not long:
- **People** (left). The team lead first, called that beside its name; then the employees in the order one wants to hear of them: whoever is blocked or wants somebody, whoever is at work, whoever sleeps. A line is a face, a name, and under it **how they are and on what** ("● thinking · T-9 Notes, part 1"); at its end *Talk*, quiet. **A click on the line opens it** — one at a time — to what they are (title · project · machine, for somebody with several · model) and *Talk*, *Terminal*, *Profile*; for a shared employee one looks after, *Not mine*; for the lead, what a lead does and *Also direct the office's shared employees*. Without a lead, *Hire a team lead* stands quietly beside the heading and opens, in place, what a lead is, a name for it and *Hire onto <machine>*. Under the list, my machines as small chips with a dot (a click: My room).
- **Open tasks** (right), **by project**: each of my projects is a small list headed by its name and "3 of 8 done" (a click opens the project), then the open tasks in it — key, title, and the face of whoever is on it. A task in progress says nothing more; one that stands otherwise says how ("ready", "backlog", and coloured, "in review", "blocked"); a task nobody has shows a dashed ring. Projects of others with a task of mine follow, marked whose they are. Twelve tasks in all; the rest is one line, "…and N more on the board". *The board* at the right of the heading opens Tasks.

**What is no longer printed:** "Nothing of yours is waiting…"; the paragraph about what a lead is, for everybody who has none; an upper-case state badge on every employee and a status badge on every task; the title, the project and the machine on every employee's line (behind the click); three buttons on every employee (one, quiet; the rest behind the click); separate lists of projects and of machines (the projects head their tasks, the machines are chips). Nothing that could be done was removed.

**Roles.** Only somebody with a place of their own in the office has the window (a colleague or an owner who joined as a member); a visitor and the office's first owner do not — unchanged.

**Checked:** unit `apps/desktop/test/my-work.test.ts` (the words, who is listed first, the grouping and its limit); the UI suite's step "My work (a member's own window)…", in a second window as the member: the line, the one main button, two columns side by side and a window under 620 px tall for three people, one word and one button per person, a line opening and closing (one at a time), tasks under their project with a face and no word, nothing about waiting while nothing waits, a lead hired in place, listed first, widened and narrowed, a question appearing across the top with its asker first among the people, *Talk*. Looked at in a development office as a member with eight people, ten tasks in two projects, a shared employee and a question waiting. **Not looked at:** a member with several machines or a server, more than twelve open tasks, somebody with nothing of their own yet, anything stuck (a blocked task, a dropped machine) across the top.
