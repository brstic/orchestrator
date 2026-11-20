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
| `<Window kit lead={…}>` | A face (or a picture of the thing) before the window's name; the line under the name may be a `.k-line` |
| `<Window kit flush>` + `<Tabs>` + `.k-body` | A window with tabs: the tabs under the head, and a body that keeps one size whatever the tab holds (540 px, less on a low screen) |
| `.k-tools` › `.k-find`, `select` | Tools over a list: a box to find by, and what narrows the list |
| `.k-pick` (`-on`) › `.k-pick-words`, `.k-pick-text`, `.k-pick-more` | A choice among a few, one line each (a radio); the chosen one says the rest under its line |
| `<PickMany>` (`.k-many` › `.k-tag`, `.k-many-add`; the list is `.k-pop`) | **Several of many** (see below): what is chosen as small tags on one line, each with its ✕; *Add* opens a list of the rest, with a box to find by when there are more than seven |
| `<Toggles>` (`.k-many` › `.k-toggle`, `-on`) | A few things that are each on or off, all in sight: a row of small buttons, the ones that are on lit. For a short list that does not grow |
| `.k-swatch`, `.k-lead-key` (in a tag or a list) | A project's dot of colour; a task's key — what stands before a name |
| `.k-figures` › `.k-figure` | Figures: a number and what it counts, three to a row |
| `.k-x` | A small cross at the end of a row: put this away |
| `.k-split` › `.k-split-side` (`.k-split-tools`, `.k-split-list`), `.k-split-main` | A window that is a library: what there is on the left, one thing of it on the right; one size |
| `.k-filters` › `button` (`.k-filter-on`) | What narrows a list: a few words to choose among, each with how many there are |
| `.k-bar` (`-thin`) › `i.k-bar-done / -review / -doing / -blocked / -waiting`, `.k-legend` | How far something is: one bar in parts, and what the parts are |
| `.k-note`, `.k-notice`, `.k-warn`, `.k-bad` | A warning in a sentence; a list that wants a decision; text in the warning and the error colour |
| `.k-empty` | Nothing here yet: a title, a sentence, the main button |

**The cascade, once more, because it cost a bug:** a kit rule on `.win-kit` alone ties with the app's `.win` rule and loses (the app's stylesheet comes later). The frame's own rules are written `.win.win-kit`. The first night's builds had the window's height limit on `.win-kit`, so tall windows hung lower *and* kept the old limit, and left the screen at the bottom.

Colours, fonts and the old classes (`.btn`, `.badge`, `.field`, `.avatar`) are the app's own (`styles.css`); the kit adds nothing of its own to them. Note the cascade: the panel stylesheets come *before* `styles.css`, so a kit rule that ties with an element rule there (an `input`'s width) loses — give the element the style directly.

## Several of many

The owner, of *Also works on* in an employee's settings: "awfully made and takes too much space — think of something different, and wherever this pattern with many checkboxes repeats, solve it with something that takes little space."

The pattern was a row (or a scrolling box) of checkboxes, one for every thing there is: every other project, every employee, every task of the project. It grew with the office — nine projects were three lines of boxes, thirty employees a box of thirty rows — and what was chosen had to be found among what was not.

`<PickMany>` turns it round: **what is chosen is what is shown.** The chosen things stand as tags on one line (a face, a dot of colour or a key before the name; ✕ takes one off), and after them a dashed **+ Add…**. That opens a list of the rest right under the button — over it where there is no room under — with a box to find one by a word when the list is longer than seven; a click (or ↑ ↓ and Enter) adds it and the list stays open for the next; Escape, or a click anywhere else, puts it away without closing the window. With nothing chosen the line says so in words ("Only their own project", "Nobody yet"). It is one line whether there are three things to choose from or three hundred.

