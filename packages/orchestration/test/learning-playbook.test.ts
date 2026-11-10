import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SelfImprovementSettings } from '@orchestrator/contracts';
import type { Employee, Host, Lesson, Project, Task } from '@orchestrator/contracts';
import { Store } from '@orchestrator/database';
import { Engine, type AgentLink } from '../src/index.ts';
import { DEFAULT_BUDGET_CHARS, MATCH_THRESHOLD, STALE_AFTER, clearerText, compareLessons, compareTexts, isStale, lessonLine, pathsIn, playbookSettings, selectLessons, stem, terms, type TaskContext } from '../src/learning/playbook.ts';

// ───────────────────────── pure functions ─────────────────────────

const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();
function lesson(over: Partial<Lesson> & { id: string; text: string }): Lesson {
  return { scope: 'employee', employeeId: 'alex', projectId: null, appliesWhen: '', source: 'retrospective', evidence: [], status: 'active', authoredBy: { kind: 'employee', id: 'alex', name: 'Alex' }, appliedCount: 0, createdAt: day(1), updatedAt: day(1), ...over };
}
const context = (over: Partial<TaskContext> = {}): TaskContext => ({ title: '', description: '', acceptance: '', kind: 'feature', projectName: 'Shop', files: [], nearFiles: [], ...over });
const ids = (s: { chosen: Array<{ lesson: Lesson }> }) => s.chosen.map((c) => c.lesson.id);

const UNRELATED = [
  'Keep CSS class names in kebab-case so the stylesheet stays searchable',
  'Log request ids on every API error so support can trace a complaint',
  'Rebase the branch on the integration branch first thing in the morning',
  'Screenshots in a review comment save a round of questions',
  'Name React components after what they show, not where they are used',
  'Pin the Node version in the Dockerfile to the one CI runs',
  'Translate button labels through the i18n helper, never inline',
  'Close the websocket in the cleanup of the effect that opened it',
  'Prefer early returns over nested conditionals in request handlers',
  'Read the linter output before pushing, it is faster than CI',
];
const migration = lesson({ id: 'mig', scope: 'project', employeeId: null, projectId: 'shop', text: 'Run every database migration against a copy of production data before committing it', appliesWhen: 'when writing or changing a migration', createdAt: day(1) });
const newer = UNRELATED.map((text, i) => lesson({ id: `u${i}`, text, createdAt: day(10 + i) }));
const migrationTask = context({ title: 'Add a migration for the orders table', description: 'The orders table needs a currency column. Write the migration and update the model.' });

test('words are reduced to what they mean: stems, aliases, no filler', () => {
  for (const [a, b] of [['migrations', 'migrate'], ['migrating', 'migration'], ['committing', 'commits'], ['committed', 'commit'], ['tests', 'testing'], ['copies', 'copy'], ['db', 'databases'], ['configure', 'configuration'], ['verified', 'verification'], ['changes', 'changing'], ['repo', 'repositories']] as const) {
    assert.equal(stem(a), stem(b), `${a} / ${b}`);
  }
  assert.notEqual(stem('test'), stem('typecheck'));
  assert.equal(stem('ISO8601'.toLowerCase()), 'iso8601', 'anything with a digit is left alone');
  assert.equal(stem('проверити'), 'проверити', 'other languages pass through');
  assert.deepEqual(terms("Don't forget: always run the filesChanged check before you commit!"), ['forget', 'run', 'file', 'chang', 'check', 'commit']);
  assert.deepEqual(pathsIn('Touch src/db/schema.ts and package.json, not the README'), ['src/db/schema.ts', 'package.json']);
});

test('relevance: the lesson about migrations is chosen for a migration task over ten newer unrelated ones', () => {
  // Room for about four lessons: under the old rule (own lessons first, newest first) the project's migration lesson came last.
  const s = selectLessons({ lessons: [...newer, migration], employeeId: 'alex', context: migrationTask, budgetChars: 400 });
  assert.equal(s.chosen[0]!.lesson.id, 'mig', 'the best fit leads');
  assert.ok(s.chosen[0]!.relevance >= MATCH_THRESHOLD && s.chosen[0]!.fits);
  assert.deepEqual(s.chosen[0]!.matched, ['migration', 'write'], "and says which of the task's words it matched, strongest first");
  assert.match(s.chosen[0]!.reasons.join('; '), /fits the task: migration, write; project knowledge/);
  assert.ok(s.chosen.length < 11 && s.leftOut.length === 11 - s.chosen.length, 'the rest of the room goes to others; what did not fit is listed');
  assert.ok(s.leftOut.every((x) => x.why === 'budget'));
  assert.equal(s.considered, 11);
  // A task about something else does not get it ahead of the employee's own lessons.
  const other = selectLessons({ lessons: [...newer, migration], employeeId: 'alex', context: context({ title: 'Fix the websocket leak in the chat effect' }), budgetChars: 400 });
  assert.equal(other.chosen[0]!.lesson.id, 'u7');
  assert.ok(!ids(other).includes('mig'));
});

