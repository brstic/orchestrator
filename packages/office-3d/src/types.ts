import type { Appearance, TerminalScreen } from '@orchestrator/contracts';

/**
 * View models: the only things the 3D layer knows about. They are computed by
 * the application from real orchestration state; the scene has no access to
 * sessions, tasks or agents, and cannot change them.
 */
export interface PersonView {
  id: string;
  name: string;
  title: string;
  appearance: Appearance;
  deskId: string | null;
  /** Real activity state, or "offline" when no live session exists. */
  activity: string;
  /** Short caption shown over the head, e.g. "RUNNING TESTS". */
  label: string;
  detail: string | null;
  attention: 'question' | 'approval' | 'blocked' | 'done' | null;
  sessionId: string | null;
  live: boolean;
  projectColor: string | null;
  level: number;
  /** Seat index at the conference table while in a real, active meeting. */
  meetingSeat: number | null;
  /** When the employee became idle (ms since epoch), for break-room visits. */
  idleSince: number | null;
  /** Filtered out by the owner's project/machine filter. */
  dimmed: boolean;
  taskKey: string | null;
  progress: number | null;
  /** The owner holds this employee's keyboard. */
  controlled: boolean;
  /** The project this employee is assigned to (their pod becomes that project's zone). */
  projectId: string | null;
  /** Colour of the employee's role, for the accent on a specialized workstation. */
  roleColor: string | null;
  /** What stands on their desk: a specialized workstation is earned with levels and changes nothing about what they can do. */
  workstation: 'standard' | 'specialized';
  /** Working on a planning task and currently thinking or reading rather than typing: they stand at the project board. */
  atBoard: boolean;
  /** Commands of theirs running in the background (`AgentSession.background`): how many, and what the first is. Null: none. */
  background?: { count: number; what: string } | null;
  /** What they keep working toward until it holds (their goal, while it stands). Null: none. */
  goal?: string | null;
  /**
   * Being moved to another machine (`docs/MOVE.md`): how far, over their head; their desk is packed into a box while it
   * goes, and when it is done they carry the box to their new place. `failed`: it did not happen (nothing is shown).
   */
  moving?: { percent: number; phase: 'packing' | 'sending' | 'unpacking' | 'failed' } | null;
}

/** What is written on the meeting-room whiteboard: the meeting that is running, or the last decision. */
export interface WhiteboardView {
  state: 'running' | 'concluded' | 'empty';
  meetingId: string | null;
  /** The meeting's topic. */
  title: string;
  /** One line under the title: the round that is running, or when it was decided. */
  status: string;
  /** Who has spoken this round, or the first lines of the decision document. */
  lines: string[];
}

/** The employee of the month, for the board of that name: who, since when, and how long they have worked. Null: nobody yet. */
export interface AwardView {
  employeeId: string;
  name: string;
  title: string;
  appearance: Appearance;
  /** "November 2026". */
  month: string;
  /** Whole hours worked in that month. */
  hours: number;
}

/** A desk pod whose people (all or most of them) belong to one project. */
export interface ZoneView {
  /** The pod's id (see `deskPods`). */
  id: string;
  deskIds: string[];
  projectId: string;
  name: string;
  color: string;
  /** Real task counts of that project. */
  inProgress: number;
  blocked: number;
  done: number;
}

/**
 * Somebody who has no desk and walks among the desks: a member's team lead (see `Walker.tsx`).
 * Everything here is recorded state: who it is and who it is with right now.
 */
export interface WalkerView {
  id: string;
  name: string;
  appearance: Appearance;
  level: number;
  /** Its session is running. */
  live: boolean;
  /** It walks from desk to desk. Off: it stands at its home place. */
  patrolling: boolean;
  /** The employee it is with right now (it looked at them, told them something, gave them work), if any. */
  visitingId: string | null;
  /** Whose it looks after, for the name tag: "ANA'S TEAM". */
  space: string;
  /** What it is doing, in a few words: "checking Alex", "looking after the team". */
  doing: string;
  dimmed: boolean;
  /** What it is, for the name tag: "TEAM LEAD". */
  title: string;
  /** Whose desks it walks between: its own team's. Absent: everybody's. */
  stopsOf?: string[];
  /** Where it stands when there is nobody to walk to: its own seat. Absent: by the entrance. */
  homeDeskId?: string | null;
}

/** One avatar walks to another's desk: the visualisation of a real collaboration event. */
export interface WalkRequest {
  id: string;
  fromId: string;
  toId: string;
}

export interface HostView {
  id: string;
  /**
   * A server a member brought in and keeps to themselves: it stands in their room as a small rack, not among the
   * office's machines in the server room. (Shared, it is one of the office's machines.)
   */
  private?: boolean;
  name: string;
  status: 'online' | 'offline' | 'revoked';
  cpu: number | null;
  mem: number | null;
  sessions: number;
}

export interface BoardView {
  title: string;
  columns: Array<{ status: string; items: Array<{ key: string; title: string; who: string; color: string }> }>;
}

export interface WallView {
  /** Sessions shown on the operations wall. */
  tiles: Array<{ sessionId: string; name: string; label: string }>;
  stats: string[];
}

/** One Claude account on the CEO room wall: a clock whose big hand is the week and whose small dial is the 5-hour window. */
export interface UsageClockView {
  key: string;
  /** Who the account belongs to (or where it lives, when that is not known). */
  name: string;
  /** Percent of the week used, 0–100; null when Claude Code has not reported it. */
  week: number | null;
  /** Percent of the 5-hour window used; null when not reported (or the account has no such window). */
  five: number | null;
  /** What is written under the clock. */
  lines: string[];
}

export interface CeoView {
  company: string;
  tagline: string;
  lines: string[];
  /** One clock per Claude account the employees run on. */
  accounts: UsageClockView[];
}

/** What the office hi-fi is doing right now: the office's own state, the same in every window (also in one that has muted its copy). */
export interface RadioView {
  playing: boolean;
  station: string | null;
}

export type Quality = 'low' | 'medium' | 'high';
export type CameraMode = 'ceo' | 'first' | 'management' | 'free' | 'workstation' | 'command';

export interface NearbyTarget {
  kind: 'employee' | 'desk' | 'board' | 'meeting' | 'server' | 'ops' | 'ceo' | 'break' | 'reception' | 'hifi' | 'tv' | 'vault' | 'arcade' | 'seat' | 'edge';
  id: string;
  label: string;
}

export type ScreenSubscribe = (sessionId: string, fn: (s: TerminalScreen) => void) => () => void;
