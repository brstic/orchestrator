import type { ActivityState, AgentSession, BackgroundCommand, HookPayload } from '@orchestrator/contracts';
import { redactSecrets, truncate } from '@orchestrator/contracts';
import type { Engine } from './engine.ts';

/**
 * Commands that go on running in a session's background, and what the office shows for them.
 *
 * **What is known, and from where.** A session's machine sees the shells Claude Code started for its commands that
 * are still alive (`toolShells`, sent as `shells` whenever the set changes). Its hooks say which Bash call is in front
 * of the session right now — begun (`PreToolUse`) and not yet over (`PostToolUse`). Every live shell that is not the
 * one of a call in front is running in the background: started with `run_in_background`, moved there after its time
 * ran out, or sent there by whoever is at the terminal. When it ends, its shell does.
 *
 * **What is shown.** The commands themselves on the session (`AgentSession.background`: what each is, since when) —
 * a line under the name in the office and in the profile, while the employee goes on with other things. And when the
 * turn is over and nothing but that is going on — the employee would be "available", or "waiting" with their last
 * words — the state says what it really is: `waiting_command`, ⏳ COMMAND RUNNING, until the last one ends. Claude
 * Code tells the session when a command of its ends; whatever it does then, its hooks say. When the command has ended
 * and they say nothing, the employee is what they were before: available, or waiting.
 *
 * A wait for a colleague, a question, an approval, a pause, a completed task are not covered over: they say more, and
 * the line under the name still says that something runs.
 */
interface Shell {
  pid: number;
  command: string;
  since: number;
}

/** A shell's start as the machine reports it (whole seconds of `ps`) and a call's start by the office's clock differ by this much at most. */
const SAME_MOMENT_MS = 2_500;
/** How long after a call went to the background its shell may still be unknown to the office (the machine looks every two seconds). */
const NOT_SEEN_YET_MS = 15_000;

export class Background {
  private eng: Engine;
  /** The command shells of each session, as its machine last reported them. */
  private shells = new Map<string, Shell[]>();
  /** Bash calls in front of each session right now: tool_use_id → the command, and when the call began. */
  private inFront = new Map<string, Map<string, { command: string; at: number }>>();
  /** What Claude Code said a command is for (the Bash call's `description`), by command, for each session. */
  private words = new Map<string, Map<string, string>>();
  /** When a Bash call of the session last went to the background (its hook says so before its machine does). */
  private sentBack = new Map<string, number>();
  /** What the session would show if nothing ran in its background, while ⏳ COMMAND RUNNING is shown instead. */
  private rest = new Map<string, [ActivityState, string | null]>();

  constructor(eng: Engine) {
    this.eng = eng;
  }

  private get core() {
    return this.eng.core;
  }

  /** A machine says which command shells one of its sessions has. */
  onShells(hostId: string, sessionId: string, shells: unknown): void {
    const session = this.core.sessions.get(sessionId);
    if (!session || session.hostId !== hostId || !Array.isArray(shells)) return;
    const before = new Map((this.shells.get(sessionId) ?? []).map((s) => [s.pid, s]));
    const now = Date.now();
    const list: Shell[] = [];
    for (const s of shells.slice(0, 20) as Array<{ pid?: unknown; command?: unknown; seconds?: unknown }>) {
      if (!s || typeof s.pid !== 'number' || typeof s.command !== 'string') continue;
      const seconds = typeof s.seconds === 'number' && s.seconds >= 0 && s.seconds < 1e8 ? s.seconds : 0;
      list.push({ pid: s.pid, command: s.command.slice(0, 4000), since: before.get(s.pid)?.since ?? now - seconds * 1000 });
    }
    if (list.length) this.shells.set(sessionId, list);
    else this.shells.delete(sessionId);
    this.update(session);
  }

  /** A hook of the session: a Bash call in front of it began or ended, or a turn did. */
  onHook(session: AgentSession, payload: HookPayload): void {
    const id = session.id;
    const ev = payload.hook_event_name;
    let changed = false;
    if (ev === 'UserPromptSubmit' || ev === 'Stop' || ev === 'StopFailure' || ev === 'SessionStart' || ev === 'SessionEnd') {
      changed = this.inFront.delete(id);
    } else if (payload.tool_name === 'Bash') {
      const input = (payload.tool_input ?? {}) as Record<string, unknown>;
      const command = typeof input.command === 'string' ? input.command : '';
      const calls = this.inFront.get(id) ?? new Map<string, { command: string; at: number }>();
      if (ev === 'PreToolUse') {
        if (command && typeof input.description === 'string' && input.description.trim()) {
          const words = this.words.get(id) ?? new Map<string, string>();
          words.delete(norm(command));
          words.set(norm(command), input.description.trim());
          if (words.size > 60) words.delete(words.keys().next().value!);
          this.words.set(id, words);
        }
        if (input.run_in_background !== true) {
          calls.set(payload.tool_use_id ?? `cmd:${command}`, { command, at: Date.now() });
          this.inFront.set(id, calls);
          changed = true;
        } else this.sentBack.set(id, Date.now());
      } else if (ev === 'PostToolUse' || ev === 'PostToolUseFailure' || ev === 'PermissionDenied') {
        // (A refusal may not carry the call's id: then the call with that command is the one that ended.)
        const key = payload.tool_use_id && calls.has(payload.tool_use_id) ? payload.tool_use_id : [...calls].find(([, c]) => c.command === command)?.[0];
        if (key !== undefined) changed = calls.delete(key);
        if (ev === 'PostToolUse' && wentToBackground(payload.tool_response)) this.sentBack.set(id, Date.now());
      }
    }
    if (changed) this.update(session);
  }

