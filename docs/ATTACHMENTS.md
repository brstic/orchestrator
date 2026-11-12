# Files on tasks, eyes and a browser for employees

How a picture or a document gets from a person to the employee who does the task, how an employee leaves a screenshot of the result as evidence, and how employees get a browser of their own. Read this before touching `packages/orchestration/src/attachments.ts`, the `files.*` messages of the host agent, or `findBrowserMcp`.

_Built on 2026-11-11 on the owner's request: "an option on the task board to attach pictures and files; agents should be able to leave a screenshot of what they did with their evidence; give them vision so they understand better; they should have a browser from the server, or whatever they need to work efficiently". Why it is built this way: `DECISIONS.md`, "Files on tasks; a browser for employees". What protects what: `SECURITY.md`, "Files on tasks" and "A browser for employees"._

## The three parts in one paragraph each

**Files for the employee.** In the task window (and in *New task*) a person attaches files — a button, a drop, or a pasted screenshot. The office keeps the bytes. When the task is handed over, each file is copied to the machine the employee's session runs on, into a folder of the host agent *outside every repository*, and the hand-over lists the paths. The employee opens them with Claude Code's own **Read** tool.

**Eyes.** Nothing had to be added for an employee to see: Claude Code's Read tool shows an image file to the model, which looks at it (a PNG, JPEG, GIF or WebP; a PDF is read as a document). What was missing was a way for the image to *reach* the session, and for the employee to be told to look — that is the paragraph above and one paragraph of their instructions.

**Evidence to look at.** An employee calls `attach_file { path, caption }` and the office takes that file from their machine and puts it on the task as *evidence*. The task window shows evidence pictures at the top of the *Evidence* tab and under *Files*. Their instructions say: when the work has something to look at — a page, a screen, a chart — take a picture of the result and leave it before `complete_task`.

**A browser.** Where Playwright's MCP server is installed on a machine, every session started there gets a second set of tools, `browser_*`: open a page, read it, click, type, take a screenshot. Headless, on the machine's own Chrome, with a profile that lives only as long as the session. That is how an employee on the server looks at what it built, and how it makes the screenshot it leaves as evidence.

## A file's way, end to end

```
person ──(pieces of ≤ 384 KB)──▶ office: <data folder>/files/<task id>/<attachment id>      Task.attachments[] (the list)
                                    │  at hand-over, or at once if the task is in progress
                                    ▼  files.put (pieces of 1 MB over the agent's link)
              machine of the employee: <agent home>/files/<task key>/<name>                 mode 600, outside any repository
                                    │  the path stands in the task's hand-over
                                    ▼
                         Claude Code: Read <path>   → an image is seen, a document is read

employee: attach_file { path } ──▶ office asks the machine: files.get (pieces) ──▶ <data folder>/files/…   kind: evidence
person in the office: GET /api/tasks/:id/attachments/:aid  → the picture, or a download
```

- **Limits:** 25 MB a file, 200 files a task (30 until 2026-11-12: a long task with a picture per step was full, and its employee went back to naming paths on its machine). Larger things belong on the machine, named in the task.
- **Names** are made safe (`safeName`: no path, no control characters, not hidden) and unique within a task (`spec.pdf`, `spec-2.pdf`).
- **A file added while the employee is already on the task** is sent at once and they get a message with its path.
- **A task that is deleted** takes its files along (the office's copies; a copy on an employee's machine stays there).
- **Shown or downloaded:** PNG, JPEG, GIF and WebP are sent to the window as pictures. Everything else — PDF, HTML, SVG, anything — is sent as a download with `nosniff`, never as a page.

## Where things are

| | |
| --- | --- |
| The store, delivery, evidence | `packages/orchestration/src/attachments.ts` — `Attachments` (`begin`, `append`, `open`, `remove`, `deliver`, `attachFrom`, `dropTask`), `safeName`, `mimeOf`, `isImage` |
| The list on a task | `Task.attachments: TaskAttachment[]` in `packages/contracts/src/entities.ts` (`kind: 'input' \| 'evidence'`, `paths`: where a copy stands on each machine) |
| For people | `POST /api/tasks/:id/attachments` (say what it is), `POST …/attachments/:aid/data` (a piece), `GET …/attachments/:aid`, `DELETE …/attachments/:aid` in `apps/server/src/server.ts`; rules in `access.ts` |
| On the machine | `files.put` / `files.get` in `packages/contracts/src/protocol.ts`; `putFile`, `getFile`, `filesRoot` in `apps/host-agent/src/agent.ts`. Every session is started with `--add-dir <agent home>/files` so it may read there |
| The hand-over | `TaskManager.startTask` in `tasks.ts` ("Attached files — open each with the Read tool…") |
| The employee's tool | `attach_file` in `FILE_TOOLS` (`packages/integrations/src/mcp.ts`), handler in `mcp-tools.ts`; `get_task` lists a task's files |
| What employees are told | `systemPromptFor(…, files, browser)` in `prompts.ts` |
| The window | `apps/desktop/src/hud/panels/task-files.tsx` (`TaskFiles`, `PendingFiles`, `uploadFile`), used by `tasks.tsx` |
| The browser | `findBrowserMcp` in `packages/execution/src/claude.ts`; `HostInfo.browser`; `LaunchSpec.browser`; the `browser` entry of a session's `mcp.json` and `mcp__browser` in its allow list (`planClaudeLaunch`); the switch `OwnerSettings.employeesBrowser` (Settings → Employees) |

