import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lastSaidIn, readLastSaid } from '../src/host.ts';

/** Records as Claude Code writes them to a transcript: one content block to a line. */
const prompt = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const says = (text: string, extra: object = {}) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, ...extra });
const thinks = () => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: 'x'.repeat(400) }] } });
const runs = (command: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command } }] } });
const result = (out: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: out }] } });

test('what the agent last wrote: the sentence above the tool it is running, and only of this turn', () => {
  const turn = [prompt('fix it'), thinks(), says('**Fix committed** and pushed as `038a39b` (276 of 276). Deploying it to dev.\n\nMore below.'), runs('git push')];
  assert.equal(lastSaidIn(turn), 'Fix committed and pushed as 038a39b (276 of 276). Deploying it to dev.');
  // Through the tools since: the sentence stands until the next one.
  assert.equal(lastSaidIn([...turn, result('ok'), thinks(), runs('npm test')]), 'Fix committed and pushed as 038a39b (276 of 276). Deploying it to dev.');
  assert.equal(lastSaidIn([...turn, result('ok'), says('- Now verifying 26 keywords'), runs('curl x')]), 'Now verifying 26 keywords');
  // A new turn that has said nothing yet: not the answer of the turn before.
  assert.equal(lastSaidIn([...turn, result('ok'), says('All done.'), prompt('and the docs?'), thinks(), runs('ls')]), null);
  // A subagent's words are not theirs; lines that are not records are passed over; long ones are cut.
  assert.equal(lastSaidIn([prompt('go'), says('Mine.'), says('The subagent speaks.', { isSidechain: true }), 'half a rec', '', runs('ls')]), 'Mine.');
  assert.equal(lastSaidIn([prompt('go'), says('x'.repeat(400))])!.length, 240);
  assert.equal(lastSaidIn([]), null);
});

test('only the end of the file is read, and a file that is not there says nothing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orch-said-'));
  const file = path.join(dir, 't.jsonl');
  const old = Array.from({ length: 400 }, (_x, i) => says(`Old line ${i} ${'pad '.repeat(60)}`));
  await fs.writeFile(file, [prompt('start'), ...old, says('Applying the patch on dev.'), runs('git apply')].join('\n') + '\n');
  assert.ok((await fs.stat(file)).size > 96 * 1024);
  assert.equal(await readLastSaid(file), 'Applying the patch on dev.');
  // A window so small that it starts inside the last record: nothing whole to read, so nothing.
  assert.equal(await readLastSaid(file, 40), null);
  assert.equal(await readLastSaid(path.join(dir, 'missing.jsonl')), null);
  await fs.rm(dir, { recursive: true, force: true });
});
