/**
 * Context (`docs/CONTEXT.md`): what every employee always knows. Short facts in layers — the office, a project, a role,
 * a client, one employee's own notes — that the office keeps in front of each employee whoever they talk to: given
 * when a session starts, again after every compaction, and as the change at their next prompt.
 *
 * Here: the facts of each layer (add, change, keep on demand, keep from clients, archive), what employees proposed,
 * who holds which version, and exactly what one employee is given.
 */
import { useEffect, useMemo, useState } from 'react';
import { CONTEXT_BUDGET_CHARS, ROLE_CATALOGUE, type ContextFact, type ContextLayer } from '@orchestrator/contracts';
import { Button, Tabs, Window, timeAgo } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { act, ask } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { onActivate } from './company-shared.tsx';
import { More } from './kit.tsx';

interface Change {
  id: string;
  factId: string;
  at: string;
  by: string;
  what: string;
  title: string;
  layer: ContextLayer;
}
interface Holder {
  employeeId: string;
  name: string;
  holds: string | null;
  current: string;
}
interface View {
  facts: ContextFact[];
  history: Change[];
  sessions: Holder[];
  straightIn: ContextLayer[];
}

type Tab = 'office' | 'project' | 'role' | 'client' | 'self' | 'proposals' | 'holders';
const ABOUT: Record<ContextLayer, string> = {
  office: 'Everybody holds these — rented employees too, but for facts you keep from clients.',
  project: 'Everybody working on the project (or building on it) holds these.',
  role: 'Everybody with the role holds these.',
  client: "The employees this client rents get these with every message of the client's.",
  self: "One employee's own notes — what they are in the middle of. They write them themselves too (propose_context), straight in.",
};
/** Who wrote a fact, in words: a person, an employee, or what the office offered it from. */
const who = (by: string) =>
  by.startsWith('meeting:') ? 'a meeting' : by.startsWith('lesson:') ? 'a lesson the office follows' : by.startsWith('answer:') ? "the boss's answer" : by.startsWith('import:') ? 'what the office already knew' : by.replace(/^member:/, '').replace(/^employee:/, '').replace(/^owner$/, 'the owner');

function FactEditor({ fact, layer, scope, onDone }: { fact: ContextFact | null; layer: ContextLayer; scope: string | null; onDone: () => void }) {
  const [title, setTitle] = useState(fact?.title ?? '');
  const [text, setText] = useState(fact?.text ?? '');
  const [always, setAlways] = useState(fact?.always ?? true);
  const [hidden, setHidden] = useState(!!fact?.notForClients);
  const [review, setReview] = useState(fact?.reviewBy?.slice(0, 10) ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!title.trim() || !text.trim() || busy) return;
    setBusy(true);
    const body = { title: title.trim(), text: text.trim(), always, notForClients: hidden, reviewBy: review || null };
    const ok = await act(() => (fact ? api('PATCH', `/context/facts/${fact.id}`, body) : api('POST', '/context/facts', { ...body, layer, scope })), fact ? 'Changed — everyone concerned gets it at their next prompt' : 'Added — everyone concerned gets it at their next prompt');
    setBusy(false);
    if (ok) onDone();
  };
  return (
    <form
      className="ctx-edit"
      data-context-edit={fact?.id ?? 'new'}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="A few words: what it is (“How we deploy”)" maxLength={80} aria-label="Title" autoFocus={!fact} />
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="The fact, short and standing on its own. Never a password — name the vault entry." maxLength={2000} rows={3} aria-label="The fact" />
      <div className="ctx-edit-row">
        <div className="k-filters" role="group" aria-label="Where it stands">
          <button type="button" className={always ? 'k-filter-on' : ''} aria-pressed={always} onClick={() => setAlways(true)} title="In front of every employee concerned, always">
            Always
          </button>
          <button type="button" className={!always ? 'k-filter-on' : ''} aria-pressed={!always} onClick={() => setAlways(false)} title="Not in front of them: found with get_context when they need it">
            On demand
          </button>
        </div>
        {layer === 'office' && (
          <label className="check small">
            <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
            Keep from rented employees
          </label>
        )}
        <label className="small ctx-review">
          Look again by <input type="date" value={review} onChange={(e) => setReview(e.target.value)} aria-label="Look again by" />
        </label>
      </div>
      <div className="k-actions">
        <Button small variant="primary" type="submit" disabled={busy || !title.trim() || !text.trim()} data-context-save>
          {fact ? 'Save' : 'Add the fact'}
        </Button>
        <Button small variant="ghost" type="button" onClick={onDone}>
          Cancel
        </Button>
        <span className="grow" />
        {fact && (
          <Button
            small
            variant="ghost"
            className="k-quiet"
            type="button"
            onClick={async () => {
              if (!(await ask({ title: `Archive “${fact.title}”?`, body: 'Nobody holds it from their next prompt on; it stays in the history.', ok: 'Archive' }))) return;
              if (await act(() => api('DELETE', `/context/facts/${fact.id}`), 'Archived')) onDone();
            }}
          >
            Archive
          </Button>
        )}
      </div>
    </form>
  );
}

