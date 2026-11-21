/**
 * Access → Rent (`docs/RENT.md`): the owner rents employees out. Clients never come into the office; they get a link,
 * set a password, and talk to the employees they rent on the Rent portal at the office's address.
 *
 * Here: who rents whom (one line per client), making a client and their link, and — opening a client — their
 * employees with what each may do (switched live), another employee for them, the conversation they have with each
 * (read-only), a new link, and ending it all.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Appearance, RentLine, RentPerms } from '@orchestrator/contracts';
import { RENT_PERMS_DEFAULT, matchesWords, searchWords, snippetOf } from '@orchestrator/contracts';
import { Avatar, Button, Markdown, clock, timeAgo } from '@orchestrator/ui';
import { api, apiBlob } from '../../lib/api.ts';
import { Marked, useFoundMarks, useSettled } from '../../lib/found.tsx';
import { act, ask } from '../core.tsx';
import { copyText, onActivate } from './company-shared.tsx';
import { PickMany } from './kit.tsx';

interface Agent {
  employeeId: string;
  since: string;
  perms: RentPerms;
  name: string;
  title: string;
  appearance: Appearance | null;
  workingDir: string | null;
  state: string;
  /** On the owner's own computer: they work while it is connected. */
  mine?: boolean;
  online?: boolean;
  /** Other clients who rent the same employee. */
  others?: string[];
}
interface Client {
  id: string;
  name: string;
  company: string | null;
  note: string;
  createdAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  hasPassword: boolean;
  inviteExpiresAt: string | null;
  lastLineAt: string | null;
  lines: number;
  agents: Agent[];
}
interface Rentable {
  id: string;
  name: string;
  title: string;
  appearance: Appearance;
  workingDir: string | null;
  /** Who rents them now (names), and those clients' ids: one employee may be rented to several. */
  rentedTo: string | null;
  clients?: string[];
  mine?: boolean;
  online?: boolean;
  /** Why this owner cannot rent them out (another member's, or a computer whose app is too old). */
  cannot?: string | null;
}
interface RentView {
  address: string | null;
  clients: Client[];
  employees: Rentable[];
}
interface Made {
  client: Client;
  link: string;
  expiresAt: string;
}

/** What each permission is, in a word and a line. The order is the order they are shown in. */
const PERMS: Array<{ key: keyof RentPerms; label: string; about: string }> = [
  { key: 'commands', label: 'Commands', about: 'Run shell commands in their folders' },
  { key: 'edit', label: 'Edit files', about: 'Change files; off: they only read' },
  { key: 'web', label: 'Web', about: 'Fetch pages and search the web' },
  { key: 'teamwork', label: 'Teamwork', about: "Talk to and work with the client's other employees, in each other's folders" },
  { key: 'files', label: 'Files', about: 'The client sends files, and they give the client files' },
  { key: 'vault', label: 'Vault', about: "Use the office's credentials" },
  { key: 'memory', label: 'Memory', about: "Read and write the office's long memory" },
  { key: 'anywhere', label: 'Anywhere', about: 'Beyond their folders: the whole machine, and the servers the work needs (ssh, deploys) — the office’s own files stay fenced' },
  { key: 'office', label: 'Office work', about: 'They go on working with the whole office as before: the task board, every colleague (who can reach them too), office work handed to them — for a project manager or anyone the client reaches the team through. Off: walled in with this client’s employees' },
  { key: 'autonomous', label: 'Never waits', about: 'The client never waits for you: what the switches allow runs without your approval — the high-risk hold too — and they ask you nothing (the client is asked instead)' },
];
/** Switches that reach past this client: shown amber when on. */
const WIDE = new Set<keyof RentPerms>(['vault', 'memory', 'anywhere', 'autonomous', 'office']);
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

