import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Field, Window, timeAgo, type Tone } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useAccess } from '../../lib/access.ts';
import { useOffice } from '../../lib/store.ts';
import { act, ask } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { copyText } from './company-shared.tsx';

type Kind = 'password' | 'api_key' | 'token' | 'ssh_key' | 'other';
interface Actor {
  kind: 'owner' | 'member' | 'employee' | 'office';
  name: string;
}
interface Entry {
  id: string;
  name: string;
  kind: Kind;
  service: string;
  username: string;
  description: string;
  source: 'added' | 'stored' | 'captured' | 'noticed';
  createdAt: string;
  createdBy: Actor;
  uses: number;
  lastUsedAt: string | null;
  lastUsedBy: Actor | null;
  length: number;
}

const KINDS: Array<[Kind, string]> = [
  ['password', 'Password'],
  ['api_key', 'API key'],
  ['token', 'Token'],
  ['ssh_key', 'Private key'],
  ['other', 'Other'],
];
const KIND_LABEL = Object.fromEntries(KINDS) as Record<Kind, string>;
const KIND_TONE: Record<Kind, Tone> = { password: 'info', api_key: 'good', token: 'warn', ssh_key: 'bad', other: 'muted' };

/** How it got here, in a few words. */
function origin(e: Entry): string {
  const who = e.createdBy.kind === 'office' ? 'the office' : e.createdBy.name;
  if (e.source === 'captured') return `taken out of a message from ${who}`;
  if (e.source === 'noticed') return `seen in ${who}'s session`;
  if (e.source === 'stored') return `stored by ${who}`;
  return `added by ${who}`;
}

/**
 * The vault: the office's passwords, tokens and keys. What is listed is what each one is called and what it is
 * for — the value is shown only to an owner who asks for one, for half a minute.
 */
