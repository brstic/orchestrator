/**
 * A prompt that was typed into a session and never acknowledged is not left there. Seen on the live office on
 * 2026-11-12: a review was typed into a session two seconds after it had been started again; Claude Code took the
 * text into its input box when it was ready and never got the Enter. The office said "typed, waiting for Claude Code
 * to acknowledge" — for forty minutes, with the reviewer sitting in front of it and the reviewed task waiting.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let project = '';
let alex = '';
const task = async (id: string) => (await h.state()).tasks.find((t) => t.id === id)!;
const idle = () => waitFor(async () => (await h.session(alex))?.inTurn === false, { label: 'between turns', timeout: 20000 });

/** The next prompt typed to a session goes wrong on its way, once: `how` says in which way. */
function spoilNextPaste(how: 'no-enter' | 'lost'): { done: () => boolean } {
  const agents = h.server.engine.core.agents as any;
  const real = agents.rpc.bind(agents);
  let spoiled = false;
  agents.rpc = (hostId: string, rpc: any, ...rest: unknown[]) => {
    if (!spoiled && rpc?.method === 'session.paste' && rpc.params?.submit) {
      spoiled = true;
      agents.rpc = real;
      // Typed without its Enter — or not typed at all, though the machine said it was.
      return how === 'no-enter' ? real(hostId, { ...rpc, params: { ...rpc.params, submit: false } }, ...rest) : Promise.resolve({ ok: true, via: 'terminal' });
    }
    return real(hostId, rpc, ...rest);
  };
  return { done: () => spoiled };
}

before(async () => {
  h = await createHarness({ timings: { deliveryConfirmMs: 1500 } });
  project = (await h.project('Shop', h.makeRepo('shop'), { verifyCommand: null })).id;
  alex = (await h.employee('Alex', 'backend', { projectId: project, autonomy: 'auto' })).id;
  await h.api('POST', `/employees/${alex}/start`, {});
  await idle();
});
after(async () => {
  await h?.cleanup();
});

test('text that stands in the input box without its Enter is submitted by the office', async () => {
  const spoil = spoilNextPaste('no-enter');
  const t = await h.task({ projectId: project, title: 'Add the footer', assigneeId: alex, description: '@@fake: write footer.txt ok; commit footer; complete footer added@@' });
  await waitFor(() => spoil.done(), { label: 'the prompt was typed without Enter' });
  // It stands there, unacknowledged…
  await waitFor(async () => (await task(t.id)).delivery.status === 'sent', { label: 'typed, not acknowledged', timeout: 10000 });
  assert.equal((await task(t.id)).status, 'IN_PROGRESS');
  // …until the office looks at the terminal, finds it in the box, and presses Enter. Then it is done like any other.
  const done = await waitFor(async () => ((await task(t.id)).status === 'DONE' ? task(t.id) : null), { label: 'the task was taken and finished', timeout: 40000 }).catch(async (e) => {
    const eng = h.server.engine;
    const ses = eng.core.runningSessionOf(alex)!;
    const screen = eng.core.gateway.screens.get(ses.id);
    throw new Error(`${(e as Error).message} — session inTurn=${ses.inTurn} ${ses.activity}; delivery ${JSON.stringify((await task(t.id)).delivery)}; screen: ${screen ? JSON.stringify(screen.lines.slice(-6)) : 'none'}; pane: ${JSON.stringify(h.tmux('capture-pane', '-p', '-J', '-t', ses.tmuxPane!).split('\n').filter((l) => l.trim()).slice(-5))}`);
  });
  assert.equal(done.delivery.status, 'confirmed');
  const events = await h.api<any[]>('GET', `/events?taskId=${t.id}&limit=100`);
  assert.equal(events.filter((e) => e.type === 'terminal.resubmitted').length, 1, 'once');
  assert.equal(done.evidence.commits.length, 1, 'and the work was done once');
});

test('a prompt that never arrived is typed again', async () => {
  await idle();
  const spoil = spoilNextPaste('lost');
  const t = await h.task({ projectId: project, title: 'Add the header', assigneeId: alex, description: '@@fake: write header.txt ok; commit header; complete header added@@' });
  await waitFor(() => spoil.done(), { label: 'the prompt was lost' });
  const done = await waitFor(async () => ((await task(t.id)).status === 'DONE' ? task(t.id) : null), { label: 'the task was typed again and finished', timeout: 40000 });
  assert.equal(done.delivery.status, 'confirmed');
  assert.equal(done.evidence.commits.length, 1);
  assert.equal((await h.api<any[]>('GET', `/events?taskId=${t.id}&limit=100`)).filter((e) => e.type === 'terminal.resubmitted').length, 0, 'nothing stood in the box: it was typed, not submitted');
  assert.equal((await h.state()).notifications.filter((n) => /has not taken/.test(n.title)).length, 0);
});

test('"blocked" said outside any task stops asking for the owner once that employee is told something new', async () => {
  await idle();
  await h.api('POST', `/employees/${alex}/message`, { body: 'Check the server. @@fake: block The server does not answer@@' });
  const note = await waitFor(async () => (await h.state()).notifications.find((n) => n.kind === 'blocked' && n.employeeId === alex && !n.taskId && !n.resolvedAt), { label: 'the owner is told', timeout: 20000 });
  assert.match(note.title, /Alex is blocked/);
  await idle();
  // Somebody deals with it: the next thing said to Alex.
  await h.api('POST', `/employees/${alex}/message`, { body: 'It is up again, go on. @@fake: say going-on@@' });
  await waitFor(async () => !!(await h.state()).notifications.find((n) => n.id === note.id)?.resolvedAt, { label: 'no longer waiting for the owner', timeout: 20000 });
});
