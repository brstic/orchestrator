/**
 * "Mine" and "Everyone": the one switch the lists of the office share (Team, Tasks, Projects), remembered on this
 * computer, and the small badge that says whose a row is. What "mine" means is in `lib/mine.ts`.
 */
import { create } from 'zustand';
import { Badge } from '@orchestrator/ui';
import { useOffice } from '../lib/store.ts';
import { hasOwn, whoseLabel, type Scope, type Whose } from '../lib/mine.ts';

const KEY = 'orch.scope';
const read = (): Scope => {
  try {
    return localStorage.getItem(KEY) === 'all' ? 'all' : 'mine';
  } catch {
    return 'mine';
  }
};

const useScopeStore = create<{ scope: Scope; set: (scope: Scope) => void }>((set) => ({
  scope: read(),
  set: (scope) => {
    try {
      localStorage.setItem(KEY, scope);
    } catch {
      /* a window that may not keep anything: the choice lasts while it is open */
    }
    set({ scope });
  },
}));

/** The scope the lists show, and whether this person has anything of their own to narrow them to. */
export function useScope(): { scope: Scope; own: boolean; setScope: (scope: Scope) => void } {
  const scope = useScopeStore((s) => s.scope);
  const setScope = useScopeStore((s) => s.set);
  const own = useOffice((s) => hasOwn(s.hosts, s.me));
  return { scope: own ? scope : 'all', own, setScope };
}

/** The switch itself; nothing for someone with no machines of their own (everything they see is the office's). */
export function ScopeSwitch({ what }: { what: string }) {
  const { scope, own, setScope } = useScope();
  if (!own) return null;
  return (
    <div className="seg scope-switch" role="tablist" aria-label={`Whose ${what} to show`}>
      <button role="tab" aria-selected={scope === 'mine'} className={scope === 'mine' ? 'seg-on' : ''} onClick={() => setScope('mine')} title={`Only your own ${what}: what is on your computers and servers`}>
        Mine
      </button>
      <button role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'seg-on' : ''} onClick={() => setScope('all')} title={`The whole office's ${what}, yours first`}>
        Everyone
      </button>
    </div>
  );
}

/** Whose a row is. */
export function WhoseBadge({ whose }: { whose: Whose }) {
  return (
    <Badge tone={whose.kind === 'mine' ? 'accent' : whose.kind === 'shared' ? 'muted' : 'info'} title={whose.kind === 'mine' ? 'On your own computer or server' : whose.kind === 'shared' ? "On the office's shared machines" : `On ${whose.name}'s own computer`}>
      {whoseLabel(whose)}
    </Badge>
  );
}
