import { useState, type ReactNode } from 'react';
import type { Employee } from '@orchestrator/contracts';
import { Avatar } from '@orchestrator/ui';
import type { Meter as MeterValue } from '../../lib/machines.ts';

/**
 * The pieces of the calm look (docs/UI.md) that are more than a class name. The styles are `kit.css`; a window that
 * has been moved to this look is `<Window kit>`.
 */

/** A measurement at a glance: its name, the number, a thin bar. Coloured only when it is worth a look. */
export function Meter({ label, meter, title }: { label: string; meter: MeterValue; title?: string }) {
  return (
    <div className={`k-meter ${meter.tone === 'calm' ? '' : `k-meter-${meter.tone}`}`} title={title} role="meter" aria-label={label} aria-valuenow={Math.round(meter.percent)} aria-valuemin={0} aria-valuemax={100} aria-valuetext={meter.value}>
      <div className="k-meter-top">
        <span>{label}</span>
        <b>{meter.value}</b>
      </div>
      <div className="k-meter-bar">
        <i style={{ width: `${meter.percent}%` }} />
      </div>
    </div>
  );
}

/** Who is there, as faces: the first few, and how many more. */
export function Faces({ people, max = 4 }: { people: Employee[]; max?: number }) {
  if (people.length === 0) return null;
  // One more face fits where "+1" would stand.
  const shown = people.length > max + 1 ? people.slice(0, max) : people;
  const names = people.map((e) => e.name).join(', ');
  return (
    <div className="k-faces" title={names} aria-label={`${people.length} employee${people.length === 1 ? '' : 's'}: ${names}`}>
      {shown.map((e) => (
        <Avatar key={e.id} appearance={e.appearance} size={24} />
      ))}
      {people.length > shown.length && <span className="k-faces-more">+{people.length - shown.length}</span>}
    </div>
  );
}

/** More, for whoever asks: a line that opens. It stays as the person left it. */
export function More({ summary, startOpen = false, children }: { summary: ReactNode; startOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <details className="k-more" open={open} onToggle={(ev) => setOpen(ev.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && children}
    </details>
  );
}
