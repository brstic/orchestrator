import { useEffect, useState } from 'react';
import { Button } from '@orchestrator/ui';
import { api } from '../../lib/api.ts';
import { useOffice } from '../../lib/store.ts';

interface Candidate {
  command: string;
  why: string;
  kind: 'tests' | 'types' | 'lint';
}
interface Tried {
  command: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

const seconds = (ms: number) => (ms < 1000 ? '<1 s' : `${Math.round(ms / 1000)} s`);

/**
 * Beside a project's verification command (owners): what its repository offers as checks (`GET /projects/:id/checks`),
 * one click puts one in the field; and *Try*, which runs what is in the field once where the project's work is and says
 * in one line whether it passed (`POST /projects/:id/checks/try`) — so a command is set knowing it works.
 */
export function CheckFinder({ projectId, value, onPick }: { projectId: string; value: string; onPick: (command: string) => void }) {
  const owner = useOffice((s) => s.me?.role === 'owner');
  const [found, setFound] = useState<Candidate[] | null>(null);
  const [tried, setTried] = useState<Tried | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!owner) return;
    let gone = false;
    setFound(null);
    api<{ candidates: Candidate[] }>('GET', `/projects/${projectId}/checks`)
      .then((r) => !gone && setFound(r.candidates))
      .catch(() => !gone && setFound([]));
    return () => {
      gone = true;
    };
  }, [projectId, owner]);
  useEffect(() => setTried(null), [value]);
  if (!owner) return null;
  const tryIt = async () => {
    setBusy(true);
    setError(null);
    try {
      setTried(await api<Tried>('POST', `/projects/${projectId}/checks/try`, { command: value }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const others = (found ?? []).filter((c) => c.command !== value.trim());
  return (
    <div className="check-finder" data-check-finder>
      {others.length > 0 && (
        <div className="check-finder-row">
          <span className="small faint">Found</span>
          {others.slice(0, 4).map((c) => (
            <button key={c.command} type="button" className="check-chip mono" title={`From ${c.why} (${c.kind}). Click to use it.`} onClick={() => onPick(c.command)} data-check-candidate={c.command}>
              {c.command}
            </button>
          ))}
        </div>
      )}
      <div className="check-finder-row">
        <Button small variant="ghost" type="button" disabled={busy || !value.trim()} onClick={() => void tryIt()} title="Run it once where the project's work is, and see whether it passes" data-check-try>
          {busy ? 'Trying…' : 'Try'}
        </Button>
        {tried && (
          <span className={`small ${tried.passed ? 'check-ok' : 'check-bad'}`} data-check-result={tried.passed ? 'passed' : 'failed'}>
            {tried.passed ? `✓ passed in ${seconds(tried.durationMs)}` : tried.timedOut ? `✗ timed out after ${seconds(tried.durationMs)}` : `✗ failed (exit ${tried.exitCode ?? '?'})`}
          </span>
        )}
        {error && <span className="small check-bad">{error}</span>}
      </div>
      {tried && !tried.passed && tried.outputTail && (
        <details className="check-output">
          <summary className="small faint">Output</summary>
          <pre className="mono small">{tried.outputTail}</pre>
        </details>
      )}
    </div>
  );
}