function FactRow({ f, open, onToggle, reload }: { f: ContextFact; open: boolean; onToggle: () => void; reload: () => void }) {
  const late = !!f.reviewBy && f.reviewBy.slice(0, 10) < new Date().toISOString().slice(0, 10);
  return (
    <div data-context-fact={f.title}>
      <div className="k-row k-row-sm k-row-click" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle} onKeyDown={(e) => e.target === e.currentTarget && onActivate(onToggle)(e)}>
        <div className="k-main">
          <div className="k-title-sm">{f.title}</div>
          <div className="k-sub ctx-text">{f.text}</div>
        </div>
        {!f.always && <span className="k-aside">on demand</span>}
        {f.notForClients && <span className="k-aside">not for clients</span>}
        {late && <span className="k-aside k-warn">look again</span>}
        <span className="k-chev" aria-hidden />
      </div>
      {open && (
        <div className="k-detail">
          <div className="k-sub">
            {f.createdBy === f.updatedBy ? `By ${who(f.createdBy)}` : `By ${who(f.createdBy)}, last changed by ${who(f.updatedBy)}`} · {timeAgo(f.updatedAt)}
          </div>
          <FactEditor
            fact={f}
            layer={f.layer}
            scope={f.scope}
            onDone={() => {
              onToggle();
              reload();
            }}
          />
        </div>
      )}
    </div>
  );
}

function Layer({ view, layer, scope, scopes, onScope, reload, onImported }: { view: View; layer: ContextLayer; scope: string | null; scopes?: Array<{ id: string; label: string }>; onScope?: (id: string) => void; reload: () => void; onImported?: () => void }) {
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const facts = view.facts.filter((f) => f.layer === layer && f.status === 'active' && (layer === 'office' || f.scope === scope));
  const size = facts.filter((f) => f.always).reduce((n, f) => n + f.title.length + f.text.length + 10, 0);
  const share = layer === 'office' ? 0.5 : 0.3;
  return (
    <div className="k-stack" data-context-layer={layer}>
      <div className="ctx-top">
        <div className="k-text">{ABOUT[layer]}</div>
        {!adding && (
          <Button variant="primary" onClick={() => setAdding(true)} disabled={layer !== 'office' && !scope} data-context-add>
            Add a fact
          </Button>
        )}
      </div>
      {layer === 'office' && (
        <div className="ctx-import">
          <span className="k-sub">Start from what the office already knows: each employee's standing instructions, each project's description and goals, the lessons the office follows — offered as proposals, to take in what holds.</span>
          <Button
            small
            onClick={async () => {
              const r = await act(() => api<{ offered: number }>('POST', '/context/import', {}));
              if (!r) return;
              useOffice.getState().toast(r.offered ? `${r.offered} proposal${r.offered === 1 ? '' : 's'} to look at` : 'Nothing new to offer: it was all offered before', r.offered ? 'success' : 'info');
              reload();
              if (r.offered) onImported?.();
            }}
            data-context-import
          >
            Import what the office knows
          </Button>
        </div>
      )}
      {scopes && (
        <select value={scope ?? ''} onChange={(e) => onScope?.(e.target.value)} aria-label="Which" className="ctx-scope">
          {!scope && <option value="">Choose…</option>}
          {scopes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
              {view.facts.some((f) => f.layer === layer && f.scope === s.id && f.status === 'active') ? ` · ${view.facts.filter((f) => f.layer === layer && f.scope === s.id && f.status === 'active').length}` : ''}
            </option>
          ))}
        </select>
      )}
      {adding && (
        <div className="k-sheet">
          <FactEditor
            fact={null}
            layer={layer}
            scope={scope}
            onDone={() => {
              setAdding(false);
              reload();
            }}
          />
        </div>
      )}
      {(layer === 'office' || scope) && (
        <div className="k-section">
          <span className="k-label">
            {facts.length} fact{facts.length === 1 ? '' : 's'} · {size.toLocaleString()} characters always held
            {size > CONTEXT_BUDGET_CHARS * share ? <span className="k-warn"> — a lot: keep it short, or move some on demand</span> : ''}
          </span>
          {facts.length ? (
            <div className="k-group">
              {facts.map((f) => (
                <FactRow key={f.id} f={f} open={open === f.id} onToggle={() => setOpen((o) => (o === f.id ? null : f.id))} reload={reload} />
              ))}
            </div>
          ) : (
            <div className="k-text">Nothing here yet.</div>
          )}
        </div>
      )}
    </div>
  );
}