- The list is drawn on top of everything (`createPortal` to the page, `position: fixed`), because a window's scrolling body would cut it off; it carries `data-esc-first` **and** its own Escape listener stops every later one (`stopImmediatePropagation`), so Escape closes it and not the window — the mark alone is not enough: the window's listener is put on again whenever its `onClose` changes, so it can come after the list's, and by the time it runs the list is already off the page (found by the UI suite with a real key press; a key made in script does not show it). When what is under it scrolls it goes along with its button, and is put away when the button leaves the screen.
- It must not stand inside `<Field>`: that is a `<label>`, and a click on a label presses the first button in it — the ✕ of the first tag. Use `<div className="field">` with `.field-label` and `.field-hint`.
- A chosen thing that will not do what was meant says so on its tag (`warn`: an employee who is not started "would be absent" from a meeting — the tag is outlined in orange and the reason is its tooltip).
- For a short list that does not grow, where each thing is simply on or off, all of them stay in sight: `<Toggles>` (what stands in a member's room).

Where it is: an employee's **Also works on** (Settings), a project's **Builds on** (About), a meeting's **Participants**, a new task's **Depends on**; `<Toggles>` for **In the room** (My room). A single checkbox that switches one thing on (Settings, a task's "Start now") is not this pattern and stays a checkbox; so does the list of folders in *Add folders…*, where each row is a thing with its own details and the list *is* the window.

**Checked:** the UI suite — the meeting form (two participants added from the list, tags on one line of at most 40 px with nobody and with two, Escape closes the list and leaves the window and what was typed) and the profile's Settings (*Also works on* is one line with no checkbox; the list is on the screen and does not offer their own project; adding one names it in the save bar as "other projects", ✕ takes it off and the bar says nothing is changed).
**Not looked at:** the list with hundreds of things in it; a phone-width window.

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
| My work | 2026-11-13 | See below (done twice) |
| The menu | 2026-11-13 | See below |
| Inbox | 2026-11-13 | See below |
| Team | 2026-11-13 | See below |
| An employee's window (Profile) | 2026-11-13 | See below; every tab |
| Projects | 2026-11-13 | See below; every tab |
| Reports | 2026-11-13 | See below |
| Growth | 2026-11-13 | See below; every shelf (the table under "Is it working?" is still a table: it is one) |
| My room | 2026-11-13 | See below; every tab |
| Company | 2026-11-13 | Its frame, and the *Now* tab: what needs you as lines, and "Everyone" with a word and a dot instead of a badge (it stays a table: this is where everybody is compared). Projects, Claude, History and Record: the new frame, their insides as they were |
| Help | 2026-11-13 | The new frame, and a list of what each window is for |
| Talk (its message box and its head) | 2026-11-14 | See below. The conversation itself is as it was |
| Vault | 2026-11-18 | Its insides too: a library (`.k-split`) built as a vault — the boxes on shelves by what they open, the open box with its value behind a steel slot; `VAULT.md`, "The window" |
| Tasks, a task, New task, Meetings, Access, Settings, Map, Floor plan, Terminals, Hi-fi, TV, Arcade, a question, a desk | 2026-11-13 | **The new frame only** (the window's head, its air, hanging from the top): their insides are as they were. Tasks keeps the board the owner knows (`add-to-a-layout-do-not-replace-it`) |

## Talk

`hud/panels/talk.tsx`. The owner, 2026-11-14: "when I open a chat with an agent (F) I need a quick link to their profile up top; and the chat box down there — redesign it, everything is thrown together; make it like ChatGPT, icons on the left, the send icon on the right, that's it — clean it up".

- **The head:** the face and the name are one button to **their profile** (it says so when pointed at), and **Profile** stands among the head's buttons, before *Open terminal*.
- **The message box** is one rounded box, as in a chat: the words (one line that grows with what is written, up to about ten lines, then scrolls; *Message Ava…*), and under them, inside the box, **three icons at the left** — *Attach* (a paperclip), *Track as a task* (a clipboard), *Repeat* (two arrows) — and **one round button at the right**: Send (an arrow up). Enter sends, Shift+Enter is a new line, Ctrl+V pastes a screenshot, `/goal …` sets a goal: said when the box is pointed at, no longer printed under it.
- **A task, a routine:** the icon lights up and a small pill stands over the words — "Task after T-9 · verified when done", or "Repeat every [5] min" with its minutes — each with its ×. The send button then makes the task or the routine (it says so when pointed at). What a routine costs is said under the box while *Repeat* is on, as before. *Track as a task* is dimmed for somebody without a project, and while *Repeat* is on.
- **Pause** is no longer a button of its own: while they are at something and the box is empty, the send button is a **stop square** that pauses them (as a chat's stop button). With words in the box it sends; between turns, pausing is in their profile (*Session*).
- Files that go with the message wait at the top of the box, as before; a drop on the box adds them.

**What is no longer printed:** the "Track as a task — verified when done" checkbox and its sentence, "Repeat every [ ] minutes", *Attach…*, "Enter to send · Shift+Enter for a new line", *Pause Ava*, and the long placeholder. All of it is in an icon's tooltip, a pill, or the send button.

**Checked:** the UI suite's steps that talk (the first word to a new hire, a reply in Markdown, an answer after I walked away, a file from an employee, a routine — now made with the Repeat icon, its pill and minutes seen, and the box back to *Send* after). Looked at in the development office (`talk-repeat-on.png`, `routine.png`). **Not looked at:** the stop square while somebody works, by hand; a browser tab (the window is the same component); a member's own employee.

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

## The menu

`hud/menu.tsx` (the component and its small pictures), `lib/menu.ts` (what each window is for, and how one is found by a word). The button at the top left opens it.

Every window the person may open is there with **a picture, its name and one line that says what it is for** ("Vault — Passwords and keys employees may use"), so nobody has to open a window to learn what it is. The groups are the old ones (Mine, Work, People, Office, Break room) in **two columns**; Settings and Help stand across the bottom. A number beside a window is grey, and red only when it counts things that are stuck or wait for somebody.

The same names and lines are in **Help**, under *What each window is for* (each opens its window); what a window is called is said in one place, `LABEL` in `lib/menu.ts`.

**A box at the top has the keyboard** when the menu opens: a word of the window's name, of its line, or of what people call the thing ("password" → Vault and Access; "hire" → Team; "ssh" → Machines) narrows the list; ↑ ↓ move, Enter opens, Escape closes. Keys typed there do not reach the office (no walking while typing).

**Checked:** unit `apps/desktop/test/menu.test.ts`; the UI suite's step "the menu opens from the top-left button…" (every window has a picture and a line, two columns, all of it on the screen, found by "passwords keys", Enter opens, a click opens, nothing found says so). **Not looked at:** as a visitor (the short menu); on a screen lower than 760 px (it scrolls).

## Inbox

`hud/panels/notifications.tsx`, `lib/inbox.ts`. Three tabs in a window that **keeps one size**: *Needs you*, *News* (was "Notifications"), *Answered*.

- **Needs you** — whoever asks to be allowed something first (they stand still until told), then questions, then what is stuck. Each is one or two lines: a face, "David asks to be allowed · T-4", and under it what is asked in one line (for an approval, the command or the file); at the end how long ago and *Decide* / *Answer*. The whole line opens it. Headings ("To be allowed · 1") appear only when there is more than one kind.
- **News** — one line each, under *Today*, *Yesterday*, *Earlier*: a dot that is coloured only for a warning, the title (bold while new) and the first line of its text, its kind and age, and a small ✕ to dismiss it. Forty lines, then "Show 40 more"; what was dismissed is one folded line at the bottom.
- **Answered** — what was asked, "You: …", and one word for whether the answer got there ("arrived", "on its way", "did not arrive", "settled elsewhere"; the detail in its tooltip).

**What is no longer printed:** the whole Markdown text of every question, the kind as a badge on every line, "via mcp tool", a card around every question with a blue button in each, the full text under every piece of news, dismissed news among the rest.

**Checked:** unit `apps/desktop/test/inbox.test.ts`; the UI suite's "Inbox: Mark all read…" (the window's size is the same on all three tabs, a piece of news is one line, today's is under "Today"). Looked at with thirteen things needing the owner at once (one approval, eight questions, four blocked): the window keeps its size and the list scrolls inside it. **Not looked at:** fifty and more pieces of news; yesterday's and earlier ones (a development office is minutes old).

## Team

`hud/panels/team.tsx` (`TeamPanel`), `lib/team.ts`. It was a table of eight columns that scrolled sideways. Now: **people as cards under their projects**, three to a row — a face, the name (and whose they are, when not the office's), "● thinking · T-9 Notes, part 1", and *Talk*. Within a project whoever wants somebody comes first. **A card opens that person's window**, where everything else about them is. Above the cards: a box to find by name, title or skill, the two filters (project, machine) and *Mine / Everyone*; the foreman, when there is one, has a line of its own; archived employees are one folded line at the bottom. *Hire* is the one main button.

Looked at with thirty-three employees in four projects (a development office with three members' rooms): three cards to a row, the groups one under the other, the window scrolling inside itself.

**What is no longer printed for everybody:** level and XP bar, machine, autonomy, the task's key as a button, *Open terminal* and *Profile* on every row, *Mine / Not mine* on every row — all of it is in the person's window (the head's *Terminal*, the Overview's "What they are").

## An employee's window

`hud/panels/team.tsx` (`EmployeePanel`, `OverviewTab`, `ProfileTab`…). The owner on the old one: "awful — everything is crammed and bolted on, nothing is organised".

- **The head** is the person: their face, their name, and under it the same line as in every list (how they are, and on what). To the right: *Terminal* (quiet) and the one main button — *Talk*, or *Answer their question* when they ask (then *Talk* is an ordinary button beside it).
- **Overview** (new, and where the window opens): on the left **Right now** — what they ask, the task they are on (a click opens it), whether a session runs (a click goes to Session) — and **What they are**: role, project, machine, what they think with, how much they may do without asking, whose they are (with *List among mine* / *Not mine*), skills; *Change* leads to Settings. On the right **Delivered** — six figures counted by the office — and **Level**, with where the XP came from folded. Nothing on it is filled in.
- **Settings** (was the whole "Profile" tab): who they are, where they work, what they think with, how much they may do without asking — **three lines, Standard, Auto and Unrestricted, the chosen one saying the rest** (there were six levels in six tall boxes until 2026-11-13) — the other projects they work on as tags on one line (`<PickMany>`, see "Several of many") — more settings folded, employment (archive, delete: two quiet buttons with a sentence, no longer two red ones). **The bar that saves is always at the bottom of the window**: it says "Nothing is changed" or names what is unsaved and what saving will do to their session, with *Discard* and *Save changes*.
- **The order of Settings (the owner, 2026-11-13: "right after the name and what they are, the settings for the folder — choosing what, where and how, the same as when I hire; then the settings for Claude — which account, model, effort; then the rest"):**
  1. **Who they are** — Name, Role, Title, on one line.
  2. **Their folder** — asked the way the hire form asks it: *On* (the machine), *Folder they live in* (the same field as in hiring: the path, **Browse…**, a new folder made from the list), and *…or a shared project*. Somebody hired into a folder is on a project of their own that *is* that folder; the form shows it as their folder, not as a project of that name (`lib/employee-home.ts`: `homeOf`, `homePatch`). Another folder, saved, is given the way hiring gives one — it becomes their own project, worked in place, or they join the project that already lives there (`PATCH /employees/:id { folder }` → `Engine.updateEmployee`); a folder that is not on the machine is refused and nothing of the change is made. It takes effect when their session next starts. Changing the machine empties the folder (a folder is on a machine). *Also works on* stands under it.
  3. **Claude** — Account (by name), Model, Effort, on one line.
  4. **How much they may do without asking** — the three levels.
  5. Folded: skills, department, specialisation, style, runtime, instructions, tools. Then employment.
- **Codex-managed workers** use the selected machine’s Codex model settings and the workspace file tools (list, read and write text in their folder; no shell). Hire and Settings offer the runtime on machines that report it. The workstation shows a read-only transcript. Send work through the office’s messages and tasks.
- **Session**: one sentence on what a session is; *Pause* / *Stop session…* / *Open terminal* (no red button: stopping asks first); the session now in two lines — how it is and since when, and who holds the keyboard — then six facts (machine, model, last heard from, folder, branch, tokens); the rest (how it runs, what the office can do with it, tmux, process, permission mode) under *Technical details*; earlier sessions folded. Then **Machine**: *Move to another machine…* (`move-employee.tsx`) — the machine (the ones you may put them on; one that is not connected or runs an older agent shown but not choosable), what goes along and what to know (the office's plan, word for word), **their desk there** (the hire form's desk picker: a seat of that member's room, or a desk of the office; *Automatic* finds one — they never arrive without a desk), the folder to put it in on that machine, *Move <name>*; while it goes, a line and a bar; a failed one with *Try again* / *Dismiss* (`MOVE.md`).
- **Routines** (the owner, 2026-11-13: "I need somewhere in the profile to see the tasks that repeat for them, what they have, and to manage that — add and so on"; moved to the kit on 2026-11-15 after "fix the routines UI, it is a bit buggy" — the list had kept the Talk window's style: a box of 168 px that scrolled inside itself, a frame in a frame, "Not run yet · not run yet", and five controls on every row): one sentence on what a routine is and **Add a routine** (the main button); one line per routine in one list — a dot (lit, a ring when paused, orange when held, red when it failed), its words, "every hour · next 12:08 · 3 runs"; a click opens it: its words in full with *Change the words*, **how often** (15 min, 30 min, hour, 3 h, day — one click — or any number of minutes), what the last run came to, *Run now*, *Pause / Resume*, and *Remove* last, asking first. **Add a routine** opens a sheet with the same choice of rhythm (an hour unless changed) and "and once right now". The Talk window keeps its compact list above the conversation (`RoutineList`), where *Remove* now asks first too (`routines.tsx`).
- **My character** (2026-11-17, `docs/CHARACTER.md`): a window in two halves — the figure on the left (drag to turn; Standing / Walking / Waving / Sitting as filters under it), what is chosen on the right in tabs (Body, Face, Hair, Clothes, Extras): colours as rows of dots with a last one for any colour, choices as a row of words; *Surprise me*, *Undo changes* and *The office's look* (asks first) quiet, *Save* the main button.
- **Context** (2026-11-17, `docs/CONTEXT.md`): a window with tabs per layer (Office, Projects, Roles, Clients — owners — , Employees), *Proposals* with a count and *Who holds it*; each layer a sentence on who holds it, **Add a fact** (the main button), the facts one line each with *on demand* / *not for clients* / *look again* at the end, opening to edit (title, text, Always / On demand as a two-way switch, keep from clients, look again by) or archive (asking first); the characters the layer holds always, warned past its share; *Recent changes* folded.
- **Access → Rent** (2026-11-16, `docs/RENT.md`): Access became a window with two tabs, *Members* (as it was) and *Rent*. Rent: one sentence on what renting is and **New client** (the main button); the new client is a sheet — name and company side by side, the employees with `PickMany`, what they may do as a row of switches (`k-toggle`; vault and memory turn amber when on), *Make the client and a link*; the link is a sheet with *Copy* and what to tell them, shown once. One line per client (an initial, name and company, whom they rent · whether the link was used · their last word, the faces at the end); open: each employee with their state and folder, the switches (changed at once), *Conversation* (read-only, below them), × to release; *Another employee for them*; the owner's note; *New link* and *End the rental…* last, asking first. Ended rentals are folded under one line, their conversations still readable.
- **The Rent portal** (2026-11-16) is not a window of the office but a page of its own for clients, in the entrance page's look rather than the kit's (`apps/desktop/src/rent/`).
- **Messages**: everything said to and by them, one line each under *Today / Yesterday / Earlier* ("From Boss · …", how long ago, and one word for whether it got there); a click shows all of it.
- **History**: what they did and what was done with them, one line each by day — the time, what happened, and who it came from in words ("by the office", "from their session", "by a person"); the event's code is in the tooltip; a line about a task opens it.
- **Look** (was "Appearance"): the face as it will look beside what is chosen for it — colours, hair and what they wear (what is earned with levels in one sentence, not three badges), build — and the same bar at the bottom ("Unsaved: shirt, hair style…", *Discard*, *Save appearance*).
- **Desk and hours**: *Where they sit* (the plan of the floor; a click moves them, a taken desk swaps) and *When they work* (available or not, and the hours).
- The window keeps one size from tab to tab. `openPanel('employee', '<id>:settings')` (or `:profile`) opens the settings; without a tab it opens Overview.

**Roles.** A visitor gets the small card as before (role, project, task, skills, level, *Watch terminal*), now with the same head.

**Checked:** unit `apps/desktop/test/team.test.ts`; the UI suite's "Team and an employee's window…" (cards under projects in columns, one button and one state per card, no table or badge; a card opens the profile on Overview with the face and state in its head, one main button, six figures and nothing to fill in; *Change* → Settings at the same window size; the save bar in sight and disabled, three level lines with one explained, a change named in the bar and discarded) and the older Team steps (instructions saved, session stopped and started, appearance, schedule, archive, hiring). **Not looked at:** the profile of a member's own employee as that member; somebody with dozens of messages or a history over several days; a session that is paused, lost or on a machine that dropped out. (A visitor's card and menu were looked at: the short card with the new head, and no button but *Watch terminal*.)

## Projects

`hud/panels/projects.tsx`, `lib/project-view.ts`. The owner on the old one: "it makes no sense; it has to be good for something". It opened on a form of four text boxes.

**On the left, the projects**, each with a thin bar of how far it is and "3 of 8 done". **On the right, one project**: its name and one line about it ("1 of 8 done · 4 in progress · 1 blocked"), *Pause project* / *Resume project* and *Delete project…* (quiet), and its tabs. *New project* is the one main button.

- **Overview** (new, and where a project opens): **How far it is** — one bar in parts (done, in review, in progress, blocked, not started) with what the parts are; **Open now** — its open tasks with the face of whoever is on each (a click opens the task; *Its tasks* opens the board filtered to it) and under them what was **done lately**; **Who is on it** — its people with how each is (a click opens the person); **What it is** — the description, and the way to change it; *Show only this project in the office*.
- **About** (was the Overview's form): description, goals, requirements, notes — "what employees on this project are told about it" — where it lives (folder, machine, branches), other repositories and what it builds on.
- **Plan**: what you want, who plans it, *Ask for a plan*; what happens then is said above the box.
- **Integration**: what it is for, three figures (finished and waiting to go to the main branch, on it and not brought in yet, how the integration tests stand), *Bring in* / *Test now* / *Promote*, and the last test's output.
- **Policy**: the same switches and rules, under three headings — *When a task is handed in*, *What happens by itself*, *What employees may run here* — with the bar that saves at the bottom.

## Reports

`hud/panels/reports.tsx`. The owner: "I do not know what it is for." It said "No document selected".

It is **what employees wrote for you**, kept to be read: on the left the documents under *Today / Yesterday / Earlier*, each with its writer's face, its name, what kind it is and how old; a box finds one by a word in it or by who wrote it; when there is more than one kind, a row of them to narrow by ("Reports 4 · Plans 2 · Decisions 1"). On the right, one of them to read: its head (writer, when, project; the task or the meeting it belongs to; *Talk to <writer>*) and the text at a width one can read. **The one main button is *Ask for a report***: pick somebody, and their report appears here when they hand it in. With nothing written yet the window says what gets here and how — a report asked for, a plan or a review handed in with a task, what a meeting decided.

## Growth

`hud/panels/growth.tsx`. The owner: "it has to be like a library, so that I find my way and see what is going on." It was four tabs under a strip of three buttons.

**The shelves are on the left:** *Waiting for you* (with how many); **the library** — *All lessons*, *For everyone*, then a shelf for each project and each person that has lessons, each with how many stand on it; and **the office** — *Done by itself*, *Is it working?*, *How it learns* (with how it is set: "apply what is safe"). **On the right, the shelf that was picked:** what it is and whose task prompts its lessons are added to, how many are in use, a box to find a lesson by a word, and the lessons as cards — the lesson, when it applies, where it came from and how often it was used, and *Retire* / *Edit* quietly at the end; on the shelf of everything each card says whose it is. *Add a lesson* is the one main button. The window opens on what waits for you when something does, and on the library otherwise. The dial (ask me first / apply what is safe / apply more on a clean record) is under *How it learns*, with a paragraph on what learning is here.

## My room

`hud/panels/my-room.tsx`, `my-servers.tsx`. It was four cards one under the other. Now the head says whether this computer is in the office and how many work in the room, *Add folders…* is the one main button, and three tabs keep one size: **Who is in it** (one line each: face, name, title, their folder, how they are, *Talk* or *Start*; what the room is, in three lines; Claude Code found running outside the office), **The room** (its name, colour, desks, floor, furniture, and *Close my room*; saved as it is changed), **My servers**. `openPanel('myroom', 'room' | 'servers')` opens on a tab.

**Checked, for these four:** unit `apps/desktop/test/project-view.test.ts`; the UI suite's steps for Projects (created, paused, resumed; Integration; Policy; deleted), Reports (a document listed and shown), Growth (the new step "Growth is a library…": the shelves and their counts, one open at a time, the dial under *How it learns*; a lesson taught, found, retired, edited; a suggestion applied). Looked at in a development office with two projects, six lessons on four shelves and two reports, as owner; My room as a member with five employees. **Not looked at:** a project worked on in place (no integration branch) and one whose integration tests fail; a report long enough to scroll, and more than a handful of them; Growth with something waiting and with dozens of lessons; *My servers* with a server in it (it needs the desktop app and a real server: its lines were restyled and only read); none of the four as a colleague.
