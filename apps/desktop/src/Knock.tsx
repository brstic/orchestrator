import { useEffect, useRef, useState } from 'react';
import { Button } from '@orchestrator/ui';
import { connection, serverBase, setToken } from './lib/api.ts';

type Stage = { at: 'ask' } | { at: 'waiting'; id: string; secret: string; code: string; anyoneIn: boolean } | { at: 'refused' } | { at: 'gone' };

/**
 * The office's page for someone who has no invitation: say who you are and knock. The people inside
 * see it and one of them lets you in — from a browser, to look around: you can watch, not change
 * anything. Nothing here grants access by itself; the office answers only once someone inside has.
 */
/**
 * Signing in with a name and a password — for a member who was given one (Access, in the office). What comes back is
 * that member's own session; the form says no more than "does not match" when it does not.
 */
export function SignIn({ onBack }: { onBack?: () => void }) {
  const [username, setUsername] = useState(() => {
    try {
      return localStorage.getItem('orch.login-name') ?? '';
    } catch {
      return '';
    }
  });
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const signIn = async () => {
    if (busy || !username.trim() || !password) return;
    setError('');
    setBusy(true);
    try {
      const res = await fetch(`${serverBase}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: username.trim(), password }) });
      const a = await res.json().catch(() => ({}));
      if (!res.ok || !a.token) throw new Error(a?.error ?? 'The office did not answer.');
      try {
        localStorage.setItem('orch.login-name', username.trim());
      } catch {
        /* private window */
      }
      setPassword('');
      setToken(a.token);
      connection.connect();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="col"
      style={{ gap: 10 }}
      onSubmit={(ev) => {
        ev.preventDefault();
        void signIn();
      }}
    >
      <input value={username} maxLength={40} placeholder="Name" aria-label="Name" autoComplete="username" autoFocus={!username} onChange={(e) => setUsername(e.target.value)} />
      <input type="password" value={password} maxLength={200} placeholder="Password" aria-label="Password" autoComplete="current-password" autoFocus={!!username} onChange={(e) => setPassword(e.target.value)} />
      {error && <div className="small bad">{error}</div>}
      <Button variant="primary" type="submit" disabled={busy || !username.trim() || !password}>
        Sign in
      </Button>
      {onBack && (
        <div className="small faint">
          No password?{' '}
          <button type="button" className="linklike" onClick={onBack}>
            Ask to come in instead
          </button>
        </div>
      )}
    </form>
  );
}

export function Knock({ office, onOwnToken }: { office: string; onOwnToken: () => void }) {
  // Somebody who has signed in here before is shown the sign-in first.
  const [signingIn, setSigningIn] = useState(() => {
    try {
      return !!localStorage.getItem('orch.login-name');
    } catch {
      return false;
    }
  });
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('orch.knock-name') ?? '';
    } catch {
      return '';
    }
  });
  const [stage, setStage] = useState<Stage>({ at: 'ask' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const waiting = stage.at === 'waiting' ? stage : null;
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  // While waiting: ask every two seconds how it stands. The office forgets a knocker who stops asking.
  useEffect(() => {
    if (!waiting) return;
    const { id, secret } = waiting;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch(`${serverBase}/knock/${id}`, { headers: { 'x-knock-secret': secret }, cache: 'no-store' });
        const a = await res.json();
        if (!live.current) return;
        if (a.status === 'admitted') {
          window.clearInterval(timer);
          setToken(a.token);
          connection.connect();
        } else if (a.status === 'refused' || a.status === 'gone') setStage({ at: a.status });
        else if (a.status === 'waiting' && a.anyoneIn !== waiting.anyoneIn) setStage({ ...waiting, anyoneIn: !!a.anyoneIn });
      } catch {
        /* the office did not answer this time; ask again */
      }
    }, 2000);
    // Closing the page is walking away from the door.
    const leave = () => void fetch(`${serverBase}/knock/${id}`, { method: 'DELETE', headers: { 'x-knock-secret': secret }, keepalive: true }).catch(() => undefined);
    window.addEventListener('pagehide', leave);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', leave);
    };
  }, [waiting?.id, waiting?.anyoneIn]); // eslint-disable-line react-hooks/exhaustive-deps

  const knock = async () => {
    setError('');
    setBusy(true);
    try {
      const res = await fetch(`${serverBase}/knock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, via: 'browser' }) });
      const a = await res.json();
      if (!res.ok) throw new Error(a?.error ?? 'The office did not answer.');
      try {
        localStorage.setItem('orch.knock-name', name.trim());
      } catch {
        /* private window */
      }
      setStage({ at: 'waiting', id: a.id, secret: a.secret, code: a.code, anyoneIn: !!a.anyoneIn });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    if (waiting) void fetch(`${serverBase}/knock/${waiting.id}`, { method: 'DELETE', headers: { 'x-knock-secret': waiting.secret } }).catch(() => undefined);
    setStage({ at: 'ask' });
  };

  return (
    <div className="login">
      <div className="glass login-card knock-card col" style={{ gap: 14 }}>
        <div className="knock-kicker">ORCHESTRATOR</div>
        <h1 className="knock-office">{office}</h1>
        {signingIn ? (
          <>
            <p className="muted">Sign in with the name and the password you were given for this office.</p>
            <SignIn onBack={() => setSigningIn(false)} />
          </>
        ) : stage.at === 'waiting' ? (
          <>
            <p>
              You knocked as <b>{name.trim()}</b>. {stage.anyoneIn ? 'The people inside can see you at the door; one of them has to let you in.' : 'Nobody who can open the door is inside right now. Your knock stays up while this page is open, for whoever walks in.'}
            </p>
            <div className="knock-code" aria-label="Your code">
              {stage.code}
            </div>
            <p className="small muted">They see this code next to your name — tell it to them if they ask whether it is really you.</p>
            <div className="row">
              <span className="knock-dots grow" aria-hidden>
                waiting<i>.</i>
                <i>.</i>
                <i>.</i>
              </span>
              <Button variant="ghost" onClick={cancel}>
                Never mind
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">
              {stage.at === 'refused'
                ? 'They did not let you in this time.'
                : stage.at === 'gone'
                  ? 'Nobody answered the door. You can knock again.'
                  : 'This is a working office. Ask to come in: someone inside will let you in to look around — you can watch what is going on, not change anything.'}
            </p>
            <input value={name} maxLength={40} placeholder="Your name" aria-label="Your name" autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim().length >= 2 && !busy && void knock()} />
            {error && <div className="small bad">{error}</div>}
            <Button variant="primary" disabled={busy || name.trim().length < 2} onClick={() => void knock()}>
              {stage.at === 'ask' ? 'Ask to come in' : 'Knock again'}
            </Button>
            <div className="small faint">
              A member of this office?{' '}
              <button type="button" className="linklike" onClick={() => setSigningIn(true)}>
                Sign in with your password
              </button>
            </div>
            <div className="small faint">
              Working here every day? The Orchestrator desktop app lets you in with your own computer.{' '}
              <button type="button" className="linklike" onClick={onOwnToken}>
                I have an owner token
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
