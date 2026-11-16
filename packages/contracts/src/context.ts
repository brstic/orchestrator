/**
 * The central context (`docs/CONTEXT.md`): short facts in layers that every employee always holds, whoever they talk
 * to — put in front of the model by the machine's agent when a session starts, after every compaction, and as a change
 * at the next prompt when the facts change. These types and the two renderings are shared by the office (which
 * compiles a pack per employee) and the machine's agent (which hands it to Claude Code), so both say it the same way.
 */
import type { ID, ISODate } from './entities.ts';

/** Where a fact belongs, and so who holds it. */
export type ContextLayer = 'office' | 'project' | 'client' | 'role' | 'self';
export const CONTEXT_LAYERS: ContextLayer[] = ['office', 'project', 'role', 'client', 'self'];

export interface ContextFact {
  id: ID;
  layer: ContextLayer;
  /** What it is about: a project's id, a client's id, a role's key, an employee's id; null for the office. */
  scope: string | null;
  /** A few words: what it is. */
  title: string;
  /** The fact itself, short (Markdown). */
  text: string;
  /** In front of the employee always (the pack); false: found on demand (`get_context`). */
  always: boolean;
  /** Kept from rented employees (an office fact that is the office's business only). */
  notForClients?: boolean;
  /** When somebody should look at it again (it may be out of date by then). */
  reviewBy?: ISODate | null;
  /** proposed: waits for a person (an employee's proposal); archived: no longer held. */
  status: 'active' | 'proposed' | 'archived';
  createdAt: ISODate;
  createdBy: string;
  updatedAt: ISODate;
  updatedBy: string;
}

/** One fact as an employee is given it. */
export interface ContextItem {
  id: ID;
  layer: ContextLayer;
  /** Under which heading it stands ("Office", "Project Shop", "Your role: reviewer", …). */
  section: string;
  title: string;
  text: string;
}

/** What one employee holds: the facts, in order, and a version that changes when any of them does. */
export interface ContextPack {
  rev: string;
  items: ContextItem[];
  /** How many facts there are beyond these, on demand. */
  onDemand: number;
}

/** About 4,000 tokens: what every employee has in front of them always. Past it the window warns; past the hard cap the rest is on demand. */
export const CONTEXT_BUDGET_CHARS = 16_000;
export const CONTEXT_HARD_CAP_CHARS = 24_000;

const INTRO =
  "# The office's central context\nWhat everybody in this office is to know, kept by the office. It holds whatever conversation you are in. Where it and anything you were told earlier disagree, this is the newer word. Facts not shown here are found with get_context; propose a fact others should know with propose_context.";

/** The whole pack as the model reads it. */
export function renderContext(pack: ContextPack): string {
  const out: string[] = [INTRO, `(version ${pack.rev})`];
  let section = '';
  for (const it of pack.items) {
    if (it.section !== section) {
      out.push('', `## ${it.section}`);
      section = it.section;
    }
    out.push(`- **${it.title}** — ${it.text.trim()}`);
  }
  if (pack.onDemand) out.push('', `(${pack.onDemand} more fact${pack.onDemand === 1 ? '' : 's'} on demand: get_context.)`);
  return out.join('\n');
}

/** What changed between two packs, as the model reads it at its next prompt; null when nothing did. */
export function renderContextChange(before: ContextPack | null, after: ContextPack): string | null {
  if (!before) return renderContext(after);
  if (before.rev === after.rev) return null;
  const was = new Map(before.items.map((i) => [i.id, i]));
  const now = new Map(after.items.map((i) => [i.id, i]));
  const lines: string[] = [];
  for (const it of after.items) {
    const old = was.get(it.id);
    if (!old) lines.push(`- New (${it.section}): **${it.title}** — ${it.text.trim()}`);
    else if (old.text !== it.text || old.title !== it.title || old.section !== it.section) lines.push(`- Changed (${it.section}): **${it.title}** — ${it.text.trim()}`);
  }
  for (const it of before.items) if (!now.has(it.id)) lines.push(`- No longer holds (${it.section}): **${it.title}**`);
  if (!lines.length) return null;
  return [`# The office's central context changed (version ${before.rev} → ${after.rev})`, 'This replaces what you were told before about these:', ...lines].join('\n');
}
