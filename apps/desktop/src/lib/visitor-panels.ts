/**
 * The windows a visitor can open. A visitor looks at the office — who is here, who works on what, how the shared work
 * stands, the shared terminals — and the office sends them nothing else (`shownTo` in the office's `access.ts`), so a
 * window about the rest would only be an empty one. The office decides; this keeps such windows off the menu and
 * out of reach of the keys.
 */
export const VISITOR_PANELS: ReadonlySet<string> = new Set(['tasks', 'team', 'employee', 'people', 'map', 'wall', 'radio', 'tv', 'arcade', 'character', 'settings', 'help']);

/** May someone here as `role` open this window? */
export const mayOpenPanel = (role: string | null | undefined, panel: string): boolean => role !== 'visitor' || VISITOR_PANELS.has(panel);
