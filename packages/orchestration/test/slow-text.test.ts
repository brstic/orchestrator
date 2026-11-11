/**
 * Readers of text that somebody else shapes — a session's command, a lesson it records, a question, a terminal's
 * screen, what a program printed — timed on text built to be slow for each. The office has one thread: a reader that
 * takes time with the square of a text's length stops everything for as long as one long text wants.
 * (The vault's detector, the high-risk list, the fence and the redaction have their own such tests beside them.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripEnd } from '@orchestrator/contracts';
import { deployCommand, isTestCommand, unquoted } from '../../integrations/src/hooks.ts';
import { inputToSendKeys } from '../../execution/src/tmux.ts';
import { permissionPrompt, plainScreen, trustPromptKeys } from '../src/comms.ts';
import { commandShape } from '../src/learning/autopilot.ts';
import { checkLesson, questionSimilarity, sameFriction, tokens } from '../src/learning/capture.ts';
import { distinctiveWords, environmentError } from '../src/learning/detect.ts';
import { pathsIn } from '../src/learning/playbook.ts';
import { parseSearch } from '../src/memory.ts';
import { detectSecrets } from '../src/vault-detect.ts';

const N = 200_000;
const timed = (what: string, run: () => unknown, limit = 1500) => {
  const t0 = process.hrtime.bigint();
  run();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < limit, `${what}: ${Math.round(ms)} ms`);
};

test('trimming the end of a text walks back from the end', () => {
  assert.equal(stripEnd('done...', '.'), 'done');
  assert.equal(stripEnd('a/b///', '/'), 'a/b');
  assert.equal(stripEnd('what?!', '.!?'), 'what');
  assert.equal(stripEnd('...', '.'), '');
  assert.equal(stripEnd('a.b', '.'), 'a.b');
  assert.equal(stripEnd('', '.'), '');
  timed('dots in the middle', () => stripEnd(`a${'.'.repeat(N)}a`, '.'));
});

test('a session\'s command, as every hook reads it: quotes, tests, deploys, its first word', () => {
  // What it must go on saying.
  assert.equal(unquoted('git commit -m "run npm test \\"now\\"" && echo \'npm test\''), 'git commit -m "" && echo \'\'');
  assert.equal(unquoted('echo "never closed'), 'echo "never closed');
  assert.equal(unquoted('echo "a" "b" "c'), 'echo "" "" "c');
  for (const c of ['a "b" c', '"\\\\" x "y"', 'x="a\\"b" y', "it's \"fine\" isn't", '"" "" ""', 'a\\"b "c"', '"unterminated \\" still']) {
    assert.equal(unquoted(c), c.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'[^']*'/g, "''"), c);
  }
  assert.equal(isTestCommand('cd app && npm test'), true);
  assert.equal(isTestCommand('git commit -m "fix npm test"'), false);
  for (const [command, what] of [
    ['git push origin v1.2.3', 'version tag'],
    ['git push --tags', 'version tag'],
    ['git tag -a v2.0 -m x', 'version tag'],
    ['git push origin main', 'git push'],
    ['cd x && gcloud run deploy api --region eu', 'cloud deploy'],
    ['aws s3 sync dist s3://bucket', 'cloud deploy'],
    ['aws --profile p lambda update-function-code --function-name f', 'cloud deploy'],
    ['az webapp deploy --name x', 'cloud deploy'],
    ['docker compose -f prod.yml up -d', 'compose up'],
    ['docker-compose up', 'compose up'],
    ['(gcloud app deploy)', 'cloud deploy'],
  ] as const) {
    assert.equal(deployCommand(command)?.what, what, command);
  }
  for (const command of ['aws s3 ls; echo deploy', 'gcloud config list | grep deploy', 'echo "gcloud run deploy"', 'docker compose ps && echo up', 'git push origin main --dry-run', 'gcloud auth login', 'ls']) {
    assert.equal(deployCommand(command)?.what === 'cloud deploy' || deployCommand(command)?.what === 'compose up', false, command);
  }
  assert.equal(commandShape('npm   run build  &&  rm -rf x'), commandShape('npm run build'));
  // …and how long it may take.
  const hostile: Record<string, string> = {
    'a quote and escaped quotes': `"${'\\"'.repeat(N / 2)}`,
    'quotes, none closed': '"a'.repeat(N / 2),
    'aws, over and over': 'aws '.repeat(N / 4),
    'gcloud, over and over': 'gcloud '.repeat(Math.floor(N / 7)),
    'git push, over and over': 'git push '.repeat(Math.floor(N / 9)),
    'docker compose, over and over': 'docker compose '.repeat(Math.floor(N / 15)),
    'a word, then spaces, then a word': `x${' '.repeat(N)}y`,
    'a word, then empty lines, then a word': `x${'\n'.repeat(N)}y`,
    'one long word': 'a'.repeat(N),
  };
  for (const [what, command] of Object.entries(hostile)) {
    timed(`isTestCommand, ${what}`, () => isTestCommand(command));
    timed(`deployCommand, ${what}`, () => deployCommand(command));
    timed(`commandShape, ${what}`, () => commandShape(command));
  }
});

test('what a session records and asks: a lesson, a question, the words of both', () => {
  assert.deepEqual(tokens('Touch src/db/schema.ts. Really.'), ['touch', 'src/db/schema.ts', 'really']);
  const ok = checkLesson({ lesson: 'Run the migrations before the tests in this repo', applies_when: 'changing the schema.', why: 'the tests read the new columns' });
  assert.equal(ok.ok, true);
  const dots = `a${'.'.repeat(N)}a`;
  timed('tokens', () => tokens(dots));
  timed('a lesson of dots', () => checkLesson({ lesson: `Always ${dots}`, applies_when: dots, why: dots }));
  timed('the words of a question', () => distinctiveWords(`abc${'.'.repeat(N)}a`));
  timed('two questions compared', () => questionSimilarity(`what ${dots} is it`, 'what is it then'));
  // The same texts compared again and again (every new question against every earlier one) are read once.
  const earlier = Array.from({ length: 2000 }, (_, i) => `Which database should service number ${i} use for its sessions and why would that be the right one?`);
  const asked = `Which of the two databases should the new service use ${'really '.repeat(500)}?`;
  timed('one question against two thousand', () => earlier.forEach((q) => questionSimilarity(asked, q)), 1000);
  assert.ok(questionSimilarity('Which database should we use?', 'which database should we use') > 0.9);
});

test('a terminal\'s screen: a line is read as far as a wide terminal shows', () => {
  const dialog = ['────────────────────────────────', ' Bash command', '   rm -rf build', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ''];
  const seen = permissionPrompt(dialog);
  assert.deepEqual([seen?.allow, seen?.deny], [['Enter'], ['Down', 'Enter']]);
  assert.equal(plainScreen([`\x1b[31m${'x'.repeat(5000)}\x1b[0m`])[0]!.length, 600);
  assert.deepEqual(plainScreen(null as unknown as string[]), []);
  const spaces = `${' '.repeat(N)}x`;
  timed('a prompt under a line of spaces', () => permissionPrompt([...dialog, spaces]));
  timed('fifty lines of spaces', () => permissionPrompt(Array.from({ length: 50 }, () => spaces)));
  timed('the trust prompt', () => trustPromptKeys(Array.from({ length: 50 }, () => spaces)));
  timed('a million lines', () => permissionPrompt(Array.from({ length: 100_000 }, () => ' x')));
});

test('what programs printed and what tasks say: errors of the machine, paths, a search\'s reply, conflicted files', () => {
  assert.deepEqual(environmentError('building…\n/bin/sh: 1: pnpm: not found\nexit 127'), { name: 'command not found', line: '/bin/sh: 1: pnpm: not found' });
  assert.deepEqual(environmentError('Error: Cannot find module \'x\'\n    at y'), { name: 'missing module', line: "Error: Cannot find module 'x'" });
  assert.equal(environmentError('2 tests failed'), null);
  assert.deepEqual(pathsIn('Change src/db/schema.ts and package.json, not the README.'), ['src/db/schema.ts', 'package.json']);
  assert.equal(sameFriction('conflict:a.ts,b.ts', 'conflict:b.ts,c.ts'), sameFriction('conflict:b.ts,c.ts', 'conflict:a.ts,b.ts'));
  timed('errors, one long line', () => environmentError('x'.repeat(N)));
  timed('errors, many long lines', () => environmentError(Array.from({ length: 100 }, () => 'y'.repeat(2000)).join('\n')));
  for (const [what, text] of Object.entries({ 'one long word': 'a'.repeat(N), 'a-a-a': 'a-'.repeat(N / 2), 'a.a.a': 'a.'.repeat(N / 2), 'a/a/a': 'a/'.repeat(N / 2), slashes: '/'.repeat(N) })) timed(`paths, ${what}`, () => pathsIn(text));
  timed('a search reply of empty lines', () => parseSearch(`${'\n'.repeat(N)}`));
  timed('a search reply of indented lines', () => parseSearch(`  [1] room\n${'      \n'.repeat(Math.floor(N / 7))}`));
  const files = (k: number, from: number) => `conflict:${Array.from({ length: k }, (_, i) => `src/file-${from + i}.ts`).join(',')}`;
  timed('two long lists of files', () => sameFriction(files(30_000, 0), files(30_000, 30_000)));
  timed('keys for a terminal', () => inputToSendKeys('%1', '\x01'.repeat(N * 5)));
  assert.equal(inputToSendKeys('%1', '\x01'.repeat(600)).length, 3, '256 keys a command');
});

test('the words around a credential: a name with a tail of commas', () => {
  timed('a password with a tail', () => detectSecrets(`the password is a${','.repeat(N)}a1B`));
  timed('a name with a tail', () => detectSecrets(`token for a${'.'.repeat(N)}a is Abcdef12345!`));
  assert.deepEqual(detectSecrets('the password for staging is Jaka123!x.').map((f) => f.value), ['Jaka123!x']);
});
