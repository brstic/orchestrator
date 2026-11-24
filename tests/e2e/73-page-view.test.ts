/**
 * A page an employee made, shown as a page (`apps/server/src/page-view.ts`; the owner, 2026-11-24: "the accountant sent
 * me HTML — we need a way to see the HTML pages and the like that agents make"): the file given in the conversation is
 * served from a ticket, as HTML, in a sandbox of its own; a wrong ticket and a file that is no page are refused.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handleMcpPost } from '@orchestrator/integrations';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let kira: any;
let repo = '';

before(async () => {
  h = await createHarness();
  repo = h.makeRepo('books');
  kira = await h.api('POST', '/employees', { name: 'Kira', roleKey: 'docs', hostId: h.hostId, workingDir: repo });
});
after(async () => {
  await h.cleanup();
});

const give = async (file: string, body: string) => {
  fs.writeFileSync(path.join(repo, file), body);
  const eng = h.server.engine;
  const employee = eng.core.employees.require(kira.id);
  const session = eng.core.runningSessionOf(employee.id) ?? ({ id: `none-${employee.id}`, employeeId: employee.id, hostId: employee.hostId } as any);
  const res: any = await handleMcpPost({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'attach_file', arguments: { path: file, caption: 'for you' } } }, eng.mcp, { employee, session });
  assert.notEqual(res.body.result?.isError, true, JSON.stringify(res.body));
  const ev = await waitFor(async () => (await h.api<any[]>('GET', `/events?employeeId=${kira.id}&limit=50`)).find((e) => e.type === 'agent.file_given' && e.data.file?.name === file), { label: `${file} given` });
  return ev.data.file.id as string;
};

test('an HTML file given in the conversation opens as a page: from a ticket, as HTML, sandboxed', async () => {
  const id = await give('uplatnice.html', '<!doctype html><html><body><h1>Uplatnice</h1><script>document.body.dataset.ran = "yes"</script></body></html>');
  const t = await h.api<{ url: string; until: string }>('POST', `/employees/${kira.id}/files/${id}/page`, {});
  assert.match(t.url, /^\/view\/[A-Za-z0-9_-]{30,}\/uplatnice\.html$/);
  const r = await fetch(`${h.server.url}${t.url}`); // no token: the ticket is what lets it in
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /^text\/html/);
  const csp = r.headers.get('content-security-policy') ?? '';
  assert.match(csp, /^sandbox allow-scripts/, 'its own origin: it reaches nothing of the office');
  assert.doesNotMatch(csp, /allow-same-origin/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.match(await r.text(), /<h1>Uplatnice<\/h1>/);
  assert.equal((await fetch(`${h.server.url}/view/not-a-ticket/x.html`)).status, 404);
});

test('a file that is no page gets no ticket', async () => {
  const id = await give('notes.txt', 'plain');
  await assert.rejects(h.api('POST', `/employees/${kira.id}/files/${id}/page`, {}), /not a page/);
});
