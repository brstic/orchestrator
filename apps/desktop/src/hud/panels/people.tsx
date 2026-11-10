import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Field, Window, timeAgo, type Tone } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { copyText } from './company-shared.tsx';

type Role = 'visitor' | 'colleague' | 'owner';
const ROLES: Role[] = ['visitor', 'colleague', 'owner'];

interface Guest {
  id: string;
  name: string;
  role: Role;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  via?: 'knock-browser' | 'knock-app';
  expiresAt?: string | null;
}

interface Sharing {
  door: { open: boolean; port: number | null; addresses: string[]; fingerprint: string | null; error: string | null };
  wanted: { open: boolean; port: number; address: string | null };
  guests: Guest[];
}

const ROLE_TONE: Record<string, Tone> = { owner: 'info', colleague: 'good', visitor: 'muted' };
const ROLE_TEXT: Record<string, string> = {
  visitor: 'Looks: the office, the people, tasks, and the terminals and documents of what is shared. Changes nothing.',
  colleague: 'Works on everything shared — talks and types to employees, hires, hands out tasks, answers and approves — and has a room for the sessions on their own computer. Does not run the office.',
  owner: "Everything: members, settings and policies, machines, the layout — and other members' own computers.",
};

/** Who is here, what people say to each other, and — for the owner — who is invited and how they get in. */
function PeoplePanel({ onClose }: { arg: string | null; onClose: () => void }) {
  const me = useOffice((s) => s.me);
  const people = useOffice((s) => s.people);
  const clientId = useOffice((s) => s.clientId);
  const chat = useOffice((s) => s.chat);
  const office = useOffice((s) => s.settings?.companyName ?? 'the office');
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [chat.length]);
  const owner = me?.kind === 'owner';
  const others = people.filter((p) => p.id !== clientId);

  return (
    <Window title="People" subtitle={owner ? `${others.length ? `${others.length} other${others.length === 1 ? '' : 's'} here now` : 'Nobody else is here'} · other people can walk around ${office} with you` : `You are in ${office} as a ${me?.role ?? 'guest'}`} onClose={onClose} width={owner ? 980 : 620}>
      <div className={owner ? 'people-cols' : 'col'} style={{ gap: 16 }}>
        <div className="col" style={{ gap: 12, minWidth: 0 }}>
          <div>
            <div className="section-title">Here now</div>
            <div className="row row-wrap" style={{ gap: 8 }}>
              <span className="people-chip">
                <span className="strong">{me?.name ?? 'You'}</span> <Badge tone={ROLE_TONE[me?.role ?? 'owner']}>{me?.role ?? 'owner'}</Badge> <span className="faint">you</span>
              </span>
              {others.map((p) => (
                <span key={p.id} className="people-chip" style={{ borderColor: `hsl(${p.hue} 70% 60%)` }}>
                  <span className="strong">{p.name}</span> <Badge tone={ROLE_TONE[p.role]}>{p.role}</Badge>
                </span>
              ))}
            </div>
          </div>
          <div>
            <div className="section-title">Talk to the people here</div>
            <div ref={log} className="people-log">
              {chat.length === 0 && <div className="small faint">Nothing said yet. What you write here is heard by the people in the office — not by the employees.</div>}
              {chat.map((c) => (
                <div key={c.id} className="small">
                  <span className="strong">{c.name}</span> <span className="faint">{new Date(c.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  <div className={c.emote ? 'chat-emote' : undefined}>{c.emote ? `${c.name} ${c.text}.` : c.text}</div>
                </div>
              ))}
            </div>
            <form
              className="row"
              style={{ marginTop: 8 }}
              onSubmit={(ev) => {
                ev.preventDefault();
                useOffice.getState().say(text);
                setText('');
              }}
            >
              <input value={text} onChange={(ev) => setText(ev.target.value)} placeholder="Say something…" maxLength={300} aria-label="Say something to the people here" autoFocus />
              <Button variant="primary" type="submit" disabled={!text.trim()}>
                Say
              </Button>
            </form>
            <div className="small faint" style={{ marginTop: 4 }}>
              In the office, press <span className="kbd">Enter</span> to say something without opening this window.
            </div>
          </div>
        </div>
        {owner && <GuestsAdmin />}
      </div>
    </Window>
  );
}

/** The owner's side: open the office to guests, invite people, change what they may do, take access away. */
function GuestsAdmin() {
  const [sharing, setSharing] = useState<Sharing | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('colleague');
  const [address, setAddress] = useState('');
  const [invite, setInvite] = useState<{ name: string; code: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () =>
    api<Sharing>('GET', '/sharing').then((s) => {
      setSharing(s);
      setAddress((a) => a || s.wanted.address || '');
    }, () => undefined);
  useEffect(() => {
    void load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, []);
  if (!sharing) return <div className="small muted">Loading…</div>;
  const open = sharing.door.open;
  const run = async <T,>(fn: () => Promise<T>, ok?: string) => {
    setBusy(true);
    const res = await act(fn, ok);
    setBusy(false);
    void load();
    return res;
  };
  const active = sharing.guests.filter((g) => !g.revokedAt);

  return (
    <div className="col" style={{ gap: 12, minWidth: 0 }}>
      <div className="card col" style={{ gap: 8 }}>
        <div className="row">
          <div className="section-title" style={{ margin: 0 }}>
            Open the office to its members
          </div>
          <span className="grow" />
          <Badge tone={open ? 'good' : 'muted'}>{open ? 'open' : 'closed'}</Badge>
          <Button small variant={open ? 'default' : 'primary'} disabled={busy} onClick={() => void run(() => api('POST', '/sharing', { open: !open }), open ? 'The office is closed to the network' : 'The office is open to its members')}>
            {open ? 'Close' : 'Open'}
          </Button>
        </div>
        <div className="small muted">
          The office normally answers only on its own computer. Open, it also answers on the network — encrypted, with a certificate made here — and only for people who were invited. Nobody gets the server's own owner token, and the only machine that can join from outside is a member's own computer, for their own sessions.
        </div>
        {sharing.door.error && !open && <div className="small bad">{sharing.door.error}</div>}
        {open && (
          <>
            <div className="small">
              <span className="muted">Reachable at </span>
              {sharing.door.addresses.length ? sharing.door.addresses.map((a) => <span key={a} className="mono" style={{ marginRight: 10 }}>{a}</span>) : <span className="faint">no network address found on this computer</span>}
            </div>
            <Field label="Another address people can reach you at (optional)" hint="For guests outside your network: a VPN name (e.g. Tailscale) or a forwarded port on your router, as https://name-or-ip:port. It is added to new invitations.">
              <div className="row">
                <input className="mono" value={address} onChange={(ev) => setAddress(ev.target.value)} placeholder={`https://my-computer.tailnet.ts.net:${sharing.door.port ?? 4610}`} spellCheck={false} />
                <Button small disabled={busy || address.trim() === (sharing.wanted.address ?? '')} onClick={() => void run(() => api('POST', '/sharing', { address: address.trim() }), 'Saved')}>
                  Save
                </Button>
              </div>
            </Field>
          </>
        )}
      </div>

      <div className="card col" style={{ gap: 8 }}>
        <div className="section-title" style={{ margin: 0 }}>
          Invite someone
        </div>
        <form
          className="row"
          onSubmit={async (ev) => {
            ev.preventDefault();
            const made = await run(() => api<{ guest: Guest; invite: string }>('POST', '/guests', { name: name.trim(), role }));
            if (!made) return;
            setInvite({ name: made.guest.name, code: made.invite });
            setName('');
          }}
        >
          <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Their name" maxLength={40} aria-label="Guest name" />
          <select value={role} onChange={(ev) => setRole(ev.target.value as Role)} aria-label="Role" style={{ width: 'auto' }}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r[0]!.toUpperCase() + r.slice(1)}
              </option>
            ))}
          </select>
          <Button variant="primary" type="submit" disabled={!name.trim() || busy || !open} title={open ? undefined : 'Open the office to its members first'}>
            Invite
          </Button>
        </form>
        <div className="small faint">{ROLE_TEXT[role]}</div>
        {invite && (
          <div className="col" style={{ gap: 6 }}>
            <div className="small">
              Send this to <span className="strong">{invite.name}</span>. They start Orchestrator, choose <span className="strong">Connect to an office</span> and paste it. It is shown only now; anyone who has it can come in as {invite.name}.
            </div>
            <textarea className="mono" readOnly value={invite.code} aria-label="Invitation" style={{ minHeight: 76, fontSize: 11 }} onFocus={(ev) => ev.currentTarget.select()} />
            <div className="row">
              <Button small variant="primary" onClick={() => void copyText(invite.code, 'Invitation copied')}>
                Copy invitation
              </Button>
              <Button small variant="ghost" onClick={() => setInvite(null)}>
                Done
              </Button>
            </div>
          </div>
        )}
      </div>

      <div>
        <div className="section-title">Members ({active.length})</div>
        {active.length === 0 && <div className="small faint">Nobody is invited.</div>}
        {active.map((g) => (
          <div key={g.id} className="row" style={{ padding: '5px 0', gap: 8 }}>
            <span className="strong truncate" style={{ minWidth: 90 }}>
              {g.name}
            </span>
            <select value={g.role} disabled={busy} aria-label={`Role of ${g.name}`} style={{ width: 'auto' }} onChange={(ev) => void run(() => api('PATCH', `/guests/${g.id}`, { role: ev.target.value }), `${g.name} is now a ${ev.target.value}`)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <span className="small faint grow truncate">{g.lastSeenAt ? `seen ${timeAgo(g.lastSeenAt)}` : 'has not come in yet'}
              {g.via ? ` · let in at the door (${g.via === 'knock-browser' ? 'browser' : 'app'})` : ''}
              {g.expiresAt ? ` · until ${new Date(g.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
            <Button
              small
              disabled={busy || !open}
              title="Make a new invitation for them; the old one stops working"
              onClick={async () => {
                const made = await run(() => api<{ guest: Guest; invite: string }>('POST', `/guests/${g.id}/reissue`, {}));
                if (made) setInvite({ name: made.guest.name, code: made.invite });
              }}
            >
              New invitation
            </Button>
            <Button small variant="danger" disabled={busy} onClick={() => window.confirm(`Take away ${g.name}'s access? They are disconnected at once and their invitation stops working.`) && void run(() => api('DELETE', `/guests/${g.id}`), `${g.name} can no longer come in`)}>
              Revoke
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

registerPanel('people', PeoplePanel);
