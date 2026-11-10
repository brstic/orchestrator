import { useMemo, useState } from 'react';
import type { Employee } from '@orchestrator/contracts';
import { ACTIVITY_LABEL } from '@orchestrator/contracts';
import { Avatar, Badge, Button, Empty, Window } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { sessionOfEmployee, useOffice } from '../../lib/store.ts';
import { act } from '../core.tsx';
import { registerPanel } from './index.tsx';
import { BulkHire } from './bulk-hire.tsx';
import { OutsideTmux } from './ssh-links.tsx';

/**
 * A member's own corner of the office: the sessions that run on their own computer. While they are
 * here their computer is one of the office's machines and their employees sit in their room; when
 * they leave, the room goes with them and the sessions wait in tmux on their computer.
 */
function MyRoomPanel({ onClose }: { arg: string | null; onClose: () => void }) {
  const me = useOffice((s) => s.me);
  const hosts = useOffice((s) => s.hosts);
  const employees = useOffice((s) => s.employees);
  const sessions = useOffice((s) => s.sessions);
  const myHost = useOffice((s) => s.myHost);
  const [adding, setAdding] = useState(false);
  // This computer, as the office knows it: the host the desktop app started, else any of mine that is online.
  const mine = useMemo(() => Object.values(hosts).filter((h) => !!me?.id && h.memberId === me.id && h.status !== 'revoked'), [hosts, me?.id]);
  const host = mine.find((h) => h.id === myHost.hostId) ?? mine.find((h) => h.status === 'online') ?? null;
  const online = host?.status === 'online';
  const people = useMemo(
    () =>
      Object.values(employees)
        .filter((e) => !e.archived && mine.some((h) => h.id === e.hostId))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [employees, mine],
  );
  const elsewhere = people.filter((e) => e.hostId !== host?.id);

  const status = online ? (
    <Badge tone="good">this computer is in the office</Badge>
  ) : myHost.state === 'starting' ? (
    <Badge tone="info">connecting this computer…</Badge>
  ) : (
    <Badge tone="muted">this computer is not in the office</Badge>
  );
  const start = (e: Employee) => act(() => api('POST', `/employees/${e.id}/start`, {}), `${e.name} is starting on your computer`);

  return (
    <Window title="My room" subtitle={`${me?.name ?? 'You'} · sessions on your own computer`} onClose={onClose} width={adding ? 1040 : 760}>
      <div className="col" style={{ gap: 14 }}>
        <div className="card col" style={{ gap: 6 }}>
          <div className="row">
            <span className="strong grow">{host?.name ?? 'Your computer'}</span>
            {status}
          </div>
          <div className="small muted">
            What runs here is yours: your folders, your Claude account, your terminals. The others see that your employees are there and what state they are in; only you and the owners of the office can open their terminals or talk to them.
            When you leave the office your room goes with you; the sessions keep running in tmux on this computer and are back when you return.
          </div>
          {!online && myHost.state === 'unavailable' && <div className="small bad">{myHost.reason}</div>}
          {!online && myHost.state === 'none' && <div className="small muted">Open this office with the Orchestrator desktop app to bring your computer in: a browser tab cannot run sessions.</div>}
        </div>

        {adding && host && online ? (
          <div className="card">
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="section-title grow" style={{ margin: 0 }}>
                Add folders from this computer
              </span>
              <Button small variant="ghost" onClick={() => setAdding(false)}>
                Back
              </Button>
            </div>
            <BulkHire onlyHostId={host.id} onDone={() => setAdding(false)} />
          </div>
        ) : (
          <>
            <div>
              <div className="row" style={{ marginBottom: 6 }}>
                <span className="section-title grow" style={{ margin: 0 }}>
                  In my room ({people.length})
                </span>
                <Button small variant="primary" disabled={!online} title={online ? undefined : 'Your computer is not connected to the office right now'} onClick={() => setAdding(true)}>
                  Add folders…
                </Button>
              </div>
              {people.length === 0 && <Empty title="Nobody yet">Add a folder from this computer: one employee is hired for it and works there, on your machine.</Empty>}
              <div className="list">
                {people.map((e) => {
                  const s = sessionOfEmployee(sessions, e.id);
                  const live = s?.status === 'running';
                  return (
                    <div key={e.id} className="row my-room-row" style={{ padding: '6px 0', gap: 10 }}>
                      <Avatar appearance={e.appearance} size={30} />
                      <button className="pc-rowbtn grow" style={{ textAlign: 'left' }} onClick={() => useOffice.getState().openPanel('employee', e.id)}>
                        <span className="strong">{e.name}</span> <span className="small muted">{e.title}</span>
                        <div className="small faint mono truncate">{e.workingDir ?? 'no folder'}</div>
                      </button>
                      <Badge tone={live ? 'good' : 'muted'}>{live ? (ACTIVITY_LABEL[s!.activity] ?? s!.activity) : e.hostId === host?.id && online ? 'not started' : 'computer away'}</Badge>
                      {live ? (
                        <Button small onClick={() => useOffice.getState().openPanel('talk', e.id)}>
                          Talk
                        </Button>
                      ) : (
                        <Button small disabled={!(e.hostId === host?.id && online)} onClick={() => void start(e)}>
                          Start
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
              {elsewhere.length > 0 && host && <div className="small faint">{elsewhere.length} of these live on another computer of yours and wait for it.</div>}
            </div>
            {host && online && (
              <div>
                <div className="section-title">Claude sessions already running on this computer</div>
                <OutsideTmux host={host} />
              </div>
            )}
          </>
        )}
      </div>
    </Window>
  );
}

registerPanel('myroom', MyRoomPanel);
