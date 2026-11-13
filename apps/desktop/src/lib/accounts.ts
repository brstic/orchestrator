import type { AccountProvider } from '@orchestrator/contracts';

/**
 * How a Claude account is called for people, everywhere it is named: by who is signed in to it — never by the name
 * of its folder when anything better is known — and what the terminal of a sign-in says, read for what to do next.
 */

export interface NamedAccount {
  configDir: string | null;
  email?: string | null;
  provider?: AccountProvider | null;
  endpoint?: string | null;
}

/** "Z.AI" for theirs; another service by its address. Null: Anthropic's own (a Claude login). */
export function providerName(a: Pick<NamedAccount, 'provider' | 'endpoint'>): string | null {
  if (a.provider === 'zai') return 'Z.AI';
  if (a.provider === 'custom') return a.endpoint || 'Another service';
  return null;
}

/**
 * The name of an account: the e-mail address signed in to it; for another service, the service; on a member's own
 * computer before anything is known, "Mila's Claude"; and only when nothing else is known, the folder.
 */
export function accountName(a: NamedAccount, host?: { memberId?: string | null; memberName?: string | null } | null): string {
  if (a.email) return a.email;
  const service = providerName(a);
  if (service) return service;
  if (host?.memberId) return `${host.memberName ?? 'Member'}'s Claude`;
  return a.configDir ? NOT_SIGNED_IN : 'Default login';
}

/** What an account is called while nobody is known to be signed in to it; where it is stands under the name. */
export const NOT_SIGNED_IN = 'Not signed in yet';

/** What stands under the name, quietly: the organisation, and where the account is on the machine. */
export function accountWhere(a: NamedAccount & { organization?: string | null }): string {
  return [a.organization, a.configDir ?? 'the machine\'s default login'].filter((x) => !!x).join(' · ');
}

/**
 * The accounts of one machine, for choosing one in an employee's settings: the default login first, then the rest by
 * name. Each says its name and, when two have the same name, where it is.
 */
export function accountChoices<T extends NamedAccount & { hostId: string }>(accounts: T[], hostId: string | null | undefined, host?: { memberId?: string | null; memberName?: string | null } | null): Array<{ value: string; label: string }> {
  const mine = accounts.filter((a) => a.hostId === hostId);
  const rows = mine.map((a) => ({ value: a.configDir ?? '', name: accountName(a, host), dir: a.configDir }));
  if (!rows.some((r) => r.value === '')) rows.push({ value: '', name: accountName({ configDir: null }, host), dir: null });
  const count = new Map<string, number>();
  for (const r of rows) count.set(r.name, (count.get(r.name) ?? 0) + 1);
  return rows
    .sort((x, y) => Number(y.value === '') - Number(x.value === '') || x.name.localeCompare(y.name))
    .map((r) => ({ value: r.value, label: r.value === '' ? `${r.name}${r.name === 'Default login' ? '' : ' (default)'}` : (count.get(r.name) ?? 0) > 1 || r.name === NOT_SIGNED_IN ? `${r.name} (${r.dir})` : r.name }));
}

/**
 * The link a sign-in's terminal is showing, if it shows one: Claude Code prints the address of the sign-in page and
 * waits for the code that page gives. Lines of a terminal are cut at its width, so a long address arrives in pieces.
 */
export function signInLink(lines: string[]): string | null {
  const at = lines.findIndex((l) => /https:\/\/\S*(oauth|authorize|login)/i.test(l));
  if (at < 0) return null;
  const first = /https:\/\/\S+/.exec(lines[at]!)![0];
  let url = first;
  // It goes on in the next line only when it ran to the end of this one, and the next line is nothing but more of it.
  if (lines[at]!.trimEnd().endsWith(first)) {
    for (let i = at + 1; i < lines.length; i++) {
      const next = lines[i]!.trim();
      if (!next || !/^[A-Za-z0-9%&=._~+\-/?#:@!$'()*,;]+$/.test(next) || /^https?:/.test(next)) break;
      url += next;
    }
  }
  return url;
}
