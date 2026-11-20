import { useTick } from './company-shared.tsx';
import { useEffect, useState, type ReactNode } from 'react';
import { ACTIVITY_LABEL, SURROUNDINGS, reviewDefaultOf, surroundingsOf, type AuditEntry, type ForemanSettings, type ForemanStatus, type OwnerSettings, type ReviewBy, type SelfImprovementSettings, type Surroundings } from '@orchestrator/contracts';
import { Badge, Button, Field, Window } from '@orchestrator/ui';
import { api, forgetToken } from '../../lib/api.ts';
import { DEFAULT_KEYS, setPrefs, usePrefs, type ClientPrefs, type PrefsPatch } from '../../lib/prefs.ts';
import { canChooseOutput, soundChoices } from '../../lib/sound-devices.ts';
import { micLevel } from '../../lib/voice.ts';
import { GATE_MAX, GATE_MIN } from '../../lib/voice-gate.ts';
import { useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { LoadState, fmtDateTime, keyLabel, useLoad, type PanelProps } from './company-shared.tsx';
import { AutopilotDial } from './growth.tsx';
import { REVIEW_CHOICES } from './task-shared.tsx';

type SectionId = 'company' | 'surroundings' | 'graphics' | 'controls' | 'sound' | 'account' | 'improve' | 'workers' | 'foreman' | 'audit';

/** 'mine': kept on this computer, for whoever sits at it. 'office': the office's own settings, which its owners change. */
const SECTIONS: Array<{ id: SectionId; label: string; group: 'mine' | 'office'; ownerOnly?: boolean; memberOnly?: boolean }> = [
  { id: 'graphics', label: 'Graphics', group: 'mine' },
  { id: 'controls', label: 'Controls', group: 'mine' },
  { id: 'sound', label: 'Sound', group: 'mine' },
  // A member's own way in: their password, and signing out of a browser. The office's own computer has neither.
  { id: 'account', label: 'Sign-in', group: 'mine', memberOnly: true },
  { id: 'company', label: 'Company', group: 'office' },
  // Where the office stands: what is seen around the building and through its windows.
  { id: 'surroundings', label: 'Surroundings', group: 'office' },
  { id: 'improve', label: 'Growth', group: 'office' },
  { id: 'workers', label: 'Employees', group: 'office' },
  { id: 'foreman', label: 'Foreman', group: 'office' },
  // The audit log is read from the office on request, and only owners may read it.
  { id: 'audit', label: 'Audit log', group: 'office', ownerOnly: true },
];
const GROUPS: Array<{ id: 'mine' | 'office'; label: string }> = [
  { id: 'mine', label: 'This computer' },
  { id: 'office', label: 'The office' },
];

type SettingsPatch = Partial<Omit<OwnerSettings, 'selfImprovement' | 'foreman'>> & { selfImprovement?: Partial<SelfImprovementSettings>; foreman?: Partial<ForemanSettings> };

/** The office's settings are saved one change at a time; the server merges the partial and broadcasts the result. */
function save(patch: SettingsPatch, ok = 'Saved'): Promise<OwnerSettings | undefined> {
  return act(() => api<OwnerSettings>('PATCH', '/settings', patch), ok);
}

/** This computer's preferences: stored here, nothing is asked of the office. */
function savePrefs(patch: PrefsPatch, ok: string): void {
  setPrefs(patch);
  useOffice.getState().toast(ok, 'success');
}

function Toggle({ checked, onChange, title, children, disabled }: { checked: boolean; onChange: (v: boolean) => void; title: ReactNode; children?: ReactNode; disabled?: boolean }) {
  return (
    <label className={`check ${disabled ? 'pc-dim' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(ev) => onChange(ev.target.checked)} />
      <span>
        <span className="strong">{title}</span>
        {children && (
          <>
            <br />
            <span className="small muted">{children}</span>
          </>
        )}
      </span>
    </label>
  );
}

function Choice<T extends string>({ name, value, current, onPick, title, children, disabled }: { name: string; value: T; current: T; onPick: (v: T) => void; title: ReactNode; children: ReactNode; disabled?: boolean }) {
  return (
    <label className={`pc-choice ${current === value ? 'pc-choice-on' : ''} ${disabled ? 'pc-dim' : ''}`}>
      <input type="radio" name={name} checked={current === value} disabled={disabled} onChange={() => onPick(value)} />
      <span>
        <span className="strong">{title}</span>
        <br />
        <span className="small muted">{children}</span>
      </span>
    </label>
  );
}

function CompanySection({ settings }: { settings: OwnerSettings }) {
  const [companyName, setCompanyName] = useState(settings.companyName);
  const [ownerName, setOwnerName] = useState(settings.ownerName);
  const dirty = companyName.trim() !== settings.companyName || ownerName.trim() !== settings.ownerName;
  return (
    <form
      className="col"
      style={{ gap: 12, maxWidth: 640 }}
      onSubmit={(ev) => {
        ev.preventDefault();
        if (dirty) void save({ companyName: companyName.trim(), ownerName: ownerName.trim() });
      }}
    >
      <Field label="Company name" hint="Shown in the top bar and in the CEO office.">
        <input value={companyName} onChange={(ev) => setCompanyName(ev.target.value)} />
      </Field>
      <Field label="Your name">
        <input value={ownerName} onChange={(ev) => setOwnerName(ev.target.value)} />
      </Field>
      <div className="row">
        <Button variant="primary" type="submit" disabled={!dirty || !companyName.trim()}>
          Save
        </Button>
      </div>
      <Toggle checked={settings.gamification} onChange={(gamification) => void save({ gamification })} title="XP, levels and milestones">
        Employees earn XP and levels, and the company reaches milestones that unlock things for the office — only for work that was checked. A level is a record of delivered work; it changes nothing about how work is handed out.
      </Toggle>
      <Toggle checked={settings.nlFallback} onChange={(nlFallback) => void save({ nlFallback })} title="Let Claude interpret commands the rules cannot">
        The command bar understands common instructions by itself. For the rest it can ask Claude on one of your machines, which uses tokens. Either way you see a plan first; nothing changes until you confirm.
      </Toggle>
    </form>
  );
}

/** The places an office can stand in: what each is called, what is there, and a small picture of its sky. */
const PLACES: Record<Surroundings, { name: string; about: string; picture: string }> = {
  studio: { name: 'By itself', about: 'The building alone in the dark, as it has always been.', picture: 'radial-gradient(ellipse at 50% 120%, #1a2230 0%, #0d1118 60%)' },
  skyline: {
    name: 'Skyline',
    about: 'The top floor of a tower at dusk: a city far below with traffic in its streets, lit windows all round, a helicopter on its round.',
    picture: 'repeating-linear-gradient(90deg, #1a1c3a 0 9px, transparent 9px 13px, #23254a 13px 25px, transparent 25px 31px) bottom / 100% 42% no-repeat, linear-gradient(#0a1030, #3a2d6e 45%, #a8627e 72%, #ff8a5c)',
  },
  park: {
    name: 'Park',
    about: 'A pavilion on mown lawns on a clear day: a fountain, a pond, trees moving in the wind, balloons over the hills.',
    picture: 'radial-gradient(circle at 78% 22%, #ffffff 0 7%, transparent 8%), radial-gradient(ellipse at 30% 105%, #4f9a45 0 45%, transparent 46%), radial-gradient(ellipse at 80% 110%, #63ad52 0 50%, transparent 51%), linear-gradient(#2a66c8, #cfe5f6)',
  },
  island: {
    name: 'Island',
    about: 'A small island at sunset: palms, a pier out towards the sun with a boat at its end, sails and a lighthouse far out.',
    picture: 'radial-gradient(circle at 30% 58%, #fff3c4 0 8%, transparent 9%), linear-gradient(transparent 0 62%, #2f7f9a 62% 82%, #e3c690 82%), linear-gradient(#22387a, #b85f8e 40%, #ffb070 62%)',
  },
  north: {
    name: 'Northern lights',
    about: 'A valley deep in snow at night: mountains all round, pines, cabins with their windows lit, a lake that shows the lights, snow falling.',
    picture: 'linear-gradient(160deg, transparent 0 30%, rgba(60, 230, 150, 0.55) 42%, rgba(130, 80, 220, 0.35) 55%, transparent 68%), linear-gradient(transparent 0 70%, #5a6788 70%), linear-gradient(#040816, #0a1832 60%, #1d3c5c)',
  },
  orbit: {
    name: 'Orbit',
    about: 'A station above the Earth: solar wings, a great wheel turning at its end, somebody on a spacewalk, the planet going by below.',
    picture: 'radial-gradient(circle at 70% 190%, #cfe8ff 0 60%, #3f8be0 61% 64%, rgba(63, 139, 224, 0.35) 65% 67%, transparent 68%), radial-gradient(circle at 20% 30%, #ffffff 0 1px, transparent 2px), radial-gradient(circle at 60% 18%, #ffffff 0 1px, transparent 2px), radial-gradient(circle at 85% 40%, #ffffff 0 1px, transparent 2px), #02030a',
  },
};

function SurroundingsSection({ settings }: { settings: OwnerSettings }) {
  const current = surroundingsOf(settings.surroundings);
  return (
    <div className="col" style={{ gap: 12, maxWidth: 720 }} data-settings-section="surroundings">
      <div className="small muted">
        Where the office stands. It is the office’s own — everybody in it sees the same place — and it changes at once. Anywhere but “{PLACES.studio.name}” the outer walls get windows wherever nothing hangs on them or stands against them.
      </div>
      <div className="pc-places" role="radiogroup" aria-label="Where the office stands">
        {SURROUNDINGS.map((id) => (
          <label key={id} className={`pc-choice pc-place ${current === id ? 'pc-choice-on' : ''}`} data-surroundings={id}>
            <span className="pc-place-picture" style={{ background: PLACES[id].picture }} aria-hidden="true" />
            <span className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
              <input type="radio" name="surroundings" checked={current === id} onChange={() => void save({ surroundings: id }, `Surroundings: ${PLACES[id].name}`)} />
              <span>
                <span className="strong">{PLACES[id].name}</span>
                <br />
                <span className="small muted">{PLACES[id].about}</span>
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="small faint">How much of a place is drawn follows each computer’s own graphics quality (Graphics, under “This computer”): on Low there are fewer trees, cars and flakes.</div>
    </div>
  );
}

function GraphicsSection() {
  const settings = usePrefs((p) => p.prefs);
  const pick = (quality: ClientPrefs['quality']) => savePrefs({ quality }, `Graphics quality: ${quality}`);
  useTick(2000);
  const perf = (window as unknown as { __orchPerf?: { fps: number; worstFrameMs: number; at: number } }).__orchPerf;
  const fresh = perf && Date.now() - perf.at < 6000 ? perf : null;
  return (
    <div className="col" style={{ gap: 8, maxWidth: 560 }} role="radiogroup" aria-label="Graphics quality">
      <Choice name="quality" value="low" current={settings.quality} onPick={pick} title="Low">
        No shadows, no anti-aliasing, rendered at 1× resolution. For integrated graphics or to save battery.
      </Choice>
      <Choice name="quality" value="medium" current={settings.quality} onPick={pick} title="Medium">
        Shadows on (2048 px shadow map), anti-aliasing, rendered at up to 1.5× display resolution.
      </Choice>
      <Choice name="quality" value="high" current={settings.quality} onPick={pick} title="High">
        Sharper shadows (4096 px shadow map), anti-aliasing, rendered at up to 2× display resolution.
      </Choice>
      <div className="small" aria-live="off">
        <span className="muted">Measured right now: </span>
        {fresh ? (
          <span className={fresh.fps >= 50 ? 'good' : fresh.fps >= 30 ? '' : 'bad'}>
            <span className="mono strong">{fresh.fps.toFixed(0)}</span> frames per second <span className="faint">(slowest frame {fresh.worstFrameMs.toFixed(0)} ms, over the last two seconds)</span>
          </span>
        ) : (
          <span className="faint">not available — the 3D office is not drawing (for example the window is hidden)</span>
        )}
        {fresh && fresh.fps < 30 && settings.quality !== 'low' && <span className="muted"> — a lower quality will help.</span>}
      </div>
      <div className="small faint">Only the 3D office is affected. Terminals and panels always render at full resolution.</div>
      <PowerChoice />
      <div className="section-title" style={{ marginTop: 10 }}>
        Office extras
      </div>
      <label className="check">
        <input type="checkbox" checked={settings.projectZones === true} onChange={(ev) => savePrefs({ projectZones: ev.target.checked }, ev.target.checked ? 'Project areas are marked on the floor' : 'Project areas are no longer marked')} />
        <span>
          <span className="strong">Mark project areas on the floor</span>
          <br />
          <span className="field-hint">A coloured outline, a sign and live task counts around desks whose people share a project.</span>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.approachZoom === true} onChange={(ev) => savePrefs({ approachZoom: ev.target.checked }, ev.target.checked ? 'The camera moves closer at a desk' : 'The camera keeps its distance at a desk')} />
        <span>
          <span className="strong">Move the camera closer at a desk</span>
          <br />
          <span className="field-hint">When you stand next to an employee, the camera eases in towards their monitor.</span>
        </span>
      </label>
    </div>
  );
}

/** How often the office may be drawn: saving on battery and while the computer runs warm, always, or never (`pace.ts`). */
function PowerChoice() {
  const power = usePrefs((p) => p.prefs.power);
  const pick = (value: ClientPrefs['power']) => savePrefs({ power: value }, value === 'auto' ? 'Power: saves on battery and when warm' : value === 'save' ? 'Power: always saving' : 'Power: always the full pace');
  useTick(2000);
  const saving = (window as unknown as { __orchPace?: { saving: string | null } }).__orchPace?.saving ?? null;
  const why = saving === 'battery' ? 'the computer runs on its battery' : saving === 'warm' ? 'the computer runs warm' : saving === 'chosen' ? 'you chose it' : null;
  return (
    <div className="col" style={{ gap: 8 }} role="radiogroup" aria-label="Power" data-settings-power={power}>
      <div className="section-title" style={{ marginTop: 10 }}>
        Power
      </div>
      <Choice name="power" value="auto" current={power} onPick={pick} title="Save on battery and when warm">
        The office is drawn half as often (30 frames a second while you work in it, 15 while you do not) when the computer runs on its battery or gets warm — a laptop without a fan stays cool. Otherwise up to about 72 and 30.
      </Choice>
      <Choice name="power" value="save" current={power} onPick={pick} title="Always save">
        Always half as often, plugged in too. For a laptop that still gets hot, or a computer busy with other work.
      </Choice>
      <Choice name="power" value="full" current={power} onPick={pick} title="Always the full pace">
        Never slowed down for the battery or the heat.
      </Choice>
      <div className="small" aria-live="off" data-power-saving={saving ?? 'none'}>
        <span className="muted">Right now: </span>
        {why ? <span>saving, because {why}.</span> : <span className="faint">the full pace.</span>}
      </div>
    </div>
  );
}

const KEY_ACTIONS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'forward', label: 'Move forward', hint: 'Walk / fly forward' },
  { id: 'back', label: 'Move back', hint: 'Walk / fly backward' },
  { id: 'left', label: 'Turn left', hint: 'Turn your character (pans in the overview cameras)' },
  { id: 'right', label: 'Turn right', hint: 'Turn your character (pans in the overview cameras)' },
  { id: 'strafeLeft', label: 'Sidestep left', hint: 'Move sideways without turning' },
  { id: 'strafeRight', label: 'Sidestep right', hint: 'Move sideways without turning' },
  { id: 'interact', label: 'Interact', hint: 'Open the workstation or room you are standing next to' },
  { id: 'talk', label: 'Talk', hint: 'Talk to the employee you are standing next to' },
  { id: 'whip', label: 'Crack the whip', hint: 'A sound and an animation for the employee — or the person — next to you. An owner can make it approve what an employee is waiting for permission to do (Settings → Employees)' },
  { id: 'voice', label: 'Talk to the people near you (hold)', hint: 'Push to talk: while it is held, your microphone is heard by the people near your character — louder the nearer they stand; a meeting room keeps it in. With the microphone always on (Sound), this key switches it off and on' },
  { id: 'emotes', label: 'Gestures (hold)', hint: 'A wheel opens: move the mouse to wave, dance, clap… and let go' },
  { id: 'camera', label: 'Next camera mode', hint: 'CEO → first person → management → free → command center' },
  { id: 'overview', label: 'Company overview', hint: 'Toggle the overview panel' },
  { id: 'map', label: 'Office map', hint: 'Toggle the map' },
  { id: 'tasks', label: 'Tasks', hint: 'Toggle the task board' },
  { id: 'projects', label: 'Projects', hint: 'Toggle the projects panel' },
  { id: 'notifications', label: 'Inbox', hint: 'Toggle the inbox' },
  { id: 'command', label: 'Command bar', hint: 'Tell Orchestrator what to do' },
  { id: 'exit', label: 'Close / leave', hint: 'Close a panel, stand up from a workstation, deselect' },
];

const MODIFIER_CODES = new Set(['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock']);

/** How this person hears the others talk: theirs to set, on this computer. */
function VoicePrefs() {
  const volume = usePrefs((p) => p.prefs.voiceVolume);
  const muted = usePrefs((p) => p.prefs.voiceMuted);
  return (
    <div className="card col" style={{ gap: 8 }}>
      <div className="section-title" style={{ margin: 0 }}>
        Voices
      </div>
      <div className="small muted">You hear whoever is near your character, louder the nearer they stand; what is said in the meeting room is heard only in it. Nothing is recorded.</div>
      <div className="row" style={{ gap: 12 }}>
        <label className="small grow" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Their volume here
          <input type="range" min={0} max={1} step={0.05} value={volume} disabled={muted} onChange={(ev) => setPrefs({ voiceVolume: Number(ev.target.value) })} aria-label="Volume of other people's voices" style={{ flex: 1 }} />
          <span className="mono">{Math.round(volume * 100)}%</span>
        </label>
        <label className="check small" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={muted} onChange={(ev) => savePrefs({ voiceMuted: ev.target.checked }, ev.target.checked ? 'You no longer hear the others talk' : 'You hear the others again')} style={{ marginTop: 0 }} />
          Do not play them
        </label>
      </div>
    </div>
  );
}

/** How loud the office hi-fi is on this computer (what is on belongs to the office: the Hi-fi window). */
function HiFiPrefs() {
  const volume = usePrefs((p) => p.prefs.radioVolume);
  const muted = usePrefs((p) => p.prefs.radioMuted);
  return (
    <div className="card col" style={{ gap: 8 }}>
      <div className="section-title" style={{ margin: 0 }}>
        Hi-fi
      </div>
      <div className="small muted">The office's music, louder the nearer your character stands to the hi-fi. What is on is chosen at the hi-fi itself, for everyone.</div>
      <div className="row" style={{ gap: 12 }}>
        <label className="small grow" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Its volume here
          <input type="range" min={0} max={1} step={0.05} value={volume} disabled={muted} onChange={(ev) => setPrefs({ radioVolume: Number(ev.target.value) })} aria-label="Volume of the hi-fi" style={{ flex: 1 }} />
          <span className="mono">{Math.round(volume * 100)}%</span>
        </label>
        <label className="check small" style={{ alignItems: 'center' }}>
          <input type="checkbox" checked={muted} onChange={(ev) => savePrefs({ radioMuted: ev.target.checked }, ev.target.checked ? 'The hi-fi is off on this computer' : 'The hi-fi plays here again')} style={{ marginTop: 0 }} />
          Do not play it
        </label>
      </div>
    </div>
  );
}

/** The open microphone as it is heard right now, against the mark above which it is sent. */
function MicMeter({ gate }: { gate: number }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setLevel(micLevel()), 80);
    return () => window.clearInterval(timer);
  }, []);
  const at = (v: number) => `${Math.min(100, Math.max(0, (v / GATE_MAX) * 100)).toFixed(1)}%`;
  return (
    <div className="mic-meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(1, level / GATE_MAX) * 100)}>
      <div className={`mic-meter-fill ${level >= gate ? 'on' : ''}`} style={{ width: at(level) }} />
      <div className="mic-meter-mark" style={{ left: at(gate) }} />
    </div>
  );
}

/** This computer's sound: where it comes out, which microphone is used, how one talks, and how loud everything is. */
function SoundSection() {
  const prefs = usePrefs((p) => p.prefs);
  const micOff = useOffice((s) => s.micOff);
  const talkKey = keyLabel(prefs.keybindings.voice ?? 'KeyV');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;

  useEffect(() => {
    if (!media?.enumerateDevices) return;
    let gone = false;
    const list = () => void media.enumerateDevices().then((found) => !gone && setDevices(found), () => undefined);
    list();
    // Headphones plugged in or pulled out while the window is open.
    media.addEventListener?.('devicechange', list);
    return () => {
      gone = true;
      media.removeEventListener?.('devicechange', list);
    };
  }, [media]);

  const mics = soundChoices(devices, 'audioinput', prefs.micDevice);
  const outs = soundChoices(devices, 'audiooutput', prefs.outputDevice);
  const unnamed = devices.length > 0 && !mics.named && !outs.named;
  const outputs = canChooseOutput();

  /** The browser names the devices only once the microphone was allowed: ask, and let go of it at once. */
  const allow = async () => {
    try {
      const stream = await media!.getUserMedia({ audio: true, video: false });
      for (const track of stream.getTracks()) track.stop();
      setDevices(await media!.enumerateDevices());
    } catch {
      useOffice.getState().toast('The microphone was not allowed. Allow it for this page (the icon in the address bar, or your system’s privacy settings).', 'error');
    }
  };

  return (
    <div className="col" style={{ gap: 12, maxWidth: 680 }}>
      <div className="card col" style={{ gap: 10 }}>
        <div className="section-title" style={{ margin: 0 }}>
          Devices
        </div>
        <Field label="Sound comes out of" hint={outputs ? 'Everything the office plays here: voices, the hi-fi, the small effects.' : 'This browser plays on the system’s own device only. Choose your headphones in the system’s sound settings, or use the Orchestrator app or a Chromium browser.'}>
          <select value={prefs.outputDevice} disabled={!outputs} onChange={(ev) => savePrefs({ outputDevice: ev.target.value }, 'The office’s sound comes out there now')} aria-label="Output device">
            <option value="">System default</option>
            {outs.choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Microphone" hint="What the people near you hear when you talk.">
          <select value={prefs.micDevice} onChange={(ev) => savePrefs({ micDevice: ev.target.value }, 'That microphone is used from now on')} aria-label="Microphone">
            <option value="">System default</option>
            {mics.choices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        {!media?.enumerateDevices && <div className="pc-note">This page cannot see sound devices: it has to be opened over https, or in the Orchestrator app.</div>}
        {unnamed && (
          <div className="row" style={{ gap: 10 }}>
            <Button onClick={() => void allow()}>Show the devices’ names</Button>
            <span className="small faint">The browser gives their names only once the microphone was allowed for this page. Nothing is sent.</span>
          </div>
        )}
      </div>

      <div className="card col" style={{ gap: 10 }}>
        <div className="section-title" style={{ margin: 0 }}>
          Talking
        </div>
        <div className="col" style={{ gap: 8 }} role="radiogroup" aria-label="How you talk">
          <Choice name="voice-mode" value="hold" current={prefs.voiceMode} onPick={(voiceMode) => savePrefs({ voiceMode }, 'You talk while you hold the key')} title={`Hold ${talkKey} to talk`}>
            Your microphone is on only while the key is held. Nobody hears you otherwise.
          </Choice>
          <Choice name="voice-mode" value="open" current={prefs.voiceMode} onPick={(voiceMode) => savePrefs({ voiceMode }, `Your microphone is on. ${talkKey} switches it off`)} title="Microphone always on">
            You just talk: the people near your character hear you whenever you speak, with no key. {talkKey} switches the microphone off and on, and a light at the bottom of the window shows which it is. Silence and quiet noise are not sent.
          </Choice>
        </div>
        {prefs.voiceMode === 'open' && (
          <div className="col" style={{ gap: 6 }}>
            <label className="small" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              Sent when louder than
              <input type="range" min={GATE_MIN} max={GATE_MAX} step={0.002} value={prefs.micGate} onChange={(ev) => setPrefs({ micGate: Number(ev.target.value) })} aria-label="How loud a sound has to be to be sent" style={{ flex: 1 }} />
            </label>
            <MicMeter gate={prefs.micGate} />
            <div className="small faint">
              {micOff
                ? `The microphone is switched off (${talkKey} switches it on), so the bar stands still.`
                : 'Say something: the bar should pass the white mark and turn green. If it is green while you are silent, move the mark to the right, above the noise of your room.'}
            </div>
          </div>
        )}
        <div className="small faint">The key is yours to change in Controls. You need a character in the office to be heard.</div>
      </div>

      <VoicePrefs />
      <HiFiPrefs />
    </div>
  );
}

function ControlsSection({ capturing, setCapturing }: { capturing: string | null; setCapturing: (id: string | null) => void }) {
  const keys = usePrefs((p) => p.prefs.keybindings);

  useEffect(() => {
    if (!capturing) return;
    // Capture phase on window, so the key reaches neither the office shortcuts nor the panel itself.
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (MODIFIER_CODES.has(e.code) || !e.code) return;
      setCapturing(null);
      if (keys[capturing] !== e.code) savePrefs({ keybindings: { [capturing]: e.code } }, `${KEY_ACTIONS.find((a) => a.id === capturing)?.label ?? capturing}: ${keyLabel(e.code)}`);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, keys, setCapturing]);

  const users = new Map<string, string[]>();
  for (const a of KEY_ACTIONS) {
    const code = keys[a.id];
    if (code) users.set(code, [...(users.get(code) ?? []), a.label]);
  }
  const duplicates = [...users.entries()].filter(([, who]) => who.length > 1);
  const isDefault = KEY_ACTIONS.every((a) => keys[a.id] === DEFAULT_KEYS[a.id]);

  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="small muted">Click a binding, then press the key you want. Bindings follow the physical key position, so they work the same on every keyboard layout.</div>
      <div className="pc-keys">
        {KEY_ACTIONS.map((a) => {
          const code = keys[a.id];
          const dup = !!code && (users.get(code)?.length ?? 0) > 1;
          const on = capturing === a.id;
          return (
            <div key={a.id} className="pc-keyrow">
              <div className="grow">
                <div className="truncate">{a.label}</div>
                <div className="small faint truncate">{a.hint}</div>
              </div>
              <button
                className={`pc-key ${on ? 'pc-key-on' : ''} ${dup ? 'pc-key-dup' : ''}`}
                aria-label={`${a.label}: ${on ? 'press a key' : keyLabel(code)}. Click to change.`}
                title={code ? `Key code: ${code}` : 'Not bound'}
                onClick={() => setCapturing(on ? null : a.id)}
                onBlur={() => on && setCapturing(null)}
              >
                {on ? 'press a key…' : keyLabel(code)}
              </button>
            </div>
          );
        })}
      </div>
      {capturing && <div className="pc-info">Waiting for a key for “{KEY_ACTIONS.find((a) => a.id === capturing)?.label}”. Click the binding again to cancel.</div>}
      {duplicates.length > 0 && (
        <div className="pc-note">
          {duplicates.map(([code, who]) => (
            <div key={code}>
              <b>{keyLabel(code)}</b> is bound to more than one action: {who.join(', ')}. They will get in each other's way.
            </div>
          ))}
        </div>
      )}
      <div className="row">
        <Button disabled={isDefault} onClick={() => savePrefs({ keybindings: DEFAULT_KEYS }, 'Keybindings reset to defaults')}>
          Reset to defaults
        </Button>
        <span className="small faint">In a terminal, Escape always belongs to the terminal — it is Claude Code's interrupt key. “?” opens the help.</span>
      </div>
    </div>
  );
}

/** The office's long memory: whether there is one, how much it holds, and the switch. */
function LongMemory({ settings }: { settings: OwnerSettings }) {
  const [st, setSt] = useState<{ available: boolean; version: string | null; filed: number; lastFiledAt: string | null; lastError: string | null } | null>(null);
  useEffect(() => {
    const load = () => api<typeof st>('GET', '/memory').then(setSt, () => undefined);
    void load();
    const t = window.setInterval(load, 10_000);
    return () => window.clearInterval(t);
  }, []);
  const installed = !!st?.version;
  return (
    <Toggle checked={settings.longMemory !== false} onChange={(longMemory) => void save({ longMemory })} title="Long memory (MemPalace)">
      {installed
        ? `The office writes down what is done, decided and learned — finished tasks, your answers, resolved blockers, lessons, meeting decisions, employees' notes — and employees can ask it in plain words (recall). MemPalace ${st!.version} on the office's machine · ${st!.filed} record${st!.filed === 1 ? '' : 's'} so far${st!.lastError ? ` · last problem: ${st!.lastError}` : ''}.`
        : 'Not installed on the office\'s machine, so there is no long memory: this switch does nothing yet. (MemPalace beside the office program — see docs/OPERATIONS.md.)'}
    </Toggle>
  );
}

function ImproveSection({ settings }: { settings: OwnerSettings }) {
  const si = settings.selfImprovement;
  const set = (patch: Partial<SelfImprovementSettings>) => void save({ selfImprovement: patch });
  const off = !si.enabled;
  return (
    <div className="col" style={{ gap: 14, maxWidth: 640 }}>
      <Toggle checked={si.enabled} onChange={(enabled) => set({ enabled })} title="Learn from real work">
        The office keeps what it learns from finished work, gives it to employees with their next tasks, and looks for better ways of working. Off: nothing is learned, used or suggested.
      </Toggle>
      <LongMemory settings={settings} />
      {!off && (
        <div>
          <div className="section-title">What the office does with what it learns</div>
          <AutopilotDial inSettings />
          <div className="small faint" style={{ marginTop: 6 }}>
            Whatever it does by itself is listed in Growth → Done by itself, with the reason and an Undo. The same choice is at the top of the Growth window.
          </div>
        </div>
      )}
      <div>
        <div className="section-title">Retrospectives</div>
        <div className="col" style={{ gap: 6 }} role="radiogroup" aria-label="Retrospectives">
          <Choice name="retro" value="off" current={si.retrospectives} onPick={(retrospectives) => set({ retrospectives })} title="Off" disabled={off}>
            Employees are never asked to reflect.
          </Choice>
          <Choice name="retro" value="friction" current={si.retrospectives} onPick={(retrospectives) => set({ retrospectives })} title="After friction" disabled={off}>
            Only after a task that hit a problem: a failed verification, a rejected review, a merge conflict, a blocker, a question, a denied command or a nudge.
          </Choice>
          <Choice name="retro" value="always" current={si.retrospectives} onPick={(retrospectives) => set({ retrospectives })} title="After every task" disabled={off}>
            After every verified task, whether or not anything went wrong.
          </Choice>
        </div>
        <div className="small faint" style={{ marginTop: 6 }}>
          A retrospective is a short prompt delivered into the employee's real session, so it uses a few tokens there. It needs a session with the Orchestrator MCP server.
        </div>
      </div>
      <Toggle checked={si.autoApproveSharedLessons} onChange={(autoApproveSharedLessons) => set({ autoApproveSharedLessons })} title="Auto-approve shared lessons" disabled={off}>
        Lessons an employee proposes for a whole project or the company are used at once. Off: they wait for you in Growth. What an employee learns for themselves is always used.
      </Toggle>
      <Toggle checked={si.learnedRouting} onChange={(learnedRouting) => set({ learnedRouting })} title="Learned routing" disabled={off}>
        Among equally suitable employees, the one with the better record on that kind of task is preferred, once they have finished at least two.
      </Toggle>
      <Toggle checked={si.outcomesAutoRetire !== false} onChange={(outcomesAutoRetire) => set({ outcomesAutoRetire })} title="Retire lessons that do not help" disabled={off}>
        When enough finished tasks show that a lesson makes no difference or makes things worse, the office stops using it and says so in Growth, where you can bring it back. Lessons you wrote yourself are never retired this way.
      </Toggle>
    </div>
  );
}

const ATTENTION_LABEL: Record<string, string> = { question: 'question', blocked: 'blocked', stalled: 'stalled', unassigned: 'unassigned', idle: 'idle' };
const ROUND_OUTCOME: Record<string, string> = { running: 'in progress', finished: 'finished', turn_ended: 'ended without a summary', timed_out: 'gave up waiting', failed: 'could not be delivered', interrupted: 'interrupted' };

function roundDid(a: ForemanStatus['rounds'][number]): string {
  const parts = [
    a.visited.length ? `looked at ${a.visited.length}` : '',
    a.actions.answered ? `answered ${a.actions.answered}` : '',
    a.actions.assigned ? `assigned ${a.actions.assigned}` : '',
    a.actions.created ? `created ${a.actions.created}` : '',
    a.actions.messaged ? `messaged ${a.actions.messaged}` : '',
    a.actions.escalated ? `escalated ${a.actions.escalated} to you` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

/**
 * Sleep: how long a session on the office's own machines may sit without work before it is stopped to free memory.
 * Saved when the field is left (or Enter is pressed); what the office keeps is shown back.
 */
function SleepSetting({ settings }: { settings: OwnerSettings }) {
  // An office running an older server does not have the setting yet: shown as off.
  const current = settings.sleepAfterMinutes ?? 0;
  const [minutes, setMinutes] = useState(String(current));
  useEffect(() => setMinutes(String(current)), [current]);
  const commit = () => {
    const n = Math.round(Number(minutes));
    if (minutes.trim() === '' || !Number.isFinite(n) || n === current) return setMinutes(String(current));
    void save({ sleepAfterMinutes: n }, n <= 0 ? 'Sessions are never put to sleep' : `Sessions sleep after ${Math.max(5, Math.min(1440, n))} minutes without work`);
  };
  return (
    <Field
      label="Put idle sessions to sleep after (minutes)"
      hint="An idle Claude Code session still holds memory. A session with no work for this long is stopped — on the office's machines and on members' own computers — and its employee is shown as sleeping; a second session of the same employee is stopped as soon as it rests. A message, a task, a routine or a meeting wakes it, in the same folder and the same conversation. 0 = never; otherwise at least 5."
    >
      <input type="number" min={0} max={1440} step={5} value={minutes} style={{ maxWidth: 120 }} aria-label="Put idle sessions to sleep after (minutes)" onChange={(ev) => setMinutes(ev.target.value)} onBlur={commit} onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()} />
    </Field>
  );
}

function ForemanSection({ settings, readOnly }: { settings: OwnerSettings; readOnly: boolean }) {
  // An office running an older server has no foreman settings yet: show them as off.
  const f: ForemanSettings = settings.foreman ? { ...settings.foreman, idleMinutes: settings.foreman.idleMinutes ?? 10 } : { enabled: false, minGapSeconds: 120, quietCheckMinutes: 15, answersQuestions: true, idleMinutes: 10 };
  const set = (patch: Partial<ForemanSettings>, ok?: string) => void save({ foreman: patch }, ok);
  const [gap, setGap] = useState(String(f.minGapSeconds));
  const [quiet, setQuiet] = useState(String(f.quietCheckMinutes));
  const [idle, setIdle] = useState(String(f.idleMinutes));
  useEffect(() => setIdle(String(f.idleMinutes)), [f.idleMinutes]);
  useEffect(() => setGap(String(f.minGapSeconds)), [f.minGapSeconds]);
  useEffect(() => setQuiet(String(f.quietCheckMinutes)), [f.quietCheckMinutes]);
  // The status is read again on a slow clock; what is shown stays in place while it loads.
  const [st, setSt] = useState<ForemanStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tick = useTick(5000);
  useEffect(() => {
    // The live status is the owners' to read; everyone else sees the settings alone.
    if (readOnly) return;
    let alive = true;
    api<ForemanStatus>('GET', '/foreman').then(
      (data) => {
        if (!alive) return;
        setSt(data);
        setError(null);
      },
      (e: Error) => alive && setError(e.message),
    );
    return () => {
      alive = false;
    };
  }, [tick, readOnly, f.enabled, f.minGapSeconds, f.quietCheckMinutes, f.answersQuestions]);

  const gapN = Number(gap);
  const quietN = Number(quiet);
  const idleN = Number(idle);
  const numbersValid = Number.isFinite(gapN) && gap.trim() !== '' && Number.isFinite(quietN) && quiet.trim() !== '' && Number.isFinite(idleN) && idle.trim() !== '';
  const dirty = numbersValid && (Math.round(gapN) !== f.minGapSeconds || Math.round(quietN) !== f.quietCheckMinutes || Math.round(idleN) !== f.idleMinutes);
  const off = !f.enabled;
  const last = st?.lastRound ?? null;
  const fresh = st?.attention.filter((i) => !i.seen) ?? [];
  const older = st?.attention.filter((i) => i.seen) ?? [];

  return (
    <div className="col" style={{ gap: 14, maxWidth: 680 }}>
      <Toggle checked={f.enabled} onChange={(enabled) => set({ enabled }, enabled ? 'Foreman rounds are on' : 'Foreman rounds are off')} title="Foreman rounds">
        The foreman (hire one with the role <b>Foreman</b>; there is one for the whole office) has no desk: it walks the office — the shared floor and every member's room that is open — and keeps the work going. When something needs it — a
        question nobody has answered, a blocked or stalled task, ready work next to someone free, someone who has stopped and is doing nothing — it is given one round: it goes over, looks at what they are really doing, answers, assigns, tells them
        how to continue, and comes to you only with what is yours to decide. Hiring a foreman switches this on. Off: nothing is ever sent to the foreman automatically.
      </Toggle>
      <div className="pc-info">
        Each round is a real turn in the foreman's own Claude Code session, so it uses Claude usage on the account the foreman runs on. Whether a round is due is worked out by the office itself, without any model: a quiet office starts no round and costs
        nothing.
      </div>
      <Toggle checked={f.answersQuestions} onChange={(answersQuestions) => set({ answersQuestions })} title="The foreman answers employees' questions" disabled={off}>
        An employee's question goes to the foreman as well as to you; whoever answers first counts, and the record says who it was. Approving or denying an action is never the foreman's — permission requests always wait for you. Off: questions wait for
        you alone, and the foreman only deals with blocked, stalled and unassigned work.
      </Toggle>
      <form
        className="col"
        style={{ gap: 10 }}
        onSubmit={(ev) => {
          ev.preventDefault();
          if (dirty) set({ minGapSeconds: Math.round(gapN), quietCheckMinutes: Math.round(quietN), idleMinutes: Math.round(idleN) });
        }}
      >
        <div className="grid2">
          <Field label="Shortest gap between rounds (seconds)" hint={`However much is going on, a new round starts no sooner than this after the previous one ended.${st && st.minGapSeconds !== f.minGapSeconds ? ` In force right now: ${st.minGapSeconds} s.` : ''}`}>
            <input type="number" min={30} max={3600} step={10} value={gap} disabled={off} onChange={(ev) => setGap(ev.target.value)} />
          </Field>
          <Field label="Quiet check every (minutes)" hint="With nothing waiting, the foreman still takes one look around this often — but only if tasks or sessions changed since its last round. 0 = never.">
            <input type="number" min={0} max={1440} step={5} value={quiet} disabled={off} onChange={(ev) => setQuiet(ev.target.value)} />
          </Field>
          <Field label="Someone idle for (minutes)" hint="A running session that has done nothing this long, with no task in progress, is put in front of the foreman once: it looks, and gets them going again or leaves them be. 0 = never.">
            <input type="number" min={0} max={1440} step={1} value={idle} disabled={off} onChange={(ev) => setIdle(ev.target.value)} aria-label="Someone idle for (minutes)" />
          </Field>
        </div>
        <div className="row">
          <Button variant="primary" type="submit" disabled={!dirty || off}>
            Save
          </Button>
        </div>
      </form>

      <div style={readOnly ? { display: 'none' } : undefined}>
        <div className="section-title">Right now</div>
        {error && !st && <div className="small bad">Could not load the foreman's status: {error}</div>}
        {st && (
          <div className="col small" style={{ gap: 6 }}>
            <div>
              <span className="muted">Foreman: </span>
              {st.foreman ? (
                <>
                  <span className="strong">{st.foreman.name}</span> <Badge tone={st.foreman.session === 'running' ? 'good' : 'muted'}>{st.foreman.session === 'running' && st.foreman.activity ? (ACTIVITY_LABEL[st.foreman.activity] ?? st.foreman.activity).toLowerCase() : 'no session running'}</Badge>
                  {st.visiting && <span className="muted"> — with {useOffice.getState().employees[st.visiting]?.name ?? 'someone'} right now</span>}
                  {st.otherForemen.length > 0 && <span className="faint"> — rounds go to {st.foreman.name}; {st.otherForemen.join(', ')} also {st.otherForemen.length === 1 ? 'has' : 'have'} the role</span>}
                </>
              ) : (
                <span className="muted">nobody yet</span>
              )}
            </div>
            {st.problem && <div className="pc-note">{st.problem}</div>}
            <div>
              <span className="muted">{st.round ? 'Round in progress' : 'Last round'}: </span>
              {st.round ? (
                <span>started {fmtDateTime(st.round.startedAt)}</span>
              ) : last ? (
                <span>
                  {fmtDateTime(last.finishedAt ?? last.startedAt)} — {last.reason === 'quiet_check' ? 'quiet check, ' : ''}
                  {ROUND_OUTCOME[last.outcome] ?? last.outcome}
                  {roundDid(last) ? ` · ${roundDid(last)}` : ''}
                </span>
              ) : (
                <span className="muted">none yet</span>
              )}
            </div>
            {!st.round && last?.summary && <div className="faint">“{last.summary}”</div>}
            <div>
              <span className="muted">Needs attention: </span>
              {fresh.length === 0 && older.length === 0 && <span className="muted">nothing</span>}
            </div>
            {[...fresh, ...older].map((i) => (
              <div key={i.key} className="row" style={{ alignItems: 'baseline', gap: 6 }}>
                <Badge tone={i.seen ? 'muted' : 'warn'}>{ATTENTION_LABEL[i.kind] ?? i.kind}</Badge>
                <span className="grow">
                  {i.text}
                  {i.escalated ? <span className="faint"> — escalated to you</span> : i.seen ? <span className="faint"> — the foreman has seen it</span> : off || !st.foreman ? null : <span className="faint"> — waiting for the next round</span>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AuditSection() {
  const load = useLoad<AuditEntry[]>('/audit?limit=200');
  const rows = load.data ?? [];
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row">
        <span className="small muted">The last {rows.length || 200} recorded actions, newest first. Secrets are redacted before anything is stored.</span>
        <span className="grow" />
        <Button small onClick={load.reload} disabled={load.loading}>
          Refresh
        </Button>
      </div>
      <LoadState load={load} what="the audit log" />
      {load.data && rows.length === 0 && <div className="small muted">Nothing has been recorded yet.</div>}
      {rows.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const detail = r.detail && Object.keys(r.detail).length ? JSON.stringify(r.detail) : '';
              return (
                <tr key={r.id} title={detail || undefined}>
                  <td className="small mono muted pc-nowrap" title={r.ts}>
                    {fmtDateTime(r.ts)}
                  </td>
                  <td>
                    <Badge tone={r.actor.startsWith('owner') ? 'info' : 'muted'}>{r.actor}</Badge>
                  </td>
                  <td className="mono">{r.action}</td>
                  <td>
                    <div className="mono small" style={{ wordBreak: 'break-all' }}>
                      {r.target}
                    </div>
                    {detail && (
                      <div className="mono small faint truncate" style={{ maxWidth: 360 }}>
                        {detail}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * A member's own sign-in: the password they come in with at the office's address, and leaving a browser they signed in on.
 * (Whether a member may have a password at all is not decided here — anybody who is in may give themselves one.)
 */
function AccountSection() {
  const me = useOffice((s) => s.me);
  const load = useLoad<{ hasPassword: boolean; passwordSession: boolean }>('/me');
  const data = load.data;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  if (!data) return <LoadState load={load} what="your sign-in" />;
  const mismatch = !!again && next !== again;
  const ready = next.length >= 8 && next === again && (!data.hasPassword || !!current) && !busy;
  const change = async () => {
    setBusy(true);
    const done = await act(() => api('POST', '/me/password', { current, password: next }), data.hasPassword ? 'Password changed' : 'Password set');
    setBusy(false);
    if (!done) return;
    // Sessions made with the old password are over — this one too, when it was one.
    if (data.passwordSession) {
      forgetToken();
      window.location.reload();
      return;
    }
    setCurrent('');
    setNext('');
    setAgain('');
    load.reload();
  };
  const signOut = async () => {
    await api('POST', '/logout').catch(() => undefined);
    forgetToken();
    window.location.reload();
  };
  return (
    <div className="col" style={{ gap: 16 }} data-settings-section="account">
      <div className="pc-info">
        You are in this office as <b>{me?.name}</b> ({me?.role}). {data.hasPassword ? 'You can sign in at the office’s address in a browser with that name and your password.' : 'With a password you can also sign in at the office’s address in a browser, with that name.'}
      </div>
      <form
        className="col"
        style={{ gap: 8, maxWidth: 360 }}
        onSubmit={(ev) => {
          ev.preventDefault();
          if (ready) void change();
        }}
      >
        <div className="section-title">{data.hasPassword ? 'Change your password' : 'Set a password'}</div>
        {/* For a password manager: which account this is. */}
        <input type="text" value={me?.name ?? ''} autoComplete="username" readOnly hidden />
        {data.hasPassword && <input type="password" value={current} maxLength={200} placeholder="Current password" aria-label="Current password" autoComplete="current-password" onChange={(e) => setCurrent(e.target.value)} />}
        <input type="password" value={next} maxLength={200} placeholder="New password (at least 8 characters)" aria-label="New password" autoComplete="new-password" onChange={(e) => setNext(e.target.value)} />
        <input type="password" value={again} maxLength={200} placeholder="New password, once more" aria-label="New password, once more" autoComplete="new-password" onChange={(e) => setAgain(e.target.value)} />
        {mismatch && <div className="small bad">The two do not match.</div>}
        <div className="row" style={{ gap: 8 }}>
          <Button variant="primary" type="submit" disabled={!ready}>
            {data.hasPassword ? 'Change password' : 'Set password'}
          </Button>
        </div>
        <div className="small faint">Changing it signs out every browser that was signed in with the old one. The desktop app stays in.</div>
      </form>
      {data.passwordSession && !window.orchestrator && (
        <div className="col" style={{ gap: 8 }}>
          <div className="section-title">This browser</div>
          <div className="small muted">Signed in with your password. It stays signed in for 30 days unless you sign out.</div>
          <div className="row">
            <Button onClick={() => void signOut()} data-sign-out>
              Sign out
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsPanel({ arg, onClose }: PanelProps) {
  const settings = useOffice((s) => s.settings);
  // Only owners change the office; everyone changes what is their own.
  const owner = useOffice((s) => s.me?.role === 'owner');
  const role = useOffice((s) => s.me?.role ?? 'visitor');
  // The office's own computer is not a member: nothing to sign in with.
  const member = useOffice((s) => !!s.me && s.me.id !== 'owner' && !!s.me.id);
  const sections = SECTIONS.filter((s) => (owner || !s.ownerOnly) && (member || !s.memberOnly));
  const [picked, setSection] = useState<SectionId>(sections.some((s) => s.id === arg) ? (arg as SectionId) : owner ? 'company' : 'graphics');
  const section = sections.some((s) => s.id === picked) ? picked : 'graphics';
  const [capturing, setCapturing] = useState<string | null>(null);
  if (!settings) return null;
  const pick = (id: SectionId) => {
    setCapturing(null);
    setSection(id);
  };
  const current = SECTIONS.find((s) => s.id === section)!;
  const readOnly = current.group === 'office' && !owner;
  return (
    // While a key is being captured the window must not react to Escape: it may be the key being bound.
    <Window kit title="Settings" subtitle={`${GROUPS.find((g) => g.id === current.group)!.label} · ${current.label}`} onClose={capturing ? undefined : onClose} width={940} flush>
      <div className="split pc-fixed" style={{ gridTemplateColumns: '190px 1fr' }}>
        <nav className="split-side list" aria-label="Settings sections">
          {GROUPS.map((g) => (
            <div key={g.id} className="pc-navgroup" role="group" aria-label={g.label}>
              <div className="section-title">{g.label}</div>
              <div className="small faint pc-navhint">{g.id === 'mine' ? 'Yours, saved on this computer.' : owner ? 'The same for everyone in it.' : 'Changed by its owners.'}</div>
              {sections
                .filter((s) => s.group === g.id)
                .map((s) => (
                  <button key={s.id} className={`pc-rowbtn ${section === s.id ? 'list-item-on' : ''}`} aria-current={section === s.id} onClick={() => pick(s.id)}>
                    {s.label}
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <div className="split-main">
          {current.group === 'mine' && section !== 'account' && (
            <div className="pc-info" style={{ marginBottom: 12 }} data-settings-scope="mine">
              Yours alone, kept on this computer, and the same in every office you open from here.</div>
          )}
          {readOnly && (
            <div className="pc-info" style={{ marginBottom: 12 }} data-settings-scope="office-readonly">
              These settings belong to the office and only its owners can change them — you are here as a {role}, so they are shown as they are.
            </div>
          )}
          {section === 'graphics' && <GraphicsSection />}
          {section === 'controls' && <ControlsSection capturing={capturing} setCapturing={setCapturing} />}
          {section === 'sound' && <SoundSection />}
          {section === 'account' && <AccountSection />}
          {current.group === 'office' && (
            // A disabled fieldset switches off every control inside it at once.
            <fieldset className="pc-plain" disabled={readOnly}>
              {section === 'company' && <CompanySection settings={settings} />}
              {section === 'surroundings' && <SurroundingsSection settings={settings} />}
              {section === 'improve' && <ImproveSection settings={settings} />}
              {section === 'workers' && (
                <div className="col" style={{ gap: 12, maxWidth: 640 }}>
                  <Toggle checked={settings.workersInheritMcp} onChange={(workersInheritMcp) => void save({ workersInheritMcp })} title="Employees also get your MCP servers and connectors">
                    Off: employees get only the office's own tools — cheaper per request, and they reach their folder and the office, nothing else of yours. On: they also get your own MCP servers and connectors and whatever those can reach. Takes effect
                    for a session the next time it starts.
                  </Toggle>
                  <Toggle checked={settings.autoAsksHighRisk !== false} onChange={(autoAsksHighRisk) => void save({ autoAsksHighRisk })} title="On Auto, still ask me before high-risk commands">
                    Employees on <b>Auto</b> do not ask for permission; Claude Code's own auto mode decides what is safe. With this on, high-risk commands — pushing, sudo, deploying, publishing, broad deletions, reading credential files — still
                    come to you first.
                  </Toggle>
                  <Toggle
                    checked={(settings.unrestrictedAsksHighRisk ?? settings.autoAsksHighRisk) !== false}
                    onChange={(unrestrictedAsksHighRisk) => void save({ unrestrictedAsksHighRisk })}
                    title="On Unrestricted, still ask me before high-risk commands"
                  >
                    Employees on <b>Unrestricted</b> run without any permission checks. With this on, the same high-risk commands are still held until you answer. <b>Off: an Unrestricted employee is never stopped for approval</b> — pushing, sudo,
                    deploying, deleting, reading credential files all run at once, and nothing asks you. Switching it off takes effect at once, also for sessions that are already running (on a computer with an older desktop app, the session is started again between turns, once); switching it back on starts each such session again between turns.
                    Either way the office's own files on a machine stay fenced off, and a project's deny rules still refuse what they refuse.
                  </Toggle>
                  <Toggle checked={settings.employeesSetModels !== false} onChange={(employeesSetModels) => void save({ employeesSetModels })} title="Employees may change models and effort">
                    An employee may set the <b>model</b> and the <b>effort</b> of their own and their colleagues' sessions — a project manager putting routine work on a lighter model, say — with a reason that is in the feed and the audit log.
                    Never the level, never the Claude account, never the foreman, and not across to or from a member's own computer. Off: only you change them.
                  </Toggle>
                  <Toggle checked={settings.acceptStartPrompts !== false} onChange={(acceptStartPrompts) => void save({ acceptStartPrompts })} title="Answer Claude Code's start-up questions for me">
                    When a session starts in a folder for the first time, Claude Code asks whether to <b>trust the folder</b>; the first time an account runs an <b>Unrestricted</b> employee it shows its <b>Bypass Permissions warning</b> ("you accept
                    all responsibility…"). With this on, the office answers yes to both by itself — the folder for whoever you put there, the warning for whoever an owner put on Unrestricted, on the office's own machines — and says so in the feed.
                    Off: the folder is still trusted for employees on Auto and Unrestricted, and everything else waits for your answer in the Inbox.
                  </Toggle>
                  <div className="field" data-review-default>
                    <span className="field-label">Finished work is reviewed by</span>
                    <select aria-label="Finished work is reviewed by" value={reviewDefaultOf(settings)} onChange={(e) => void save({ reviewDefault: e.target.value as ReviewBy })} style={{ width: 'auto', alignSelf: 'flex-start' }}>
                      {REVIEW_CHOICES.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                    <span className="field-hint">
                      {REVIEW_CHOICES.find((c) => c.id === reviewDefaultOf(settings))!.hint} This is what every new task starts with, whoever makes it — you, an employee, a routine; each task can be set differently when it is made or
                      afterwards. A part of a divided task is not reviewed on its own: the whole is.
                    </span>
                  </div>
                  <Toggle checked={settings.employeesManageBoard !== false} onChange={(employeesManageBoard) => void save({ employeesManageBoard })} title="Employees manage the task board themselves">
                    On: any employee can release a waiting task, unblock one (saying how), give a task to a colleague, review a colleague's finished work, and start a colleague who is needed — so work goes on without you. Off: those are yours.
                    Either way no employee approves a permission request, marks work done without verification, or deletes anything.
                  </Toggle>
                  <Toggle checked={settings.whipApproves === true} onChange={(whipApproves) => void save({ whipApproves })} title="The whip approves">
                    Off: the whip is only for show. On: cracking it at an employee who is waiting for a permission approves that request — for whoever may decide it anyway, and on the record as theirs, like an approval from the Inbox.
                    It approves whatever they asked: look at the request first.
                  </Toggle>
                  <Toggle checked={settings.employeesBrowser !== false} onChange={(employeesBrowser) => void save({ employeesBrowser })} title="Employees have a browser">
                    On: on machines where a browser for employees is installed (Machines shows which), every session gets one of its own — headless, empty at each start — to look at what it builds, read documentation and take the screenshots it
                    leaves as evidence. A page an employee opens can say anything, and what a page says can steer a model: leave this off for work that must not touch the web. Takes effect for a session the next time it starts.
                  </Toggle>
                  <Toggle checked={settings.accountFailover !== false} onChange={(accountFailover) => void save({ accountFailover })} title="Move employees to another Claude account when theirs runs out">
                    On: when the Claude account an employee runs on has used up its allowance and the same machine has another account with room, the employee is put on that one and their session starts again there, so nobody waits for a reset.
                    Off: they wait. Accounts are added in Company → Claude.
                  </Toggle>
                  <SleepSetting settings={settings} />
                </div>
              )}
              {section === 'foreman' && <ForemanSection settings={settings} readOnly={readOnly} />}
              {section === 'audit' && <AuditSection />}
            </fieldset>
          )}
        </div>
      </div>
    </Window>
  );
}
registerPanel('settings', SettingsPanel);
