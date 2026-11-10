import { ACTIVITY_LABEL, formatDuration, memberSeatOf, roleByKey } from '@orchestrator/contracts';
import { deskPods, withMemberRooms, type ForemanView, type MemberOffice, type BoardView, type CeoView, type HostView, type UsageClockView, type PersonView, type WalkRequest, type WallView, type WhiteboardView, type ZoneView } from '@orchestrator/office-3d';
import { activityOf, currentTaskOf, sessionOfEmployee, type OfficeState } from './store.ts';

/**
 * Real orchestration state → the view models the 3D scene renders.
 * This is the only bridge between the two: the scene never sees sessions or tasks.
 */

const ACTIVE_MEETING = new Set(['proposals', 'responses', 'synthesis']);

/** From this level on an employee's desk is shown as a specialized workstation. Looks only: it unlocks no capability. */
export const SPECIALIZED_DESK_LEVEL = 5;

/** Activities in which someone is working without typing: thinking it through or reading. */
const AWAY_FROM_KEYBOARD = new Set(['thinking', 'reading', 'researching', 'planning']);

/** The office as the scene draws it, and who of the members' own employees is in it. */
export interface OfficeWithRooms extends MemberOffice {
  /** Personal employees who are not in the office: their member is not connected (or no room could be attached). */
  away: Set<string>;
}

let lastOffice: { layout: OfficeState['layout']; key: string; value: OfficeWithRooms } | null = null;

/**
 * The stored layout plus a room for every member whose own computer is connected, with their personal employees
 * seated in it. Nothing here is stored: it follows from which personal hosts are online. The same object comes
 * back for as long as the answer is the same (hosts report in every few seconds), so the scene is not rebuilt.
 */
