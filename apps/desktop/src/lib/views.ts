import { ACTIVITY_LABEL, formatDuration, roleByKey } from '@orchestrator/contracts';
import { deskPods, type BoardView, type CeoView, type HostView, type PersonView, type WalkRequest, type WallView, type WhiteboardView, type ZoneView } from '@orchestrator/office-3d';
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

export function personViews(s: OfficeState): PersonView[] {
  const meetingSeats = new Map<string, number>();
  for (const m of Object.values(s.meetings)) {
    if (!ACTIVE_MEETING.has(m.status)) continue;
    m.participantIds.filter((id) => !m.absent.includes(id)).forEach((id, i) => meetingSeats.set(id, i));
  }
  const out: PersonView[] = [];
  for (const e of Object.values(s.employees)) {
    if (e.archived) continue;
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
      deskId: e.deskId,
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
 * A foreman's `look_at` calls become visits: its character walks to the desk of each employee it
 * really looked at, in the order it looked, and goes back to its own desk when the round is over.
 * Looks that come in quick succession are shown one after the other, not only the last of them.
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
 * Recent collaboration events become short walks between desks, and a foreman's looks become visits.
 * The event is real; the walk only shows it.
 */
export function walkRequests(s: OfficeState, now: number): WalkRequest[] {
  const out: WalkRequest[] = foremanWalks(s.events, now);
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
  // How much Claude is left: one clock per account on the wall, from what Claude Code itself last reported.
  const left = (w: { usedPercent: number; resetsAt: string | null } | null, label: string): string => {
    if (!w) return `${label}: not reported`;
    const text = limitText(w) ?? '';
    const resets = text.includes('·') ? ` · ${text.split('·')[1]!.trim()}` : '';
    return `${label}: ${Math.max(0, 100 - Math.round(w.usedPercent))}% left${resets}`;
  };
  const accounts = s.accounts.map((a) => ({
    key: a.key,
    name: accountName(a, s.hosts[a.hostId]?.name),
    week: a.sevenDay ? a.sevenDay.usedPercent : null,
    five: a.fiveHour ? a.fiveHour.usedPercent : null,
    lines: a.reportedAt ? [left(a.sevenDay, 'Week'), left(a.fiveHour, '5 hours')] : ['Not reported yet', 'shows when a session starts'],
  }));
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
export function zoneViews(s: OfficeState): ZoneView[] {
  if (!s.layout) return [];
  const seated = new Map<string, string | null>();
  for (const e of Object.values(s.employees)) if (!e.archived && e.deskId) seated.set(e.deskId, e.projectId ?? null);
  const out: ZoneView[] = [];
  for (const pod of deskPods(s.layout.desks)) {
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
