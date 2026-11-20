import { useEffect, useState } from 'react';
import type { Employee, Host } from '@orchestrator/contracts';
import { Button, Field, Progress } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useAccess } from '../../lib/access.ts';
import { useOffice } from '../../lib/store.ts';
import { moveLine, movePercent } from '../../lib/move.ts';
import { act } from '../core.tsx';
import { FolderField } from './folder-picker.tsx';
import { DeskPicker } from './hire-where.tsx';

/** What the office answers when asked what a move would do (`Moves.plan`). */
interface MovePlan {
  why: string | null;
  kind: 'own' | 'copy' | 'back' | null;
  folder: string | null;
  name: string | null;
  projectName: string | null;
  backInto: string | null;
  released: Array<{ key: string; title: string }>;
  conversation: boolean;
  stopsSession: boolean;
  notes: string[];
}

/**
 * Moving an employee to another machine with their folder and conversation (`docs/MOVE.md`): in their profile's
 * Session tab. A move under way shows how far it is (in the office it stands over their head too); one that failed
 * says why, with *Try again*.
 */
export function MoveSection({ e }: { e: Employee }) {
  const hosts = useOffice((s) => s.hosts);
  const can = useAccess();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [parent, setParent] = useState('');
  /** The desk they sit at there (null: one is found for them — they never arrive without one). */
  const [deskId, setDeskId] = useState<string | null>(null);
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [busy, setBusy] = useState(false);
  const target = to ? hosts[to] : undefined;
  const m = e.moving;

  useEffect(() => {
    setPlan(null);
    setDeskId(null);
    if (!to) return;
    let gone = false;
    api<MovePlan>('POST', `/employees/${e.id}/move/plan`, { to })
      .then((p) => !gone && setPlan(p))
      .catch((err) => !gone && setPlan({ why: (err as Error).message, kind: null, folder: null, name: null, projectName: null, backInto: null, released: [], conversation: false, stopsSession: false, notes: [] }));
    return () => {
      gone = true;
    };
  }, [to, e.id, e.hostId]);

  if (!can.work(e.hostId) || e.archived || e.roleKey === 'foreman' || e.roleKey === 'lead' || e.selfDriven) return null;
  const toName = (id: string) => hosts[id]?.name ?? 'the other machine';

  if (m && m.phase !== 'failed') {
    return (
      <div className="k-stack" data-move-progress>
        <div className="k-label">Moving</div>
        <div className="k-text">{moveLine(m, toName(m.toHostId))}</div>
        <Progress value={movePercent(m) ?? 0} />
        <div className="k-sub">Nothing is started for them meanwhile. When it is done they sit at their new place and go on where they were.</div>
      </div>
    );
  }

  const choices = Object.values(hosts)
    .filter((h: Host) => h.id !== e.hostId && h.status !== 'revoked' && can.usable(h))
    .sort((a, b) => a.name.localeCompare(b.name));
  const start = async () => {
    setBusy(true);
    const ok = await act(() => api('POST', `/employees/${e.id}/move`, { to, parent: plan?.kind === 'back' ? null : parent.trim(), deskId }), `${e.name} is being moved to ${toName(to)}`);
    setBusy(false);
    if (ok !== undefined) setOpen(false);
  };

  return (
    <div className="k-stack" data-move>
      <div className="k-label">Machine</div>
      {m?.phase === 'failed' && (
        <div className="k-warn k-text" data-move-failed>
          {moveLine(m, toName(m.toHostId))}{' '}
          <Button small onClick={() => { setTo(m.toHostId); setOpen(true); }}>Try again</Button>{' '}
          <Button small variant="ghost" onClick={() => void act(() => api('POST', `/employees/${e.id}/move/dismiss`, {}), 'Put away')}>Dismiss</Button>
        </div>
      )}
      {!open ? (
        <div className="k-actions">
          <Button small onClick={() => setOpen(true)} disabled={!choices.length} title={choices.length ? undefined : 'There is no other machine you may put them on'} data-move-open>
            Move to another machine…
          </Button>
          <span className="k-sub">With their folder, its .md files, their conversation and its memory.</span>
        </div>
      ) : (
        <div className="k-stack" data-move-sheet>
          <Field label="To">
            <select value={to} onChange={(ev) => setTo(ev.target.value)} data-move-to>
              <option value="">Choose a machine…</option>
              {choices.map((h) => (
                <option key={h.id} value={h.id} disabled={h.status !== 'online' || !h.info?.moves}>
                  {h.name}
                  {h.memberName ? ` — ${h.memberName}'s` : ''}
                  {h.status !== 'online' ? ' (not connected)' : !h.info?.moves ? ' (its program is too old)' : ''}
                </option>
              ))}
            </select>
          </Field>
          {to && !plan && <div className="k-sub">Looking at what goes along…</div>}
          {plan?.why && <div className="k-warn k-text" data-move-why>{plan.why}</div>}
          {plan && !plan.why && (
            <>
              <div className="k-text" data-move-what>
                {plan.kind === 'back'
                  ? `${e.name} goes back into ${plan.backInto} on ${toName(to)}, with their conversation.`
                  : plan.kind === 'copy'
                    ? `${e.name} takes a copy of ${plan.projectName} (every branch, its .md files) and ${plan.conversation ? 'their conversation' : 'nothing else'} to ${toName(to)}.`
                    : `${e.name} takes their folder${plan.folder ? ` (${plan.folder})` : ''} — git history, .md files, everything but what an install makes again — ${plan.conversation ? 'and their conversation with its memory ' : ''}to ${toName(to)}.`}
                {plan.stopsSession ? ' Their session is stopped first and continues there.' : ''}
              </div>
              {plan.notes.length > 0 && (
                <ul className="k-sub" style={{ margin: 0, paddingLeft: 18 }}>
                  {plan.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              )}
              {target && (
                <Field label={target.memberId ? `Their seat in ${target.memberName ?? 'that member'}'s room` : 'Their desk in the office'} hint="Where they sit down when they get there. Automatic: a free seat of the room, or a free desk near their project's people — never none.">
                  <div data-move-desk>
                    <DeskPicker place={{ host: target, mine: !!target.memberId, problem: null }} value={deskId} onChange={setDeskId} room={target.memberId && target.memberId !== can.me?.id ? `${target.memberName ?? 'that member'}'s room` : 'your room'} />
                  </div>
                </Field>
              )}
              {plan.kind !== 'back' && (
                <Field label={`Put the folder inside, on ${toName(to)}`} hint={`A new folder "${plan.name}" is made there (or "${plan.name}-2" if that name is taken).`}>
                  <FolderField value={parent} onChange={setParent} host={target} placeholder="/path/to/a/folder" />
                </Field>
              )}
            </>
          )}
          <div className="k-actions">
            <Button variant="primary" small disabled={busy || !plan || !!plan.why || (plan.kind !== 'back' && !parent.trim())} onClick={() => void start()} data-move-go>
              Move {e.name}
            </Button>
            <Button small variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
