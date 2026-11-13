import { useEffect, useState } from 'react';
import { Badge, Button, Field, Window, timeAgo, type Tone } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';
import { act, ask } from '../core.tsx';
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
  /** Until when their invitation link can still be used; null once it was used (or there is none). */
  inviteExpiresAt?: string | null;
  /** They can sign in at the office's address with their name and a password (never the password itself). */
  hasPassword?: boolean;
}

interface Sharing {
  door: { open: boolean; port: number | null; addresses: string[]; fingerprint: string | null; error: string | null };
  wanted: { open: boolean; port: number; address: string | null };
  guests: Guest[];
}

/** What pressing Invite gives back: a link that works once — or, in an office with no address set, text to paste. */
interface Made {
  guest: Guest;
  invite: string;
  link: boolean;
  expiresAt: string | null;
}

const ROLE_TONE: Record<string, Tone> = { owner: 'info', colleague: 'good', visitor: 'muted' };
const ROLE_TEXT: Record<string, string> = {
  visitor: 'Looks: the office, the people, tasks, and the terminals and documents of what is shared. Changes nothing.',
  colleague: 'Works on everything shared — talks and types to employees, hires, hands out tasks, answers and approves — and has a room for the sessions on their own computer. Does not run the office.',
  owner: "Everything: members, settings and policies, machines, the layout — and other members' own computers.",
};
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

/**
 * Access: who can come into the office, and as what. For an owner: the address people come to, inviting
 * someone with a link, and the members. For everyone else: what their own role lets them do, and who is here.
 */
function AccessPanel({ onClose }: { arg: string | null; onClose: () => void }) {
  const me = useOffice((s) => s.me);
  const people = useOffice((s) => s.people);
  const clientId = useOffice((s) => s.clientId);
  const office = useOffice((s) => s.settings?.companyName ?? 'the office');
  const others = people.filter((p) => p.id !== clientId);
  if (me?.kind === 'owner') {
    return (
      <Window kit title="Access" subtitle={`Who can come into ${office}, and as what`} onClose={onClose} width={700}>
        <OwnerAccess here={new Set(others.map((p) => p.memberId).filter((id): id is string => !!id))} />
      </Window>
    );
  }
  const role = me?.role ?? 'visitor';
  return (
    <Window kit title="Access" subtitle={`You are in ${office} as ${role === 'owner' ? 'an owner' : `a ${role}`}`} onClose={onClose} width={560}>
      <div className="col" style={{ gap: 14 }}>
        <div className="small">{ROLE_TEXT[role]}</div>
        <div>
          <div className="section-title">Here now</div>
          <div className="row row-wrap" style={{ gap: 8 }}>
            <span className="people-chip">
              <span className="strong">{me?.name ?? 'You'}</span> <Badge tone={ROLE_TONE[role]}>{role}</Badge> <span className="faint">you</span>
            </span>
            {others.map((p) => (
              <span key={p.id} className="people-chip" style={{ borderColor: `hsl(${p.hue} 70% 60%)` }}>
                <span className="strong">{p.name}</span> <Badge tone={ROLE_TONE[p.role]}>{p.role}</Badge>
              </span>
            ))}
          </div>
        </div>
      </div>
    </Window>
  );
}

