import { unlockedUpgrades, type Milestone, type OfficeLayout } from '@orchestrator/contracts';

/** Whether an arcade cabinet stands in this office: one is on the floor plan, and what it asks for has been reached. */
export function arcadeStands(layout: Pick<OfficeLayout, 'decorations'> | null | undefined, milestones: Array<Pick<Milestone, 'key' | 'unlocks' | 'unlockedAt'>>): boolean {
  if (!layout) return false;
  const reached = new Set(unlockedUpgrades(milestones));
  return layout.decorations.some((d) => d.kind === 'arcade' && (!d.requires || reached.has(d.requires)));
}
