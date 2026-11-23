/**
 * An employee's own Telegram bot, in their profile (`docs/TELEGRAM.md`): three steps to set it up — make a bot with
 * @BotFather, paste its token, scan the code with your phone — and then who talks to them there, the groups they take
 * part in (and when they speak up in each), whether their questions go there too, and taking it all away.
 * The token is sent once and never comes back to a window.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import type { Employee } from '@orchestrator/contracts';
import { Button } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { act, ask } from '../core.tsx';
import { More } from './kit.tsx';

interface View {
  connected: boolean;
  bot: { username: string; name: string; link: string } | null;
  people: Array<{ tgId: number; name: string; username: string | null; as: string; since: string }>;
  questions: boolean;
  error: string | null;
  pairing: { until: string } | null;
  groups: Array<{ chatId: number; title: string; as: string; mode: 'addressed' | 'all'; since: string }>;
  hearsAll: boolean;
  /** The office counts you as in the office now: questions and messages to you stay here (`docs/TELEGRAM.md`). */
  here?: boolean;
}
interface Links {
  link: string;
  groupLink: string;
  until: string;
}

const minutesLeft = (until: string) => Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 60_000));
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** A QR code of a link, drawn as one SVG path (dark modules on a white card, with the quiet zone QR readers need). */
function Qr({ text, size = 148 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
    return { d, n: n + 8 };
  }, [text]);
  return (
    <svg className="tg-qr" width={size} height={size} viewBox={`0 0 ${path.n} ${path.n}`} shapeRendering="crispEdges" role="img" aria-label="QR code of the link">
      <rect width={path.n} height={path.n} fill="#fff" />
      <path d={path.d} fill="#0b0f17" />
    </svg>
  );
}

