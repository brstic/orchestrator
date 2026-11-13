/**
 * The order of the Team window (docs/UI.md): the people of the office under the project each belongs to, and the
 * window's one line. Nothing here touches the page.
 */

export interface TeamGroup<E, P> {
  project: P | null;
  people: E[];
}

/**
 * People under their projects: the projects by name, then whoever has none. Within a project the order the people
 * came in is kept (the caller has already put whoever wants somebody first).
 */
export function byProject<E extends { projectId?: string | null }, P extends { id: string; name: string }>(people: readonly E[], projects: Record<string, P | undefined>): Array<TeamGroup<E, P>> {
  const groups = new Map<string, TeamGroup<E, P>>();
  const none: E[] = [];
  for (const e of people) {
    const p = e.projectId ? projects[e.projectId] : undefined;
    if (!p) none.push(e);
    else {
      const g = groups.get(p.id) ?? { project: p, people: [] };
      g.people.push(e);
      groups.set(p.id, g);
    }
  }
  const out = [...groups.values()].sort((a, b) => a.project!.name.localeCompare(b.project!.name));
  if (none.length) out.push({ project: null, people: none });
  return out;
}

/** "16 employees · 11 working", and "· 2 archived" when there are any. */
export function teamLine(n: { employees: number; working: number; archived: number }): string {
  if (n.employees === 0) return n.archived ? `Nobody on the team · ${n.archived} archived` : 'Nobody works here yet';
  return [`${n.employees} employee${n.employees === 1 ? '' : 's'}`, `${n.working} working`, n.archived ? `${n.archived} archived` : null].filter(Boolean).join(' · ');
}

/** How far somebody is to the next level, in words: "Level 3 · 420 XP · 80 to level 4", or the top. */
export function levelLine(level: number, xp: number, next: number | null): string {
  const n = (v: number) => Math.round(v).toLocaleString('en-US');
  return next == null ? `Level ${level} · ${n(xp)} XP · top level` : `Level ${level} · ${n(xp)} XP · ${n(Math.max(0, next - xp))} to level ${level + 1}`;
}
