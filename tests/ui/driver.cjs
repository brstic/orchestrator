/**
 * UI exercise driver (runs inside Electron's main process; started by tests/ui/run.mjs).
 *
 *   electron tests/ui/driver.cjs <office-url> <out-dir> <context.json>
 *
 * Loads the real office UI and uses it the way a person does — real mouse
 * clicks at the element's position, real text input, real key presses — then
 * writes what happened to <out-dir>/results.json. The runner checks the
 * effects on the server side.
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [url, outDir, ctxFile] = process.argv.slice(2);
const ctx = JSON.parse(fs.readFileSync(ctxFile, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pageErrors = [];
const pageWarnings = [];
let win;
/** The step that is running, so an error in the page can be traced to what was being done. */
let currentStep = 'loading';

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-webgl');

const js = (code) => win.webContents.executeJavaScript(code, true);

const HELPERS = `
window.__errs = [];
window.addEventListener('error', (e) => window.__errs.push('error: ' + (e.message || e.type)));
window.addEventListener('unhandledrejection', (e) => window.__errs.push('unhandled rejection: ' + (e.reason && e.reason.message || e.reason)));
window.__t = {
  visible(el) { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; },
  /** The topmost thing a person is looking at: the open window, the workstation, or the page. */
  scope() { const w = document.querySelectorAll('.win'); return w.length ? w[w.length - 1] : document.querySelector('.cmd') || document.querySelector('.ws') || document.body; },
  byText(text, sel = 'button', scope) {
    const all = [...(scope || this.scope()).querySelectorAll(sel)].filter((e) => this.visible(e) && !e.disabled);
    return all.find((e) => e.textContent.trim() === text) || all.find((e) => e.textContent.trim().startsWith(text)) || null;
  },
  field(label, scope) {
    const l = [...(scope || this.scope()).querySelectorAll('label, .field')].find((e) => this.visible(e) && e.textContent.trim().startsWith(label));
    return l ? l.querySelector('input, textarea, select') : null;
  },
  point(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(x, y);
    return { x, y, hit: !!top && (el === top || el.contains(top) || top.contains(el)), top: top ? top.tagName + '.' + top.className : null };
  },
  submit(text, scope) { return [...(scope || this.scope()).querySelectorAll('button[type=submit]')].find((b) => this.visible(b) && !b.disabled && b.textContent.trim() === text) || null; },
  /** The checkbox of the row (a <label>) that mentions this text. */
  checkbox(text, scope) { const l = [...(scope || this.scope()).querySelectorAll('label')].find((e) => this.visible(e) && e.querySelector('input[type=checkbox]') && e.textContent.trim().startsWith(text)); return l ? l.querySelector('input[type=checkbox]') : null; },
  /** The button with this label that belongs to the smallest block mentioning the text (e.g. one card in a list). */
  near(text, label, scope) {
    const leaf = [...(scope || this.scope()).querySelectorAll('*')].filter((e) => this.visible(e) && e.children.length === 0 && e.textContent.includes(text)).pop();
    for (let c = leaf; c && c !== document.body; c = c.parentElement) {
      const b = [...c.querySelectorAll('button')].find((x) => this.visible(x) && !x.disabled && x.textContent.trim() === label);
      if (b) return b;
    }
    return null;
  },
  setSelect(sel, value) { Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, value); sel.dispatchEvent(new Event('change', { bubbles: true })); },
  emp(name) { return Object.values(window.__office.getState().employees).find((e) => e.name === name); },
  store() { return window.__office.getState(); },
};
true;
`;