function VaultPanel({ onClose }: { arg: string | null; onClose: () => void }) {
  const can = useAccess();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<{ id: string; value: string } | null>(null);
  const hide = useRef<number | null>(null);
  const load = () => api<{ entries: Entry[] }>('GET', '/vault').then((r) => setEntries(r.entries), () => setEntries((e) => e ?? []));
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

  if (!works) {
    return (
      <Window title="Vault" subtitle="The office's passwords, tokens and keys" onClose={onClose} width={560}>
        <p className="muted">The vault is for the people who work in this office. Visitors cannot open it.</p>
      </Window>
    );
  }
  const run = async <T,>(fn: () => Promise<T>, ok?: string) => {
    setBusy(true);
    const res = await act(fn, ok);
    setBusy(false);
    void load();
    return res;
  };
  const needle = search.trim().toLowerCase();
  const list = (entries ?? []).filter((e) => !needle || `${e.name} ${e.service} ${e.username} ${e.description} ${KIND_LABEL[e.kind]}`.toLowerCase().includes(needle));
  const show = async (e: Entry) => {
    const res = await run(() => api<{ value: string }>('POST', `/vault/${e.id}/reveal`, {}));
    if (!res) return;
    setShown({ id: e.id, value: res.value });
    if (hide.current) window.clearTimeout(hide.current);
    hide.current = window.setTimeout(() => setShown(null), 30_000);
  };

  return (
    <Window title="Vault" subtitle="The office's passwords, tokens and keys" onClose={onClose} width={780}>
      <div className="col" style={{ gap: 12 }}>
        <div className="small muted">
          Employees use what is here by its name, inside their commands; the value does not appear in their conversation. A password or a key you write to an employee in a message is moved here by itself, and the message goes on with its name.
        </div>
        <div className="row">
          <input type="search" value={search} onChange={(ev) => setSearch(ev.target.value)} placeholder="Search by name, service or login…" aria-label="Search the vault" style={{ flex: 1 }} />
          <Button variant={adding ? 'default' : 'primary'} onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : 'Add a credential'}
          </Button>
        </div>
        {adding && (
          <AddForm
            busy={busy}
            onSave={async (input) => {
              const res = await run(() => api<{ entry: Entry; created: boolean }>('POST', '/vault', input));
              if (!res) return;
              useOffice.getState().toast(res.created ? `Stored as "${res.entry.name}"` : `That value is already in the vault as "${res.entry.name}"`, 'success');
              setAdding(false);
            }}
          />
        )}

        {entries === null ? (
          <div className="small muted">Loading…</div>
        ) : list.length === 0 ? (
          <div className="small faint" data-vault-empty>
            {needle ? 'Nothing in the vault matches.' : 'The vault is empty. Add a credential, or simply give one to an employee in a message: it ends up here.'}
          </div>
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {list.map((e) => (
              <div key={e.id} className="card col" style={{ gap: 6 }} data-vault={e.name}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="mono strong truncate">{e.name}</span>
                  <Badge tone={KIND_TONE[e.kind]}>{KIND_LABEL[e.kind]}</Badge>
                  <span className="small muted truncate grow">
                    {[e.service, e.username && `login ${e.username}`].filter(Boolean).join(' · ')}
                  </span>
                  <Button small onClick={() => void copyText(`{{vault:${e.name}}}`, 'Name copied — paste it into a message to an employee')} title="Copy its name, to mention it in a message or a task">
                    Copy name
                  </Button>
                  {can.admin && (
                    <Button small disabled={busy} onClick={() => (shown?.id === e.id ? setShown(null) : void show(e))} title="Show the value for half a minute. It is recorded that you looked">
                      {shown?.id === e.id ? 'Hide' : 'Show'}
                    </Button>
                  )}
                  {can.admin && (
                    <Button
                      small
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void ask({ title: `Remove ${e.name} from the vault?`, body: 'Employees can no longer use it. The value is deleted here and cannot be brought back; wherever it is used, it keeps working until it is changed there.', ok: 'Remove', danger: true }).then((yes) => {
                          if (yes) void run(() => api('DELETE', `/vault/${e.id}`), `${e.name} removed`);
                        })
                      }
                    >
                      Remove…
                    </Button>
                  )}
                </div>
                {e.description && <div className="small">{e.description}</div>}
                {shown?.id === e.id && (
                  <div className="row">
                    <textarea className="mono" readOnly value={shown.value} aria-label={`Value of ${e.name}`} rows={shown.value.includes('\n') ? 5 : 1} style={{ flex: 1, minHeight: 0, resize: 'none' }} onFocus={(ev) => ev.currentTarget.select()} />
                    <Button small variant="primary" onClick={() => void copyText(shown.value, 'Value copied')}>
                      Copy
                    </Button>
                  </div>
                )}
                <div className="small faint">
                  {origin(e)} {timeAgo(e.createdAt)} · {e.uses ? `used ${e.uses} time${e.uses === 1 ? '' : 's'}, last by ${e.lastUsedBy?.name ?? 'someone'} ${e.lastUsedAt ? timeAgo(e.lastUsedAt) : ''}` : 'not used yet'} · {e.length} characters
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Window>
  );
}

function AddForm({ busy, onSave }: { busy: boolean; onSave: (input: { name: string; value: string; kind: Kind; service: string; username: string; description: string }) => void }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<Kind>('password');
  const [service, setService] = useState('');
  const [username, setUsername] = useState('');
  const [description, setDescription] = useState('');
  const [visible, setVisible] = useState(false);
  return (
    <form
      className="card col"
      style={{ gap: 10 }}
      onSubmit={(ev) => {
        ev.preventDefault();
        onSave({ name: name.trim(), value, kind, service: service.trim(), username: username.trim(), description: description.trim() });
      }}
    >
      <div className="grid2">
        <Field label="What it opens" hint="A site, a server, a product: github.com, the shop's database.">
          <input value={service} onChange={(ev) => setService(ev.target.value)} placeholder="github.com" autoFocus />
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
        <Field label="Login (if it has one)">
          <input value={username} onChange={(ev) => setUsername(ev.target.value)} placeholder="deploy" autoComplete="off" />
        </Field>
        <Field label="Name" hint="How employees refer to it. Empty: named from what it opens.">
          <input value={name} onChange={(ev) => setName(ev.target.value)} className="mono" placeholder="github-deploy-token" spellCheck={false} />
        </Field>
      </div>
      <Field label="The value" wide>
        <div className="row">
          {kind === 'ssh_key' ? (
            <textarea value={value} onChange={(ev) => setValue(ev.target.value)} className="mono" rows={4} spellCheck={false} aria-label="The value" style={{ flex: 1 }} />
          ) : (
            <input type={visible ? 'text' : 'password'} value={value} onChange={(ev) => setValue(ev.target.value)} className="mono" autoComplete="new-password" spellCheck={false} aria-label="The value" style={{ flex: 1 }} />
          )}
          {kind !== 'ssh_key' && (
            <Button small type="button" onClick={() => setVisible((v) => !v)}>
              {visible ? 'Hide' : 'Show'}
            </Button>
          )}
        </div>
      </Field>
      <Field label="Note (optional)" wide>
        <input value={description} onChange={(ev) => setDescription(ev.target.value)} placeholder="What it is for, in a few words" />
      </Field>
      <div className="row">
        <Button variant="primary" type="submit" disabled={busy || !value.trim() || (!name.trim() && !service.trim())} title={!value.trim() ? 'Give the value' : !name.trim() && !service.trim() ? 'Say what it opens, or give it a name' : undefined}>
          Put it in the vault
        </Button>
      </div>
    </form>
  );
}

registerPanel('vault', VaultPanel);
