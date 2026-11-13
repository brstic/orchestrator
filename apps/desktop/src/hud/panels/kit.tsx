import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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

/**
 * How somebody or something is: a dot and a word (`dot`: lit, a ring, orange, red). Without a dot it is the word
 * alone, at the end of a row. The colour is for when somebody is wanted.
 */
export function State({ word, dot, tone = 'calm', title, width }: { word: string; dot?: 'on' | 'off' | 'busy' | 'bad'; tone?: 'calm' | 'warn' | 'bad'; title?: string; width?: number }) {
  return (
    <span className={`k-state ${tone === 'calm' ? '' : `k-state-${tone}`}`} title={title} style={width ? { width, justifyContent: dot ? undefined : 'flex-end' } : undefined}>
      {dot && <i className={`k-dot ${dot === 'on' ? '' : `k-dot-${dot}`}`} aria-hidden />}
      {word}
    </span>
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

/** One thing that can be chosen: its name, and for whoever looks closer a picture before it and a word after it. */
export interface Choice {
  id: string;
  label: string;
  /** Said quietly after the name in the list: its state, whose it is. */
  hint?: string;
  /** A face, a dot of colour, a key — before the name. */
  lead?: ReactNode;
  /** More words the list is searched by. */
  also?: string;
  /** Worth a look where it is chosen (a chosen one that will not do what was meant). */
  warn?: string;
}

/**
 * Several of many (docs/UI.md, "Several of many"): what is chosen stands as small tags on one line, each taken off
 * with its ✕, and "Add" opens a short list of the rest — with a box to find one by a word when the list is long.
 * It takes one line whether there are three things to choose from or three hundred; a row of checkboxes grows with
 * every one there is.
 */
export function PickMany({ options, value, onChange, add = 'Add', none = 'None', name, disabled = false }: { options: Choice[]; value: string[]; onChange: (ids: string[]) => void; add?: string; none?: string; name?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [at, setAt] = useState(0);
  const [place, setPlace] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const find = useRef<HTMLInputElement>(null);
  const chosen = useMemo(() => value.map((id) => options.find((o) => o.id === id)).filter((o): o is Choice => !!o), [options, value]);
  const rest = useMemo(() => options.filter((o) => !value.includes(o.id)), [options, value]);
  const words = typed.trim().toLowerCase();
  const shown = useMemo(() => (words ? rest.filter((o) => `${o.label} ${o.hint ?? ''} ${o.also ?? ''}`.toLowerCase().includes(words)) : rest), [rest, words]);
  // (Fixed while the list is open: a box that goes away as the list gets shorter would move everything under the hand.)
  const [long, setLong] = useState(false);
  const close = () => {
    setOpen(false);
    setTyped('');
    setAt(0);
  };

  // The list hangs under its button (over it, where there is no room under), on top of everything — a window's own
  // scrolling body would cut it off. When what is under it scrolls, it goes along with its button; when the button
  // leaves the screen, it is put away.
  const locate = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r || r.bottom < 0 || r.top > window.innerHeight) return close();
    const width = Math.min(340, window.innerWidth - 24);
    const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
    const under = window.innerHeight - r.bottom - 14;
    const over = r.top - 14;
    setPlace(under >= 220 || under >= over ? { left, top: r.bottom + 6, width, maxHeight: Math.max(140, Math.min(320, under)) } : { left, bottom: window.innerHeight - r.top + 6, width, maxHeight: Math.max(140, Math.min(320, over)) });
  };
  useLayoutEffect(() => {
    if (open) locate();
    else setPlace(null);
  }, [open, value.length]);
  const placed = !!place;
  useEffect(() => {
    if (open && placed) (find.current ?? pop.current)?.focus();
  }, [open, placed]);
  useEffect(() => {
    if (!open) return;
    const away = (ev: Event) => {
      const t = ev.target as Node | null;
      if (t && (pop.current?.contains(t) || button.current?.contains(t))) return;
      close();
    };
    const moved = (ev: Event) => {
      if (ev.target instanceof Node && pop.current?.contains(ev.target)) return;
      locate();
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      // Nobody after this one hears the key. The window under the list listens for Escape on the same target, and
      // may have been put there after this listener (it is put again whenever its `onClose` changes); by the time
      // it runs the list is already gone from the page, so `data-esc-first` alone would not hold it back.
      ev.stopImmediatePropagation();
      close();
      button.current?.focus();
    };
    window.addEventListener('mousedown', away, true);
    window.addEventListener('scroll', moved, true);
    window.addEventListener('resize', moved);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('mousedown', away, true);
      window.removeEventListener('scroll', moved, true);
      window.removeEventListener('resize', moved);
      window.removeEventListener('keydown', key, true);
    };
  }, [open]);
  // Nothing is left to add: the list has no reason to stay.
  useEffect(() => {
    if (open && rest.length === 0) close();
  }, [open, rest.length]);

  const pick = (id: string) => {
    onChange([...value, id]);
    setTyped('');
    setAt((i) => Math.max(0, Math.min(i, shown.length - 2)));
    find.current?.focus();
  };
  const active = shown[Math.min(at, shown.length - 1)];

  return (
    <div className="k-many" data-pick-many={name}>
      {chosen.map((o) => (
        <span key={o.id} className={`k-tag ${o.warn ? 'k-tag-warn' : ''} ${o.lead ? 'k-tag-led' : ''}`} title={o.warn ?? o.hint} data-picked={o.id}>
          {o.lead}
          <span className="k-tag-name">{o.label}</span>
          {!disabled && (
            <button type="button" className="k-tag-off" aria-label={`Take ${o.label} off`} onClick={() => onChange(value.filter((x) => x !== o.id))}>
              ✕
            </button>
          )}
        </span>
      ))}
      {chosen.length === 0 && <span className="k-many-none">{none}</span>}
      {!disabled && rest.length > 0 && (
        <button
          ref={button}
          type="button"
          className={`k-many-add ${open ? 'k-many-add-on' : ''}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => {
            if (open) return close();
            setLong(rest.length > 7);
            setOpen(true);
          }}
          data-pick-add
        >
          + {add}
        </button>
      )}
      {open &&
        place &&
        createPortal(
          <div
            ref={pop}
            className="k-pop"
            style={{ left: place.left, top: place.top, bottom: place.bottom, width: place.width, maxHeight: place.maxHeight }}
            role="listbox"
            aria-label={add}
            tabIndex={-1}
            data-esc-first
            data-pick-list={name}
            onKeyDown={(ev) => {
              if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
                ev.preventDefault();
                setAt((i) => (shown.length ? (Math.min(i, shown.length - 1) + (ev.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length : 0));
              } else if (ev.key === 'Enter' && active) {
                ev.preventDefault();
                pick(active.id);
              }
              // The office's own keys (walking, its shortcuts) are not for a list that is being typed into.
              if (ev.key !== 'Escape') ev.stopPropagation();
            }}
          >
            {long && (
              <input
                ref={find}
                className="k-pop-find"
                value={typed}
                onChange={(ev) => {
                  setTyped(ev.target.value);
                  setAt(0);
                }}
                placeholder="Find…"
                aria-label="Find"
                spellCheck={false}
              />
            )}
            <div className="k-pop-list">
              {shown.map((o, i) => (
                <button key={o.id} type="button" role="option" aria-selected={active?.id === o.id} className={`k-pop-item ${active?.id === o.id ? 'k-pop-item-at' : ''}`} onMouseMove={() => at !== i && setAt(i)} onClick={() => pick(o.id)} data-pick-option={o.id}>
                  {o.lead}
                  <span className="k-pop-name">{o.label}</span>
                  {o.hint && <span className="k-pop-hint">{o.hint}</span>}
                </button>
              ))}
              {shown.length === 0 && <div className="k-pop-none">Nothing is called that.</div>}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * A few things that are each on or off, all of them in sight: a row of small buttons, the ones that are on lit.
 * For a short list that does not grow (what stands in a room); a list that grows is `PickMany`.
 */
export function Toggles({ options, value, onChange, name }: { options: Array<{ id: string; label: string; note?: string }>; value: string[]; onChange: (ids: string[]) => void; name?: string }) {
  return (
    <div className="k-many" role="group" data-toggles={name}>
      {options.map((o) => {
        const on = value.includes(o.id);
        return (
          <button key={o.id} type="button" className={`k-toggle ${on ? 'k-toggle-on' : ''}`} aria-pressed={on} title={o.note} onClick={() => onChange(options.filter((x) => (x.id === o.id ? !on : value.includes(x.id))).map((x) => x.id))} data-toggle={o.id}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
