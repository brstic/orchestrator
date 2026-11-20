import { useEffect, useMemo, useRef, useState } from 'react';
import type { Appearance, Employee, Task } from '@orchestrator/contracts';
import { Avatar } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';

/**
 * Whom a task is for, chosen by typing (the owner, 2026-11-20: "the assignee fields in tasks, everywhere — making,
 * editing, looking at a task — must be searchable; and a task must be assignable to an owner or a colleague, a real
 * person"). One field for all of it: an employee, or a person of the office (`Task.personId`), found by a few letters
 * of a name, a title or a role; arrows and Enter to choose, Escape to close.
 *
 * Values: '' nobody (or, in a filter, anyone); 'none' (a filter's "unassigned"); 'e:<employee id>'; 'p:<person id>'.
 */
export interface Person {
  id: string;
  name: string;
  owner: boolean;
}

let peopleCache: Person[] | null = null;
let peopleAsked: Promise<Person[]> | null = null;
/** The owners and colleagues a task can be for (`GET /people/assignable`), asked once and kept for the page. */
export function useAssignablePeople(): Person[] {
  const [people, setPeople] = useState<Person[]>(peopleCache ?? []);
  useEffect(() => {
    let gone = false;
    peopleAsked ??= api<Person[]>('GET', '/people/assignable')
      .then((p) => (peopleCache = p))
      .catch(() => {
        peopleAsked = null;
        return [];
      });
    void peopleAsked.then((p) => !gone && setPeople(p));
    return () => {
      gone = true;
    };
  }, []);
  return people;
}

export const valueOfTask = (t: Pick<Task, 'assigneeId' | 'personId'>): string => (t.personId ? `p:${t.personId}` : t.assigneeId ? `e:${t.assigneeId}` : '');
/** What a value means for a task: `{ assigneeId }` or `{ personId }` (the other one cleared). */
export function patchOf(value: string): { assigneeId: string | null; personId: string | null } {
  if (value.startsWith('p:')) return { assigneeId: null, personId: value.slice(2) };
  if (value.startsWith('e:')) return { assigneeId: value.slice(2), personId: null };
  return { assigneeId: null, personId: null };
}

interface Item {
  value: string;
  label: string;
  sub: string;
  group: 'none' | 'employee' | 'person';
  appearance?: Appearance;
}

/** A person's mark where an employee has a face: their initials. */
export function PersonMark({ name, size = 20 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <span className="ap-person-mark" style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }} aria-hidden>
      {initials || '?'}
    </span>
  );
}

/** Who a task is for, shown: an employee's face and name, or a person's initials and name. */
export function AssigneeLabel({ task, size = 18 }: { task: Pick<Task, 'assigneeId' | 'personId' | 'personName'>; size?: number }) {
  const e = useOffice((s) => (task.assigneeId ? s.employees[task.assigneeId] : undefined));
  if (task.personId)
    return (
      <span className="row" style={{ gap: 6, minWidth: 0 }} title="A person of the office: they are told in their Inbox and move it on themselves">
        <PersonMark name={task.personName ?? '?'} size={size} />
        <span className="truncate">{task.personName ?? 'a person'}</span>
      </span>
    );
  if (!e) return null;
  return (
    <span className="row" style={{ gap: 6, minWidth: 0 }}>
      <Avatar appearance={e.appearance} size={size} />
      <span className="truncate">{e.name}</span>
    </span>
  );
}

export function AssigneePicker({
  value,
  onChange,
  employees,
  none = 'Unassigned',
  filter = false,
  disabled,
  label = 'Assignee',
  people: withPeople = true,
}: {
  value: string;
  onChange: (value: string) => void;
  employees: Employee[];
  /** What "nobody" is called ('' value); in a filter, "Everyone". */
  none?: string;
  /** A filter: '' is anyone, and 'none' is "Unassigned". */
  filter?: boolean;
  disabled?: boolean;
  label?: string;
  people?: boolean;
}) {
  const people = useAssignablePeople();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const items = useMemo<Item[]>(
    () => [
      { value: '', label: none, sub: '', group: 'none' },
      ...(filter ? [{ value: 'none', label: 'Unassigned', sub: '', group: 'none' as const }] : []),
      ...employees.map((e) => ({ value: `e:${e.id}`, label: e.name, sub: e.title, group: 'employee' as const, appearance: e.appearance })),
      ...(withPeople ? people.map((p) => ({ value: `p:${p.id}`, label: p.name, sub: p.owner ? 'Owner' : 'Colleague', group: 'person' as const })) : []),
    ],
    [employees, people, none, filter, withPeople],
  );
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((i) => i.group !== 'none' && `${i.label} ${i.sub} ${i.group === 'person' ? 'person people human' : 'employee'}`.toLowerCase().includes(needle)) : items;
  const current = items.find((i) => i.value === value) ?? (value ? { value, label: 'Someone no longer here', sub: '', group: 'none' as const } : items[0]!);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  useEffect(() => setAt(0), [q, open]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-ap-i="${at}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const pick = (v: string) => {
    setOpen(false);
    setQ('');
    if (v !== value) onChange(v);
  };
  let lastGroup = '';
  return (
    <div className="ap" ref={box} data-assignee-picker>
      <button type="button" className="ap-button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        {current.appearance ? <Avatar appearance={current.appearance} size={18} /> : current.group === 'person' ? <PersonMark name={current.label} size={18} /> : null}
        <span className={`truncate ${current.group === 'none' ? 'muted' : ''}`}>{current.label}</span>
        <span className="ap-caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="ap-pop" role="dialog">
          <input
            className="ap-search"
            autoFocus
            placeholder="Search employees and people…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setAt((a) => Math.min(shown.length - 1, a + 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setAt((a) => Math.max(0, a - 1)));
              else if (e.key === 'Enter') {
                e.preventDefault();
                if (shown[at]) pick(shown[at]!.value);
              } else if (e.key === 'Escape') {
                e.stopPropagation();
                setOpen(false);
              }
            }}
            data-assignee-search
          />
          <div className="ap-list" role="listbox" ref={list}>
            {shown.length === 0 && <div className="ap-empty">Nobody by that name</div>}
            {shown.map((i, n) => {
              const head = i.group !== lastGroup && i.group !== 'none' ? (i.group === 'employee' ? 'Employees' : 'People') : null;
              lastGroup = i.group;
              return (
                <div key={i.value}>
                  {head && <div className="ap-group">{head}</div>}
                  <div
                    role="option"
                    aria-selected={i.value === value}
                    className={`ap-item ${n === at ? 'ap-at' : ''} ${i.value === value ? 'ap-on' : ''}`}
                    data-ap-i={n}
                    data-assignee-option={i.value}
                    onMouseEnter={() => setAt(n)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(i.value)}
                  >
                    {i.appearance ? <Avatar appearance={i.appearance} size={22} /> : i.group === 'person' ? <PersonMark name={i.label} size={22} /> : <span className="ap-none" />}
                    <span className="ap-text">
                      <span className="truncate">{i.label}</span>
                      {i.sub && <span className="ap-sub truncate">{i.sub}</span>}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