function Proposals({ view, reload, names }: { view: View; reload: () => void; names: (layer: ContextLayer, scope: string | null) => string }) {
  const proposed = view.facts.filter((f) => f.status === 'proposed');
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const all = proposed.length > 1 && (
    <div className="k-actions">
      <span className="k-sub grow">{proposed.length} proposals. Look through them; take in what holds.</span>
      <Button
        small
        onClick={async () => {
          if (!(await ask({ title: `Take in all ${proposed.length}?`, body: 'Every employee concerned holds them from their next prompt. You can change or archive any of them afterwards.', ok: 'Take in all' }))) return;
          for (const f of proposed) await api('POST', `/context/facts/${f.id}/accept`, {}).catch(() => undefined);
          reload();
        }}
        data-context-accept-all
      >
        Take in all
      </Button>
    </div>
  );
  if (!proposed.length) return <div className="k-empty"><div className="k-title">Nothing proposed</div><div className="k-text">When an employee proposes a fact for the office, a role or a client, it waits here. Their own notes and their project's state go in at once ({view.straightIn.join(', ')}).</div></div>;
  return (
    <div className="k-stack">
    {all}
    <div className="k-group" data-context-proposals>
      {proposed.map((f) => (
        <div key={f.id} className="k-row ctx-proposal" data-context-proposal={f.title}>
          <div className="k-main">
            <div className="k-title-sm">
              {f.title} <span className="k-title-note">for {names(f.layer, f.scope)} · from {who(f.createdBy)}</span>
            </div>
            {editing === f.id ? <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} aria-label="The fact" /> : <div className="k-sub ctx-text">{f.text}</div>}
          </div>
          <div className="k-actions ctx-proposal-actions">
            <Button small variant="primary" onClick={() => void act(() => api('POST', `/context/facts/${f.id}/accept`, editing === f.id ? { text } : {}), 'Taken in').then(() => (setEditing(null), reload()))} data-context-accept>
              {editing === f.id ? 'Save and take in' : 'Take in'}
            </Button>
            {editing !== f.id && (
              <Button small variant="ghost" onClick={() => (setEditing(f.id), setText(f.text))}>
                Edit
              </Button>
            )}
            <Button small variant="ghost" className="k-quiet" onClick={() => void act(() => api('POST', `/context/facts/${f.id}/drop`, {}), 'Dropped').then(reload)}>
              Drop
            </Button>
          </div>
        </div>
      ))}
    </div>
    </div>
  );
}

function Holders({ view }: { view: View }) {
  const [showing, setShowing] = useState<string | null>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    if (!showing) return;
    void api<{ text: string }>('GET', `/context/pack/${showing}`).then((r) => setText(r.text), () => setText(''));
  }, [showing]);
  return (
    <div className="k-stack" data-context-holders>
      <div className="k-text">Every running session, and the version it holds. A change reaches a session at its next prompt; a session that starts or is compacted gets everything.</div>
      {view.sessions.length ? (
        <div className="k-group">
          {view.sessions.map((s) => (
            <div key={s.employeeId}>
              <div className="k-row k-row-sm" data-context-holder={s.name}>
                <span className={`k-dot ${s.holds === s.current ? '' : 'k-dot-busy'}`} aria-hidden />
                <div className="k-main">
                  <div className="k-title-sm">{s.name}</div>
                  <div className="k-sub">{s.holds === s.current ? `holds the current version (${s.current})` : s.holds ? `holds ${s.holds} — gets ${s.current} at their next prompt` : `gets ${s.current} at their next prompt`}</div>
                </div>
                <Button small variant="ghost" onClick={() => setShowing(showing === s.employeeId ? null : s.employeeId)} data-context-show={s.name}>
                  {showing === s.employeeId ? 'Hide' : 'What they know'}
                </Button>
              </div>
              {showing === s.employeeId && <pre className="ctx-pack" data-context-pack>{text || 'Loading…'}</pre>}
            </div>
          ))}
        </div>
      ) : (
        <div className="k-text">Nobody is at work right now.</div>
      )}
    </div>
  );
}