/** The owner's side: where people come in, inviting them, what each may do, taking access away. */
function OwnerAccess({ here }: { here: Set<string> }) {
  const [sharing, setSharing] = useState<Sharing | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('colleague');
  const [address, setAddress] = useState('');
  const [made, setMade] = useState<Made | null>(null);
  // Whose password is being set (the form opens under their row).
  const [passwordFor, setPasswordFor] = useState<string | null>(null);
  const [password, setPassword] = useState('');
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
  const saved = sharing.wanted.address ?? '';
  const run = async <T,>(fn: () => Promise<T>, ok?: string) => {
    setBusy(true);
    const res = await act(fn, ok);
    setBusy(false);
    void load();
    return res;
  };
  const active = sharing.guests.filter((g) => !g.revokedAt);
  const cannotInvite = !open ? 'Open the office first' : !saved ? 'Save the address people come to first' : undefined;
  // (Closed, there is nothing to invite into: the form is not shown. A new link for a member still says why it cannot be made.)
  const statusOf = (g: Guest) =>
    [
      g.inviteExpiresAt ? `invited · the link works until ${day(g.inviteExpiresAt)}` : g.lastSeenAt ? `here ${timeAgo(g.lastSeenAt)}` : 'has not come in yet',
      g.via ? `let in at the door (${g.via === 'knock-browser' ? 'browser' : 'app'})` : '',
      g.expiresAt ? `until ${new Date(g.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '',
    ]
      .filter(Boolean)
      .join(' · ');

  return (
    <div className="col" style={{ gap: 14, minWidth: 0 }}>
      <div className="card col" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 12 }}>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="strong">{open ? 'The office is open to the people you invite' : 'The office is closed'}</div>
            <div className="small muted">{open ? 'They come in over the network, encrypted, each with access of their own.' : 'It answers only on its own computer. Nobody can come in until you open it; nobody is removed.'}</div>
          </div>
          <Button variant={open ? 'default' : 'primary'} disabled={busy} onClick={() => void run(() => api('POST', '/sharing', { open: !open }), open ? 'The office is closed to the network' : 'The office is open to its members')}>
            {open ? 'Close' : 'Open'}
          </Button>
        </div>
        {sharing.door.error && !open && <div className="small bad">{sharing.door.error}</div>}
        {open && (
          <Field label="Address people come to" hint="Where this office is reached from outside: a domain that points here, a VPN name, or this computer's address on your network. Invitation links start with it.">
            <div className="row">
              <input className="mono" value={address} onChange={(ev) => setAddress(ev.target.value)} placeholder="https://office.example.com" spellCheck={false} />
              <Button small disabled={busy || address.trim().replace(/\/+$/, '') === saved} onClick={() => void run(() => api('POST', '/sharing', { address: address.trim() }), 'Saved')}>
                Save
              </Button>
            </div>
          </Field>
        )}
        {open && !saved && sharing.door.addresses.length > 0 && (
          <div className="small muted">
            No address of your own? This computer answers at{' '}
            {sharing.door.addresses.map((a) => (
              <button key={a} type="button" className="fp-link mono" style={{ marginRight: 10 }} onClick={() => setAddress(a)}>
                {a}
              </button>
            ))}
          </div>
        )}
      </div>

      {open && (
      <div className="card col" style={{ gap: 8 }}>
        <div className="section-title" style={{ margin: 0 }}>
          Invite someone
        </div>
        <form
          className="row"
          onSubmit={async (ev) => {
            ev.preventDefault();
            const res = await run(() => api<Made>('POST', '/guests', { name: name.trim(), role }));
            if (!res) return;
            setMade(res);
            setName('');
          }}
        >
          <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Their name" maxLength={40} aria-label="Their name" />
          <select value={role} onChange={(ev) => setRole(ev.target.value as Role)} aria-label="Role" style={{ width: 'auto' }}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r[0]!.toUpperCase() + r.slice(1)}
              </option>
            ))}
          </select>
          <Button variant="primary" type="submit" disabled={!name.trim() || busy || !!cannotInvite} title={cannotInvite}>
            Invite
          </Button>
        </form>
        <div className="small faint">{saved ? ROLE_TEXT[role] : 'Save the address people come to first: the invitation link starts with it.'}</div>
        {made && (
          <div className="col access-made" style={{ gap: 6 }} data-invite-for={made.guest.name}>
            <div className="small">
              Send this {made.link ? 'link' : 'text'} to <span className="strong">{made.guest.name}</span>. They paste it into the Orchestrator app, under <span className="strong">Connect to an office</span>.{' '}
              {made.link && made.expiresAt ? `It works once, until ${day(made.expiresAt)}.` : `Anyone who has it can come in as ${made.guest.name}.`}
            </div>
            <div className="row">
              <input className="mono" readOnly value={made.invite} aria-label="Invitation" onFocus={(ev) => ev.currentTarget.select()} />
              <Button small variant="primary" onClick={() => void copyText(made.invite, made.link ? 'Link copied' : 'Invitation copied')}>
                {made.link ? 'Copy link' : 'Copy'}
              </Button>
            </div>
            <div className="small faint">It is shown only now. If it gets lost, make another with New link.</div>
          </div>
        )}
        {!made && saved && <div className="small faint">Or give them only the address: they type it into the app, and you let them in at the door.</div>}
      </div>
      )}

      <div>
        <div className="section-title">Members ({active.length})</div>
        {active.length === 0 && <div className="small faint">Nobody is invited.</div>}
        {active.map((g) => (
          <div key={g.id} className="row" style={{ padding: '5px 0', gap: 8, flexWrap: 'wrap' }} data-member={g.name}>
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
            {here.has(g.id) ? <Badge tone="good">here now</Badge> : null}
            <span className="small faint grow truncate">{here.has(g.id) ? '' : statusOf(g)}</span>
            <Button
              small
              disabled={busy || !!cannotInvite}
              title={cannotInvite ?? 'A new invitation link for them; what they have now stops working'}
              onClick={async () => {
                // Someone who is already in loses that access until they use the new link: say so first.
                if (g.lastSeenAt && !(await ask({ title: `Give ${g.name} a new link?`, body: `${g.name} is disconnected at once and comes back in only with the new link.`, ok: 'Make a new link' }))) return;
                const res = await run(() => api<Made>('POST', `/guests/${g.id}/reissue`, {}));
                if (res) setMade(res);
              }}
            >
              New link
            </Button>
            <Button
              small
              disabled={busy}
              title={g.hasPassword ? `${g.name} can sign in at the office's address with their name and a password. Set a new one, or remove it.` : `Let ${g.name} sign in at the office's address with their name and a password — beside their invitation.`}
              onClick={() => setPasswordFor(passwordFor === g.id ? null : g.id)}
            >
              {g.hasPassword ? 'Password ✓' : 'Password…'}
            </Button>
            <Button small variant="ghost" disabled={busy} onClick={() => void ask({ title: `Take away ${g.name}'s access?`, body: 'They are disconnected at once and their invitation stops working.', ok: 'Take away access', danger: true }).then((yes) => { if (yes) void run(() => api('DELETE', `/guests/${g.id}`), `${g.name} can no longer come in`); })}>
              Revoke…
            </Button>
            {passwordFor === g.id && (
              <form
                className="row"
                style={{ gap: 6, flexBasis: '100%', flexWrap: 'wrap' }}
                onSubmit={async (ev) => {
                  ev.preventDefault();
                  const ok = await run(() => api('POST', `/guests/${g.id}/password`, { password }), `${g.name} can sign in with that password`);
                  if (ok) {
                    setPassword('');
                    setPasswordFor(null);
                    await load();
                  }
                }}
              >
                <input type="password" className="grow" value={password} minLength={8} maxLength={200} autoFocus autoComplete="new-password" placeholder={`A password for ${g.name} (8 characters or more)`} aria-label={`Password for ${g.name}`} onChange={(ev) => setPassword(ev.target.value)} style={{ minWidth: 220 }} />
                <Button small variant="primary" type="submit" disabled={busy || password.length < 8}>
                  {g.hasPassword ? 'Set the new password' : 'Set password'}
                </Button>
                {g.hasPassword && (
                  <Button
                    small
                    variant="ghost"
                    type="button"
                    disabled={busy}
                    onClick={async () => {
                      const ok = await run(() => api('DELETE', `/guests/${g.id}/password`), `${g.name} can no longer sign in with a password`);
                      if (ok) {
                        setPasswordFor(null);
                        await load();
                      }
                    }}
                  >
                    Remove password
                  </Button>
                )}
                <span className="small faint" style={{ flexBasis: '100%' }}>
                  They sign in at the office's address with the name “{g.name}” and this password, as {g.role}. Five wrong passwords in a row close the name for a while. Tell them the password yourself; the office does not show it again.
                </span>
              </form>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

registerPanel('people', AccessPanel);