test('the budget is in characters: respected, filled with short lessons, and never empty', () => {
  const long = lesson({ id: 'long', text: `Check the migration twice. ${'Really, check it. '.repeat(18)}`.trim(), createdAt: day(2) });
  const short = ['Squash before merge', 'Lint before push', 'Ask before deleting', 'Tag every release'].map((text, i) => lesson({ id: `s${i}`, text, createdAt: day(3 + i) }));
  const size = (s: { chosen: Array<{ lesson: Lesson }> }) => s.chosen.reduce((n, c) => n + lessonLine(c.lesson).length + 1, 0);
  for (const budgetChars of [120, 400, 2400]) {
    const s = selectLessons({ lessons: [...short, ...newer], employeeId: 'alex', context: migrationTask, budgetChars });
    assert.ok(size(s) <= budgetChars, `within ${budgetChars}`);
    assert.equal(s.usedChars, size(s));
    assert.equal(s.chosen.length + s.leftOut.length, 14);
  }
  // Short lessons do not waste the allowance: a too-long one is passed over and the next ones that fit go in.
  const mixed = selectLessons({ lessons: [long, ...short], employeeId: 'alex', context: context({ title: 'Tag the release' }), budgetChars: 90, newestOwn: 0 });
  assert.deepEqual(ids(mixed).sort(), ['s0', 's1', 's2', 's3']);
  assert.deepEqual(mixed.leftOut.map((x) => [x.id, x.why]), [['long', 'budget']]);
  // The best fit always goes in, even when it alone is longer than the budget.
  const alone = selectLessons({ lessons: [long, ...short], employeeId: 'alex', context: migrationTask, budgetChars: 90, newestOwn: 0 });
  assert.deepEqual(ids(alone), ['long']);
  // More lessons than the old fixed twelve fit when they are short.
  const many = Array.from({ length: 30 }, (_, i) => lesson({ id: `m${String(i).padStart(2, '0')}`, text: `Rule ${i}: keep module ${i} small`, createdAt: day(1 + i) }));
  assert.equal(selectLessons({ lessons: many, employeeId: 'alex', context: migrationTask }).chosen.length, 30);
  assert.equal(DEFAULT_BUDGET_CHARS, 2400);
});

test("the employee's newest lessons keep a place even when nothing matches them yet", () => {
  const fits = Array.from({ length: 6 }, (_, i) => lesson({ id: `f${i}`, scope: 'project', employeeId: null, projectId: 'shop', text: `Migration rule ${i}: check the orders table migration for locks, part ${i}`, createdAt: day(1 + i) }));
  const fresh = [lesson({ id: 'new1', text: 'Restart the preview server after editing the theme', createdAt: day(30) }), lesson({ id: 'new2', text: 'Colour tokens live in one palette document', createdAt: day(29) }), lesson({ id: 'old', text: 'Keep the changelog in the present tense, one line per change, newest entry at the top of the file', createdAt: day(2) })];
  const s = selectLessons({ lessons: [...fits, ...fresh], employeeId: 'alex', context: migrationTask, budgetChars: 330 });
  assert.ok(ids(s).includes('new1') && ids(s).includes('new2'), 'the two newest of their own are in');
  assert.ok(!ids(s).includes('old'), 'an older one that does not fit is not');
  assert.deepEqual(s.chosen.filter((c) => c.newestOwn).map((c) => c.lesson.id).sort(), ['new1', 'new2']);
  assert.match(s.chosen.find((c) => c.lesson.id === 'new1')!.reasons.join('; '), /one of their newest lessons/);
  assert.equal(s.chosen[0]!.lesson.id.startsWith('f'), true, 'the quota never displaces the best fit');
  // Someone else's playbook gives no quota here.
  const sarah = selectLessons({ lessons: [...fits, ...fresh.map((l) => ({ ...l, scope: 'company' as const, employeeId: null }))], employeeId: 'sarah', context: migrationTask, budgetChars: 330 });
  assert.ok(!ids(sarah).includes('new1') && sarah.chosen.every((c) => !c.newestOwn));
});

