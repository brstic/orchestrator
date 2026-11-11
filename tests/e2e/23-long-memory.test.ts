/**
 * The office's long memory, end to end: a real server, a real host agent, real tmux sessions, a scripted worker —
 * and a stand-in for the MemPalace program (`tests/fixtures/fake-mempalace.mjs`: the same commands and the same
 * output; it compares words, not meaning). What the real MemPalace does with the same calls was tried by hand on
 * the office's server and is written down in docs/STATUS.md.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness, waitFor, type Harness } from './harness.ts';

let h: Harness;
let projectId = '';
const ids: Record<string, string> = {};
let palace = '';

const events = (query: string) => h.api<any[]>('GET', `/events?limit=1500&${query}`);
const atPrompt = (who: string) =>
  waitFor(async () => {
    const s = await h.session(ids[who]!);
    return s?.status === 'running' && s.inTurn === false ? s : null;
  }, { label: `${who} at the prompt`, timeout: 40000 });
const turnEnded = (who: string, said: RegExp) => waitFor(async () => ((await events(`employeeId=${ids[who]}`)).some((e) => e.type === 'agent.turn_finished' && said.test(e.data.lastMessage ?? '')) ? true : null), { label: `${who}: ${said}`, timeout: 40000 });
const call = async (who: string, tool: string, args: Record<string, unknown>, tag: string) => {
  const cwd = (await atPrompt(who)).cwd;
  await h.api('POST', `/employees/${ids[who]}/message`, { body: `Do this. @@fake: mcp ${tool} ${JSON.stringify(args)}; result ${tag}.txt; say ${tag}-done@@` });
  await turnEnded(who, new RegExp(`${tag}-done`));
  return fs.readFileSync(path.join(cwd, `${tag}.txt`), 'utf8').trim();
};
const filed = () => (fs.existsSync(path.join(palace, 'fake-index.json')) ? (JSON.parse(fs.readFileSync(path.join(palace, 'fake-index.json'), 'utf8')) as Array<{ room: string; source: string; text: string }>) : []);
const done = (id: string) => waitFor(async () => ((await h.getTask(id)).status === 'DONE' ? true : null), { label: 'task done', timeout: 60000 });

before(async () => {
  // The stand-in, as a program on disk the way the real one is.
  const dir = fs.mkdtempSync('/tmp/orch-fake-mp-');
  const bin = path.join(dir, 'mempalace');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL('../fixtures/fake-mempalace.mjs', import.meta.url))}" "$@"\n`, { mode: 0o755 });
  h = await createHarness({ memoryBin: bin, timings: { memoryMineDelayMs: 300, memoryRecallMs: 5000 } });
  palace = path.join(h.tmp, 'server', 'palace', 'palace');
  projectId = (await h.project('Shop', h.makeRepo('shop'), { verifyCommand: 'npm test --silent' })).id;
  for (const [name, role] of [['Alex', 'backend'], ['Sarah', 'frontend']] as const) ids[name] = (await h.employee(name, role, { projectId, autonomy: 'autonomous' })).id;
});
after(async () => {
  await h?.cleanup();
});

test('where MemPalace is installed the office says so, and sets its palace up once', async () => {
  const st = await waitFor(async () => ((await h.api<any>('GET', '/memory')).available ? h.api<any>('GET', '/memory') : null), { label: 'the memory ready' });
  assert.deepEqual([st.available, st.version, st.filed, st.lastError], [true, '9.9.9', 0, null]);
  const records = path.join(h.tmp, 'server', 'palace', 'records');
  assert.deepEqual(new Set(fs.readdirSync(records)), new Set(['answers', 'blockers', 'lessons', 'meetings', 'notes', 'tasks', 'mempalace.yaml']));
});

test('what happens is filed by itself: a finished task with how it went, the boss\'s answer, a resolved blocker, a lesson', async () => {
  const t = await h.task({ projectId, title: 'Limit login attempts', assigneeId: ids.Alex, acceptance: 'Six tries in a minute are refused.', description: 'Add a rate limit to the login form. @@fake: ask How many attempts per minute; write limit.txt five; commit rate limit; complete five per minute with a one minute wait@@' });
  const q = await waitFor(() => h.openQuestion(ids.Alex!), { label: 'the question' });
  await h.api('POST', `/questions/${q.id}/answer`, { answer: 'Five per minute per address, then a one minute wait. Never lock the account.' });
  await done(t.id);
  await h.api('POST', '/lessons', { scope: 'project', projectId, text: 'Rate limits are per address, never per account.', appliesWhen: 'adding a limit to anything a visitor can call' });
  const blocked = await h.task({ projectId, title: 'Send the reset mail', assigneeId: ids.Sarah, description: '@@fake: block There is no mail server to send through@@' });
  await waitFor(async () => ((await h.getTask(blocked.id)).status === 'BLOCKED' ? true : null), { label: 'blocked', timeout: 40000 });
  await h.api('POST', `/tasks/${blocked.id}/unblock`, { note: 'Use the sandbox mailer on port 2525; real mail comes later.' });

  // (Five: the boss's answer is also kept as a lesson by the office, as before, and a lesson in use is a record too.)
  const all = await waitFor(async () => (filed().filter((d) => d.source !== 'README.md').length >= 5 ? filed() : null), { label: 'the records filed', timeout: 20000 });
  const by = (room: string) => all.filter((d) => d.room === room && d.source !== 'README.md').map((d) => d.text);
  assert.match(by('tasks')[0]!, /^# T-1 Limit login attempts \(Shop\) — done by Alex on \d{4}-\d\d-\d\d\n\nWhat was asked:\nAdd a rate limit to the login form\.[\s\S]*Acceptance criteria:\nSix tries in a minute are refused\.[\s\S]*What Alex reported:\nfive per minute with a one minute wait[\s\S]*Verified by: npm test --silent — passed/);
  assert.match(by('answers')[0]!, /^# The boss answered Alex \(Shop, T-1\): How many attempts per minute\n\nQuestion: How many attempts per minute[\s\S]*Answer: Five per minute per address, then a one minute wait\. Never lock the account\./);
  assert.match(by('lessons').find((x) => /never per account/.test(x))!, /^# A lesson for Shop: Rate limits are per address, never per account\.[\s\S]*Applies when: adding a limit to anything a visitor can call/);
  assert.match(by('blockers')[0]!, /was blocked, and how it was resolved\n\nBlocked on: There is no mail server to send through\n\nResolved by the boss on \d{4}-\d\d-\d\d: Use the sandbox mailer on port 2525/);
  // The scripted worker's instructions are part of the description here; nothing else of the session is in the record.
  assert.equal((await h.api<any>('GET', '/memory')).filed >= 4, true);
  // Filed once: the same task saved again (its record changes as the office goes on) is not written a second time.
  const before = filed().length;
  await h.api('PATCH', `/tasks/${t.id}`, { priority: 'high' });
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(filed().length, before);
});

test('an employee asks the memory in plain words and gets what bears on the question; and writes down what should outlive the session', async () => {
  const got = await call('Sarah', 'recall', { query: 'how many login attempts per minute are allowed' }, 'recall');
  assert.match(got, /^From the office's memory, closest first\./);
  assert.match(got, /\d\. \(answers, match [\d.]+\)\n# The boss answered Alex[\s\S]*Never lock the account\./);
  assert.match(got, /1\. \(tasks, match [\d.]+\)\n# T-1 Limit login attempts \(Shop\) — done by Alex/, 'the closest first');
  assert.match(await call('Sarah', 'recall', { query: 'kubernetes ingress certificates' }, 'nothing'), /^Nothing in the office's memory is close to that\./);
  assert.match(await call('Sarah', 'remember', { note: 'too short' }, 'short'), /^ERROR Write the note so that it can be understood/);
  const kept = await call('Sarah', 'remember', { about: 'reset mail', note: 'The reset mail goes through the sandbox mailer until the real provider is chosen. The template lives in mail/reset.html and must keep the unsubscribe footer.' }, 'note');
  assert.match(kept, /^Written down\. It can be found with recall/);
  await waitFor(async () => (filed().some((d) => d.room === 'notes' && /unsubscribe footer/.test(d.text)) ? true : null), { label: 'the note filed', timeout: 15000 });
  assert.match(filed().find((d) => d.room === 'notes' && d.source !== 'README.md')!.text, /^# Sarah's note \(Shop\), \d{4}-\d\d-\d\d: reset mail\n\nThe reset mail goes through the sandbox mailer/);
  // (Asked from Sarah's own folder: a file the scripted worker leaves in Alex's would keep him from being given his next task.)
  assert.match(await call('Sarah', 'recall', { query: 'where does the reset mail template live and what must it keep' }, 'recall2'), /Sarah's note \(Shop\)[\s\S]*unsubscribe footer/);
});

test('a task is handed over with what the office already knows about its subject', async () => {
  await atPrompt('Alex');
  // (The scripted worker's instructions go into the acceptance criteria here, so that what is looked up is the subject alone.)
  const t = await h.task({ projectId, title: 'Reset mail template: keep the unsubscribe footer', assigneeId: ids.Alex, description: 'The reset mail template must keep its unsubscribe footer.', acceptance: "@@fake: saw From the office's memory; saw sandbox mailer; write footer.txt ok; commit footer; complete done@@" });
  await done(t.id);
  // What the worker was really handed (the scripted worker says whether a text was in its prompt).
  const pane = h.tmux('capture-pane', '-p', '-J', '-S', '-200', '-t', (await h.session(ids.Alex!))!.tmuxPane!);
  assert.match(pane, /saw\[From the office's memory\]=yes/);
  assert.match(pane, /saw\[sandbox mailer\]=yes/, "Sarah's note on the same subject came with it");
});

test('only one MemPalace process runs at a time, and a credential never reaches the memory', async () => {
  // Several questions at once: the calls are made one after another.
  await Promise.all(['login attempts', 'reset mail', 'rate limit address', 'sandbox mailer'].map((query) => h.api('POST', '/memory/recall', { query })));
  const calls = fs.readFileSync(path.join(palace, 'calls.log'), 'utf8').trim().split('\n').map((l) => l.split(' ').slice(1).join(' '));
  let open = 0;
  for (const c of calls) {
    if (c.startsWith('start')) open++;
    else open--;
    assert.ok(open <= 1, `two at once: ${calls.join(' | ')}`);
  }
  const token = `ghp_${'m3M0'.repeat(9)}`;
  await call('Sarah', 'remember', { about: 'deploy', note: `Deploys push with the token ${token} from the CI account, never from a laptop.` }, 'secret');
  await waitFor(async () => (filed().some((d) => /never from a laptop/.test(d.text)) ? true : null), { label: 'filed', timeout: 15000 });
  const text = filed().find((d) => /never from a laptop/.test(d.text))!.text;
  assert.ok(!text.includes(token), 'the value is not in the memory');
  assert.match(text, /push with the token \{\{vault:github-token\}\} from the CI account/);
});

test('switched off by the owner, nothing is filed or recalled, and the tools are gone', async () => {
  await h.api('PATCH', '/settings', { longMemory: false });
  assert.equal((await h.api<any>('GET', '/memory')).available, false);
  const before = filed().length;
  const t = await h.task({ projectId, title: 'Not remembered', assigneeId: ids.Alex, description: '@@fake: write n.txt x; commit n; complete nothing to see@@' });
  await done(t.id);
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(filed().length, before);
  assert.match(await call('Sarah', 'recall', { query: 'login attempts per minute' }, 'off'), /^ERROR This office has no long memory/);
  await h.api('PATCH', '/settings', { longMemory: true });
});
