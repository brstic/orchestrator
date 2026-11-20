import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trustPromptKeys } from '../src/comms.ts';

/**
 * The keys that choose "Yes" on Claude Code's own questions at the start of a session — the workspace-trust
 * question and the Bypass Permissions warning — read from the screen as it stands, in the shapes they have had.
 */

test('the Bypass Permissions warning, as it looks now: no numbers, either answer may be the one marked', () => {
  const warning = (marked: 'yes' | 'no') => [
    ' WARNING: Claude Code running in Bypass Permissions mode',
    '',
    '  In Bypass Permissions mode, Claude Code will not ask for your approval before running potentially dangerous commands.',
    '  This mode should only be used in a sandboxed container/VM that has restricted internet access and can easily be restored if damaged.',
    '',
    '  By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.',
    '',
    '  https://code.claude.com/docs/en/security',
    '',
    `  ${marked === 'no' ? '❯' : ' '} No, exit`,
    `  ${marked === 'yes' ? '❯' : ' '} Yes, I accept`,
  ];
  assert.deepEqual(trustPromptKeys(warning('yes')), ['Enter']);
  assert.deepEqual(trustPromptKeys(warning('no')), ['Down', 'Enter']);
});

test('the workspace-trust question: numbered, "Yes" first; and the same inside a drawn box', () => {
  const asked = [
    ' Accessing workspace:',
    '',
    ' /home/office/projects/shop',
    '',
    ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team).',
    '',
    " Claude Code'll be able to read, edit, and execute files here.",
    '',
    ' ❯ 1. Yes, I trust this folder',
    '   2. No, exit',
    '',
    ' Enter to confirm · Esc to cancel',
  ];
  assert.deepEqual(trustPromptKeys(asked), ['Enter']);
  const boxed = ['╭──────────────────────────────────────╮', '│ Do you trust the files in this folder? │', '│                                      │', '│   1. No, exit                        │', '│ ❯ 2. Yes, proceed                    │', '╰──────────────────────────────────────╯'];
  assert.deepEqual(trustPromptKeys(boxed), ['Enter']);
  assert.deepEqual(trustPromptKeys(boxed.map((l) => l.replace('❯ 2.', '  2.').replace('  1. No', '❯ 1. No'))), ['Down', 'Enter']);
});

test('no keys are pressed blind: words of the question without its answers, or answers with none marked, are not it', () => {
  assert.equal(trustPromptKeys(['Is this a project you created or one you trust?', 'I would say yes, trust this folder.']), null);
  assert.equal(trustPromptKeys(['  Yes, I accept', '  No, exit']), null, 'nothing is marked');
  assert.equal(trustPromptKeys(['❯ Yes, I accept']), null, 'one answer is not a choice');
  assert.equal(trustPromptKeys([]), null);
});

test('the question about files a CLAUDE.md imports from outside the folder, as it looked on the live office: "No" marked', () => {
  const asked = [
    ' Allow external CLAUDE.md file imports?',
    '',
    "  This project's CLAUDE.md or .claude/rules imports files outside the current working directory. Never allow this for third-party repositories.",
    '',
    '  External imports:',
    '    /home/office/AGENTS.md',
    '',
    '  Important: Only use Claude Code with files you trust. Accessing untrusted files may pose security risks https://code.claude.com/docs/en/security',
    '',
    '  ❯ No, disable external imports',
    '    Yes, allow external imports',
    '',
    '  Enter to confirm · Esc to cancel',
  ];
  assert.deepEqual(trustPromptKeys(asked), ['Down', 'Enter']);
});