test('boosts: the same kind of task and the same files count, and each is named as a reason', () => {
  const a = lesson({ id: 'a', scope: 'project', employeeId: null, projectId: 'shop', text: 'Regenerate the lockfile in a separate commit' });
  const b = lesson({ id: 'b', scope: 'project', employeeId: null, projectId: 'shop', text: 'Leave formatting-only changes out of the pull request' });
  const c = lesson({ id: 'c', scope: 'project', employeeId: null, projectId: 'shop', text: 'Explain every skipped assertion in a comment' });
  const facts = (l: Lesson) => (l.id === 'a' ? { kinds: ['bug' as const], files: ['src/billing/invoice.ts'] } : l.id === 'b' ? { kinds: ['feature' as const], files: ['src/billing/tax.ts'] } : { kinds: ['bug' as const], files: [] });
  const s = selectLessons({ lessons: [a, b, c], employeeId: 'alex', facts, context: context({ title: 'Round totals', kind: 'bug', files: ['src/billing/invoice.ts'] }) });
  assert.deepEqual(ids(s), ['a', 'b', 'c'], 'same file and same kind, then same directory, then same kind only… and c has only the kind');
  assert.match(s.chosen[0]!.reasons.join('; '), /learned on a bug task; learned on src\/billing\/invoice\.ts/);
  assert.match(s.chosen[1]!.reasons.join('; '), /learned in src\/billing\//);
  assert.ok(s.chosen[0]!.fits && s.chosen[1]!.fits && !s.chosen[2]!.fits);
  // A path written in the task text counts as a file of the task; a dependency's files count by directory only.
  const named = selectLessons({ lessons: [a, b, c], employeeId: 'alex', facts, context: context({ title: 'Round totals in src/billing/tax.ts' }) });
  assert.equal(named.chosen[0]!.lesson.id, 'b');
  const near = selectLessons({ lessons: [a, b, c], employeeId: 'alex', facts, context: context({ title: 'Round totals', nearFiles: ['src/billing/invoice.ts'] }) });
  assert.ok(near.chosen.slice(0, 2).every((x) => /learned in src\/billing\//.test(x.reasons.join('; '))));
});

test('determinism: the same lessons and task give the same choice in the same order, however they arrive', () => {
  const all = [...newer, migration, lesson({ id: 'tie1', text: 'Ship small', createdAt: day(5) }), lesson({ id: 'tie2', text: 'Ship often', createdAt: day(5) })];
  const first = selectLessons({ lessons: all, employeeId: 'alex', context: migrationTask, budgetChars: 500 });
  const again = selectLessons({ lessons: all, employeeId: 'alex', context: migrationTask, budgetChars: 500 });
  assert.deepEqual(again, first);
  const reversed = selectLessons({ lessons: [...all].reverse(), employeeId: 'alex', context: migrationTask, budgetChars: 500 });
  const shuffled = selectLessons({ lessons: all.map((l, i) => all[(i * 7 + 3) % all.length]!), employeeId: 'alex', context: migrationTask, budgetChars: 500 });
  assert.deepEqual(ids(reversed), ids(first));
  assert.deepEqual(ids(shuffled), ids(first));
  assert.deepEqual(reversed.chosen.map((c) => c.score), first.chosen.map((c) => c.score));
  assert.deepEqual(reversed.leftOut, first.leftOut);
});

test('staleness: included again and again without ever fitting ranks a lesson down, but never out of a task it fits', () => {
  const stale = lesson({ id: 'stale', text: 'Double-check the invoice rounding rules', createdAt: day(3), appliedCount: 20, playbook: { lastIncludedAt: day(9), matchedCount: 0, unmatchedStreak: STALE_AFTER, mergedCount: 0, mergedFrom: [], mergedInto: null, promotedFrom: [], distinctFrom: [] } });
  const fresh = lesson({ id: 'fresh', text: 'Write the summary for someone who was not there', createdAt: day(2) });
  const shared = lesson({ id: 'shared', scope: 'project', employeeId: null, projectId: 'shop', text: 'Screenshots go in the pull request description', createdAt: day(1) });
  assert.equal(isStale(stale), true);
  assert.equal(isStale({ ...stale, playbook: { ...stale.playbook!, unmatchedStreak: STALE_AFTER - 1 } }), false);
  assert.equal(isStale({ ...stale, appliesWhen: 'always, on every task' }), false, 'a lesson that says it always applies is not expected to match words');
  const s = selectLessons({ lessons: [stale, fresh, shared], employeeId: 'alex', context: migrationTask, newestOwn: 0 });
  assert.deepEqual(ids(s), ['fresh', 'shared', 'stale'], 'still included while there is room, but behind even shared knowledge');
  assert.match(s.chosen[2]!.reasons.join('; '), /ranked down: included 8 task prompts in a row without fitting the task/);
  assert.deepEqual(ids(selectLessons({ lessons: [stale, fresh, shared], employeeId: 'alex', context: migrationTask, budgetChars: 120 })), ['fresh', 'shared'], 'when room is short it is the one that falls off — and it holds no newest-lesson place');
  const fitting = selectLessons({ lessons: [stale, fresh, shared], employeeId: 'alex', context: context({ title: 'Invoice rounding is off by a cent' }), budgetChars: 60 });
  assert.deepEqual(ids(fitting), ['stale'], 'a task it does fit gets it at full strength');
  assert.ok(!/ranked down/.test(fitting.chosen[0]!.reasons.join('; ')));
});

test('telling lessons apart: a rewording is a duplicate, an opposite is a contradiction, a different subject is neither', () => {
  const dup = compareTexts('Always run the migration against a copy of the database before committing.', 'Run migrations on a database copy before you commit');
  assert.deepEqual([dup.verdict, dup.similarity], ['duplicate', 1]);
  assert.equal(compareTexts('Run the tests before completing.', 'run the tests before completing').verdict, 'duplicate', 'case and punctuation are not a difference');
  // The shorter lesson inside a longer one that adds detail.
  assert.equal(compareTexts('Run the linter and the type checker before committing', 'Run the linter and the type checker before committing, then paste the output in the summary').verdict, 'duplicate');
  // One different key word is a different lesson.
  assert.equal(compareTexts('Run pnpm test before completing the task', 'Run pnpm typecheck before completing the task').verdict, 'different');
  assert.equal(compareTexts('Use tabs for indentation', 'Use spaces for indentation').verdict, 'different');
  assert.equal(compareTexts('Ship small', 'Ship often').verdict, 'different', 'too few words to call two sentences the same');
  // Opposite polarity on the same subject.
  const contra = compareTexts('Always squash commits before merging into the main branch', 'Never squash commits before merging into the main branch');
  assert.deepEqual([contra.verdict, contra.reason], ['contradiction', 'polarity']);
  assert.equal(compareTexts('Do not squash commits before merging into main', "Don't squash commits before merging to main").verdict, 'duplicate', 'two prohibitions agree');
  assert.equal(compareTexts('Never merge into main without running the test suite', 'Always run the test suite and then merge into main').verdict, 'duplicate', 'a double negative is not a prohibition');
  // A longer lesson that adds a prohibition is not called a contradiction of the shorter one.
  assert.equal(compareTexts('Run the linter and the type checker before committing', 'Run the linter and the type checker before committing, and never push straight to main').verdict, 'different');
  // The same sentence with different figures.
  assert.deepEqual(compareTexts('Start the local preview server on port 3000 before taking the screenshots', 'Start the local preview server on port 3001 before taking the screenshots').reason, 'numbers');
  // The boss's decisions: only the very same words are the same decision.
  const q = 'Decided by the boss — "Which of the two layouts do we ship for the dashboard page?": ';
  const decided = (answer: string, question = q) => ({ text: `${question}${answer}`, source: 'owner_answer' as const });
  assert.equal(compareLessons(decided('the compact one'), decided('The compact one.')).verdict, 'duplicate');
  for (const other of ['the wide one', 'option B', 'no', 'the compact one, but only on phones']) {
    const c = compareLessons(decided('the compact one'), decided(other));
    assert.deepEqual([c.verdict, c.reason], ['contradiction', 'decision'], other);
  }
  assert.equal(compareLessons(decided('the compact one'), decided('the compact one', 'Decided by the boss — "Which colour is the header?": ')).verdict, 'different');
  // Labels and figures count: "option A" is not "option B".
  assert.equal(compareTexts('For the checkout flow of the shop we go with option A', 'For the checkout flow of the shop we go with option B').verdict, 'contradiction');
  // Which wording survives a merge.
  const by = (kind: 'owner' | 'employee', text: string) => ({ text, appliesWhen: '', authoredBy: { kind, id: null, name: kind } });
  assert.equal(clearerText(by('employee', 'Run tests'), by('employee', 'Run the unit tests and the linter')).text, 'Run the unit tests and the linter');
  assert.equal(clearerText(by('owner', 'Run tests'), by('employee', 'Run the unit tests and the linter')).text, 'Run tests', "the owner's words are not replaced by an employee's");
  assert.equal(clearerText(by('employee', 'Run the tests'), by('employee', 'Run tests')).text, 'Run the tests', 'a tie keeps the longer, then the first');
});

test('settings: on by default, the budget kept within bounds', () => {
  const s = (over: object) => playbookSettings({ selfImprovement: { enabled: true, retrospectives: 'friction', autoApproveSharedLessons: false, learnedRouting: true, ...over } as SelfImprovementSettings });
  assert.deepEqual(s({}), { relevance: true, budgetChars: 2400 });
  assert.deepEqual(s({ playbookRelevance: false, playbookBudgetChars: 1000.4 }), { relevance: false, budgetChars: 1000 });
  assert.deepEqual([s({ playbookBudgetChars: 5 }).budgetChars, s({ playbookBudgetChars: 1e9 }).budgetChars, s({ playbookBudgetChars: 'lots' }).budgetChars, s({ playbookBudgetChars: NaN }).budgetChars], [400, 8000, 2400, 2400]);
});

// ───────────────────────── with an office ─────────────────────────

/** An engine whose one host is "online" but runs nothing (as in foreman.test.ts): no session is ever started. */
const link: AgentLink = { rpc: () => Promise.reject(new Error('this test host runs nothing')), isOnline: () => true, respondHook: () => false, disconnect: () => undefined };

interface Office {
  eng: Engine;
  shop: Project;
  alex: Employee;
  sarah: Employee;
  /** A task of the project, in progress with that employee (so what they record cites it). */
  working: (who: Employee, title: string, over?: Partial<Task>) => Task;
  lessons: () => Lesson[];
  events: (type: string) => ReturnType<Engine['core']['store']['queryEvents']>;
}

async function office(settings: object = {}): Promise<Office> {
  const eng = new Engine({ store: new Store(':memory:'), agents: link, publicUrl: 'http://127.0.0.1:1' }, { send: () => undefined });
  const host: Host = { id: 'host-1', name: 'box', status: 'online', info: null, resources: null, enrolledAt: new Date().toISOString(), lastSeenAt: null, revokedAt: null, local: true };
  eng.core.put('host', host);
  eng.core.updateSettings({ selfImprovement: settings } as any);
  // Work is handed over by hand here, so the scheduler starts nothing.
  const shop = await eng.tasks.createProject({ name: 'Shop', policy: { autoAssign: false } });
  const [alex, sarah] = (['Alex', 'Sarah'] as const).map((name) => eng.employees.create({ name, roleKey: name === 'Alex' ? 'backend' : 'frontend', projectId: shop.id, hostId: host.id, workingDir: '/tmp/x' }));
  let n = 0;
  const working = (who: Employee, title: string, over: Partial<Task> = {}) => {
    // Whatever they were on before is done; this is their task now.
    for (const t of eng.core.tasks.filter((x) => x.assigneeId === who.id && x.status === 'IN_PROGRESS')) eng.core.put('task', { ...t, status: 'DONE' });
    const t = eng.tasks.createTask({ projectId: shop.id, title, released: false });
    return eng.core.put('task', { ...t, assigneeId: who.id, status: 'IN_PROGRESS', startedAt: new Date(Date.now() + ++n).toISOString(), ...over } as Task);
  };
  return { eng, shop, alex: alex!, sarah: sarah!, working, lessons: () => eng.core.lessons.all().sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)), events: (type) => eng.core.store.queryEvents({ types: [type], limit: 500 }) };
}

test('a task prompt carries the lessons that fit the task, and the delivery says which and why', async () => {
  const o = await office({ playbookBudgetChars: 400 });
  for (const text of UNRELATED) o.eng.improver.recordFromOwner({ text, scope: 'employee', employeeId: o.alex.id });
  const mig = o.eng.improver.recordFromOwner({ text: migration.text, appliesWhen: migration.appliesWhen, scope: 'project', projectId: o.shop.id });
  const task = o.working(o.alex, migrationTask.title, { description: migrationTask.description });

  const block = o.eng.improver.playbookBlock(o.alex, o.shop.id, true, task);
  assert.match(block, /Team knowledge and decisions already made by the boss — do not ask these again:\n- Run every database migration against a copy of production data before committing it \(applies when writing or changing a migration\)/);
  assert.match(block, /Lessons from your own earlier work here — apply them:\n- /);
  const given = block.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(given.join('\n').length + 1 <= 400 && given.length < 11, 'within the budget from the settings');

  // On the lessons: counted, dated, and whether it fitted.
  const after = o.eng.core.lessons.require(mig.id);
  assert.equal(after.appliedCount, 1);
  assert.ok(after.playbook!.lastIncludedAt && Date.now() - Date.parse(after.playbook!.lastIncludedAt) < 5000);
  assert.deepEqual([after.playbook!.matchedCount, after.playbook!.unmatchedStreak], [1, 0]);
  const included = o.lessons().filter((l) => l.appliedCount === 1);
  assert.equal(included.length, given.length);
  assert.ok(included.filter((l) => l.id !== mig.id).every((l) => l.playbook!.matchedCount === 0 && l.playbook!.unmatchedStreak === 1));
  assert.ok(o.lessons().filter((l) => l.appliedCount === 0).every((l) => l.playbook === undefined), 'lessons that were not given are untouched');

  // On the task: the ids, for whoever measures whether lessons help.
  const stored = o.eng.core.tasks.require(task.id);
  assert.deepEqual([...stored.playbookLessonIds!].sort(), included.map((l) => l.id).sort());
  assert.equal(stored.playbookLessonIds![0], mig.id, 'best fit first');
  assert.match(stored.history.at(-1)!.note, new RegExp(`^Prompt carried ${given.length} playbook lessons \\(best fit: "Run every database migration against a copy of production data`));
  assert.equal(stored.history.at(-1)!.status, 'IN_PROGRESS', 'a note, not a change of status');

  // One event per delivery, explaining itself.
  const [ev, ...more] = o.events('learning.lessons_delivered');
  assert.equal(more.length, 0);
  assert.deepEqual([ev!.taskId, ev!.employeeId, ev!.projectId], [task.id, o.alex.id, o.shop.id]);
  const d = ev!.data as any;
  assert.deepEqual([d.auto, d.area, d.undo, d.quiet, d.budgetChars, d.considered], [true, 'playbook', null, true, 400, 11]);
  assert.deepEqual(d.lessons.map((l: any) => l.id), stored.playbookLessonIds);
  assert.deepEqual([d.lessons[0].id, d.lessons[0].matched, d.lessons[0].fits], [mig.id, ['migration', 'write'], true]);
  assert.match(d.lessons[0].reasons.join('; '), /fits the task: migration, write; project knowledge/);
  assert.equal(d.lessons.length + d.leftOut.length, 11);
  assert.ok(d.usedChars <= 400 && typeof d.what === 'string' && typeof d.why === 'string' && d.evidence[0].id === task.id);

  // A second delivery of the same task (a retry) adds to the task's list without repeating ids; a preview counts nothing.
  o.eng.improver.playbookBlock(o.alex, o.shop.id, false, task);
  assert.equal(o.eng.core.lessons.require(mig.id).appliedCount, 1);
  o.eng.improver.playbookBlock(o.alex, o.shop.id, true, task);
  assert.equal(o.eng.core.lessons.require(mig.id).appliedCount, 2);
  assert.equal(o.eng.core.tasks.require(task.id).playbookLessonIds!.length, stored.playbookLessonIds!.length);
  assert.equal(o.events('learning.lessons_delivered').length, 2);
});

test('a review is matched on the work it reviews', async () => {
  const o = await office({ playbookBudgetChars: 400 });
  for (const text of UNRELATED) o.eng.improver.recordFromOwner({ text, scope: 'employee', employeeId: o.sarah.id });
  const mig = o.eng.improver.recordFromOwner({ text: migration.text, appliesWhen: migration.appliesWhen, scope: 'project', projectId: o.shop.id });
  const target = o.working(o.alex, 'Add a migration for the orders table');
  const review = o.working(o.sarah, 'Review T-1', { kind: 'review', reviewOf: target.id });
  const s = o.eng.improver.playbook.select(o.sarah, review);
  const given = s.chosen.find((c) => c.lesson.id === mig.id)!;
  assert.deepEqual([given.matched, given.fits], [['migration'], true], 'the word is in the title of the task under review, not in the review task');
  // The only thing ahead of it is Sarah's own lesson about reviewing — which is what a review task is.
  assert.deepEqual(s.chosen.slice(0, 2).map((c) => c.lesson.text), ['Screenshots in a review comment save a round of questions', migration.text]);
});

test('no task (a system prompt, a Talk message, get_playbook): the newest twelve by scope, as before', async () => {
  const o = await office();
  const own: Lesson[] = [];
  for (let i = 0; i < 14; i++) {
    own.push(o.eng.improver.recordFromOwner({ text: `Own lesson number ${i}: mind module ${i} of the shop`, scope: 'employee', employeeId: o.alex.id }));
    // Recorded in the same millisecond otherwise; the old order is by time.
    o.eng.core.put('lesson', { ...own[i]!, createdAt: day(1 + i) });
  }
  const shared = o.eng.improver.recordFromOwner({ text: 'The shop sells in euros only', scope: 'project', projectId: o.shop.id });
  const expected = own.slice(2).reverse().map((l) => `- ${l.text}`);
  const block = o.eng.improver.playbookBlock(o.alex, o.shop.id, false);
  assert.equal(block, `Lessons from your own earlier work here — apply them:\n${expected.join('\n')}`, 'twelve of their own, newest first; the project lesson fell off the end');
  assert.deepEqual(o.eng.improver.lessonsFor(o.alex, o.shop.id).map((l) => l.id), own.slice(2).reverse().map((l) => l.id));
  assert.ok(o.lessons().every((l) => l.appliedCount === 0), 'not counted when the caller says so');
  // Counted the old way too: the count only, no delivery record, nothing on any task.
  o.eng.improver.playbookBlock(o.alex, o.shop.id);
  assert.deepEqual(o.lessons().filter((l) => l.appliedCount === 1).length, 12);
  assert.equal(o.eng.core.lessons.require(shared.id).appliedCount, 0);
  assert.ok(o.lessons().every((l) => l.playbook === undefined));
  assert.equal(o.events('learning.lessons_delivered').length, 0);

  // Relevance switched off in the settings: a task prompt is built the old way as well.
  o.eng.core.updateSettings({ selfImprovement: { playbookRelevance: false } } as any);
  const task = o.working(o.alex, 'Price the shop in euros');
  assert.equal(o.eng.improver.playbookBlock(o.alex, o.shop.id, true, task), block);
  assert.equal(o.eng.core.tasks.require(task.id).playbookLessonIds, undefined);
  // …and on again: the project lesson about euros is back in, first among the shared ones.
  o.eng.core.updateSettings({ selfImprovement: { playbookRelevance: true } } as any);
  assert.match(o.eng.improver.playbookBlock(o.alex, o.shop.id, true, task), /do not ask these again:\n- The shop sells in euros only/);
  // Self-improvement off altogether: nothing is given, task or not.
  o.eng.core.updateSettings({ selfImprovement: { enabled: false } } as any);
  assert.equal(o.eng.improver.playbookBlock(o.alex, o.shop.id, true, task), '');
});

test('a lesson recorded again in other words is merged: clearer text, all the evidence, the earliest date, counted, undoable', async () => {
  const o = await office();
  const t1 = o.working(o.alex, 'Add the orders migration');
  o.eng.improver.recordFromAgent(o.alex, { lesson: 'Always run the migration against a copy of the database before committing.', applies_when: 'when writing a migration', why: 'verification failed on this task because the migration was only run on an empty database' });
  const first = o.lessons()[0]!;
  o.eng.core.put('lesson', { ...first, createdAt: day(1), appliedCount: 3 });
  const t2 = o.working(o.alex, 'Add the invoices migration');
  const reply = o.eng.improver.recordFromAgent(o.alex, { lesson: 'Run migrations on a database copy before you commit — production data included', applies_when: 'when writing a migration', why: 'verification failed on this task because the migration was only run on an empty database' });
  assert.match(reply, new RegExp(`Recorded in your playbook \\(id ${first.id}\\)`), 'the employee is told it is in their playbook, under the lesson that carries on');

  assert.equal(o.lessons().length, 1, 'one lesson, not two');
  const merged = o.lessons()[0]!;
  assert.equal(merged.id, first.id);
  assert.equal(merged.text, 'Run migrations on a database copy before you commit — production data included', 'the wording that says more');
  assert.equal(merged.appliesWhen, 'when writing a migration', 'the "applies when" note is not lost with the wording');
  assert.deepEqual(merged.evidence.map((e) => e.id), [t1.id, t2.id], 'evidence of both');
  assert.equal(merged.createdAt, day(1), 'the earliest date');
  assert.equal(merged.appliedCount, 3);
  assert.equal(merged.playbook!.mergedCount, 1);
  assert.deepEqual(merged.playbook!.mergedFrom.map((m) => [m.lessonId, m.by, m.text]), [[null, 'Alex', 'Run migrations on a database copy before you commit — production data included']]);
  assert.equal(o.events('improvement.lesson_recorded').length, 1, 'not announced as a new lesson');
  const [ev] = o.events('learning.lesson_merged');
  const d = ev!.data as any;
  assert.deepEqual([d.auto, d.area, d.lessonId, d.keptWording, d.undo.type, ev!.taskId, ev!.employeeId], [true, 'playbook', first.id, 'incoming', 'unmerge', t2.id, o.alex.id]);
  assert.ok(d.similarity > 0.35 && d.similarity < 1 && /share \d+% of their meaningful words/.test(d.why));

  // The very same call again changes nothing; the same words on another task only add the evidence.
  o.eng.improver.recordFromAgent(o.alex, { lesson: 'Run migrations on a database copy before you commit — production data included', applies_when: 'when writing a migration', why: 'verification failed on this task because the migration was only run on an empty database' });
  assert.equal(o.events('learning.lesson_merged').length, 1);
  const t3 = o.working(o.alex, 'Add the refunds migration');
  o.eng.improver.recordFromAgent(o.alex, { lesson: 'run migrations on a database copy before you commit, production data included.', applies_when: 'when writing a migration', why: 'verification failed on this task because the migration was only run on an empty database' });
  assert.deepEqual(o.lessons()[0]!.evidence.map((e) => e.id), [t1.id, t2.id, t3.id]);
  assert.equal(o.lessons()[0]!.playbook!.mergedCount, 2);
  assert.equal(o.lessons().length, 1);

  // A different lesson, another employee's lesson and another scope are left alone.
  o.eng.improver.recordFromAgent(o.alex, { lesson: 'Run pnpm typecheck on a database copy before you commit', applies_when: 'when writing a migration', why: 'verification failed on this task because the migration was only run on an empty database' });
  o.working(o.sarah, 'Style the invoices page');
  o.eng.improver.recordFromOwner({ text: 'Run migrations on a database copy before you commit', scope: 'company' });
  assert.equal(o.lessons().length, 3);

  // Undo the first merge: the old wording and date are back, and what was folded in is a lesson of its own again.
  assert.throws(() => o.eng.improver.playbook.revert('nope'), /no merge or promotion with that id/);
  const undone = o.eng.improver.playbook.revert(ev!.id);
  assert.equal(undone.reverted, 'learning.lesson_merged');
  const back = o.eng.core.lessons.require(first.id);
  assert.deepEqual([back.text, back.createdAt, back.playbook!.mergedCount], ['Always run the migration against a copy of the database before committing.', day(1), 1]);
  assert.ok(!back.evidence.some((e) => e.id === t2.id) && back.evidence.some((e) => e.id === t1.id));
  const apart = o.eng.core.lessons.require(undone.lessonIds[1]!);
  assert.deepEqual([apart.text, apart.scope, apart.employeeId, apart.status, apart.evidence.map((e) => e.id)], ['Run migrations on a database copy before you commit — production data included', 'employee', o.alex.id, 'active', [t2.id]]);
  assert.throws(() => o.eng.improver.playbook.revert(ev!.id), /already undone/);
  assert.equal(o.events('learning.reverted').length, 1);
  // …and the periodic tidy-up does not merge the two again.
  const before = o.lessons().filter((l) => l.status === 'active').length;
  assert.deepEqual(o.eng.improver.playbook.consolidate().merged, []);
  assert.equal(o.lessons().filter((l) => l.status === 'active').length, before);
});

test('consolidate: duplicates already stored are merged into the older one, and the absorbed lesson points to it', async () => {
  const o = await office();
  // Two copies from before near-duplicates were caught (stored directly, as an older office would have them).
  const a = o.eng.improver.recordFromOwner({ text: 'Keep the public API backwards compatible for one release', scope: 'project', projectId: o.shop.id });
  const b = o.eng.core.put('lesson', { ...a, id: 'copy0001', text: 'For one release, keep the public API backwards-compatible.', evidence: [{ kind: 'task' as const, id: 't-x', note: 'T-9' }], appliedCount: 4, createdAt: day(400 * 365), authoredBy: { kind: 'employee' as const, id: o.sarah.id, name: 'Sarah' } });
  assert.equal(o.eng.improver.analyze().length, 0, 'nothing for the owner to decide');
  const kept = o.eng.core.lessons.require(a.id);
  const gone = o.eng.core.lessons.require(b.id);
  assert.deepEqual([kept.status, kept.text, kept.appliedCount, kept.evidence.map((e) => e.id), kept.playbook!.mergedCount], ['active', 'Keep the public API backwards compatible for one release', 4, ['t-x'], 1], "the owner's wording stays");
  assert.deepEqual([gone.status, gone.playbook!.mergedInto], ['retired', a.id]);
  const [ev] = o.events('learning.lesson_merged');
  assert.equal(o.eng.improver.analyze().length, 0);
  assert.equal(o.events('learning.lesson_merged').length, 1, 'idempotent');
  // Undone: both stand again.
  o.eng.improver.playbook.revert(ev!.id);
  assert.deepEqual([o.eng.core.lessons.require(a.id).appliedCount, o.eng.core.lessons.require(b.id).status, o.eng.core.lessons.require(b.id).playbook!.mergedInto], [0, 'active', null]);
  o.eng.improver.analyze();
  assert.equal(o.eng.core.lessons.require(b.id).status, 'active');

  // The same when the owner simply reactivates a lesson that was folded away: it is not folded away again.
  const c = o.eng.improver.recordFromOwner({ text: 'Write the changelog entry in the same commit as the change', scope: 'company' });
  const d = o.eng.core.put('lesson', { ...c, id: 'copy0002', text: 'In the same commit as the change, write the changelog entry too', createdAt: day(400 * 365) });
  o.eng.improver.analyze();
  assert.deepEqual([o.eng.core.lessons.require(d.id).status, o.eng.core.lessons.require(d.id).playbook!.mergedInto], ['retired', c.id]);
  o.eng.improver.updateLesson(d.id, { status: 'active' });
  o.eng.improver.analyze();
  assert.deepEqual([o.eng.core.lessons.require(d.id).status, o.eng.core.lessons.require(d.id).playbook!.mergedInto, o.eng.core.lessons.require(c.id).playbook!.distinctFrom], ['active', null, [d.id]]);
  assert.equal(o.events('learning.lesson_merged').length, 2);
});

test('a contradiction is put to the owner, not merged and not decided', async () => {
  const o = await office();
  const yes = o.eng.improver.recordFromOwner({ text: 'Always squash commits before merging into the main branch', scope: 'project', projectId: o.shop.id });
  o.working(o.alex, 'Merge the checkout branch');
  o.eng.improver.recordFromAgent(o.alex, { lesson: 'Never squash commits before merging into the main branch', applies_when: 'when writing a migration', why: 'verification failed on this task because the migration was only run on an empty database' });
  const no = o.lessons().find((l) => l.scope === 'employee')!;
  // A lesson of an employee on another project never meets the project's lesson: no contradiction there.
  const other = await o.eng.tasks.createProject({ name: 'Blog', policy: { autoAssign: false } });
  const bo = o.eng.employees.create({ name: 'Bo', roleKey: 'backend', projectId: other.id, hostId: 'host-1', workingDir: '/tmp/x' });
  o.eng.improver.recordFromOwner({ text: 'Never squash commits before merging into the main branch', scope: 'employee', employeeId: bo.id });

  const found = o.eng.improver.analyze();
  assert.equal(found.length, 1);
  const imp = found[0]!;
  assert.deepEqual([imp.kind, imp.status, imp.action, imp.projectId, imp.employeeId], ['playbook_contradiction', 'proposed', { type: 'advice' }, o.shop.id, o.alex.id]);
  assert.deepEqual(imp.evidence.map((e) => [e.kind, e.id]).sort(), [['lesson', yes.id], ['lesson', no.id]].sort());
  assert.match(imp.rationale, /“Always squash commits[^”]*” \(project Shop\)/);
  assert.match(imp.rationale, /“Never squash commits[^”]*” \(Alex's playbook\)/);
  assert.match(imp.rationale, /share 100% of their meaningful words, and one tells employees to do what the other tells them not to/);
  assert.match(imp.rationale, /comparison of wording, not of meaning/);
  assert.deepEqual(o.lessons().map((l) => l.status), ['active', 'active', 'active'], 'both stay as they are');
  assert.equal(o.events('learning.lesson_merged').length, 0);
  assert.equal(o.events('learning.contradiction_flagged').length, 1);
  assert.ok(o.eng.core.notifications.all().some((n) => /Two lessons contradict each other/.test(n.title)));
  assert.equal(o.eng.improver.analyze().length, 0, 'flagged once');

  // The owner retires one: the question answers itself.
  o.eng.improver.updateLesson(no.id, { status: 'retired' });
  o.eng.improver.analyze();
  assert.equal(o.eng.core.improvements.require(imp.id).status, 'applied');
  assert.equal(o.events('learning.contradiction_closed').length, 1);
  // A dismissed one is not raised again.
  o.eng.improver.updateLesson(no.id, { status: 'active' });
  assert.equal(o.eng.improver.analyze().length, 0, 'the same pair has one suggestion, already decided');
});

test("two different answers of the boss to the same question are both kept and shown to the boss", async () => {
  const o = await office();
  const ask = (id: string, answer: string) => o.eng.improver.captureOwnerAnswer({ id, kind: 'decision', employeeId: o.alex.id, projectId: o.shop.id, taskId: null, text: 'Which of the two layouts do we ship for the dashboard page?', answer, answers: null } as any);
  ask('q1', 'the compact one');
  ask('q1', 'the compact one');
  assert.equal(o.lessons().length, 1, 'the same answer to the same question is one lesson');
  ask('q2', 'the compact one');
  assert.deepEqual(o.lessons()[0]!.evidence.map((e) => e.id), ['q1', 'q2']);
  ask('q3', 'the wide one');
  assert.equal(o.lessons().length, 2, 'a different answer is never folded into the first');
  const [imp] = o.eng.improver.analyze();
  assert.deepEqual([imp!.kind, imp!.title], ['playbook_contradiction', 'Two recorded decisions look like the same question']);
});

test('promotion: what a second employee of the project learns independently becomes a project lesson — proposed, or automatic with the setting', async () => {
  for (const auto of [false, true]) {
    const o = await office({ autoApproveSharedLessons: auto });
    const t1 = o.working(o.alex, 'Add the orders migration');
    o.eng.improver.recordFromAgent(o.alex, { lesson: 'Run the migration against a copy of the database before committing', applies_when: 'when writing a migration', why: 'verification failed on this task because the migration was only run on an empty database' });
    assert.equal(o.lessons().length, 1, 'one employee: theirs alone');
    // The same employee learning it twice is a merge, not a promotion.
    o.eng.improver.recordFromAgent(o.alex, { lesson: 'Run migrations on a database copy before you commit', applies_when: 'when writing a migration', why: 'verification failed on this task because the migration was only run on an empty database' });
    o.eng.improver.analyze();
    assert.deepEqual([o.lessons().length, o.events('learning.lesson_promoted').length], [1, 0]);

    const t2 = o.working(o.sarah, 'Add the invoices migration');
    o.eng.improver.recordFromAgent(o.sarah, { lesson: 'Before committing, run every migration on a copy of the database first', applies_when: 'when writing a migration', why: 'verification failed on this task because the migration was only run on an empty database' });
    const project = o.lessons().find((l) => l.scope === 'project')!;
    assert.ok(project, 'recorded by the second employee: promoted there and then');
    const own = o.lessons().filter((l) => l.scope === 'employee');
    assert.deepEqual(own.map((l) => [l.employeeId, l.status]), [[o.alex.id, 'active'], [o.sarah.id, 'active']], 'their own lessons stay theirs');
    assert.deepEqual([project.status, project.projectId, project.source, project.authoredBy.kind], [auto ? 'active' : 'proposed', o.shop.id, 'orchestrator', 'orchestrator']);
    assert.deepEqual([...project.playbook!.promotedFrom].sort(), own.map((l) => l.id).sort());
    assert.deepEqual(project.evidence.map((e) => e.id).sort(), [t1.id, t2.id].sort(), 'citing the tasks both learned it on');
    assert.equal(project.appliesWhen, 'when writing a migration');
    const [ev, ...more] = o.events('learning.lesson_promoted');
    assert.equal(more.length, 0);
    const d = ev!.data as any;
    assert.deepEqual([d.auto, d.area, d.proposed, d.lessonId, [...d.from].sort(), d.undo], [true, 'playbook', !auto, project.id, own.map((l) => l.id).sort(), { type: 'retire', lessonId: project.id }]);
    assert.match(ev!.summary, auto ? /(Alex and Sarah|Sarah and Alex) have the same lesson in their own playbooks; it is now a lesson for everyone on Shop/ : /is proposed as a lesson for everyone on Shop \(awaiting your approval\)/);
    assert.match(d.why, auto ? /approved automatically in this office \(setting: autoApproveSharedLessons\)/ : /wait for the owner/);
    assert.equal(o.eng.core.notifications.all().some((n) => /learned the same thing/.test(n.title)), !auto, 'the owner is asked only when it waits for them');

    // Not again on the periodic pass, and a third employee does not make a second one.
    o.eng.improver.analyze();
    const cy = o.eng.employees.create({ name: 'Cy', roleKey: 'backend', projectId: o.shop.id, hostId: 'host-1', workingDir: '/tmp/x' });
    o.eng.improver.recordFromOwner({ text: 'Run each migration on a database copy before committing', scope: 'employee', employeeId: cy.id });
    assert.equal(o.lessons().filter((l) => l.scope === 'project').length, 1);
    assert.equal(o.events('learning.lesson_promoted').length, 1);

    // In a prompt the employee is not told the same thing twice (their own wording and the project's).
    const task = o.working(o.alex, 'Write the refunds migration');
    const chosen = o.eng.improver.playbook.select(o.alex, task);
    assert.equal(chosen.chosen.length, 1);
    assert.deepEqual(chosen.leftOut.map((x) => x.why), auto ? ['duplicate'] : [], 'a proposed lesson is in no prompt yet');
    // Someone on the project who never recorded it gets it only once it is active.
    const dee = o.eng.employees.create({ name: 'Dee', roleKey: 'frontend', projectId: o.shop.id, hostId: 'host-1', workingDir: '/tmp/x' });
    assert.equal(o.eng.improver.playbook.select(dee, task).chosen.length, auto ? 1 : 0);

    // Undone (or, for a proposal, rejected): the project lesson is retired and is not proposed again.
    if (auto) assert.equal(o.eng.improver.playbook.revert(ev!.id).reverted, 'learning.lesson_promoted');
    else o.eng.improver.updateLesson(project.id, { status: 'retired' });
    assert.equal(o.eng.core.lessons.require(project.id).status, 'retired');
    o.eng.improver.analyze();
    assert.equal(o.lessons().filter((l) => l.scope === 'project').length, 1);
    assert.equal(o.events('learning.lesson_promoted').length, 1);
  }
});

test('promotion needs the same project: the same lesson in two projects stays with each employee', async () => {
  const o = await office({ autoApproveSharedLessons: true });
  const blog = await o.eng.tasks.createProject({ name: 'Blog', policy: { autoAssign: false } });
  const bo = o.eng.employees.create({ name: 'Bo', roleKey: 'backend', projectId: blog.id, hostId: 'host-1', workingDir: '/tmp/x' });
  o.working(o.alex, 'Add the orders migration');
  o.eng.improver.recordFromAgent(o.alex, { lesson: 'Run the migration against a copy of the database before committing', applies_when: 'when writing a migration', why: 'verification failed on this task because the migration was only run on an empty database' });
  o.eng.improver.recordFromOwner({ text: 'Run migrations on a database copy before you commit', scope: 'employee', employeeId: bo.id });
  o.eng.improver.analyze();
  assert.deepEqual(o.lessons().map((l) => l.scope), ['employee', 'employee']);
});