function ContextPanel({ arg, onClose }: { arg: string | null; onClose: () => void }) {
  const owner = useOffice((s) => s.me?.kind === 'owner');
  const projects = useOffice((s) => s.projects);
  const employees = useOffice((s) => s.employees);
  const [view, setView] = useState<View | null>(null);
  const [clients, setClients] = useState<Array<{ id: string; name: string }>>([]);
  const [tab, setTab] = useState<Tab>((arg as Tab) || 'office');
  const [scopes, setScopes] = useState<Record<string, string>>({});
  const load = () => api<View>('GET', '/context').then(setView, () => undefined);
  useEffect(() => {
    void load();
    if (owner) void api<{ clients: Array<{ id: string; name: string; revokedAt: string | null }> }>('GET', '/rent').then((r) => setClients(r.clients.filter((c) => !c.revokedAt)), () => undefined);
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, [owner]);
  const lists = useMemo(
    () => ({
      project: Object.values(projects)
        .filter((p) => p.status !== 'archived')
        .map((p) => ({ id: p.id, label: p.name })),
      role: ROLE_CATALOGUE.map((r) => ({ id: r.key, label: r.title })),
      client: clients.map((c) => ({ id: c.id, label: c.name })),
      self: Object.values(employees)
        .filter((e) => !e.archived)
        .map((e) => ({ id: e.id, label: e.name })),
    }),
    [projects, employees, clients],
  );
  const names = (layer: ContextLayer, scope: string | null) => {
    const label = (lists[layer as keyof typeof lists] ?? []).find((x) => x.id === scope)?.label ?? '';
    return layer === 'office' ? 'the office' : layer === 'self' ? `${label}'s own notes` : `${layer} ${label}`.trim();
  };
  const proposals = view?.facts.filter((f) => f.status === 'proposed').length ?? 0;
  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'office', label: 'Office' },
    { id: 'project', label: 'Projects' },
    { id: 'role', label: 'Roles' },
    ...(owner ? [{ id: 'client' as Tab, label: 'Clients' }] : []),
    { id: 'self', label: 'Employees' },
    { id: 'proposals', label: 'Proposals', count: proposals },
    { id: 'holders', label: 'Who holds it' },
  ];
  return (
    <Window kit flush title="Context" subtitle="What every employee always knows — whoever they talk to" onClose={onClose} width={780}>
      <Tabs<Tab> value={tab} onChange={setTab} tabs={tabs} />
      <div className="k-body ctx-body" data-context-tab={tab}>
        {!view ? (
          <div className="k-text">Loading…</div>
        ) : tab === 'proposals' ? (
          <Proposals view={view} reload={() => void load()} names={names} />
        ) : tab === 'holders' ? (
          <Holders view={view} />
        ) : (
          <>
            <Layer onImported={() => setTab('proposals')} view={view} layer={tab} scope={tab === 'office' ? null : (scopes[tab] ?? lists[tab as keyof typeof lists]?.[0]?.id ?? null)} scopes={tab === 'office' ? undefined : lists[tab as keyof typeof lists]} onScope={(id) => setScopes((s) => ({ ...s, [tab]: id }))} reload={() => void load()} />
            <More summary={`Recent changes (${view.history.length})`}>
              <div className="ctx-history">
                {[...view.history].reverse().slice(0, 40).map((h) => (
                  <div key={h.id} className="k-sub">
                    {timeAgo(h.at)} · {who(h.by)} {h.what} “{h.title}” ({h.layer})
                  </div>
                ))}
              </div>
            </More>
          </>
        )}
      </div>
    </Window>
  );
}

registerPanel('context', ContextPanel);
