import { useEffect, useMemo, useState } from 'react';
import { EFFORT_CHOICES, MODEL_CHOICES, type Employee, type Host } from '@orchestrator/contracts';
import { Avatar, Button } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { accountChoices } from '../../lib/accounts.ts';
import { useAccess } from '../../lib/access.ts';
import { loadAccounts, useOffice } from '../../lib/store.ts';
import { pending, pendingWords, setForMany, useOf, type Use } from '../../lib/who-uses.ts';

/**
 * Who is on which Claude account and thinks with what (Company → Claude; docs/ACCOUNTS.md, "Who is on what").
 * Every employee is a line with three choices — account, model, effort. Ticking several and choosing in the bar
 * above sets the same for all of them. Nothing is asked of the office until **Apply**: a change of account, model
 * or effort starts a running session again, and that is not something to do by a slip of the hand.
 */

const KEEP = '\u0000keep';

function modelOptions(now: string): Array<{ value: string; label: string }> {
  const known = MODEL_CHOICES.map((c) => ({ value: c.value, label: c.label }));
  // A model named in full in their settings is offered as it is.
  return [{ value: '', label: 'Default' }, ...known, ...(now && !known.some((k) => k.value === now) ? [{ value: now, label: now }] : [])];
}

function effortOptions(host: Host | undefined, now: string): Array<{ value: string; label: string }> {
  const levels = host?.info ? (host.info.claudeEffortLevels ?? null) : undefined;
  return [{ value: '', label: 'Default' }, ...EFFORT_CHOICES.filter((c) => !levels || levels.includes(c.value) || c.value === now).map((c) => ({ value: c.value as string, label: c.label }))];
}

