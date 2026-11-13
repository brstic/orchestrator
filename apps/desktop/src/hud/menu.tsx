import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ABOUT, matches } from '../lib/menu.ts';
import type { PanelId } from '../lib/store.ts';

/**
 * The office's menu (docs/UI.md, "The menu"): every window there is, each with a small picture, its name and one
 * line that says what it is for — so that nobody has to open a window to learn what it is. Two columns, so it is
 * wide and not long; a box at the top finds a window by a word of its name or of what it is for.
 */

export interface MenuItem {
  id: PanelId;
  label: string;
  /** The key that opens it from the office, when it has one. */
  k?: string;
  count?: number;
  /** The count is of things that are stuck or wait for somebody (red), not merely a number (grey). */
  bad?: boolean;
}
export interface MenuGroup {
  title: string;
  items: MenuItem[];
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
/** The small pictures, drawn here: 24 by 24, one line weight. */
const ICONS: Partial<Record<PanelId, ReactNode>> = {
  mine: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8 1.4 0 2.6.5 3.6 1.3" />
      <path d="M15 16.5l2 2 3.5-4" />
    </>
  ),
  myroom: <path d="M4 11l8-6.5 8 6.5v8a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z" />,
  overview: (
    <>
      <rect x="5" y="3.5" width="14" height="17" rx="1.5" />
      <path d="M9 8h2M13 8h2M9 12h2M13 12h2M10.5 20.5v-4h3v4" />
    </>
  ),
  tasks: (
    <>
      <rect x="4" y="5" width="4.2" height="12" rx="1" />
      <rect x="9.9" y="5" width="4.2" height="7.5" rx="1" />
      <rect x="15.8" y="5" width="4.2" height="14" rx="1" />
    </>
  ),
  projects: <path d="M3.5 7.5a2 2 0 0 1 2-2H9l2 2.3h7.5a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  meetings: (
    <>
      <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h6A2.5 2.5 0 0 1 15 6.5v3.5a2.5 2.5 0 0 1-2.5 2.5H9l-3 2.5v-2.6A2.5 2.5 0 0 1 4 10z" />
      <path d="M17.5 9.5A2.5 2.5 0 0 1 20 12v3.3a2.5 2.5 0 0 1-2 2.4V20l-2.8-2.2H12" />
    </>
  ),
  reports: (
    <>
      <path d="M7 3.5h6.5L18 8v11.5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1z" />
      <path d="M13.5 3.5V8H18M9 12.5h6M9 16h4" />
    </>
  ),
  growth: (
    <>
      <path d="M12 7C10.4 5.7 8.3 5.3 4.5 5.3v12.4c3.800 0 5.900.4 7.500 1.700 1.600-1.300 3.700-1.700 7.500-1.700V5.300c-3.800 0-5.900.4-7.500 1.700z" />
      <path d="M12 7v12.300" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="8.300" r="3" />
      <path d="M3.500 19c.5-3 2.700-4.900 5.500-4.900s5 1.900 5.500 4.900" />
      <circle cx="17" cy="9.300" r="2.300" />
      <path d="M16.300 14.300c2.300.200 3.800 1.700 4.200 4.200" />
    </>
  ),
  people: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M11 12l8.500-8.500M16 7l2.500 2.500M13.500 9.500l2 2" />
    </>
  ),
  map: (
    <>
      <path d="M12 21s-6-5.500-6-10.300a6 6 0 1 1 12 0C18 15.500 12 21 12 21z" />
      <circle cx="12" cy="10.500" r="2.200" />
    </>
  ),
  office: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="1.500" />
      <path d="M4 10.500h7.500V20M11.500 4v3M14.500 14h5.500" />
    </>
  ),
  hosts: (
    <>
      <rect x="4" y="4.500" width="16" height="6.500" rx="1.500" />
      <rect x="4" y="13" width="16" height="6.500" rx="1.500" />
      <path d="M7.500 7.800h.01M7.500 16.300h.01M11 7.800h5.500M11 16.300h5.500" />
    </>
  ),
  wall: (
    <>
      <rect x="3.500" y="5" width="17" height="14" rx="2" />
      <path d="M7.500 10l3 2.300-3 2.300M12.500 15h4" />
    </>
  ),
  vault: (
    <>
      <rect x="5" y="10.500" width="14" height="9.500" rx="2" />
      <path d="M8.500 10.500V8a3.500 3.500 0 0 1 7 0v2.500M12 14.500v2" />
    </>
  ),
  radio: (
    <>
      <path d="M9 17.500V6l10-2v11.500" />
      <circle cx="6.500" cy="17.500" r="2.500" />
      <circle cx="16.500" cy="15.500" r="2.500" />
    </>
  ),
  tv: (
    <>
      <rect x="3.500" y="5" width="17" height="11.500" rx="2" />
      <path d="M8.500 20h7M12 16.500V20" />
    </>
  ),
  arcade: (
    <>
      <path d="M7.500 8h9a4.500 4.500 0 0 1 4.500 4.500v1a3.300 3.300 0 0 1-6 1.900L14.500 15h-5l-.5.400a3.300 3.300 0 0 1-6-1.900v-1A4.500 4.500 0 0 1 7.500 8z" />
      <path d="M7.500 10.800v2.700M6.200 12.200h2.700M15.800 11.300h.01M17.600 13h.01" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17.500 7H20M4 12h3M11.500 12H20M4 17h11M19.500 17h.5" />
      <circle cx="15.200" cy="7" r="2" />
      <circle cx="9.200" cy="12" r="2" />
      <circle cx="17.200" cy="17" r="2" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="8.500" />
      <path d="M9.700 9.600a2.400 2.400 0 1 1 3.500 2.100c-.800.500-1.200 1-1.200 1.900M12 16.800h.01" />
    </>
  ),
};

