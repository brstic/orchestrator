import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEffortLevels, planClaudeLaunch } from '../src/claude.ts';

const HELP = `Usage: claude [options] [command] [prompt]

Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <environment_id>        Create a new cloud session (preview)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
`;

test('the effort levels are read from Claude Code\'s own help', () => {
  assert.deepEqual(parseEffortLevels(HELP), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(parseEffortLevels('Options:\n  --model <model>   Model for the session (e.g. sonnet)\n'), [], 'a Claude Code without the option');
  assert.deepEqual(parseEffortLevels('  --effort <level>   Effort level for the current session\n  --model <model>  Model'), ['low', 'medium', 'high'], 'the option without a list we can read');
  assert.deepEqual(parseEffortLevels('  --effort <level>  One of (low, high)\n'), ['low', 'high']);
});

const spec = (over: Record<string, unknown>) =>
  ({ displayName: 'Alex', cwd: '/tmp/x', mode: 'interactive_cli', model: null, permissionMode: 'default', permissions: { allow: [], deny: [], ask: [] }, allowedTools: [], disallowedTools: [], appendSystemPrompt: '', mcp: null, strictMcp: true, highRiskPatterns: [], claudeSessionId: 's-1', resume: false, env: {}, ...over }) as any;
const plan = (over: Record<string, unknown>, effortLevels?: string[] | null) =>
  planClaudeLaunch({ claudeBin: 'claude', spec: spec(over), sessionId: 'sess', sessionDir: '/tmp/sess', hookSocket: '/tmp/sock', hookToken: 't', claudeVersion: '2.1.322', approvalWaitSeconds: 60, effortLevels }).argv;
const after = (argv: string[], flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);

test('a worker is started with the model and the effort chosen for it — and with neither when nothing was chosen', () => {
  const both = plan({ model: 'opus', effort: 'high' }, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual([after(both, '--model'), after(both, '--effort')], ['opus', 'high']);
  const none = plan({}, ['low', 'medium', 'high']);
  assert.ok(!none.includes('--model') && !none.includes('--effort'), 'Claude Code\'s own defaults');
});

test('an effort this machine\'s Claude Code does not have is left out, so the session still starts', () => {
  assert.ok(!plan({ effort: 'xhigh' }, ['low', 'medium', 'high']).includes('--effort'));
  assert.ok(!plan({ effort: 'high' }, []).includes('--effort'), 'a Claude Code with no effort option');
  assert.ok(!plan({ effort: 'high' }, null).includes('--effort'), 'nothing known about it');
});