export function WhoUsesWhat() {
  const employeesById = useOffice((s) => s.employees);
  const hosts = useOffice((s) => s.hosts);
  const accounts = useOffice((s) => s.accounts);
  const [drafts, setDrafts] = useState<Record<string, Use>>({});
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [find, setFind] = useState('');
  const [busy, setBusy] = useState(false);
  const can = useAccess();
  useEffect(() => {
    void loadAccounts();
  }, []);

  const everyone = useMemo(
    () =>
      Object.values(employeesById)
        .filter((e) => !e.archived && !!e.hostId && !!hosts[e.hostId])
        .sort((a, b) => a.name.localeCompare(b.name)),
    [employeesById, hosts],
  );
  const words = find.trim().toLowerCase();
  const shown = words ? everyone.filter((e) => `${e.name} ${e.title} ${hosts[e.hostId!]?.name ?? ''}`.toLowerCase().includes(words)) : everyone;
  // Machine by machine: the office's own first, then members' computers.
  const groups = useMemo(() => {
    const by = new Map<string, Employee[]>();
    for (const e of shown) by.set(e.hostId!, [...(by.get(e.hostId!) ?? []), e]);
    return [...by.entries()].map(([hostId, list]) => ({ host: hosts[hostId]!, list })).sort((x, y) => Number(!!x.host.memberId) - Number(!!y.host.memberId) || x.host.name.localeCompare(y.host.name));
  }, [shown, hosts]);

  const changes = pending(drafts, everyone);
  const picked = everyone.filter((e) => chosen.has(e.id));
  // An account is a folder on one machine: it can be set for many only when they are all on the same one.
  const oneHost = picked.length > 0 && picked.every((e) => e.hostId === picked[0]!.hostId) ? hosts[picked[0]!.hostId!] : undefined;
  const set = (ids: string[], part: Partial<Use>) => setDrafts((d) => setForMany(d, everyone, ids, part));
  const toggle = (ids: string[], on: boolean) =>
    setChosen((cur) => {
      const next = new Set(cur);
      for (const id of ids) (on ? next.add(id) : next.delete(id));
      return next;
    });

  const apply = async () => {
    setBusy(true);
    let done = 0;
    const failed: string[] = [];
    for (const c of changes) {
      try {
        await api('PATCH', `/employees/${c.id}`, c.patch);
        done++;
      } catch (e) {
        failed.push(`${employeesById[c.id]?.name ?? 'somebody'}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
    const toast = useOffice.getState().toast;
    if (done) toast(`${done} employee${done === 1 ? '' : 's'} changed`, 'success');
    if (failed.length) toast(failed.slice(0, 3).join(' · '), 'error');
    // What was applied is what they have now; what was refused stays in the table to be looked at.
    if (!failed.length) {
      setDrafts({});
      setChosen(new Set());
    }
    await loadAccounts();
  };

  // An owner's table: putting people on accounts is theirs to do.
  if (!can.admin || everyone.length === 0) return null;
  return (
    <div className="use" data-who-uses>
      <div className="row" style={{ gap: 10, marginBottom: 8 }}>
        <span className="strong use-title">Who is on what</span>
        <span className="small faint use-about">Put people on accounts and choose their model and effort — one by one, or tick several and set them together.</span>
        {everyone.length > 8 && <input className="use-find" value={find} onChange={(ev) => setFind(ev.target.value)} placeholder="Find…" aria-label="Find an employee" spellCheck={false} />}
      </div>

      {picked.length > 0 && (
        <div className="use-bulk" data-use-bulk>
          <span className="small">
            <b>{picked.length}</b> chosen — set for all of them:
          </span>
          <select
            aria-label="Account for the chosen"
            value={KEEP}
            disabled={!oneHost}
            title={oneHost ? undefined : 'The chosen are on different machines, and an account is on one machine: choose people of one machine to set their account together.'}
            onChange={(ev) => ev.target.value !== KEEP && set([...chosen], { account: ev.target.value })}
          >
            <option value={KEEP}>{oneHost ? 'Account…' : 'Account (one machine at a time)'}</option>
            {oneHost && accountChoices(accounts, oneHost.id, oneHost).map((c) => <option key={c.value || 'default'} value={c.value}>{c.label}</option>)}
          </select>
          <select aria-label="Model for the chosen" value={KEEP} onChange={(ev) => ev.target.value !== KEEP && set([...chosen], { model: ev.target.value })}>
            <option value={KEEP}>Model…</option>
            {modelOptions('').map((c) => <option key={c.value || 'default'} value={c.value}>{c.label}</option>)}
          </select>
          <select aria-label="Effort for the chosen" value={KEEP} onChange={(ev) => ev.target.value !== KEEP && set([...chosen], { effort: ev.target.value })}>
            <option value={KEEP}>Effort…</option>
            {effortOptions(undefined, '').map((c) => <option key={c.value || 'default'} value={c.value}>{c.label}</option>)}
          </select>
          <button type="button" className="k-quiet" onClick={() => setChosen(new Set())}>
            Clear
          </button>
        </div>
      )}

      {groups.map(({ host, list }) => {
        const ids = list.map((e) => e.id);
        const all = ids.every((id) => chosen.has(id));
        const choices = accountChoices(accounts, host.id, host);
        return (
          <div key={host.id} className="use-group" data-use-machine={host.name}>
            <label className="use-row use-head">
              <input type="checkbox" checked={all} onChange={(ev) => toggle(ids, ev.target.checked)} aria-label={`Everybody on ${host.name}`} />
              <span className="small">
                <span className="strong">{host.name}</span> <span className="faint">· {list.length}</span>
              </span>
              <span className="small faint">Account</span>
              <span className="small faint">Model</span>
              <span className="small faint">Effort</span>
            </label>
            {list.map((e) => {
              const now = useOf(e);
              const d = drafts[e.id] ?? now;
              const changed = (k: keyof Use) => (d[k] !== now[k] ? ' use-changed' : '');
              // An account they are on that the list does not know (a folder typed by hand) is still theirs to keep.
              const mine = choices.some((c) => c.value === d.account) ? choices : [...choices, { value: d.account, label: d.account }];
              return (
                <div key={e.id} className="use-row" data-use-employee={e.name}>
                  <input type="checkbox" checked={chosen.has(e.id)} onChange={(ev) => toggle([e.id], ev.target.checked)} aria-label={`Choose ${e.name}`} />
                  <span className="use-who">
                    <Avatar appearance={e.appearance} size={22} />
                    <span className="truncate">
                      <span className="strong">{e.name}</span> <span className="small faint">{e.title}</span>
                    </span>
                  </span>
                  <select className={`use-select${changed('account')}`} aria-label={`${e.name}'s account`} value={d.account} onChange={(ev) => set([e.id], { account: ev.target.value })}>
                    {mine.map((c) => <option key={c.value || 'default'} value={c.value}>{c.label}</option>)}
                  </select>
                  <select className={`use-select${changed('model')}`} aria-label={`${e.name}'s model`} value={d.model} onChange={(ev) => set([e.id], { model: ev.target.value })}>
                    {modelOptions(d.model).map((c) => <option key={c.value || 'default'} value={c.value}>{c.label}</option>)}
                  </select>
                  <select className={`use-select${changed('effort')}`} aria-label={`${e.name}'s effort`} value={d.effort} onChange={(ev) => set([e.id], { effort: ev.target.value })}>
                    {effortOptions(host, d.effort).map((c) => <option key={c.value || 'default'} value={c.value}>{c.label}</option>)}
                  </select>
                </div>
              );
            })}
          </div>
        );
      })}
      {shown.length === 0 && <div className="small faint">Nobody is called that.</div>}

      <div className="use-save" data-use-save>
        <div className="small" style={{ flex: 1 }}>
          {changes.length ? (
            <>
              <b>Unsaved — {pendingWords(changes)}.</b> A change of account, model or effort starts a running session again with the same conversation: at once if they are between turns, otherwise when their turn ends.
            </>
          ) : (
            <span className="faint">Nothing is changed.</span>
          )}
        </div>
        <Button small variant="ghost" className="k-quiet" disabled={!changes.length || busy} onClick={() => setDrafts({})}>
          Discard
        </Button>
        <Button small variant="primary" disabled={!changes.length || busy} onClick={() => void apply()} data-use-apply>
          {busy ? 'Applying…' : changes.length ? `Apply to ${changes.length}` : 'Apply'}
        </Button>
      </div>
    </div>
  );
}
