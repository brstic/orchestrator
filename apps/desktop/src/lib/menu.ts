import type { PanelId } from './store.ts';

/**
 * The words of the office's menu (hud/menu.tsx): what each window is for, in a line, and how a window is found by
 * what somebody types. Nothing here touches the page.
 */

/** What each window is for, in a line. A window without a line here is listed by its name alone. */
export const ABOUT: Partial<Record<PanelId, string>> = {
  mine: 'Your people, your tasks, what waits',
  myroom: 'Your computer, your room, your servers',
  overview: 'The office at a glance, and Claude usage',
  tasks: 'What is to do, and who is on it',
  projects: 'What is being built, and how far it is',
  meetings: 'Employees talk something through and decide',
  reports: 'What employees wrote for you',
  growth: 'What the office learned from its own work',
  team: 'Hire, talk to and look after your employees',
  people: 'Who may come into the office, and as what',
  map: 'The floor from above — find anybody',
  office: 'Move walls, rooms and desks',
  hosts: 'The computers your employees run on',
  wall: "Every employee's live screen, side by side",
  vault: 'Passwords and keys employees may use',
  radio: 'Radio for the whole office',
  tv: 'A screen on the break room wall',
  arcade: 'Mega Drive games, alone or together',
  settings: 'How the office looks, sounds and behaves',
  help: 'Keys, and how things work',
};

/** More words a window is looked for by than stand in its name or its line. */
const ALSO: Partial<Record<PanelId, string>> = {
  overview: 'usage limits accounts cost overview dashboard',
  tasks: 'board tickets kanban todo blocked review',
  projects: 'repository repo folder plan policy',
  reports: 'documents artifacts plans reviews decisions',
  growth: 'lessons learned suggestions improvements library',
  team: 'employees people hire profile',
  people: 'members invite guests visitors door password sign in',
  hosts: 'servers computers ssh token',
  wall: 'terminal screens tmux',
  vault: 'secrets credentials passwords keys tokens',
  radio: 'music hifi station',
  tv: 'browser video',
  arcade: 'games sega',
  office: 'layout desks rooms walls editor',
  settings: 'graphics sound keys controls theme',
  help: 'shortcuts how to',
  myroom: 'servers computer room',
};

/** Whether an item answers to what was typed: every word of it is in the name, in the line about it, or among the other words it is looked for by. */
export function matches(item: { id: PanelId; label: string }, typed: string): boolean {
  const hay = `${item.label} ${ABOUT[item.id] ?? ''} ${ALSO[item.id] ?? ''}`.toLowerCase();
  return typed
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

