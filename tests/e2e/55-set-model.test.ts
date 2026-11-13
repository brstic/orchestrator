/**
 * Employees set what they and their colleagues think with (the owner, 2026-11-13: "so that e.g. the project manager
 * can put the others on a cheaper model when the work does not need the most expensive"): the `set_model` tool —
 * model and effort, with a reason on the record; a running session is started again with the same conversation.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpPost } from '@orchestrator/integrations';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
const ids: Record<string, string> = {};
const tool = async (who: string, name: string, args: Record<string, unknown> = {}) => {
  const eng = h.server.engine;
  const employee = eng.core.employees.require(ids[who]!);
  const session = eng.core.runningSessionOf(employee.id) ?? eng.core.sessionOf(employee.id) ?? ({ id: `none-${employee.id}`, employeeId: employee.id, hostId: employee.hostId } as any);
  const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, eng.mcp, { employee, session });
  return { text: String(res.body.result?.content?.[0]?.text ?? JSON.stringify(res.body)), isError: res.body.result?.isError === true };
};
const emp = async (name: string) => (await h.state()).employees.find((e) => e.id === ids[name])!;

before(async () => {
  h = await createHarness();
  const project = (await h.project('Shop', h.makeRepo('shop'))).id;
  ids.Pat = (await h.employee('Pat', 'pm', { projectId: project, autonomy: 'auto' })).id;
  ids.Alex = (await h.employee('Alex', 'backend', { projectId: project, autonomy: 'auto', model: 'fable', effort: 'high' })).id;
  ids.Mira = (await h.employee('Mira', 'foreman', {})).id;
});
after(async () => {
  await h?.cleanup();
});

test('the project manager puts a colleague on a lighter model and less effort; it is on the record and the colleague is told why', async () => {
  // What everybody thinks with is in get_team.
  assert.match((await tool('Pat', 'get_team')).text, /- Alex — .* thinks with fable, high effort/);
  await h.api('POST', `/employees/${ids.Alex}/start`, {});
  await waitFor(async () => { const s = await h.session(ids.Alex!); return s?.status === 'running' && s.inTurn === false ? s : null; }, { label: 'Alex is up', timeout: 30000 });
  const res = await tool('Pat', 'set_model', { employee: 'Alex', model: 'sonnet', effort: 'medium', reason: 'Copy changes on the landing page do not need Fable.' });
  assert.equal(res.isError, false, res.text);
  assert.match(res.text, /Alex is on Sonnet, medium effort now \(was Fable, high effort\)\. Their session is started again with the same conversation now\./);
  assert.deepEqual([(await emp('Alex')).model, (await emp('Alex')).effort], ['sonnet', 'medium']);
  const s = await waitFor(async () => { const x = await h.session(ids.Alex!); return x?.status === 'running' && x.model === 'sonnet' ? x : null; }, { label: 'started again on Sonnet', timeout: 30000 });
  assert.equal(s.resumed, true);
  const audit = await h.api<any[]>('GET', '/audit');
  assert.ok(audit.some((a) => a.action === 'employee.model_set' && a.actor === 'employee:Pat' && a.detail.employee === 'Alex' && /Fable/.test(a.detail.reason)));
  assert.ok((await h.state()).messages.some((m) => m.toEmployeeId === ids.Alex && /^I put you on Sonnet, medium effort \(it was Fable, high effort\): Copy changes/.test(m.body)));
  // Back to the account's default, by name.
  assert.match((await tool('Alex', 'set_model', { model: 'default', effort: 'default', reason: 'The next task is the hard one.' })).text, /^You are on the account's default model, the default effort now/);
  assert.deepEqual([(await emp('Alex')).model, (await emp('Alex')).effort], [null, null]);
});

test('what is refused: not a model of the list, not the foreman, no reason, nothing to change — and not at all when the owner says so', async () => {
  for (const [args, said] of [
    [{ employee: 'Alex', model: 'gpt-5', reason: 'Because it is cheaper.' }, /is not a model to choose/],
    [{ employee: 'Alex', effort: 'extreme', reason: 'Because it is cheaper.' }, /is not an effort/],
    [{ employee: 'Mira', model: 'haiku', reason: 'Because it is cheaper.' }, /foreman: what it thinks with is the owner's/],
    [{ employee: 'Alex', model: 'haiku', reason: 'cheap' }, /Say in "reason" why/],
    [{ employee: 'Alex', reason: 'Nothing to change at all.' }, /Say the model, the effort, or both/],
    [{ employee: 'Nobody', model: 'haiku', reason: 'Because it is cheaper.' }, /No teammate matches/],
  ] as const) {
    const res = await tool('Pat', 'set_model', args as any);
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.match(res.text, said);
  }
  // Not the level: the tool has no such field, and a level given anyway changes nothing.
  await tool('Pat', 'set_model', { employee: 'Alex', model: 'haiku', reason: 'Small fixes only today.', autonomy: 'unrestricted' } as any);
  assert.equal((await emp('Alex')).autonomy, 'auto');
  await h.api('PATCH', '/settings', { employeesSetModels: false });
  const off = await tool('Pat', 'set_model', { employee: 'Alex', model: 'opus', reason: 'Because it is needed now.' });
  assert.equal(off.isError, true);
  assert.match(off.text, /The owner keeps models and effort to themselves/);
  assert.equal((await emp('Alex')).model, 'haiku');
});
