import { useEffect, useRef, useState } from 'react';
import { EMOTES, type EmoteName } from '@orchestrator/contracts';
import { ownerPosition } from '@orchestrator/office-3d';
import { usePrefs } from '../lib/prefs.ts';
import { keyTaken } from '../lib/keys-taken.ts';
import { useOffice } from '../lib/store.ts';
import { isTalking, startTalking, stopTalking } from '../lib/voice.ts';
import { WHEEL_REACH as REACH, sliceAt } from '../lib/people-acts.ts';

export { personInReach } from '../lib/people-acts.ts';

/**
 * What a person does with their own character among the other people in the office, by holding a key:
 *
 *   - the talk key (V): their microphone is heard by those near their character for as long as it is held — or,
 *     with the microphone always on (Settings → Sound), the key switches it off and on;
 *   - the gesture key (B): a wheel opens in the middle of the screen; the mouse (or a digit) picks a gesture, and
 *     letting go of the key makes the character do it. Letting go in the middle does nothing.
 *
 * Neither reaches an employee: this is between people.
 */

export const EMOTE_LABEL: Record<EmoteName, string> = { wave: 'Wave', dance: 'Dance', clap: 'Clap', thumbsUp: 'Thumbs up', shrug: 'Shrug', point: 'Point', cheer: 'Cheer', bow: 'Bow' };

function typing(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable || !!el.closest?.('.xterm'));
}

