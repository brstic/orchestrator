#!/usr/bin/env node
/**
 * Live UI exercise:  pnpm test:ui [--out <dir>]
 *
 * Starts the development office (a real server, a real host agent and real tmux
 * sessions; the workers run the fake-claude test fixture, so no tokens are spent),
 * opens the built office UI in Electron and drives it with real clicks, typing
 * and key presses (tests/ui/driver.cjs). Then it checks, on the server and on
 * disk, that what was clicked really happened.
 *
 * Needs the UI build (pnpm build:ui) and Electron (pnpm electron:repair).
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const outDir = argv.includes('--out') ? path.resolve(argv[argv.indexOf('--out') + 1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ui-'));
const electron = path.join(root, 'apps/desktop/node_modules/electron/dist', process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron');
if (!fs.existsSync(path.join(root, 'apps/desktop/dist/index.html'))) throw new Error('the UI is not built: run pnpm build:ui');
if (!fs.existsSync(electron)) throw new Error('Electron is not installed: run pnpm electron:repair');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// (`--review none`: the office of this suite is one whose tasks are done when they pass; the steps about review choose it per ticket.)
const office = spawn(process.execPath, [path.join(root, 'scripts/dev-office.ts'), '--port', String(port), '--review', 'none'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: root });
let officeErr = '';
office.stderr.on('data', (d) => (officeErr += d));
const info = await new Promise((resolve) => {
  readline.createInterface({ input: office.stdout }).on('line', (line) => {
    try {
      const j = JSON.parse(line);
      if (j.url) resolve(j);
    } catch {
      /* not the ready line */
    }
  });
  office.on('exit', () => resolve(null));
  setTimeout(() => resolve(null), 90000);
});
let exitCode = 1;
let station = null;
try {
  if (!info) throw new Error(`the development office did not start\n${officeErr.slice(-600)}`);
  const u = new URL(info.url);
  const token = u.searchParams.get('token');
  const api = async (p) => (await fetch(`${u.origin}/api${p}`, { headers: { authorization: `Bearer ${token}` } })).json();
  // Let the scripted workers reach the states the UI test acts on (a question and an approval waiting).
  for (let i = 0; i < 150; i++) {
    const s = await api('/state');
    if (s.questions.some((q) => q.status === 'open' && q.kind === 'permission') && s.questions.some((q) => q.status === 'open' && q.kind === 'question')) break;
    await sleep(200);
  }
  const hireFolder = path.join(fs.realpathSync(info.base), 'quinn-notes');
  fs.mkdirSync(hireFolder);
  fs.writeFileSync(path.join(hireFolder, 'README.md'), '# quinn-notes\n');
  fs.mkdirSync(path.join(hireFolder, 'docs'));
  fs.writeFileSync(path.join(hireFolder, 'docs', 'GUIDE.md'), '# Guide\n\n| Step | Who |\n| --- | --- |\n| Write | Quinn |\n\n- one\n- two\n\n```sh\nnpm test\n```\n');
  // Several project folders to hire for in one go: two repositories and a plain folder.
  const portfolio = path.join(fs.realpathSync(info.base), 'portfolio');
  for (const [name, isRepo] of [['xagio-panel', true], ['ai_tuner', true], ['client notes', false]]) {
    const dir = path.join(portfolio, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`);
    if (!isRepo) continue;
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.test', 'commit', '-q', '-m', 'init'], { cwd: dir });
  }
  const projectRepo = path.join(fs.realpathSync(info.base), 'ui-made-project');
  fs.mkdirSync(projectRepo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectRepo });
  fs.writeFileSync(path.join(projectRepo, 'README.md'), '# ui-made-project\n');
  execFileSync('git', ['add', '-A'], { cwd: projectRepo });
  execFileSync('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.test', 'commit', '-q', '-m', 'init'], { cwd: projectRepo });
  // A second machine that enrolled once and is now offline: something to rename and remove in Machines.
  const { token: spareToken } = await (await fetch(`${u.origin}/api/hosts/enroll-token`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'spare' }) })).json();
  await new Promise((resolve) => {
    const ws = new WebSocket(`${u.origin.replace('http', 'ws')}/ws/agent`);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, enrollmentToken: spareToken, enrollOnly: true, name: 'spare-box', info: { hostname: 'spare-box' } }));
    ws.onmessage = () => {
      ws.close();
      resolve();
    };
    ws.onerror = resolve;
  });
  const post = async (p, body) => (await fetch(`${u.origin}/api${p}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const waitState = async (label, fn, ms = 40000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn(await api('/state'));
      if (v) return v;
      if (Date.now() > end) throw new Error(`setup: timed out waiting for ${label}`);
      await sleep(250);
    }
  };
  const s0 = await api('/state');
  const E = (n) => s0.employees.find((e) => e.name === n);
  // A change for the owner to review by hand: its appointed reviewer is busy with a long task.
  const toReview = await post('/tasks', { projectId: E('Noor').projectId, title: 'Owner-reviewed change', assigneeId: E('Noor').id, requiresReview: true, reviewerId: E('Alex').id, description: '@@fake: write owner-review.txt please-look; commit owner reviewed change; complete ready for review@@' });
  await waitState('a task waiting for review', (s) => s.tasks.find((t) => t.id === toReview.id && t.status === 'REVIEW'));
  // Three approvals of the same kind of command: Orchestrator should suggest a rule.
  const pia = await post('/employees', { name: 'Pia', roleKey: 'devops', projectId: E('Noor').projectId, hostId: E('Noor').hostId, autonomy: 'supervised' });
  await post(`/employees/${pia.id}/start`, {});
  const piaIdle = () => waitState('Pia idle', (s) => s.sessions.find((x) => x.employeeId === pia.id && x.status === 'running' && x.inTurn === false));
  await piaIdle();
  for (let i = 0; i < 3; i++) {
    await post(`/employees/${pia.id}/message`, { body: `build ${i} @@fake: bash docker build -t app:${i} --help >/dev/null 2>&1 || true@@` });
    const q = await waitState(`approval ${i}`, (s) => s.questions.find((x) => x.employeeId === pia.id && x.kind === 'permission' && x.status === 'open'));
    await post(`/questions/${q.id}/answer`, { decision: 'allow' });
    await waitState(`approval ${i} settled`, (s) => !s.questions.some((x) => x.id === q.id && x.status === 'open'));
    await piaIdle();
  }
  await waitState('a rule suggestion', (s) => s.improvements.find((x) => x.kind === 'allow_rule' && x.status === 'proposed'));
  // Planning work: while Pia thinks it through she stands at the project board in the office.
  const planning = await post('/tasks', { projectId: E('Noor').projectId, title: 'Plan the release rollout', kind: 'planning', assigneeId: pia.id, description: '@@fake: progress drafting the rollout plan; sleep 600000@@' });
  await waitState('the planning task in progress', (s) => s.tasks.find((t) => t.id === planning.id && t.status === 'IN_PROGRESS'));
  // A Claude-looking tmux session that Orchestrator did not start, for the attach dialog.
  const devSock = /-L (\S+)/.exec(info.tmux)[1];
  const legacyDir = path.join(fs.realpathSync(info.base), 'legacy');
  fs.mkdirSync(legacyDir);
  execFileSync('tmux', ['-L', devSock, 'new-session', '-d', '-s', 'legacy-claude', '-c', legacyDir, path.join(info.base, 'fake-claude')]);
  const legacyPid = execFileSync('tmux', ['-L', devSock, 'list-panes', '-t', 'legacy-claude', '-F', '#{pane_pid}'], { encoding: 'utf8' }).trim();
  // Things to delete and archive from the UI.
  const throwaway = await post('/tasks', { projectId: E('Noor').projectId, title: 'Throwaway task', description: 'Never released.', released: false });
  const temp = await post('/employees', { name: 'Temp', roleKey: 'docs', projectId: E('Noor').projectId, hostId: E('Noor').hostId });
  const manual = await post('/tasks', { projectId: E('Noor').projectId, title: 'Done by hand', description: 'The owner did this themselves.', released: false });
  // A meeting that cannot finish on its own (both participants are in the middle of long tasks).
  const cancelTopic = 'A meeting that gets cancelled';
  const toCancel = await post('/meetings', { topic: cancelTopic, projectId: E('Noor').projectId, participantIds: [E('Alex').id, E('Sarah').id] });
  if (!toCancel.id) throw new Error(`setup: could not start the meeting to cancel: ${JSON.stringify(toCancel).slice(0, 200)}`);
  // A local "radio station" (three minutes of silence, and what it says is on air), so the hi-fi needs no internet here.
  const wav = (() => {
    const rate = 8000;
    const n = rate * 180;
    const b = Buffer.alloc(44 + n, 128);
    b.write('RIFF', 0);
    b.writeUInt32LE(36 + n, 4);
    b.write('WAVEfmt ', 8);
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20);
    b.writeUInt16LE(1, 22);
    b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate, 28);
    b.writeUInt16LE(1, 32);
    b.writeUInt16LE(8, 34);
    b.write('data', 36);
    b.writeUInt32LE(n, 40);
    return b;
  })();
  station = http.createServer((req, res) => {
    if (req.url.startsWith('/now')) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ now_playing: { song: { text: 'The Testers - Local Tone' } } }));
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length }).end(wav);
  });
  await new Promise((r) => station.listen(0, '127.0.0.1', r));
  const stationAt = `http://127.0.0.1:${station.address().port}`;
  const ctx = {
    tableLabel: 'Payments crew',
    radioName: 'Test FM',
    radioUrl: `${stationAt}/stream.wav`,
    radioNow: `${stationAt}/now`,
    radioTitle: 'The Testers - Local Tone',
    manualTaskId: manual.id,
    planner: 'Pia',
    planningTaskId: planning.id,
    roomName: 'War Room',
    cancelTopic,
    throwawayTaskId: throwaway.id,
    tempEmployee: 'Temp',
    lessonWhen: 'before every commit',
    denyRule: 'Bash(rm -rf:*)',
    reviewTaskId: toReview.id,
    spareHost: 'spare-box',
    spareRenamed: 'spare-renamed',
    hireName: 'Quinn',
    hireFolder,
    taskTitle: 'Add a UI-created marker',
    taskDescription: 'Created through the task form. @@fake: write ui-marker.txt made-through-the-ui; commit add ui marker; complete marker added@@',
    hireFolderName: 'quinn-notes',
    talkMessage: 'Quick check from the UI test @@fake: say pong-from-ava-7341 is **confirmed**, see `status`@@',
    talkReply: 'pong-from-ava-7341',
    typedPrompt: 'typed at the workstation @@fake: say typed-in-xterm-9152@@',
    typedReply: 'typed-in-xterm-9152',
    ownerName: 'Boss Tester',
    lesson: 'Always run the linter before committing UI changes',
    meetingTopic: 'Where should the UI test artefacts live?',
    instructions: 'Prefer small pull requests.',
    projectName: 'UI Made Project',
    projectRepo,
    command: 'pause Customer Platform',
    commandPreview: 'Pause Customer Platform',
  };
  fs.mkdirSync(outDir, { recursive: true });
  const ctxFile = path.join(outDir, 'context.json');
  fs.writeFileSync(ctxFile, JSON.stringify(ctx));
  const before = await api('/state');

  // What an earlier run left in this folder is not this run's result: a driver that is stopped before it has
  // written anything must not be read as the one that passed last time (it was, on 2026-11-12).
  const resultsFile = path.join(outDir, 'results.json');
  fs.rmSync(resultsFile, { force: true });
  const driver = spawn(electron, [path.join(root, 'tests/ui/driver.cjs'), info.url, outDir, ctxFile], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } });
  const code = await new Promise((resolve) => {
    driver.on('exit', resolve);
    setTimeout(() => {
      driver.kill('SIGKILL');
      resolve('timeout');
    }, 420000);
  });
  if (!fs.existsSync(resultsFile)) throw new Error(code === 'timeout' ? 'the UI driver was stopped after seven minutes without finishing: its steps are failing or waiting (see the FAILED-… pictures in the output folder)' : `the UI driver produced no results (exit ${code})`);
  const res = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  console.log('In the UI (real clicks, typing and key presses):');
  for (const r of res.results) check(r.step, r.ok, r.detail);
  if (res.fatal) check(`driver: ${res.fatal}`, false);
  if (res.pageWarnings.length) console.log(`  (${res.pageWarnings.length} console warning(s): ${res.pageWarnings.slice(0, 3).join(' | ').slice(0, 300)})`);

  console.log('\nOn the server and on disk (what those clicks really did):');
  const s = await api('/state');
  const usage = await api('/usage');
  const events = await api('/events?limit=1000');
  const audit = await api('/audit');
  const by = (name) => s.employees.find((e) => e.name === name);
  const q1 = s.questions.find((q) => q.kind === 'question' && /remember the user/.test(q.text));
  check('the clicked answer reached the waiting agent', q1?.answer === 'Option A' || Object.values(q1?.answers ?? {}).includes('Option A'), `status ${q1?.status}, answer ${JSON.stringify(q1?.answer ?? q1?.answers)}`);
  const perm = s.questions.find((q) => q.kind === 'permission' && q.decision === 'allow');
  const david = by('David');
  const davidTask = s.tasks.find((t) => t.assigneeId === david.id);
  const pipeline = davidTask?.worktree ? path.join(davidTask.worktree, 'pipeline.txt') : null;
  let wrote = false;
  for (let i = 0; i < 40 && pipeline && !(wrote = fs.existsSync(pipeline)); i++) await sleep(250);
  check('the approval let the real write happen', !!perm && wrote, `${perm?.tool?.name ?? '?'} → ${pipeline ?? 'no worktree'}`);
  check('the approval is in the audit log', audit.some((a) => a.action === 'approval.decide'));
  const routineRuns = s.messages.filter((m) => m.routineId && m.toEmployeeId === by('Ava').id);
  check('the routine made in the Talk window was a real one: created, run once into Ava\'s session, paused and removed, all on the record', routineRuns.length === 1 && routineRuns[0].delivery.status === 'confirmed' && /^Routine \(every 5 min\): Check the queue/.test(routineRuns[0].body) && (s.routines ?? []).length === 0 && ['routine.created', 'routine.updated', 'routine.removed'].every((x) => audit.some((a) => a.action === x)), `${routineRuns.length} run(s), ${routineRuns[0]?.delivery.status}; ${(s.routines ?? []).length} routines left`);
  const quinn = by('Quinn');
  const quinnSession = s.sessions.find((x) => x.employeeId === quinn?.id);
  const quinnProject = s.projects.find((p) => p.id === quinn?.projectId);
  const madeFolder = path.join(fs.realpathSync(info.base), 'made-in-the-form');
  check('the folder made from the hire form exists on the machine, empty', fs.existsSync(madeFolder) && fs.readdirSync(madeFolder).length === 0, madeFolder);
  check('the hired employee exists, owns the folder as an in-place project, and has a real session', !!quinn && quinnProject?.repoPath === hireFolder && quinnProject?.workspace === 'in_place' && quinnSession?.status === 'running' && quinnSession?.cwd === hireFolder, `${quinnProject?.name} @ ${quinnSession?.cwd} (${quinnSession?.tmuxSession})`);
  const task = s.tasks.find((t) => t.title === ctx.taskTitle);
  check('the task made in the form was done by a real session and verified', task?.status === 'DONE' && task?.evidence?.verification?.passed === true && task?.evidence?.commits?.length === 1, `${task?.key} ${task?.status}, verification ${task?.evidence?.verification?.provenance}`);
  const ava = by('Ava');
  const msg = s.messages.find((m) => m.toEmployeeId === ava.id && m.body.includes('Quick check from the UI test')) ?? s.messages.find((m) => m.body?.includes('Quick check from the UI test'));
  check('the message typed in the talk panel was delivered and confirmed', msg?.delivery?.status === 'confirmed', `delivery ${msg?.delivery?.status} via ${msg?.delivery?.via}`);
  const rev = by('Rev');
  const typed = events.find((e) => e.employeeId === rev.id && e.type === 'agent.turn_finished' && String(e.data?.lastMessage ?? '').includes(ctx.typedReply));
  check('what was typed at the workstation ran as a turn in the real session', !!typed);
  const control = audit.filter((a) => /control/.test(a.action)).map((a) => a.action);
  check('taking and returning control was recorded', control.some((a) => /acquire|taken|take/.test(a)) && control.some((a) => /release|returned|return/.test(a)), [...new Set(control)].join(', '));
  const settings = s.settings;
  check('the owner name typed in Settings is stored', settings.ownerName === ctx.ownerName, settings.ownerName);
  const tokenStep = res.results.find((x) => /enrollment token/.test(x.step));
  const enrollReply = tokenStep?.ok
    ? await new Promise((resolve) => {
        const ws = new WebSocket(`${u.origin.replace('http', 'ws')}/ws/agent`);
        ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', protocol: 1, enrollmentToken: tokenStep.detail, enrollOnly: true, name: 'enrolled-with-ui-token', info: { hostname: 'ui-token-host' } }));
        ws.onmessage = (ev) => {
          resolve(JSON.parse(String(ev.data)));
          ws.close();
        };
        ws.onerror = () => resolve({ t: 'error' });
      })
    : { t: 'no token' };
  check('the enrollment token shown in Machines really enrolls a machine', enrollReply.t === 'welcome', enrollReply.t);
  check('the desk pod added in Office is in the stored layout (four desks, minus the one removed again, plus the seat added to a table)', s.layout.desks.length === before.layout.desks.length + 4, `${before.layout.desks.length} → ${s.layout.desks.length} desks`);
  const lesson = s.lessons.find((l) => l.text === ctx.lesson);
  check('the lesson taught in Growth is stored as an active owner lesson', !!lesson && lesson.status === 'active', lesson ? `${lesson.scope} / ${lesson.source} / applies ${lesson.appliesWhen ?? '—'}` : 'missing');
  const meeting = s.meetings.find((m) => m.topic === ctx.meetingTopic);
  const proposers = new Set((meeting?.contributions ?? []).filter((c) => c.round === 'proposal').map((c) => c.employeeId));
  check('the meeting started in Meetings got real contributions from both sessions and a decision', meeting?.status === 'concluded' && proposers.has(ava.id) && proposers.has(rev.id) && /Adopt the HTTP boundary/.test(meeting?.decisionDoc ?? ''), `${meeting?.contributions?.length ?? 0} contributions`);
  check('the standing instructions edited in Team are stored', by('Ava').instructions === ctx.instructions);
  const quinnNow = s.sessions.find((x) => x.employeeId === quinn?.id && x.status === 'running');
  check('the session stopped and started from the UI is the same record, running again', !!quinnNow && audit.some((a) => a.action === 'session.stopped') && audit.some((a) => a.action === 'session.resumed' || a.action === 'session.started'), quinnNow?.tmuxSession ?? 'not running');
  check('the interrupt from the Session tab was a real one', events.some((e) => e.type === 'terminal.interrupt' && e.employeeId === by('Mike').id) && audit.some((a) => a.action === 'session.interrupted'));
  const made = s.projects.find((p) => p.name === ctx.projectName);
  check('the project created in Projects points at the real repository and is active again', made?.repoPath === projectRepo && made?.status === 'active', `${made?.repoPath} (${made?.status})`);
  check('the lesson retired and reactivated from its card is active, with both changes on record', s.lessons.find((l) => l.text === ctx.lesson)?.status === 'active' && events.filter((e) => e.type === 'improvement.lesson_updated').length >= 2, `${events.filter((e) => e.type === 'improvement.lesson_updated').length} lesson updates`);
  const hair = res.results.find((x) => /appearance/.test(x.step))?.detail ?? '';
  check('the appearance change is stored', hair.endsWith(by('Ava').appearance.hairStyle) && by('Ava').appearance.hairStyle !== before.employees.find((e) => e.name === 'Ava').appearance.hairStyle, `Ava: ${before.employees.find((e) => e.name === 'Ava').appearance.hairStyle} → ${by('Ava').appearance.hairStyle}`);
  const dragged = /^(\S+): (\w+) → (\w+)$/.exec(res.results.find((x) => /dragging a card/.test(x.step))?.detail ?? '');
  const draggedTask = dragged ? s.tasks.find((t) => t.key === dragged[1]) : null;
  check('the task dragged on the board has its new status on the server', !!draggedTask && draggedTask.status !== dragged[2] && draggedTask.history.some((x) => x.status === dragged[3]), dragged ? `${dragged[1]} was moved to ${dragged[3]} (now ${draggedTask?.status}: the scheduler took it from there)` : 'no drag result');
  check('the machine renamed and removed in Machines is gone from the office', before.hosts.some((h) => h.name === ctx.spareHost) && !s.hosts.some((h) => h.name === ctx.spareHost || h.name === ctx.spareRenamed), `${before.hosts.length} → ${s.hosts.length - 1} machines (plus the one enrolled with the UI token)`);
  // Graphics, keys and the office extras are each person's own: kept on their computer, never sent to the office.
  const mine = (() => {
    try {
      return JSON.parse(res.results.find((x) => /preferences, as they are stored at the end/.test(x.step))?.detail ?? 'null');
    } catch {
      return null;
    }
  })();
  const settingsAudited = audit.filter((a) => a.action === 'settings.changed').flatMap((a) => a.detail?.changed ?? []);
  const clientFields = ['quality', 'keybindings', 'projectZones', 'approachZoom'];
  check('the key binding captured and reset is back to its default, on this computer', mine?.keybindings?.forward === before.settings.keybindings.forward && /→ KeyI →/.test(res.results.find((x) => /key binding is captured/.test(x.step))?.detail ?? ''), `forward = ${mine?.keybindings?.forward}`);
  check('the graphics quality changed in Settings was kept on this computer, and the office\'s own setting did not change', /^this computer: (\w+) → (\w+) → \1;/.test(res.results.find((x) => /graphics quality is chosen for this computer/.test(x.step))?.detail ?? '') && mine?.quality === before.settings.quality && s.settings.quality === before.settings.quality, `this computer: ${mine?.quality}; the office: ${before.settings.quality} → ${s.settings.quality}`);
  check('nothing a person chose for their own computer reached the office: its settings and its audit log have none of it', clientFields.every((f) => JSON.stringify(s.settings[f]) === JSON.stringify(before.settings[f])) && !settingsAudited.some((f) => clientFields.includes(f)), `office settings changed during the run: ${[...new Set(settingsAudited)].join(', ') || 'none'}`);
  const avaReport = events.find((e) => e.employeeId === ava.id && /report/i.test(e.summary) && e.ts > before.sessions.reduce((m, x) => (x.startedAt > m ? x.startedAt : m), ''));
  check('the report requested from the right-click menu was asked of the real session', !!avaReport || s.artifacts.some((a) => a.kind === 'report' && /ava/i.test(a.title)), avaReport?.summary ?? s.artifacts.filter((a) => a.kind === 'report').map((a) => a.title).join(', '));
  const reviewedByOwner = s.tasks.find((t) => t.id === ctx.reviewTaskId);
  check('the change approved by the owner in the task panel was merged, with the owner on record as reviewer', reviewedByOwner?.status === 'DONE' && reviewedByOwner?.evidence?.review?.by === 'owner' && reviewedByOwner?.evidence?.review?.verdict === 'approved' && reviewedByOwner?.evidence?.merge?.ok === true, `${reviewedByOwner?.key} ${reviewedByOwner?.status}, reviewed by ${reviewedByOwner?.evidence?.review?.by}`);
  const legacy = s.sessions.find((x) => x.tmuxSession === 'legacy-claude');
  const legacyPidNow = execFileSync('tmux', ['-L', devSock, 'list-panes', '-t', 'legacy-claude', '-F', '#{pane_pid}'], { encoding: 'utf8' }).trim();
  check('the existing tmux session was attached without being restarted', legacy?.origin === 'attached' && legacy?.status === 'running' && legacyPidNow === legacyPid, `pid ${legacyPid} → ${legacyPidNow}, origin ${legacy?.origin}`);
  check('the schedule is back to what it was', JSON.stringify(by('Ava').schedule) === JSON.stringify(before.employees.find((e) => e.name === 'Ava').schedule));
  const rule = s.improvements.find((x) => x.kind === 'allow_rule');
  check('the suggestion applied in Growth changed the real project policy, and is in the audit log', rule?.status === 'applied' && s.projects.find((p) => p.id === E('Noor').projectId).policy.allow.includes('Bash(docker build:*)') && audit.some((a) => /improvement/.test(a.action)), `${rule?.title ?? ''} → ${rule?.status}`);
  const markedAt = / at (\S+)$/.exec(res.results.find((x) => /Mark all read/.test(x.step))?.detail ?? '')?.[1];
  check('the lesson edited in place has its new condition', s.lessons.find((l) => l.text === ctx.lesson)?.appliesWhen === ctx.lessonWhen);
  check('the deny rule typed on the Policy tab is in the project policy', made?.policy?.deny?.includes(ctx.denyRule) === true);
  check('the deleted task is gone from the server', !s.tasks.some((t) => t.id === ctx.throwawayTaskId) && before.tasks.some((t) => t.id === ctx.throwawayTaskId));
  check('the archived employee is archived on the server', by('Temp')?.archived === true);
  const cmdAudit = audit.filter((a) => /project\.(paused|resumed)|command/.test(a.action)).map((a) => a.action);
  check('the commands typed in the command bar really paused and resumed the project', made?.status === 'active' && audit.filter((x) => x.action === 'command.execute').length >= 2, `${audit.filter((x) => x.action === 'command.execute').length} commands executed and audited; project is ${made?.status}`);
  const byHand = s.tasks.find((t) => t.id === ctx.manualTaskId);
  check('the task marked done by hand is DONE and recorded as unverified', byHand?.status === 'DONE' && !byHand?.evidence?.verification && byHand?.history?.some((x) => x.status === 'DONE' && x.by === 'owner'), `${byHand?.key} ${byHand?.status}; verification: ${byHand?.evidence?.verification ? 'present' : 'none'}`);
  const cancelled = s.meetings.find((m) => m.topic === ctx.cancelTopic);
  check('the cancelled meeting is cancelled on the server, with no decision written', cancelled?.status === 'cancelled' && !cancelled?.decisionDoc);
  check('the pause from the right-click menu was a real interrupt of that session', events.some((e) => e.type === 'terminal.interrupt' && e.employeeId === ava.id));
  check('every notification that existed when "Mark all read" was pressed is read', !!markedAt && s.notifications.filter((n) => n.createdAt <= markedAt && !n.resolvedAt && !n.readAt).length === 0, `${s.notifications.filter((n) => n.createdAt <= (markedAt ?? '')).length} notifications up to then`);
  const fm = s.settings.radio.stations.find((x) => x.name === ctx.radioName);
  check('the station added at the hi-fi is saved with the office and noted as the last one played; the volume set there stayed on this computer', fm?.url === ctx.radioUrl && fm?.nowPlayingUrl === ctx.radioNow && s.settings.radio.lastStationId === fm?.id && s.settings.radio.volume === before.settings.radio.volume, `${fm?.name} @ ${fm?.url}, the office's volume ${before.settings.radio.volume} → ${s.settings.radio.volume}`);
  const whipTrace = [...events, ...audit].filter((x) => /whip/i.test(JSON.stringify(x)));
  check('the whip left no trace on the server: no event, no audit entry, no message', whipTrace.length === 0 && !s.messages.some((m) => /whip/i.test(m.body ?? '')), `${whipTrace.length} traces`);
  const bulk = ['XagioPanel', 'AiTuner', 'Scribe'].map((n) => by(n));
  const bulkFolders = ['xagio-panel', 'ai_tuner', 'client notes'].map((f) => path.join(portfolio, f));
  check(
    // (Unrestricted: what an owner's hires start as since 2026-11-11.)
    'everyone hired in bulk lives in their own folder, which became their project, and none of them was started',
    bulk.every((e, i) => e?.workingDir === bulkFolders[i] && s.projects.find((p) => p.id === e.projectId)?.workspace === 'in_place' && s.projects.find((p) => p.id === e.projectId)?.repoPath === bulkFolders[i] && e.autonomy === 'unrestricted') && !s.sessions.some((x) => bulk.some((e) => e?.id === x.employeeId)),
    bulk.map((e) => `${e?.name} → ${s.projects.find((p) => p.id === e?.projectId)?.name}`).join(', '),
  );
  const seated = s.employees.filter((e) => !e.archived && e.deskId);
  check('the seats chosen in the office are the stored ones: Ava and Rev swapped, Scribe moved, and no desk has two people', by('Ava')?.deskId === before.employees.find((e) => e.name === 'Rev')?.deskId && !!by('Scribe')?.deskId && by('Rev')?.deskId !== before.employees.find((e) => e.name === 'Rev')?.deskId && new Set(seated.map((e) => e.deskId)).size === seated.length, `Ava ${by('Ava')?.deskId}, Rev ${by('Rev')?.deskId}, Scribe ${by('Scribe')?.deskId}`);
  check('the two office extras switched on in Settings are stored on this computer (both are off by default), and stay off in the office', before.settings.projectZones === false && before.settings.approachZoom === false && mine?.projectZones === true && mine?.approachZoom === true && s.settings.projectZones === false && s.settings.approachZoom === false);
  check('the label written on a table and its extra seat are in the stored layout', Object.values(s.layout.podLabels ?? {}).includes(ctx.tableLabel) && s.layout.desks.some((d) => /-[e-h]$/.test(d.id)), JSON.stringify(s.layout.podLabels));
  check('the employee put on another Claude account kept it', s.employees.find((e) => e.name === 'Ava')?.claudeConfigDir === '~/.claude-second', String(s.employees.find((e) => e.name === 'Ava')?.claudeConfigDir));
  check('the office recorded what Claude Code said about the account limits', usage.some((a) => a.email === 'dev@example.test' && a.sevenDay?.usedPercent === 85 && a.fiveHour?.usedPercent === 42), JSON.stringify(usage));
  check('the previewed command changed nothing', s.projects.find((p) => p.name === 'Customer Platform')?.status === before.projects.find((p) => p.name === 'Customer Platform')?.status);
  // The office editor and the 3D office.
  const step = (re) => res.results.find((x) => re.test(x.step));
  const podMove = /^pod (\S+): x (-?[\d.]+) → (-?[\d.]+)/.exec(step(/desk pod is moved with the arrow/)?.detail ?? '');
  const podDesk = podMove ? s.layout.desks.find((d) => d.id === podMove[1]) : null;
  const podBefore = podMove ? before.layout.desks.find((d) => d.id === podMove[1]) : null;
  check('the desk pod moved in the Office panel stands where it was put, in the stored layout', !!podDesk && !!podBefore && Math.abs(podDesk.x - Number(podMove[3])) < 1e-6 && Math.abs(podDesk.x - podBefore.x - 0.5) < 1e-6, podMove ? `${podMove[1]}: x ${podBefore?.x} → ${podDesk?.x}` : 'no result from the UI');
  const dragged2 = /^pod (\S+) dragged (-?[\d.]+) m south/.exec(step(/dragged on the floor plan/)?.detail ?? '');
  const dragDesk = dragged2 ? s.layout.desks.find((d) => d.id === dragged2[1]) : null;
  const dragBefore = dragged2 ? before.layout.desks.find((d) => d.id === dragged2[1]) : null;
  check('the desk pod dragged on the plan is stored at the new place; the refused drop changed nothing', !!dragDesk && Number(dragged2[2]) > 0 && (!dragBefore || Math.abs(dragDesk.z - dragBefore.z - Number(dragged2[2])) < 1e-6), dragged2 ? `${dragged2[1]}: z ${dragBefore?.z ?? '(new pod)'} → ${dragDesk?.z}` : 'no result from the UI');
  const ids = (l) => l.decorations.map((d) => d.id).sort().join(',');
  check('the decoration added and removed left the stored decorations as they were, and every edit of the floor plan is audited', ids(s.layout) === ids(before.layout) && audit.filter((a) => a.action === 'office.layout_updated').length >= 8, `${s.layout.decorations.length} decorations; ${audit.filter((a) => a.action === 'office.layout_updated').length} layout updates audited`);
  const roomNow = (id) => s.layout.rooms.find((r) => r.id === id);
  const roomWas = (id) => before.layout.rooms.find((r) => r.id === id);
  check('the renamed room and the moved wall are in the stored layout, and the neighbouring room gave up the strip', roomNow('meeting').name === ctx.roomName && Math.abs(roomNow('meeting').w - roomWas('meeting').w - 0.5) < 1e-6 && Math.abs(roomNow('ops').x - roomWas('ops').x - 0.5) < 1e-6 && Math.abs(roomNow('ops').w - roomWas('ops').w + 0.5) < 1e-6, `${roomWas('meeting').name} ${roomWas('meeting').w} m → ${roomNow('meeting').name} ${roomNow('meeting').w} m; ops ${roomWas('ops').w} → ${roomNow('ops').w} m`);
  const plan = s.tasks.find((t) => t.id === ctx.planningTaskId);
  check('the employee who stood at the project board really has a planning task in progress', plan?.kind === 'planning' && plan?.status === 'IN_PROGRESS' && plan?.assigneeId === by(ctx.planner)?.id, `${plan?.key} ${plan?.kind} ${plan?.status}`);
  const shown = step(/whiteboard shows the last decision/)?.detail ?? '';
  check('what the whiteboard showed is the stored decision of that meeting', !!meeting?.decisionDoc && shown.includes(meeting.topic) && /Adopt the HTTP boundary/.test(shown) && meeting.decisionDoc.includes('Adopt the HTTP boundary'), shown.slice(0, 120));
  const zone = /^sign "([^"]+)": (\d+) in progress, (\d+) blocked, (\d+) done/.exec(step(/project zone/)?.detail ?? '');
  const zoneProject = zone ? s.projects.find((p) => p.name === zone[1]) : null;
  check('the project zone sign named a real project that people sit in', !!zoneProject && s.employees.some((e) => !e.archived && e.projectId === zoneProject.id && e.deskId), zone ? `${zone[1]}: ${zone[2]}/${zone[3]}/${zone[4]} when it was read` : 'no result from the UI');
  console.log(`\nscreenshots and results: ${outDir}`);
  exitCode = checks.every(Boolean) ? 0 : 1;
} catch (e) {
  console.log(`✖ ${e.message}`);
} finally {
  station?.close();
  office.kill('SIGTERM');
  for (let i = 0; i < 50 && office.exitCode === null; i++) await sleep(100);
}
console.log(`\n${checks.filter(Boolean).length}/${checks.length} checks passed`);
process.exit(exitCode);
