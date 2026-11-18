/**
 * The vault: the office's passwords, tokens and keys (docs/VAULT.md). Built as a vault (the owner, 2026-11-18: "make
 * the vault's interface actually look like a vault, very clear and easy to use"): the door at the top; on the left
 * the boxes, by what they open; on the right the box that is open — its value behind a steel slot that only an owner
 * opens (for half a minute, on the record), how employees use it, where it came from, and what can be done with it.
 * The words and the grouping are worked out in `lib/vault.ts`.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Field, Window, timeAgo } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useAccess } from '../../lib/access.ts';
import { useOffice } from '../../lib/store.ts';
import { KINDS, KIND_LABEL, KIND_MANY, byService, commandFor, kindCounts, matches, origin, placeholderFor, usedLine, type Kind, type VaultEntry } from '../../lib/vault.ts';
import { act, ask } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { copyText } from './company-shared.tsx';

/** How long a value an owner asked to see stays in sight. */
const SHOWN_MS = 30_000;

/** The vault's door, as its emblem: a round door, its dial and the handle's spokes. */
export function VaultDoor({ size = 40 }: { size?: number }) {
  return (
    <svg className="vt-door" width={size} height={size} viewBox="0 0 48 48" aria-hidden>
      <rect x="2" y="2" width="44" height="44" rx="10" className="vt-door-frame" />
      <circle cx="24" cy="24" r="16.5" className="vt-door-plate" />
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <circle key={a} cx={24 + 13.6 * Math.cos((a * Math.PI) / 180)} cy={24 + 13.6 * Math.sin((a * Math.PI) / 180)} r="1.1" className="vt-door-bolt" />
      ))}
      <circle cx="24" cy="24" r="7.5" className="vt-door-dial" />
      {[90, 210, 330].map((a) => (
        <line key={a} x1="24" y1="24" x2={24 + 11 * Math.cos((a * Math.PI) / 180)} y2={24 + 11 * Math.sin((a * Math.PI) / 180)} className="vt-door-spoke" />
      ))}
      <circle cx="24" cy="24" r="2.4" className="vt-door-hub" />
    </svg>
  );
}

/** What kind of thing it is, as a small sign on a metal tile. */
function KindTile({ kind, size = 30 }: { kind: Kind; size?: number }) {
  const s = Math.round(size * 0.55);
  const path: Record<Kind, ReactNode> = {
    password: (
      <>
        <rect x="5" y="10.5" width="14" height="10" rx="2" />
        <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
        <circle cx="12" cy="15.5" r="1.3" />
      </>
    ),
    api_key: (
      <>
        <circle cx="8" cy="12" r="3.6" />
        <path d="M11.6 12H20M17 12v3M20 12v2.4" />
      </>
    ),
    token: (
      <>
        <path d="M4 8.5h16v2.2a1.8 1.8 0 0 0 0 3.6v2.2H4v-2.2a1.8 1.8 0 0 0 0-3.6z" />
        <path d="M10 8.5v8" strokeDasharray="1.6 1.6" />
      </>
    ),
    ssh_key: (
      <>
        <path d="M6 3.5h8l4 4v13H6z" />
        <path d="M14 3.5v4h4" />
        <circle cx="10.5" cy="14" r="2" />
        <path d="M12.5 14h3.5M15 14v1.8" />
      </>
    ),
    other: (
      <>
        <rect x="4.5" y="6" width="15" height="12" rx="2" />
        <path d="M4.5 10h15M10 13.5h4" />
      </>
    ),
  };
  return (
    <span className={`vt-tile vt-tile-${kind}`} style={{ width: size, height: size }} title={KIND_LABEL[kind]}>
      <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {path[kind]}
      </svg>
    </span>
  );
}

type Mode = 'view' | 'add' | 'edit' | 'value';