export function Icon({ id, size = 18 }: { id: PanelId; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...stroke} aria-hidden>
      {ICONS[id] ?? <circle cx="12" cy="12" r="3" />}
    </svg>
  );
}

/**
 * The menu itself. `groups` come in the order people look for things; the last group without a title (Settings,
 * Help) stands across the bottom. Up and down move through what is listed, Enter opens it.
 */
export function Menu({ groups, current, onPick }: { groups: MenuGroup[]; current: PanelId | null; onPick: (id: PanelId) => void }) {
  const [typed, setTyped] = useState('');
  const [at, setAt] = useState(0);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => box.current?.focus(), []);
  const shown = useMemo(() => groups.map((g) => ({ ...g, items: g.items.filter((i) => matches(i, typed)) })).filter((g) => g.items.length), [groups, typed]);
  const titled = shown.filter((g) => g.title);
  const foot = shown.filter((g) => !g.title).flatMap((g) => g.items);
  // Two columns of about the same length: the groups stay whole, in their order.
  const columns = useMemo(() => {
    const total = titled.reduce((n, g) => n + g.items.length + 1, 0);
    const left: MenuGroup[] = [];
    const right: MenuGroup[] = [];
    let n = 0;
    for (const g of titled) {
      (n + (g.items.length + 1) / 2 <= total / 2 || left.length === 0 ? left : right).push(g);
      n += g.items.length + 1;
    }
    return [left, right].filter((c) => c.length);
  }, [titled]);
  const flat = [...columns.flat().flatMap((g) => g.items), ...foot];
  const active = flat[Math.min(at, flat.length - 1)]?.id;

  const item = (n: MenuItem, small = false) => (
    <button key={n.id} role="menuitem" className={`mn-item ${small ? 'mn-item-sm' : ''} ${current === n.id ? 'mn-item-on' : ''} ${active === n.id && typed ? 'mn-item-at' : ''}`} onClick={() => onPick(n.id)} data-menu-item={n.id}>
      <span className="mn-icon">
        <Icon id={n.id} />
      </span>
      <span className="mn-words">
        <span className="mn-name">{n.label}</span>
        {!small && ABOUT[n.id] && <span className="mn-about">{ABOUT[n.id]}</span>}
      </span>
      {!!n.count && (
        <span className={`mn-count ${n.bad ? 'mn-count-bad' : ''}`} aria-label={`${n.count}`}>
          {n.count}
        </span>
      )}
      {n.k && <kbd className="kbd">{n.k}</kbd>}
    </button>
  );

  return (
    <div className="glass dock mn" role="menu" aria-label="Menu">
      <input
        ref={box}
        className="mn-find"
        value={typed}
        onChange={(ev) => {
          setTyped(ev.target.value);
          setAt(0);
        }}
        onKeyDown={(ev) => {
          if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
            ev.preventDefault();
            setAt((i) => (flat.length ? (i + (ev.key === 'ArrowDown' ? 1 : flat.length - 1)) % flat.length : 0));
          } else if (ev.key === 'Enter' && active) {
            ev.preventDefault();
            onPick(active);
          }
          // The office's own keys (walking, its shortcuts) are not for a box that is being typed into.
          if (ev.key !== 'Escape') ev.stopPropagation();
        }}
        placeholder="Find a window…"
        aria-label="Find a window"
        spellCheck={false}
      />
      {flat.length === 0 && <div className="mn-none">Nothing is called that. Try a word of what you want to do — "hire", "password", "radio".</div>}
      {columns.length > 0 && (
        <div className="mn-cols">
          {columns.map((col, i) => (
            <div key={i} className="mn-col">
              {col.map((g) => (
                <div key={g.title} className="mn-group" role="group" aria-label={g.title}>
                  <div className="mn-title">{g.title}</div>
                  {g.items.map((n) => item(n))}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {foot.length > 0 && <div className="mn-foot">{foot.map((n) => item(n, true))}</div>}
    </div>
  );
}
