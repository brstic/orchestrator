#!/usr/bin/env node
/**
 * How the office's work went, read from its database — read-only. The figures the owner asked for on 2026-11-23
 * ("how good is this multi-agent process, really?"), made one command so they can be read again and compared (the
 * branches pilot, `docs/plans/BRANCHES-FOR-A-TEAM-IN-PLACE.md`).
 *
 *   node --no-warnings scripts/measure-work.mjs <orchestrator.db> [--days 14] [--project <name>]...
 *
 * Prints per project group (all, and each --project given): work tickets and review tickets; how the office checked
 * the hand-ins (the project's command, only the syntax check, nothing); colleagues' verdicts and how many say what
 * they checked; owners' verdicts and how many with a word; sent back at least once; work time and time in review;
 * what waits for an owner now. Nothing is written. Names of projects are printed as they are in that office.
 */
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a) && args[args.indexOf(a) - 1] !== '--project');
if (!file) {
  console.error('usage: node --no-warnings scripts/measure-work.mjs <orchestrator.db> [--days 14] [--project <name>]...');
  process.exit(2);
}
const days = Number(args[args.indexOf('--days') + 1]) || 14;
const only = args.flatMap((a, i) => (a === '--project' && args[i + 1] ? [args[i + 1]] : []));
const db = new DatabaseSync(file, { readOnly: true });
const docs = (kind) => db.prepare('select data from docs where kind = ?').all(kind).map((r) => JSON.parse(r.data));
const tasks = docs('task');
const projects = new Map(docs('project').map((p) => [p.id, p]));
const from = new Date(Date.now() - days * 86_400_000).toISOString();

const NOT_CODE = new Set(['review', 'research', 'planning']);
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const p90 = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.9)] : null);
const dur = (ms) => (ms == null ? '—' : ms < 3600e3 ? `${Math.round(ms / 60e3)} min` : `${(ms / 3600e3).toFixed(1)} h`);
const pct = (n, d) => (d ? `${n} of ${d} (${Math.round((100 * n) / d)}%)` : '—');
const at = (t, re) => (t.history ?? []).find((h) => re.test(`${h.status} ${h.note}`))?.ts ?? null;

function measure(name, list) {
  const inWindow = list.filter((t) => (at(t, /^REVIEW Verified/) ?? t.completedAt ?? t.createdAt) >= from);
  const work = inWindow.filter((t) => !t.reviewOf && !t.cancelled);
  const reviews = inWindow.filter((t) => t.reviewOf);
  const code = work.filter((t) => !NOT_CODE.has(t.kind) && (t.status === 'DONE' || t.status === 'REVIEW'));
  const v = (t) => t.evidence?.verification;
  const tested = code.filter((t) => v(t)?.provenance === 'measured' && v(t)?.passed === true && v(t)?.kind !== 'syntax').length;
  const parsed = code.filter((t) => v(t)?.provenance === 'measured' && v(t)?.passed === true && v(t)?.kind === 'syntax').length;
  const peer = work.map((t) => t.evidence?.peerReview ?? (t.evidence?.review?.by === 'employee' && t.evidence.review.verdict === 'approved' ? t.evidence.review : null)).filter(Boolean);
  const owner = work.map((t) => t.evidence?.review).filter((r) => r?.by === 'owner' && r.verdict === 'approved');
  const sentBack = work.filter((t) => (t.friction?.reviewRejections ?? 0) > 0).length;
  const failedChecks = work.reduce((n, t) => n + (t.friction?.failedVerifications ?? 0), 0);
  const workTime = [];
  const reviewTime = [];
  for (const t of work.filter((x) => x.status === 'DONE')) {
    const start = at(t, /^IN_PROGRESS/);
    const handed = at(t, /^REVIEW/);
    const done = [...(t.history ?? [])].reverse().find((h) => h.status === 'DONE')?.ts;
    if (start && handed) workTime.push(Date.parse(handed) - Date.parse(start));
    if (handed && done) reviewTime.push(Date.parse(done) - Date.parse(handed));
  }
  const reviewTook = reviews.map((r) => {
    const s = at(r, /^IN_PROGRESS/);
    const d = [...(r.history ?? [])].reverse().find((h) => h.status === 'DONE')?.ts;
    return s && d ? Date.parse(d) - Date.parse(s) : null;
  }).filter((x) => x != null);
  const waiting = list.filter((t) => t.status === 'REVIEW' && t.reviewStage === 'boss');
  const merged = work.filter((t) => t.evidence?.merge?.ok).length;
  const conflicts = work.reduce((n, t) => n + (t.friction?.mergeConflicts ?? 0), 0);
  const released = work.filter((t) => t.release?.releasedAt);
  const toRelease = released.map((t) => Date.parse(t.release.releasedAt) - Date.parse(t.release.approvedAt)).filter((x) => x >= 0);
  console.log(`\n== ${name} — the last ${days} days`);
  console.log(`work tickets ${work.length} (code handed in ${code.length}) · review tickets ${reviews.length}`);
  console.log(`checked by the office: its tests ${pct(tested, code.length)} · only parsed ${parsed} · nothing ${code.length - tested - parsed} · failed checks ${failedChecks}`);
  console.log(`colleagues' approvals ${peer.length}, saying what they checked ${pct(peer.filter((p) => p.checked?.trim()).length, peer.length)} · a review took ${dur(med(reviewTook))} (median)`);
  console.log(`owners' approvals ${owner.length}, with a word ${pct(owner.filter((r) => r.comments?.trim()).length, owner.length)} · sent back at least once ${pct(sentBack, work.length)}`);
  console.log(`work ${dur(med(workTime))} median, ${dur(p90(workTime))} p90 · in review ${dur(med(reviewTime))} median, ${dur(p90(reviewTime))} p90`);
  console.log(`merged by the office ${merged} · merge conflicts ${conflicts} · released and reported ${released.length}${toRelease.length ? `, approval to release ${dur(med(toRelease))} median` : ''}`);
  console.log(`waiting for an owner now ${waiting.length}${waiting.length ? `: ${waiting.map((t) => t.key).join(', ')}` : ''}`);
}

measure('all projects', tasks);
for (const n of only) {
  const ids = new Set([...projects.values()].filter((p) => p.name === n).map((p) => p.id));
  if (!ids.size) console.log(`\n(no project called "${n}")`);
  else measure(n, tasks.filter((t) => ids.has(t.projectId)));
}
