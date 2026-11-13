import type { ReactNode } from 'react';
import { Window } from '@orchestrator/ui';
import { ABOUT, LABEL } from '../../lib/menu.ts';
import { usePrefs } from '../../lib/prefs.ts';
import { mayOpenPanel } from '../../lib/visitor-panels.ts';
import type { PanelId } from '../../lib/store.ts';
import { Icon } from '../menu.tsx';
import { useOffice } from '../../lib/store.ts';
import { registerPanel } from './index.tsx';
import { keyLabel, type PanelProps } from './company-shared.tsx';

function Key({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

const ROOMS: Array<{ name: string; text: string }> = [
  { name: 'Reception, break room', text: 'Company: who is doing what and what needs you.' },
  { name: 'Project board', text: 'Tasks, from backlog to done.' },
  { name: 'CEO office', text: 'Decisions waiting for you, projects, how much Claude is left.' },
  { name: 'Meeting room', text: 'Put a question to several employees and get one decision.' },
  { name: 'Operations room', text: 'Every running terminal side by side.' },
  { name: 'Server room', text: 'The machines the office runs on.' },
  { name: 'Hi-fi, TV', text: 'Music and a screen, in the break room.' },
];

const BINDINGS: Array<{ id: string; label: string }> = [
  { id: 'talk', label: 'Talk to the employee next to you' },
  { id: 'interact', label: 'Use what you are standing at: a desk, a room, a seat — and jump where there is nothing' },
  { id: 'notifications', label: 'Inbox: what needs you' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'projects', label: 'Projects' },
  { id: 'overview', label: 'Company' },
  { id: 'map', label: 'Map' },
  { id: 'command', label: 'Tell Orchestrator what to do, in your own words' },
  { id: 'camera', label: 'Next camera' },
  { id: 'exit', label: 'Close a window, stand up' },
];

function HelpPanel({ onClose }: PanelProps) {
  const kb = usePrefs((p) => p.prefs.keybindings);
  const k = (id: string) => keyLabel(kb[id]);
  const role = useOffice((s) => s.me?.role);
  return (
    <Window
      kit
      title="Help"
      subtitle="The office in two minutes"
      onClose={onClose}
      width={980}
      actions={
        <button className="btn btn-ghost btn-sm" onClick={() => useOffice.getState().openPanel('settings', 'controls')}>
          Change keys
        </button>
      }
    >
      <div className="pc-help grid2" style={{ gap: '18px 28px' }}>
        <section style={{ gridColumn: '1 / -1' }}>
          <h3>The idea</h3>
          <ul className="small">
            <li>
              <b>Every employee is a real Claude Code session</b> working in a folder on one of your machines. Walk up to one and press <Key>{k('talk')}</Key> to tell them what to do, or <Key>{k('interact')}</Key> to open their terminal.
            </li>
            <li>
              <b>When someone needs you</b> — a question, a permission, a blocker — the Inbox at the top right counts it and their name tag shows it. Nothing else needs your attention.
            </li>
            <li>
              <b>A task is done when it was checked</b>, not when an employee says so: the office runs the project’s own check and, if the project asks for it, waits for a review.
            </li>
          </ul>
        </section>

        <section>
          <h3>Moving around</h3>
          <dl className="kv small">
            <dt>
              <Key>{k('forward')}</Key> <Key>{k('back')}</Key>
            </dt>
            <dd>Walk forward and back</dd>
            <dt>
              <Key>{k('left')}</Key> <Key>{k('right')}</Key>
            </dt>
            <dd>Turn</dd>
            <dt>
              <Key>{k('strafeLeft')}</Key> <Key>{k('strafeRight')}</Key>
            </dt>
            <dd>Step sideways</dd>
            <dt>
              <Key>Shift</Key>
            </dt>
            <dd>Run</dd>
            <dt>Mouse</dt>
            <dd>Drag to look around, scroll to zoom</dd>
            <dt>Right-click</dt>
            <dd>On an employee: everything you can do with them</dd>
            <dt>
              <Key>{k('interact')}</Key>
            </dt>
            <dd>At a sofa, an armchair or a chair at a table: sit down (a step, or the key again, gets you up). With nothing in front of you: jump. The others in the office see both.</dd>
            <dt>
              <Key>Enter</Key>
            </dt>
            <dd>Say something to the other people in the office</dd>
            <dt>
              <Key>{k('whip')}</Key>
            </dt>
            <dd>Crack the whip at the employee — or the person — next to you. At somebody asleep it gets them up (if you may start them); somebody who has left their chair runs back to it — some at the first crack, some after two or three. Otherwise for show. An owner can make it approve what an employee is waiting for permission to do.</dd>
            <dt>
              <Key>{k('voice')}</Key> (hold)
            </dt>
            <dd>Talk: the people near your character hear you, louder the nearer they stand. What is said in the meeting room stays in it. Settings → Sound can keep your microphone always on instead; the key then switches it off and on.</dd>
            <dt>
              <Key>{k('emotes')}</Key> (hold)
            </dt>
            <dd>Gestures: a wheel opens — move the mouse to wave, dance, clap, bow… and let go.</dd>
          </dl>
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
        </section>

        <section>
          <h3>At someone’s terminal</h3>
          <ul className="small">
            <li>You see their real terminal, live. At first you only watch: what you type goes nowhere.</li>
            <li>
              <b>Take the keyboard</b> to type into it yourself. The office sends them nothing while you do. <b>Give it back</b> when you are done.
            </li>
            <li>
              <Key>Esc</Key> inside a terminal belongs to Claude Code (it interrupts). Use <b>Leave</b> to stand up.
            </li>
            <li>
              <b>Pause</b> stops what they are doing until you resume them. <b>Stop session</b> closes Claude Code; it continues where it was when started again.
            </li>
          </ul>
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
            Walk in and press <Key>{k('interact')}</Key>, or use the menu at the top left: everything is there too.
          </div>
        </section>

        <section>
          <h3>Cameras</h3>
          <dl className="kv small">
            <dt>CEO</dt>
            <dd>You walk the floor, seen from behind.</dd>
            <dt>First person</dt>
            <dd>The same, through your own eyes.</dd>
            <dt>Management</dt>
            <dd>From above, moved with the walking keys.</dd>
            <dt>Free cam</dt>
            <dd>
              Fly anywhere; <Key>E</Key> up, <Key>Q</Key> down.
            </dd>
            <dt>Command center</dt>
            <dd>The whole office from above, with a list of everyone.</dd>
          </dl>
          <div className="small faint" style={{ marginTop: 6 }}>
            Desks and rooms are used in CEO and First person.
          </div>
        </section>

        <section style={{ gridColumn: '1 / -1' }} data-help-windows>
          <h3>What each window is for</h3>
          <div className="hp-windows">
            {(Object.keys(ABOUT) as PanelId[])
              .filter((id) => id !== 'help' && id !== 'mine' && id !== 'myroom' && mayOpenPanel(role, id))
              .map((id) => (
                <button key={id} type="button" className="mn-item" onClick={() => useOffice.getState().openPanel(id)} title={`Open ${LABEL[id] ?? id}`}>
                  <span className="mn-icon">
                    <Icon id={id} />
                  </span>
                  <span className="mn-words">
                    <span className="mn-name">{LABEL[id] ?? id}</span>
                    <span className="mn-about">{ABOUT[id]}</span>
                  </span>
                </button>
              ))}
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>
            All of them are in the <b>Menu</b>, at the top left; its box finds one by a word of what you want — “password”, “hire”, “radio”.
          </p>
        </section>

        <section>
          <h3>What the words mean</h3>
          <dl className="kv small">
            <dt>Sleeping</dt>
            <dd>No session is running. Talking to them or giving them work wakes them where they left off.</dd>
            <dt>Needs you</dt>
            <dd>They asked a question or need a permission, and wait for your answer.</dd>
            <dt>Blocked</dt>
            <dd>They cannot go on and said why.</dd>
            <dt>Unknown</dt>
            <dd>The office cannot see what the session is doing, and says so rather than guess.</dd>
            <dt>Proposed</dt>
            <dd>A task that waits for your go-ahead before anyone starts it.</dd>
          </dl>
        </section>
      </div>
    </Window>
  );
}
registerPanel('help', HelpPanel);