async function waitFor(code, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await js(`(() => { try { return (${code}); } catch (e) { return null; } })()`).catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${code.slice(0, 140)}`);
    await sleep(120);
  }
}

/** A real click: the mouse goes to where the element is. Fails if something else is on top of it. */
async function click(finder, what = finder) {
  await waitFor(`!!(${finder})`, 15000);
  const p = await js(`window.__t.point(${finder})`);
  if (!p.hit) throw new Error(`${what} is covered by ${p.top} — a person could not click it`);
  win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(120);
}
const clickText = (text, sel = 'button') => click(`window.__t.byText(${JSON.stringify(text)}, ${JSON.stringify(sel)})`, `"${text}"`);

/** Real text input into a field: click it, select what is there, type. */
async function type(finder, text) {
  await click(finder);
  // Select what is there the way Cmd+A in the field does, then type over it.
  await js(`(() => { const el = ${finder}; if (el) { el.focus(); if (el.select) el.select(); } return true; })()`);
  await sleep(60);
  await win.webContents.insertText(text);
  await sleep(80);
}
async function key(keyCode, char) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  if (char) win.webContents.sendInputEvent({ type: 'char', keyCode: char });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await sleep(120);
}
async function shot(name) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
}
async function step(name, fn) {
  const started = Date.now();
  currentStep = name;
  try {
    const detail = await fn();
    results.push({ step: name, ok: true, detail: detail || '', ms: Date.now() - started });
  } catch (e) {
    results.push({ step: name, ok: false, detail: e.message, ms: Date.now() - started });
    await shot(`FAILED-${name.replace(/[^a-z0-9]+/gi, '-').slice(0, 40)}`).catch(() => undefined);
    // Leave whatever was open, so one failure does not cascade.
    await js(`(() => { const s = window.__t.store(); s.openPanel(null); s.setCommandOpen(false); if (s.workstationId) s.leaveWorkstation(); })()`).catch(() => undefined);
  }
}

/** Right-click the employee (just below their name tag in the top-down view) until their menu is open. */
async function openEmployeeMenu(name) {
  const tag = `[...document.querySelectorAll('.tag')].find((t) => t.querySelector('.tag-name') && t.querySelector('.tag-name').textContent.trim().startsWith(${JSON.stringify(name)}))`;
  const menuOpen = `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'View skills')`;
  if ((await js(`window.__t.store().cameraMode`)) !== 'command') {
    await click(`window.__t.byText('Command center', 'button', document.body)`, 'Command center');
    await sleep(3500);
  }
  await waitFor(`!!(${tag}) && (${tag}).getBoundingClientRect().width > 0`, 10000);
  for (let round = 0; round < 3; round++) {
    for (const dy of [16, 8, 24, 34, 46, 60]) {
      const p = await js(`(() => { const r = (${tag}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom + ${dy}) }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'right', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'right', clickCount: 1 });
      await sleep(350);
      if (await js(menuOpen)) return dy;
    }
    await sleep(1200);
  }
  throw new Error(`right-clicking ${name} never opened their menu`);
}
const menuItem = (label) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)} && !b.closest('.win') && !b.closest('.cc'))`;

/** Tick or untick one of the "Office extras" in Settings (a real click on its checkbox). */
async function officeExtra(label, on) {
  await js(`window.__t.store().openPanel('settings')`);
  await clickText('Graphics');
  const box = `window.__t.checkbox(${JSON.stringify(label)})`;
  await waitFor(`!!(${box})`, 8000);
  if ((await js(`(${box}).checked`)) !== on) await click(box, label);
  await waitFor(`(${box}).checked === ${on}`, 5000);
  await js(`window.__t.store().openPanel(null)`);
}

const PANELS = ['tasks', 'projects', 'team', 'meetings', 'hosts', 'wall', 'growth', 'map', 'overview', 'ceo', 'office', 'notifications', 'settings', 'help', 'radio', 'reports'];

async function scenario() {
  await step('the office loads with the live company', async () => {
    await waitFor(`document.querySelector('canvas') && Object.keys(window.__office.getState().employees).length >= 8`, 30000);
    await sleep(2500);
    await shot('00-office');
    return await js(`Object.keys(window.__t.store().employees).length + ' employees, ' + Object.values(window.__t.store().sessions).filter((s) => s.status === 'running').length + ' running sessions'`);
  });

  for (const panel of PANELS) {
    await step(`panel "${panel}" opens, renders and closes`, async () => {
      await js(`window.__t.store().openPanel(${JSON.stringify(panel)})`);
      await waitFor(`document.querySelector('.win') && document.querySelector('.win').textContent.length > 40`, 8000);
      await sleep(350);
      await shot(`panel-${panel}`);
      const title = await js(`document.querySelector('.win h2').textContent`);
      await clickText('✕');
      await waitFor(`!document.querySelector('.win')`, 5000);
      return title;
    });
  }

  await step('every camera mode can be selected from the top bar', async () => {
    const seen = [];
    for (const [label, mode] of [['First person', 'first'], ['Management', 'management'], ['Free cam', 'free'], ['Command center', 'command'], ['CEO', 'ceo']]) {
      await click(`window.__t.byText(${JSON.stringify(label)}, 'button', document.body)`, label);
      await waitFor(`window.__t.store().cameraMode === ${JSON.stringify(mode)}`, 4000);
      await sleep(700);
      if (mode === 'command') await shot('camera-command');
      seen.push(mode);
    }
    return seen.join(' → ');
  });

  await step('command center view lists what needs the owner, everyone, and measured machine load', async () => {
    await click(`window.__t.byText('Command center', 'button', document.body)`, 'Command center');
    await waitFor(`!!document.querySelector('.cc')`, 5000);
    const text = await js(`document.querySelector('.cc').textContent`);
    for (const expected of ['Needs you', 'People', 'Machines', 'Sarah', 'David', 'dev-mac']) if (!text.includes(expected)) throw new Error(`"${expected}" is missing from the command center`);
    await waitFor(`/CPU \\d+% · RAM \\d+%/.test(document.querySelector('.cc').textContent)`, 15000);
    await shot('command-center');
    // A "needs you" row opens the real question.
    await click(`[...document.querySelectorAll('.cc .cc-row')].find((r) => /approval|question/.test(r.textContent))`, 'a needs-you row');
    await waitFor(`document.querySelector('.win') && /Allow this once|Option A/.test(document.querySelector('.win').textContent)`, 5000);
    await clickText('✕');
    await click(`window.__t.byText('CEO', 'button', document.body)`, 'CEO');
    await waitFor(`!document.querySelector('.cc')`, 4000);
    return text.match(/\d+\/\d+ working · \d+ at their desks/)?.[0] ?? '';
  });

  await step('the inbox opens with its keyboard shortcut and lists what is waiting', async () => {
    await key('N', 'n');
    await waitFor(`document.querySelector('.win') && /remember the user/.test(document.querySelector('.win').textContent)`, 6000);
    await shot('inbox');
    await key('Escape');
    await waitFor(`!document.querySelector('.win')`, 5000);
  });

  await step('answering an employee question by clicking an option', async () => {
    const id = await waitFor(`(Object.values(window.__t.store().questions).find((q) => q.status === 'open' && q.kind === 'question' && /remember the user/.test(q.text)) || {}).id`, 20000);
    await js(`window.__t.store().openPanel('question', ${JSON.stringify(id)})`);
    await click(`window.__t.byText('Option A', 'button.card-click')`, 'Option A');
    await waitFor(`['answered', 'delivered', 'confirmed'].includes(window.__t.store().questions[${JSON.stringify(id)}].status)`, 10000);
    await js(`window.__t.store().openPanel(null)`);
    return id;
  });

  await step('approving a permission request with "Allow this once"', async () => {
    const id = await waitFor(`(Object.values(window.__t.store().questions).find((q) => q.status === 'open' && q.kind === 'permission') || {}).id`, 20000);
    await js(`window.__t.store().openPanel('question', ${JSON.stringify(id)})`);
    await shot('permission');
    await clickText('Allow this once');
    await waitFor(`window.__t.store().questions[${JSON.stringify(id)}].status !== 'open'`, 10000);
    await js(`window.__t.store().openPanel(null)`);
    return id;
  });

  await step('hiring an employee into a folder through the hire form', async () => {
    await js(`window.__t.store().openPanel('team', 'hire')`);
    // Step one: where they work. Nothing is chosen for the person when there is more than one place.
    await waitFor(`document.querySelectorAll('.win .hire-place').length >= 1`, 8000);
    if (await js(`document.querySelectorAll('.win .hire-place').length > 1 && !!document.querySelector('.win form')`)) throw new Error('a place was chosen without asking');
    await js(`[...document.querySelectorAll('.win .hire-place')].find((b) => /dev-mac/.test(b.textContent)).click()`);
    await type(`window.__t.field('Name')`, ctx.hireName);
    // No path typing: browse the machine's folders and choose one.
    await clickText('Browse…');
    await waitFor(`!!window.__t.near(${JSON.stringify(ctx.hireFolderName)}, 'Choose')`, 10000);
    await shot('hire-browse');
    await click(`window.__t.near(${JSON.stringify(ctx.hireFolderName)}, 'Choose')`, 'Choose');
    await waitFor(`window.__t.field('Folder they live in').value === ${JSON.stringify(ctx.hireFolder)}`, 5000);
    // Step three is the desk: a free one, picked by hand.
    const where = await js(`[...window.__t.scope().querySelectorAll('.hire-place')].map((b) => [b.dataset.place, b.getAttribute('aria-checked')]).join('|')`);
    if (!/shared,true/.test(where) || /mine/.test(where)) throw new Error(`the places to hire in were ${where}`);
    const pickedDesk = await js(`(() => { const free = [...window.__t.scope().querySelectorAll('.desk-seat:not(.taken)')]; const b = free[free.length - 1]; b.click(); return b.dataset.desk; })()`);
    await waitFor(`window.__t.scope().querySelector('.desk-seat.on')?.dataset.desk === ${JSON.stringify(pickedDesk)}`, 3000);
    ctx.hireDesk = pickedDesk;
    await shot('hire-form');
    await clickText('Hire');
    await waitFor(`!!window.__t.emp(${JSON.stringify(ctx.hireName)})`, 10000);
    if ((await js(`window.__t.emp(${JSON.stringify(ctx.hireName)}).deskId`)) !== ctx.hireDesk) throw new Error(`hired at ${await js(`window.__t.emp(${JSON.stringify(ctx.hireName)}).deskId`)} instead of the chosen desk ${ctx.hireDesk}`);
    // Hiring does not start a session: it starts when the owner first talks to them.
    const hasSession = `Object.values(window.__t.store().sessions).some((s) => s.employeeId === window.__t.emp(${JSON.stringify(ctx.hireName)}).id)`;
    await sleep(2500);
    if (await js(hasSession)) throw new Error('a session was started at hire');
    await js(`window.__t.store().openPanel('talk', window.__t.emp(${JSON.stringify(ctx.hireName)}).id)`);
    await type(`window.__t.scope().querySelector('textarea')`, 'Welcome aboard. @@fake: say glad-to-be-here@@');
    await clickText('Send');
    await waitFor(`Object.values(window.__t.store().sessions).some((s) => s.employeeId === window.__t.emp(${JSON.stringify(ctx.hireName)}).id && s.status === 'running')`, 20000);
    await waitFor(`/glad-to-be-here/.test(window.__t.scope().textContent.replace('@@fake: say glad-to-be-here@@', ''))`, 25000);
    await js(`window.__t.store().openPanel(null)`);
    return 'hired with no session; the first message started it and got a reply';
  });

  await step('hiring for several project folders at once: one employee per folder, named after it, nobody started', async () => {
    await js(`window.__t.store().openPanel('team', 'hire-many')`);
    // Step one: where they work. Nothing is chosen for the person when there is more than one place.
    await waitFor(`document.querySelectorAll('.win .hire-place').length >= 1`, 8000);
    if (await js(`document.querySelectorAll('.win .hire-place').length > 1 && !!document.querySelector('.win .bulk-item')`)) throw new Error('a place was chosen without asking');
    await js(`[...document.querySelectorAll('.win .hire-place')].find((b) => /dev-mac/.test(b.textContent)).click()`);
    await waitFor(`!!window.__t.near('portfolio', 'open ›', window.__t.scope())`, 10000).catch(() => undefined);
    await click(`[...window.__t.scope().querySelectorAll('.bulk-item')].find((r) => r.textContent.includes('portfolio')).querySelector('.fp-link')`, 'open portfolio');
    await waitFor(`[...window.__t.scope().querySelectorAll('.bulk-item')].some((r) => r.textContent.includes('xagio-panel'))`, 8000);
    await clickText('All repositories');
    await waitFor(`window.__t.scope().querySelectorAll('.bulk-row').length === 2`, 5000);
    // The third one is not a repository: tick it by hand.
    await click(`[...window.__t.scope().querySelectorAll('.bulk-item')].find((r) => r.textContent.includes('client notes')).querySelector('input[type=checkbox]')`, 'client notes');
    await waitFor(`window.__t.scope().querySelectorAll('.bulk-row').length === 3`, 5000);
    const names = await js(`[...window.__t.scope().querySelectorAll('.bulk-row input')].map((i) => i.value)`);
    if ([...names].sort().join(',') !== 'AiTuner,ClientNotes,XagioPanel') throw new Error(`names were ${names.join(', ')}`);
    // A name can be changed before hiring.
    await type(`[...window.__t.scope().querySelectorAll('.bulk-row input')].find((i) => i.value === 'ClientNotes')`, 'Scribe');
    await shot('hire-many');
    await clickText('Hire 3 employees');
    await waitFor(`['XagioPanel', 'AiTuner', 'Scribe'].every((n) => !!window.__t.emp(n))`, 15000);
    await sleep(2500);
    const started = await js(`Object.values(window.__t.store().sessions).filter((s) => ['XagioPanel', 'AiTuner', 'Scribe'].some((n) => window.__t.emp(n).id === s.employeeId)).length`);
    if (started) throw new Error(`${started} session(s) were started at hire`);
    await js(`window.__t.store().openPanel(null)`);
    return `hired ${names.filter((n) => n !== 'ClientNotes').join(', ')} and Scribe (renamed from ClientNotes); no session started`;
  });

  await step('the menu opens from the top-left button and leads to a panel', async () => {
    if (await js(`!!document.querySelector('.dock')`)) throw new Error('the menu should be closed until asked for');
    await click(`document.querySelector('.brand-btn')`, 'the menu button');
    await waitFor(`!!document.querySelector('.dock')`, 3000);
    await click(`window.__t.byText('Team', 'button', document.querySelector('.dock'))`, 'Team');
    await waitFor(`window.__t.store().panel === 'team' && !document.querySelector('.dock')`, 5000);
    await js(`window.__t.store().openPanel(null)`);
  });

  await step("an employee's documents: the Markdown files in their folder are listed and shown formatted", async () => {
    const quinn = await js(`window.__t.emp(${JSON.stringify(ctx.hireName)}).id`);
    await waitFor(`((window.__t.store().docs[${JSON.stringify(quinn)}] || {}).files || []).length >= 2`, 70000);
    await js(`window.__t.store().openPanel('docs', ${JSON.stringify(quinn)})`);
    await click(`[...window.__t.scope().querySelectorAll('.doc-folder')].find((b) => b.textContent.includes('docs'))`, 'the docs folder');
    await click(`[...window.__t.scope().querySelectorAll('.doc-item')].find((b) => b.textContent.includes('GUIDE.md'))`, 'GUIDE.md');
    await waitFor(`(() => { const b = window.__t.scope().querySelector('.doc-body .md'); return !!b && !!b.querySelector('h1') && b.querySelector('h1').textContent === 'Guide' && !!b.querySelector('table') && !!b.querySelector('pre.md-code') && b.querySelectorAll('li').length === 2; })()`, 8000);
    await shot('documents');
    await js(`window.__t.store().openPanel(null)`);
    return await js(`window.__t.store().docs[${JSON.stringify(quinn)}].files.map((f) => f.path).join(', ')`);
  });

  await step('creating a task through the task form; it is delivered and completed', async () => {
    await js(`window.__t.store().openPanel('tasks')`);
    await clickText('New task');
    await waitFor(`!!window.__t.field('Title')`, 5000);
    await js(`(() => { const sel = window.__t.field('Assignee'); const v = window.__t.emp('Noor').id; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, v); sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await type(`window.__t.field('Title')`, ctx.taskTitle);
    await type(`window.__t.field('Description')`, ctx.taskDescription);
    await shot('task-form');
    await clickText('Create task');
    await waitFor(`Object.values(window.__t.store().tasks).some((t) => t.title === ${JSON.stringify(ctx.taskTitle)})`, 10000);
    await waitFor(`Object.values(window.__t.store().tasks).some((t) => t.title === ${JSON.stringify(ctx.taskTitle)} && t.status === 'DONE')`, 40000);
    await js(`window.__t.store().openPanel(null)`);
    return 'created → DONE';
  });

  await step('talking to an employee: the message is delivered and the real reply appears', async () => {
    await js(`window.__t.store().openPanel('talk', window.__t.emp('Ava').id)`);
    await type(`window.__t.scope().querySelector('textarea')`, ctx.talkMessage);
    await clickText('Send');
    await waitFor(`/${ctx.talkReply}/.test(window.__t.scope().textContent.replace(${JSON.stringify(ctx.talkMessage)}, ''))`, 25000);
    // What the employee writes is Markdown, and it is shown formatted — not as raw asterisks and backticks.
    await waitFor(`(() => { const b = [...window.__t.scope().querySelectorAll('.talk-them')].find((x) => x.textContent.includes(${JSON.stringify(ctx.talkReply)})); return !!b && !!b.querySelector('strong') && !!b.querySelector('code') && !b.textContent.includes('**'); })()`, 5000);
    await shot('talk');
    await js(`window.__t.store().openPanel(null)`);
    return 'reply shown in the conversation';
  });

  await step('workstation: take control, type into the real terminal, return control', async () => {
    await js(`window.__t.store().enterWorkstation(window.__t.emp('Rev').id)`);
    await waitFor(`document.querySelector('.ws .xterm') && document.querySelector('.ws .xterm-rows') && document.querySelector('.ws .xterm-rows').textContent.length > 20`, 15000);
    await clickText('Take control');
    await waitFor(`/YOU ARE IN CONTROL/.test(document.querySelector('.ws-state').textContent)`, 8000);
    await click(`document.querySelector('.ws .xterm')`, 'the terminal');
    await win.webContents.insertText(ctx.typedPrompt);
    await sleep(300);
    await key('Enter');
    await waitFor(`/${ctx.typedReply}/.test(document.querySelector('.ws .xterm-rows').textContent)`, 20000);
    await shot('workstation-control');
    await clickText('Return control');
    await waitFor(`!/YOU ARE IN CONTROL/.test(document.querySelector('.ws-state').textContent)`, 8000);
    await clickText('Leave');
    await waitFor(`!document.querySelector('.ws')`, 5000);
    return 'typed prompt ran in the real session';
  });

  // ───────────── the controls inside the management panels ─────────────
  const open = (panel, arg) => js(`window.__t.store().openPanel(${JSON.stringify(panel)}${arg ? `, ${arg}` : ''})`);
  const close = () => js(`window.__t.store().openPanel(null)`);

  await step('Settings: a changed owner name is saved', async () => {
    await open('settings');
    await type(`window.__t.field('Your name')`, ctx.ownerName);
    await click(`window.__t.submit('Save')`, 'Save');
    await waitFor(`window.__t.store().settings.ownerName === ${JSON.stringify(ctx.ownerName)}`, 8000);
    await close();
  });

  await step('Machines: creating an enrollment token shows a usable one-time token', async () => {
    await open('hosts');
    await clickText('Create enrollment token');
    // The token as its own element shows it (neighbouring button labels are not part of it).
    const token = await waitFor(`([...document.querySelectorAll('.win *')].find((e) => e.children.length === 0 && /^orch_enroll_[A-Za-z0-9_-]+$/.test(e.textContent.trim())) || { textContent: '' }).textContent.trim()`, 8000);
    await waitFor(`/orchestrator-agent login --server/.test(document.querySelector('.win').textContent)`, 4000);
    await shot('machines-token');
    await close();
    return token;
  });

  await step('Office: adding a desk pod grows the real layout', async () => {
    await open('office');
    const before = await js(`window.__t.store().layout.desks.length`);
    await clickText('Add a desk pod');
    await waitFor(`window.__t.store().layout.desks.length === ${before} + 4`, 8000);
    await close();
    return `${before} → ${before + 4} desks`;
  });

  // ───────────── the office editor (floor plan) ─────────────
  const pick = (value) => js(`window.__t.setSelect(window.__t.scope().querySelector('select[aria-label="Selected item"]'), ${JSON.stringify(value)})`);
  const deskAt = (id) => js(`(() => { const d = window.__t.store().layout.desks.find((x) => x.id === ${JSON.stringify(id)}); return d ? { x: d.x, z: d.z } : null; })()`);

  await step('Office: a desk pod is moved with the arrow buttons, and the people sitting there move with it', async () => {
    await open('office');
    await waitFor(`!!window.__t.scope().querySelector('svg.plan [data-pod]')`, 8000);
    // The pod Alex sits in.
    const desk = await js(`window.__t.emp('Alex').deskId`);
    const pod = await js(`(() => { const g = [...window.__t.scope().querySelectorAll('svg.plan [data-pod]')]; const want = ${JSON.stringify(desk)}; const hit = g.find((x) => x.getAttribute('data-pod') === want) || g.find((x) => want.startsWith(x.getAttribute('data-pod').replace(/-[a-z]$/, '-'))); return hit ? hit.getAttribute('data-pod') : null; })()`);
    if (!pod) throw new Error(`no pod on the plan holds Alex's desk ${desk}`);
    await click(`window.__t.scope().querySelector('svg.plan [data-pod="${pod}"]')`, 'the pod on the plan');
    await waitFor(`window.__t.scope().querySelector('select[aria-label="Selected item"]').value === 'pod:${pod}' && /Alex/.test(window.__t.scope().querySelector('.plan-side').textContent)`, 4000);
    const from = await deskAt(desk);
    await click(`window.__t.scope().querySelector('button[aria-label="Move east"]')`, 'Move east');
    await waitFor(`Math.abs(window.__t.store().layout.desks.find((x) => x.id === ${JSON.stringify(desk)}).x - ${from.x + 0.5}) < 1e-6`, 8000);
    await shot('office-plan');
    await close();
    return `pod ${desk}: x ${from.x} → ${from.x + 0.5}`;
  });

  await step('Office: a desk pod is dragged on the floor plan; dropping it onto another pod is refused', async () => {
    await open('office');
    await waitFor(`!!window.__t.scope().querySelector('svg.plan [data-pod]')`, 8000);
    // An empty pod (nobody to disturb) with free floor to its south: the northernmost one.
    const pod = await js(`(() => { const s = window.__t.store(); const taken = new Set(Object.values(s.employees).filter((e) => !e.archived && e.deskId).map((e) => e.deskId)); const pods = [...window.__t.scope().querySelectorAll('svg.plan [data-pod]')].map((g) => g.getAttribute('data-pod')); const z = (p) => s.layout.desks.find((d) => d.id === p).z; const free = pods.filter((p) => !s.layout.desks.some((d) => d.id.startsWith(p.replace(/-[a-z]$/, '-')) && taken.has(d.id))).sort((a, b) => z(a) - z(b)); return free[0] || null; })()`);
    if (!pod) throw new Error('there is no empty pod on the plan to drag');
    const at = () => js(`(() => { const g = window.__t.scope().querySelector('svg.plan [data-pod="${pod}"]'); g.scrollIntoView({ block: 'center' }); const r = g.getBoundingClientRect(); const m = window.__t.scope().querySelector('svg.plan').getScreenCTM(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), scale: m.a }; })()`);
    const dragBy = async (dxm, dzm) => {
      const p = await at();
      const mouse = (type, x, y, extra = {}) => win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', ...extra });
      mouse('mouseMove', p.x, p.y);
      mouse('mouseDown', p.x, p.y, { clickCount: 1 });
      for (let i = 1; i <= 8; i++) {
        mouse('mouseMove', p.x + (dxm * p.scale * i) / 8, p.y + (dzm * p.scale * i) / 8, { modifiers: ['leftButtonDown'] });
        await sleep(40);
      }
      await sleep(150);
      const cls = await js(`window.__t.scope().querySelector('svg.plan [data-pod="${pod}"]').getAttribute('class')`);
      mouse('mouseUp', p.x + dxm * p.scale, p.y + dzm * p.scale, { clickCount: 1 });
      await sleep(250);
      return cls;
    };
    const first = `${pod}`;
    const from = await deskAt(first);
    const okClass = await dragBy(0, 1.5);
    if (!/plan-drag-ok/.test(okClass)) throw new Error(`while dragged to free floor the pod should be marked as allowed (class: ${okClass})`);
    await waitFor(`Math.abs(window.__t.store().layout.desks.find((x) => x.id === ${JSON.stringify(first)}).z - ${from.z}) > 1`, 8000);
    const to = await deskAt(first);
    // Onto the pod where people sit, far to the north-east: marked red while dragging, refused when dropped.
    const target = await js(`(() => { const s = window.__t.store(); const d = s.layout.desks.find((x) => x.id === window.__t.emp('Emma').deskId); return { x: d.x, z: d.z }; })()`);
    const badClass = await dragBy(target.x - to.x, target.z - to.z);
    if (!/plan-drag-bad/.test(badClass)) throw new Error(`while dragged onto another pod it should be marked as refused (class: ${badClass})`);
    await waitFor(`/Not possible/.test(window.__t.scope().querySelector('.plan-side').textContent)`, 4000);
    const after = await deskAt(first);
    if (Math.abs(after.x - to.x) > 1e-6 || Math.abs(after.z - to.z) > 1e-6) throw new Error('the refused drop moved the pod anyway');
    await shot('office-plan-refused');
    const why = await js(`(document.querySelector('.plan-side [role=alert]') || { textContent: '' }).textContent.trim()`);
    await close();
    return `pod ${first} dragged ${(to.z - from.z).toFixed(2)} m south; the drop onto Emma's pod was refused: "${why}"`;
  });

  await step('Office: a decoration is added, turned, and removed again', async () => {
    await open('office');
    await waitFor(`!!window.__t.scope().querySelector('select[aria-label="Decoration to add"]')`, 8000);
    const count = `window.__t.store().layout.decorations.length`;
    const before = await js(count);
    // Milestone rewards that have not been earned are listed but cannot be chosen.
    const locked = await js(`[...window.__t.scope().querySelectorAll('select[aria-label="Decoration to add"] option')].filter((o) => o.disabled).map((o) => o.textContent)`);
    await js(`window.__t.setSelect(window.__t.scope().querySelector('select[aria-label="Decoration to add"]'), 'bookshelf')`);
    await clickText('Add decoration');
    await waitFor(`${count} === ${before} + 1`, 8000);
    const added = await js(`(() => { const d = window.__t.store().layout.decorations.find((x) => x.kind === 'bookshelf'); return d ? { id: d.id, x: d.x, z: d.z, rot: d.rot } : null; })()`);
    if (!added) throw new Error('no bookshelf in the layout after adding one');
    await waitFor(`window.__t.scope().querySelector('select[aria-label="Selected item"]').value === 'decoration:${added.id}'`, 4000);
    // A quarter turn: stored when the turned bookshelf still fits where it stands, refused (with the reason) when it does not.
    await clickText('Turn');
    const turned = await waitFor(`(() => { const d = window.__t.store().layout.decorations.find((x) => x.id === ${JSON.stringify(added.id)}); if (Math.abs(d.rot - ${added.rot} - Math.PI / 2) < 1e-6) return 'turned a quarter'; const a = window.__t.scope().querySelector('.plan-side [role=alert]'); return a ? 'turn refused (' + a.textContent.trim() + ')' : null; })()`, 8000);
    await shot('office-decoration');
    await clickText('Remove decoration');
    await waitFor(`${count} === ${before}`, 8000);
    await close();
    return `${added.id} placed at ${added.x}, ${added.z}, ${turned}, removed; not offered yet: ${locked.length ? locked.join('; ') : 'nothing'}`;
  });

  await step('Office: a room is renamed and the wall it shares with the next room is moved', async () => {
    await open('office');
    await waitFor(`!!window.__t.scope().querySelector('select[aria-label="Selected item"]')`, 8000);
    await pick('room:meeting');
    await type(`window.__t.scope().querySelector('input[aria-label="Room name"]')`, ctx.roomName);
    await clickText('Rename');
    const room = (id) => `window.__t.store().layout.rooms.find((r) => r.id === '${id}')`;
    await waitFor(`${room('meeting')}.name === ${JSON.stringify(ctx.roomName)}`, 8000);
    const w = await js(`${room('meeting')}.w`);
    await click(`window.__t.scope().querySelector('button[aria-label="Move the east wall east"]')`, 'East wall →');
    await waitFor(`Math.abs(${room('meeting')}.w - ${w + 0.5}) < 1e-6`, 8000);
    // The outer wall and the wall along the hallway are not offered at all.
    const offered = await js(`[...window.__t.scope().querySelectorAll('.plan-wall')].map((r) => r.textContent.trim().replace(/[←→↑↓]/g, '').trim())`);
    if (offered.includes('North wall') || offered.includes('South wall')) throw new Error(`walls that cannot move are offered: ${offered.join(', ')}`);
    await close();
    return `Meeting Room → ${ctx.roomName}, ${w} m → ${w + 0.5} m wide (movable walls: ${offered.join(', ')})`;
  });

  await step('Growth: teaching a lesson through the form records it', async () => {
    await open('growth');
    await clickText('Teach');
    await type(`window.__t.field('Lesson')`, ctx.lesson);
    await type(`window.__t.field('Applies when')`, 'before a commit');
    await shot('growth-teach');
    await click(`window.__t.submit('Teach')`, 'Teach (submit)');
    await waitFor(`Object.values(window.__t.store().lessons).some((l) => l.text === ${JSON.stringify(ctx.lesson)})`, 8000);
    await close();
  });

  await step('Meetings: a meeting started from the form runs to a recorded decision', async () => {
    await open('meetings');
    await clickText('New meeting');
    await type(`window.__t.field('Topic')`, ctx.meetingTopic);
    for (const name of ['Ava', 'Rev']) {
      await click(`window.__t.checkbox(${JSON.stringify(name)})`, `${name}'s checkbox`);
      await waitFor(`window.__t.checkbox(${JSON.stringify(name)}).checked`, 3000);
    }
    await shot('meeting-form');
    await click(`window.__t.submit('Start meeting')`, 'Start meeting');
    await waitFor(`Object.values(window.__t.store().meetings).some((m) => m.topic === ${JSON.stringify(ctx.meetingTopic)} && m.status === 'concluded')`, 60000);
    await waitFor(`/Adopt the HTTP boundary/.test(document.querySelector('.win').textContent)`, 8000);
    await shot('meeting-concluded');
    await close();
    return 'concluded; decision shown';
  });

  await step('Team: editing a profile saves standing instructions', async () => {
    await open('employee', `window.__t.emp('Ava').id`);
    await type(`window.__t.field('Standing instructions')`, ctx.instructions);
    await clickText('Save changes');
    await waitFor(`window.__t.emp('Ava').instructions === ${JSON.stringify(ctx.instructions)}`, 8000);
    await close();
  });

  await step('Team: a session is stopped and started again from the Session tab', async () => {
    const running = `Object.values(window.__t.store().sessions).some((s) => s.employeeId === window.__t.emp(${JSON.stringify(ctx.hireName)}).id && s.status === 'running')`;
    await open('employee', `window.__t.emp(${JSON.stringify(ctx.hireName)}).id + ':session'`);
    await clickText('Stop session…');
    await clickText('Stop session');
    await waitFor(`!(${running})`, 15000);
    await click(`window.__t.byText('Resume session') || window.__t.byText('Start session')`, 'Resume/Start session');
    await waitFor(running, 20000);
    await close();
    return 'stopped → running again';
  });

  await step('Team: interrupting a working employee and resuming from the Session tab', async () => {
    const act = (name) => `(Object.values(window.__t.store().sessions).find((s) => s.employeeId === window.__t.emp('${name}').id && s.status === 'running') || {}).activity`;
    await open('employee', `window.__t.emp('Mike').id + ':session'`);
    await clickText('Pause (interrupt)');
    await waitFor(`${act('Mike')} === 'paused'`, 10000);
    await clickText('Resume work');
    await waitFor(`${act('Mike')} !== 'paused'`, 10000);
    await close();
    return 'paused → resumed';
  });

  await step('Projects: a project created through the form exists, and can be paused and resumed', async () => {
    await open('projects');
    await clickText('New project');
    await type(`window.__t.field('Name')`, ctx.projectName);
    await type(`window.__t.field('Repository path')`, ctx.projectRepo);
    await click(`window.__t.submit('Create project')`, 'Create project');
    const status = `(Object.values(window.__t.store().projects).find((p) => p.name === ${JSON.stringify(ctx.projectName)}) || {}).status`;
    await waitFor(`${status} === 'active'`, 15000);
    await clickText('Pause project');
    await waitFor(`${status} === 'paused'`, 8000);
    await clickText('Resume project');
    await waitFor(`${status} === 'active'`, 8000);
    await close();
    return 'created → paused → resumed';
  });

  await step('Task detail shows the measured evidence of the task made earlier', async () => {
    await open('task', `Object.values(window.__t.store().tasks).find((t) => t.title === ${JSON.stringify(ctx.taskTitle)}).id`);
    const shows = (re) => waitFor(`${re}.test(document.querySelector('.win').textContent)`, 8000);
    await shows('/confirmed/');
    await clickText('Evidence');
    await shows('/add ui marker/');
    await shows('/measured/i');
    await shot('task-detail');
    await clickText('Changes');
    await shows('/ui-marker\\.txt/');
    await clickText('History');
    await shows('/DONE|Done/');
    await close();
    return 'overview, evidence, changes and history all render the real record';
  });

  await step('Terminal wall: a tile enlarges, restores and opens the workstation', async () => {
    await open('wall');
    await waitFor(`!!window.__t.byText('Enlarge')`, 10000);
    await clickText('Enlarge');
    await waitFor(`!!window.__t.byText('Restore')`, 5000);
    await clickText('Restore');
    await clickText('Open workstation');
    await waitFor(`!!document.querySelector('.ws .xterm')`, 10000);
    await clickText('Leave');
    await waitFor(`!document.querySelector('.ws')`, 5000);
  });

  await step('Inbox: "Mark all read" clears the unread notifications', async () => {
    await open('notifications');
    const unread = `Object.values(window.__t.store().notifications).filter((n) => !n.resolvedAt && !n.readAt).length`;
    const before = await js(unread);
    if (before > 0) {
      await clickText('All notifications');
      await clickText('Mark all read');
      await waitFor(`${unread} === 0`, 8000);
    }
    await close();
    return `${before} unread → 0 at ${new Date().toISOString()}`;
  });

  await step('Growth: a lesson is retired and reactivated from its card', async () => {
    await open('growth');
    const status = `(Object.values(window.__t.store().lessons).find((l) => l.text === ${JSON.stringify(ctx.lesson)}) || {}).status`;
    let found = false;
    for (const tab of ['Playbooks', 'Team knowledge']) {
      await clickText(tab);
      await sleep(400);
      if (await js(`!!window.__t.near(${JSON.stringify(ctx.lesson)}, 'Retire')`)) {
        found = true;
        break;
      }
    }
    if (!found) throw new Error('the taught lesson is not listed with a Retire button in Playbooks or Team knowledge');
    await click(`window.__t.near(${JSON.stringify(ctx.lesson)}, 'Retire')`, 'Retire');
    await waitFor(`${status} === 'retired'`, 8000);
    await click(`window.__t.near(${JSON.stringify(ctx.lesson)}, 'Reactivate')`, 'Reactivate');
    await waitFor(`${status} === 'active'`, 8000);
    await close();
    return 'active → retired → active';
  });

  await step('Team: changing an appearance is saved', async () => {
    await open('employee', `window.__t.emp('Ava').id`);
    await clickText('Appearance');
    await waitFor(`!!window.__t.field('Hair style')`, 5000);
    const next = await js(`(() => { const sel = window.__t.field('Hair style'); const o = [...sel.options].find((x) => x.value !== sel.value && !x.disabled); window.__t.setSelect(sel, o.value); return o.value; })()`);
    await shot('appearance');
    await clickText('Save appearance');
    await waitFor(`window.__t.emp('Ava').appearance.hairStyle === ${JSON.stringify(next)}`, 8000);
    await close();
    return `hair style → ${next}`;
  });

  await step('Team: looks that are earned with levels are shown but cannot be chosen by a level-1 employee', async () => {
    await open('employee', `window.__t.emp('Ava').id + ':appearance'`);
    await waitFor(`!!window.__t.field('Accessory')`, 5000);
    const info = await js(`(() => { const e = window.__t.emp('Ava'); const opts = (label) => [...window.__t.field(label).options].map((o) => ({ value: o.value, text: o.textContent, disabled: o.disabled })); return { level: e.level, accessory: e.appearance.accessory, hair: e.appearance.hairStyle, acc: opts('Accessory'), hairs: opts('Hair style') }; })()`);
    if (info.level >= 3) throw new Error(`Ava is level ${info.level}; this check needs a level-1 employee`);
    const said = [];
    for (const [list, value, level, own] of [[info.acc, 'cap', 3, info.accessory], [info.acc, 'headphones', 5, info.accessory], [info.hairs, 'curly', 8, info.hair]]) {
      const o = list.find((x) => x.value === value);
      if (!o) throw new Error(`"${value}" is not listed at all`);
      // What she already wears stays hers; everything else of a higher level is locked.
      if (own === value) continue;
      if (!o.disabled || !o.text.includes('unlocks at level ' + level)) throw new Error(`"${value}" should be disabled and say "unlocks at level ${level}" (got "${o.text}", disabled: ${o.disabled})`);
      said.push(o.text);
    }
    for (const free of ['none', 'glasses']) if (info.acc.find((x) => x.value === free).disabled) throw new Error(`"${free}" should be free for everyone`);
    await shot('appearance-locked');
    await close();
    return `Ava (level ${info.level}): ${said.join('; ')}`;
  });

  await step('Task board: dragging a card to another column moves the task', async () => {
    await open('tasks');
    const pick = await js(`(() => { const t = Object.values(window.__t.store().tasks).find((x) => (x.status === 'READY' || x.status === 'BACKLOG') && !x.assigneeId && x.kind !== 'review'); return t ? { id: t.id, key: t.key, from: t.status, to: t.status === 'READY' ? 'BACKLOG' : 'READY' } : null; })()`);
    if (!pick) throw new Error('no unassigned READY/BACKLOG task to drag');
    const card = `[...window.__t.scope().querySelectorAll('[draggable=true]')].find((c) => c.textContent.includes(${JSON.stringify(pick.key)} + ' ') || [...c.querySelectorAll('.mono')].some((m) => m.textContent.trim() === ${JSON.stringify(pick.key)}))`;
    const col = `[...window.__t.scope().querySelectorAll('.board-col')].find((c) => c.querySelector('.board-col-head').textContent.trim().toUpperCase().startsWith(${JSON.stringify(pick.to)}))`;
    await waitFor(`!!(${card}) && !!(${col})`, 8000);
    // HTML5 drag and drop, event by event, with one shared DataTransfer (the browser's own drag
    // session cannot be driven in a hidden window, so the events a real drag produces are dispatched).
    await js(`(() => { window.__dt = new DataTransfer(); (${card}).dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt })); })()`);
    await sleep(150);
    await js(`(${col}).dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))`);
    await sleep(150);
    await shot('board-drag');
    await js(`(${col}).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))`);
    await waitFor(`window.__t.store().tasks[${JSON.stringify(pick.id)}].status === ${JSON.stringify(pick.to)}`, 8000);
    await close();
    return `${pick.key}: ${pick.from} → ${pick.to}`;
  });

  await step('Machines: a machine is renamed and then removed', async () => {
    await open('hosts');
    await click(`window.__t.near(${JSON.stringify(ctx.spareHost)}, 'Rename')`, 'Rename');
    await type(`window.__t.scope().querySelector('input[aria-label="Machine name"]')`, ctx.spareRenamed);
    await click(`window.__t.submit('Save')`, 'Save');
    await waitFor(`Object.values(window.__t.store().hosts).some((h) => h.name === ${JSON.stringify(ctx.spareRenamed)})`, 8000);
    await click(`window.__t.near(${JSON.stringify(ctx.spareRenamed)}, 'Remove…')`, 'Remove…');
    await clickText('Remove machine');
    await waitFor(`!Object.values(window.__t.store().hosts).some((h) => h.name === ${JSON.stringify(ctx.spareRenamed)})`, 8000);
    await close();
    return 'renamed → removed';
  });

  await step('Settings: a key binding is captured from a real key press and reset again', async () => {
    await open('settings');
    await clickText('Controls');
    // Keys belong to this computer: they are kept here, and the office's own settings are left alone.
    const forward = `window.__orchPrefs.getState().prefs.keybindings.forward`;
    const kept = `JSON.parse(localStorage.getItem('orch.prefs')).keybindings.forward`;
    const original = await js(forward);
    await click(`[...window.__t.scope().querySelectorAll('.pc-keyrow')].find((r) => r.textContent.startsWith('Move forward')).querySelector('.pc-key')`, 'the "Move forward" binding');
    await waitFor(`/press a key/.test(window.__t.scope().querySelector('.pc-key-on').textContent)`, 4000);
    await key('I', 'i');
    await waitFor(`${forward} === 'KeyI' && ${kept} === 'KeyI'`, 8000);
    await clickText('Reset to defaults');
    await waitFor(`${forward} === ${JSON.stringify(original)} && ${kept} === ${JSON.stringify(original)}`, 8000);
    await close();
    return `${original} → KeyI → ${original}`;
  });

  await step('Settings: the graphics quality is chosen for this computer and kept here, not in the office', async () => {
    await open('settings');
    await clickText('Graphics');
    const mine = `window.__orchPrefs.getState().prefs.quality`;
    const kept = `JSON.parse(localStorage.getItem('orch.prefs')).quality`;
    const office = `window.__t.store().settings.quality`;
    const original = await js(mine);
    const officeBefore = await js(office);
    const other = original === 'low' ? 'medium' : 'low';
    const title = (q) => q[0].toUpperCase() + q.slice(1);
    const radio = (q) => `[...window.__t.scope().querySelectorAll('label.pc-choice')].find((l) => l.textContent.trim().startsWith(${JSON.stringify(title(q))})).querySelector('input')`;
    if (!(await js(`/Saved on this computer/.test(window.__t.scope().textContent) && [...window.__t.scope().querySelectorAll('nav .section-title')].map((e) => e.textContent).join('|') === 'This computer|The office'`))) throw new Error('Settings does not show the two groups "This computer" and "The office"');
    await click(radio(other), title(other));
    await waitFor(`${mine} === ${JSON.stringify(other)} && ${kept} === ${JSON.stringify(other)} && (${radio(other)}).checked`, 8000);
    // Long enough for the office to have answered, had anything been sent to it.
    await sleep(1200);
    if ((await js(office)) !== officeBefore) throw new Error(`the office's own quality setting changed to ${await js(office)}`);
    await shot('settings-this-computer');
    await click(radio(original), title(original));
    await waitFor(`${mine} === ${JSON.stringify(original)} && ${kept} === ${JSON.stringify(original)}`, 8000);
    await close();
    return `this computer: ${original} → ${other} → ${original}; the office's setting stayed ${officeBefore}`;
  });

  await step('3D office: walking up to someone, talking (F), sitting down (Space), turning (A/D), sidestepping (Q/E) and walking (W/S)', async () => {
    await close();
    await click(`window.__t.byText('CEO', 'button', document.body)`, 'CEO');
    const ava = await js(`window.__t.emp('Ava').id`);
    const nearAva = `(() => { const n = window.__t.store().nearby; return !!n && n.kind === 'employee' && n.id === ${JSON.stringify(ava)}; })()`;
    await js(`window.__t.store().focusEmployee(${JSON.stringify(ava)})`);
    await waitFor(nearAva, 20000);
    await shot('near-employee');
    await key('F', 'f');
    await waitFor(`window.__t.store().panel === 'talk' && !!document.querySelector('.win')`, 6000);
    await key('Escape');
    await waitFor(`!document.querySelector('.win')`, 5000);
    await key('Space', ' ');
    await waitFor(`!!document.querySelector('.ws .xterm')`, 10000);
    await clickText('Leave');
    await waitFor(`!document.querySelector('.ws')`, 5000);
    await waitFor(nearAva, 10000);
    // The whip: a crack, a yelp and a flinch — and nothing else.
    await key('R', 'r');
    await waitFor(`window.__t.store().whips[${JSON.stringify(ava)}] > 0 && !!document.querySelector('.ouch-bubble')`, 4000);
    await shot('whip');
    await waitFor(`!document.querySelector('.ouch-bubble')`, 5000);
    // The owner's own controls: A/D turn on the spot, Q/E sidestep without turning, W/S walk.
    if (!(await js(`!!window.__orchPlayer`))) throw new Error('the scene does not report the player position (stale UI build?)');
    const at = () => js(`({ x: window.__orchPlayer.x, z: window.__orchPlayer.z, rot: window.__orchPlayer.rot })`);
    const hold = async (k, ms) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k });
      await sleep(ms);
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k });
      await sleep(350);
    };
    const moved = (p, q) => Math.hypot(p.x - q.x, p.z - q.z);
    const turned = (p, q) => Math.abs(Math.atan2(Math.sin(p.rot - q.rot), Math.cos(p.rot - q.rot)));
    const p0 = await at();
    await hold('D', 700);
    const p1 = await at();
    if (turned(p1, p0) < 0.5 || moved(p1, p0) > 0.05) throw new Error(`D should turn on the spot (turned ${turned(p1, p0).toFixed(2)} rad, moved ${moved(p1, p0).toFixed(2)})`);
    await hold('A', 700);
    const p2 = await at();
    if (turned(p2, p1) < 0.5 || moved(p2, p1) > 0.05) throw new Error(`A should turn on the spot (turned ${turned(p2, p1).toFixed(2)} rad, moved ${moved(p2, p1).toFixed(2)})`);
    // Sidestep: one of the two directions is always free next to a desk.
    let side = null;
    for (const k of ['Q', 'E']) {
      const before = await at();
      await hold(k, 900);
      const after = await at();
      if (moved(after, before) > 0.5) {
        if (turned(after, before) > 0.12) throw new Error(`${k} should sidestep without turning (turned ${turned(after, before).toFixed(2)} rad)`);
        side = k;
        break;
      }
    }
    if (!side) throw new Error('neither Q nor E moved the character sideways');
    let walked = null;
    for (const k of ['S', 'W']) {
      const before = await at();
      await hold(k, 1800);
      if (moved(await at(), before) > 0.8) {
        walked = k;
        break;
      }
    }
    if (!walked) throw new Error('holding W/S never moved the character');
    await waitFor(`!(${nearAva})`, 8000).catch(async () => {
      await hold(walked, 2500);
    });
    return `F → talk, Space → workstation, R → whip ("jao" bubble shown and gone), A/D turned on the spot, ${side} sidestepped, ${walked} walked`;
  });

  await step('3D office: at a workstation the camera comes closer and the monitor is drawn sharper; both ease back on leaving', async () => {
    await close();
    await click(`window.__t.byText('CEO', 'button', document.body)`, 'CEO');
    const ava = await js(`window.__t.emp('Ava').id`);
    const away = await js(`(window.__orchPlayer.spots || []).find((s) => s.kind === 'reception')`);
    await js(`window.__orchPlayer.goto = { x: ${away.x}, z: ${away.z}, rot: 0 }; true`);
    // Really there (the placement is applied on the next drawn frame), before going anywhere else.
    await waitFor(`!window.__orchPlayer.goto && Math.hypot(window.__orchPlayer.x - ${away.x}, window.__orchPlayer.z - ${away.z}) < 2 && window.__orchPlayer.approach === 0 && (window.__orchScene.closeScreens || 0) === 0`, 8000);
    const far = await js(`window.__orchPlayer.camDist`);
    await js(`window.__t.store().focusEmployee(${JSON.stringify(ava)})`);
    await waitFor(`(() => { const n = window.__t.store().nearby; return !!n && n.kind === 'employee' && n.id === ${JSON.stringify(ava)}; })()`, 10000);
    // Unless the owner asked for it, the camera keeps its distance at a desk.
    await sleep(1800);
    if ((await js(`window.__orchPlayer.approach`)) !== 0 || Math.abs((await js(`window.__orchPlayer.camDist`)) - far) > 0.2) throw new Error('the camera moved closer although "Move the camera closer at a desk" is off');
    await officeExtra('Move the camera closer at a desk', true);
    await click(`window.__t.byText('CEO', 'button', document.body)`, 'CEO');
    await waitFor(`window.__orchPlayer.approach > 0.97 && window.__orchPlayer.camDist < ${far} - 3 && window.__orchScene.closeScreens >= 1`, 8000);
    const near = await js(`({ dist: window.__orchPlayer.camDist, sharp: window.__orchScene.closeScreens })`);
    await sleep(400);
    await shot('approach');
    // The camera still obeys the turn keys while it is close.
    const rot0 = await js(`window.__orchPlayer.rot`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'D' });
    await sleep(500);
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'D' });
    await sleep(200);
    const rot1 = await js(`window.__orchPlayer.rot`);
    if (Math.abs(Math.atan2(Math.sin(rot1 - rot0), Math.cos(rot1 - rot0))) < 0.4) throw new Error('the turn key did nothing while the camera was close');
    await js(`window.__orchPlayer.goto = { x: ${away.x}, z: ${away.z}, rot: 0 }; true`);
    await waitFor(`window.__orchPlayer.approach < 0.03 && Math.abs(window.__orchPlayer.camDist - ${far}) < 0.2 && (window.__orchScene.closeScreens || 0) === 0`, 8000);
    return `camera ${far.toFixed(1)} m → ${near.dist.toFixed(1)} m → ${far.toFixed(1)} m; ${near.sharp} monitor(s) at the sharp tier while standing there, none after leaving`;
  });

  await step('3D office: nothing pops in and out while walking on the default setting; on Low, room interiors are mounted only near the owner', async () => {
    const detail = () => js(`({ ...window.__orchScene.detail })`);
    // The far south-west corner, the camera behind the owner to the west: the east wing is more than 30 m away.
    await js(`window.__orchPlayer.goto = { x: -20.6, z: 13, rot: Math.PI / 2 }; true`);
    // On the default graphics setting nothing is ever taken away: walking around must not make things pop in and out.
    await sleep(3500);
    if (!Object.values(await detail()).every(Boolean)) throw new Error(`interiors were unmounted on the default setting: ${JSON.stringify(await detail())}`);
    // The saving belongs to the Low setting; switch it on here the way that setting does.
    await js(`window.__orchScene.lazy = true; true`);
    await waitFor(`window.__orchScene.detail.server === false && window.__orchScene.detail.break === false && window.__orchScene.detail.hifi === false`, 12000);
    const farAway = await detail();
    const perfFar = await (async () => { await js(`window.__orchPerf = null; true`); await waitFor(`window.__orchPerf && window.__orchPerf.fps > 0`, 8000); return js(`({ ...window.__orchPerf })`); })();
    // Stay put: nothing may come and go on its own.
    await sleep(1200);
    if (JSON.stringify(await detail()) !== JSON.stringify(farAway)) throw new Error('interiors changed while standing still');
    await click(`window.__t.byText('Command center', 'button', document.body)`, 'Command center');
    await waitFor(`Object.values(window.__orchScene.detail).every(Boolean) && window.__orchScene.detail.server === true && window.__orchScene.detail.hifi === true`, 8000);
    const all = await detail();
    await click(`window.__t.byText('CEO', 'button', document.body)`, 'CEO');
    // Walking into the break room brings its interior (and the hi-fi) back.
    const hifi = await js(`(window.__orchPlayer.spots || []).find((s) => s.kind === 'hifi')`);
    await js(`window.__orchPlayer.goto = { x: ${hifi.x + 2}, z: ${hifi.z + 1}, rot: 0 }; true`);
    await waitFor(`window.__orchScene.detail.break === true && window.__orchScene.detail.hifi === true`, 8000);
    await js(`window.__orchScene.lazy = false; true`);
    await waitFor(`Object.values(window.__orchScene.detail).every(Boolean)`, 8000);
    const off = Object.entries(farAway).filter(([, v]) => !v).map(([k]) => k);
    return `in the far corner ${off.length} of ${Object.keys(farAway).length} interiors were unmounted (${off.join(', ')}); the overview camera mounted all ${Object.keys(all).length}; ${perfFar.calls} draw calls / ${perfFar.fps} fps in the far corner`;
  });

  await step('3D office: an employee thinking through a planning task stands at the project board', async () => {
    const id = await js(`window.__t.emp(${JSON.stringify(ctx.planner)}).id`);
    const task = await js(`(() => { const t = window.__t.store().tasks[${JSON.stringify(ctx.planningTaskId)}]; return t ? t.kind + ' ' + t.status : null; })()`);
    await waitFor(`window.__orchScene.places[${JSON.stringify(id)}] === 'board'`, 15000);
    // Walk over and look: she is standing at one of the places in front of the board, not at her desk.
    const spot = await js(`(window.__orchPlayer.spots || []).find((s) => s.kind === 'board')`);
    await js(`window.__orchPlayer.goto = { x: ${spot.x + 2.5}, z: ${spot.z}, rot: ${-Math.PI / 2} }; true`);
    const at = await waitFor(`(() => { const p = window.__orchScene.where(${JSON.stringify(id)}); if (!p) return null; const s = window.__orchScene.boardSpots.find((b) => Math.hypot(b.x - p.x, b.z - p.z) < 0.05); return s ? { x: p.x, z: p.z } : null; })()`, 40000);
    await sleep(1200);
    await shot('planning-board');
    const act = await js(`(Object.values(window.__t.store().sessions).find((s) => s.employeeId === ${JSON.stringify(id)} && s.status === 'running') || {}).activity`);
    return `${ctx.planner} (${task}, ${act}) stands at the board at ${at.x.toFixed(1)}, ${at.z.toFixed(1)}`;
  });

  await step('3D office: a desk pod of one project is marked as that project zone, and its sign opens the project', async () => {
    // Nothing is marked on the floor until the owner switches it on.
    if ((await js(`window.__orchScene.zones.length`)) !== 0) throw new Error('project areas are marked although the setting is off');
    await officeExtra('Mark project areas on the floor', true);
    await waitFor(`window.__orchScene.zones.length > 0`, 8000);
    const zones = await js(`window.__orchScene.zones`);
    if (!zones.length) throw new Error('no project zone is marked although whole pods sit in one project');
    // The counts on the sign are the project's real task counts.
    const z = zones[0];
    const real = await js(`(() => { const t = Object.values(window.__t.store().tasks).filter((x) => x.projectId === ${JSON.stringify(z.projectId)} && x.kind !== 'review'); const n = (s) => t.filter((x) => x.status === s).length; return { inProgress: n('IN_PROGRESS'), blocked: n('BLOCKED'), done: n('DONE'), name: window.__t.store().projects[${JSON.stringify(z.projectId)}].name }; })()`);
    if (real.name !== z.name || real.inProgress !== z.inProgress || real.blocked !== z.blocked || real.done !== z.done) throw new Error(`the sign says ${JSON.stringify(z)} but the project has ${JSON.stringify(real)}`);
    // A pod with nobody in it is nobody's zone.
    const empty = await js(`(() => { const s = window.__t.store(); const taken = new Set(Object.values(s.employees).filter((e) => !e.archived && e.deskId).map((e) => e.deskId)); return ${JSON.stringify(zones.map((x) => x.id))}.filter((id) => !s.layout.desks.some((d) => d.id.startsWith(id.replace(/-[a-z]$/, '-')) && taken.has(d.id))); })()`);
    if (empty.length) throw new Error(`empty pods are marked as zones: ${empty.join(', ')}`);
    // Click the sign, from the overview camera, where a person would.
    await click(`window.__t.byText('Management', 'button', document.body)`, 'Management');
    await sleep(2500);
    let opened = null;
    for (const [zid, sign] of Object.entries(await js(`window.__orchScene.zoneSigns`))) {
      const p = await js(`(() => { const p = window.__orchScene.project(${sign.x}, ${sign.y}, ${sign.z}); const c = document.querySelector('canvas').getBoundingClientRect(); const x = Math.round(c.left + p.x), y = Math.round(c.top + p.y); const top = document.elementFromPoint(x, y); return { x, y, visible: p.visible, free: !!top && top.tagName === 'CANVAS' }; })()`);
      if (!p.visible || !p.free) continue;
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(500);
      if (await js(`window.__t.store().panel === 'projects' && window.__t.store().panelArg === ${JSON.stringify(sign.projectId)}`)) {
        opened = zid;
        break;
      }
    }
    await shot('project-zone');
    if (!opened) throw new Error('clicking a zone sign did not open its project');
    await waitFor(`!!document.querySelector('.win') && document.querySelector('.win').textContent.includes(${JSON.stringify(z.name)})`, 8000);
    await close();
    await click(`window.__t.byText('CEO', 'button', document.body)`, 'CEO');
    return `sign "${z.name}": ${z.inProgress} in progress, ${z.blocked} blocked, ${z.done} done — ${zones.length} zone(s); clicking the sign of pod ${opened} opened the project`;
  });

  await step('3D office: right-clicking an employee opens their menu; "Request report" asks their real session', async () => {
    await click(`window.__t.byText('Command center', 'button', document.body)`, 'Command center');
    await sleep(3500);
    const tag = `[...document.querySelectorAll('.tag')].find((t) => t.querySelector('.tag-name') && t.querySelector('.tag-name').textContent.trim().startsWith('Ava'))`;
    await waitFor(`!!(${tag}) && (${tag}).getBoundingClientRect().width > 0`, 10000);
    const menuOpen = `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Request report')`;
    let hit = null;
    for (const dy of [8, 16, 24, 34, 46, 60]) {
      const p = await js(`(() => { const r = (${tag}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.bottom + ${dy}) }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'right', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'right', clickCount: 1 });
      await sleep(400);
      if (await js(menuOpen)) {
        hit = dy;
        break;
      }
    }
    if (hit === null) throw new Error('right-clicking below the name tag never opened the employee menu');
    await shot('context-menu');
    await click(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Request report')`, 'Request report');
    await waitFor(`!(${menuOpen})`, 4000);
    await click(`window.__t.byText('CEO', 'button', document.body)`, 'CEO');
    return `menu opened by a right-click ${hit}px below the name tag`;
  });

  await step('Task panel: the owner approves a change that is waiting for review', async () => {
    await open('task', JSON.stringify(ctx.reviewTaskId));
    await clickText('Approve');
    await waitFor(`window.__t.store().tasks[${JSON.stringify(ctx.reviewTaskId)}].status === 'DONE'`, 30000);
    await close();
  });

  await step('Machines: an already-running tmux session is found and attached without restarting it', async () => {
    await open('hosts');
    await clickText('Bring in what is running there…');
    await waitFor(`/legacy-claude/.test(window.__t.scope().textContent)`, 10000);
    await shot('attach-dialog');
    await click(`window.__t.near('legacy-claude', 'Attach')`, 'Attach');
    await waitFor(`Object.values(window.__t.store().sessions).some((s) => s.tmuxSession === 'legacy-claude' && s.origin === 'attached' && s.status === 'running')`, 15000);
    await close();
  });

  await step('Team: a schedule change is saved (and put back)', async () => {
    await open('employee', `window.__t.emp('Ava').id + ':desk'`);
    const available = `window.__t.emp('Ava').schedule.available`;
    const was = await js(available);
    await click(`window.__t.checkbox('Available for work')`, 'Available for work');
    await clickText('Save schedule');
    await waitFor(`${available} === ${!was}`, 8000);
    await click(`window.__t.checkbox('Available for work')`, 'Available for work');
    await clickText('Save schedule');
    await waitFor(`${available} === ${was}`, 8000);
    await close();
    return `available: ${was} → ${!was} → ${was}`;
  });

  await step('Growth: a suggestion that widens permissions is applied by the owner', async () => {
    await open('growth');
    await clickText('Suggestions');
    await waitFor(`/docker build/.test(window.__t.scope().textContent)`, 10000);
    await shot('growth-suggestion');
    await click(`window.__t.near('docker build', 'Apply — I understand it widens permissions') || window.__t.near('docker build', 'Apply')`, 'Apply');
    await waitFor(`Object.values(window.__t.store().improvements).some((i) => i.kind === 'allow_rule' && i.status === 'applied')`, 8000);
    await close();
  });

  await step('Growth: a lesson is edited in place', async () => {
    await open('growth');
    for (const tab of ['Playbooks', 'Team knowledge']) {
      await clickText(tab);
      await sleep(400);
      if (await js(`!!window.__t.near(${JSON.stringify(ctx.lesson)}, 'Edit')`)) break;
    }
    await click(`window.__t.near(${JSON.stringify(ctx.lesson)}, 'Edit')`, 'Edit');
    await type(`window.__t.scope().querySelector('input[aria-label="Applies when"]')`, ctx.lessonWhen);
    await click(`window.__t.scope().querySelector('form textarea[aria-label="Lesson"]').closest('form').querySelector('button[type=submit]')`, 'Save');
    await waitFor(`Object.values(window.__t.store().lessons).some((l) => l.text === ${JSON.stringify(ctx.lesson)} && l.appliesWhen === ${JSON.stringify(ctx.lessonWhen)})`, 8000);
    await close();
  });

  await step('Overview: the search box filters the people list', async () => {
    await open('overview');
    const rows = `window.__t.scope().querySelectorAll('tr.tbl-click').length`;
    await waitFor(`${rows} > 3`, 8000);
    const all = await js(rows);
    await type(`window.__t.scope().querySelector('input[aria-label="Search employees"]')`, 'Sarah');
    await waitFor(`${rows} === 1 && /Sarah/.test(window.__t.scope().querySelector('tr.tbl-click').textContent)`, 5000);
    await type(`window.__t.scope().querySelector('input[aria-label="Search employees"]')`, 'zzzz-nobody');
    await waitFor(`${rows} === 0 && /No employee matches/.test(window.__t.scope().textContent)`, 5000);
    await close();
    return `${all} people → 1 → 0`;
  });

  await step('Map: filtering by one employee dims everyone else', async () => {
    await open('map');
    await js(`(() => { const sel = window.__t.scope().querySelector('select[aria-label="Filter by employee"]'); const o = [...sel.options].find((x) => x.textContent.trim() === 'Ava'); window.__t.setSelect(sel, o.value); return true; })()`);
    const summary = await waitFor(`(window.__t.scope().textContent.match(/1 of \\d+ match/) || [])[0]`, 5000);
    await clickText('Clear filter');
    await waitFor(`!/\\d+ of \\d+ match/.test(window.__t.scope().textContent)`, 5000);
    await close();
    return summary;
  });

  await step('Terminal wall: the Operations view shows builds, git activity, projects, resources and warnings from recorded facts', async () => {
    await open('wall');
    await clickText('Operations');
    await waitFor(`!!document.querySelector('.win .ops-grid')`, 5000);
    const titles = await js(`[...document.querySelectorAll('.win .ops-card .section-title')].map((e) => e.textContent.split(' — ')[0].replace(/ \\(\\d+\\)$/, ''))`);
    for (const want of ['Build results', 'Deployment activity', 'Git activity', 'Current projects', 'Resource usage', 'Infrastructure warnings']) if (!titles.includes(want)) throw new Error(`no "${want}" card (have: ${titles.join(', ')})`);
    const builds = await js(`document.querySelectorAll('.win .ops-card')[0].querySelectorAll('.ops-row').length`);
    const git = await js(`document.querySelectorAll('.win .ops-card')[2].querySelectorAll('.ops-row').length`);
    if (!builds || !git) throw new Error(`expected real builds and git activity from the work done so far (builds ${builds}, git ${git})`);
    await shot('ops-dashboard');
    await clickText('Terminals');
    await waitFor(`!document.querySelector('.win .ops-grid')`, 5000);
    await close();
    return `${builds} verification runs, ${git} commits/merges listed`;
  });

  await step('Task board: typing in the search box narrows the board', async () => {
    await open('tasks');
    const all = await js(`window.__t.scope().querySelectorAll('[draggable=true]').length`);
    await type(`window.__t.scope().querySelector('input[aria-label="Search tasks"]')`, 'UI-created marker');
    await waitFor(`window.__t.scope().querySelectorAll('[draggable=true]').length === 1`, 5000);
    const only = await js(`window.__t.scope().querySelector('[draggable=true]').textContent`);
    if (!/UI-created marker/.test(only)) throw new Error(`the remaining card is not the searched one: ${only.slice(0, 80)}`);
    await close();
    return `${all} cards → 1 ("${only.slice(0, 60)}")`;
  });

  await step('Projects: the Integration tab shows how the integration branch stands, and runs its tests on request', async () => {
    const pid = await js(`Object.values(window.__t.store().projects).find((p) => p.name === 'Customer Platform').id`);
    await open('projects', JSON.stringify(pid));
    await clickText('Integration');
    await waitFor(`/Ahead of the base/.test(window.__t.scope().textContent)`, 10000);
    await clickText('Test now');
    await waitFor(`/Last integration test/.test(window.__t.scope().textContent) && /on request/.test(window.__t.scope().textContent)`, 30000);
    const verdict = await js(`(window.__t.scope().textContent.match(/Integration tests(passing|failing|could not run)/) || [])[1]`);
    await shot('project-integration');
    await close();
    return `integration tests ${verdict}, run on request`;
  });

  await step('Reports: a document handed in by an employee is listed and shown formatted', async () => {
    await open('reports');
    await waitFor(`window.__t.scope().querySelectorAll('.report-row').length > 0`, 8000);
    const n = await js(`window.__t.scope().querySelectorAll('.report-row').length`);
    await click(`window.__t.scope().querySelector('.report-row')`, 'first report');
    await waitFor(`!!window.__t.scope().querySelector('.doc-body .md')`, 5000);
    const title = await js(`window.__t.scope().querySelector('.doc-head .strong').textContent`);
    await shot('reports');
    await close();
    return `${n} documents; opened "${title}"`;
  });

  await step('Map: filtering by project dims everyone else, and the filter clears', async () => {
    await open('map');
    await js(`(() => { const sel = window.__t.scope().querySelector('select[aria-label="Filter by project"]'); const o = [...sel.options].find((x) => x.textContent.trim() === ${JSON.stringify(ctx.projectName)}); window.__t.setSelect(sel, o.value); })()`);
    const summary = await waitFor(`(window.__t.scope().textContent.match(/\\d+ of \\d+ match/) || [])[0]`, 5000);
    await clickText('Clear filter');
    await waitFor(`!/\\d+ of \\d+ match/.test(window.__t.scope().textContent)`, 5000);
    await close();
    return summary;
  });

  await step('Terminal wall: a terminal is pinned and unpinned', async () => {
    await open('wall');
    await waitFor(`!!window.__t.byText('Pin')`, 10000);
    await clickText('Pin');
    await waitFor(`!!window.__t.byText('Pinned')`, 5000);
    await clickText('Pinned');
    await waitFor(`!window.__t.byText('Pinned')`, 5000);
    await close();
  });

  await step('Projects: a deny rule added on the Policy tab is saved', async () => {
    await open('projects');
    await click(`[...window.__t.scope().querySelectorAll('button.pw-list-btn')].find((b) => b.textContent.includes(${JSON.stringify(ctx.projectName)}))`, 'the project in the list');
    await clickText('Policy');
    await type(`window.__t.field('Deny rules')`, ctx.denyRule);
    await click(`window.__t.submit('Save policy')`, 'Save policy');
    await waitFor(`Object.values(window.__t.store().projects).find((p) => p.name === ${JSON.stringify(ctx.projectName)}).policy.deny.includes(${JSON.stringify(ctx.denyRule)})`, 8000);
    await close();
  });

  await step('Task panel: a task is deleted after its confirmation', async () => {
    // The app asks with a native confirm dialog, which cannot be clicked in a hidden window:
    // the question it asks is recorded and answered "OK" here.
    await js(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(String(m)); return true; }; true`);
    await open('task', JSON.stringify(ctx.throwawayTaskId));
    await clickText('Delete task');
    await waitFor(`!window.__t.store().tasks[${JSON.stringify(ctx.throwawayTaskId)}]`, 8000);
    const asked = await js(`window.__confirms.join(' | ')`);
    if (!/Delete .*This cannot be undone/s.test(asked)) throw new Error(`no delete confirmation was asked (got: ${asked.slice(0, 80)})`);
    await close();
    return `asked: "${asked.split('\\n')[0]}"`;
  });

  await step('Team: an employee without a session is archived after confirmation', async () => {
    await open('employee', `window.__t.emp(${JSON.stringify(ctx.tempEmployee)}).id`);
    await clickText('Archive employee…');
    await clickText('Archive employee');
    await waitFor(`window.__t.emp(${JSON.stringify(ctx.tempEmployee)}).archived === true`, 8000);
    await close();
  });

  await step('Command bar: a typed command is previewed, then executed with Enter', async () => {
    const status = `(Object.values(window.__t.store().projects).find((p) => p.name === ${JSON.stringify(ctx.projectName)}) || {}).status`;
    for (const [text, expected] of [[`pause ${ctx.projectName}`, 'paused'], [`resume ${ctx.projectName}`, 'active']]) {
      await key('G', 'g');
      await waitFor(`!!document.querySelector('.cmd input')`, 5000);
      await type(`document.querySelector('.cmd input')`, text);
      await key('Enter');
      await waitFor(`document.querySelector('.cmd-body') && /${ctx.projectName}/.test(document.querySelector('.cmd-body').textContent) && !/Working…/.test(document.querySelector('.cmd-body').textContent)`, 10000);
      if ((await js(status)) === expected) throw new Error('the command ran before it was confirmed');
      await key('Enter');
      await waitFor(`${status} === ${JSON.stringify(expected)}`, 10000);
      await key('Escape');
      await waitFor(`!document.querySelector('.cmd')`, 5000);
    }
    return 'pause → paused, resume → active';
  });

  await step('Right-click menu: every entry does what it says', async () => {
    await close();
    const done = [];
    const entries = [
      ['Talk', `window.__t.store().panel === 'talk'`],
      ['Open terminal', `!!document.querySelector('.ws .xterm')`],
      ['Inspect work', `!!document.querySelector('.ws .xterm')`],
      ['Assign task…', `!!document.querySelector('.win') && /New task/.test(document.querySelector('.win h2').textContent) && /Ava/.test(document.querySelector('.win').textContent)`],
      ['View skills', `window.__t.store().panel === 'employee' && /Ava/.test(document.querySelector('.win').textContent)`],
      ['View history', `window.__t.store().panel === 'employee' && String(window.__t.store().panelArg).endsWith(':history')`],
      ['View current project', `window.__t.store().panel === 'projects'`],
      ['Change workstation…', `window.__t.store().panel === 'employee' && String(window.__t.store().panelArg).endsWith(':desk')`],
    ];
    for (const [label, expect] of entries) {
      await openEmployeeMenu('Ava');
      await click(menuItem(label), `menu entry "${label}"`);
      await waitFor(expect, 10000);
      if (await js(`!!document.querySelector('.ws')`)) {
        await clickText('Leave');
        await waitFor(`!document.querySelector('.ws')`, 5000);
      }
      await close();
      await sleep(500);
      done.push(label);
    }
    const activity = `(Object.values(window.__t.store().sessions).find((x) => x.employeeId === window.__t.emp('Ava').id && x.status === 'running') || {}).activity`;
    await openEmployeeMenu('Ava');
    await click(menuItem('Pause (interrupt)'), 'menu entry "Pause (interrupt)"');
    await waitFor(`${activity} === 'paused'`, 10000);
    await openEmployeeMenu('Ava');
    await click(menuItem('Resume'), 'menu entry "Resume"');
    await waitFor(`${activity} !== 'paused'`, 10000);
    done.push('Pause (interrupt)', 'Resume');
    await click(`window.__t.byText('CEO', 'button', document.body)`, 'CEO');
    return done.join(', ');
  });

  await step('Task panel: a task is marked done by hand, after the warning that it is unverified', async () => {
    await js(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(String(m)); return true; }; true`);
    await open('task', JSON.stringify(ctx.manualTaskId));
    await waitFor(`!!window.__t.scope().querySelector('select[aria-label="Move to another column"]')`, 5000);
    await js(`window.__t.setSelect(window.__t.scope().querySelector('select[aria-label="Move to another column"]'), 'DONE')`);
    await waitFor(`window.__t.store().tasks[${JSON.stringify(ctx.manualTaskId)}].status === 'DONE'`, 8000);
    const asked = await js(`window.__confirms.join(' | ')`);
    if (!/by hand/.test(asked) || !/not have verified/.test(asked)) throw new Error(`the unverified warning was not shown (got: ${asked.slice(0, 80)})`);
    await close();
    return `asked: "${asked.split('\n')[0]}"`;
  });

  await step('3D office: the meeting-room whiteboard shows the meeting that is running, with its round', async () => {
    const wb = await waitFor(`(() => { const w = window.__orchScene.whiteboard; return w && w.state === 'running' && w.title === ${JSON.stringify(ctx.cancelTopic)} ? { status: w.status, lines: w.lines } : null; })()`, 8000);
    if (!/Round \d of 3/.test(wb.status)) throw new Error(`no round on the board: "${wb.status}"`);
    const names = await js(`Object.values(window.__t.store().meetings).find((m) => m.topic === ${JSON.stringify(ctx.cancelTopic)}).participantIds.map((id) => window.__t.store().employees[id].name)`);
    for (const n of names) if (!wb.lines.some((l) => l.includes(n))) throw new Error(`${n} is in the meeting but not on the board`);
    return `"${ctx.cancelTopic}" — ${wb.status}; ${wb.lines.join(' | ')}`;
  });

  await step('Meetings: a running meeting is cancelled', async () => {
    await js(`window.__confirms = []; true`);
    await open('meetings');
    await click(`[...window.__t.scope().querySelectorAll('button.pw-list-btn')].find((b) => b.textContent.includes(${JSON.stringify(ctx.cancelTopic)}))`, 'the meeting in the list');
    await clickText('Cancel meeting');
    await waitFor(`Object.values(window.__t.store().meetings).some((m) => m.topic === ${JSON.stringify(ctx.cancelTopic)} && m.status === 'cancelled')`, 8000);
    await close();
    return `asked: "${(await js(`window.__confirms.join(' | ')`)).split('\n')[0]}"`;
  });

  await step('3D office: the whiteboard shows the last decision, and a click on it opens that meeting', async () => {
    await close();
    await click(`window.__t.byText('CEO', 'button', document.body)`, 'CEO');
    const wb = await waitFor(`(() => { const w = window.__orchScene.whiteboard; return w && w.state === 'concluded' && w.title === ${JSON.stringify(ctx.meetingTopic)} ? { ...w } : null; })()`, 8000);
    if (!wb.lines.some((l) => /Adopt the HTTP boundary/.test(l))) throw new Error(`the decision is not on the board: ${wb.lines.join(' | ')}`);
    // Walk into the meeting room and stand in front of it.
    await js(`window.__orchPlayer.goto = { x: ${wb.x}, z: ${wb.z + 2.3}, rot: ${Math.PI} }; true`);
    await sleep(2500);
    await shot('whiteboard');
    const p = await js(`(() => { const p = window.__orchScene.project(${wb.x}, ${wb.y + 0.3}, ${wb.z + 0.05}); const c = document.querySelector('canvas').getBoundingClientRect(); const x = Math.round(c.left + p.x), y = Math.round(c.top + p.y); const top = document.elementFromPoint(x, y); return { x, y, visible: p.visible, top: top ? top.tagName + '.' + top.className : null }; })()`);
    if (!p.visible || !/^CANVAS/.test(p.top)) throw new Error(`the whiteboard is not in clear view (${JSON.stringify(p)})`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
    await waitFor(`window.__t.store().panel === 'meetings' && window.__t.store().panelArg === ${JSON.stringify(wb.meetingId)}`, 6000);
    await waitFor(`!!document.querySelector('.win') && /Adopt the HTTP boundary/.test(document.querySelector('.win').textContent)`, 8000);
    await close();
    return `"${wb.title}" — ${wb.status}: ${wb.lines.slice(0, 4).join(' | ')}; a click on the board opened the meeting`;
  });

  await step('Office: an empty desk is removed', async () => {
    await js(`window.__confirms = []; true`);
    await open('office');
    const before = await js(`window.__t.store().layout.desks.length`);
    await click(`window.__t.scope().querySelector('button[title="Remove this empty desk"]')`, 'remove-desk button');
    await waitFor(`window.__t.store().layout.desks.length === ${before} - 1`, 8000);
    await close();
    return `${before} → ${before - 1} desks; asked: "${await js(`window.__confirms.join(' | ')`)}"`;
  });

  await step('3D office: standing in front of the hi-fi offers it, and Space opens the radio', async () => {
    await close();
    await click(`window.__t.byText('CEO', 'button', document.body)`, 'CEO');
    const spot = await js(`(window.__orchPlayer.spots || []).find((s) => s.kind === 'hifi') || null`);
    if (!spot) throw new Error('the office has no hi-fi to walk up to');
    await js(`window.__orchPlayer.goto = { x: ${spot.x}, z: ${spot.z}, rot: ${-Math.PI / 2} }; true`); // facing the west wall, where it stands
    await waitFor(`(() => { const n = window.__t.store().nearby; return !!n && n.kind === 'hifi'; })()`, 8000);
    await waitFor(`[...document.querySelectorAll('.prompt, .glass')].some((e) => /HI-FI/.test(e.textContent))`, 4000);
    await sleep(900);
    await shot('hifi-3d');
    await key('Space', ' ');
    await waitFor(`window.__t.store().panel === 'radio' && !!document.querySelector('.win .radio-now')`, 6000);
    await clickText('✕');
    await waitFor(`!document.querySelector('.win')`, 5000);
    return `stood at ${spot.x.toFixed(1)}, ${spot.z.toFixed(1)}; Space opened the radio`;
  });

  await step('3D office: an empty desk offers a seat; someone is seated there, moved with the menu, and swapped with a colleague', async () => {
    await close();
    await click(`window.__t.byText('CEO', 'button', document.body)`, 'CEO');
    const desks = () => js(`(() => { const s = window.__t.store(); const taken = new Set(Object.values(s.employees).filter((e) => !e.archived && e.deskId).map((e) => e.deskId)); return s.layout.desks.filter((d) => !taken.has(d.id) && d.kind !== 'executive').map((d) => d.id); })()`);
    const standAt = async (deskId) => {
      const seat = await js(`window.__orchPlayer.seatOf(${JSON.stringify(deskId)})`);
      await js(`window.__orchPlayer.goto = { x: ${seat.x}, z: ${seat.z} }; true`);
    };
    const deskOf = (name) => js(`window.__t.emp(${JSON.stringify(name)}).deskId`);
    // 1. Walk up to an empty desk: it offers to seat someone; choose a person in the window that opens.
    const [first, second] = await desks();
    await standAt(first);
    await waitFor(`(() => { const n = window.__t.store().nearby; return !!n && n.kind === 'desk' && n.id === ${JSON.stringify(first)}; })()`, 8000);
    await waitFor(`/SEAT SOMEONE AT THIS DESK/.test((document.querySelector('.prompt') || {}).textContent || '')`, 4000);
    await shot('empty-desk');
    await key('Space', ' ');
    await waitFor(`window.__t.store().panel === 'seat' && !!document.querySelector('.win')`, 8000);
    await type(`window.__t.scope().querySelector('input[aria-label="Search people"]')`, 'Scribe');
    await click(`window.__t.near('Scribe', 'Move here')`, 'Move here');
    await waitFor(`window.__t.emp('Scribe').deskId === ${JSON.stringify(first)} && !document.querySelector('.win')`, 8000);
    // 2. "Move to another desk…" from the right-click menu, then walk to a free desk and press Space.
    await openEmployeeMenu('Ava');
    await click(menuItem('Move to another desk…'), 'Move to another desk…');
    await waitFor(`window.__t.store().movingEmployeeId === window.__t.emp('Ava').id`, 4000);
    await click(`window.__t.byText('CEO', 'button', document.body)`, 'CEO');
    await standAt(second);
    await waitFor(`/SEAT AVA HERE/.test((document.querySelector('.prompt') || {}).textContent || '')`, 8000);
    await shot('moving-someone');
    await key('Space', ' ');
    await waitFor(`window.__t.emp('Ava').deskId === ${JSON.stringify(second)} && window.__t.store().movingEmployeeId === null`, 8000);
    // 3. Carry her to a colleague's desk: the two swap. Escape first, to see that it cancels.
    await js(`window.__t.store().setMoving(window.__t.emp('Ava').id)`);
    await key('Escape');
    await waitFor(`window.__t.store().movingEmployeeId === null`, 4000);
    await js(`window.__t.store().setMoving(window.__t.emp('Ava').id)`);
    const revDesk = await deskOf('Rev');
    await standAt(revDesk);
    await waitFor(`/SWAP SEATS WITH REV/.test((document.querySelector('.prompt') || {}).textContent || '')`, 8000);
    await key('Space', ' ');
    await waitFor(`window.__t.emp('Ava').deskId === ${JSON.stringify(revDesk)} && window.__t.emp('Rev').deskId === ${JSON.stringify(second)}`, 8000);
    return `Scribe seated at ${first}; Ava moved to ${second}, then swapped with Rev (${revDesk})`;
  });

  await step('3D office: the TV on the break room wall opens; put away it stays on, and the top bar turns it off', async () => {
    await close();
    await click(`window.__t.byText('CEO', 'button', document.body)`, 'CEO');
    const spot = await js(`(window.__orchPlayer.spots || []).find((s) => s.kind === 'tv') || null`);
    if (!spot) throw new Error('the office has no TV to walk up to');
    await js(`window.__orchPlayer.goto = { x: ${spot.x}, z: ${spot.z}, rot: ${Math.PI} }; true`);
    await waitFor(`(() => { const n = window.__t.store().nearby; return !!n && n.kind === 'tv'; })()`, 8000);
    await sleep(700);
    await shot('tv-3d');
    await key('Space', ' ');
    await waitFor(`window.__t.store().tv.on && !!document.querySelector('.tv-layer.tv-visible .tv-screen')`, 6000);
    // This test window is a plain browser page: the full browser exists only in the desktop app, and the TV says so.
    const said = await js(`(document.querySelector('.tv-note') || {}).textContent || ''`);
    if (!/only show YouTube videos/.test(said)) throw new Error(`unexpected TV content: ${said.slice(0, 80)}`);
    const marks = await js(`[...document.querySelectorAll('.tv-mark')].map((m) => m.textContent.trim())`);
    await shot('tv-open');
    await click(`document.querySelector('.tv-bar button[aria-label="Close and keep playing"]')`, 'put the TV away');
    await waitFor(`window.__t.store().panel === null && window.__t.store().tv.on && !document.querySelector('.tv-layer.tv-visible') && !!document.querySelector('.tv-layer')`, 5000);
    await click(`document.querySelector('button[aria-label="Turn the TV off"]')`, 'turn the TV off from the top bar');
    await waitFor(`!window.__t.store().tv.on && !document.querySelector('.tv-layer')`, 5000);
    return `bookmarks: ${marks.join(', ')}; stayed on when put away; switched off from the top bar`;
  });

  await step('Office: who sits where — a person is dragged to another seat, a table gets a label and one more seat', async () => {
    await js(`window.__confirms = []; window.confirm = (m) => { window.__confirms.push(String(m)); return true; }; true`);
    await open('office');
    await waitFor(`!!window.__t.scope().querySelector('.seat-table')`, 10000);
    const chip = `window.__t.scope().querySelector('.seat-chip[data-employee="Noor"]')`;
    const from = await js(`(${chip}).closest('.seat').dataset.desk`);
    const empty = `[...window.__t.scope().querySelectorAll('.seat.seat-empty')].find((x) => x.dataset.desk)`;
    const to = await js(`(${empty}).dataset.desk`);
    // HTML5 drag and drop, event by event (as on the task board).
    await js(`(() => { window.__dt = new DataTransfer(); (${chip}).dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt })); })()`);
    await sleep(120);
    const target = `window.__t.scope().querySelector('.seat[data-desk=${JSON.stringify(to)}]')`;
    await js(`(${target}).dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))`);
    await sleep(120);
    await shot('seating-drag');
    await js(`(${target}).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt }))`);
    await waitFor(`window.__t.emp('Noor').deskId === ${JSON.stringify(to)}`, 8000);
    // Drop her onto a colleague: the two swap.
    const other = await js(`(() => { const c = [...window.__t.scope().querySelectorAll('.seat-chip')].find((x) => x.dataset.employee !== 'Noor' && x.closest('.seat')); return { name: c.dataset.employee, desk: c.closest('.seat').dataset.desk }; })()`);
    await js(`(() => { window.__dt = new DataTransfer(); (${chip}).dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: window.__dt })); const t = window.__t.scope().querySelector('.seat[data-desk=${JSON.stringify(other.desk)}]'); t.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.__dt })); t.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.__dt })); })()`);
    await waitFor(`window.__t.emp('Noor').deskId === ${JSON.stringify(other.desk)} && window.__t.emp(${JSON.stringify(other.name)}).deskId === ${JSON.stringify(to)}`, 8000);
    // Write something on her table, and give it one more seat.
    const pod = other.desk.replace(/-[a-z]$/, '');
    const label = `window.__t.scope().querySelector('.seat-table[data-pod=${JSON.stringify(pod)}] input')`;
    await type(label, ctx.tableLabel);
    await key('Enter');
    await waitFor(`(window.__t.store().layout.podLabels || {})[${JSON.stringify(pod)}] === ${JSON.stringify(ctx.tableLabel)}`, 8000);
    const seats = await js(`window.__t.store().layout.desks.filter((d) => d.id.replace(/-[a-z]$/, '') === ${JSON.stringify(pod)}).length`);
    await click(`window.__t.byText('+ seat', 'button', window.__t.scope().querySelector('.seat-table[data-pod=${JSON.stringify(pod)}]'))`, '+ seat');
    await waitFor(`window.__t.store().layout.desks.filter((d) => d.id.replace(/-[a-z]$/, '') === ${JSON.stringify(pod)}).length === ${seats} + 1`, 8000);
    await shot('seating');
    await close();
    // The label stands on the table in the 3D office.
    await waitFor(`[...document.querySelectorAll('.pod-label')].some((e) => e.textContent === ${JSON.stringify(ctx.tableLabel)})`, 8000);
    return `Noor: ${from} → ${to} → swapped with ${other.name}; table ${pod} labelled and grown from ${seats} to ${seats + 1} seats`;
  });

  await step('CEO desk: how much Claude is left on each account, and an employee is put on another account', async () => {
    const card = (text) => `[...window.__t.scope().querySelectorAll('.claude-account')].find((c) => c.textContent.includes(${JSON.stringify(text)}))`;
    await open('ceo');
    await waitFor(`(() => { const c = ${card('dev@example.test')}; return !!c && /42% used/.test(c.textContent) && /85% used/.test(c.textContent) && /Dev Org/.test(c.textContent); })()`, 20000);
    const before = await js(`window.__t.scope().querySelectorAll('.claude-account').length`);
    // The same reading hangs on the CEO room wall as a clock: the big hand is the week, the small dial the 5 hours.
    await waitFor(`(window.__orchScene.clocks || []).some((c) => c.name === 'dev@example.test' && Math.round(c.week) === 85 && Math.round(c.five) === 42 && /Week: 15% left/.test(c.lines.join(' ')) && /5 hours: 58% left/.test(c.lines.join(' ')))`, 10000);
    await shot('ceo-claude');
    await close();
    await open('employee', `window.__t.emp('Ava').id`);
    await type(`window.__t.field('Claude account folder')`, '~/.claude-second');
    await clickText('Save changes');
    await waitFor(`window.__t.emp('Ava').claudeConfigDir === '~/.claude-second'`, 8000);
    await close();
    await open('ceo');
    // Her account is listed at once, without figures: nobody has worked on it yet.
    await waitFor(`(() => { const c = ${card('~/.claude-second')}; return !!c && /Not reported yet/.test(c.textContent) && /used by Ava/.test(c.textContent); })()`, 10000);
    const after = await js(`window.__t.scope().querySelectorAll('.claude-account').length`);
    await shot('ceo-claude-two');
    await close();
    // The second account gets a clock of its own at once, with its hands at rest until something is reported.
    await waitFor(`(window.__orchScene.clocks || []).length === ${after} && window.__orchScene.clocks.some((c) => c.week === null && /Not reported yet/.test(c.lines.join(' ')))`, 10000);
    // The office is drawn at an even rhythm: on every refresh of the display, or on every second one.
    const pace = await js(`window.__orchPace`);
    if (!pace || ![1, 2].includes(pace.every) || !(pace.fps > 20)) throw new Error(`the render loop reports ${JSON.stringify(pace)}`);
    return `${before} account → ${after}; the first shows 42% of 5 hours and 85% of the week`;
  });

  await step('Hi-fi: a station is added, plays, says what is on air, and is stopped from the top bar', async () => {

    await open('radio');
    await waitFor(`!!document.querySelector('.win .radio-now')`, 8000);
    const builtIn = await js(`window.__t.store().settings.radio.stations.map((x) => x.name).join(', ')`);
    await clickText('Add a station');
    await type(`window.__t.field('Name')`, ctx.radioName);
    await type(`window.__t.field('Stream address')`, ctx.radioUrl);
    await type(`window.__t.field('Now-playing address')`, ctx.radioNow);
    await click(`window.__t.submit('Add and play')`, 'Add and play');
    await waitFor(`window.__t.store().radio.status === 'playing' && window.__t.store().radio.name === ${JSON.stringify(ctx.radioName)}`, 15000);
    await waitFor(`window.__t.store().radio.nowPlaying === ${JSON.stringify(ctx.radioTitle)}`, 10000);
    // Volume: a real click in the middle of the slider.
    await click(`window.__t.scope().querySelector('.radio-volume input[type=range]')`, 'volume slider');
    await waitFor(`Math.abs(window.__t.store().settings.radio.volume - 0.5) < 0.1`, 8000);
    await shot('hifi-playing');
    await clickText('✕');
    await waitFor(`!document.querySelector('.win')`, 5000);
    await waitFor(`!!document.querySelector('.radio-mini') && document.querySelector('.radio-mini').textContent.includes(${JSON.stringify(ctx.radioTitle)})`, 5000);
    await click(`document.querySelector('.radio-mini button[aria-label="Stop the radio"]')`, 'the stop button in the top bar');
    await waitFor(`window.__t.store().radio.status === 'idle' && !document.querySelector('.radio-mini')`, 5000);
    return `stations before: ${builtIn}; "${ctx.radioName}" played "${ctx.radioTitle}", volume set to ${await js(`window.__t.store().settings.radio.volume`)}`;
  });

  await step('Machines: "Connect a server over SSH" checks a server with the real ssh client and says plainly why it cannot connect', async () => {
    await open('hosts');
    await clickText('Connect a server over SSH');
    const server = `window.__t.scope().querySelector('input[aria-label="Server"]')`;
    await type(server, 'not a server; rm -rf /');
    if (!(await js(`window.__t.byText('Check the server') === null || window.__t.byText('Check the server').disabled`))) throw new Error('nonsense was accepted as a server');
    // Nothing listens for SSH on port 1 of this machine: the real client is refused at once.
    await type(server, 'nobody@127.0.0.1:1');
    await clickText('Check the server');
    await waitFor(`/refused the connection|did not answer/.test(window.__t.scope().textContent)`, 30000);
    const said = await js(`[...window.__t.scope().querySelectorAll('.ssh-form .bad')].map((e) => e.textContent).join(' ')`);
    if (await js(`!!window.__t.byText('Connect', 'button') && !window.__t.byText('Connect', 'button').disabled && window.__t.byText('Connect', 'button').textContent.trim() === 'Connect'`)) throw new Error('Connect is enabled for a server that could not be checked');
    await shot('ssh-link-form');
    await clickText('Cancel');
    await close();
    return said.slice(0, 110);
  });

  await step('the command bar opens with its shortcut and previews before doing anything', async () => {
    await key('G', 'g');
    await waitFor(`!!document.querySelector('.cmd input')`, 5000);
    await type(`document.querySelector('.cmd input')`, ctx.command);
    await key('Enter');
    await waitFor(`document.querySelector('.cmd-body') && /${ctx.commandPreview}/i.test(document.querySelector('.cmd-body').textContent)`, 10000);
    await shot('command-preview');
    await key('Escape');
    await waitFor(`!document.querySelector('.cmd')`, 5000);
    return 'preview shown, nothing executed';
  });

  await step('the 3D office keeps a usable frame rate while every session is live (measured, not assumed)', async () => {
    await close();
    await click(`window.__t.byText('CEO', 'button', document.body)`, 'CEO');
    await js(`window.__orchPerf = null; true`);
    const samples = [];
    for (let i = 0; i < 3; i++) {
      await waitFor(`window.__orchPerf && window.__orchPerf.fps > 0`, 8000);
      samples.push(await js(`({ ...window.__orchPerf })`));
      await js(`window.__orchPerf = null; true`);
    }
    const fps = samples.map((s) => s.fps);
    const avg = fps.reduce((a, b) => a + b, 0) / fps.length;
    // This runs in a hidden window next to a dozen live sessions; the bar is "smooth enough to use", the number is reported as measured.
    if (avg < 24) throw new Error(`the scene averaged ${avg.toFixed(1)} fps (${fps.join(', ')})`);
    return `${avg.toFixed(1)} fps average over 6 s (${fps.join(', ')}); slowest frame ${Math.max(...samples.map((s) => s.worstFrameMs))} ms`;
  });

  await step('The foreman: hired with no desk, shown apart from the team, and walking the floor from desk to desk', async () => {
    await close();
    const hired = await js(`(async () => {
      const st = window.__office.getState();
      const folder = Object.values(st.sessions).map((x) => x.cwd).find(Boolean) || '/tmp';
      const r = await fetch('/api/employees', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ((window.orchestrator && window.orchestrator.token) || localStorage.getItem('orch.token') || '') }, body: JSON.stringify({ name: 'Mira', roleKey: 'foreman', workingDir: folder }) });
      return { status: r.status, body: await r.json() };
    })()`);
    if (hired.status !== 200 || hired.body.roleKey !== 'foreman') throw new Error(`hiring the foreman: ${JSON.stringify(hired).slice(0, 300)}`);
    if (hired.body.deskId !== null) throw new Error(`the foreman was given a desk: ${hired.body.deskId}`);
    const id = hired.body.id;
    // Hiring it switched its rounds on, so it walks; it is not one of the seated people.
    await waitFor(`window.__office.getState().settings.foreman.enabled === true && !!window.__orchScene.foreman && window.__orchScene.foreman().stops.length >= 3`, 12000);
    await waitFor(`[...document.querySelectorAll('.tag-foreman')].some((e) => /Mira/.test(e.textContent) && /FOREMAN · WHOLE OFFICE/.test(e.textContent))`, 12000);
    const seated = await js(`Object.keys(window.__orchScene.places || {}).includes(${JSON.stringify(id)})`);
    if (seated) throw new Error('the foreman is among the seated people');
    // It stands at somebody's desk, then goes on to the next one.
    // (It may be on its way across the whole office to someone a round called it to: that takes a while.)
    await waitFor(`(() => { const f = window.__orchScene.foreman(); return f.arrived && /^(stop|visit):/.test(f.key); })()`, 60000).catch(async (e) => {
      throw new Error(`${e.message} — ${JSON.stringify(await js(`window.__orchScene.foreman()`))}`);
    });
    const first = await js(`(() => { const f = window.__orchScene.foreman(); return { key: f.key, x: f.x, z: f.z, stops: f.stops.length }; })()`);
    await js(`window.__office.getState().setCameraMode('management'); true`);
    await new Promise((r) => setTimeout(r, 1500));
    await shot('foreman-walking');
    await js(`window.__office.getState().setCameraMode('ceo'); true`);
    await waitFor(`(() => { const f = window.__orchScene.foreman(); return f.arrived && /^(stop|visit):/.test(f.key) && f.key !== ${JSON.stringify(first.key)}; })()`, 75000);
    const second = await js(`(() => { const f = window.__orchScene.foreman(); return { key: f.key, x: f.x, z: f.z }; })()`);
    const walked = Math.hypot(second.x - first.x, second.z - first.z);
    if (walked < 0.5) throw new Error(`the foreman did not move between two desks (${walked.toFixed(2)} m)`);
    // In Team it has a line of its own, above the list — not a row among the employees.
    await js(`window.__office.getState().openPanel('team'); true`);
    await waitFor(`!!document.querySelector('[data-foreman=${JSON.stringify(id)}]')`, 8000);
    const card = await js(`document.querySelector('[data-foreman]').textContent`);
    if (!/Mira/.test(card) || !/no desk/.test(card)) throw new Error(`the foreman's line in Team: ${card.slice(0, 200)}`);
    const inTable = await js(`[...document.querySelectorAll('.tbl tbody tr')].some((r) => /Mira/.test(r.textContent))`);
    if (inTable) throw new Error('the foreman is also a row of the employee table');
    await close();
    return `${first.stops} desks on its walk; went from ${first.key} to ${second.key} (${walked.toFixed(1)} m)`;
  });

  await step('this computer\'s preferences, as they are stored at the end', async () => {
    return js(`localStorage.getItem('orch.prefs')`);
  });

  await step('the page is still alive and reported no errors', async () => {
    const alive = await js(`!!document.querySelector('canvas') && document.getElementById('root').children.length > 0`);
    const errs = [...(await js(`window.__errs`)), ...pageErrors];
    if (!alive) throw new Error('the React root is empty');
    if (errs.length) throw new Error([...new Set(errs)].slice(0, 6).join(' | '));
    return `${pageWarnings.length} console warning(s)`;
  });
}

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  win = new BrowserWindow({ width: 1600, height: 1000, show: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) pageErrors.push(`console.error: ${message} (during "${currentStep.slice(0, 70)}")`);
    else if (level === 2) pageWarnings.push(message);
  });
  win.webContents.on('render-process-gone', (_e, d) => pageErrors.push(`renderer gone: ${d.reason}`));
  win.webContents.on('did-fail-load', (_e, code, desc) => pageErrors.push(`load failed: ${desc}`));
  let fatal = null;
  try {
    win.webContents.setAudioMuted(true); // the whip and the radio are heard by nobody during the test
    await win.loadURL(url);
    await js(HELPERS);
    win.webContents.focus();
    await scenario();
  } catch (e) {
    fatal = e.message;
  }
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ results, pageErrors: [...new Set(pageErrors)], pageWarnings: [...new Set(pageWarnings)].slice(0, 20), fatal }, null, 2));
  app.quit();
});