  /** Is anything of this session running in the background — or about to be seen to (a call went there a moment ago)? */
  busy(sessionId: string): boolean {
    return !!this.core.sessions.get(sessionId)?.background?.length || Date.now() - (this.sentBack.get(sessionId) ?? 0) < NOT_SEEN_YET_MS;
  }

  /**
   * What a session is to be shown doing, when `state` is what it was going to be: between turns with nothing else
   * going on, while something runs in its background, it is waiting for that. (`SessionRegistry.setActivity` asks.)
   */
  instead(session: AgentSession, state: ActivityState, detail: string | null): [ActivityState, string | null] {
    if (state === 'waiting_command') return [state, detail];
    const bg = session.background ?? [];
    if (bg.length && session.inTurn === false && this.coverable(session, state, detail)) {
      this.rest.set(session.id, [state, detail]);
      return ['waiting_command', describe(bg)];
    }
    this.rest.delete(session.id);
    return [state, detail];
  }

  /** The session ended, or its machine went away: nothing of it is known to run any more (its machine says again when it is back). */
  forget(sessionId: string): void {
    this.shells.delete(sessionId);
    this.inFront.delete(sessionId);
    this.sentBack.delete(sessionId);
    this.rest.delete(sessionId);
  }

  /** The words and state that go with what is known now. */
  private update(session: AgentSession): void {
    const live = session.status === 'running' || session.status === 'starting';
    // (A session that has ended runs nothing, whatever a late report says.)
    const shown: BackgroundCommand[] = live ? this.running(session.id).map((s) => ({ what: this.what(session.id, s.command), since: new Date(s.since).toISOString() })) : [];
    const changed = JSON.stringify(session.background ?? []) !== JSON.stringify(shown);
    if (changed) session.background = shown.length ? shown : null;
    if (live && session.inTurn === false && !this.core.gateway.isPaused(session.id)) {
      if (session.activity === 'waiting_command') {
        if (!shown.length) {
          const [state, detail] = this.rest.get(session.id) ?? this.resting(session);
          this.rest.delete(session.id);
          return void this.eng.sessions.setActivity(session, state, detail);
        }
        if (describe(shown) !== session.activityDetail) return void this.eng.sessions.setActivity(session, 'waiting_command', describe(shown));
      } else if (shown.length && this.coverable(session, session.activity, session.activityDetail)) {
        return void this.eng.sessions.setActivity(session, session.activity, session.activityDetail);
      }
    }
    if (changed) this.core.put('session', session);
  }

  /** The shells of the session that are not those of the calls in front of it, oldest first. */
  private running(sessionId: string): Shell[] {
    const left = [...(this.shells.get(sessionId) ?? [])];
    for (const call of this.inFront.get(sessionId)?.values() ?? []) {
      // The shell of that very command; failing that, the newest one started since the call began (a call that waits
      // for an approval has no shell yet, and an older shell is not its).
      let i = left.findIndex((s) => norm(s.command) === norm(call.command));
      if (i < 0) i = left.reduce((best, s, j) => (s.since >= call.at - SAME_MOMENT_MS && (best < 0 || s.since >= left[best]!.since) ? j : best), -1);
      if (i >= 0) left.splice(i, 1);
    }
    return left.sort((a, b) => a.since - b.since);
  }

  private what(sessionId: string, command: string): string {
    const said = this.words.get(sessionId)?.get(norm(command));
    return truncate(redactSecrets((said ?? command).replace(/\s+/g, ' ').trim()), 160) || 'a command';
  }

  /** Between turns with nothing else to say: available, or waiting with a task in hand — not waiting for a colleague. */
  private coverable(session: AgentSession, state: ActivityState, detail: string | null): boolean {
    if (state === 'idle') return true;
    return state === 'waiting_input' && !session.waitingOn && !(detail ?? '').startsWith('Waiting for ');
  }

  /** What a session between turns is when nothing runs and nothing more is known. */
  private resting(session: AgentSession): [ActivityState, string | null] {
    const task = this.eng.tasks.currentTask(session.employeeId);
    return task && task.delivery.status === 'confirmed' ? ['waiting_input', `Stopped while working on ${task.key}`] : ['idle', null];
  }
}

/** A command as compared with another: its words, however its lines and spaces fell (`ps` on Linux writes a line break as "?"). */
const norm = (command: string): string => command.replace(/[\s?]+/g, ' ').trim();

/** The detail of ⏳ COMMAND RUNNING: the command, and how many more there are. */
function describe(bg: BackgroundCommand[]): string {
  const first = bg[0]!.what;
  return bg.length === 1 ? first : `${first} — and ${bg.length - 1} more`;
}

/** Did a Bash call return because its command went on in the background (by request, after its time ran out, or by hand)? */
function wentToBackground(response: unknown): boolean {
  if (!response || typeof response !== 'object') return typeof response === 'string' && /in background with ID|moved to the background|backgrounded by user/i.test(response);
  const r = response as Record<string, unknown>;
  return typeof r.backgroundTaskId === 'string' || typeof r.background_task_id === 'string';
}
