/**
 * The vault window's words and arrangement (`hud/panels/vault.tsx`; docs/VAULT.md). Pure: no store, no window.
 */
export type Kind = 'password' | 'api_key' | 'token' | 'ssh_key' | 'other';

interface Actor {
  kind: 'owner' | 'member' | 'employee' | 'office';
  name: string;
}

/** What the office's list says about one credential: never its value. */
export interface VaultEntry {
  id: string;
  name: string;
  kind: Kind;
  service: string;
  username: string;
  description: string;
  source: 'added' | 'stored' | 'captured' | 'noticed';
  createdAt: string;
  createdBy: Actor;
  updatedAt?: string;
  uses: number;
  lastUsedAt: string | null;
  lastUsedBy: Actor | null;
  length: number;
}

export const KINDS: Array<[Kind, string]> = [
  ['password', 'Password'],
  ['api_key', 'API key'],
  ['token', 'Token'],
  ['ssh_key', 'Private key'],
  ['other', 'Other'],
];
export const KIND_LABEL = Object.fromEntries(KINDS) as Record<Kind, string>;
export const KIND_MANY: Record<Kind, string> = {
  password: 'Passwords',
  api_key: 'API keys',
  token: 'Tokens',
  ssh_key: 'Private keys',
  other: 'Other',
};

/** How a credential is named in a message or a task. */
export const placeholderFor = (name: string): string => `{{vault:${name}}}`;
/** How a command in an employee's session takes it (the value goes into the command, not the conversation). */
export const commandFor = (name: string): string => `$("$ORCH_VAULT" get ${name})`;

/** How it got here, in a few words. */
export function origin(e: Pick<VaultEntry, 'source' | 'createdBy'>): string {
  const who = e.createdBy.kind === 'office' ? 'the office' : e.createdBy.name;
  if (e.source === 'captured') return `taken out of a message from ${who}`;
  if (e.source === 'noticed') return `seen in ${who}'s session`;
  if (e.source === 'stored') return `stored by ${who}`;
  return `added by ${who}`;
}

/** "Used 3 times, last by Ava 2h ago", or that it has not been. `ago` is the app's `timeAgo`. */
export function usedLine(e: Pick<VaultEntry, 'uses' | 'lastUsedAt' | 'lastUsedBy'>, ago: (iso: string) => string = defaultAgo): string {
  if (!e.uses) return 'Not used yet';
  const times = e.uses === 1 ? 'once' : `${e.uses} times`;
  return `Used ${times}${e.lastUsedBy ? `, last by ${e.lastUsedBy.name}` : ''}${e.lastUsedAt ? ` ${ago(e.lastUsedAt)}` : ''}`;
}

function defaultAgo(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Does it match what was typed into the search box: its name, what it opens, the login, the note or the kind. */
export function matches(e: Pick<VaultEntry, 'name' | 'service' | 'username' | 'description' | 'kind'>, search: string): boolean {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${e.name} ${e.service} ${e.username} ${e.description} ${KIND_LABEL[e.kind]} ${KIND_MANY[e.kind]}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** How many of each kind there are, in the order of `KINDS`, only those there are. */
export function kindCounts(entries: readonly Pick<VaultEntry, 'kind'>[]): Array<{ kind: Kind; n: number }> {
  return KINDS.map(([kind]) => ({
    kind,
    n: entries.filter((e) => e.kind === kind).length,
  })).filter((x) => x.n > 0);
}

/**
 * The boxes by what they open: one shelf per service ("github.com"), the shelves in alphabetical order, and what opens
 * nothing named last ("Other"). Within a shelf, by name.
 */
export function byService<T extends Pick<VaultEntry, 'service' | 'name'>>(entries: readonly T[]): Array<{ label: string; rows: T[] }> {
  const shelves = new Map<string, { label: string; rows: T[] }>();
  for (const e of entries) {
    const label = e.service.trim() || 'Other';
    const key = e.service.trim() ? label.toLowerCase() : '￿';
    if (!shelves.has(key)) shelves.set(key, { label, rows: [] });
    shelves.get(key)!.rows.push(e);
  }
  return [...shelves.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, s]) => ({
      label: s.label,
      rows: [...s.rows].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}