## A browser: installing it on a machine

The office never downloads a browser or the tool by itself. Somebody installs the tool once per machine; the agent finds it at start and reports it (`HostInfo.browser`), and from then on sessions started there have it.

On the office's server (done on 2026-11-11; Chrome was already there):

```sh
# as the user the office runs as
mkdir -p ~/orchestrator-office/browser && cd ~/orchestrator-office/browser
echo '{"name":"office-browser","private":true}' > package.json
npm i @playwright/mcp@0.0.83 --ignore-scripts        # pinned; 19 MB; beside `app`, so a deploy does not touch it
systemctl --user restart orchestrator-office          # the agent looks for it when it starts
```

- **Where it is looked for** (`findBrowserMcp`): `ORCH_BROWSER_MCP` (the path of its `cli.js`), then `browser/node_modules/@playwright/mcp/cli.js` beside the office program, in the agent's home, and in `~/.orchestrator/` (a member's own computer: install it there the same way).
- **Which browser:** the machine's Google Chrome when it has one (`--browser chrome`); otherwise the Chromium that `npx playwright install chromium` puts in place (that one *is* a download of about 150 MB, and on Linux may need system libraries — `npx playwright install-deps` needs root).
- **How a session runs it:** `node cli.js --headless --isolated --file-paths absolute [--browser chrome] --output-dir <session folder>/browser`. `--isolated`: nothing is kept between sessions — no cookies, no logins. Screenshots land in the session's own folder, from where `attach_file` can take them.
- **Updating it:** change the version in the `npm i` line (take one that is a few weeks old), restart. **Removing it:** delete the `browser` folder, restart.
- **Switching it off for everyone:** Settings → Employees → *Employees have a browser*.

Tried by hand on the server after installing: the tool started as a session starts it, opened `https://example.com` in Chrome 156 and saved a screenshot (25 tools offered).

## Testing it

- `tests/e2e/28-attachments.test.ts` — real server, agent and sessions with the scripted worker: attaching in pieces, names, the copy on the machine (place, bytes, mode, not in git), the hand-over naming the files, a file added mid-task, evidence from the worker and opening it in the office, everything that is refused, who may, a restart, deleting a task; and a stand-in browser tool that the session's `mcp.json` must carry — and must not when the office says no.
- `packages/orchestration/test/attachments.test.ts` — names, types, finding the browser.
- In tests the browser tool is a stand-in file named by `ORCH_BROWSER_MCP`; no browser is started. `ORCH_BROWSER_CHROME=none` makes the machine look as if it had no Chrome.

## Limits, plainly

- **A copy on an employee's machine stays there** after the file is removed from the task or the task is deleted. On a member's own computer that is the member's disk.
- **Files are not looked into.** The vault does not find a password inside a picture or a PDF, and the long memory does not file what a document says. An employee is told never to attach a file that holds a credential; nothing prevents it.
- **Where evidence may come from** (the machine's agent, `getFile`): the employee's working folder (and its repository), the folder its browser saves to, the files the office put on the machine for it, and temporary folders — never "anywhere the machine lets the office work", which is usually the whole home folder. Nothing hidden (a file or folder whose name starts with a dot) and nothing that is a key or a credential by its name (`id_ed25519`, `*.pem`, `*.key`, `owner-token`, a session's own `mcp.json` or `settings.json`, …). This is a fence around a tool, not around the employee: its shell can still read what its user can read, under Claude Code's own rules.
- **Evidence is whatever the employee attaches.** A screenshot is not checked against the work. It is something to look at, not a verification — the verification command is still what decides.
- **Messages cannot carry files** — only tasks. To show an employee a picture, put it on a task (or on their machine).
- **SDK-managed workers** get the files and `attach_file`; the browser entry is written for interactive sessions only.
- **The browser can reach whatever the machine can reach**, including addresses inside its network, and what a page says can steer a model (see `SECURITY.md`). It runs as the same user as the session; it has no access the session's shell did not already have.

## Not verified with real Claude Code

- That a session reads a file under `--add-dir <agent home>/files` without a permission prompt in every permission mode.
- That an employee, told to, really opens an attached picture before starting, and really leaves a screenshot when the work is visual.
- The browser tools inside a real session (they were tried by hand over the same protocol, not through Claude Code), and how much of a session's context a page snapshot takes.