export function PeopleActs() {
  const keys = usePrefs((p) => p.prefs.keybindings);
  const talking = useOffice((s) => s.talking);
  const level = useOffice((s) => s.micLevel);
  const micOpen = useOffice((s) => s.micOpen);
  const micOff = useOffice((s) => s.micOff);
  const [wheel, setWheel] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const aim = useRef({ x: 0, y: 0 });
  const pickedRef = useRef<number | null>(null);
  pickedRef.current = picked;
  const wheelRef = useRef(false);
  wheelRef.current = wheel;

  useEffect(() => {
    const talkKey = keys.voice ?? 'KeyV';
    const wheelKey = keys.emotes ?? 'KeyB';
    const close = (play: boolean) => {
      if (!wheelRef.current) return;
      const i = pickedRef.current;
      setWheel(false);
      setPicked(null);
      if (play && i !== null) useOffice.getState().doEmote(EMOTES[i]!);
    };
    const down = (e: KeyboardEvent) => {
      if (wheelRef.current) {
        // With the wheel open: a digit picks straight away, Escape puts it away.
        const n = /^Digit([1-8])$/.exec(e.code);
        if (n) {
          e.preventDefault();
          setPicked(Number(n[1]) - 1);
        } else if (e.code === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          pickedRef.current = null;
          close(false);
        }
        return;
      }
      if (e.repeat || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      // A key a game on the arcade holds is the game's, whatever it is bound to here.
      if (keyTaken(e.code)) return;
      const st = useOffice.getState();
      if (st.commandOpen || !st.ready) return;
      if (e.code === talkKey) {
        e.preventDefault();
        startTalking();
      } else if (e.code === wheelKey && !st.panel && st.cameraMode !== 'workstation') {
        e.preventDefault();
        aim.current = { x: 0, y: 0 };
        setPicked(null);
        setWheel(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === talkKey && isTalking()) stopTalking();
      if (e.code === wheelKey) close(true);
    };
    // The mouse picks by direction from the middle. With the pointer held by the 3D view (first person) there is no
    // position, only movement: that is added up instead, and kept inside the wheel.
    const move = (e: MouseEvent) => {
      if (!wheelRef.current) return;
      if (document.pointerLockElement) {
        const x = aim.current.x + e.movementX;
        const y = aim.current.y + e.movementY;
        const far = Math.hypot(x, y);
        aim.current = far > REACH ? { x: (x / far) * REACH, y: (y / far) * REACH } : { x, y };
      } else aim.current = { x: e.clientX - window.innerWidth / 2, y: e.clientY - window.innerHeight / 2 };
      const i = sliceAt(aim.current.x, aim.current.y, EMOTES.length);
      if (i !== pickedRef.current) setPicked(i);
    };
    // A window that loses the keyboard does not get the key's release: stop as if it had.
    const away = () => {
      if (isTalking()) stopTalking();
      pickedRef.current = null;
      close(false);
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('mousemove', move);
    window.addEventListener('blur', away);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('blur', away);
      away();
    };
  }, [keys.voice, keys.emotes]);

  const talkLabel = (keys.voice ?? 'KeyV').replace(/^Key|^Digit/, '');
  return (
    <>
      {micOpen ? (
        // Always shown while the microphone is always on: nobody should be on the air without seeing it.
        <div className={`talking-pill glass ${micOff ? 'talking-pill-off' : talking ? '' : 'talking-pill-quiet'}`} role="status" data-mic={micOff ? 'off' : talking ? 'sending' : 'open'}>
          <span className="talking-light" style={{ transform: `scale(${1 + (talking ? level : 0) * 0.9})` }} />
          {micOff ? (
            <>
              Microphone off. <span className="kbd">{talkLabel}</span> switches it on
            </>
          ) : (
            <>
              {talking ? 'Talking — people near you hear it.' : 'Microphone on — people near you hear you when you speak.'} <span className="kbd">{talkLabel}</span> switches it off
            </>
          )}
        </div>
      ) : (
        talking && (
          <div className="talking-pill glass" role="status" data-mic="sending">
            <span className="talking-light" style={{ transform: `scale(${1 + level * 0.9})` }} />
            Talking — people near you hear it. Release <span className="kbd">{talkLabel}</span> to stop
          </div>
        )
      )}
      {wheel && <Wheel picked={picked} />}
    </>
  );
}

function Wheel({ picked }: { picked: number | null }) {
  const n = EMOTES.length;
  const r0 = 46;
  const r1 = REACH;
  const slice = (i: number) => {
    const a0 = ((i - 0.5) / n) * Math.PI * 2;
    const a1 = ((i + 0.5) / n) * Math.PI * 2;
    const p = (r: number, a: number) => `${(r * Math.sin(a)).toFixed(2)} ${(-r * Math.cos(a)).toFixed(2)}`;
    return `M ${p(r0, a0)} L ${p(r1, a0)} A ${r1} ${r1} 0 0 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 0 0 ${p(r0, a0)} Z`;
  };
  return (
    <div className="emote-wheel" role="menu" aria-label="Gestures">
      <svg viewBox={`${-r1 - 6} ${-r1 - 6} ${2 * r1 + 12} ${2 * r1 + 12}`} width={2 * r1 + 12} height={2 * r1 + 12}>
        {EMOTES.map((name, i) => {
          const a = (i / n) * Math.PI * 2;
          const rm = (r0 + r1) / 2;
          return (
            <g key={name} className={`emote-slice${picked === i ? ' on' : ''}`} role="menuitem" aria-label={EMOTE_LABEL[name]}>
              <path d={slice(i)} />
              <text x={rm * Math.sin(a)} y={-rm * Math.cos(a) - 3} textAnchor="middle" dominantBaseline="middle">
                {EMOTE_LABEL[name]}
              </text>
              <text className="emote-digit" x={rm * Math.sin(a)} y={-rm * Math.cos(a) + 13} textAnchor="middle" dominantBaseline="middle">
                {i + 1}
              </text>
            </g>
          );
        })}
        <circle r={r0 - 5} className="emote-hub" />
        <text className="emote-hint" textAnchor="middle" dominantBaseline="middle" y={-5}>
          {picked === null ? 'Move to' : EMOTE_LABEL[EMOTES[picked]!]}
        </text>
        <text className="emote-hint emote-hint-2" textAnchor="middle" dominantBaseline="middle" y={10}>
          {picked === null ? 'choose' : 'release'}
        </text>
      </svg>
    </div>
  );
}

/** Where this window's own character stands, for whoever asks who is within the whip's reach. */
export const myPlace = (): { x: number; z: number; rot: number } => ({ x: ownerPosition.x, z: ownerPosition.z, rot: ownerPosition.rot });
