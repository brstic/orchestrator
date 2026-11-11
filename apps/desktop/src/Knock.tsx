import { useEffect, useRef, useState } from 'react';
import { connection, serverBase, setToken } from './lib/api.ts';

/**
 * What somebody at the office's door can do, without the page around it: sign in with a name and a password, or
 * knock and wait to be let in. The page that shows these is `entrance/EntrancePage.tsx` (`entrance/Door.tsx` draws
 * the forms); the requests, what is remembered in the browser and what counts as an answer are all here.
 */

/** Read something this browser remembered; a private window remembers nothing. */
function remembered(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

/** Somebody who has signed in here before is shown the sign-in first. */
export const signedInBefore = (): boolean => !!remembered('orch.login-name');

/**
 * Signing in with a name and a password — for a member who was given one (Access, in the office). What comes back is
 * that member's own session; the form says no more than "does not match" when it does not.
 */
export function useSignIn() {
  const [username, setUsername] = useState(() => remembered('orch.login-name'));
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = !busy && !!username.trim() && !!password;
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
  return { username, setUsername, password, setPassword, error, busy, ready, signIn };
}

export type KnockStage = { at: 'ask' } | { at: 'waiting'; id: string; secret: string; code: string; anyoneIn: boolean } | { at: 'refused' } | { at: 'gone' };

/**
 * Knocking, for someone who has no invitation: say who you are and knock. The people inside see it and one of them
 * lets you in — from a browser, to look around: you can watch, not change anything. Nothing here grants access by
 * itself; the office answers only once someone inside has.
 */
export function useKnock() {
  const [name, setName] = useState(() => remembered('orch.knock-name'));
  const [stage, setStage] = useState<KnockStage>({ at: 'ask' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const waiting = stage.at === 'waiting' ? stage : null;
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => void (live.current = false);
  }, []);

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

  const ready = !busy && name.trim().length >= 2;
  const knock = async () => {
    if (busy || name.trim().length < 2) return;
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
  return { name, setName, stage, error, busy, ready, knock, cancel };
}
