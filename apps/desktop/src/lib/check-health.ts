import type { Question, Task } from '@orchestrator/contracts';

/**
 * How the office's work was checked lately — the figures an owner measured by hand on 2026-11-23 (`docs/TASKS.md` §1,
 * "What was checked, said"), kept in front of them: how much of the handed-in code the office tested, what colleagues
 * say they checked, how the owner's own approvals went, and what waits for them now. From the tasks the window holds.
 */
export interface CheckHealth {
  days: number;
  /** Code handed in within the window (not a review, research or planning). */
  handedIn: number;
  /** Of those: the office ran the project's own command and it passed. */
  tested: number;
  /** Only the office's syntax check of the changed files. */
  syntaxOnly: number;
  /** Nothing of the office's checked it. */
  unchecked: number;
  peerApprovals: number;
  /** Colleague approvals that say what was checked. */
  peerChecked: number;
  /** Sent back at least once. */
  sentBack: number;
  ownerApprovals: number;
  /** The owner's approvals with a word said. */
  ownerSaid: number;
  /** In review and waiting for an owner, oldest first. */
  waiting: Array<{ id: string; key: string; title: string; since: string }>;
}

const NOT_CODE = new Set(['review', 'research', 'planning']);

/** When it was handed in last (it reached REVIEW). */
function handedAt(t: Task): string | null {
  for (let i = (t.history ?? []).length - 1; i >= 0; i--) if (t.history[i]!.status === 'REVIEW' && /waiting for review|Verified/i.test(t.history[i]!.note)) return t.history[i]!.ts;
  return t.completedAt ?? null;
}

/** Since when it waits for an owner: the colleague's approval, or the hand-in. */
function waitsSince(t: Task): string {
  return t.evidence.peerReview?.ts ?? handedAt(t) ?? t.updatedAt;
}

export function checkHealth(tasks: Record<string, Task> | Task[], now = Date.now(), days = 14): CheckHealth {
  const from = new Date(now - days * 86_400_000).toISOString();
  const all = Array.isArray(tasks) ? tasks : Object.values(tasks);
  const out: CheckHealth = { days, handedIn: 0, tested: 0, syntaxOnly: 0, unchecked: 0, peerApprovals: 0, peerChecked: 0, sentBack: 0, ownerApprovals: 0, ownerSaid: 0, waiting: [] };
  for (const t of all) {
    if (NOT_CODE.has(t.kind) || t.cancelled) continue;
    if (t.status === 'REVIEW' && !t.approverId && (t.reviewStage === 'boss' || (!t.reviewStage && !t.reviewerId))) out.waiting.push({ id: t.id, key: t.key, title: t.title, since: waitsSince(t) });
    const at = handedAt(t);
    if (!at || at < from || !(t.status === 'REVIEW' || t.status === 'DONE')) continue;
    out.handedIn++;
    const v = t.evidence.verification;
    if (v?.provenance === 'measured' && v.passed === true) {
      if (v.kind === 'syntax') out.syntaxOnly++;
      else out.tested++;
    } else out.unchecked++;
    const r = t.evidence.review;
    const peer = t.evidence.peerReview ?? (r?.by === 'employee' && r.verdict === 'approved' ? r : null);
    if (peer) {
      out.peerApprovals++;
      if (peer.checked?.trim()) out.peerChecked++;
    }
    if ((t.friction?.reviewRejections ?? 0) > 0) out.sentBack++;
    if (r?.by === 'owner' && r.verdict === 'approved') {
      out.ownerApprovals++;
      if (r.comments?.trim()) out.ownerSaid++;
    }
  }
  out.waiting.sort((a, b) => a.since.localeCompare(b.since));
  return out;
}

/**
 * What the office decided without its owner, against what came to them — the owner's principle of 2026-11-27,
 * "autonomy, learning, self-improvement", kept measurable on the operations wall. Reviews: given by a project manager in
 * the boss's place, or by an owner; questions: answered by a project manager, or by an owner (permission requests and
 * the like are not questions). From what the window holds.
 */
export interface Autonomy {
  days: number;
  reviewsByManagers: number;
  reviewsByOwners: number;
  /** Of the managers' approvals: those that let a release out. */
  releasesByManagers: number;
  questionsByManagers: number;
  questionsByOwners: number;
}

const ANSWERABLE = new Set(['question', 'decision', 'priority', 'deployment']);

export function autonomy(tasks: Record<string, Task> | Task[], questions: Record<string, Question> | Question[], now = Date.now(), days = 7): Autonomy {
  const from = new Date(now - days * 86_400_000).toISOString();
  const out: Autonomy = { days, reviewsByManagers: 0, reviewsByOwners: 0, releasesByManagers: 0, questionsByManagers: 0, questionsByOwners: 0 };
  for (const t of Array.isArray(tasks) ? tasks : Object.values(tasks)) {
    const verdict = [...(t.history ?? [])].reverse().find((h) => h.ts >= from && /^Review approved by /.test(h.note));
    if (verdict && /in the boss's place/.test(verdict.note)) {
      out.reviewsByManagers++;
      if (t.release?.approvedBy && /the manager/.test(t.release.approvedBy)) out.releasesByManagers++;
    } else if (t.evidence?.review?.by === 'owner' && t.evidence.review.verdict === 'approved' && (t.evidence.review.ts || '') >= from) out.reviewsByOwners++;
  }
  for (const q of Array.isArray(questions) ? questions : Object.values(questions)) {
    if (!ANSWERABLE.has(q.kind) || !q.answeredAt || q.answeredAt < from) continue;
    if (q.answeredBy?.kind === 'manager') out.questionsByManagers++;
    else if (!q.answeredBy || q.answeredBy.kind === 'owner') out.questionsByOwners++;
  }
  return out;
}
