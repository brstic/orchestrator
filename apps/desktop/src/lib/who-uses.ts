import type { Employee } from '@orchestrator/contracts';

/**
 * Who is on which Claude account and thinks with what — for the table in Company → Claude where an owner puts
 * people on accounts one by one or many at once, and changes model and effort the same way. The table edits a
 * draft; nothing is asked of the office until it is applied.
 */

export interface Use {
  /** The account's folder on their machine; '' = the machine's default login. */
  account: string;
  /** A model's alias or full name; '' = whatever the account uses. */
  model: string;
  /** '' = the default effort. */
  effort: string;
}
type Who = Pick<Employee, 'id' | 'claudeConfigDir' | 'model' | 'effort'>;

export const useOf = (e: Who): Use => ({ account: e.claudeConfigDir ?? '', model: e.model ?? '', effort: e.effort ?? '' });

/** What is to be asked for one employee: only what differs from what they have. Empty: nothing. */
export function usePatch(e: Who, want: Use | undefined): { claudeConfigDir?: string | null; model?: string | null; effort?: string | null } {
  if (!want) return {};
  const now = useOf(e);
  return {
    ...(want.account !== now.account ? { claudeConfigDir: want.account || null } : {}),
    ...(want.model.trim() !== now.model ? { model: want.model.trim() || null } : {}),
    ...(want.effort !== now.effort ? { effort: want.effort || null } : {}),
  };
}

/** The same thing set for many at once: `part` names what (an account, a model, an effort); the rest of each stays. */
export function setForMany(drafts: Record<string, Use>, employees: Who[], ids: Iterable<string>, part: Partial<Use>): Record<string, Use> {
  const chosen = new Set(ids);
  const next = { ...drafts };
  for (const e of employees) if (chosen.has(e.id)) next[e.id] = { ...(drafts[e.id] ?? useOf(e)), ...part };
  return next;
}

/** Whose draft differs from what they have, and in what — for the bar that applies it. */
export function pending(drafts: Record<string, Use>, employees: Who[]): Array<{ id: string; patch: ReturnType<typeof usePatch> }> {
  return employees.map((e) => ({ id: e.id, patch: usePatch(e, drafts[e.id]) })).filter((x) => Object.keys(x.patch).length > 0);
}

/** "3 employees: account, model" — what the bar says is unsaved. */
export function pendingWords(changes: Array<{ patch: Record<string, unknown> }>): string {
  if (!changes.length) return '';
  const what = [changes.some((c) => 'claudeConfigDir' in c.patch) ? 'account' : '', changes.some((c) => 'model' in c.patch) ? 'model' : '', changes.some((c) => 'effort' in c.patch) ? 'effort' : ''].filter(Boolean);
  return `${changes.length} employee${changes.length === 1 ? '' : 's'}: ${what.join(', ')}`;
}
