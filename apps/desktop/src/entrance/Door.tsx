import { useEffect, useId, useRef, useState } from 'react';
import { signedInBefore, useKnock, useSignIn, useWalkIn } from '../Knock.tsx';

/**
 * The door itself: the card that travels down the entrance page with whoever reads it. Two ways in — a name and a
 * password for a member, or a knock for a visitor — drawn here; what they do is in `Knock.tsx`.
 *
 * Real forms and real inputs (a password manager has to recognise them), a label on every field, errors announced.
 * The class names `knock-card` and `knock-code` are what `tests/ui/guest-app.mjs` looks for.
 */
export function Door({
  office,
  onOwnToken,
  folded = false,
  onWaiting,
  showcase = false,
}: {
  office: string;
  onOwnToken: () => void;
  /** Only the name is shown; the forms are put away (and out of the keyboard's way) until the door is opened again. */
  folded?: boolean;
  /** Told when a knock starts waiting for an answer, and when it stops. */
  onWaiting?: (waiting: boolean) => void;
  /** The public demo office: one way in — walk in and watch — no knock, no sign-in. */
  showcase?: boolean;
}) {
  if (showcase) return <DemoDoor office={office} folded={folded} />;
  return <OfficeDoor office={office} onOwnToken={onOwnToken} folded={folded} onWaiting={onWaiting} />;
}

/** The demo office's door: say who you are if you like, and walk in. */
function DemoDoor({ office, folded }: { office: string; folded: boolean }) {
  const walk = useWalkIn();
  const ids = useId();
  return (
    <div className="ent-door knock-card" data-mode="demo">
      <div className="ent-door-head">
        <span className={`ent-door-lamp ${walk.busy ? 'is-waiting' : ''}`} aria-hidden />
        <div className="ent-door-titles">
          <div className="knock-kicker">ORCHESTRATOR · LIVE DEMO</div>
          <h2 className="knock-office">{office}</h2>
        </div>
      </div>
      <div className="ent-door-fold" inert={folded}>
        <div className="ent-door-body">
          <p className="ent-door-say">The door is open: walk straight in and try it — talk to the team, hand out tasks, answer their questions. No account, nobody to let you in. The employees are scripted stand-ins — no Claude runs here, nothing is spent.</p>
          <form
            className="ent-form"
            onSubmit={(ev) => {
              ev.preventDefault();
              void walk.walkIn();
            }}
          >
            <label htmlFor={`${ids}n`}>Your name (if you like)</label>
            <input id={`${ids}n`} name="visitor" value={walk.name} maxLength={40} autoComplete="off" placeholder="Guest" onChange={(e) => walk.setName(e.target.value)} />
            {walk.error && (
              <div className="ent-error" role="alert">
                {walk.error}
              </div>
            )}
            <button className="ent-go" type="submit" disabled={walk.busy} data-walk-in>
              {walk.busy ? 'Walking in…' : 'Walk in'}
            </button>
          </form>
          <p className="ent-door-foot">You come in as the boss, for a day. What would spoil the demo for everybody else (settings, access, deleting things) is switched off. Use a computer — phones are turned away.</p>
        </div>
      </div>
    </div>
  );
}

