/**
 * An employee's own Telegram bot, in their profile (`docs/TELEGRAM.md`): three steps to set it up — make a bot with
 * @BotFather, paste its token, open the one-time link on your phone — and then who talks to them there, the groups
 * they take part in (and when they speak up in each), whether their questions go there too, and taking it all away.
 * The token is sent once and never comes back to a window.
 */
import { useEffect, useState } from 'react';
import type { Employee } from '@orchestrator/contracts';
import { Button } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { act, ask } from '../core.tsx';

interface View {
  connected: boolean;
  bot: { username: string; name: string; link: string } | null;
  people: Array<{ tgId: number; name: string; username: string | null; as: string; since: string }>;
  questions: boolean;
  error: string | null;
  pairing: { until: string } | null;
  groups: Array<{ chatId: number; title: string; as: string; mode: 'addressed' | 'all'; since: string }>;
  hearsAll: boolean;
}
interface Links {
  link: string;
  groupLink: string;
  until: string;
}

const minutesLeft = (until: string) => Math.max(1, Math.round((Date.parse(until) - Date.now()) / 60_000));

export function TelegramTab({ e }: { e: Employee }) {
  const [view, setView] = useState<View | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [links, setLinks] = useState<Links | null>(null);
  const [show, setShow] = useState<'phone' | 'group'>('phone');
  const [copied, setCopied] = useState(false);
  const load = () => api<View>('GET', `/employees/${e.id}/telegram`).then(setView, (err: Error) => setError(err.message));
  useEffect(() => {
    setView(null);
    setLinks(null);
    void load();
    // (Who paired, and the groups, change while the window is open: looked at again now and then.)
    const t = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(t);
  }, [e.id]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <div>
          <div className="k-title">Talk to {e.name} from your phone</div>
          <p className="k-text">Give {e.name} a Telegram bot of their own. What you write to it goes into their real session; their answers, questions and permission requests come back there — and in a group you add them to, they join the conversation.</p>
        </div>
        <ol className="k-group tg-steps">
          <li className="k-row">
            <span className="tg-num">1</span>
            <div className="k-main">
              <div className="k-title-sm">Make a bot</div>
              <div className="k-sub">
                In Telegram, open <b>@BotFather</b>, send <code>/newbot</code>, and give it a name — e.g. “{e.name}”. It answers with a token.
              </div>
            </div>
            <a className="btn btn-sm" href="https://t.me/BotFather" target="_blank" rel="noreferrer">
              Open @BotFather
            </a>
          </li>
          <li className="k-row">
            <span className="tg-num">2</span>
            <div className="k-main">
              <div className="k-title-sm">Paste its token</div>
              <form
                className="tg-token"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void connect();
                }}
              >
                <input value={token} onChange={(ev) => setToken(ev.target.value)} placeholder="123456789:AA…" autoComplete="off" spellCheck={false} aria-label="The bot's token" data-telegram-token />
                <Button variant="primary" type="submit" disabled={!token.trim() || busy}>
                  {busy ? 'Checking with Telegram…' : 'Connect'}
                </Button>
              </form>
              {error && <div className="k-note k-bad" role="alert">{error}</div>}
            </div>
          </li>
          <li className="k-row">
            <span className="tg-num">3</span>
            <div className="k-main">
              <div className="k-title-sm">Open the link on your phone</div>
              <div className="k-sub">You get a link that works once: it lets you — and only you — talk to {e.name}. Anybody else who finds the bot is told it is private.</div>
            </div>
          </li>
        </ol>
        <p className="k-text">The token is kept locked with the office's vault key and never shown again.</p>
      </div>
    );
  }

  const bot = view.bot!;
  const shown = links ? (show === 'group' ? links.groupLink : links.link) : null;
  return (
    <div className="k-stack tg" data-telegram="connected">
      <div className="k-group">
        <div className="k-row">
          <span className={`k-dot ${view.error ? 'k-dot-bad' : ''}`} />
          <div className="k-main">
            <div className="k-title">
              @{bot.username} <span className="k-title-note">{bot.name}</span>
            </div>
            <div className="k-sub">{view.error ? <span className="k-bad">{view.error}</span> : `${e.name}'s line to Telegram — listening.`}</div>
          </div>
          <a className="btn btn-sm k-quiet" href={bot.link} target="_blank" rel="noreferrer">
            Open in Telegram
          </a>
        </div>
      </div>

      {shown && links && (
        <div className="k-sheet tg-link" data-telegram-link={show}>
          <div className="k-title-sm">{show === 'phone' ? 'Open this on your phone' : `Open this, then pick the group — ${e.name} joins it`}</div>
          <div className="k-code">
            <a href={shown} target="_blank" rel="noreferrer">
              {shown}
            </a>
            <button type="button" className="btn btn-sm k-quiet" onClick={() => copy(shown)}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="k-sub">
            Works once, for the next {minutesLeft(links.until)} minutes. {show === 'phone' ? 'It speaks as you: whatever you write there comes from you.' : 'Everybody in the group can talk to them then — as people you brought in.'}
          </div>
        </div>
      )}

      <div>
        <div className="k-head">
          <span className="k-label">Who talks to {e.name} here</span>
          <button type="button" className="k-link" onClick={() => void newLink('phone')} data-telegram-pair>
            Connect your Telegram
          </button>
        </div>
        {view.people.length ? (
          <div className="k-group">
            {view.people.map((p) => (
              <div className="k-row k-row-sm" key={p.tgId} data-telegram-person={p.username ?? p.name}>
                <div className="k-main">
                  <div className="k-title-sm">
                    {p.name}
                    {p.username && <span className="k-title-note"> @{p.username}</span>}
                  </div>
                  <div className="k-sub">as {p.as} in the office</div>
                </div>
                <button type="button" className="k-x" title="Disconnect this person" aria-label={`Disconnect ${p.name}`} onClick={() => void act(() => api<View>('DELETE', `/employees/${e.id}/telegram/people/${p.tgId}`).then(setView), `${p.name} disconnected`)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="k-text">Nobody yet. “Connect your Telegram” gives you a one-time link for your phone.</p>
        )}
      </div>

      <div>
        <div className="k-head">
          <span className="k-label">Groups</span>
          <button type="button" className="k-link" onClick={() => void newLink('group')} data-telegram-group>
            Add to a group
          </button>
        </div>
        {!view.hearsAll && (
          <div className="k-note" data-telegram-privacy>
            In groups, Telegram now shows this bot only messages that mention it or reply to it. To let {e.name} follow the conversation and notice when it is about them: in @BotFather send <code>/setprivacy</code>, choose @{bot.username}, <b>Disable</b> — then add the bot to the group again.{' '}
            <button type="button" className="k-link" onClick={() => void act(() => api<View>('POST', `/employees/${e.id}/telegram/check`, {}).then(setView))}>
              Check again
            </button>
          </div>
        )}
        {view.groups.length ? (
          <div className="k-group">
            {view.groups.map((g) => (
              <div className="k-row k-row-sm" key={g.chatId} data-telegram-chat={g.title}>
                <div className="k-main">
                  <div className="k-title-sm">{g.title}</div>
                  <div className="k-sub">connected by {g.as}</div>
                </div>
                <select value={g.mode} aria-label={`When ${e.name} speaks in ${g.title}`} onChange={(ev) => void act(() => api<View>('PATCH', `/employees/${e.id}/telegram/groups/${g.chatId}`, { mode: ev.target.value }).then(setView))} title="When talked to: a mention, their name, a reply to them, or a follow-up. Everything: every message goes to them and they decide — each pause in the conversation is a turn of their Claude.">
                  <option value="addressed">When talked to</option>
                  <option value="all">Everything (they decide)</option>
                </select>
                <button type="button" className="k-x" title="Leave this group" aria-label={`Leave ${g.title}`} onClick={() => void act(() => api<View>('DELETE', `/employees/${e.id}/telegram/groups/${g.chatId}`).then(setView), `${e.name} left ${g.title}`)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="k-text">In no group yet. “Add to a group” gives a link that adds the bot to a group of your choice; there {e.name} answers when somebody mentions them, says their name or replies to them.</p>
        )}
      </div>

      <label className="check">
        <input type="checkbox" checked={view.questions} onChange={(ev) => void act(() => api<View>('PATCH', `/employees/${e.id}/telegram`, { questions: ev.target.checked }).then(setView))} />
        Send their questions and permission requests to Telegram too (with buttons to answer)
      </label>

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
