import { may } from '../lib/access.ts';
import { usePrefs } from '../lib/prefs.ts';
import { retune, setRadioMuted, stopHiFi } from '../lib/radio.ts';
import { useOffice } from '../lib/store.ts';

/**
 * The buttons of the hi-fi pill in the top bar. Everyone can switch their own copy off and on; only those who
 * may switch the office's hi-fi (owners and colleagues) get the button that stops it for everyone. Each says
 * which of the two it does.
 */
export function RadioPillButtons() {
  const muted = usePrefs((p) => p.prefs.radioMuted);
  const me = useOffice((s) => s.me);
  return (
    <>
      <button
        className={`pill ${muted ? 'pill-on' : ''}`}
        onClick={() => setRadioMuted(!muted)}
        aria-pressed={muted}
        aria-label={muted ? 'Unmute the hi-fi on this computer' : 'Mute the hi-fi on this computer'}
        title={muted ? 'Muted on this computer only — click to hear the hi-fi again' : 'Mute it on this computer only; it plays on for everyone else'}
      >
        {muted ? 'Muted' : 'Mute'}
      </button>
      {may(me, 'work', null) && (
        <button className="pill" onClick={() => void stopHiFi().catch((e) => useOffice.getState().toast((e as Error).message, 'error'))} title="Stop the hi-fi for everyone in the office" aria-label="Stop the hi-fi for everyone">
          ■
        </button>
      )}
    </>
  );
}

/**
 * A browser does not let sound start before the person has clicked in the page. When the office's hi-fi is on
 * and this window was not allowed to start it, say so once, calmly; the click on it is the click the browser wants.
 */
export function RadioNotice() {
  const blocked = useOffice((s) => s.radio.status === 'blocked');
  const name = useOffice((s) => s.radio.name);
  if (!blocked) return null;
  return (
    <div className="glass radio-notice" role="status">
      <button className="radio-notice-listen" onClick={retune}>
        The hi-fi is playing: ♪ {name ?? 'a station'} — click to listen
      </button>
      <button className="pill" onClick={() => setRadioMuted(true)} title="Not now: keep it off on this computer (the Hi-fi window switches it back on)" aria-label="Not now: mute the hi-fi on this computer">
        ✕
      </button>
    </div>
  );
}