/** A working office's door: sign in as a member, or knock as a visitor. */
function OfficeDoor({ office, onOwnToken, folded, onWaiting }: { office: string; onOwnToken: () => void; folded: boolean; onWaiting?: (waiting: boolean) => void }) {
  // Somebody who has signed in here before is shown the sign-in first.
  const [member, setMember] = useState(signedInBefore);
  const signIn = useSignIn();
  const knock = useKnock();
  const ids = useId();
  const first = useRef(true);
  const nameField = useRef<HTMLInputElement>(null);
  const passField = useRef<HTMLInputElement>(null);
  const knockField = useRef<HTMLInputElement>(null);
  // Changing from one way in to the other puts the cursor where the typing starts. (Not on arrival: the page is for
  // reading first, and a focused field would take the keys that scroll it — except for a member coming back, who is
  // here for the password.)
  useEffect(() => {
    if (first.current) {
      first.current = false;
      if (member) passField.current?.focus({ preventScroll: true });
      return;
    }
    (member ? (signIn.username ? passField : nameField) : knockField).current?.focus({ preventScroll: true });
  }, [member]); // eslint-disable-line react-hooks/exhaustive-deps

  const waiting = knock.stage.at === 'waiting' ? knock.stage : null;
  const isWaiting = !!waiting;
  useEffect(() => onWaiting?.(isWaiting), [isWaiting]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="ent-door knock-card" data-mode={member ? 'member' : 'visitor'}>
      <div className="ent-door-head">
        <span className={`ent-door-lamp ${waiting ? 'is-waiting' : ''}`} aria-hidden />
        <div className="ent-door-titles">
          <div className="knock-kicker">ORCHESTRATOR · THE DOOR OF</div>
          <h2 className="knock-office">{office}</h2>
        </div>
      </div>

      <div className="ent-door-fold" inert={folded}>
        <div className="ent-door-body">
          {!waiting && (
            <div className="ent-seg" role="group" aria-label="How you are coming in">
              <button type="button" aria-pressed={!member} onClick={() => setMember(false)}>
                Visitor
              </button>
              <button type="button" aria-pressed={member} onClick={() => setMember(true)}>
                Member
              </button>
            </div>
          )}

          {member ? (
            <>
              <p className="ent-door-say">Sign in with the name and the password you were given for this office.</p>
              <form
                className="ent-form"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void signIn.signIn();
                }}
              >
                <label htmlFor={`${ids}u`}>Name</label>
                <input ref={nameField} id={`${ids}u`} name="username" value={signIn.username} maxLength={40} autoComplete="username" autoCapitalize="none" spellCheck={false} onChange={(e) => signIn.setUsername(e.target.value)} />
                <label htmlFor={`${ids}p`}>Password</label>
                <input ref={passField} id={`${ids}p`} name="password" type="password" value={signIn.password} maxLength={200} autoComplete="current-password" onChange={(e) => signIn.setPassword(e.target.value)} />
                {signIn.error && (
                  <div className="ent-error" role="alert">
                    {signIn.error}
                  </div>
                )}
                <button className="ent-go" type="submit" disabled={!signIn.ready}>
                  {signIn.busy ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
              <p className="ent-door-foot">
                No password?{' '}
                <button type="button" className="ent-link" onClick={() => setMember(false)}>
                  Ask to come in instead
                </button>
              </p>
            </>
          ) : waiting ? (
            <div aria-live="polite" className="ent-waiting">
              <p className="ent-door-say">
                You knocked as <b>{knock.name.trim()}</b>. {waiting.anyoneIn ? 'The people inside can see you at the door; one of them has to let you in.' : 'Nobody who can open the door is inside right now. Your knock stays up while this page is open, for whoever walks in.'}
              </p>
              <div className="knock-code" aria-label="Your code">
                {waiting.code}
              </div>
              <p className="ent-door-foot">They see this code next to your name — tell it to them if they ask whether it is really you.</p>
              <div className="ent-waiting-row">
                <span className="knock-dots" aria-hidden>
                  waiting<i>.</i>
                  <i>.</i>
                  <i>.</i>
                </span>
                <button type="button" className="ent-quiet" onClick={knock.cancel}>
                  Never mind
                </button>
              </div>
            </div>
          ) : (
            <>
              <p className="ent-door-say" aria-live="polite">
                {knock.stage.at === 'refused'
                  ? 'They did not let you in this time.'
                  : knock.stage.at === 'gone'
                    ? 'Nobody answered the door. You can knock again.'
                    : 'This is a working office. Ask to come in: someone inside will let you in to look around — you can watch what is going on, not change anything.'}
              </p>
              <form
                className="ent-form"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  void knock.knock();
                }}
              >
                <label htmlFor={`${ids}k`}>Your name</label>
                <input ref={knockField} id={`${ids}k`} name="visitor" value={knock.name} maxLength={40} autoComplete="off" onChange={(e) => knock.setName(e.target.value)} />
                {knock.error && (
                  <div className="ent-error" role="alert">
                    {knock.error}
                  </div>
                )}
                <button className="ent-go" type="submit" disabled={!knock.ready}>
                  {knock.stage.at === 'ask' ? 'Ask to come in' : 'Knock again'}
                </button>
              </form>
              <p className="ent-door-foot">
                Working here every day? The Orchestrator desktop app lets you in with your own computer.{' '}
                <button type="button" className="ent-link" onClick={onOwnToken}>
                  I have an owner token
                </button>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