export function officeWithRooms(s: OfficeState, unlocked: string[]): OfficeWithRooms | null {
  if (!s.layout) return null;
  const personal = Object.values(s.hosts)
    .filter((h) => !!h.memberId && h.status !== 'revoked')
    .sort((a, b) => a.enrolledAt.localeCompare(b.enrolledAt) || a.id.localeCompare(b.id));
  const staff = Object.values(s.employees)
    .filter((e) => !e.archived && !!e.hostId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  // Every member's room stands in the office whether they are in or not: lit and open while their computer is
  // connected, grey and locked while it is not. (A computer of theirs that is away and has nobody on it gets no room
  // when they have another: an old enrollment would otherwise leave an empty room behind.)
  const hasStaff = (id: string) => staff.some((e) => e.hostId === id);
  const shown = personal.filter((h) => h.status === 'online' || hasStaff(h.id) || !personal.some((o) => o.id !== h.id && o.memberId === h.memberId));
  const online = shown.map((h) => ({ hostId: h.id, memberId: h.memberId!, memberName: h.memberName ?? h.name, prefs: h.room ?? null, locked: h.status !== 'online', seats: Object.fromEntries(staff.filter((e) => e.hostId === h.id && memberSeatOf(e.deskId)?.hostId === h.id).map((e) => [e.id, memberSeatOf(e.deskId)!.n])), employeeIds: staff.filter((e) => e.hostId === h.id).map((e) => e.id) }));
  const theirs = staff.filter((e) => personal.some((h) => h.id === e.hostId)).map((e) => e.id);
  const key = JSON.stringify([online, theirs, [...unlocked].sort()]);
  if (lastOffice && lastOffice.layout === s.layout && lastOffice.key === key) return lastOffice.value;
  const office = withMemberRooms(s.layout, online, new Set(unlocked));
  const value: OfficeWithRooms = { ...office, away: new Set(theirs.filter((id) => !office.deskOf.has(id))) };
  lastOffice = { layout: s.layout, key, value };
  return value;
}

export function personViews(s: OfficeState, office?: OfficeWithRooms | null): PersonView[] {
  const meetingSeats = new Map<string, number>();
  for (const m of Object.values(s.meetings)) {
    if (!ACTIVE_MEETING.has(m.status)) continue;
    m.participantIds.filter((id) => !m.absent.includes(id)).forEach((id, i) => meetingSeats.set(id, i));
  }
  const out: PersonView[] = [];
  for (const e of Object.values(s.employees)) {
    if (e.archived) continue;
    // The foreman has no desk: it walks the floor, drawn on its own (see `foremanView`).
    if (e.roleKey === 'foreman') continue;
    // A member's own employees are in the office only while that member is: in their room, at a desk there.
    if (office?.away.has(e.id)) continue;
    const session = sessionOfEmployee(s.sessions, e.id);
    const live = !!session && (session.status === 'running' || session.status === 'starting');
    const activity = activityOf(session);
    const task = currentTaskOf(s.tasks, e.id);
    const questions = Object.values(s.questions).filter((q) => q.employeeId === e.id && q.status === 'open');
    const blockedTask = Object.values(s.tasks).some((t) => t.assigneeId === e.id && t.status === 'BLOCKED');
    let attention: PersonView['attention'] = null;
    if (questions.some((q) => q.kind === 'permission' || q.kind === 'trust_prompt') || activity === 'needs_approval') attention = 'approval';
    else if (questions.length || activity === 'waiting_answer') attention = 'question';
    else if (activity === 'blocked' || blockedTask) attention = 'blocked';
    else if (activity === 'task_complete') attention = 'done';
    const project = s.projects[task?.projectId ?? e.projectId ?? ''];
    const filtered = (s.filter.projectId && e.projectId !== s.filter.projectId) || (s.filter.hostId && e.hostId !== s.filter.hostId) || (s.filter.employeeId && e.id !== s.filter.employeeId);
    out.push({
      id: e.id,
      name: e.name,
      title: e.title,
      appearance: e.appearance,
      deskId: office?.deskOf.get(e.id) ?? e.deskId,
      activity,
      label: meetingSeats.has(e.id) && live ? 'IN MEETING' : (ACTIVITY_LABEL[activity] ?? activity.toUpperCase()),
      detail: session?.activityDetail ?? null,
      attention,
      sessionId: session?.id ?? null,
      live,
      projectColor: project?.color ?? null,
      level: e.level,
      meetingSeat: live ? (meetingSeats.get(e.id) ?? null) : null,
      idleSince: live && activity === 'idle' ? Date.parse(session!.activitySince) : null,
      dimmed: !!filtered,
      taskKey: task?.key ?? null,
      progress: task?.progress.percent ?? null,
      controlled: !!session && s.control[session.id]?.you === true,
      projectId: e.projectId ?? null,
      roleColor: roleByKey(e.roleKey)?.color ?? null,
      workstation: e.level >= SPECIALIZED_DESK_LEVEL ? 'specialized' : 'standard',
      // Planning work, live, and not at the keyboard right now: they stand at the project board until they type again or the task ends.
      atBoard: live && task?.kind === 'planning' && AWAY_FROM_KEYBOARD.has(activity) && !meetingSeats.has(e.id),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** How long the foreman stands at each desk it looked at, so every visit is seen even when several come at once. */
const FOREMAN_DWELL_MS = 8000;
/** While its round is still running, the foreman stays at the last desk it looked at for at most this long. */
const FOREMAN_STAY_MS = 40_000;

/**
 * What the foreman does during a round becomes visits: its character walks to the desk of each employee it
 * really looked at, answered, gave work to or told something, in that order, and goes back to walking the
 * floor when the round is over. Visits that come in quick succession are shown one after the other, not only
 * the last of them.
 */
export function foremanWalks(events: Array<{ id: string; type: string; ts: string; employeeId: string | null; data: Record<string, unknown> }>, now: number): WalkRequest[] {
  const visits = new Map<string, Array<{ id: string; toId: string; at: number }>>();
  /** When each foreman's latest round ended. */
  const ended = new Map<string, number>();
  const horizon = now - 3 * 60_000;
  for (let i = events.length - 1; i >= 0 && i > events.length - 600; i--) {
    const e = events[i]!;
    const at = Date.parse(e.ts);
    if (at < horizon) break;
    if (e.type === 'foreman.round.finished' && e.employeeId && !ended.has(e.employeeId)) ended.set(e.employeeId, at);
    if (e.type !== 'foreman.visit') continue;
    const from = e.data.fromEmployeeId;
    const to = e.data.toEmployeeId;
    if (typeof from !== 'string' || typeof to !== 'string' || from === to) continue;
    const list = visits.get(from) ?? [];
    list.unshift({ id: e.id, toId: to, at }); // oldest first
    visits.set(from, list);
  }
  const out: WalkRequest[] = [];
  for (const [fromId, list] of visits) {
    let start = 0;
    let current: { id: string; toId: string } | null = null;
    for (const [n, v] of list.entries()) {
      // Each desk gets its turn: a visit starts when the look happened, or when the previous desk has had its time.
      start = n ? Math.max(v.at, start + FOREMAN_DWELL_MS) : v.at;
      if (start > now) break;
      current = v;
      if (n === list.length - 1) {
        // The last desk: until the round ends (but long enough to get there), or for a while when nothing says it ended.
        const end = ended.get(fromId);
        const until = end !== undefined && end >= v.at ? Math.min(start + FOREMAN_STAY_MS, Math.max(start + FOREMAN_DWELL_MS, end)) : start + FOREMAN_STAY_MS;
        if (now >= until) current = null;
      }
    }
    if (current) out.push({ id: current.id, fromId, toId: current.toId });
  }
  return out;
}

/**
 * Who cannot go on until this employee has answered or finished, one plain line each. Read from the waiting
 * sessions' own records (`AgentSession.waitingOn`), which the office keeps true.
 */
export function waitingForLines(s: Pick<OfficeState, 'sessions' | 'employees' | 'tasks'>, employeeId: string): string[] {
  const out: string[] = [];
  for (const x of Object.values(s.sessions)) {
    const w = x.waitingOn;
    if (!w || w.employeeId !== employeeId || (x.status !== 'running' && x.status !== 'starting')) continue;
    const who = s.employees[x.employeeId ?? '']?.name;
    if (!who) continue;
    out.push(w.requestId ? `${who} is waiting for an answer from them` : `${who} is waiting for them to finish ${s.tasks[w.taskId ?? '']?.key ?? 'a task'}`);
  }
  return out;
}

const VISIT_VERB: Record<string, string> = { look: 'checking', answer: 'answering', assign: 'giving work to', tell: 'talking to' };
const ROUND_NOUN: Array<[string, string, string]> = [
  ['question', 'question', 'questions'],
  ['blocked', 'blocked', 'blocked'],
  ['stalled', 'stalled', 'stalled'],
  ['unassigned', 'to assign', 'to assign'],
  ['idle', 'idle', 'idle'],
  ['waiting', 'waiting', 'waiting'],
];

/**
 * The foreman as the scene draws it: who it is, whether it is on its rounds, who it is with right now and what
 * it is doing — all read from recorded state and events. Null while the office has no foreman.
 */
export function foremanView(s: OfficeState, now: number): ForemanView | null {
  const e = Object.values(s.employees)
    .filter((x) => !x.archived && x.roleKey === 'foreman')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  if (!e) return null;
  const session = sessionOfEmployee(s.sessions, e.id);
  const live = !!session && (session.status === 'running' || session.status === 'starting');
  const patrolling = !!s.settings?.foreman?.enabled;
  const visit = foremanWalks(s.events, now).find((w) => w.fromId === e.id);
  // The round in flight, if any: the latest "started" with no "finished" after it.
  let round: Record<string, unknown> | null = null;
  for (let i = s.events.length - 1; i >= 0 && i > s.events.length - 600; i--) {
    const ev = s.events[i]!;
    if (ev.employeeId !== e.id) continue;
    if (ev.type === 'foreman.round.finished') break;
    if (ev.type === 'foreman.round.started') {
      if (now - Date.parse(ev.ts) < 15 * 60_000) round = ev.data;
      break;
    }
  }
  let doing = patrolling ? 'walking the floor' : 'rounds paused';
  if (visit) {
    const action = String(s.events.find((x) => x.id === visit.id)?.data.action ?? 'look');
    doing = `${VISIT_VERB[action] ?? 'with'} ${s.employees[visit.toId]?.name ?? 'someone'}`;
  } else if (round) {
    const counts = (round.counts ?? {}) as Record<string, number>;
    const parts = ROUND_NOUN.filter(([k]) => counts[k]! > 0).map(([k, one, many]) => `${counts[k]} ${counts[k] === 1 ? one : many}`);
    doing = round.reason === 'quiet_check' || !parts.length ? 'round: a look around' : `round: ${parts.join(', ')}`;
  }
  const filtered = (s.filter.projectId && e.projectId !== s.filter.projectId) || (s.filter.hostId && e.hostId !== s.filter.hostId) || (s.filter.employeeId && e.id !== s.filter.employeeId);
  return { id: e.id, name: e.name, appearance: e.appearance, level: e.level, live, patrolling, visitingId: visit?.toId ?? null, space: 'WHOLE OFFICE', doing, dimmed: !!filtered };
}

/**
 * Recent collaboration events become short walks between desks. The event is real; the walk only shows it.
 * (The foreman's visits are its own: see `foremanView`.)
 */
export function walkRequests(s: OfficeState, now: number): WalkRequest[] {
  const out: WalkRequest[] = [];
  for (let i = s.events.length - 1; i >= 0 && i > s.events.length - 80; i--) {
    const e = s.events[i]!;
    if (now - Date.parse(e.ts) > 9000) break;
    if (e.type !== 'agent.collaboration_requested' && e.type !== 'task.review_requested') continue;
    const from = e.data.fromEmployeeId as string | undefined;
    const to = e.data.toEmployeeId as string | undefined;
    if (from && to && from !== to && !out.some((w) => w.fromId === from)) out.push({ id: e.id, fromId: from, toId: to });
  }
  return out;
}

export function hostViews(s: OfficeState): HostView[] {
  return Object.values(s.hosts)
    .filter((h) => h.status !== 'revoked')
    .sort((a, b) => a.enrolledAt.localeCompare(b.enrolledAt))
    .map((h) => ({
      id: h.id,
      name: h.name,
      status: h.status,
      cpu: h.status === 'online' ? (h.resources?.cpuPercent ?? null) : null,
      mem: h.status === 'online' && h.resources?.memUsedBytes != null && h.resources.memTotalBytes ? (h.resources.memUsedBytes / h.resources.memTotalBytes) * 100 : null,
      sessions: Object.values(s.sessions).filter((x) => x.hostId === h.id && x.status === 'running').length,
    }));
}

const BOARD_COLUMNS = ['BACKLOG', 'READY', 'IN_PROGRESS', 'REVIEW', 'BLOCKED', 'DONE'];

export function boardView(s: OfficeState): BoardView {
  const projects = Object.values(s.projects).filter((p) => p.status !== 'archived');
  const pid = s.filter.projectId ?? (projects.length === 1 ? projects[0]!.id : null);
  const tasks = Object.values(s.tasks).filter((t) => (!pid || t.projectId === pid) && t.kind !== 'review');
  return {
    title: pid ? `${s.projects[pid]?.name ?? 'Project'} — task board` : projects.length ? 'All projects — task board' : 'No projects yet — create one to start',
    columns: BOARD_COLUMNS.map((status) => ({
      status,
      items: tasks
        .filter((t) => t.status === status)
        .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))
        .map((t) => ({ key: t.key, title: t.title, who: s.employees[t.assigneeId ?? '']?.name ?? (t.roleHint ? `unassigned · ${t.roleHint}` : 'unassigned'), color: s.projects[t.projectId]?.color ?? '#888' })),
    })),
  };
}

export function wallView(s: OfficeState, people: PersonView[]): WallView {
  const live = people.filter((p) => p.live && p.sessionId);
  // People who need the owner first, then the busiest.
  live.sort((a, b) => Number(!!b.attention) - Number(!!a.attention) || Number(b.activity !== 'idle') - Number(a.activity !== 'idle'));
  const hosts = Object.values(s.hosts).filter((h) => h.status !== 'revoked');
  const tasks = Object.values(s.tasks);
  return {
    tiles: live.slice(0, 6).map((p) => ({ sessionId: p.sessionId!, name: p.name, label: p.label })),
    stats: [
      `${live.length} live session${live.length === 1 ? '' : 's'} on ${hosts.filter((h) => h.status === 'online').length}/${hosts.length} hosts`,
      `${tasks.filter((t) => t.status === 'IN_PROGRESS').length} in progress · ${tasks.filter((t) => t.status === 'REVIEW').length} in review`,
      ...(tasks.some((t) => t.status === 'BLOCKED') ? [`! ${tasks.filter((t) => t.status === 'BLOCKED').length} blocked`] : []),
      ...(Object.values(s.questions).some((q) => q.status === 'open') ? [`? ${Object.values(s.questions).filter((q) => q.status === 'open').length} waiting on you`] : []),
      ...hosts.filter((h) => h.status !== 'online').map((h) => `! host ${h.name} offline`),
    ],
  };
}

/** "23%" and when it starts again, for one rate-limit window; null when Claude Code has not reported it. */
export function limitText(w: { usedPercent: number; resetsAt: string | null } | null, now = Date.now()): string | null {
  if (!w) return null;
  const left = w.resetsAt ? Date.parse(w.resetsAt) - now : NaN;
  const when = !Number.isFinite(left) || left <= 0 ? '' : left < 3600e3 ? ` · resets in ${Math.max(1, Math.round(left / 60e3))} min` : left < 48 * 3600e3 ? ` · resets in ${Math.round(left / 3600e3)} h` : ` · resets in ${Math.round(left / 86400e3)} d`;
  return `${Math.round(w.usedPercent)}% used${when}`;
}

/** What to call an account: who is logged in, else where it lives. */
export function accountName(a: { email: string | null; configDir: string | null }, hostName: string | undefined): string {
  return a.email ?? `${a.configDir ?? 'default login'} on ${hostName ?? 'a machine'}`;
}

/** One account as a wall clock: the big hand is the week, the small dial the 5-hour window. */
function clockOf(s: OfficeState, a: OfficeState['accounts'][number]): UsageClockView {
  const left = (w: { usedPercent: number; resetsAt: string | null } | null, label: string): string => {
    if (!w) return `${label}: not reported`;
    const text = limitText(w) ?? '';
    const resets = text.includes('·') ? ` · ${text.split('·')[1]!.trim()}` : '';
    return `${label}: ${Math.max(0, 100 - Math.round(w.usedPercent))}% left${resets}`;
  };
  const host = s.hosts[a.hostId];
  // Who is logged in is not told to everyone; a member's account is then simply theirs.
  const name = a.email ?? (host?.memberId ? `${host.memberName ?? 'Member'}'s Claude${a.configDir ? ` (${a.configDir})` : ''}` : accountName(a, host?.name));
  return {
    key: a.key,
    name,
    week: a.sevenDay ? a.sevenDay.usedPercent : null,
    five: a.fiveHour ? a.fiveHour.usedPercent : null,
    lines: a.reportedAt ? [left(a.sevenDay, 'Week'), left(a.fiveHour, '5 hours')] : ['Not reported yet', 'shows when a session starts'],
  };
}

const NO_CLOCKS: Record<string, UsageClockView[]> = {};
let lastClocks: { key: string; value: Record<string, UsageClockView[]> } | null = null;

/** The usage clocks in members' rooms: for each member computer, the Claude accounts used on it. The same object while nothing changed. */
export function memberClocks(s: OfficeState): Record<string, UsageClockView[]> {
  const out: Record<string, UsageClockView[]> = {};
  for (const a of s.accounts) {
    if (!s.hosts[a.hostId]?.memberId) continue;
    (out[a.hostId] ??= []).push(clockOf(s, a));
  }
  if (!Object.keys(out).length) return NO_CLOCKS;
  const key = JSON.stringify(out);
  if (lastClocks?.key === key) return lastClocks.value;
  lastClocks = { key, value: out };
  return out;
}

export function ceoView(s: OfficeState): CeoView {
  const c = s.company;
  const open = Object.values(s.questions).filter((q) => q.status === 'open').length;
  const blocked = Object.values(s.tasks).filter((t) => t.status === 'BLOCKED').length;
  const projects = Object.values(s.projects).filter((p) => p.status === 'active');
  const lines = [
    `${projects.length} active project${projects.length === 1 ? '' : 's'} · ${Object.values(s.employees).filter((e) => !e.archived).length} employees`,
    `${c?.tasksCompleted ?? 0} tasks verified done · ${c?.testsPassed ?? 0} verifications passed`,
    `${c?.mergesSucceeded ?? 0} merges · ${c?.reviewsCompleted ?? 0} reviews`,
  ];
  if (open) lines.push(`? ${open} decision${open === 1 ? '' : 's'} waiting on you`);
  if (blocked) lines.push(`! ${blocked} task${blocked === 1 ? '' : 's'} blocked`);
  for (const p of projects.slice(0, 3)) {
    const ts = Object.values(s.tasks).filter((t) => t.projectId === p.id && t.kind !== 'review');
    lines.push(`${p.name}: ${ts.filter((t) => t.status === 'DONE').length}/${ts.length} done`);
  }
  // How much Claude is left on the office's own accounts (the machines everyone shares): one clock each, on this
  // room's wall. A member's own account hangs in their own room (`memberClocks`).
  const accounts = s.accounts.filter((a) => !s.hosts[a.hostId]?.memberId).map((a) => clockOf(s, a));
  return { company: s.settings?.companyName ?? 'My Company', tagline: 'Your code. Your company. Your world.', lines, accounts };
}

/** Markdown line → what someone would write on a whiteboard (no heading marks, bullets or emphasis). */
function plainLine(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)]|>)\s+/, '')
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

