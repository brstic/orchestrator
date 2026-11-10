import type { ReactNode } from 'react';
import { Window } from '@orchestrator/ui';
import { useOffice } from '../../lib/store.ts';
import { registerPanel } from './index.tsx';
import { CONTROL_STATES, keyLabel, type PanelProps } from './company-shared.tsx';

function Key({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

const ROOMS: Array<{ name: string; text: string }> = [
  { name: 'CEO office', text: 'The CEO desk: project portfolio, decisions waiting on you, infrastructure health, measured token usage and what happened while you were away.' },
  { name: 'Meeting room', text: 'Meetings: put a topic to several employees, read their real contributions and the decision document that comes out.' },
  { name: 'Operations room', text: 'The terminal wall: every running session’s real terminal side by side, read-only.' },
  { name: 'Server room', text: 'Machines: connect, rename and revoke hosts, see measured resources, attach existing tmux sessions. “Connect a server over SSH” links a server you can ssh into — no ports opened — and brings the Claude Code sessions running there in as employees.' },
  { name: 'Project board', text: 'The task board: tasks by status, with their evidence, reviews and merges.' },
  { name: 'Break room', text: 'Company overview: who is doing what, what needs you, milestones.' },
  { name: 'Reception', text: 'Company overview as well — the first stop when you walk in.' },
];

const BINDINGS: Array<{ id: string; label: string }> = [
  { id: 'talk', label: 'Talk to the employee next to you — tell them what to do in plain words' },
  { id: 'interact', label: 'Interact with the desk or room next to you' },
  { id: 'camera', label: 'Next camera mode' },
  { id: 'command', label: 'Command bar' },
  { id: 'overview', label: 'Company overview' },
  { id: 'map', label: 'Office map' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'projects', label: 'Projects' },
  { id: 'notifications', label: 'Inbox' },
  { id: 'exit', label: 'Close a panel / stand up / deselect' },
];

function HelpPanel({ onClose }: PanelProps) {
  const kb = useOffice((s) => s.settings?.keybindings) ?? {};
  const k = (id: string) => keyLabel(kb[id]);
  return (
    <Window
      title="Help"
      subtitle="How the office works"
      onClose={onClose}
      width={980}
      actions={
        <button className="btn btn-ghost btn-sm" onClick={() => useOffice.getState().openPanel('settings', 'controls')}>
          Change keys
        </button>
      }
    >
      <div className="pc-help grid2" style={{ gap: '18px 28px' }}>
        <section>
          <h3>Moving around</h3>
          <dl className="kv small">
            <dt>
              <Key>{k('forward')}</Key> <Key>{k('back')}</Key>
            </dt>
            <dd>Walk forward and back (or fly, or pan — depending on the camera mode)</dd>
            <dt>
              <Key>{k('left')}</Key> <Key>{k('right')}</Key>
            </dt>
            <dd>Turn your character left and right</dd>
            <dt>
              <Key>{k('strafeLeft')}</Key> <Key>{k('strafeRight')}</Key>
            </dt>
            <dd>Sidestep without turning</dd>
            <dt>
              <Key>{k('whip')}</Key>
            </dt>
            <dd>Crack the whip at whoever you are standing next to. A sound and a flinch, purely for fun: nothing is sent to them and their work is not touched.</dd>
            <dt>
              <Key>Shift</Key>
            </dt>
            <dd>Move faster</dd>
            <dt>Mouse</dt>
            <dd>Drag to look around; scroll to zoom. In first person, click to capture the mouse.</dd>
            <dt>Right-click</dt>
            <dd>On an employee: assign a task, send a message, pause, open their terminal…</dd>
          </dl>
        </section>

        <section>
          <h3>Camera modes</h3>
          <dl className="kv small">
            <dt>CEO</dt>
            <dd>Third person: you walk the floor and can interact with desks and rooms.</dd>
            <dt>First person</dt>
            <dd>The same walk through your own eyes.</dd>
            <dt>Management</dt>
            <dd>An elevated view you pan across the floor.</dd>
            <dt>Free cam</dt>
            <dd>
              Fly anywhere; <Key>E</Key>/<Key>Space</Key> up, <Key>Q</Key> down.
            </dd>
            <dt>Command center</dt>
            <dd>The whole office from above.</dd>
          </dl>
          <div className="small faint" style={{ marginTop: 6 }}>
            <Key>{k('camera')}</Key> cycles through them. Desks and rooms can only be interacted with in CEO and first-person mode.
          </div>
        </section>

        <section>
          <h3>Keys</h3>
          <dl className="kv small">
            {BINDINGS.map((b) => (
              <div key={b.id} style={{ display: 'contents' }}>
                <dt>
                  <Key>{k(b.id)}</Key>
                </dt>
                <dd>{b.label}</dd>
              </div>
            ))}
            <dt>
              <Key>?</Key>
            </dt>
            <dd>This help</dd>
          </dl>
          <div className="small faint" style={{ marginTop: 6 }}>
            Inside a terminal, Escape belongs to the terminal: it is Claude Code’s interrupt key, so it never closes the workstation.
          </div>
        </section>

        <section>
          <h3>Rooms</h3>
          <dl className="kv small">
            {ROOMS.map((r) => (
              <div key={r.name} style={{ display: 'contents' }}>
                <dt>{r.name}</dt>
                <dd>{r.text}</dd>
              </div>
            ))}
          </dl>
          <div className="small faint" style={{ marginTop: 6 }}>
            Walk in and press <Key>{k('interact')}</Key>, or open the menu at the top left — every room is also a panel.
          </div>
        </section>

        <section>
          <h3>Three levels of workstation interaction</h3>
          <ol className="small">
            <li>
              <b>Observe from a distance.</b> The tag above each employee shows their real state and task; the monitor on their desk shows a low-rate capture of their actual terminal. Nothing is touched.
            </li>
            <li>
              <b>Approach.</b> Stand next to a desk for a summary card, then press <Key>{k('interact')}</Key> to sit down: you see the live terminal stream, read-only, next to the current task, open questions and actions. Anything you type is dropped by the
              server.
            </li>
            <li>
              <b>Take control.</b> “Take control” gives you the keyboard of that exact tmux session; only one person can hold it. Orchestrator stops delivering prompts into the session until you press “Return control”.
            </li>
            <li>
              <b>Two kinds of worker.</b> By default an employee is the real interactive Claude Code terminal. In their profile you can switch the runtime to <i>SDK-managed</i>: the same Claude Code, driven through the Claude Agent SDK, so messages, approvals and interrupts are structured calls and the terminal shows a transcript you can still type prompts into. It needs the SDK on that machine (<span className="mono">orchestrator-agent sdk install</span>); where it is missing the employee starts as an interactive worker and is marked “fallback”.
            </li>
          </ol>
        </section>

        <section>
          <h3>Control states</h3>
          <dl className="kv small">
            {CONTROL_STATES.map((c) => (
              <div key={c.id} style={{ display: 'contents' }}>
                <dt className="mono">{c.id}</dt>
                <dd>{c.text}</dd>
              </div>
            ))}
          </dl>
          <div className="small faint" style={{ marginTop: 6 }}>
            Who may type is enforced on the server, never trusted to this window.
          </div>
        </section>

        <section style={{ gridColumn: '1 / -1' }}>
          <h3>What you see is real</h3>
          <ul className="small">
            <li>
              <b>States come from real signals.</b> An employee’s activity is derived from Claude Code hooks, the agent’s own MCP calls and the process state on the machine — never from animation or guesswork.
            </li>
            <li>
              <b>
                <span className="mono">UNKNOWN</span> means unknown.
              </b>{' '}
              When a session cannot be observed — an attached session without hooks, or a machine that is offline — it is shown as <span className="mono">UNKNOWN</span> rather than something plausible.
            </li>
            <li>
              <b>Delivery is confirmed only by the runtime.</b> A message, task prompt or answer is “sent” when it is written to the session and “confirmed” only when Claude Code itself acknowledges it.
            </li>
            <li>
              <b>Numbers say where they come from.</b> “Measured” was observed by Orchestrator on the machine; “reported” is the agent’s own claim; what cannot be measured — cost of interactive sessions, usage of sessions without a transcript — is shown as “not available”. The only cost figure shown is the Claude Agent SDK’s own estimate for SDK-managed workers, labelled as an estimate.
            </li>
            <li>
              <b>Done means checked, not claimed.</b> A task is not done because an agent says so: Orchestrator runs the project’s verification command on the machine and, where the project requires it, waits for an approved review. XP and levels are
              awarded only for work that passed, and say nothing about the underlying model.
            </li>
          </ul>
        </section>
      </div>
    </Window>
  );
}
registerPanel('help', HelpPanel);