function VaultPanel({ onClose }: { arg: string | null; onClose: () => void }) {
  const can = useAccess();
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<Kind | ''>('');
  const [picked, setPicked] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('view');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{
    id: string;
    value: string;
    until: number;
  } | null>(null);
  const [, tick] = useState(0);
  const hide = useRef<number | null>(null);
  const load = () =>
    api<{ entries: VaultEntry[] }>('GET', '/vault').then(
      (r) => setEntries(r.entries),
      () => setEntries((e) => e ?? []),
    );
  const works = can.work(null);
  useEffect(() => {
    if (!works) return;
    void load();
    const t = window.setInterval(load, 5000);
    return () => {
      window.clearInterval(t);
      if (hide.current) window.clearTimeout(hide.current);
    };
  }, [works]);
  // While a value is in sight, the seconds left are counted down.
  useEffect(() => {
    if (!shown) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [shown]);

  if (!works) {
    return (
      <Window kit title="Vault" subtitle="The office's passwords, tokens and keys" onClose={onClose} width={560} lead={<VaultDoor />}>
        <p className="muted">The vault is for the people who work in this office. Visitors cannot open it.</p>
      </Window>
    );
  }

  const all = entries ?? [];
  const run = async <T,>(fn: () => Promise<T>, ok?: string) => {
    setBusy(true);
    const res = await act(fn, ok);
    setBusy(false);
    void load();
    return res;
  };
  const putAway = () => {
    setShown(null);
    if (hide.current) window.clearTimeout(hide.current);
  };
  const pick = (id: string) => {
    if (id !== picked) putAway();
    setPicked(id);
    setMode('view');
  };
  const list = all.filter((e) => (!kind || e.kind === kind) && matches(e, search));
  const counts = kindCounts(all);
  const groups = byService(list);
  // The box that is open: the one picked, else the first on the shelves as they stand on the left.
  const current = mode === 'add' ? null : (list.find((e) => e.id === picked) ?? all.find((e) => e.id === picked) ?? groups[0]?.rows[0] ?? null);
  const show = async (e: VaultEntry) => {
    const res = await run(() => api<{ value: string }>('POST', `/vault/${e.id}/reveal`, {}));
    if (!res) return;
    setShown({ id: e.id, value: res.value, until: Date.now() + SHOWN_MS });
    if (hide.current) window.clearTimeout(hide.current);
    hide.current = window.setTimeout(() => setShown(null), SHOWN_MS);
  };
  const used = all.reduce((n, e) => n + e.uses, 0);

  return (
    <Window
      kit
      flush
      title="Vault"
      subtitle={all.length ? `${all.length} credential${all.length === 1 ? '' : 's'} under lock · taken out ${used} time${used === 1 ? '' : 's'}` : "The office's passwords, tokens and keys"}
      lead={<VaultDoor />}
      onClose={onClose}
      width={1100}
      actions={
        mode === 'add' ? undefined : (
          <Button variant="primary" onClick={() => (putAway(), setMode('add'))}>
            Add a credential
          </Button>
        )
      }
    >
      <div className="k-split vt" data-vault-window>
        <aside className="k-split-side vt-side">
          <div className="k-split-tools">
            <input
              className="k-find"
              type="search"
              aria-label="Search the vault"
              placeholder="Find by name, what it opens or the login…"
              value={search}
              onChange={(ev) => setSearch(ev.target.value)}
            />
            {counts.length > 1 && (
              <div className="k-filters" role="tablist" aria-label="Kind">
                <button type="button" role="tab" aria-selected={!kind} className={kind ? '' : 'k-filter-on'} onClick={() => setKind('')}>
                  All <span>{all.length}</span>
                </button>
                {counts.map(({ kind: k, n }) => (
                  <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'k-filter-on' : ''} onClick={() => setKind(k)}>
                    {KIND_MANY[k]} <span>{n}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="k-split-list vt-list">
            {entries === null ? (
              <div className="k-sub vt-pad">Opening…</div>
            ) : all.length === 0 ? (
              <div className="k-sub vt-pad">Nothing is in the vault yet.</div>
            ) : list.length === 0 ? (
              <div className="k-sub vt-pad" data-vault-empty>
                Nothing in the vault matches.
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.label} className="vt-group">
                  {groups.length > 1 && (
                    <div className="k-label vt-group-label">
                      {g.label} <span>{g.rows.length}</span>
                    </div>
                  )}
                  {g.rows.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      className={`vt-box ${current?.id === e.id ? 'vt-box-on' : ''}`}
                      aria-pressed={current?.id === e.id}
                      onClick={() => pick(e.id)}
                      data-vault={e.name}
                      title={usedLine(e)}
                    >
                      <KindTile kind={e.kind} />
                      <span className="k-main">
                        <span className="vt-box-name">{e.name}</span>
                        <span className="k-sub">{[KIND_LABEL[e.kind], e.username && `login ${e.username}`].filter(Boolean).join(' · ')}</span>
                      </span>
                      <span className={`vt-box-uses ${e.uses ? '' : 'vt-box-new'}`}>{e.uses ? `${e.uses}×` : 'unused'}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </aside>

        <section className="k-split-main vt-main">
          {mode === 'add' ? (
            <div className="vt-pane">
              <AddForm
                busy={busy}
                onCancel={() => setMode('view')}
                onSave={async (input) => {
                  const res = await run(() => api<{ entry: VaultEntry; created: boolean }>('POST', '/vault', input));
                  if (!res) return;
                  useOffice.getState().toast(res.created ? `Stored as "${res.entry.name}"` : `That value is already in the vault as "${res.entry.name}"`, 'success');
                  setKind('');
                  setSearch('');
                  setPicked(res.entry.id);
                  setMode('view');
                }}
              />
            </div>
          ) : current ? (
            <Box
              key={current.id}
              e={current}
              owner={can.admin}
              busy={busy}
              mode={mode}
              setMode={setMode}
              shown={
                shown?.id === current.id
                  ? {
                      value: shown.value,
                      left: Math.max(0, Math.ceil((shown.until - Date.now()) / 1000)),
                    }
                  : null
              }
              onShow={() => void show(current)}
              onHide={putAway}
              onEdit={async (patch) => {
                const res = await run(() => api('PATCH', `/vault/${current.id}`, patch), 'Saved');
                if (res) setMode('view');
              }}
              onValue={async (value) => {
                const res = await run(() => api('PUT', `/vault/${current.id}/value`, { value }), `A new value is in "${current.name}"`);
                if (res) {
                  putAway();
                  setMode('view');
                }
              }}
              onRemove={() =>
                void ask({
                  title: `Remove ${current.name} from the vault?`,
                  body: 'Employees can no longer use it. The value is deleted here and cannot be brought back; wherever it is used, it keeps working until it is changed there.',
                  ok: 'Remove',
                  danger: true,
                }).then((yes) => {
                  if (yes) void run(() => api('DELETE', `/vault/${current.id}`), `${current.name} removed`).then(putAway);
                })
              }
            />
          ) : entries !== null && all.length === 0 ? (
            <div className="k-empty vt-empty">
              <VaultDoor size={88} />
              <div className="k-title">The vault is empty</div>
              <div className="k-text">
                Passwords, tokens and keys kept here are used by employees by their name, inside their commands — the value never appears in their conversation. A password you write to an employee in
                a message ends up here by itself.
              </div>
              <Button variant="primary" onClick={() => setMode('add')}>
                Add a credential
              </Button>
            </div>
          ) : (
            <div className="k-empty vt-empty">
              <VaultDoor size={64} />
              <div className="k-sub">{entries === null ? 'Opening the vault…' : 'Choose a box on the left.'}</div>
            </div>
          )}
        </section>
      </div>
    </Window>
  );
}

/** One credential, opened: its slot, how it is used, where it came from, and what may be done with it. */
function Box({
  e,
  owner,
  busy,
  mode,
  setMode,
  shown,
  onShow,
  onHide,
  onEdit,
  onValue,
  onRemove,
}: {
  e: VaultEntry;
  owner: boolean;
  busy: boolean;
  mode: Mode;
  setMode: (m: Mode) => void;
  shown: { value: string; left: number } | null;
  onShow: () => void;
  onHide: () => void;
  onEdit: (patch: Partial<Pick<VaultEntry, 'name' | 'service' | 'username' | 'description' | 'kind'>>) => void;
  onValue: (value: string) => void;
  onRemove: () => void;
}) {
  return (
    <div className="vt-pane" data-vault-box={e.name}>
      {/* The box's door: its name plate, and the slot with the value behind it. */}
      <div className="vt-plate">
        <header className="vt-head">
          <KindTile kind={e.kind} size={46} />
          <div className="k-main">
            <div className="vt-name">{e.name}</div>
            <div className="k-sub">{[KIND_LABEL[e.kind], e.service, e.username && `login ${e.username}`].filter(Boolean).join(' · ')}</div>
          </div>
          <Button
            small
            variant="ghost"
            className="k-quiet"
            onClick={() => void copyText(placeholderFor(e.name), 'Name copied — paste it into a message or a task')}
            title={`Copy ${placeholderFor(e.name)}, to mention it in a message to an employee or in a task`}
          >
            Copy name
          </Button>
        </header>
        {e.description && <p className="vt-note">{e.description}</p>}

        {/* The slot: the value behind steel. Open only for an owner, for half a minute. */}
        {mode === 'value' ? (
          <NewValue kind={e.kind} busy={busy} onSave={onValue} onCancel={() => setMode('view')} />
        ) : (
          <div className={`vt-slot ${shown ? 'vt-slot-open' : ''}`} data-vault-slot>
            <span className="vt-slot-lock" aria-hidden>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="10.5" width="14" height="10" rx="2" />
                {shown ? <path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2" /> : <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />}
              </svg>
            </span>
            {shown ? (
              <textarea
                className="vt-slot-value"
                readOnly
                value={shown.value}
                aria-label={`Value of ${e.name}`}
                rows={shown.value.includes('\n') ? 5 : 1}
                spellCheck={false}
                onFocus={(ev) => ev.currentTarget.select()}
              />
            ) : (
              <span className="vt-slot-dots" aria-label={`${e.length} characters, locked`}>
                {'•'.repeat(Math.min(e.length, 28))}
              </span>
            )}
            <span className="vt-slot-side">
              {shown ? (
                <>
                  <span className="vt-slot-left">locks in {shown.left} s</span>
                  <Button small variant="primary" onClick={() => void copyText(shown.value, 'Value copied')}>
                    Copy
                  </Button>
                  <Button small onClick={onHide}>
                    Hide
                  </Button>
                </>
              ) : (
                <>
                  <span className="vt-slot-left">{e.length} characters</span>
                  {owner && (
                    <Button small disabled={busy} onClick={onShow} title="Open it for half a minute. It is recorded that you looked">
                      Show
                    </Button>
                  )}
                </>
              )}
            </span>
          </div>
        )}
        {!owner && <div className="k-sub">Only an owner can open the value, change it or take it out of the vault.</div>}
      </div>

      <div className="vt-section">
        <div className="k-label">How employees use it</div>
        <div className="vt-use">
          <span className="vt-use-what">In a command</span>
          <code className="vt-use-code">{commandFor(e.name)}</code>
          <Button small variant="ghost" className="k-quiet" onClick={() => void copyText(commandFor(e.name), 'Copied')}>
            Copy
          </Button>
        </div>
        <div className="vt-use">
          <span className="vt-use-what">In a message or a task</span>
          <code className="vt-use-code">{placeholderFor(e.name)}</code>
          <Button small variant="ghost" className="k-quiet" onClick={() => void copyText(placeholderFor(e.name), 'Copied')}>
            Copy
          </Button>
        </div>
      </div>

      {mode === 'edit' ? (
        <EditForm e={e} busy={busy} onSave={onEdit} onCancel={() => setMode('view')} />
      ) : (
        <div className="vt-section">
          <div className="k-label">On the record</div>
          <dl className="k-spec vt-facts">
            <div>
              <dt>Put in</dt>
              <dd>
                {origin(e)}, {timeAgo(e.createdAt)}
              </dd>
            </div>
            <div>
              <dt>Used</dt>
              <dd>{usedLine(e)}</dd>
            </div>
            {e.updatedAt && e.updatedAt !== e.createdAt && (
              <div>
                <dt>Last changed</dt>
                <dd>{timeAgo(e.updatedAt)}</dd>
              </div>
            )}
          </dl>
        </div>
      )}

      {owner && mode === 'view' && (
        <div className="k-actions vt-actions">
          <Button small onClick={() => setMode('edit')}>
            Edit details
          </Button>
          <Button small onClick={() => (onHide(), setMode('value'))} title="A changed password, a new key: put it in under the same name, and employees go on using it as before">
            Put in a new value…
          </Button>
          <span className="grow" />
          <Button small variant="ghost" className="k-quiet vt-remove" disabled={busy} onClick={onRemove}>
            Remove…
          </Button>
        </div>
      )}
    </div>
  );
}

/** The value's field: a hidden line, or a box for a private key. */
function ValueField({ kind, value, setValue, autoFocus }: { kind: Kind; value: string; setValue: (v: string) => void; autoFocus?: boolean }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="vt-slot vt-slot-input">
      <span className="vt-slot-lock" aria-hidden>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="5" y="10.5" width="14" height="10" rx="2" />
          <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
        </svg>
      </span>
      {kind === 'ssh_key' ? (
        <textarea
          value={value}
          onChange={(ev) => setValue(ev.target.value)}
          className="vt-slot-value"
          rows={4}
          spellCheck={false}
          aria-label="The value"
          autoFocus={autoFocus}
          placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
        />
      ) : (
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(ev) => setValue(ev.target.value)}
          className="vt-slot-value"
          autoComplete="new-password"
          spellCheck={false}
          aria-label="The value"
          autoFocus={autoFocus}
          placeholder="Paste or type it"
        />
      )}
      {kind !== 'ssh_key' && (
        <span className="vt-slot-side">
          <Button small type="button" onClick={() => setVisible((v) => !v)}>
            {visible ? 'Hide' : 'Show'}
          </Button>
        </span>
      )}
    </div>
  );
}

function AddForm({
  busy,
  onSave,
  onCancel,
}: {
  busy: boolean;
  onSave: (input: { name: string; value: string; kind: Kind; service: string; username: string; description: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<Kind>('password');
  const [service, setService] = useState('');
  const [username, setUsername] = useState('');
  const [description, setDescription] = useState('');
  return (
    <form
      className="k-form vt-form"
      onSubmit={(ev) => {
        ev.preventDefault();
        onSave({
          name: name.trim(),
          value,
          kind,
          service: service.trim(),
          username: username.trim(),
          description: description.trim(),
        });
      }}
    >
      <header className="vt-head">
        <KindTile kind={kind} size={46} />
        <div className="k-main">
          <div className="vt-name vt-name-plain">Put a credential in the vault</div>
          <div className="k-sub">Encrypted on the server. Employees use it by its name; nobody sees the value but an owner who asks.</div>
        </div>
      </header>
      <div className="vt-kinds" role="radiogroup" aria-label="Kind">
        {KINDS.map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} className={`vt-kind ${kind === k ? 'vt-kind-on' : ''}`} onClick={() => setKind(k)}>
            <KindTile kind={k} size={22} />
            {label}
          </button>
        ))}
      </div>
      <div className="grid2">
        <Field label="What it opens" hint="A site, a server, a product: github.com, the shop's database.">
          <input value={service} onChange={(ev) => setService(ev.target.value)} placeholder="github.com" autoFocus />
        </Field>
        <Field label="Login (if it has one)">
          <input value={username} onChange={(ev) => setUsername(ev.target.value)} placeholder="deploy" autoComplete="off" />
        </Field>
      </div>
      <div className="field">
        <span className="field-label">The value</span>
        <ValueField kind={kind} value={value} setValue={setValue} />
      </div>
      <div className="grid2">
        <Field label="Name" hint="How employees refer to it. Empty: named from what it opens.">
          <input value={name} onChange={(ev) => setName(ev.target.value)} className="mono" placeholder="github-deploy-token" spellCheck={false} />
        </Field>
        <Field label="Note (optional)">
          <input value={description} onChange={(ev) => setDescription(ev.target.value)} placeholder="What it is for, in a few words" />
        </Field>
      </div>
      <div className="k-actions">
        <Button
          variant="primary"
          type="submit"
          disabled={busy || !value.trim() || (!name.trim() && !service.trim())}
          title={!value.trim() ? 'Give the value' : !name.trim() && !service.trim() ? 'Say what it opens, or give it a name' : undefined}
        >
          Put it in the vault
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EditForm({
  e,
  busy,
  onSave,
  onCancel,
}: {
  e: VaultEntry;
  busy: boolean;
  onSave: (patch: Partial<Pick<VaultEntry, 'name' | 'service' | 'username' | 'description' | 'kind'>>) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(e.name);
  const [kind, setKind] = useState<Kind>(e.kind);
  const [service, setService] = useState(e.service);
  const [username, setUsername] = useState(e.username);
  const [description, setDescription] = useState(e.description);
  const patch = Object.fromEntries(
    (
      [
        ['name', name.trim(), e.name],
        ['kind', kind, e.kind],
        ['service', service.trim(), e.service],
        ['username', username.trim(), e.username],
        ['description', description.trim(), e.description],
      ] as const
    )
      .filter(([, now, was]) => now !== was)
      .map(([k, now]) => [k, now]),
  );
  const renamed = !!patch.name;
  return (
    <form
      className="k-form vt-section"
      onSubmit={(ev) => {
        ev.preventDefault();
        onSave(patch);
      }}
    >
      <div className="k-label">Details</div>
      <div className="grid2">
        <Field label="Name" hint={renamed ? 'Employees told the old name will not find it under that name any more.' : 'How employees refer to it.'}>
          <input value={name} onChange={(ev) => setName(ev.target.value)} className="mono" spellCheck={false} />
        </Field>
        <Field label="Kind">
          <select value={kind} onChange={(ev) => setKind(ev.target.value as Kind)} aria-label="Kind">
            {KINDS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="What it opens">
          <input value={service} onChange={(ev) => setService(ev.target.value)} />
        </Field>
        <Field label="Login (if it has one)">
          <input value={username} onChange={(ev) => setUsername(ev.target.value)} autoComplete="off" />
        </Field>
      </div>
      <Field label="Note" wide>
        <input value={description} onChange={(ev) => setDescription(ev.target.value)} placeholder="What it is for, in a few words" />
      </Field>
      <div className="k-actions">
        <Button variant="primary" type="submit" disabled={busy || !Object.keys(patch).length || !name.trim()}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function NewValue({ kind, busy, onSave, onCancel }: { kind: Kind; busy: boolean; onSave: (value: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="k-form"
      onSubmit={(ev) => {
        ev.preventDefault();
        onSave(value);
      }}
    >
      <ValueField kind={kind} value={value} setValue={setValue} autoFocus />
      <div className="k-sub">The old value is deleted from the vault. Employees go on using it by the same name; wherever the old one is set, change it there too.</div>
      <div className="k-actions">
        <Button variant="primary" type="submit" disabled={busy || !value.trim()}>
          Put the new value in
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

registerPanel('vault', VaultPanel);
