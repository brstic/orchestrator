import { useTick } from './company-shared.tsx';
import { useEffect, useState, type ReactNode } from 'react';
import { ACTIVITY_LABEL, type AuditEntry, type ForemanSettings, type ForemanStatus, type OwnerSettings, type SelfImprovementSettings } from '@orchestrator/contracts';
import { Badge, Button, Field, Window } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { DEFAULT_KEYS, setPrefs, usePrefs, type ClientPrefs, type PrefsPatch } from '../../lib/prefs.ts';
import { useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { LoadState, fmtDateTime, keyLabel, useLoad, type PanelProps } from './company-shared.tsx';
import { AutopilotDial } from './growth.tsx';

type SectionId = 'company' | 'graphics' | 'controls' | 'improve' | 'workers' | 'foreman' | 'audit';

/** 'mine': kept on this computer, for whoever sits at it. 'office': the office's own settings, which its owners change. */
const SECTIONS: Array<{ id: SectionId; label: string; group: 'mine' | 'office'; ownerOnly?: boolean }> = [
  { id: 'graphics', label: 'Graphics', group: 'mine' },
  { id: 'controls', label: 'Controls', group: 'mine' },
  { id: 'company', label: 'Company', group: 'office' },
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

const KEY_ACTIONS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'forward', label: 'Move forward', hint: 'Walk / fly forward' },
  { id: 'back', label: 'Move back', hint: 'Walk / fly backward' },
  { id: 'left', label: 'Turn left', hint: 'Turn your character (pans in the overview cameras)' },
  { id: 'right', label: 'Turn right', hint: 'Turn your character (pans in the overview cameras)' },
  { id: 'strafeLeft', label: 'Sidestep left', hint: 'Move sideways without turning' },
  { id: 'strafeRight', label: 'Sidestep right', hint: 'Move sideways without turning' },
  { id: 'interact', label: 'Interact', hint: 'Open the workstation or room you are standing next to' },
  { id: 'talk', label: 'Talk', hint: 'Talk to the employee you are standing next to' },
  { id: 'whip', label: 'Crack the whip', hint: 'A sound and an animation for the employee next to you — it changes nothing about their work' },
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
      hint="An idle Claude Code session still holds memory. On the office's own machines, a session with no work for this long is stopped and its employee is shown as sleeping. A message, a task, a routine or a meeting wakes it, in the same folder and the same conversation. 0 = never; otherwise at least 5."
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

function SettingsPanel({ arg, onClose }: PanelProps) {
  const settings = useOffice((s) => s.settings);
  // Only owners change the office; everyone changes what is their own.
  const owner = useOffice((s) => s.me?.role === 'owner');
  const role = useOffice((s) => s.me?.role ?? 'visitor');
  const sections = SECTIONS.filter((s) => owner || !s.ownerOnly);
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
    <Window title="Settings" subtitle={`${GROUPS.find((g) => g.id === current.group)!.label} · ${current.label}`} onClose={capturing ? undefined : onClose} width={940} flush>
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
          {current.group === 'mine' && (
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
          {current.group === 'office' && (
            // A disabled fieldset switches off every control inside it at once.
            <fieldset className="pc-plain" disabled={readOnly}>
              {section === 'company' && <CompanySection settings={settings} />}
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
                  <Toggle checked={settings.employeesManageBoard !== false} onChange={(employeesManageBoard) => void save({ employeesManageBoard })} title="Employees manage the task board themselves">
                    On: any employee can release a waiting task, unblock one (saying how), give a task to a colleague, review a colleague's finished work, and start a colleague who is needed — so work goes on without you. Off: those are yours.
                    Either way no employee approves a permission request, marks work done without verification, or deletes anything.
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
