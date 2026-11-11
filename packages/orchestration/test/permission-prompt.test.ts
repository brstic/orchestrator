import { test } from 'node:test';
import assert from 'node:assert/strict';
import { permissionPrompt } from '../src/comms.ts';

// The dialog as it stood in a real session's terminal on the office's server on 2026-11-11 (Claude Code 2.1.322),
// with the lines of the conversation above it.
const HOOK_ASK = `
● Pushing commit b2754e4 (the T-3 Stripe status commit) to git.example.test, then deploying to dev.
● Bash(cd /srv/shop; git fetch origin 2>&1 | tail -2; git status -sb | head -3;
      timeout 60 git push origin master 2>&1 | tail -5)
  ⎿  Waiting…
────────────────────────────────────────────────────────────────────────────────────────────────
 Bash command
 Run shell command
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 │ cd /srv/shop; git fetch origin 2>&1 | tail -2; git status -sb | head -3;
 │ timeout 60 git push origin master 2>&1 | tail -5
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 │ Hook PreToolUse:Bash requires confirmation for this command:
 │ Orchestrator policy: this command matches a high-risk pattern (\\bgit\\s+push\\b) and needs the owner's approval.
 │ [settings]
 settings.json to update hooks
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend
──────────────────────────────────────────────────────────────────────────────── Shop Engineer ─
`.split('\n');

test('the permission dialog standing in a terminal is read: what it is about, and the keys for each answer', () => {
  const p = permissionPrompt(HOOK_ASK)!;
  assert.ok(p);
  assert.match(p.what, /timeout 60 git push origin master/);
  assert.match(p.what, /high-risk pattern/);
  assert.doesNotMatch(p.what, /Do you want to proceed|\[settings\]/);
  assert.deepEqual(p.allow, ['Enter']);
  assert.deepEqual(p.deny, ['Down', 'Enter']);
});

test('"allow" is the plain Yes, never the one that stops asking; and the choice may stand anywhere', () => {
  const three = ['', ' Edit file', ' │ src/app.ts', ' Do you want to make this edit to app.ts?', '   1. Yes', ' ❯ 2. Yes, and don\'t ask again for edits this session', '   3. No, and tell Claude what to do differently (esc)', ''];
  const p = permissionPrompt(three)!;
  assert.deepEqual(p.allow, ['Up', 'Enter']);
  assert.deepEqual(p.deny, ['Down', 'Enter']);
  assert.equal(p.what, 'src/app.ts');
  // Only a "don't ask again" Yes on offer: the office does not pick it.
  const widening = [' Do you want to proceed?', ' ❯ 1. Yes, and always allow access to tmp/ from this project', '   2. No'];
  assert.equal(permissionPrompt(widening)!.allow, null);
  assert.deepEqual(permissionPrompt(widening)!.deny, ['Down', 'Enter']);
  // Colours and the box of a framed dialog do not matter.
  const framed = ['│ \x1b[33mDo you want to proceed?\x1b[0m │', '│ \x1b[36m❯ 1. Yes\x1b[0m │', '│   2. No │'];
  assert.deepEqual(permissionPrompt(framed)!.allow, ['Enter']);
});

test('a screen without the dialog is not mistaken for one', () => {
  for (const lines of [
    [],
    ['❯ ', '  ⏵⏵ auto mode on'],
    ['● Do you want to proceed? I can also wait.', '', '❯ '],
    // The words in the conversation, with a list that is not a choice.
    [' Do you want to proceed?', ' 1. Yes, that is what the README says', ' 2. No tests exist yet'],
    // Options with nothing asked above them.
    [' ❯ 1. Yes', '   2. No'],
  ]) assert.equal(permissionPrompt(lines), null, JSON.stringify(lines));
  // A dialog still visible further up while the session is long past it (text scrolled, not cleared).
  assert.equal(permissionPrompt([...HOOK_ASK.slice(0, -3), '  ⎿ pushed', '● Done. The commit is on the server.', '  Next I deploy to dev.', '  Then I run the scenario.', '❯ ']), null);
});