const ROUND: Record<string, { n: number; label: string; round: string }> = {
  proposals: { n: 1, label: 'proposals', round: 'proposal' },
  responses: { n: 2, label: 'responses', round: 'response' },
  synthesis: { n: 3, label: 'synthesis', round: 'synthesis' },
};

/** The meeting-room whiteboard: the meeting that is running now, or else the last recorded decision. */
export function whiteboardView(s: OfficeState): WhiteboardView {
  const meetings = Object.values(s.meetings);
  const running = meetings.filter((m) => ACTIVE_MEETING.has(m.status) || m.status === 'scheduled').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (running) {
    const r = ROUND[running.status];
    const name = (id: string) => s.employees[id]?.name ?? 'someone';
    const lines = running.participantIds.map((id) => {
      if (running.absent.includes(id)) return `${name(id)} — absent`;
      if (!r) return name(id);
      return running.contributions.some((c) => c.employeeId === id && c.round === r.round) ? `✓ ${name(id)} — ${r.round} in` : `… ${name(id)}`;
    });
    if (r?.round === 'synthesis') lines.unshift(`Facilitator: ${name(running.facilitatorId)}`);
    return { state: 'running', meetingId: running.id, title: running.topic, status: r ? `Round ${r.n} of 3 — ${r.label}` : 'Scheduled — not started yet', lines };
  }
  const last = meetings.filter((m) => m.status === 'concluded').sort((a, b) => (b.concludedAt ?? b.createdAt).localeCompare(a.concludedAt ?? a.createdAt))[0];
  if (last) {
    // The decision itself first: the document's "Decision" section onward when it has one, else everything
    // but the title and the header lines (date, participants, facilitator). Section headings are kept as "HEADING:".
    const topic = last.topic.trim().toLowerCase();
    const raw = (last.decisionDoc ?? '').split('\n');
    const from = raw.findIndex((l) => /^\s{0,3}#{1,6}\s*decision\b/i.test(l));
    const lines = (from >= 0 ? raw.slice(from) : raw)
      .map((l) => (/^\s{0,3}#{1,6}\s+/.test(l) ? `${plainLine(l).replace(/:$/, '').toUpperCase()}:` : plainLine(l)))
      .filter((l) => l && l !== ':' && !/^[-=_*\s|]+$/.test(l) && l.replace(/:$/, '').toLowerCase() !== topic && !/^(date|participants|facilitator):/i.test(l));
    return {
      state: 'concluded',
      meetingId: last.id,
      title: last.topic,
      status: `Decided ${new Date(last.concludedAt ?? last.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} · ${last.participantIds.length} participants`,
      lines: lines.length ? lines.slice(0, 8) : ['No decision document was recorded.'],
    };
  }
  return { state: 'empty', meetingId: null, title: 'No meeting yet', status: '', lines: ['Start one here: the topic, each round and the decision will be written on this board.'] };
}

/**
 * Project zones: a desk pod whose seated people all, or mostly, belong to one project is that
 * project's workspace. Mixed and empty pods are nobody's. The counts are that project's real tasks.
 */
export function zoneViews(s: OfficeState, office?: OfficeWithRooms | null): ZoneView[] {
  if (!s.layout) return [];
  const seated = new Map<string, string | null>();
  for (const e of Object.values(s.employees)) {
    const deskId = office?.deskOf.get(e.id) ?? (office?.away.has(e.id) ? null : e.deskId);
    if (!e.archived && deskId) seated.set(deskId, e.projectId ?? null);
  }
  const out: ZoneView[] = [];
  for (const pod of deskPods((office?.layout ?? s.layout).desks)) {
    const people = pod.deskIds.filter((id) => seated.has(id)).map((id) => seated.get(id)!);
    if (!people.length) continue;
    const tally = new Map<string, number>();
    for (const pid of people) if (pid) tally.set(pid, (tally.get(pid) ?? 0) + 1);
    const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    // "Mostly": more than half of the people sitting there.
    if (!top || top[1] * 2 <= people.length) continue;
    const project = s.projects[top[0]];
    if (!project || project.status === 'archived') continue;
    const tasks = Object.values(s.tasks).filter((t) => t.projectId === project.id && t.kind !== 'review');
    out.push({
      id: pod.id,
      deskIds: pod.deskIds,
      projectId: project.id,
      name: project.name,
      color: project.color,
      inProgress: tasks.filter((t) => t.status === 'IN_PROGRESS').length,
      blocked: tasks.filter((t) => t.status === 'BLOCKED').length,
      done: tasks.filter((t) => t.status === 'DONE').length,
    });
  }
  return out;
}

export function sinceLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  return formatDuration(Date.now() - Date.parse(iso));
}