export function TelegramTab({ e }: { e: Employee }) {
  const [view, setView] = useState<View | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [links, setLinks] = useState<Links | null>(null);
  const [show, setShow] = useState<'phone' | 'group'>('phone');
  const [copied, setCopied] = useState(false);
  const [, tick] = useState(0);
  const load = () => api<View>('GET', `/employees/${e.id}/telegram`).then(setView, (err: Error) => setError(err.message));
  useEffect(() => {
    setView(null);
    setLinks(null);
    void load();
    // (Who paired, and the groups, change while the window is open: looked at again now and then.)
    const t = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(t);
  }, [e.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A link that was used has done its job: once the person (or the group) it was for is in, it is put away.
  const seen = useRef({ people: -1, groups: -1 });
  useEffect(() => {
    if (!view) return;
    const was = seen.current;
    if (links && ((show === 'phone' && was.people >= 0 && view.people.length > was.people) || (show === 'group' && was.groups >= 0 && view.groups.length > was.groups))) setLinks(null);
    seen.current = { people: view.people.length, groups: view.groups.length };
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  // The minutes a link has left, said right; an old link goes.
  useEffect(() => {
    if (!links) return;
    const t = window.setInterval(() => (Date.parse(links.until) < Date.now() ? setLinks(null) : tick((n) => n + 1)), 20_000);
    return () => window.clearInterval(t);
  }, [links]);

  const connect = async () => {
    if (!token.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<View & Links>('PUT', `/employees/${e.id}/telegram`, { token: token.trim() });
      setView(r);
      setLinks({ link: r.link, groupLink: r.groupLink, until: r.until });
      setShow('phone');
      setToken('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const newLink = async (which: 'phone' | 'group') => {
    const r = await act(() => api<Links>('POST', `/employees/${e.id}/telegram/pair`, {}));
    if (r) {
      setLinks(r);
      setShow(which);
    }
  };
  const copy = (text: string) =>
    void navigator.clipboard?.writeText(text).then(
      () => (setCopied(true), window.setTimeout(() => setCopied(false), 1500)),
      () => undefined,
    );

  if (!view) return <div className="k-text">{error || 'Loading…'}</div>;

  if (!view.connected) {
    return (
      <div className="k-stack tg" data-telegram="setup">
        <div className="tg-intro">
          <div className="k-title">Talk to {e.name} on Telegram</div>
          <p className="k-text">A bot of their own: what you write goes into their real session; their answers, questions and approvals come back. Add it to a group and they join the conversation.</p>
        </div>
        <ol className="k-group tg-steps">
          <li className="k-row">
            <span className="tg-num">1</span>
            <div className="k-main">
              <div className="k-title-sm">Make a bot</div>
              <div className="k-sub">
                In @BotFather send <code>/newbot</code> and name it — “{e.name}”, say. It answers with a token.
              </div>
            </div>
            <a className="btn btn-sm k-quiet" href="https://t.me/BotFather" target="_blank" rel="noreferrer">
              Open @BotFather
            </a>
          </li>
          <li className="k-row">
            <span className="tg-num">2</span>
            <div className="k-main">
              <div className="k-title-sm">Paste its token here</div>
              <form
                className="tg-token"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void connect();
                }}
              >
                <input value={token} onChange={(ev) => setToken(ev.target.value)} placeholder="123456789:AAH…" autoComplete="off" spellCheck={false} aria-label="The bot's token" data-telegram-token style={{ width: 'auto' }} />
                <Button variant="primary" type="submit" disabled={!token.trim() || busy}>
                  {busy ? 'Checking…' : 'Connect'}
                </Button>
              </form>
              {error && (
                <div className="k-sub k-bad tg-error" role="alert">
                  {error}
                </div>
              )}
            </div>
          </li>
          <li className="k-row tg-later">
            <span className="tg-num">3</span>
            <div className="k-main">
              <div className="k-title-sm">Scan the code with your phone</div>
              <div className="k-sub">It works once, and only for you. Anybody else who finds the bot is told it is private.</div>
            </div>
          </li>
        </ol>
        <p className="k-text tg-fine">The token is locked with the office's vault key and never shown again.</p>
      </div>
    );
  }

  const bot = view.bot!;
  const shown = links ? (show === 'group' ? links.groupLink : links.link) : null;
  const summary = [plural(view.people.length, 'person', 'people'), plural(view.groups.length, 'group', 'groups')].join(' · ');
  const nobody = view.people.length === 0;
  return (
    <div className="k-stack tg" data-telegram="connected">
      <div className="k-group">
        <div className="k-row">
          <span className="tg-logo" aria-hidden>
            {bot.username.slice(0, 1).toUpperCase()}
          </span>
          <div className="k-main">
            <div className="k-title">@{bot.username}</div>
            <div className="k-sub">
              {view.error ? (
                <span className="k-bad">{view.error}</span>
              ) : (
                <>
                  <i className="k-dot" aria-hidden /> Listening · {summary}
                </>
              )}
            </div>
          </div>
          <a className="btn btn-sm k-quiet" href={bot.link} target="_blank" rel="noreferrer">
            Open in Telegram
          </a>
        </div>
      </div>

      {shown && links ? (
        <div className="k-sheet tg-link" data-telegram-link={show}>
          <Qr text={shown} />
          <div className="tg-link-main">
            <div className="k-title">{show === 'phone' ? 'Scan with your phone' : `Add ${e.name} to a group`}</div>
            <div className="k-sub">{show === 'phone' ? `Telegram opens the bot; press Start and you are talking to ${e.name} — as you.` : 'Scan or open it, pick the group, and the bot joins. Everybody there can then talk to them, in your name.'}</div>
            <div className="k-code">
              <a href={shown} target="_blank" rel="noreferrer">
                {shown.replace(/^https:\/\//, '')}
              </a>
              <button type="button" className="btn btn-sm k-quiet" onClick={() => copy(shown)}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="tg-link-foot">
              <span className="k-sub">Works once · {minutesLeft(links.until)} min left</span>
              <button type="button" className="k-link" onClick={() => setLinks(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      ) : (
        nobody && (
          <div className="k-sheet tg-first">
            <div className="k-main">
              <div className="k-title">Connect your phone</div>
              <div className="k-sub">
                A code to scan — then whatever you write to @{bot.username} goes to {e.name}.
              </div>
            </div>
            <Button variant="primary" onClick={() => void newLink('phone')} data-telegram-pair-first>
              Show the code
            </Button>
          </div>
        )
      )}

      <section className="tg-section">
        <div className="k-head">
          <span className="k-label">People</span>
          <button type="button" className="k-link" onClick={() => void newLink('phone')} data-telegram-pair>
            + Connect a phone
          </button>
        </div>
        {view.people.length > 0 ? (
          <div className="k-group">
            {view.people.map((p) => (
              <div className="k-row k-row-sm" key={p.tgId} data-telegram-person={p.username ?? p.name}>
                <span className="tg-face" aria-hidden>
                  {p.name.slice(0, 1).toUpperCase()}
                </span>
                <div className="k-main">
                  <div className="k-title-sm">
                    {p.name}
                    {p.username && <span className="k-title-note"> @{p.username}</span>}
                  </div>
                  <div className="k-sub">
                    as {p.as} · since {day(p.since)}
                  </div>
                </div>
                <button type="button" className="k-x" title="Disconnect this person" aria-label={`Disconnect ${p.name}`} onClick={() => void act(() => api<View>('DELETE', `/employees/${e.id}/telegram/people/${p.tgId}`).then(setView), `${p.name} disconnected`)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="k-sub">Nobody yet.</div>
        )}
      </section>

      <section className="tg-section">
        <div className="k-head">
          <span className="k-label">Groups</span>
          <button type="button" className="k-link" onClick={() => void newLink('group')} data-telegram-group>
            + Add to a group
          </button>
        </div>
        {view.groups.length > 0 ? (
          <div className="k-group">
            {view.groups.map((g) => (
              <div className="k-row k-row-sm" key={g.chatId} data-telegram-chat={g.title}>
                <span className="tg-face tg-face-group" aria-hidden>
                  #
                </span>
                <div className="k-main">
                  <div className="k-title-sm">{g.title}</div>
                  <div className="k-sub">{g.mode === 'all' ? 'Follows everything, speaks up when it is for them' : 'Answers when named, mentioned or replied to'}</div>
                </div>
                <div className="k-filters" role="group" aria-label={`When ${e.name} speaks in ${g.title}`}>
                  {(
                    [
                      ['addressed', 'When talked to', 'A mention, their name, a reply to them, or a follow-up.'],
                      ['all', 'Everything', 'Every message reaches them and they decide — each pause in the chat is a turn of their Claude.'],
                    ] as const
                  ).map(([mode, label, why]) => (
                    <button key={mode} type="button" title={why} aria-pressed={g.mode === mode} className={g.mode === mode ? 'k-filter-on' : ''} data-telegram-mode={mode} onClick={() => g.mode !== mode && void act(() => api<View>('PATCH', `/employees/${e.id}/telegram/groups/${g.chatId}`, { mode }).then(setView))}>
                      {label}
                    </button>
                  ))}
                </div>
                <button type="button" className="k-x" title="Leave this group" aria-label={`Leave ${g.title}`} onClick={() => void act(() => api<View>('DELETE', `/employees/${e.id}/telegram/groups/${g.chatId}`).then(setView), `${e.name} left ${g.title}`)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="k-sub">In no group yet.</div>
        )}
        {!view.hearsAll && (
          <More summary={<span data-telegram-privacy>Telegram shows this bot only messages that mention it</span>} startOpen={view.groups.length > 0}>
            <div className="k-note">
              To let {e.name} follow the whole chat and notice when it is about them: in @BotFather send <code>/setprivacy</code>, pick @{bot.username}, choose <b>Disable</b> — then add the bot to the group again.{' '}
              <button type="button" className="k-link" onClick={() => void act(() => api<View>('POST', `/employees/${e.id}/telegram/check`, {}).then(setView))}>
                Check again
              </button>
            </div>
          </More>
        )}
      </section>

      <div className="k-group">
        <label className="k-row k-row-sm tg-switch">
          <div className="k-main">
            <div className="k-title-sm">Questions and approvals</div>
            <div className="k-sub">Sent to the people above, with buttons to answer. Never to a group.</div>
            <div className="k-sub" data-tg-here={view.here ? 'yes' : 'no'}>
              {view.here
                ? 'You are in the office now, so they — and what employees write to you — stay here. If you leave this window (another one in front, or 10 minutes untouched) while one is still open, it comes to Telegram then.'
                : 'While you are in the office (this window in front and used) they stay here, and come to Telegram only if you leave with one still open.'}
            </div>
          </div>
          <input type="checkbox" role="switch" checked={view.questions} onChange={(ev) => void act(() => api<View>('PATCH', `/employees/${e.id}/telegram`, { questions: ev.target.checked }).then(setView))} />
        </label>
      </div>

      <div className="k-actions">
        <Button
          variant="ghost"
          className="k-quiet"
          onClick={async () => {
            if (!(await ask({ title: `Disconnect @${bot.username}?`, body: `${e.name} stops listening to it: everybody who talks to them there, and every group, is told and let go. The token is forgotten (the bot itself stays yours in Telegram).`, ok: 'Disconnect' }))) return;
            await act(() => api<View>('DELETE', `/employees/${e.id}/telegram`).then(setView), 'Telegram disconnected');
            setLinks(null);
          }}
        >
          Disconnect the bot
        </Button>
      </div>
    </div>
  );
}