/** The permissions of one rented employee as a row of switches. */
function Perms({ value, onChange, disabled, name }: { value: RentPerms; onChange: (p: RentPerms) => void; disabled?: boolean; name: string }) {
  return (
    <div className="k-many rent-perms" role="group" aria-label={`What ${name} may do`} data-rent-perms={name}>
      {PERMS.map((p) => {
        const on = value[p.key];
        return (
          <button key={p.key} type="button" disabled={disabled} className={`k-toggle ${on ? 'k-toggle-on' : ''} ${WIDE.has(p.key) && on ? 'rent-perm-wide' : ''}`} aria-pressed={on} title={`${p.about}${p.key === 'vault' || p.key === 'memory' ? ' — the whole office’s, not only this client’s' : ''}`} onClick={() => onChange({ ...value, [p.key]: !on })} data-perm={p.key}>
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

/** The link to send: shown once, with Copy. */
function LinkSheet({ made, onDone }: { made: { name: string; link: string; expiresAt: string }; onDone: () => void }) {
  return (
    <div className="k-sheet rent-link" data-rent-link={made.name}>
      <div className="k-sheet-head">
        <div className="k-title">Send this link to {made.name}</div>
        <Button small variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
      <div className="k-code">
        {made.link}
        <Button small onClick={() => void copyText(made.link, 'Link copied')}>
          Copy
        </Button>
      </div>
      <div className="k-text">
        They open it, choose a password, and talk to the employees you rent them — in a chat at the office's address, on a computer or a phone. It works once, until {day(made.expiresAt)}; then they sign in at <span className="mono">/rent</span> with their name and password. It is shown only now — if it gets lost, make a new link.
      </div>
    </div>
  );
}

/** Making a client: who they are, whom they rent, and what those employees may do. */
function NewClient({ view, onMade, onClose }: { view: RentView; onMade: (m: Made) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [company, setCompany] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [perms, setPerms] = useState<RentPerms>(RENT_PERMS_DEFAULT);
  const [busy, setBusy] = useState(false);
  const free = view.employees.filter((e) => !e.cannot);
  return (
    <form
      className="k-sheet"
      data-rent-new
      onSubmit={async (ev) => {
        ev.preventDefault();
        if (busy || !name.trim()) return;
        setBusy(true);
        const made = await act(() => api<Made>('POST', '/rent/clients', { name: name.trim(), company: company.trim() || null, employeeIds: ids, perms }), `${name.trim()} is a client`);
        setBusy(false);
        if (made) onMade(made);
      }}
    >
      <div className="k-sheet-head">
        <div className="k-title">A new client</div>
        <Button small variant="ghost" type="button" onClick={onClose}>
          Cancel
        </Button>
      </div>
      <div className="rent-two">
        <label className="field">
          <span className="field-label">Their name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoFocus placeholder="Jane Client" aria-label="Their name" />
          <span className="field-hint">They sign in with it.</span>
        </label>
        <label className="field">
          <span className="field-label">Company (optional)</span>
          <input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={80} placeholder="Acme d.o.o." aria-label="Company" />
          <span className="field-hint">The employees are told who they work for.</span>
        </label>
      </div>
      <div className="field">
        <span className="field-label">Employees they rent</span>
        <PickMany
          name="rent-employees"
          value={ids}
          onChange={setIds}
          add="Add an employee"
          none="Nobody yet — you can add them later"
          options={view.employees.map((e) => ({ id: e.id, label: e.name, hint: [e.mine ? `${e.title} · your computer${e.online ? '' : ' (off now)'}` : e.title, e.rentedTo ? `also rented to ${e.rentedTo}` : ''].filter(Boolean).join(' · '), lead: <Avatar appearance={e.appearance} size={18} />, also: e.title, warn: e.cannot ?? undefined }))}
        />
        <span className="field-hint">
          {free.length ? 'One employee may be rented to several clients at once: each has their own conversation, and the employee is told to keep each client\'s words to that client. While rented they work in their folder, with their colleagues of the same client. Those on your own computer answer while it is connected; when it is off, what the client writes waits for them.' : 'Nobody here can be rented out yet: hire someone first.'}
        </span>
      </div>
      <div className="field">
        <span className="field-label">What they may do</span>
        <Perms value={perms} onChange={setPerms} name="the new client's employees" />
        <span className="field-hint">For each employee, changed any time below — at once, in the session that runs. Vault and memory are the whole office's; Anywhere lets them past their folders (servers too); Never waits means nothing they are allowed waits for your approval or answer — so the client never waits.</span>
      </div>
      <div className="k-actions">
        <Button variant="primary" type="submit" disabled={busy || !name.trim() || !view.address} title={!view.address ? 'Save the address people come to first (Members)' : undefined} data-rent-create>
          {busy ? 'Making the link…' : 'Make the client and a link'}
        </Button>
      </div>
    </form>
  );
}

/** One client: a line, and on a click their employees, the conversations, a new link, the end. */
function ClientRow({ c, view, open, onToggle, reload, onLink, focus }: { c: Client; view: RentView; open: boolean; onToggle: () => void; reload: () => void; onLink: (m: { name: string; link: string; expiresAt: string }) => void; focus: Focus | null }) {
  const [reading, setReading] = useState<string | null>(null);
  useEffect(() => {
    if (focus) setReading(focus.employeeId);
  }, [focus?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const [adding, setAdding] = useState('');
  const [note, setNote] = useState(c.note);
  useEffect(() => setNote(c.note), [c.note]);
  const run = async <T,>(fn: () => Promise<T>, ok?: string) => {
    const r = await act(fn, ok);
    reload();
    return r;
  };
  const free = view.employees.filter((e) => !e.cannot && !e.clients?.includes(c.id));
  const status = c.inviteExpiresAt ? `link not used yet · works until ${day(c.inviteExpiresAt)}` : c.lastSeenAt ? `here ${timeAgo(c.lastSeenAt)}` : c.hasPassword ? 'has not come back yet' : 'no link — make one';
  return (
    <div data-rent-client={c.name}>
      <div className="k-row k-row-click" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle} onKeyDown={(ev) => ev.target === ev.currentTarget && onActivate(onToggle)(ev)}>
        <span className="rent-initial" aria-hidden>
          {c.name.slice(0, 1)}
        </span>
        <div className="k-main">
          <div className="k-title">
            {c.name}
            {c.company && <span className="k-title-note"> {c.company}</span>}
          </div>
          <div className="k-sub">
            {c.agents.length ? c.agents.map((a) => a.name).join(', ') : 'rents nobody yet'} · {status}
            {c.lastLineAt ? ` · last word ${timeAgo(c.lastLineAt)}` : ''}
          </div>
        </div>
        <span className="rent-faces">
          {c.agents.slice(0, 4).map((a) => (a.appearance ? <Avatar key={a.employeeId} appearance={a.appearance} size={24} offline={a.state === 'away'} /> : null))}
        </span>
        <span className="k-chev" aria-hidden />
      </div>
      {open && (
        <div className="k-detail">
          <div className="k-section">
            <span className="k-label">Employees they rent</span>
            {c.agents.length === 0 && <div className="k-text">Nobody yet. Add an employee below; they appear in {c.name}'s portal at once.</div>}
            {c.agents.length > 0 && (
              <div className="k-group">
                {c.agents.map((a) => (
                  <div key={a.employeeId} className="rent-agent" data-rent-agent={a.name}>
                    <div className="k-row k-row-sm">
                      {a.appearance && <Avatar appearance={a.appearance} size={30} offline={a.state === 'away'} />}
                      <div className="k-main">
                        <div className="k-title-sm">
                          {a.name} <span className="k-title-note">{a.title}</span>
                        </div>
                        <div className="k-sub">
                          {a.mine ? (a.online ? 'on your computer · ' : 'on your computer, which is off now · ') : ''}
                          {a.others?.length ? `also works for ${a.others.join(', ')} — under the widest switches of their clients · ` : ''}
                          {a.state} · since {day(a.since)}
                          {a.workingDir ? ` · works in ${a.workingDir}` : ' · no folder of their own'}
                        </div>
                      </div>
                      <Button small variant="ghost" onClick={() => setReading(reading === a.employeeId ? null : a.employeeId)} data-rent-read={a.name}>
                        {reading === a.employeeId ? 'Hide conversation' : 'Conversation'}
                      </Button>
                      <button
                        type="button"
                        className="k-x"
                        title={`Release ${a.name}: they are the office's again`}
                        aria-label={`Release ${a.name}`}
                        onClick={async () => {
                          if (!(await ask({ title: `Release ${a.name}?`, body: `${c.name} no longer talks to ${a.name}. ${a.name} is the office's again — every folder, every colleague. Their conversation with ${c.name} stays here.`, ok: 'Release' }))) return;
                          await run(() => api('DELETE', `/rent/clients/${c.id}/agents/${a.employeeId}`), `${a.name} is the office's again`);
                        }}
                      >
                        ×
                      </button>
                    </div>
                    <div className="rent-agent-perms">
                      <Perms value={a.perms} name={a.name} onChange={(perms) => void run(() => api('PATCH', `/rent/clients/${c.id}/agents/${a.employeeId}`, { perms }), `${a.name}: changed now`)} />
                    </div>
                    {reading === a.employeeId && <Conversation clientId={c.id} employeeId={a.employeeId} client={c.name} agent={a.name} focus={focus?.employeeId === a.employeeId ? focus : null} />}
                  </div>
                ))}
              </div>
            )}
            {free.length > 0 && c.agents.length < 20 && (
              <div className="rent-add">
                <select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Another employee for them">
                  <option value="">Another employee for {c.name}…</option>
                  {free.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name} — {e.title}
                      {e.mine ? ' (your computer)' : ''}
                      {e.rentedTo ? ` (also rented to ${e.rentedTo})` : ''}
                    </option>
                  ))}
                </select>
                <Button small disabled={!adding} onClick={async () => (await run(() => api('POST', `/rent/clients/${c.id}/agents`, { employeeId: adding }), 'Rented')) && setAdding('')}>
                  Rent
                </Button>
              </div>
            )}
          </div>
          <div className="k-section">
            <span className="k-label">Your note</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== c.note && void run(() => api('PATCH', `/rent/clients/${c.id}`, { note }), 'Saved')} rows={2} placeholder="What was agreed, what they are for — for you only; never shown to them or the employees" aria-label="Your note" />
          </div>
          <div className="k-actions">
            <Button
              small
              onClick={async () => {
                if (c.hasPassword && !(await ask({ title: `A new link for ${c.name}?`, body: `What ${c.name} signs in with now stops working: their password and the browsers they are signed in on. They set a new password with the link.`, ok: 'Make a new link' }))) return;
                const r = await run(() => api<Made>('POST', `/rent/clients/${c.id}/link`, {}));
                if (r) onLink({ name: c.name, link: r.link, expiresAt: r.expiresAt });
              }}
              data-rent-newlink
            >
              New link
            </Button>
            <span className="grow" />
            <Button
              small
              variant="ghost"
              className="k-quiet"
              onClick={async () => {
                if (!(await ask({ title: `End ${c.name}'s rental?`, body: `${c.name} is signed out and cannot come back; ${c.agents.length ? `${c.agents.map((a) => a.name).join(', ')} ${c.agents.length === 1 ? 'is' : 'are'} the office's again` : 'nobody is rented to them'}. Their conversations stay here to read.`, ok: 'End it', danger: true }))) return;
                await run(() => api('DELETE', `/rent/clients/${c.id}`), `${c.name} is no longer a client`);
              }}
              data-rent-end
            >
              End the rental…
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A line a search of the Rent tab found: its conversation opens on it, with the same words searched. */
interface Focus {
  clientId: string;
  employeeId: string;
  lineId: string;
  q: string;
  at: number;
}

/**
 * What a client and an employee said to each other, read by the owner: the last 80 lines — or, searched (the box over
 * it, or a hit of the tab's search), every line of the whole conversation that has the words, marked.
 */
function Conversation({ clientId, employeeId, client, agent, focus }: { clientId: string; employeeId: string; client: string; agent: string; focus?: Focus | null }) {
  const [lines, setLines] = useState<RentLine[] | null>(null);
  const [q, setQ] = useState(focus?.q ?? '');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) setQ(focus.q);
  }, [focus?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const load = () => api<{ lines: RentLine[] }>('GET', `/rent/clients/${clientId}/chats/${employeeId}`).then((r) => setLines(r.lines), () => undefined);
    void load();
    const t = window.setInterval(load, 4000);
    return () => window.clearInterval(t);
  }, [clientId, employeeId]);
  const words = searchWords(q);
  const shown = !lines ? [] : words.length ? lines.filter((l) => l.from !== 'note' && matchesWords(`${l.text}\n${(l.files ?? []).map((f) => f.name).join('\n')}`, words)) : lines.slice(-80);
  useFoundMarks(box, words, 'rent-tab-found', [shown.length, lines]);
  const focusId = focus?.lineId ?? null;
  useLayoutEffect(() => {
    if (focusId) box.current?.querySelector(`[data-line-id="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'center' });
  }, [focusId, focus?.at, !!lines]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!lines) return <div className="k-text rent-convo">Loading…</div>;
  if (!lines.length) return <div className="k-text rent-convo">{client} has not written to {agent} yet.</div>;
  return (
    <div className="rent-convo-wrap">
      <div className="rent-convo-find">
        <input className="rent-find" type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && q && (e.stopPropagation(), setQ(''))} placeholder={`Search what ${client} and ${agent} said`} aria-label={`Search what ${client} and ${agent} said`} data-rent-convo-find />
        <span className="k-sub" data-rent-convo-count>
          {words.length ? (shown.length ? `${shown.length} line${shown.length === 1 ? '' : 's'} of ${lines.length}` : 'nothing found') : lines.length > 80 ? `the last 80 of ${lines.length} lines` : ''}
        </span>
      </div>
    <div className="rent-convo" data-rent-convo ref={box}>
      {shown.map((l) => (
        <div key={l.id} className={`rent-line rent-line-${l.from} ${focusId === l.id ? 'rent-line-found' : ''}`} data-line-id={l.id}>
          <div className="rent-line-who" data-found-skip>
            {l.from === 'client' ? client : l.from === 'agent' ? agent : 'The office'} <span>{clock(l.ts)}</span>
          </div>
          {l.files?.map((f) => (
            <button
              key={f.id}
              type="button"
              className="rent-line-file"
              onClick={async () => {
                const blob = await apiBlob(`/rent/clients/${clientId}/chats/${employeeId}/files/${f.id}`).catch(() => null);
                if (!blob) return;
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = f.name;
                a.click();
              }}
            >
              📎 {f.name}
            </button>
          ))}
          {l.text && (l.from === 'agent' ? <Markdown text={l.text} /> : <div className="pre">{l.text}</div>)}
        </div>
      ))}
    </div>
    </div>
  );
}

/** A rental that ended: who it was, and what was said — to read. */
function EndedRow({ c, focus }: { c: Client; focus: Focus | null }) {
  const [reading, setReading] = useState<string | null>(null);
  useEffect(() => {
    if (focus) setReading(focus.employeeId);
  }, [focus?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <div className="k-row k-row-sm">
        <span className="rent-initial rent-initial-ended" aria-hidden>
          {c.name.slice(0, 1)}
        </span>
        <div className="k-main">
          <div className="k-title-sm">{c.name}</div>
          <div className="k-sub">
            ended {day(c.revokedAt!)} · {c.lines} lines said
          </div>
        </div>
        {c.agents.map((a) => (
          <Button key={a.employeeId} small variant="ghost" onClick={() => setReading(reading === a.employeeId ? null : a.employeeId)}>
            {a.name}
          </Button>
        ))}
      </div>
      {reading && <Conversation clientId={c.id} employeeId={reading} client={c.name} agent={c.agents.find((a) => a.employeeId === reading)?.name ?? ''} focus={focus?.employeeId === reading ? focus : null} />}
    </div>
  );
}

export function RentTab() {
  const [view, setView] = useState<RentView | null>(null);
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<{ name: string; link: string; expiresAt: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showEnded, setShowEnded] = useState(false);
  // Searching: the clients (name, company, note, whom they rent) here, and what was said in every conversation on the server.
  const [q, setQ] = useState('');
  const settled = useSettled(q.trim());
  const [found, setFound] = useState<{ q: string; hits: RentLine[]; words: string[]; more: boolean } | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);
  useEffect(() => {
    if (settled.length < 2) return setFound(null);
    let gone = false;
    api<{ hits: RentLine[]; words: string[]; more: boolean }>('POST', '/rent/search', { q: settled, limit: 30 }).then(
      (r) => !gone && setFound({ q: settled, ...r }),
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [settled]);
  const load = () => api<RentView>('GET', '/rent').then(setView, () => undefined);
  useEffect(() => {
    void load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, []);
  if (!view) return <div className="k-text">Loading…</div>;
  const words = searchWords(q);
  // (A client whose conversation has the words is shown too: a hit opens it there.)
  const withHits = new Set([...(found?.hits.map((h) => h.clientId) ?? []), ...(focus ? [focus.clientId] : [])]);
  const fits = (c: Client) => !words.length || withHits.has(c.id) || matchesWords(`${c.name} ${c.company ?? ''} ${c.note} ${c.agents.map((a) => a.name).join(' ')}`, words);
  const active = view.clients.filter((c) => !c.revokedAt && fits(c));
  const ended = view.clients.filter((c) => c.revokedAt && fits(c));
  const anyClients = view.clients.length > 0;
  const nameOf = (clientId: string, employeeId: string) => {
    const c = view.clients.find((x) => x.id === clientId);
    return { client: c?.name ?? 'a client', agent: c?.agents.find((a) => a.employeeId === employeeId)?.name ?? 'an employee', ended: !!c?.revokedAt };
  };
  return (
    <div className="k-stack" data-rent-tab>
      <div className="rent-top">
        <div className="k-text">
          Rent employees out. A client gets a link, sets a password, and talks to the employees you give them — in a chat at the office's address, never in the office. While rented, an employee works only for that client: in their own folder, with that client's other employees, and only as far as you allow. Your own conversation with them stays yours.
        </div>
        {!creating && (
          <Button variant="primary" onClick={() => (setCreating(true), setLink(null))} data-rent-open-new>
            New client
          </Button>
        )}
      </div>
      {!view.address && <div className="k-note">Save the address people come to first (the Members tab): the client's link starts with it.</div>}
      {creating && (
        <NewClient
          view={view}
          onClose={() => setCreating(false)}
          onMade={(m) => {
            setCreating(false);
            setLink({ name: m.client.name, link: m.link, expiresAt: m.expiresAt });
            setOpen(m.client.id);
            void load();
          }}
        />
      )}
      {link && <LinkSheet made={link} onDone={() => setLink(null)} />}
      {anyClients && (
        <input className="rent-find" type="search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && q && (e.stopPropagation(), setQ(''))} placeholder="Search clients and what was said with them" aria-label="Search clients and what was said with them" data-rent-tab-search />
      )}
      {settled.length >= 2 && (
        <div className="k-section" data-rent-tab-found>
          <span className="k-label">In conversations{found && found.q === settled ? ` · ${found.hits.length}${found.more ? '+' : ''}` : ''}</span>
          {!found || found.q !== settled ? (
            <div className="k-text">Searching…</div>
          ) : found.hits.length === 0 ? (
            <div className="k-text">No line has “{found.q}” in it.</div>
          ) : (
            <div className="k-group">
              {found.hits.map((h) => {
                const n = nameOf(h.clientId, h.employeeId);
                const text = h.text || (h.files ?? []).map((f) => `📎 ${f.name}`).join(' ');
                return (
                  <div
                    key={h.id}
                    className="k-row k-row-sm k-row-click"
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (n.ended) setShowEnded(true);
                      else setOpen(h.clientId);
                      setFocus({ clientId: h.clientId, employeeId: h.employeeId, lineId: h.id, q: found.q, at: Date.now() });
                    }}
                    onKeyDown={(ev) => ev.target === ev.currentTarget && onActivate(() => (n.ended ? setShowEnded(true) : setOpen(h.clientId), setFocus({ clientId: h.clientId, employeeId: h.employeeId, lineId: h.id, q: found.q, at: Date.now() })))(ev)}
                    data-rent-tab-hit={h.id}
                  >
                    <div className="k-main">
                      <div className="k-title-sm">
                        {h.from === 'client' ? `${n.client} → ${n.agent}` : `${n.agent} → ${n.client}`}
                        <span className="k-title-note"> {day(h.ts)}{n.ended ? ' · ended' : ''}</span>
                      </div>
                      <div className="k-sub">
                        <Marked text={snippetOf(text, found.words, 160)} words={found.words} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {words.length > 0 && active.length === 0 && ended.length === 0 && <div className="k-text">No client fits “{q.trim()}”.</div>}
      {active.length === 0 && !creating && !words.length ? (
        <div className="k-empty">
          <div className="k-title">No clients yet</div>
          <div className="k-text">Make one, give them an employee or two, and send them the link.</div>
        </div>
      ) : (
        active.length > 0 && (
          <div className="k-section">
            <span className="k-label">
              {active.length} client{active.length === 1 ? '' : 's'} · {active.reduce((n, c) => n + c.agents.length, 0)} employees rented
            </span>
            <div className="k-group">
              {active.map((c) => (
                <ClientRow key={c.id} c={c} view={view} open={open === c.id} onToggle={() => setOpen((o) => (o === c.id ? null : c.id))} reload={() => void load()} onLink={setLink} focus={focus?.clientId === c.id ? focus : null} />
              ))}
            </div>
          </div>
        )
      )}
      {ended.length > 0 && (
        <div>
          <button type="button" className="k-link" onClick={() => setShowEnded((s) => !s)}>
            {showEnded ? 'Hide' : 'Show'} {ended.length} ended rental{ended.length === 1 ? '' : 's'}
          </button>
          {showEnded && (
            <div className="k-group" style={{ marginTop: 8 }}>
              {ended.map((c) => (
                <EndedRow key={c.id} c={c} focus={focus?.clientId === c.id ? focus : null} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
