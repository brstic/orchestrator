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
/** `UI_ONLY=<regex>`: run only the steps whose name matches (for working on one; the checks at the end then mostly fail, by design). */
const ONLY = process.env.UI_ONLY ? new RegExp(process.env.UI_ONLY, 'i') : null;
async function step(name, fn) {
  if (ONLY && !ONLY.test(name)) return;
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
  const menuOpen = `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Their project')`;
  if ((await js(`window.__t.store().cameraMode`)) !== 'command') {
    await camera('Command center');
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
/** Choose a camera the way a person does: open the View menu in the top bar, click the view. */
async function camera(label) {
  if (!(await js(`!!document.querySelector('.cam-dock')`))) await click(`document.querySelector('.cam-btn')`, 'the View button');
  await waitFor(`!!document.querySelector('.cam-dock')`, 3000);
  await click(`[...document.querySelectorAll('.cam-dock .cam-item')].find((b) => b.querySelector('.cam-label').textContent.trim() === ${JSON.stringify(label)})`, `the ${label} view`);
  await waitFor(`!document.querySelector('.cam-dock')`, 3000);
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
      // Every window wears the one frame, and all of it is on the screen: what does not fit scrolls inside it.
      const box = await js(`(() => { const w = document.querySelector('.win'); const b = w.getBoundingClientRect(); return { kit: w.classList.contains('win-kit'), top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: innerHeight, w: innerWidth }; })()`);
      if (!box.kit) throw new Error(`the ${panel} window is not in the frame the others wear`);
      if (box.top < 0 || box.left < 0 || box.bottom > box.h || box.right > box.w) throw new Error(`the ${panel} window leaves the screen: ${JSON.stringify(box)}`);
      await clickText('✕');
      await waitFor(`!document.querySelector('.win')`, 5000);
      return title;
    });
  }

  await step('every camera mode can be selected from the top bar', async () => {
    const seen = [];
    for (const [label, mode] of [['First person', 'first'], ['Management', 'management'], ['Free cam', 'free'], ['Command center', 'command'], ['CEO', 'ceo']]) {
      await camera(label);
      await waitFor(`window.__t.store().cameraMode === ${JSON.stringify(mode)}`, 4000);
      await sleep(700);
      if (mode === 'command') await shot('camera-command');
      seen.push(mode);
    }
    return seen.join(' → ');
  });

  await step('command center view lists what needs the owner, everyone, and measured machine load', async () => {
    await camera('Command center');
    await waitFor(`!!document.querySelector('.cc')`, 5000);
    const text = await js(`document.querySelector('.cc').textContent`);
    for (const expected of ['Needs you', 'People', 'Machines', 'Sarah', 'David', 'dev-mac']) if (!text.includes(expected)) throw new Error(`"${expected}" is missing from the command center`);
    await waitFor(`/CPU \\d+% · RAM \\d+%/.test(document.querySelector('.cc').textContent)`, 15000);
    await shot('command-center');
    // A "needs you" row opens the real question.
    await click(`[...document.querySelectorAll('.cc .cc-row')].find((r) => /approval|question/.test(r.textContent))`, 'a needs-you row');
    await waitFor(`document.querySelector('.win') && /Allow this once|Option A/.test(document.querySelector('.win').textContent)`, 5000);
    await clickText('✕');
    await camera('CEO');
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
    // The tallest form there is: it stays on the screen, and what does not fit scrolls inside the window.
    await waitFor(`!!window.__t.field('Name')`, 5000);
    await sleep(300);
    const form = await js(`(() => { const b = document.querySelector('.win').getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: innerHeight }; })()`);
    if (form.top < 0 || form.bottom > form.h) throw new Error(`the hire form leaves the screen: ${JSON.stringify(form)}`);
    // What they think with is asked in one line: which Claude account of that machine, which model, how hard.
    const claude = await js(`[...window.__t.scope().querySelectorAll('[data-hire-claude] .field-label')].map((l) => l.textContent)`);
    if (claude.join('|') !== 'Account|Model|Effort') throw new Error(`the hire form asks: ${claude.join(', ')}`);
    const offered = await js(`[...window.__t.scope().querySelector('[data-hire-claude] select[aria-label="Claude account"]').options].map((o) => o.textContent)`);
    if (!/^dev@example\.test/.test(offered[0]) || offered[offered.length - 1] !== 'Another folder…') throw new Error(`the accounts offered when hiring: ${offered.join(' | ')}`);
    await type(`window.__t.field('Name')`, ctx.hireName);
    // No path typing: browse the machine's folders and choose one.
    await clickText('Browse…');
    await waitFor(`!!window.__t.near(${JSON.stringify(ctx.hireFolderName)}, 'Choose')`, 10000);
    // A folder that is not there yet is made right here — and is then the one chosen.
    await click(`window.__t.scope().querySelector('[data-new-folder]')`, 'New folder');
    await type(`window.__t.scope().querySelector('[data-new-folder-row] input')`, 'made-in-the-form');
    await clickText('Create and use');
    await waitFor(`/\\/made-in-the-form$/.test(window.__t.field('Folder they live in').value) && !window.__t.scope().querySelector('.fp')`, 8000);
    // (The step goes on with the folder prepared for it: the list opens in the new, empty folder — one up from there.)
    await clickText('Browse…');
    await waitFor(`!!window.__t.scope().querySelector('.fp button[title="Up one folder"]:not(:disabled)') && /No folders inside this one/.test(window.__t.scope().querySelector('.fp').textContent)`, 10000);
    await click(`window.__t.scope().querySelector('.fp button[title="Up one folder"]')`, 'up one folder');
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
    // Which model they think with and how hard: both in plain view, both on "Default" until chosen.
    const model = `window.__t.scope().querySelector('select[aria-label="Model"]')`;
    const effort = `window.__t.scope().querySelector('select[aria-label="Effort"]')`;
    const defaults = await js(`[(${model}).value, (${effort}).value, [...(${effort}).options].map((o) => o.value).join(',')].join('|')`);
    if (defaults !== '||,low,medium,high,xhigh,max') throw new Error(`model and effort start as "${defaults}"`);
    await js(`(() => { window.__t.setSelect(${model}, 'opus'); window.__t.setSelect(${effort}, 'high'); })()`);
    // How much they may do: an owner's hire starts as Unrestricted (the owner's default since 2026-11-11). Chosen here:
    // Auto — the first Unrestricted session of an account waits at Claude Code's own warning, which only the owner
    // accepts, in the terminal (tests/e2e/35-unrestricted); this step is about hiring and the first word.
    await clickText('More options');
    await waitFor(`!!window.__t.scope().querySelector('[role=radiogroup][aria-label="Autonomy"]')`, 3000);
    const level = `[...window.__t.scope().querySelectorAll('[role=radiogroup][aria-label="Autonomy"] label')].map((l) => [l.querySelector('.strong').textContent, l.querySelector('input').checked])`;
    const startsAs = await js(`(${level}).filter((x) => x[1]).map((x) => x[0]).join(',')`);
    if (startsAs !== 'Unrestricted') throw new Error(`an owner's hire starts as "${startsAs}"`);
    await click(`[...window.__t.scope().querySelectorAll('[role=radiogroup][aria-label="Autonomy"] label')].find((l) => l.querySelector('.strong').textContent === 'Auto').querySelector('input')`, 'Auto');
    await waitFor(`(${level}).filter((x) => x[1]).map((x) => x[0]).join(',') === 'Auto'`, 3000);
    await shot('hire-form');
    await clickText('Hire');
    await waitFor(`!!window.__t.emp(${JSON.stringify(ctx.hireName)})`, 10000);
    const runsOn = await js(`(() => { const e = window.__t.emp(${JSON.stringify(ctx.hireName)}); return e.model + '/' + e.effort; })()`);
    if (runsOn !== 'opus/high') throw new Error(`hired on ${runsOn} instead of the chosen opus/high`);
    if ((await js(`window.__t.emp(${JSON.stringify(ctx.hireName)}).deskId`)) !== ctx.hireDesk) throw new Error(`hired at ${await js(`window.__t.emp(${JSON.stringify(ctx.hireName)}).deskId`)} instead of the chosen desk ${ctx.hireDesk}`);
    // Hiring does not start a session: it starts when the owner first talks to them.
    const hasSession = `Object.values(window.__t.store().sessions).some((s) => s.employeeId === window.__t.emp(${JSON.stringify(ctx.hireName)}).id)`;
    await sleep(2500);
    if (await js(hasSession)) throw new Error('a session was started at hire');
    await js(`window.__t.store().openPanel('talk', window.__t.emp(${JSON.stringify(ctx.hireName)}).id)`);
    await type(`window.__t.scope().querySelector('textarea')`, 'Welcome aboard. @@fake: say glad-to-be-here@@');
    await clickText('Send');
    await waitFor(`Object.values(window.__t.store().sessions).some((s) => s.employeeId === window.__t.emp(${JSON.stringify(ctx.hireName)}).id && s.status === 'running')`, 20000);
    // (Their reply itself, in their bubble: the window's text also holds what was typed — in my bubble and, for a moment, still in the box.)
    await waitFor(`[...window.__t.scope().querySelectorAll('.talk-them')].some((b) => /glad-to-be-here/.test(b.textContent))`, 25000);
    // The session that started is on what was chosen.
    const started = await js(`(() => { const x = Object.values(window.__t.store().sessions).find((s) => s.employeeId === window.__t.emp(${JSON.stringify(ctx.hireName)}).id && s.status === 'running'); return x.model + '/' + x.effort; })()`);
    if (started !== 'opus/high') throw new Error(`their session runs on ${started}`);
    await js(`window.__t.store().openPanel(null)`);
    return 'hired on Opus with high effort, with no session; the first message started it and got a reply';
  });

  await step('hiring for several project folders at once: one employee per folder, named after it, nobody started', async () => {
    await js(`window.__t.store().openPanel('team', 'hire-many')`);
    // Step one: where they work. Nothing is chosen for the person when there is more than one place.
    await waitFor(`document.querySelectorAll('.win .hire-place').length >= 1`, 8000);
    if (await js(`document.querySelectorAll('.win .hire-place').length > 1 && !!document.querySelector('.win .bulk-item')`)) throw new Error('a place was chosen without asking');
    await js(`[...document.querySelectorAll('.win .hire-place')].find((b) => /dev-mac/.test(b.textContent)).click()`);
    await waitFor(`!!window.__t.near('portfolio', 'open ›', window.__t.scope())`, 10000).catch(() => undefined);
    await click(`[...window.__t.scope().querySelectorAll('.bulk-item')].find((r) => r.textContent.includes('portfolio')).querySelector('.fp-link')`, 'open portfolio');
    await waitFor(`[...window.__t.scope().querySelectorAll('.bulk-item')].some((r) => r.textContent.includes('xenon-panel'))`, 8000);
    await clickText('All repositories');
    await waitFor(`window.__t.scope().querySelectorAll('.bulk-row').length === 2`, 5000);
    // The third one is not a repository: tick it by hand.
    await click(`[...window.__t.scope().querySelectorAll('.bulk-item')].find((r) => r.textContent.includes('client notes')).querySelector('input[type=checkbox]')`, 'client notes');
    await waitFor(`window.__t.scope().querySelectorAll('.bulk-row').length === 3`, 5000);
    const names = await js(`[...window.__t.scope().querySelectorAll('.bulk-row input')].map((i) => i.value)`);
    if ([...names].sort().join(',') !== 'AiTuner,ClientNotes,XenonPanel') throw new Error(`names were ${names.join(', ')}`);
    // A name can be changed before hiring.
    await type(`[...window.__t.scope().querySelectorAll('.bulk-row input')].find((i) => i.value === 'ClientNotes')`, 'Scribe');
    await shot('hire-many');
    await clickText('Hire 3 employees');
    await waitFor(`['XenonPanel', 'AiTuner', 'Scribe'].every((n) => !!window.__t.emp(n))`, 15000);
    await sleep(2500);
    const started = await js(`Object.values(window.__t.store().sessions).filter((s) => ['XenonPanel', 'AiTuner', 'Scribe'].some((n) => window.__t.emp(n).id === s.employeeId)).length`);
    if (started) throw new Error(`${started} session(s) were started at hire`);
    await js(`window.__t.store().openPanel(null)`);
    return `hired ${names.filter((n) => n !== 'ClientNotes').join(', ')} and Scribe (renamed from ClientNotes); no session started`;
  });

  await step('the menu opens from the top-left button: every window with a picture and a line about it, found by a word of what it is for, and it leads to a window', async () => {
    if (await js(`!!document.querySelector('.dock')`)) throw new Error('the menu should be closed until asked for');
    await click(`document.querySelector('.brand-btn')`, 'the menu button');
    await waitFor(`!!document.querySelector('.dock')`, 3000);
    const items = await js(`[...document.querySelectorAll('.dock [role=menuitem]')].map((b) => ({ id: b.getAttribute('data-menu-item'), name: b.querySelector('.mn-name').textContent, about: (b.querySelector('.mn-about') || { textContent: '' }).textContent, icon: !!b.querySelector('svg'), foot: !!b.closest('.mn-foot') }))`);
    // Every window says what it is for (the two at the foot, Settings and Help, are known by their names).
    const bare = items.filter((i) => !i.icon || (!i.foot && i.about.length < 12));
    if (items.length < 15 || bare.length) throw new Error(`${items.length} windows in the menu; without a picture or a line about them: ${bare.map((i) => i.name).join(', ') || 'none'}`);
    // Two columns: it is wide, not long, and all of it is on the screen.
    const box = await js(`(() => { const d = document.querySelector('.dock').getBoundingClientRect(); const cols = [...document.querySelectorAll('.dock .mn-col')].map((c) => Math.round(c.getBoundingClientRect().left)); return { bottom: Math.round(d.bottom), height: innerHeight, cols, scrolls: document.querySelector('.dock').scrollHeight > document.querySelector('.dock').clientHeight + 2 }; })()`);
    if (box.cols.length !== 2 || box.cols[1] <= box.cols[0] || box.bottom > box.height || box.scrolls) throw new Error(`the menu's shape: ${JSON.stringify(box)}`);
    await shot('menu');
    // The box at the top has the keyboard: a word of what one wants finds the window, and Enter opens it.
    if (!(await js(`document.activeElement === document.querySelector('.dock .mn-find')`))) throw new Error('the box that finds a window does not have the keyboard when the menu opens');
    await win.webContents.insertText('password');
    await waitFor(`(() => { const l = [...document.querySelectorAll('.dock [role=menuitem]')].map((b) => b.querySelector('.mn-name').textContent); return l.length === 2 && l.includes('Vault') && l.includes('Access'); })()`, 4000);
    // Typing here is not walking: the keys stay in the box.
    await win.webContents.insertText('s keys');
    await waitFor(`[...document.querySelectorAll('.dock [role=menuitem]')].map((b) => b.querySelector('.mn-name').textContent).join('|') === 'Vault'`, 4000);
    await key('Enter');
    await waitFor(`window.__t.store().panel === 'vault' && !document.querySelector('.dock')`, 5000);
    await js(`window.__t.store().openPanel(null)`);
    // Something nobody has: it says so, and how to look.
    await click(`document.querySelector('.brand-btn')`, 'the menu button');
    await waitFor(`!!document.querySelector('.dock')`, 3000);
    await win.webContents.insertText('zzzz');
    await waitFor(`!!document.querySelector('.dock .mn-none') && !document.querySelector('.dock [role=menuitem]')`, 4000);
    await key('Escape');
    await waitFor(`!document.querySelector('.dock')`, 3000);
    // And a click on a window's line opens it.
    await click(`document.querySelector('.brand-btn')`, 'the menu button');
    await waitFor(`!!document.querySelector('.dock')`, 3000);
    await click(`window.__t.byText('Team', 'button', document.querySelector('.dock'))`, 'Team');
    await waitFor(`window.__t.store().panel === 'team' && !document.querySelector('.dock')`, 5000);
    await js(`window.__t.store().openPanel(null)`);
    return `${items.length} windows, each with a line; "passwords keys" → Vault`;
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
    const titleBox = `window.__t.scope().querySelector('[data-ticket-new] input[aria-label="Title"]')`;
    await waitFor(`!!(${titleBox})`, 5000);
    await js(`(() => { const sel = window.__t.field('Assignee'); const v = window.__t.emp('Noor').id; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, v); sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await type(titleBox, ctx.taskTitle);
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

  await step('an answer that comes after I walked away is announced: dots while they work, then a card and a bubble over their head', async () => {
    const ava = await js(`window.__t.emp('Ava').id`);
    await js(`window.__t.store().openPanel('talk', ${JSON.stringify(ava)})`);
    await type(`window.__t.scope().querySelector('textarea')`, 'And one more thing @@fake: sleep 2500; say later-answer-5512 is ready@@');
    await clickText('Send');
    await waitFor(`!!window.__t.store().asks[${JSON.stringify(ava)}]`, 8000);
    // Walk away from the conversation before the answer is there.
    await js(`window.__t.store().openPanel(null)`);
    await waitFor(`!!document.querySelector('.talkmark-waiting')`, 6000);
    const before = await js(`document.querySelectorAll('.reply-card').length`);
    await waitFor(`[...document.querySelectorAll('.reply-card')].some((c) => /Ava answered you/.test(c.textContent) && /later-answer-5512/.test(c.textContent))`, 25000);
    await waitFor(`!!document.querySelector('.talkmark-answered') && !document.querySelector('.talkmark-waiting')`, 6000);
    await shot('answer-waiting');
    // It is remembered by this computer across a reload of the window…
    const kept = await js(`JSON.stringify(Object.keys(JSON.parse(localStorage.getItem('orch.talk-waiting')).replies))`);
    // …and reading it is opening the conversation.
    await js(`document.querySelector('.reply-card .reply-main').click()`);
    await waitFor(`window.__t.store().panel === 'talk' && window.__t.store().panelArg === ${JSON.stringify(ava)} && document.querySelectorAll('.reply-card').length === 0 && !document.querySelector('.talkmark-answered')`, 6000);
    await js(`window.__t.store().openPanel(null)`);
    if (before !== 0 || kept !== JSON.stringify([ava])) throw new Error(`cards before the answer: ${before}; remembered: ${kept}`);
    return 'dots → "Ava answered you" card and bubble → gone once the conversation is opened';
  });

  await step('the dots are there only while somebody can be working on what I said: none over someone between turns, none in the air for someone who is gone', async () => {
    const ava = await js(`window.__t.emp('Ava').id`);
    await waitFor(`Object.values(window.__t.store().sessions).some((x) => x.employeeId === ${JSON.stringify(ava)} && x.status === 'running' && x.inTurn === false)`, 8000);
    if (await js(`document.querySelectorAll('.talkmark').length + document.querySelectorAll('.reply-card').length`)) throw new Error('a mark or a card before anything was said');
    // What this computer remembers from before: I said something to Ava a while ago and the end of that turn never
    // reached this window (it was closed, or the turn was cut short) — and something to an employee who has since
    // been let go.
    await js(`window.__office.setState((s) => ({ asks: { ...s.asks, [${JSON.stringify(ava)}]: { messageId: null, at: Date.now() - 3600000 }, 'emp-who-left': { messageId: null, at: Date.now() - 3600000 } } })); true`);
    await sleep(700);
    const dots = await js(`document.querySelectorAll('.talkmark-waiting').length`);
    if (dots !== 0) throw new Error(`${dots} set(s) of dots in the office although nobody is working on anything I said`);
    // The waits themselves end a moment later instead of being kept for a day. What Ava said last since then is
    // still among the office's events, so it is put up as her answer; for the one who left there is nothing.
    await waitFor(`Object.keys(window.__t.store().asks).length === 0`, 9000);
    await waitFor(`document.querySelectorAll('.reply-card').length === 1 && /Ava answered you/.test(document.querySelector('.reply-card').textContent) && /later-answer-5512/.test(document.querySelector('.reply-card').textContent)`, 4000);
    const marks = await js(`document.querySelectorAll('.talkmark-waiting').length + '/' + document.querySelectorAll('.talkmark-answered').length + '/' + Object.keys(window.__t.store().replies).join(',')`);
    if (marks !== `0/1/${ava}`) throw new Error(`after the waits ended: dots/bubbles/answers = ${marks}`);
    await shot('wait-ended');
    await js(`document.querySelector('.reply-card .reply-x').click()`);
    await waitFor(`document.querySelectorAll('.reply-card').length === 0 && document.querySelectorAll('.talkmark').length === 0`, 4000);
    return 'no dots; both waits ended by themselves, the answer that was missed is shown';
  });

  await step('an employee gives me a file in the conversation: the picture is shown there, and it can be downloaded', async () => {
    const ava = await js(`window.__t.emp('Ava').id`);
    const cwd = await waitFor(`(Object.values(window.__t.store().sessions).find((x) => x.employeeId === ${JSON.stringify(ava)} && x.status === 'running' && x.inTurn === false) || {}).cwd`, 15000);
    // (Something for her to show: the scripted worker cannot draw.)
    const file = path.join(cwd, 'shot-for-the-boss.png');
    fs.writeFileSync(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    try {
      await js(`window.__t.store().openPanel('talk', ${JSON.stringify(ava)})`);
      await type(`window.__t.scope().querySelector('textarea')`, 'Show me how it looks. @@fake: mcp attach_file {"path":"shot-for-the-boss.png","caption":"The page as it is now"}; say here-is-the-picture-8841@@');
      await clickText('Send');
      await waitFor(`!!window.__t.scope().querySelector('[data-talk-file="shot-for-the-boss.png"] img')`, 30000);
      const shown = await js(`window.__t.scope().querySelector('[data-talk-file="shot-for-the-boss.png"]').textContent`);
      if (!/The page as it is now/.test(shown) || !/Download/.test(shown)) throw new Error(`the file in the conversation reads: ${shown.slice(0, 160)}`);
      await waitFor(`[...window.__t.scope().querySelectorAll('.talk-them')].some((b) => /here-is-the-picture-8841/.test(b.textContent))`, 20000);
      await shot('talk-file');
    } finally {
      fs.rmSync(file, { force: true });
    }
    await js(`window.__t.store().openPanel(null)`);
    return 'a picture from her, with what it shows and a way to download it';
  });

  await step('an employee gives me a video: it says Play, and it plays in the window instead of being downloaded', async () => {
    const ava = await js(`window.__t.emp('Ava').id`);
    const cwd = await waitFor(`(Object.values(window.__t.store().sessions).find((x) => x.employeeId === ${JSON.stringify(ava)} && x.status === 'running' && x.inTurn === false) || {}).cwd`, 15000);
    // (A real one second of H.264, 64×48: tests/fixtures/tiny.mp4.)
    const file = path.join(cwd, 'demo-of-the-page.mp4');
    fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'tiny.mp4'), file);
    try {
      await js(`window.__t.store().openPanel('talk', ${JSON.stringify(ava)})`);
      await type(`window.__t.scope().querySelector('textarea')`, 'Record it for me. @@fake: mcp attach_file {"path":"demo-of-the-page.mp4","caption":"The page, clicked through"}; say here-is-the-video-5520@@');
      await clickText('Send');
      const chip = `window.__t.scope().querySelector('[data-talk-file="demo-of-the-page.mp4"] [data-file="demo-of-the-page.mp4"]')`;
      await waitFor(`!!${chip} && ${chip}.dataset.fileReads === 'video' && /Play/.test(${chip}.textContent)`, 30000);
      await click(chip, 'the video\'s chip');
      // It plays: the player has the frames, and nothing was downloaded instead.
      await waitFor(`(() => { const v = document.querySelector('[data-video="demo-of-the-page.mp4"] video'); return !!v && !v.error && v.readyState >= 2 && v.videoWidth === 64; })()`, 10000);
      await js(`(() => { const v = document.querySelector('[data-video] video'); v.pause(); v.currentTime = 0.5; return true; })()`);
      await sleep(300);
      await shot('talk-video');
      // Escape closes the player and only the player.
      await key('Escape');
      await waitFor(`!document.querySelector('[data-video]') && window.__t.store().panel === 'talk'`, 4000);
    } finally {
      fs.rmSync(file, { force: true });
    }
    await js(`window.__t.store().openPanel(null)`);
    return 'a video from her: "▶ Play", played in the window (64×48, no error), Escape closed only the player';
  });

  await step('an employee gives me a sound (an mp3): it says Play, and it plays in the window', async () => {
    const ava = await js(`window.__t.emp('Ava').id`);
    const cwd = await waitFor(`(Object.values(window.__t.store().sessions).find((x) => x.employeeId === ${JSON.stringify(ava)} && x.status === 'running' && x.inTurn === false) || {}).cwd`, 15000);
    // (A real 0.6 s tone: tests/fixtures/tiny.mp3.)
    const file = path.join(cwd, 'voice-note.mp3');
    fs.copyFileSync(path.join(__dirname, '..', 'fixtures', 'tiny.mp3'), file);
    try {
      await js(`window.__t.store().openPanel('talk', ${JSON.stringify(ava)})`);
      await type(`window.__t.scope().querySelector('textarea')`, 'Send me the voice note. @@fake: mcp attach_file {"path":"voice-note.mp3","caption":"What I said in the standup"}; say here-is-the-sound-6630@@');
      await clickText('Send');
      const chip = `window.__t.scope().querySelector('[data-talk-file="voice-note.mp3"] [data-file="voice-note.mp3"]')`;
      await waitFor(`!!${chip} && ${chip}.dataset.fileReads === 'audio' && /Play/.test(${chip}.textContent)`, 30000);
      await click(chip, 'the sound\'s chip');
      await waitFor(`(() => { const a = document.querySelector('[data-sound="voice-note.mp3"] audio'); return !!a && !a.error && a.readyState >= 2 && a.duration > 0.4; })()`, 10000);
      await shot('talk-sound');
      await key('Escape');
      await waitFor(`!document.querySelector('[data-sound]') && window.__t.store().panel === 'talk'`, 4000);
    } finally {
      fs.rmSync(file, { force: true });
    }
    await js(`window.__t.store().openPanel(null)`);
    return 'a sound from her: "▶ Play", played in the window (0.6 s, no error), Escape closed only the player';
  });

  await step('the arcade: a cartridge of my own runs on the office\'s Mega Drive, the keys are the same for everybody and nothing is chosen, the office does not hear them, a second window joins with the second pad, and where I stopped is kept', async () => {
    // A cartridge written for this (tests/fixtures/md-test-rom.mjs): the colour of its screen says what both pads hold.
    const { buildTestRom, padsOf } = await import(require('node:url').pathToFileURL(path.join(__dirname, '..', 'fixtures', 'md-test-rom.mjs')).href);
    const rom = buildTestRom().toString('base64');
    // Read from the console's own picture, inside its frame (a capture of the window gives colours as this machine's
    // display shows them, which are not the ones that were drawn). Asked for after the emulator has drawn a frame.
    const consoleFrame = () => win.webContents.mainFrame.framesInSubtree.find((f) => /\/assets\/arcade\.html/.test(f.url));
    const drawn = () =>
      consoleFrame().executeJavaScript(
        // (The picture is there only from the moment a frame is drawn until the page has shown it; in between it is
        // empty. So it is looked at over and over, at every kind of moment, until it is there — two seconds at most.)
        `new Promise((done) => { const c = document.querySelector('canvas'); const gl = c.getContext('webgl2') || c.getContext('webgl'); const px = new Uint8Array(4); const from = performance.now(); let over = false; const look = () => { if (over) return false; gl.readPixels(c.width >> 1, c.height >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); if (px[0] + px[1] + px[2] === 0 && performance.now() - from < 2000) return false; over = true; done([px[0], px[1], px[2]]); return true; }; const again = () => { if (look()) return; requestAnimationFrame(look); setTimeout(again, 0); }; again(); })`,
        true,
      );
    const held = async () => {
      const [r, g, b] = await drawn();
      const h = padsOf(r, g, b);
      return h.running ? ['p1', 'p2'].map((p) => `${p}:${['a', 'b', 'c', 'start'].filter((k) => h[p][k]).join('+')}`).join(' ') : `not running (${r}, ${g}, ${b})`;
    };
    /** What a person sees where the screen is: the window as it is shown. */
    const seen = async () => {
      const at = await js(`(() => { const b = document.querySelector('[data-arcade-screen]').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      const px = (await win.webContents.capturePage({ x: at.x - 2, y: at.y - 2, width: 4, height: 4 })).toBitmap(); // BGRA
      return { r: px[2], g: px[1], b: px[0] };
    };
    const shows = async (want, what) => {
      let got = '';
      for (const end = Date.now() + 6000; Date.now() < end; await sleep(120)) if ((got = await held()) === want) return;
      throw new Error(`${what}: the screen says "${got}", expected "${want}"`);
    };
    const keys = (type, ...codes) => codes.forEach((keyCode) => win.webContents.sendInputEvent({ type, keyCode }));
    const running = () => waitFor(`document.querySelector('[data-arcade-play-view]')?.dataset.arcadePhase === 'running'`, 40000);
    const card = `document.querySelector('[data-arcade-game="Orchestrator Pad Test"]')`;

    await js(`window.__t.store().openPanel('arcade')`);
    await waitFor(`!!document.querySelector('[data-arcade-add]')`, 10000);
    await js(`(() => { const b = Uint8Array.from(atob(${JSON.stringify(rom)}), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([b], 'Pad Test (World).md')); const i = document.querySelector('[data-arcade-add]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitFor(`!!${card}`, 10000);
    await shot('arcade-shelf');
    await click(`${card}.querySelector('[data-arcade-play]')`, 'Play');
    await running();
    const frame = await js(`(() => { const f = document.querySelector('[data-arcade-screen] iframe'); return { sandbox: f.getAttribute('sandbox'), src: f.getAttribute('src') }; })()`);
    if (frame.sandbox !== 'allow-scripts') throw new Error(`the console's frame is sandboxed as "${frame.sandbox}"`);
    await shows('p1: p2:', 'nothing held');
    // And the picture is on the page, not only in the console: the cartridge's dark blue where the screen is.
    const blue = await seen();
    if (!(blue.b > 80 && blue.r < 30 && blue.g < 30)) throw new Error(`where the screen is, the window shows (${blue.r}, ${blue.g}, ${blue.b}), not the cartridge's blue`);
    // The console opened its sound, and it plays (the cartridge itself is silent: this is the output, not a tune).
    const sound = await waitFor(`document.querySelector('[data-arcade-play-view]').dataset.arcadeSoundState`, 8000);
    if (sound !== 'on') throw new Error(`the console's sound is "${sound}"`);

    // One player, the whole keyboard. The office hears none of it: W would walk.
    const was = await js(`({ x: window.__orchPlayer.x, z: window.__orchPlayer.z, rot: window.__orchPlayer.rot })`);
    keys('keyDown', 'W', 'K');
    await shows('p1:b p2:', 'player 1 holds K (B)');
    await sleep(500);
    keys('keyUp', 'W', 'K');
    await shows('p1: p2:', 'let go');
    const now = await js(`({ x: window.__orchPlayer.x, z: window.__orchPlayer.z, rot: window.__orchPlayer.rot, focus: document.activeElement.tagName })`);
    if (Math.hypot(now.x - was.x, now.z - was.z) > 0.01 || Math.abs(now.rot - was.rot) > 0.001) throw new Error(`the keys of the game moved the owner in the office: ${JSON.stringify(was)} → ${JSON.stringify(now)}`);
    if (now.focus === 'IFRAME') throw new Error('the console took the keyboard from the window');

    // Nothing is chosen: one person at a computer holds one pad, and the keys are the same for everybody.
    const chooser = await js(`({ selects: document.querySelectorAll('[data-arcade] select').length, text: document.querySelector('[data-arcade]').textContent, legend: document.querySelector('[data-arcade-keys] [data-arcade-legend]')?.textContent.trim() || '', pad: !!document.querySelector('[data-arcade-pad-legend]') })`);
    if (chooser.selects || /Player [12]|Keyboard|Nobody/.test(chooser.text)) throw new Error(`the arcade still asks who plays with what: ${chooser.selects} choices, "${chooser.text.slice(0, 200)}"`);
    if (!/^W A S D to move .*J K L = A B C .*U I O = X Y Z .*Enter = Start$/.test(chooser.legend) || chooser.pad) throw new Error(`the keys as the arcade names them: ${JSON.stringify(chooser)}`);
    // (That the old second half of the keyboard — F G H, R T Y, 1 — is no button any more is the unit test's: here those keys are the office's.)
    keys('keyDown', 'J', 'L', 'Enter');
    await shows('p1:a+c+start p2:', 'J L Enter are my A, C and Start');
    // Seen on the page too: red from player 1's buttons is in the picture now.
    const red = await seen();
    if (!(red.r > 40)) throw new Error(`with buttons held the window shows (${red.r}, ${red.g}, ${red.b})`);
    keys('keyUp', 'J', 'L', 'Enter');
    await shows('p1: p2:', 'let go');

    // A gamepad (one this page is shown; there is none on the machine) is the same pad, with nothing to choose.
    await js(`(() => { window.__padHeld = []; navigator.getGamepads = () => [{ index: 0, id: 'Test Pad (STANDARD GAMEPAD Vendor: 0000 Product: 0000)', connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, (_x, i) => ({ pressed: window.__padHeld.includes(i), touched: false, value: 0 })) }, null, null, null]; return true; })()`);
    try {
      await waitFor(`/^Your gamepad works too: D-pad/.test(document.querySelector('[data-arcade-pad-legend]')?.textContent || '')`, 5000);
      await js(`window.__padHeld = [2, 9]; true`);
      await shows('p1:a+start p2:', 'the gamepad\'s X and Start are my A and Start');
      // A button held by a key and by the gamepad is held until both let go.
      keys('keyDown', 'J', 'K');
      await shows('p1:a+b+start p2:', 'K beside the gamepad');
      await js(`window.__padHeld = []; true`);
      await shows('p1:a+b p2:', 'the gamepad let go: J still holds A');
      keys('keyUp', 'J', 'K');
      await shows('p1: p2:', 'let go');
    } finally {
      await js(`delete navigator.getGamepads; true`).catch(() => undefined);
    }

    // ── With somebody in the office, each at their own computer: a second window of the office sits down at this game. ──
    const shelf = await js(`window.__t.store().arcade.games.map((g) => g.title)`);
    if (!shelf.includes('Orchestrator Pad Test')) throw new Error(`the game is not on the office's shelf: ${JSON.stringify(shelf)}`);
    // (A game is open to the office from its start: nothing to press.)
    await waitFor(`document.querySelector('[data-arcade-play-view]').dataset.arcadeOpen === 'true' && window.__t.store().arcade.tables.length === 1`, 8000);
    const guest = new BrowserWindow({ width: 1300, height: 900, show: false, webPreferences: { backgroundThrottling: false } });
    const gjs = (code) => guest.webContents.executeJavaScript(code, true);
    const gwait = async (code, timeout = 15000, what = code) => {
      for (const end = Date.now() + timeout; Date.now() < end; await sleep(120)) {
        const v = await gjs(`(() => { try { return (${code}); } catch (e) { return null; } })()`).catch(() => null);
        if (v) return v;
      }
      throw new Error(`the second window: timed out waiting for ${String(what).slice(0, 140)}`);
    };
    const gclick = async (finder) => {
      const at = await gjs(`(() => { const b = (${finder}).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) guest.webContents.sendInputEvent({ type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
    };
    const gkeys = (type, ...codes) => codes.forEach((keyCode) => guest.webContents.sendInputEvent({ type, keyCode }));
    let together = '';
    try {
      guest.webContents.setAudioMuted(true);
      await guest.loadURL(win.webContents.getURL());
      guest.webContents.setZoomFactor(1);
      guest.webContents.focus();
      await gwait(`window.__office && window.__office.getState().ready`, 30000, 'the office in the second window');
      // The game somebody else brought is on this window's shelf too, and the game being played is offered.
      await gjs(`window.__office.getState().openPanel('arcade')`);
      await gwait(`!!document.querySelector('[data-arcade-game="Orchestrator Pad Test"]') && !!document.querySelector('[data-arcade-table] [data-arcade-join]')`, 15000, 'the shelf and the table');
      await gclick(`document.querySelector('[data-arcade-table] [data-arcade-join]')`);
      await gwait(`document.querySelector('[data-arcade-remote]')?.dataset.arcadeRemoteAs === 'player' && Number(document.querySelector('[data-arcade-remote]').dataset.shownV) > 10`, 20000, 'the picture, with the second pad in hand');
      // What the second window is shown: the middle of its picture, read as the test cartridge's colours.
      const far = async () => {
        const [r, g, b] = await gjs(`[...document.querySelector('[data-arcade-far]').getContext('2d').getImageData(320, 240, 1, 1).data]`);
        const h = padsOf(r, g, b);
        return h.running ? ['p1', 'p2'].map((p) => `${p}:${['a', 'b', 'c', 'start'].filter((k) => h[p][k]).join('+')}`).join(' ') : `not running (${r}, ${g}, ${b})`;
      };
      const farShows = async (want, what) => {
        let got = '';
        for (const end = Date.now() + 8000; Date.now() < end; await sleep(120)) if ((got = await far()) === want) return;
        throw new Error(`${what}: the second window is shown "${got}", expected "${want}"`);
      };
      await farShows('p1: p2:', 'the game as it stands');
      await waitFor(`/plays with you/.test(document.querySelector('[data-arcade-open-line]').textContent)`, 8000);
      // The second window is told the same keys, and is asked nothing either.
      const theirs = await gjs(`({ selects: document.querySelectorAll('[data-arcade] select').length, legend: document.querySelector('[data-arcade-keys] [data-arcade-legend]')?.textContent.trim() || '' })`);
      if (theirs.selects || !/^W A S D to move/.test(theirs.legend)) throw new Error(`the keys in the second window: ${JSON.stringify(theirs)}`);
      // Their keys are the second pad at my console, and they see what that does; mine are still the first.
      gkeys('keyDown', 'K', 'Enter');
      await shows('p1: p2:b+start', 'at my console: K and Enter in the second window are player 2\'s B and Start');
      await farShows('p1: p2:b+start', 'and the second window sees it');
      keys('keyDown', 'J');
      await farShows('p1:a p2:b+start', 'my J is player 1\'s A, seen from the second window');
      await shot('arcade-together-host');
      fs.writeFileSync(path.join(outDir, 'arcade-together-guest.png'), (await guest.webContents.capturePage()).toPNG());
      keys('keyUp', 'J');
      gkeys('keyUp', 'K', 'Enter');
      await farShows('p1: p2:', 'let go, both');
      // Sound goes with the picture (this cartridge is silent: the pieces are counted, not listened to).
      const sound = await gwait(`Number(document.querySelector('[data-arcade-remote]').dataset.shownA) > 5 && document.querySelector('[data-arcade-remote]').dataset.shownA`, 10000, 'pieces of sound');
      const pictures = await gjs(`Number(document.querySelector('[data-arcade-remote]').dataset.shownV)`);
      // They get up holding a button: the pad lets go, and the game is mine alone again.
      gkeys('keyDown', 'L');
      await shows('p1: p2:c', 'the second window holds C');
      guest.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
      guest.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      await shows('p1: p2:', 'they got up: nothing is held');
      await waitFor(`!/plays with you/.test(document.querySelector('[data-arcade-open-line]').textContent) && window.__t.store().arcade.tables[0].player2 === null`, 8000);
      await gwait(`!!document.querySelector('[data-arcade-shelf]') && !document.querySelector('[data-arcade-remote]')`, 8000, 'the second window back at the shelf');
      together = `; a second window found the game on the office's shelf, sat down at mine with the second pad, was shown ${pictures} pictures and ${sound} pieces of sound, and its keys were player 2's`;
    } finally {
      guest.destroy();
    }

    // Leaving keeps where I was: the shelf then offers to continue, with a picture of the moment. And the game is no longer one to join.
    await click(`document.querySelector('[data-arcade-back]')`, '← Games');
    await waitFor(`window.__t.store().arcade.tables.length === 0`, 8000);
    await waitFor(`!!${card}?.querySelector('[data-arcade-continue]') && ${card}.querySelector('img')?.naturalWidth > 0`, 15000);
    await shot('arcade-continue');
    await click(`${card}.querySelector('[data-arcade-continue]')`, 'Continue');
    await running();
    await shows('p1: p2:', 'continued');
    // Escape leaves the game for the shelf; the window closes on the next one.
    await key('Escape');
    await waitFor(`!!document.querySelector('[data-arcade-shelf]') && !document.querySelector('[data-arcade-play-view]')`, 15000);
    // The game taken off the shelf is gone from this computer.
    await click(`${card}.querySelector('[data-arcade-remove]')`, 'Remove');
    await click(`${card}.querySelector('[data-arcade-remove-sure]')`, 'Remove for everyone');
    await waitFor(`window.__t.store().arcade.games.length === 0`, 8000);
    await waitFor(`!${card} && /No games yet/.test(document.querySelector('[data-arcade-shelf]').textContent)`, 8000);
    await key('Escape');
    await waitFor(`!document.querySelector('[data-arcade]')`, 5000);
    return 'my cartridge ran in a frame that is no origin, its sound output open; nothing to choose — the keys are W A S D, J K L, U I O and Enter, and a gamepad is the same pad; the owner did not move in the office; Continue was offered with a picture, and Escape left the game and then the window' + together;
  });

  await step('sitting and jumping: the interact key sits down where there is a seat, a step gets up, and with nothing to act on it is a jump — and the others in the office see both', async () => {
    await js(`window.__t.store().openPanel(null)`);
    await camera('CEO');
    const me = () => js(`({ x: window.__orchPlayer.x, z: window.__orchPlayer.z, rot: window.__orchPlayer.rot, sit: window.__orchPlayer.sit, y: window.__orchPlayer.y || 0, near: window.__t.store().nearby, panel: window.__t.store().panel })`);
    const seat = await js(`window.__orchPlayer.seats.find((x) => x.id === 'break-sofa:0')`);
    if (!seat) throw new Error('the break room sofa has no seat');
    // Somebody else in the office, to see what the others see.
    const other = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { backgroundThrottling: false } });
    const ojs = (code) => other.webContents.executeJavaScript(code, true);
    const owait = async (code, timeout = 15000, what = code) => {
      for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) {
        const v = await ojs(`(() => { try { return (${code}); } catch (e) { return null; } })()`).catch(() => null);
        if (v) return v;
      }
      throw new Error(`the other window: timed out waiting for ${String(what).slice(0, 140)}`);
    };
    // The one other person the second window sees: me.
    const seen = `Object.values((window.__orchScene || {}).humans || {}).sort((a, b) => b.t - a.t)[0]`;
    try {
      other.webContents.setAudioMuted(true);
      await other.loadURL(win.webContents.getURL());
      other.webContents.setZoomFactor(1);
      await owait(`window.__office && window.__office.getState().ready`, 30000, 'the office');

      // In front of the sofa the key means the sofa.
      await js(`window.__orchPlayer.goto = { x: ${seat.x + 0.2}, z: ${seat.z - 0.9}, rot: 0 }; true`);
      await waitFor(`window.__t.store().nearby && window.__t.store().nearby.kind === 'seat'`, 8000);
      const asked = await js(`document.querySelector('.prompt').textContent`);
      if (!/SOFA — SIT DOWN/.test(asked)) throw new Error(`in front of the sofa the prompt reads "${asked}"`);
      await key('Space');
      await waitFor(`window.__orchPlayer.sit === 'break-sofa:0' && /STAND UP/.test(document.querySelector('.prompt').textContent)`, 8000);
      const sat = await me();
      if (Math.hypot(sat.x - seat.x, sat.z - seat.z) > 0.02 || Math.abs(Math.cos(sat.rot) - Math.cos(seat.rot)) > 0.05) throw new Error(`seated at ${JSON.stringify(sat)}, the seat is ${JSON.stringify(seat)}`);
      await owait(`(() => { const h = ${seen}; return h && h.sit && Math.hypot(h.x - ${seat.x}, h.z - ${seat.z}) < 0.1; })()`, 15000, 'me, sitting on the sofa');
      await sleep(400);
      await shot('sitting');
      fs.writeFileSync(path.join(outDir, 'sitting-seen-by-another.png'), (await other.webContents.capturePage()).toPNG());
      // A step gets me up, onto floor I can walk on.
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W' });
      await waitFor(`window.__orchPlayer.sit === null`, 5000);
      await sleep(250);
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W' });
      const up = await me();
      if (Math.hypot(up.x - seat.x, up.z - seat.z) > 2.5) throw new Error(`got up ${Math.hypot(up.x - seat.x, up.z - seat.z).toFixed(1)} m from the sofa`);
      await owait(`(() => { const h = ${seen}; return h && !h.sit; })()`, 15000, 'me, on my feet again');

      // On open floor, with nothing to act on, the same key is a jump: up and down again, and seen from the other window.
      await js(`window.__orchPlayer.goto = { x: 2, z: 6, rot: 0 }; true`);
      await waitFor(`window.__t.store().nearby === null && Math.abs(window.__orchPlayer.x - 2) < 0.05`, 8000);
      await owait(`(() => { const h = ${seen}; return h && Math.hypot(h.x - 2, h.z - 6) < 0.3; })()`, 15000, 'me on the open floor');
      const theirs = ojs(`new Promise((done) => { let top = 0; const from = performance.now(); const look = () => { const h = ${seen}; if (h) top = Math.max(top, h.y || 0); if (performance.now() - from < 1800) setTimeout(look, 25); else done(top); }; look(); })`);
      // (Every drawn frame of it: how high the body is lifted, and where its hips and its left ankle really are.)
      const mine = js(`new Promise((done) => { const p = window.__orchPlayer; const stand = { hip: p.hipY, ankle: p.ankleY }; let top = 0; let end = null; let began = null; let over = null; const seen = []; const from = performance.now(); const look = () => { const now = performance.now() - from; const y = p.y || 0; top = Math.max(top, y); if (p.air >= 0 && began === null) began = now; if (began !== null && p.air < 0 && over === null) over = now; if (top > 0.3 && y === 0 && end === null) end = now; seen.push({ t: now, y, air: p.air, hip: p.hipY, ankle: p.ankleY }); if (now < 1800) requestAnimationFrame(look); else done({ top, end, began, over, stand, last: { hip: p.hipY, ankle: p.ankleY }, seen }); }; look(); })`);
      await sleep(150);
      await key('Space');
      const [jumped, seenTop] = [await mine, await theirs];
      const { seen: frames, stand, ...told } = jumped;
      if (!(jumped.top > 0.5 && jumped.top < 0.7) || jumped.end === null || jumped.began === null || jumped.over === null) throw new Error(`the jump: ${JSON.stringify(told)}`);
      // It is a body that jumps, not a figure that is lifted: it sinks before its feet leave the floor, draws its
      // feet up under it in the air, gives at the knees as it lands, and stands again as it stood.
      const during = frames.filter((f) => f.air >= 0);
      const onFloorBefore = during.filter((f) => f.y === 0 && f.air < 0.4);
      const inAir = during.filter((f) => f.y > 0.3);
      const landed = during.filter((f) => f.y === 0 && f.air > 0.4);
      const low = (fs) => Math.min(...fs.map((f) => f.hip - f.y)) - stand.hip;
      const crouch = low(onFloorBefore);
      const feetDown = Math.max(...onFloorBefore.filter((f) => f.air < 0.09).map((f) => Math.abs(f.ankle - stand.ankle)));
      const tuck = Math.max(...inAir.map((f) => f.ankle - f.y)) - stand.ankle;
      const give = low(landed);
      // (Standing, the hips ride a centimetre or two up and down as the weight shifts from leg to leg.)
      const back = Math.abs(jumped.last.hip - stand.hip);
      const span = jumped.over - jumped.began;
      const shape = `sank ${(-crouch * 100).toFixed(0)} cm before leaving the floor (feet within ${(feetDown * 100).toFixed(1)} cm of it), feet drawn up ${(tuck * 100).toFixed(0)} cm in the air, knees gave ${(-give * 100).toFixed(0)} cm on landing, ${Math.round(span)} ms in all`;
      // (The feet stay down through the crouch — within what a standing body's ankles ride with its weight, a few centimetres; drawn up in the air they are several times that.)
      if (!(crouch < -0.05 && feetDown < 0.05 && tuck > 0.08 && give < -0.1 && back < 0.04 && span > 700 && span < 1300) || inAir.length < 5) throw new Error(`the jump is not a crouch, a push, a tuck and a landing: ${shape}; hips ${back.toFixed(3)} m from where they stood, ${inAir.length} frames in the air`);
      if (!(seenTop > 0.3)) throw new Error(`from the other window the jump was ${seenTop.toFixed(2)} m high`);
      const after = await me();
      if (after.panel || after.sit) throw new Error(`after a jump: ${JSON.stringify(after)}`);

      // Where there is something to act on, the key still means that thing: no jump in front of the project board.
      const board = await js(`window.__orchPlayer.spots.find((x) => x.kind === 'board')`);
      const jumps = await js(`window.__t.store().jumpAsk`);
      await js(`window.__orchPlayer.goto = { x: ${board.x}, z: ${board.z}, rot: 0 }; true`);
      // (Since 8de6975 somebody who stands at the board is met there, so what is in front may be that employee and
      // not the board — the suite's planner stands there. The key is pressed only when it is the board: what the
      // key does with an employee met away from their desk has its own steps, and is not undone from here.)
      const front = await waitFor(`(() => { const n = window.__t.store().nearby; return n && (n.kind === 'board' || n.kind === 'employee') ? n.kind : null; })()`, 8000);
      if (front === 'board') {
        await key('Space');
        await waitFor(`window.__t.store().panel === 'tasks'`, 8000);
        if ((await js(`window.__t.store().jumpAsk`)) !== jumps) throw new Error('the key jumped although the project board was in front');
        await js(`window.__t.store().openPanel(null)`);
      }
      return `sat on the break room sofa (the prompt: "${asked.trim()}", then "STAND UP"), got up with a step; jumped ${jumped.top.toFixed(2)} m — ${shape}; another window saw me sit, get up and jump (${seenTop.toFixed(2)} m)`;
    } finally {
      other.destroy();
    }
  });

  await step('a routine: "Repeat every … minutes" turns what I type into a standing instruction, listed above the conversation', async () => {
    const ava = await js(`window.__t.emp('Ava').id`);
    await js(`window.__t.store().openPanel('talk', ${JSON.stringify(ava)})`);
    await type(`window.__t.scope().querySelector('textarea')`, 'Check the queue and say what is new @@fake: say routine-check-7781@@');
    await click(`window.__t.scope().querySelector('.talk-compose [data-talk-tool="repeat"]')`, 'the Repeat tool of the message box');
    // The choice stands over the words as a pill, with its minutes.
    await waitFor(`!!window.__t.scope().querySelector('[data-talk-mode="repeat"] input.routine-minutes')`, 3000);
    await shot('talk-repeat-on');
    // The cost is said where the choice is made, and the button says what it will do.
    await waitFor(`/Each run is a real Claude turn on Ava's account/.test(window.__t.scope().textContent) && !!window.__t.byText('Repeat')`, 4000);
    await clickText('Repeat');
    // Listed above the conversation, with its rhythm; its first run is delivered and answered like a message.
    await waitFor(`(() => { const r = window.__t.scope().querySelector('.routine-row'); return !!r && /Check the queue and say what is new/.test(r.textContent) && r.querySelector('.routine-every input').value === '5'; })()`, 8000);
    await waitFor(`[...window.__t.scope().querySelectorAll('.talk-me')].some((b) => /Routine \\(every 5 min\\): Check the queue/.test(b.textContent))`, 8000);
    await waitFor(`[...window.__t.scope().querySelectorAll('.talk-them')].some((b) => /routine-check-7781/.test(b.textContent))`, 25000);
    await waitFor(`Object.values(window.__t.store().routines).some((r) => r.employeeId === ${JSON.stringify(ava)} && r.runs === 1 && r.lastOutcome === 'delivered')`, 5000);
    // The box is back to saying things once.
    const reset = await js(`window.__t.scope().querySelector('[data-talk-tool="repeat"]').getAttribute('aria-pressed') === 'false' && !window.__t.scope().querySelector('[data-talk-mode]') && [...window.__t.scope().querySelectorAll('.talk-compose button')].some((b) => b.textContent.trim() === 'Send') && window.__t.scope().querySelector('textarea').value === ''`);
    await shot('routine');
    // Pause it, then remove it: both from its row.
    await click(`window.__t.byText('Pause', 'button', window.__t.scope().querySelector('.routine-row'))`, 'Pause');
    await waitFor(`!!window.__t.scope().querySelector('.routine-row.routine-off') && /Paused/.test(window.__t.scope().querySelector('.routine-row').textContent)`, 5000);
    // Removing asks first.
    await js(`window.__asked = []; window.__orchConfirm = (m) => { window.__asked.push(String(m)); return true; }; true`);
    await click(`window.__t.byText('Remove', 'button', window.__t.scope().querySelector('.routine-row'))`, 'Remove');
    await waitFor(`!window.__t.scope().querySelector('.routine-row') && Object.keys(window.__t.store().routines).length === 0`, 5000);
    if (!(await js(`window.__asked.length === 1`))) throw new Error('a routine was removed without asking');
    await js(`delete window.__orchConfirm; true`);
    await js(`window.__t.store().openPanel(null)`);
    if (!reset) throw new Error('after creating the routine the message box did not go back to "Send"');
    return 'created with its first run answered → paused → removed';
  });

  await step('workstation: take control, type into the real terminal, return control', async () => {
    await js(`window.__t.store().enterWorkstation(window.__t.emp('Rev').id)`);
    await waitFor(`document.querySelector('.ws .xterm') && document.querySelector('.ws .xterm-rows') && document.querySelector('.ws .xterm-rows').textContent.length > 20`, 15000);
    await clickText('Take the keyboard');
    await waitFor(`/You are typing/.test(document.querySelector('.ws-state').textContent)`, 8000);
    await click(`document.querySelector('.ws .xterm')`, 'the terminal');
    await win.webContents.insertText(ctx.typedPrompt);
    await sleep(300);
    await key('Enter');
    await waitFor(`/${ctx.typedReply}/.test(document.querySelector('.ws .xterm-rows').textContent)`, 20000);
    await shot('workstation-control');
    await clickText('Give it back');
    await waitFor(`!/You are typing/.test(document.querySelector('.ws-state').textContent)`, 8000);
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

  // ───────────── Machines (docs/UI.md: one line per machine, the rest on a click) ─────────────
  /** A machine's block in the Machines window, by the name on its line. */
  const machine = (name) => `[...window.__t.scope().querySelectorAll('[data-machine]')].find((e) => e.querySelector('.k-title').textContent === ${JSON.stringify(name)})`;
  /** Its line is clicked open, unless it is open already (the only machine of an office starts open). */
  const unfold = async (name) => {
    const line = `(${machine(name)}).querySelector('[role=button]')`;
    await waitFor(`!!(${machine(name)})`, 8000);
    if (await js(`${line}.getAttribute('aria-expanded') === 'false'`)) await click(line, `the line of ${name}`);
    await waitFor(`${line}.getAttribute('aria-expanded') === 'true' && !!(${machine(name)}).querySelector('.k-detail')`, 4000);
  };

  await step('Machines: one line per machine says what it is and how it is; the rest opens on a click, and adding one is the one main button', async () => {
    await open('hosts');
    await waitFor(`!!(${machine('dev-mac')}) && !!(${machine(ctx.spareHost)})`, 8000);
    const seen = await js(`(() => {
      const w = window.__t.scope();
      const line = (name) => { const m = [...w.querySelectorAll('[data-machine]')].find((e) => e.querySelector('.k-title').textContent === name); return { text: m.querySelector('[role=button]').textContent, meters: [...m.querySelectorAll('[role=meter]')].map((x) => x.getAttribute('aria-label') + ' ' + x.getAttribute('aria-valuetext')), faces: m.querySelectorAll('.k-faces .avatar').length, open: m.querySelector('[role=button]').getAttribute('aria-expanded'), detail: !!m.querySelector('.k-detail') }; };
      return { kit: w.classList.contains('win-kit'), subtitle: w.querySelector('.win-head p').textContent, primary: [...w.querySelectorAll('.btn-primary')].filter((b) => window.__t.visible(b)).map((b) => b.textContent.trim()), dev: line('dev-mac'), spare: line(${JSON.stringify(ctx.spareHost)}), text: w.textContent };
    })()`);
    if (!seen.kit) throw new Error('the Machines window does not wear the calm look');
    if (!/^\d+ of \d+ online$/.test(seen.subtitle)) throw new Error(`with a machine offline the window says "${seen.subtitle}"`);
    if (seen.primary.join('|') !== 'Add a machine') throw new Error(`the window's main buttons are: ${seen.primary.join(', ') || 'none'}`);
    // The machine that is there: who works on it and its two measurements, on the one line; nothing unfolded.
    if (seen.dev.open !== 'false' || seen.dev.detail) throw new Error('with several machines, one starts unfolded');
    if (!/\d+ employees?/.test(seen.dev.text)) throw new Error(`the line of dev-mac does not say how many work there: ${seen.dev.text}`);
    if (seen.dev.faces < 1) throw new Error('no faces on the line of a machine people work on');
    if (seen.dev.meters.length !== 2 || !/^CPU \d+%$/.test(seen.dev.meters[0]) || !/^Memory [\d.]+ \/ [\d.]+ GB$/.test(seen.dev.meters[1])) throw new Error(`the measurements of dev-mac read: ${seen.dev.meters.join(' | ')}`);
    // The machine that is not: why not, and nothing measured.
    if (!/has never connected|offline, last seen/.test(seen.spare.text) || seen.spare.meters.length) throw new Error(`the line of the machine that is away reads: ${seen.spare.text} (${seen.spare.meters.length} measurements)`);
    // What used to be printed for every machine, always, is not there until asked for.
    for (const gone of ['Hostname', 'Worker runtimes', 'Load (1 min)', 'Tracked sessions', 'measured', 'Any other machine', 'Servers over SSH']) if (seen.text.includes(gone)) throw new Error(`"${gone}" is on the window before anything was opened`);
    // A click opens it: who works there by name, and what the machine is.
    await unfold('dev-mac');
    const opened = await js(`(() => { const m = ${machine('dev-mac')}; return { chips: [...m.querySelectorAll('.k-chip')].map((c) => c.textContent.trim()), facts: [...m.querySelectorAll('.k-spec dt')].map((d) => d.textContent) }; })()`);
    for (const who of ['Sarah', 'David']) if (!opened.chips.includes(who)) throw new Error(`${who} is not among those who work on dev-mac: ${opened.chips.join(', ')}`);
    for (const fact of ['System', 'Claude Code', 'tmux', 'Sessions']) if (!opened.facts.includes(fact)) throw new Error(`"${fact}" is missing from what dev-mac is: ${opened.facts.join(', ')}`);
    await shot('machines');
    // The window hangs from the top: opening and closing a machine does not move what is above it.
    const top = () => js(`Math.round(window.__t.scope().getBoundingClientRect().top)`);
    const openTop = await top();
    await click(`(${machine('dev-mac')}).querySelector('[role=button]')`, 'the line of dev-mac');
    await waitFor(`!(${machine('dev-mac')}).querySelector('.k-detail')`, 4000);
    if ((await top()) !== openTop) throw new Error(`the window moved when a machine was folded: ${openTop} → ${await top()}`);
    // A name on the list opens that employee.
    await unfold('dev-mac');
    await click(`[...(${machine('dev-mac')}).querySelectorAll('.k-chip')].find((c) => c.textContent.trim() === 'Sarah')`, 'Sarah');
    await waitFor(`window.__t.store().panel === 'employee' && String(window.__t.store().panelArg).startsWith(window.__t.emp('Sarah').id)`, 6000);
    await close();
    return `${seen.subtitle}; dev-mac: ${seen.dev.meters.join(', ')}; opened: ${opened.facts.length} facts, ${opened.chips.length} people`;
  });

  await step('My work (a member\'s own window): two columns — people with one word about each, open tasks by project — what waits only when something does, a lead hired in place, and one main button', async () => {
    await close();
    // The member at their own window: a second window on the same office, signed in as them.
    // (With a store of its own, in memory: the page keeps who is signed in for its address, and the owner's window must stay the owner's.)
    const other = new BrowserWindow({ width: 1300, height: 900, show: false, webPreferences: { backgroundThrottling: false, partition: 'my-work-member' } });
    const ojs = (code) => other.webContents.executeJavaScript(code, true);
    const owait = async (code, timeout = 15000, what = code) => {
      for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) {
        const v = await ojs(`(() => { try { return (${code}); } catch (e) { return null; } })()`).catch(() => null);
        if (v) return v;
      }
      throw new Error(`the member's window: timed out waiting for ${String(what).slice(0, 160)}`);
    };
    /** A real click in the member's window. */
    const oclick = async (finder, what = finder) => {
      await owait(`!!(${finder})`, 15000, what);
      const p = await ojs(`window.__t.point(${finder})`);
      if (!p.hit) throw new Error(`${what} is covered by ${p.top} in the member's window`);
      other.webContents.sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y });
      other.webContents.sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      other.webContents.sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
      await sleep(120);
    };
    const W = `window.__t.scope()`;
    const mine = `Object.values(window.__t.store().employees).filter((e) => !e.archived && e.roleKey !== 'lead' && (window.__t.store().hosts[e.hostId] || {}).memberId === window.__t.store().me.id)`;
    try {
      other.webContents.setAudioMuted(true);
      await other.loadURL(ctx.memberUrl);
      other.webContents.setZoomFactor(1);
      await owait(`!!window.__office && !!window.__office.getState().me && window.__office.getState().me.name === ${JSON.stringify(ctx.memberName)} && Object.keys(window.__office.getState().employees).length > 2`, 30000, 'the office, as the member');
      await ojs(HELPERS);
      await owait(`(${mine}).length === 3`, 15000, 'the member\'s three employees');
      await ojs(`window.__t.store().openPanel('mine')`);
      await owait(`!!document.querySelector('.win [data-mine]')`, 8000, 'My work');
      const seen = await ojs(`(() => {
        const w = ${W};
        const rows = [...w.querySelectorAll('[data-mine-employee]')].map((r) => ({ name: r.querySelector('.k-title').firstChild.textContent, about: r.querySelector('.k-line').textContent, states: [...r.querySelectorAll('.k-state')].map((x) => x.textContent), buttons: [...r.querySelectorAll('button')].map((b) => b.textContent.trim()), badges: r.querySelectorAll('.badge').length, open: r.querySelector('[role=button]').getAttribute('aria-expanded') }));
        const cols = [w.querySelector('[data-mine-people]'), w.querySelector('[data-mine-tasks]')].map((c) => { const b = c.getBoundingClientRect(); return { left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width) }; });
        const projects = [...w.querySelectorAll('[data-mine-project]')].map((g) => ({ head: g.querySelector('.k-row-head').textContent, tasks: g.querySelectorAll('[data-mine-task]').length }));
        return { kit: w.classList.contains('win-kit'), title: w.querySelector('.win-head h2').textContent, subtitle: w.querySelector('.win-head p').textContent, primary: [...w.querySelectorAll('.btn-primary')].filter((b) => window.__t.visible(b)).map((b) => b.textContent.trim()), rows, waiting: !!w.querySelector('[data-mine-waiting]'), asks: Object.values(window.__t.store().questions).filter((q) => q.status === 'open' && (${mine}).some((e) => e.id === q.employeeId)).length, lead: !!w.querySelector('[data-lead]'), cols, projects, tall: Math.round(w.getBoundingClientRect().height), labels: [...w.querySelectorAll('.k-label')].map((l) => l.textContent), text: w.textContent };
      })()`);
      if (!seen.kit || seen.title !== 'My work') throw new Error(`the window is "${seen.title}"${seen.kit ? '' : ', not in the calm look'}`);
      if (!/^3 employees, \d working/.test(seen.subtitle)) throw new Error(`the window's one line reads "${seen.subtitle}"`);
      if (seen.subtitle.includes(ctx.memberName)) throw new Error(`the window tells the member their own name: "${seen.subtitle}"`);
      if (seen.primary.join('|') !== 'Hire') throw new Error(`the window's main buttons are: ${seen.primary.join(', ') || 'none'}`);
      // Each of mine: a name, a phrase, one word about how they are — no badge — and the three things done with them.
      if (seen.rows.length !== 3) throw new Error(`${seen.rows.length} employees are listed for a member with three`);
      // The one with no session is asleep, which is no fault: a word, and no colour.
      if (!seen.rows.some((r) => r.states[0] === 'sleeping')) throw new Error(`nobody of the three is said to be sleeping: ${seen.rows.map((r) => r.states[0]).join(', ')}`);
      for (const r of seen.rows) {
        if (r.states.length !== 1 || !/^[a-z ]+$/.test(r.states[0])) throw new Error(`${r.name} is said to be: ${JSON.stringify(r.states)}`);
        if (r.badges) throw new Error(`${r.name} wears ${r.badges} badge(s)`);
        // On the line there is one thing to press; the rest is behind a click on the line.
        if (r.buttons.join('|') !== 'Talk' || r.open !== 'false') throw new Error(`on the line of ${r.name}: ${r.buttons.join(', ')}${r.open !== 'false' ? ' (and it starts open)' : ''}`);
        // (One machine: it is not repeated on every line.)
        if (/computer/i.test(r.about)) throw new Error(`the line of ${r.name} names the member's only machine: ${r.about}`);
      }
      // Nothing waits: nothing is said about waiting.
      if (seen.asks === 0 && (seen.waiting || /waiting/i.test(seen.text))) throw new Error('with nothing waiting, the window still speaks of waiting');
      // Two columns side by side, people and tasks: the window is wide, not long.
      if (seen.labels.join('|') !== 'People|Open tasks') throw new Error(`the window's parts are: ${seen.labels.join(', ')}`);
      if (!(seen.cols[1].left > seen.cols[0].left + seen.cols[0].width - 4 && Math.abs(seen.cols[0].top - seen.cols[1].top) < 4)) throw new Error(`people and tasks do not stand side by side: ${JSON.stringify(seen.cols)}`);
      if (seen.tall > 620) throw new Error(`with three people and two tasks the window is ${seen.tall} px tall`);
      // The open tasks stand under their project; a task somebody is on shows their face and no word.
      if (seen.projects.length !== 1 || !seen.projects[0].head.startsWith(`${ctx.memberName}'s notes`) || seen.projects[0].tasks !== 2) throw new Error(`the tasks are grouped as: ${JSON.stringify(seen.projects)}`);
      const taskRow = await ojs(`(() => { const r = ${W}.querySelector('[data-mine-task]'); return { faces: r.querySelectorAll('.avatar').length, words: [...r.querySelectorAll('.k-state')].map((x) => x.textContent) }; })()`);
      if (taskRow.faces !== 1 || taskRow.words.length) throw new Error(`a task in progress shows ${taskRow.faces} face(s) and says: ${taskRow.words.join(', ') || 'nothing'}`);
      // A click on a line opens what they are and what else can be done; opening another closes it.
      const line = (i) => `[...${W}.querySelectorAll('[data-mine-employee]')][${i}].querySelector('[role=button]')`;
      await oclick(`${line(0)}.querySelector('.k-title')`, 'the first line');
      const openedOne = await owait(`(() => { const d = [...${W}.querySelectorAll('[data-mine-employee]')][0].querySelector('.k-detail'); return d ? [...d.querySelectorAll('button')].map((b) => b.textContent.trim()).join('|') : null; })()`, 5000, 'the first line, opened');
      if (openedOne !== 'Talk|Terminal|Profile') throw new Error(`an opened line offers: ${openedOne}`);
      await oclick(`${line(1)}.querySelector('.k-title')`, 'the second line');
      await owait(`${W}.querySelectorAll('[data-mine-employee] .k-detail').length === 1 && !![...${W}.querySelectorAll('[data-mine-employee]')][1].querySelector('.k-detail')`, 5000, 'only the second line open');
      await oclick(`${line(1)}.querySelector('.k-title')`, 'the second line again');
      await owait(`${W}.querySelectorAll('[data-mine-employee] .k-detail').length === 0`, 5000, 'every line closed');
      // No lead yet: one quiet line beside the heading, and the long explanation only once asked for.
      if (seen.lead || /lightest model/.test(seen.text)) throw new Error('a member without a lead is told all about leads before asking');
      await oclick(`window.__t.byText('Hire a team lead')`, 'Hire a team lead');
      await owait(`/lightest model/.test(${W}.textContent) && !!${W}.querySelector('input[aria-label="Name of your team lead"]')`, 5000, 'what a lead is, and a name for one');
      await oclick(`window.__t.byText('Cancel')`, 'Cancel');
      await owait(`!${W}.querySelector('input[aria-label="Name of your team lead"]') && !/lightest model/.test(${W}.textContent)`, 5000, 'the line as it was');
      await oclick(`window.__t.byText('Hire a team lead')`, 'Hire a team lead');
      await oclick(`${W}.querySelector('[data-lead-form] button[type=submit]')`, 'Hire onto my computer');
      // The new lead is there to be told something: their conversation opens.
      await owait(`window.__t.store().panel === 'talk' && (window.__t.store().employees[window.__t.store().panelArg] || {}).roleKey === 'lead'`, 20000, 'the conversation with the new lead');
      const lead = await ojs(`(() => { const e = window.__t.store().employees[window.__t.store().panelArg]; return { id: e.id, name: e.name }; })()`);
      if (lead.name !== `${ctx.memberName} Lead`) throw new Error(`a lead hired without a name is called "${lead.name}"`);
      await ojs(`window.__t.store().openPanel('mine')`);
      await owait(`(${W}.querySelector('[data-lead]') || { getAttribute: () => '' }).getAttribute('data-lead') === ${JSON.stringify(lead.id)}`, 8000, 'the lead on its own line');
      // The lead stands first, is called that, and is not counted among the people it directs; what it may direct is set behind its line.
      const after = await ojs(`({ rows: ${W}.querySelectorAll('[data-mine-employee]').length, subtitle: ${W}.querySelector('.win-head p').textContent, line: ${W}.querySelector('[data-lead] .k-line').textContent, first: ${W}.querySelector('[data-mine-people] .k-group').firstElementChild.hasAttribute('data-lead'), note: ${W}.querySelector('[data-lead] .k-title-note').textContent, offer: !!window.__t.byText('Hire a team lead') })`);
      if (!after.first || after.note !== 'team lead' || after.offer) throw new Error(`the lead's place: first ${after.first}, called "${after.note}"${after.offer ? ', and another is still offered' : ''}`);
      await oclick(`${W}.querySelector('[data-lead] [role=button] .k-title')`, 'the lead\'s line');
      if (after.rows !== 3 || !/^3 employees/.test(after.subtitle)) throw new Error(`with a lead hired the window counts ${after.rows} employees ("${after.subtitle}")`);
      if (!/hired 0 of \d/.test(after.line)) throw new Error(`the lead's line reads "${after.line}"`);
      await oclick(`${W}.querySelector('[data-lead] input[type=checkbox]')`, 'Also direct the office\'s shared employees');
      await owait(`window.__t.store().employees[${JSON.stringify(lead.id)}].leadScope === 'office'`, 8000, 'the lead directing the shared employees too');
      await oclick(`${W}.querySelector('[data-lead] input[type=checkbox]')`, 'the same box again');
      await owait(`window.__t.store().employees[${JSON.stringify(lead.id)}].leadScope !== 'office'`, 8000, 'the lead directing my own only');
      fs.writeFileSync(path.join(outDir, 'my-work.png'), (await other.webContents.capturePage()).toPNG());
      // One of mine asks something: now it is said, above everything, and a click answers it.
      // (The one who was asleep: the other two are in the middle of a long task and would not hear it for a while.)
      const asker = await ojs(`(${mine}).find((e) => !Object.values(window.__t.store().sessions).some((x) => x.employeeId === e.id && (x.status === 'running' || x.status === 'starting'))) || null`);
      if (!asker) throw new Error('none of the member\'s employees is free to ask something');
      await ojs(`(async () => (await fetch('/api/employees/${asker.id}/start', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ((window.orchestrator && window.orchestrator.token) || localStorage.getItem('orch.token') || '') }, body: '{}' })).status)()`);
      await owait(`Object.values(window.__t.store().sessions).some((x) => x.employeeId === ${JSON.stringify(asker.id)} && x.status === 'running' && x.inTurn === false)`, 30000, `${asker.name} awake and at their prompt`);
      await ojs(`(async () => (await fetch('/api/employees/${asker.id}/message', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ((window.orchestrator && window.orchestrator.token) || localStorage.getItem('orch.token') || '') }, body: JSON.stringify({ body: 'One thing first. @@fake: ask Which of the two do you want?@@' }) })).status)()`);
      await owait(`!!${W}.querySelector('[data-mine-waiting]') && /asks you something/.test(${W}.querySelector('[data-mine-waiting]').textContent)`, 40000, `${asker.name}'s question in "Waiting for you"`);
      const waitingNow = await ojs(`({ above: ${W}.querySelector('[data-mine-waiting]').getBoundingClientRect().bottom <= ${W}.querySelector('[data-mine-people]').getBoundingClientRect().top, subtitle: ${W}.querySelector('.win-head p').textContent, state: [...${W}.querySelectorAll('[data-mine-employee]')].find((r) => r.getAttribute('data-mine-employee') === ${JSON.stringify(asker.id)}).querySelector('.k-state').className, firstOfMine: ${W}.querySelector('[data-mine-employee]').getAttribute('data-mine-employee') })`);
      if (!waitingNow.above || !/1 waiting for you$/.test(waitingNow.subtitle)) throw new Error(`with a question open: above the columns ${waitingNow.above}, and the window says "${waitingNow.subtitle}"`);
      // Whoever wants somebody is marked, and stands first among the people.
      if (!/k-state-warn/.test(waitingNow.state) || waitingNow.firstOfMine !== asker.id) throw new Error(`the one who asks: ${waitingNow.state}, first of the people: ${waitingNow.firstOfMine === asker.id}`);
      await oclick(`${W}.querySelector('[data-mine-waiting] button')`, 'the question');
      await owait(`window.__t.store().panel === 'question'`, 6000, 'the question, opened');
      const qid = await ojs(`window.__t.store().panelArg`);
      await ojs(`(async () => (await fetch('/api/questions/${qid}/answer', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ((window.orchestrator && window.orchestrator.token) || localStorage.getItem('orch.token') || '') }, body: JSON.stringify({ answer: 'Option A' }) })).status)()`);
      await ojs(`window.__t.store().openPanel('mine')`);
      await owait(`!!document.querySelector('.win [data-mine]') && !${W}.querySelector('[data-mine-waiting]')`, 15000, 'nothing waiting any more');
      // Talk on a line opens that conversation.
      await oclick(`[...${W}.querySelectorAll('[data-mine-employee]')][0].querySelector('button')`, 'Talk');
      await owait(`window.__t.store().panel === 'talk' && (${mine}).some((e) => e.id === window.__t.store().panelArg)`, 6000, 'the conversation with one of mine');
      // The lead was this step's own: it is let go again, so the office is as the other steps expect it.
      await ojs(`(async () => (await fetch('/api/employees/${lead.id}', { method: 'DELETE', headers: { authorization: 'Bearer ' + ((window.orchestrator && window.orchestrator.token) || localStorage.getItem('orch.token') || '') } })).status)()`);
      return `${seen.subtitle}; ${seen.rows.map((r) => `${r.name}: ${r.states[0]}`).join(', ')}; lead ${lead.name} hired, widened, narrowed; ${asker.name} asked and was answered`;
    } finally {
      other.destroy();
    }
    // The owner's window did not become the member's by it.
    if ((await js(`window.__t.store().me.kind`)) !== 'owner' || (await js(`localStorage.getItem('orch.token')`)) === new URL(ctx.memberUrl).searchParams.get('token')) throw new Error('after the member looked at their work, the owner\'s window is signed in as the member');
  });

  await step('Machines: creating an enrollment token shows a usable one-time token', async () => {
    await open('hosts');
    await clickText('Add a machine');
    // Two ways, each said in a line; the list stays where it was underneath.
    await waitFor(`window.__t.scope().querySelectorAll('[data-add-machine] .k-option').length === 2`, 4000);
    await clickText('Any machine, with a token');
    await clickText('Create a token');
    // The token as its own element shows it (neighbouring button labels are not part of it).
    const token = await waitFor(`([...document.querySelectorAll('.win *')].find((e) => e.children.length === 0 && /^orch_enroll_[A-Za-z0-9_-]+$/.test(e.textContent.trim())) || { textContent: '' }).textContent.trim()`, 8000);
    await waitFor(`/orchestrator-agent login --server \\S+ --token orch_enroll_/.test(document.querySelector('.win .k-code').textContent) && /orchestrator-agent connect/.test(document.querySelector('.win .k-code').textContent)`, 4000);
    // This office is reached at a loopback address: that it will not do for another machine is said, with the address in sight.
    await waitFor(`/only works for an agent on the same machine/.test(window.__t.scope().textContent) && !!window.__t.field('Office address')`, 4000);
    await shot('machines-token');
    await clickText('Cancel');
    await waitFor(`!window.__t.scope().querySelector('[data-add-machine]')`, 4000);
    await close();
    return token;
  });

  await step('Office: adding a desk pod grows the real layout', async () => {
    await open('office');
    const before = await js(`window.__t.store().layout.desks.length`);
    await clickText('Add a table of four desks');
    await waitFor(`window.__t.store().layout.desks.length === ${before} + 4`, 8000);
    await close();
    return `${before} → ${before + 4} desks`;
  });

  // ───────────── the office editor (floor plan) ─────────────
  const pick = (value) => js(`window.__t.setSelect(window.__t.scope().querySelector('select[aria-label="Selected item"]'), ${JSON.stringify(value)})`);
  const deskAt = (id) => js(`(() => { const d = window.__t.store().layout.desks.find((x) => x.id === ${JSON.stringify(id)}); return d ? { x: d.x, z: d.z } : null; })()`);

  await step('Office: a desk pod is moved with the arrow buttons, and the people sitting there move with it', async () => {
    await open('office', `'plan'`);
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
    await open('office', `'plan'`);
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
    await open('office', `'plan'`);
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

  await step('Office: "Employee of the month" is a decoration like any other, and its frame shows whoever the office says has worked the most', async () => {
    // The office counts by itself: after a minute or two of the scripted employees working, somebody leads.
    const best = await waitFor(`(() => { const s = window.__t.store(); const b = s.company && s.company.employeeOfMonth; const e = b && s.employees[b.employeeId]; return e ? { id: e.id, name: e.name, role: e.roleKey, month: b.month } : null; })()`, 150000);
    if (best.role === 'foreman' || best.role === 'lead' || !/^\d{4}-\d{2}$/.test(best.month)) throw new Error(`the employee of the month is ${best.name} (${best.role}) for "${best.month}"`);
    await open('office', `'plan'`);
    await waitFor(`!!window.__t.scope().querySelector('select[aria-label="Decoration to add"]')`, 8000);
    const offered = await js(`[...window.__t.scope().querySelectorAll('select[aria-label="Decoration to add"] option')].filter((o) => o.value === 'employee_of_month').map((o) => [o.textContent, o.disabled])`);
    if (offered.length !== 1 || offered[0][0] !== 'Employee of the month' || offered[0][1]) throw new Error(`offered as: ${JSON.stringify(offered)}`);
    await js(`window.__t.setSelect(window.__t.scope().querySelector('select[aria-label="Decoration to add"]'), 'employee_of_month')`);
    await clickText('Add decoration');
    const added = await waitFor(`(() => { const d = window.__t.store().layout.decorations.find((x) => x.kind === 'employee_of_month'); return d ? { id: d.id, x: d.x, z: d.z } : null; })()`, 8000);
    await close();
    // It was put near where the owner stands, so it is drawn: the scene says whose picture is in the frame.
    const shown = await waitFor(`(() => { const a = window.__orchScene && window.__orchScene.award; return a ? a : null; })()`, 15000);
    const now = await js(`(() => { const s = window.__t.store(); const b = s.company.employeeOfMonth; return { id: b.employeeId, name: s.employees[b.employeeId].name }; })()`);
    if (shown.employeeId !== now.id || shown.name !== now.name || !/^[A-Z][a-z]+ \d{4}$/.test(shown.month)) throw new Error(`the frame shows ${JSON.stringify(shown)}; the office says ${JSON.stringify(now)}`);
    await sleep(600);
    await shot('employee-of-the-month');
    // Taken away again, so that the office is left as it was found.
    await open('office', `'plan'`);
    await waitFor(`!!window.__t.scope().querySelector('select[aria-label="Selected item"]')`, 8000);
    await pick(`decoration:${added.id}`);
    await clickText('Remove decoration');
    await waitFor(`!window.__t.store().layout.decorations.some((x) => x.kind === 'employee_of_month')`, 8000);
    await close();
    return `${shown.name}, ${shown.month} (${shown.hours} h); placed at ${added.x}, ${added.z} and removed`;
  });

  await step('Office: a room is renamed and the wall it shares with the next room is moved', async () => {
    await open('office', `'plan'`);
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
    await clickText('All lessons');
    await clickText('Add a lesson');
    await type(`window.__t.field('Lesson')`, ctx.lesson);
    await type(`window.__t.field('Applies when')`, 'before a commit');
    await shot('growth-teach');
    await click(`window.__t.submit('Add')`, 'Add (submit)');
    await waitFor(`Object.values(window.__t.store().lessons).some((l) => l.text === ${JSON.stringify(ctx.lesson)})`, 8000);
    // The form closes and the lesson is listed; searching for something else hides it, clearing the search brings it back.
    const listed = `window.__t.scope().textContent.includes(${JSON.stringify(ctx.lesson)})`;
    await waitFor(`${listed} && !window.__t.submit('Add')`, 8000);
    await type(`window.__t.scope().querySelector('input[aria-label="Search lessons"]')`, 'zzzz-nothing');
    await waitFor(`!(${listed}) && /No lesson matches/.test(window.__t.scope().textContent)`, 5000);
    await type(`window.__t.scope().querySelector('input[aria-label="Search lessons"]')`, 'commit');
    await waitFor(listed, 5000);
    await close();
  });

  await step('Growth is a library: shelves on the left with how many lessons stand on each, one shelf to read on the right; "How it learns" says what the office does with what it learns, and its three choices change it', async () => {
    await open('growth');
    // The shelves: what waits, the library (everything, the company's, each project's, each person's), and the office's own.
    const shelves = await js(`[...window.__t.scope().querySelectorAll('.lib-shelf')].map((b) => ({ name: b.querySelector('.lib-shelf-name').textContent, n: (b.querySelector('.lib-shelf-n') || { textContent: '' }).textContent, on: b.classList.contains('lib-shelf-on') }))`);
    const names = shelves.map((x) => x.name);
    for (const want of ['Waiting for you', 'All lessons', 'For everyone', 'Done by itself', 'Is it working?', 'How it learns']) if (!names.includes(want)) throw new Error(`the shelf "${want}" is missing: ${names.join(', ')}`);
    if (shelves.filter((x) => x.on).length !== 1) throw new Error(`${shelves.filter((x) => x.on).length} shelves are marked as the open one`);
    const inStore = await js(`Object.values(window.__t.store().lessons).length`);
    if (Number(shelves.find((x) => x.name === 'All lessons').n || 0) !== inStore) throw new Error(`"All lessons" says ${shelves.find((x) => x.name === 'All lessons').n || 0}, the office has ${inStore}`);
    if (!(await js(`window.__t.scope().classList.contains('win-kit') && window.__t.scope().querySelectorAll('.tab').length === 0`))) throw new Error('Growth is not in the calm look, or still has its row of tabs');
    await clickText('All lessons');
    await waitFor(`!!window.__t.scope().querySelector('[data-growth-shelf="all"]') && /All lessons/.test(window.__t.scope().querySelector('[data-growth-view] .k-title').textContent)`, 5000);
    await shot('growth-library');
    await clickText('How it learns');
    const dial = `window.__t.store().settings.selfImprovement.autopilot`;
    const line = `window.__t.scope().querySelector('.gr-dial .strong').textContent`;
    const was = await js(dial);
    if (was !== 'safe') throw new Error(`the dial starts at "${was}", not at "safe"`);
    await waitFor(`/applies by itself what cannot give employees more freedom/.test(${line})`, 5000);
    await clickText('Ask me first');
    await waitFor(`${dial} === 'off' && /asks you before it changes anything/.test(${line})`, 8000);
    // The shelf's own line says how it is set.
    await waitFor(`[...window.__t.scope().querySelectorAll('.lib-shelf')].some((b) => /How it learns/.test(b.textContent) && /ask me first/.test(b.textContent))`, 5000);
    // With the dial at "ask", the log of what it did by itself says so instead of promising entries.
    await clickText('Done by itself');
    await waitFor(`/set to ask you first/.test(window.__t.scope().textContent)`, 5000);
    await shot('growth-done-by-itself');
    await clickText('How it learns');
    await clickText('Apply more on a clean record');
    await waitFor(`${dial} === 'trusted' && /never for risky commands/.test(${line})`, 8000);
    await clickText('Apply what is safe');
    await waitFor(`${dial} === 'safe'`, 8000);
    await clickText('Is it working?');
    await waitFor(`/Who delivers what/.test(window.__t.scope().textContent)`, 5000);
    await shot('growth-results');
    // The same control is in Settings, and "More settings" leads there.
    await clickText('How it learns');
    await clickText('More settings');
    await waitFor(`/Growth/.test(window.__t.scope().textContent) && !!window.__t.byText('Ask me first')`, 8000);
    await shot('settings-growth');
    // The office's other settings: one section for the company, one for how employees run.
    await clickText('Employees');
    await waitFor(`!!window.__t.field('Put idle sessions to sleep after (minutes)') && /also get your MCP servers/.test(window.__t.scope().textContent)`, 5000);
    await shot('settings-employees');
    await clickText('Company');
    await waitFor(`/XP, levels and milestones/.test(window.__t.scope().textContent) && /interpret commands/.test(window.__t.scope().textContent)`, 5000);
    await shot('settings-company');
    await close();
    return 'safe → off → trusted → safe';
  });

  await step('Meetings: a meeting started from the form runs to a recorded decision', async () => {
    await open('meetings');
    await clickText('New meeting');
    await type(`window.__t.field('Topic')`, ctx.meetingTopic);
    // Participants are picked from a list that opens on "Add someone" and stand as tags on one line: no row per employee.
    const picker = `window.__t.scope().querySelector('[data-pick-many="participants"]')`;
    const before = await js(`Math.round(${picker}.getBoundingClientRect().height)`);
    for (const name of ['Ava', 'Rev']) {
      if (!(await js(`!!document.querySelector('[data-pick-list="participants"]')`))) await click(`${picker}.querySelector('[data-pick-add]')`, 'Add someone');
      await waitFor(`!!document.querySelector('[data-pick-list="participants"] [data-pick-option]')`, 3000);
      await click(`[...document.querySelectorAll('[data-pick-list="participants"] [data-pick-option]')].find((b) => b.querySelector('.k-pop-name').textContent === ${JSON.stringify(name)})`, `${name} in the list`);
      await waitFor(`[...${picker}.querySelectorAll('[data-picked]')].some((t) => t.textContent.includes(${JSON.stringify(name)}))`, 3000);
    }
    // Escape puts the list away and leaves the window (and what was typed) where it is.
    await key('Escape');
    await waitFor(`!document.querySelector('[data-pick-list]') && !!window.__t.field('Topic') && window.__t.field('Topic').value === ${JSON.stringify(ctx.meetingTopic)}`, 3000);
    const after = await js(`Math.round(${picker}.getBoundingClientRect().height)`);
    if (before > 40 || after > 40) throw new Error(`the participants take ${before} px with nobody picked and ${after} px with two: it is to be one line`);
    await shot('meeting-form');
    await click(`window.__t.submit('Start meeting')`, 'Start meeting');
    await waitFor(`Object.values(window.__t.store().meetings).some((m) => m.topic === ${JSON.stringify(ctx.meetingTopic)} && m.status === 'concluded')`, 60000);
    await waitFor(`/Adopt the HTTP boundary/.test(document.querySelector('.win').textContent)`, 8000);
    await shot('meeting-concluded');
    await close();
    return 'concluded; decision shown';
  });

  await step('Team and an employee\'s window: people as cards under their projects; a card opens the profile — who they are and how they are in its head, what they are doing first, the settings behind a tab with its save bar always there', async () => {
    await open('team');
    await waitFor(`window.__t.scope().querySelectorAll('[data-team-employee]').length > 5`, 8000);
    const team = await js(`(() => {
      const w = window.__t.scope();
      const cards = [...w.querySelectorAll('[data-team-employee]')];
      const groups = [...w.querySelectorAll('[data-team-group]')].map((g) => ({ name: g.querySelector('.tm-project').textContent, people: g.querySelectorAll('[data-team-employee]').length }));
      const one = cards[0];
      const lefts = new Set(cards.map((c) => Math.round(c.getBoundingClientRect().left)));
      return { kit: w.classList.contains('win-kit'), subtitle: w.querySelector('.win-head p').textContent, tables: w.querySelectorAll('table').length, badges: w.querySelectorAll('[data-team-group] .badge').length, groups, columns: lefts.size, buttons: [...one.querySelectorAll('button')].map((b) => b.textContent.trim()), states: one.querySelectorAll('.k-state').length, primary: [...w.querySelectorAll('.btn-primary')].filter((b) => window.__t.visible(b)).map((b) => b.textContent.trim()), wide: w.scrollWidth <= w.clientWidth + 1 };
    })()`);
    if (!team.kit || team.tables || team.badges) throw new Error(`Team: calm look ${team.kit}, ${team.tables} table(s), ${team.badges} badge(s) on the cards`);
    if (!/^\d+ employees · \d+ working/.test(team.subtitle)) throw new Error(`Team says "${team.subtitle}"`);
    if (team.primary.join('|') !== 'Hire') throw new Error(`Team's main buttons: ${team.primary.join(', ')}`);
    if (!team.groups.length || !team.groups.some((g) => /^Customer Platform/.test(g.name) && g.people >= 5)) throw new Error(`the people are grouped as ${JSON.stringify(team.groups)}`);
    if (team.columns < 2 || !team.wide) throw new Error(`the cards stand in ${team.columns} column(s)${team.wide ? '' : ', and the window scrolls sideways'}`);
    if (team.buttons.join('|') !== 'Talk' || team.states !== 1) throw new Error(`a card has ${team.buttons.join(', ')} and ${team.states} state(s)`);
    await shot('team');
    // A word finds somebody by what they can do.
    await type(`window.__t.scope().querySelector('input[aria-label="Search employees"]')`, 'Sarah');
    await waitFor(`window.__t.scope().querySelectorAll('[data-team-employee]').length === 1`, 5000);
    await click(`window.__t.scope().querySelector('[data-team-employee] .k-title')`, 'Sarah\'s card');
    await waitFor(`window.__t.store().panel === 'employee' && window.__t.store().panelArg === window.__t.emp('Sarah').id && !!window.__t.scope().querySelector('[data-profile-overview]')`, 6000);
    // (The window grows into place when it opens: it is measured once it has stopped — the same height twice running.)
    let was = -1;
    for (let i = 0; i < 20; i++) {
      const now = await js(`Math.round(window.__t.scope().getBoundingClientRect().height)`);
      if (now === was) break;
      was = now;
      await sleep(150);
    }
    const prof = await js(`(() => {
      const w = window.__t.scope();
      return { name: w.querySelector('.win-head h2').textContent, face: !!w.querySelector('.win-head .win-lead .avatar'), state: w.querySelector('.win-head [data-profile-state] .k-state').textContent, tabs: [...w.querySelectorAll('.tab')].map((t) => t.textContent), on: w.querySelector('.tab-on').textContent, labels: [...w.querySelectorAll('[data-profile-overview] .k-label')].map((l) => l.textContent), figures: w.querySelectorAll('.k-figure').length, inputs: [...w.querySelectorAll('[data-profile-overview] input, [data-profile-overview] select, [data-profile-overview] textarea')].length, primary: [...w.querySelectorAll('.win-head .btn-primary')].map((b) => b.textContent.trim()), height: Math.round(w.getBoundingClientRect().height) };
    })()`);
    if (prof.name !== 'Sarah' || !prof.face || !prof.state) throw new Error(`the head of the profile: "${prof.name}", face ${prof.face}, state "${prof.state}"`);
    if (prof.tabs.join('|') !== 'Overview|Settings|Look|Session|Routines|Telegram|Messages|History|Desk and hours' || prof.on !== 'Overview') throw new Error(`the profile's tabs: ${prof.tabs.join(', ')} (open: ${prof.on})`);
    if (prof.primary.length !== 1) throw new Error(`the profile's main buttons: ${prof.primary.join(', ') || 'none'}`);
    // The first thing is what they are doing and what they have delivered — to be read, not filled in.
    if (prof.labels.slice(0, 2).join('|') !== 'Right now|What they are' || !prof.labels.includes('Delivered') || prof.figures !== 6 || prof.inputs) throw new Error(`the overview: ${prof.labels.join(', ')}; ${prof.figures} figures; ${prof.inputs} field(s) to fill in`);
    await shot('profile');
    // "Change" leads to the settings; the window keeps its size, and the bar that saves is there before anything is changed.
    await click(`window.__t.byText('Change')`, 'Change');
    await waitFor(`window.__t.scope().querySelector('.tab-on').textContent === 'Settings' && window.__t.visible(window.__t.scope().querySelector('[data-profile-settings]'))`, 5000);
    const set = await js(`(() => { const w = window.__t.scope(); const bar = w.querySelector('[data-profile-save]').getBoundingClientRect(); const body = w.querySelector('.pf-body').getBoundingClientRect(); return { height: Math.round(w.getBoundingClientRect().height), barIn: bar.bottom <= body.bottom + 1 && bar.top >= body.top, save: w.querySelector('[data-profile-save] .btn-primary').disabled, note: w.querySelector('.pf-save-note').textContent, picks: [...w.querySelectorAll('[role=radiogroup][aria-label="Autonomy"] label')].map((l) => Math.round(l.getBoundingClientRect().height)), more: [...w.querySelectorAll('[role=radiogroup][aria-label="Autonomy"] .k-pick-more')].length }; })()`);
    // (To the pixel a measurement is rounded to: the body's height is a part of the screen's.)
    if (Math.abs(set.height - prof.height) > 1) throw new Error(`the window changes size between Overview and Settings: ${prof.height} → ${set.height}`);
    if (!set.barIn || !set.save || !/^Nothing is changed/.test(set.note)) throw new Error(`the save bar: in sight ${set.barIn}, Save disabled ${set.save}, says "${set.note.slice(0, 60)}"`);
    // Three levels — Standard, Auto, Unrestricted — a line each; only the chosen one says the rest.
    if (set.picks.length !== 3 || set.more !== 1 || set.picks.filter((h) => h > 70).length > 1) throw new Error(`the autonomy levels take ${set.picks.join(', ')} px, ${set.more} of them explained`);
    // A change is named in the bar, and Discard takes it back.
    await type(`window.__t.field('Title')`, 'Principal Frontend Engineer');
    await waitFor(`/^Unsaved: title/.test(window.__t.scope().querySelector('.pf-save-note').textContent) && !window.__t.scope().querySelector('[data-profile-save] .btn-primary').disabled`, 4000);
    await clickText('Discard');
    await waitFor(`/^Nothing is changed/.test(window.__t.scope().querySelector('.pf-save-note').textContent) && window.__t.field('Title').value === window.__t.emp('Sarah').title`, 4000);
    // "Also works on": the other projects are one line of tags with "Add a project", however many projects there are.
    const also = `window.__t.scope().querySelector('[data-pick-many="also-projects"]')`;
    await js(`${also}.scrollIntoView({ block: 'center' })`);
    const alsoBefore = await js(`({ h: Math.round(${also}.getBoundingClientRect().height), boxes: window.__t.scope().querySelectorAll('[data-profile-settings] .field input[type=checkbox]').length, text: ${also}.textContent })`);
    if (alsoBefore.h > 40 || alsoBefore.boxes || !/Only their own/.test(alsoBefore.text)) throw new Error(`"Also works on" takes ${alsoBefore.h} px, ${alsoBefore.boxes} checkbox(es), says "${alsoBefore.text}"`);
    await click(`${also}.querySelector('[data-pick-add]')`, 'Add a project');
    await waitFor(`document.querySelectorAll('[data-pick-list="also-projects"] [data-pick-option]').length > 0`, 3000);
    const listed = await js(`(() => { const p = document.querySelector('[data-pick-list="also-projects"]').getBoundingClientRect(); return { names: [...document.querySelectorAll('[data-pick-list="also-projects"] .k-pop-name')].map((n) => n.textContent), on: p.top >= 0 && p.bottom <= innerHeight && p.left >= 0 && p.right <= innerWidth, own: window.__t.store().projects[window.__t.emp('Sarah').projectId].name }; })()`);
    if (!listed.on || !listed.names.length || listed.names.includes(listed.own)) throw new Error(`the list of other projects: on the screen ${listed.on}; ${listed.names.join(', ')} (their own is ${listed.own})`);
    await click(`document.querySelector('[data-pick-list="also-projects"] [data-pick-option]')`, listed.names[0]);
    await waitFor(`[...${also}.querySelectorAll('[data-picked]')].some((t) => t.textContent.includes(${JSON.stringify(listed.names[0])})) && /^Unsaved: /.test(window.__t.scope().querySelector('.pf-save-note').textContent)`, 4000);
    await key('Escape');
    await waitFor(`!document.querySelector('[data-pick-list]') && !!window.__t.scope().querySelector('[data-profile-settings]')`, 3000);
    await shot('profile-also-works-on');
    // The ✕ of a tag takes it off again.
    await click(`${also}.querySelector('[data-picked] .k-tag-off')`, 'the ✕ of the tag');
    await waitFor(`!${also}.querySelector('[data-picked]') && /^Nothing is changed/.test(window.__t.scope().querySelector('.pf-save-note').textContent)`, 4000);
    await close();
    return `${team.subtitle}; ${team.groups.map((g) => g.name).join(', ')}; ${team.columns} columns; Sarah: ${prof.state}`;
  });

  await step('An employee\'s settings: who they are, then their folder — chosen as when hiring — then Claude (account, model, effort), then the rest; another folder becomes their own project', async () => {
    await open('employee', `window.__t.emp(${JSON.stringify(ctx.hireName)}).id + ':settings'`);
    await waitFor(`!!window.__t.scope().querySelector('[data-settings-folder]')`, 6000);
    const folder = `window.__t.scope().querySelector('[data-settings-folder] input.mono')`;
    const lay = await js(`(() => { const w = window.__t.scope(); return {
      order: [...w.querySelectorAll('[data-profile-settings] > div > .k-label')].map((l) => l.textContent),
      who: [...w.querySelectorAll('[data-settings-who] .field-label')].map((l) => l.textContent),
      home: [...w.querySelectorAll('[data-settings-folder] .pf-home .field-label')].map((l) => l.textContent),
      claude: [...w.querySelectorAll('[data-settings-claude] .field-label')].map((l) => l.textContent),
      folder: ${folder}.value, locked: ${folder}.disabled, browse: [...w.querySelectorAll('[data-settings-folder] button')].some((b) => /Browse/.test(b.textContent) && !b.disabled),
      shared: w.querySelector('select[aria-label="Shared project"]').selectedOptions[0].textContent,
    }; })()`);
    if (lay.order.slice(0, 4).join('|') !== 'Who they are|Their folder|Claude|How much they may do without asking') throw new Error(`the order of the settings: ${lay.order.join(', ')}`);
    if (lay.who.join('|') !== 'Name|Role|Title' || lay.home.join('|') !== 'On|Folder they live in|…or a shared project' || lay.claude.join('|') !== 'Account|Model|Effort') throw new Error(`the fields: ${lay.who.join(', ')} / ${lay.home.join(', ')} / ${lay.claude.join(', ')}`);
    // Hired into a folder: it is shown as their folder (not as a project of that name), and can be browsed for.
    if (lay.folder !== ctx.hireFolder || lay.locked || !lay.browse || !/^None/.test(lay.shared)) throw new Error(`their folder: "${lay.folder}" (locked ${lay.locked}, Browse ${lay.browse}), shared project "${lay.shared}"`);
    await shot('profile-settings-folder');
    // Another folder: it becomes their own project, worked in place — the way the hire form gives one.
    const other = ctx.hireFolder.replace(/[^/]+$/, 'made-in-the-form');
    const home = (dir) => `(() => { const s = window.__t.store(); const e = window.__t.emp(${JSON.stringify(ctx.hireName)}); const p = s.projects[e.projectId]; return e.workingDir === ${JSON.stringify(dir)} && !!p && p.repoPath === ${JSON.stringify(dir)} && p.workspace === 'in_place'; })()`;
    await type(folder, other);
    await waitFor(`/^Unsaved: folder/.test(window.__t.scope().querySelector('.pf-save-note').textContent)`, 4000);
    await clickText('Save changes');
    await waitFor(home(other), 10000);
    await waitFor(`${folder}.value === ${JSON.stringify(other)} && /^Nothing is changed/.test(window.__t.scope().querySelector('.pf-save-note').textContent)`, 6000);
    // A folder that is not there is refused, and nothing of theirs changes.
    await type(folder, other + '-missing');
    await clickText('Save changes');
    await sleep(1500);
    if (!(await js(home(other)))) throw new Error('a folder that does not exist was taken');
    // And back to where they were hired.
    await type(folder, ctx.hireFolder);
    await clickText('Save changes');
    await waitFor(home(ctx.hireFolder), 10000);
    await close();
    return `who → folder → Claude → the rest; ${ctx.hireName} moved to made-in-the-form and back`;
  });

  await step('An employee\'s window → Routines: what they repeat is listed there, and one is added, reworded, paused and removed', async () => {
    const mine = `Object.values(window.__t.store().routines).filter((r) => r.employeeId === window.__t.emp('Sarah').id)`;
    await open('employee', `window.__t.emp('Sarah').id + ':routines'`);
    await waitFor(`!!window.__t.scope().querySelector('[data-profile-routines]')`, 6000);
    const tab = `window.__t.scope().querySelector('[data-profile-routines]')`;
    const before = await js(`${mine}.length`);
    if (before === 0 && !(await js(`/Nothing repeats yet/.test(${tab}.textContent)`))) throw new Error('with no routine the tab does not say so');
    await click(`${tab}.querySelector('[data-add-routine-open]')`, 'Add a routine');
    await waitFor(`!!${tab}.querySelector('[data-add-routine] textarea')`, 4000);
    await type(`${tab}.querySelector('[data-add-routine] textarea')`, 'Look at the build and say whether it is green.');
    await type(`${tab}.querySelector('[data-add-routine] input[type=number]')`, '45');
    // (Not "once right now": no turn of hers is spent on the test.)
    await click(`${tab}.querySelector('[data-add-routine] input[type=checkbox]')`, 'and once right now');
    await click(`[...${tab}.querySelectorAll('[data-add-routine] button')].find((b) => /Add the routine/.test(b.textContent))`, 'Add the routine');
    const made = await waitFor(`(() => { const r = ${mine}.find((x) => /Look at the build/.test(x.instruction)); return r ? { id: r.id, every: r.everyMinutes, on: r.enabled, runs: r.runs } : null; })()`, 8000);
    if (made.every !== 45 || !made.on || made.runs !== 0) throw new Error(`the routine that was added: ${JSON.stringify(made)}`);
    const row = `${tab}.querySelector('[data-routine="${made.id}"]')`;
    await waitFor(`!!${row} && !${tab}.querySelector('[data-add-routine]') && /Routines\\s*${before + 1}/.test(window.__t.scope().querySelector('.tab-on').textContent)`, 6000);
    // One line: its words, how often, not run yet; the rest on a click.
    const line = await js(`${row}.querySelector('.k-sub').textContent`);
    if (!/^every 45 min · next .+ · not run yet$/.test(line)) throw new Error(`its line: ${line}`);
    await click(`${row}.querySelector('.k-row-click')`, 'the routine');
    await waitFor(`!!${row}.querySelector('.k-detail [data-routine-every]')`, 4000);
    // How often, with one click: every hour.
    await click(`[...${row}.querySelectorAll('[data-routine-every] .k-filters button')].find((b) => b.textContent.trim() === 'hour')`, 'hour');
    await waitFor(`window.__t.store().routines[${JSON.stringify(made.id)}].everyMinutes === 60 && /^every hour/.test(${row}.querySelector('.k-sub').textContent)`, 8000);
    await shot('profile-routines');
    // Its words are changed in place.
    await click(`[...${row}.querySelectorAll('button')].find((b) => /Change the words/.test(b.textContent))`, 'Change the words');
    await type(`${tab}.querySelector('[data-edit-routine] textarea')`, 'Look at the build and the deploy, and say whether both are green.');
    await click(`[...${tab}.querySelectorAll('[data-edit-routine] button')].find((b) => b.textContent.trim() === 'Save')`, 'Save');
    await waitFor(`/the build and the deploy/.test(window.__t.store().routines[${JSON.stringify(made.id)}].instruction) && !${tab}.querySelector('[data-edit-routine]')`, 8000);
    // Paused, and removed.
    await click(`[...${row}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Pause')`, 'Pause');
    await waitFor(`window.__t.store().routines[${JSON.stringify(made.id)}].enabled === false && /1 paused/.test(${tab}.textContent)`, 8000);
    await js(`window.__asked = []; window.__orchConfirm = (m) => { window.__asked.push(String(m)); return true; }; true`);
    await click(`[...${row}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Remove')`, 'Remove');
    await waitFor(`!window.__t.store().routines[${JSON.stringify(made.id)}] && ${mine}.length === ${before}`, 8000);
    if (!(await js(`window.__asked.length === 1`))) throw new Error('a routine was removed without asking');
    await js(`delete window.__orchConfirm; true`);
    await close();
    return `added (every 45 min, not run), set to every hour, reworded, paused, removed (asked first); Sarah has ${before} routine(s) again`;
  });

  await step('Team: editing a profile saves standing instructions', async () => {
    await open('employee', `window.__t.emp('Ava').id + ':profile'`);
    if (!(await js(`window.__t.scope().querySelector('details.pc-more').open`))) await click(`window.__t.scope().querySelector('details.pc-more > summary')`, 'More settings');
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
    await clickText('Pause');
    await waitFor(`${act('Mike')} === 'paused'`, 10000);
    await clickText('Resume');
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
    // The ticket opens on its conversation: what was handed in is said there.
    await waitFor(`!!window.__t.scope().querySelector('[data-thread] [data-comment="handed_in"]')`, 8000);
    await clickText('Work');
    await shows('/confirmed/');
    await shows('/add ui marker/');
    await shows('/measured/i');
    await shot('task-detail');
    await clickText('Changes');
    await shows('/ui-marker\\.txt/');
    await clickText('History');
    await shows('/DONE|Done/');
    await close();
    return 'conversation, work, changes and history all render the real record';
  });

  await step('Terminal wall: a tile enlarges, restores and opens the workstation', async () => {
    await open('wall');
    await waitFor(`!!window.__t.byText('Enlarge')`, 10000);
    await clickText('Enlarge');
    await waitFor(`!!window.__t.byText('Restore')`, 5000);
    await clickText('Restore');
    await clickText('Open terminal');
    await waitFor(`!!document.querySelector('.ws .xterm')`, 10000);
    await clickText('Leave');
    await waitFor(`!document.querySelector('.ws')`, 5000);
  });

  await step('Inbox: "Mark all read" clears the unread notifications', async () => {
    await open('notifications');
    const unread = `Object.values(window.__t.store().notifications).filter((n) => !n.resolvedAt && !n.readAt).length`;
    const before = await js(unread);
    // The window keeps its size from tab to tab, and each thing in it is one line.
    const measure = () => js(`(() => { const b = window.__t.scope().getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height); })()`);
    // (Measured once the window stands still: it arrives with a short movement.)
    const size = async () => {
      for (let last = await measure(), n = 0; n < 20; n++) {
        await sleep(150);
        const now = await measure();
        if (now === last) return now;
        last = now;
      }
      return measure();
    };
    const atNeeds = await size();
    await clickText('News');
    await waitFor(`window.__t.scope().querySelector('[data-inbox]').getAttribute('data-inbox') === 'all'`, 4000);
    if ((await size()) !== atNeeds) throw new Error(`the Inbox changes size between its tabs: ${atNeeds} → ${await size()}`);
    const rows = await js(`[...window.__t.scope().querySelectorAll('[data-news]')].map((r) => Math.round(r.getBoundingClientRect().height))`);
    if (rows.length && Math.max(...rows) > 52) throw new Error(`a piece of news takes ${Math.max(...rows)} px: it is not one line`);
    if (rows.length && !(await js(`[...window.__t.scope().querySelectorAll('.k-label')].some((l) => l.textContent === 'Today')`))) throw new Error('today\'s news is not under "Today"');
    if (before > 0) {
      await clickText('Mark all read');
      await waitFor(`${unread} === 0`, 8000);
    }
    await clickText('Answered');
    await waitFor(`window.__t.scope().querySelector('[data-inbox]').getAttribute('data-inbox') === 'answered'`, 4000);
    if ((await size()) !== atNeeds) throw new Error(`the Inbox changes size between its tabs: ${atNeeds} → ${await size()}`);
    await close();
    return `${before} unread → 0 at ${new Date().toISOString()}`;
  });

  await step('Growth: a lesson is retired and reactivated from its card', async () => {
    await open('growth');
    const status = `(Object.values(window.__t.store().lessons).find((l) => l.text === ${JSON.stringify(ctx.lesson)}) || {}).status`;
    await clickText('All lessons');
    await waitFor(`!!window.__t.near(${JSON.stringify(ctx.lesson)}, 'Retire')`, 8000).catch(() => {
      throw new Error('the taught lesson is not listed with a Retire button under "What the team knows"');
    });
    await click(`window.__t.near(${JSON.stringify(ctx.lesson)}, 'Retire')`, 'Retire');
    await waitFor(`${status} === 'retired'`, 8000);
    await click(`window.__t.near(${JSON.stringify(ctx.lesson)}, 'Reactivate')`, 'Reactivate');
    await waitFor(`${status} === 'active'`, 8000);
    await close();
    return 'active → retired → active';
  });

  await step('Team: changing an appearance is saved', async () => {
    await open('employee', `window.__t.emp('Ava').id`);
    await clickText('Look');
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
    await unfold(ctx.spareHost);
    // A machine that is away cannot be looked into: nothing offers to bring in what runs there.
    if (await js(`[...(${machine(ctx.spareHost)}).querySelectorAll('button')].some((b) => /Bring in/.test(b.textContent))`)) throw new Error('a machine that is offline offers to bring in what is running there');
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
    if (!(await js(`/kept on this computer/.test(window.__t.scope().textContent) && [...window.__t.scope().querySelectorAll('nav .section-title')].map((e) => e.textContent).join('|') === 'This computer|The office'`))) throw new Error('Settings does not show the two groups "This computer" and "The office"');
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
    await camera('CEO');
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
    await camera('CEO');
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
    await camera('CEO');
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
    await camera('Command center');
    await waitFor(`Object.values(window.__orchScene.detail).every(Boolean) && window.__orchScene.detail.server === true && window.__orchScene.detail.hifi === true`, 8000);
    const all = await detail();
    await camera('CEO');
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
    // (One on the office's own floor: the checks at the end look its people up by their desks.)
    const z = zones.find((x) => !x.id.startsWith('m:')) || zones[0];
    const real = await js(`(() => { const t = Object.values(window.__t.store().tasks).filter((x) => x.projectId === ${JSON.stringify(z.projectId)} && x.kind !== 'review'); const n = (s) => t.filter((x) => x.status === s).length; return { inProgress: n('IN_PROGRESS'), blocked: n('BLOCKED'), done: n('DONE'), name: window.__t.store().projects[${JSON.stringify(z.projectId)}].name }; })()`);
    if (real.name !== z.name || real.inProgress !== z.inProgress || real.blocked !== z.blocked || real.done !== z.done) throw new Error(`the sign says ${JSON.stringify(z)} but the project has ${JSON.stringify(real)}`);
    // A pod with nobody in it is nobody's zone. (Of the office's own floor: a member's room — `m:<host>:…` — has no desks in the layout to look its people up by.)
    const empty = await js(`(() => { const s = window.__t.store(); const taken = new Set(Object.values(s.employees).filter((e) => !e.archived && e.deskId).map((e) => e.deskId)); return ${JSON.stringify(zones.map((x) => x.id).filter((id) => !id.startsWith('m:')))}.filter((id) => !s.layout.desks.some((d) => d.id.startsWith(id.replace(/-[a-z]$/, '-')) && taken.has(d.id))); })()`);
    if (empty.length) throw new Error(`empty pods are marked as zones: ${empty.join(', ')}`);
    // Click the sign, from the overview camera, where a person would.
    await camera('Management');
    await sleep(2500);
    let opened = null;
    for (const [zid, sign] of Object.entries(await js(`window.__orchScene.zoneSigns`))) {
      if (zid.startsWith('m:') || sign.projectId !== z.projectId) continue;
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
    await camera('CEO');
    return `sign "${z.name}": ${z.inProgress} in progress, ${z.blocked} blocked, ${z.done} done — ${zones.length} zone(s); clicking the sign of pod ${opened} opened the project`;
  });

  await step('3D office: right-clicking an employee opens their menu; "Ask for a report" asks their real session', async () => {
    await camera('Command center');
    await sleep(3500);
    const tag = `[...document.querySelectorAll('.tag')].find((t) => t.querySelector('.tag-name') && t.querySelector('.tag-name').textContent.trim().startsWith('Ava'))`;
    await waitFor(`!!(${tag}) && (${tag}).getBoundingClientRect().width > 0`, 10000);
    const menuOpen = `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Ask for a report')`;
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
    await click(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Ask for a report')`, 'Ask for a report');
    await waitFor(`!(${menuOpen})`, 4000);
    await camera('CEO');
    return `menu opened by a right-click ${hit}px below the name tag`;
  });

  await step('Task panel: the owner approves a change that is waiting for review', async () => {
    await open('task', JSON.stringify(ctx.reviewTaskId));
    await clickText('Approve');
    await waitFor(`window.__t.store().tasks[${JSON.stringify(ctx.reviewTaskId)}].status === 'DONE'`, 30000);
    await close();
  });

  await step('A task has a conversation: the employee asks there instead of blocking, I answer, send the work back, and approve it', async () => {
    // Somebody who is at their desk with nothing to do.
    const who = await js(`(() => { const st = window.__t.store(); const e = Object.values(st.employees).find((x) => !x.archived && x.roleKey !== 'foreman' && x.projectId && !st.hosts[x.hostId]?.memberId && Object.values(st.sessions).some((q) => q.employeeId === x.id && q.status === 'running' && q.inTurn === false) && !Object.values(st.tasks).some((t) => t.assigneeId === x.id && (t.status === 'IN_PROGRESS' || t.status === 'READY'))); return e ? { id: e.id, name: e.name, projectId: e.projectId } : null; })()`);
    if (!who) throw new Error('nobody is free for a ticket');
    await open('task', `'new'`);
    const title = 'Conversation ticket 4471';
    await type(`window.__t.scope().querySelector('[data-ticket-new] input[aria-label="Title"]')`, title);
    await type(`window.__t.field('Description')`, 'Make the banner. @@fake: sleep 5000; mcp comment_on_task {"text":"Which colour should the banner be?","ask":true,"options":[{"label":"Blue","description":"As on the home page"},{"label":"Red"}],"files":["sketch.png"]}; write banner.txt blue; commit banner; complete the banner is made@@');
    await js(`(() => { window.__t.setSelect(window.__t.field('Assignee'), ${JSON.stringify(who.id)}); window.__t.setSelect(window.__t.field('Project'), ${JSON.stringify(who.projectId)}); })()`);
    // Who reviews it is chosen in plain view: here, me alone.
    const choices = await js(`[...window.__t.scope().querySelectorAll('[role=radiogroup][aria-label="Review"] button')].map((b) => b.dataset.review + (b.getAttribute('aria-checked') === 'true' ? '*' : '')).join(',')`);
    if (choices !== 'both,boss,peer,none*') throw new Error(`the review choices of this office (set to "none") are ${choices}`);
    await click(`window.__t.scope().querySelector('[data-review="boss"]')`, 'reviewed by me');
    await shot('ticket-new');
    await clickText('Create task');
    const tid = await waitFor(`(Object.values(window.__t.store().tasks).find((t) => t.title === ${JSON.stringify(title)}) || {}).id`, 10000);
    const t = `window.__t.store().tasks[${JSON.stringify(tid)}]`;
    const pane = `window.__t.scope().querySelector('[data-ticket]')`;
    if ((await js(`${t}.reviewBy`)) !== 'boss') throw new Error(`created as reviewed by ${await js(`${t}.reviewBy`)}`);
    // (A sketch for the employee to send with its question: put into its folder while it "works" — the scripted worker cannot draw.)
    const folder = await waitFor(`${t}.status === 'IN_PROGRESS' && ${t}.worktree`, 20000);
    fs.writeFileSync(path.join(folder, 'sketch.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    // The window stays where it was, now on the new ticket. The employee asks; the ticket says so and the box is for the answer.
    await waitFor(`(${t}.comments || []).some((c) => c.kind === 'question' && !c.answeredBy)`, 30000);
    await waitFor(`(${pane}) && (${pane}).querySelector('[data-ticket-need]').dataset.ticketNeed === 'you' && !!(${pane}).querySelector('[data-comment="question"].tk-open') && (${pane}).querySelector('[data-compose]').dataset.compose === 'answer'`, 8000);
    // On the board its card says what it waits for; a click on the card is the way into the task.
    await open('tasks');
    const card = `window.__t.scope().querySelector('[data-ticket-card="' + ${t}.key + '"]')`;
    await waitFor(`!!(${card}) && /Asks you/.test((${card}).querySelector('[data-card-need]')?.textContent || '') && /Which colour should the banner be/.test((${card}).textContent)`, 8000);
    await shot('board-asks');
    await click(card, 'the card of the task');
    await waitFor(`!!(${pane}) && (${pane}).dataset.ticket === ${t}.key && (${pane}).querySelector('[data-compose]').dataset.compose === 'answer'`, 6000);
    // A colleague is put on the ticket and taken off again, right there.
    await click(`(${pane}).querySelector('[data-add-people]')`, '+ Add');
    await click(`(${pane}).querySelector('.tk-pop[open] .tk-pop-item')`, 'the first colleague offered');
    await waitFor(`(${t}.helperIds || []).length === 1 && (${pane}).querySelectorAll('[data-ticket-meta] .tk-person-chip.on').length === 1`, 6000);
    await click(`(${pane}).querySelector('[data-ticket-meta] .tk-person-chip.on button')`, 'take them off');
    await waitFor(`(${t}.helperIds || []).length === 0`, 6000);
    // "@" offers the office's people; Enter takes the one that is lit.
    const box = `(${pane}).querySelector('textarea[aria-label="Comment"]')`;
    await type(box, '@bo');
    await waitFor(`!!(${pane}).querySelector('.tk-mentions [aria-selected="true"]') && (${pane}).querySelector('.tk-mentions [aria-selected="true"]').textContent === '@boss'`, 4000);
    await shot('ticket-mention');
    await key('Enter');
    await waitFor(`(${box}).value === '@boss ' && !(${pane}).querySelector('.tk-mentions')`, 4000);
    // The picture that came with the question is under it and among the task's pictures; a click enlarges it, and Escape closes the picture — not the task.
    await waitFor(`!!(${pane}).querySelector('[data-comment="question"] [data-picture="sketch.png"] img') && !!(${pane}).querySelector('[data-task-pictures] [data-picture="sketch.png"]')`, 10000);
    await click(`(${pane}).querySelector('[data-comment="question"] [data-picture="sketch.png"]')`, 'the picture under the question');
    await waitFor(`!!document.querySelector('[data-viewer="sketch.png"] img')`, 6000);
    await shot('ticket-picture');
    await key('Escape');
    await waitFor(`!document.querySelector('[data-viewer]') && !!(${pane})`, 4000);
    // The choices the employee proposed are there to click — here, and at their desk (it is the same question).
    const offered = await js(`[...(${pane}).querySelectorAll('[data-options] [data-option]')].map((b) => b.dataset.option).join(',')`);
    const atDesk = await js(`(() => { const q = Object.values(window.__t.store().questions).find((x) => x.taskId === ${JSON.stringify(tid)} && x.status === 'open'); return q ? q.options.map((o) => o.label).join(',') : ''; })()`);
    if (offered !== 'Blue,Red' || atDesk !== 'Blue,Red') throw new Error(`choices offered on the task: "${offered}", at the desk: "${atDesk}"`);
    await type(box, '');
    await shot('ticket-question');
    await click(`(${pane}).querySelector('[data-option="Blue"]')`, 'the choice "Blue"');
    await waitFor(`${t}.status === 'REVIEW' && ${t}.reviewStage === 'boss'`, 40000);
    await waitFor(`(${pane}).querySelector('[data-compose]').dataset.compose === 'review' && [...(${pane}).querySelectorAll('[data-comment]')].map((c) => c.dataset.comment).join(',') === 'question,answer,handed_in'`, 8000);
    // Sent back with what should change; it comes back, and is approved.
    const sendBack = `window.__t.byText('Send back')`;
    if (await js(`!!(${sendBack})`)) throw new Error('"Send back" is offered before anything was written');
    await type(box, 'Make it darker. @@fake-retry: write banner.txt navy; commit darker; complete it is navy now@@');
    await clickText('Send back');
    await waitFor(`${t}.status === 'REVIEW' && ${t}.attempts === 1`, 40000);
    await waitFor(`[...(${pane}).querySelectorAll('[data-comment]')].map((c) => c.dataset.comment).join(',') === 'question,answer,handed_in,sent_back,handed_in'`, 8000);
    await shot('ticket-review');
    await clickText('Approve');
    await waitFor(`${t}.status === 'DONE'`, 30000);
    // Done is not the end: it can still be sent back from here.
    await waitFor(`(${pane}).querySelector('[data-ticket-need]').dataset.ticketNeed === 'done' && !!window.__t.scope().querySelector('.tk-compose') && [...window.__t.scope().querySelectorAll('.tk-compose button')].some((b) => b.textContent.trim() === 'Send back')`, 8000);
    await shot('ticket-done');
    // A picture goes with my own comment as well: pasted into the box, it waits there by name and is then under the comment.
    await js(`(() => { const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([png], 'my-note.png', { type: 'image/png' })); (${box}).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
    await waitFor(`(${pane}).querySelector('[data-added-files]')?.dataset.addedFiles === '1' && /my-note\.png/.test((${pane}).querySelector('[data-added-files]').textContent)`, 10000);
    await type(box, 'Like this.');
    await clickText('Comment');
    await waitFor(`(() => { const notes = [...(${pane}).querySelectorAll('[data-comment="note"]')]; const last = notes[notes.length - 1]; return !!last && /Like this\./.test(last.textContent) && !!last.querySelector('[data-picture="my-note.png"] img'); })() && !(${pane}).querySelector('[data-added-files]')`, 10000);
    await shot('ticket-my-picture');
    ctx.talkTicketId = tid;
    await close();
    return `${who.name}: asked → answered → handed in → sent back → handed in → approved`;
  });

  await step('Machines: an already-running tmux session is found and attached without restarting it', async () => {
    await open('hosts');
    await unfold('dev-mac');
    await clickText('Bring in what is running there…');
    await waitFor(`/legacy-claude/.test(window.__t.scope().textContent)`, 10000);
    // What the office already has is not listed again beside it: it is one folded line.
    const listed = await js(`(() => { const d = window.__t.scope().querySelector('[data-discover]'); return { rows: [...d.querySelectorAll('.k-group')][0].querySelectorAll('.k-row').length, folded: [...d.querySelectorAll('.k-more summary')].map((x) => x.textContent).find((t) => /already/.test(t)) || '', own: [...[...d.querySelectorAll('.k-group')][0].querySelectorAll('.k-row')].filter((r) => /^orch-/.test(r.textContent)).length }; })()`);
    if (listed.own) throw new Error(`${listed.own} of the office's own sessions are listed among what can be brought in`);
    if (!/^\d+ already in the office$/.test(listed.folded)) throw new Error(`the sessions the office already has are announced as "${listed.folded}"`);
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
    await clickText('Waiting for you');
    await waitFor(`/docker build/.test(window.__t.scope().textContent)`, 10000);
    await shot('growth-suggestion');
    // Saying yes to something that lets agents do more is spelled out before the button.
    await waitFor(`/This lets employees do more without asking you/.test(window.__t.scope().textContent)`, 5000);
    await click(`window.__t.near('docker build', 'Yes, allow it')`, 'Yes, allow it');
    await waitFor(`Object.values(window.__t.store().improvements).some((i) => i.kind === 'allow_rule' && i.status === 'applied')`, 8000);
    await close();
  });

  await step('Growth: a lesson is edited in place', async () => {
    await open('growth');
    await clickText('All lessons');
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
    // One number for "needs you": this window's heading says what the Inbox button says.
    const same = await js(`(() => {
      const pill = [...document.querySelectorAll('button.pill')].find((b) => /^Inbox/.test(b.textContent.trim()));
      const onButton = Number((pill.querySelector('.pill-count') || { textContent: '0' }).textContent);
      const title = [...window.__t.scope().querySelectorAll('.section-title')].find((t) => /^Needs you/.test(t.textContent)).textContent;
      const here = Number((title.match(/[(]([0-9]+)[)]/) || [0, 0])[1]);
      return onButton === here ? '' : 'the Inbox button says ' + onButton + ', the Company window says ' + here;
    })()`);
    if (same) throw new Error(same);
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
    // What the tab is for is said at its top; then three figures, and what can be done.
    await waitFor(`/Where finished work comes together/.test(window.__t.scope().textContent) && /waiting to go to/.test(window.__t.scope().textContent) && window.__t.scope().querySelectorAll('[data-project-integration] .k-figure').length === 3`, 10000);
    await clickText('Test now');
    await waitFor(`/The last integration test/.test(window.__t.scope().textContent) && /on request/.test(window.__t.scope().textContent)`, 30000);
    const verdict = await js(`(window.__t.scope().textContent.match(/(passing|failing|could not run)integration tests/) || [])[1]`);
    if (!verdict) throw new Error('the tab does not say how the integration tests went');
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
    // The app asks in its own dialog: Cancel leaves the task, the red button deletes it.
    await js(`window.__confirms = []; delete window.__orchConfirm; true`);
    await open('task', JSON.stringify(ctx.throwawayTaskId));
    // Deleting is not something done in passing: it is in the ticket's menu.
    const del = `[...window.__t.scope().querySelectorAll('.tk-more .tk-pop-item')].find((b) => b.textContent.trim() === 'Delete task…')`;
    await click(`window.__t.scope().querySelector('[data-more]')`, 'More actions');
    await click(del, 'Delete task…');
    await waitFor(`!!document.querySelector('.confirm-dialog')`, 5000);
    const asked = await js(`document.querySelector('.confirm-dialog').textContent`);
    if (!/Delete .*This cannot be undone/s.test(asked)) throw new Error(`no delete confirmation was asked (got: ${asked.slice(0, 80)})`);
    await shot('confirm-dialog');
    await click(`[...document.querySelectorAll('.confirm-dialog button')].find((b) => b.textContent.trim() === 'Cancel')`, 'Cancel');
    await waitFor(`!document.querySelector('.confirm-dialog')`, 3000);
    await sleep(300);
    if (!(await js(`!!window.__t.store().tasks[${JSON.stringify(ctx.throwawayTaskId)}]`))) throw new Error('Cancel deleted the task');
    await click(`window.__t.scope().querySelector('[data-more]')`, 'More actions');
    await click(del, 'Delete task…');
    await waitFor(`!!document.querySelector('.confirm-dialog [data-confirm-ok]')`, 5000);
    await click(`document.querySelector('.confirm-dialog [data-confirm-ok]')`, 'the confirming button');
    await waitFor(`!window.__t.store().tasks[${JSON.stringify(ctx.throwawayTaskId)}]`, 8000);
    // The later steps answer such questions through the test hook, which records what was asked.
    await js(`window.__orchConfirm = (m) => { window.__confirms.push(String(m)); return true; }; true`);
    await close();
    return `asked: "${asked.split('\\n')[0]}"`;
  });

  await step('Team: an employee without a session is archived after confirmation', async () => {
    await open('employee', `window.__t.emp(${JSON.stringify(ctx.tempEmployee)}).id + ':profile'`);
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
      ['Assign task…', `!!document.querySelector('.win [data-ticket-new]') && /New task/.test(document.querySelector('.win h2').textContent) && /Ava/.test(document.querySelector('.win').textContent)`],
      ['Profile', `window.__t.store().panel === 'employee' && /Ava/.test(document.querySelector('.win').textContent)`],
      ['Their project', `window.__t.store().panel === 'projects'`],
      ['Desk and working hours…', `window.__t.store().panel === 'employee' && String(window.__t.store().panelArg).endsWith(':desk')`],
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
    await click(menuItem('Pause'), 'menu entry "Pause"');
    await waitFor(`${activity} === 'paused'`, 10000);
    await openEmployeeMenu('Ava');
    await click(menuItem('Resume'), 'menu entry "Resume"');
    await waitFor(`${activity} !== 'paused'`, 10000);
    done.push('Pause', 'Resume');
    await camera('CEO');
    return done.join(', ');
  });

  await step('Task panel: a task is marked done by hand, after the warning that it is unverified', async () => {
    await js(`window.__confirms = []; window.__orchConfirm = (m) => { window.__confirms.push(String(m)); return true; }; true`);
    await open('task', JSON.stringify(ctx.manualTaskId));
    await click(`window.__t.scope().querySelector('[data-more]')`, 'More actions');
    await waitFor(`!!window.__t.scope().querySelector('select[aria-label="Move to another status"]')`, 5000);
    await js(`window.__t.setSelect(window.__t.scope().querySelector('select[aria-label="Move to another status"]'), 'DONE')`);
    await waitFor(`window.__t.store().tasks[${JSON.stringify(ctx.manualTaskId)}].status === 'DONE'`, 8000);
    const asked = await js(`window.__confirms.join(' | ')`);
    if (!/by hand/.test(asked) || !/not verified/.test(asked)) throw new Error(`the unverified warning was not shown (got: ${asked.slice(0, 80)})`);
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
    await camera('CEO');
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
    await click(`window.__t.scope().querySelector('button[title="Remove this empty seat"]')`, 'the ✕ on an empty seat');
    await waitFor(`window.__t.store().layout.desks.length === ${before} - 1`, 8000);
    await close();
    return `${before} → ${before - 1} desks`;
  });

  await step('3D office: standing in front of the hi-fi offers it, and Space opens the radio', async () => {
    await close();
    await camera('CEO');
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

  await step('3D office: standing in front of the vault offers it, and Space opens the vault', async () => {
    await close();
    await camera('CEO');
    const spot = await js(`(window.__orchPlayer.spots || []).find((s) => s.kind === 'vault') || null`);
    if (!spot) throw new Error('the office has no vault to walk up to');
    await js(`window.__orchPlayer.goto = { x: ${spot.x}, z: ${spot.z}, rot: ${-Math.PI / 2} }; true`); // facing the server room's west wall, where it stands
    await waitFor(`(() => { const n = window.__t.store().nearby; return !!n && n.kind === 'vault' && n.label === 'VAULT — PASSWORDS AND KEYS'; })()`, 8000);
    await waitFor(`[...document.querySelectorAll('.prompt')].some((e) => e.textContent.replace(/ +/g, ' ').trim() === 'SpaceVAULT — PASSWORDS AND KEYS')`, 4000);
    // The picture: from inside the room (in front of the racks), the safe's door and one side. The owner takes half
    // a step to the hinge side and turns to the wheel, so as not to stand between the camera and the door; that is
    // still in front of the vault, and the prompt stays.
    await js(`window.__orchPlayer.goto = { x: ${spot.x - 0.2}, z: ${spot.z + 0.55}, rot: ${Math.atan2(-0.8, -0.6)} }; true`);
    await js(`window.__orchScene.cam = { pos: [${spot.x + 2.2}, 2.0, ${spot.z - 1.7}], look: [${spot.x - 0.9}, 0.9, ${spot.z + 0.05}], fov: 42 }; true`);
    await sleep(1800);
    if ((await js(`(window.__t.store().nearby || {}).kind`)) !== 'vault') throw new Error('half a step aside, the vault is no longer offered');
    await shot('vault-3d');
    await js(`delete window.__orchScene.cam; true`);
    await key('Space', ' ');
    await waitFor(`window.__t.store().panel === 'vault'`, 6000);
    // The vault's window is somebody else's: whatever is shown for it, the office is still there and it closes.
    await sleep(400);
    if (!(await js(`!!document.querySelector('canvas') && !!document.querySelector('.hud')`))) throw new Error('opening the vault took the office down');
    await close();
    await waitFor(`window.__t.store().panel === null && !document.querySelector('.win')`, 5000);
    return `stood at ${spot.x.toFixed(1)}, ${spot.z.toFixed(1)}; Space opened the vault`;
  });

  await step('3D office: an empty desk offers a seat; someone is seated there, moved with the menu, and swapped with a colleague', async () => {
    await close();
    await camera('CEO');
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
    await waitFor(`/EMPTY DESK/.test((document.querySelector('.prompt') || {}).textContent || '')`, 4000);
    await shot('empty-desk');
    await key('Space', ' ');
    await waitFor(`window.__t.store().panel === 'seat' && document.querySelectorAll('.win .choice').length === 3`, 8000);
    await shot('empty-desk-choices');
    await click(`document.querySelector('.win .choice[data-choice="move"]')`, 'Seat someone who already works here');
    await type(`window.__t.scope().querySelector('input[aria-label="Search people"]')`, 'Scribe');
    await click(`window.__t.near('Scribe', 'Move here')`, 'Move here');
    await waitFor(`window.__t.emp('Scribe').deskId === ${JSON.stringify(first)} && !document.querySelector('.win')`, 8000);
    // 2. "Move to another desk…" from the right-click menu, then walk to a free desk and press Space.
    await openEmployeeMenu('Ava');
    await click(menuItem('Move to another desk…'), 'Move to another desk…');
    await waitFor(`window.__t.store().movingEmployeeId === window.__t.emp('Ava').id`, 4000);
    await camera('CEO');
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

  await step('3D office: an empty desk can be hired for, or sat at with a Claude Code session of one\'s own', async () => {
    await close();
    await camera('CEO');
    const freeDesks = () => js(`(() => { const s = window.__t.store(); const taken = new Set(Object.values(s.employees).filter((e) => !e.archived && e.deskId).map((e) => e.deskId)); return s.layout.desks.filter((d) => !taken.has(d.id) && d.kind !== 'executive').map((d) => d.id); })()`);
    const standAt = async (deskId) => {
      const seat = await js(`window.__orchPlayer.seatOf(${JSON.stringify(deskId)})`);
      await js(`window.__orchPlayer.goto = { x: ${seat.x}, z: ${seat.z} }; true`);
      await waitFor(`(() => { const n = window.__t.store().nearby; return !!n && n.kind === 'desk' && n.id === ${JSON.stringify(deskId)}; })()`, 8000);
    };
    const folder = async (label) => {
      await clickText('Browse…');
      await waitFor(`!!window.__t.near(${JSON.stringify(ctx.hireFolderName)}, 'Choose')`, 10000);
      await click(`window.__t.near(${JSON.stringify(ctx.hireFolderName)}, 'Choose')`, 'Choose');
      await waitFor(`window.__t.field(${JSON.stringify(label)}).value === ${JSON.stringify(ctx.hireFolder)}`, 5000);
    };
    // 1. Hire someone new for exactly this desk: the desk is already chosen in the form.
    const [a] = await freeDesks();
    await standAt(a);
    await key('Space', ' ');
    await waitFor(`document.querySelectorAll('.win .choice').length === 3`, 8000);
    await click(`document.querySelector('.win .choice[data-choice="hire"]')`, 'Hire someone new for this desk');
    await waitFor(`/Hire someone for this desk/.test((document.querySelector('.win h2') || {}).textContent || '')`, 8000);
    if (await js(`document.querySelectorAll('.win .hire-place').length > 1 && !document.querySelector('.win form')`)) await js(`[...document.querySelectorAll('.win .hire-place')].find((b) => /dev-mac/.test(b.textContent)).click()`);
    await waitFor(`window.__t.scope().querySelector('.desk-seat.on')?.dataset.desk === ${JSON.stringify(a)}`, 5000);
    await type(`window.__t.field('Name')`, 'Deskhire');
    await folder('Folder they live in');
    await clickText('Hire');
    await waitFor(`!!window.__t.emp('Deskhire') && !document.querySelector('.win')`, 10000);
    if ((await js(`window.__t.emp('Deskhire').deskId`)) !== a) throw new Error(`hired at ${await js(`window.__t.emp('Deskhire').deskId`)} instead of the desk stood at (${a})`);
    // 2. Sit down oneself: a session of one's own starts at this desk and its terminal opens with the keyboard taken.
    const [b] = await freeDesks();
    await standAt(b);
    await key('Space', ' ');
    await waitFor(`document.querySelectorAll('.win .choice').length === 3`, 8000);
    await click(`document.querySelector('.win .choice[data-choice="me"]')`, 'Sit here myself');
    await waitFor(`/Sit here with your own Claude Code/.test((document.querySelector('.win h2') || {}).textContent || '')`, 8000);
    if (await js(`document.querySelectorAll('.win .hire-place').length > 1 && !document.querySelector('.win form')`)) await js(`[...document.querySelectorAll('.win .hire-place')].find((b) => /dev-mac/.test(b.textContent)).click()`);
    if (await js(`!!window.__t.byText('Sit down and start') `)) throw new Error('sitting down was offered before a folder was chosen');
    const mine = await js(`window.__t.field('Name on the desk').value`);
    await folder('Claude Code starts in this folder');
    await shot('sit-here-myself');
    await clickText('Sit down and start');
    await waitFor(`(() => { const e = window.__t.emp(${JSON.stringify(mine)}); return !!e && e.selfDriven === true && e.deskId === ${JSON.stringify(b)}; })()`, 10000);
    await waitFor(`!!document.querySelector('.ws .xterm')`, 15000);
    await waitFor(`(() => { const s = window.__t.store(); const e = window.__t.emp(${JSON.stringify(mine)}); const ses = Object.values(s.sessions).find((x) => x.employeeId === e.id && x.status === 'running'); return !!ses && !!s.control[ses.id] && s.control[ses.id].you === true; })()`, 20000);
    await shot('sit-here-terminal');
    await clickText('Leave');
    await waitFor(`!document.querySelector('.ws')`, 5000);
    return `Deskhire hired at ${a}; "${mine}" sat down at ${b} with the keyboard`;
  });

  await step('3D office: the TV on the break room wall opens; put away it stays on, and the top bar turns it off', async () => {
    await close();
    await camera('CEO');
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
    await js(`window.__confirms = []; window.__orchConfirm = (m) => { window.__confirms.push(String(m)); return true; }; true`);
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
    await open('overview', `'usage'`);
    await waitFor(`(() => { const c = ${card('dev@example.test')}; return !!c && /42%/.test(c.textContent) && /85%/.test(c.textContent) && /Dev Org/.test(c.textContent); })()`, 20000);
    const before = await js(`window.__t.scope().querySelectorAll('.claude-account').length`);
    // The same reading hangs on the CEO room wall as a clock: the big hand is the week, the small dial the 5 hours.
    await waitFor(`(window.__orchScene.clocks || []).some((c) => c.name === 'dev@example.test' && Math.round(c.week) === 85 && Math.round(c.five) === 42 && /Week: 15% left/.test(c.lines.join(' ')) && /5 hours: 58% left/.test(c.lines.join(' ')))`, 10000);
    await shot('ceo-claude');
    // (The wall has a clock for each account of the office's own machines; a member's own account is on the list above and not on the wall.)
    const clocksBefore = await js(`(window.__orchScene.clocks || []).length`);
    await close();
    await open('employee', `window.__t.emp('Ava').id + ':profile'`);
    // Rarely changed settings are folded away: open them first.
    if (!(await js(`window.__t.scope().querySelector('details.pc-more').open`))) await click(`window.__t.scope().querySelector('details.pc-more > summary')`, 'More settings');
    // The accounts of her machine are chosen by name; a login made by hand in a folder of its own is "Another folder…".
    const choice = `window.__t.scope().querySelector('select[aria-label="Claude account"]')`;
    const named = await js(`[...${choice}.options].map((o) => o.textContent)`);
    if (!/^dev@example\.test/.test(named[0]) || named[named.length - 1] !== 'Another folder…' || named.some((n) => /^~\//.test(n))) throw new Error(`the accounts to choose from: ${named.join(' | ')}`);
    await js(`window.__t.setSelect(${choice}, ${choice}.options[${choice}.options.length - 1].value)`);
    await waitFor(`!!window.__t.scope().querySelector('input[aria-label="Claude account folder"]')`, 3000);
    await type(`window.__t.scope().querySelector('input[aria-label="Claude account folder"]')`, '~/.claude-second');
    await clickText('Save changes');
    await waitFor(`window.__t.emp('Ava').claudeConfigDir === '~/.claude-second'`, 8000);
    await close();
    await open('overview', `'usage'`);
    // Her account is listed at once, without figures: nobody has worked on it yet.
    await waitFor(`(() => { const c = ${card('~/.claude-second')}; return !!c && /Not reported yet/.test(c.textContent) && /used by Ava/.test(c.querySelector('.cl-people').getAttribute('aria-label')); })()`, 10000);
    const after = await js(`window.__t.scope().querySelectorAll('.claude-account').length`);
    await shot('ceo-claude-two');
    await close();
    // The second account gets a clock of its own at once, with its hands at rest until something is reported.
    await waitFor(`(window.__orchScene.clocks || []).length === ${clocksBefore + 1} && window.__orchScene.clocks.some((c) => c.week === null && /Not reported yet/.test(c.lines.join(' ')))`, 10000);
    // The office is drawn at an even rhythm: on every refresh of the display, or on every second one.
    const pace = await js(`window.__orchPace`);
    if (!pace || ![1, 2].includes(pace.every) || !(pace.fps > 20)) throw new Error(`the render loop reports ${JSON.stringify(pace)}`);
    return `${before} account → ${after}; the first shows 42% of 5 hours and 85% of the week`;
  });

  await step('Company → Claude: an account is signed in to from the window — a link to open, a code to paste — and is then called by its e-mail address everywhere; Z.AI is offered as a kind of account', async () => {
    const card = (text) => `[...window.__t.scope().querySelectorAll('.claude-account')].find((c) => c.textContent.includes(${JSON.stringify(text)}))`;
    await open('overview', `'usage'`);
    // The account Ava was put on by its folder is called by who is signed in to it there — asked of the machine when
    // she was put on it, before any session of hers reported — with the folder as the quiet line under the name.
    await waitFor(`!!${card('~/.claude-second')}`, 15000);
    await sleep(1500);
    const named = await js(`(() => { const c = ${card('~/.claude-second')}; return { name: c.querySelector('.strong').textContent, under: c.querySelector('.small.faint').textContent }; })()`);
    if (named.name !== 'second@example.test' || !/~\/\.claude-second/.test(named.under)) throw new Error(`the account in ~/.claude-second is called "${named.name}" (under it: "${named.under}")`);
    // Signing in again, as somebody else, without leaving the window.
    await click(`${card('~/.claude-second')}.querySelector('.cl-row')`, 'the account\'s row');
    await click(`${card('~/.claude-second')}.querySelector('[data-sign-in-open]')`, 'Sign in again…');
    const sheet = `window.__t.scope().querySelector('[data-sign-in]')`;
    // Claude Code's own sign-in runs on the machine; the window shows its link as a button and what its terminal says.
    await waitFor(`!!${sheet} && !!${sheet}.querySelector('[data-sign-in-link]') && /Paste code here/.test(${sheet}.querySelector('[data-sign-in-screen]').textContent)`, 25000);
    const link = await js(`${sheet}.querySelector('[data-sign-in-link]').getAttribute('href')`);
    if (!/^https:\/\/claude\.ai\/oauth\/authorize\?.*state=S{180}$/.test(link)) throw new Error(`the sign-in link: ${link.slice(0, 90)}… (${link.length} characters)`);
    await shot('claude-sign-in');
    await type(`${sheet}.querySelector('input[aria-label="Sign-in code"]')`, 'uitest');
    await click(`[...${sheet}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Send')`, 'Send');
    await waitFor(`!!${sheet}.querySelector('[data-signed-in]') && /uitest@example\.test/.test(${sheet}.querySelector('[data-signed-in]').textContent)`, 20000);
    // The list under the sheet knows it at once: the account has its name, and the folder is the quiet line under it.
    await waitFor(`(() => { const c = ${card('uitest@example.test')}; return !!c && c.querySelector('.strong').textContent === 'uitest@example.test' && !/Not signed in/.test(c.textContent); })()`, 10000);
    await click(`[...${sheet}.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Done')`, 'Done');
    await waitFor(`!window.__t.scope().querySelector('[data-sign-in]')`, 4000);
    // "Add an account…" offers the two kinds; Z.AI asks for a key and nothing else.
    await click(`[...window.__t.scope().querySelectorAll('button')].find((b) => /^Add an account/.test(b.textContent.trim()))`, 'Add an account…');
    await waitFor(`!!window.__t.scope().querySelector('[data-add-claude]') && !!window.__t.scope().querySelector('[data-add-zai]')`, 4000);
    await click(`window.__t.scope().querySelector('[data-add-zai]')`, 'Z.AI');
    await waitFor(`!!window.__t.scope().querySelector('[data-zai-account] input[type=password][aria-label="Z.AI API key"]')`, 4000);
    const zai = await js(`(() => { const f = window.__t.scope().querySelector('[data-zai-account]'); return { add: [...f.querySelectorAll('button')].find((b) => /Add the account/.test(b.textContent)).disabled, fields: f.querySelectorAll('input').length }; })()`);
    if (!zai.add || zai.fields !== 1) throw new Error(`the Z.AI form: Add disabled without a key ${zai.add}, ${zai.fields} field(s) in sight`);
    await shot('claude-zai');
    await click(`[...window.__t.scope().querySelectorAll('[data-zai-account] button')].find((b) => b.textContent.trim() === 'Cancel')`, 'Cancel');
    await close();
    // In Ava's settings her account is chosen by that name now — no folder to read.
    await open('employee', `window.__t.emp('Ava').id + ':profile'`);
    if (!(await js(`window.__t.scope().querySelector('details.pc-more').open`))) await click(`window.__t.scope().querySelector('details.pc-more > summary')`, 'More settings');
    const hers = await waitFor(`(() => { const sel = window.__t.scope().querySelector('select[aria-label="Claude account"]'); const o = sel && sel.selectedOptions[0]; return o && o.textContent === 'uitest@example.test' ? { value: sel.value, typing: !!window.__t.scope().querySelector('input[aria-label="Claude account folder"]') } : null; })()`, 10000);
    if (hers.value !== '~/.claude-second' || hers.typing) throw new Error(`Ava's account in her settings: ${JSON.stringify(hers)}`);
    await close();
    return `signed in as uitest@example.test from the window (a link of ${link.length} characters); Z.AI offered`;
  });

  await step('Company → Claude: who is on what — a line per employee with account, model and effort; several are ticked and set together; nothing changes before Apply', async () => {
    await open('overview', `'usage'`);
    await waitFor(`document.querySelectorAll('[data-who-uses] [data-use-employee]').length >= 5`, 15000);
    const table = `window.__t.scope().querySelector('[data-who-uses]')`;
    const row = (name) => `${table}.querySelector('[data-use-employee=' + JSON.stringify(${JSON.stringify(name)}) + ']')`;
    await js(`${table}.scrollIntoView({ block: 'start' })`);
    // Its heading stays one line also when the box to find somebody is there (more than eight people): the box was
    // stretched to the whole width and the words beside it broke into a column, a word a line.
    const head = await js(`(() => { const t = ${table}; const title = t.querySelector(':scope > .row > .strong'); const find = t.querySelector('input[aria-label="Find an employee"]'); return { lines: Math.round(title.getBoundingClientRect().height / parseFloat(getComputedStyle(title).lineHeight || '18')), find: find ? Math.round(find.getBoundingClientRect().width) : null, row: Math.round(title.parentElement.getBoundingClientRect().height) }; })()`);
    if (head.lines > 1 || (head.find !== null && head.find > 260) || head.row > 60) throw new Error(`the table's heading: ${JSON.stringify(head)}`);
    const first = await js(`(() => { const t = ${table}; return { machines: [...t.querySelectorAll('[data-use-machine]')].map((g) => g.getAttribute('data-use-machine')), selects: t.querySelector('[data-use-employee]').querySelectorAll('select').length, bulk: !!t.querySelector('[data-use-bulk]'), note: t.querySelector('[data-use-save]').textContent, apply: t.querySelector('[data-use-apply]').disabled }; })()`);
    if (!first.machines.includes('dev-mac') || first.selects !== 3 || first.bulk || !/Nothing is changed/.test(first.note) || !first.apply) throw new Error(`the table at first: ${JSON.stringify(first)}`);
    // Two people are ticked; the bar above sets one thing for both. It is a draft: their records do not change.
    const two = await js(`[...${table}.querySelectorAll('[data-use-machine="dev-mac"] [data-use-employee]')].slice(0, 2).map((r) => r.getAttribute('data-use-employee'))`);
    const was = await js(`${JSON.stringify(two)}.map((n) => window.__t.emp(n).model)`);
    for (const name of two) await click(`${row(name)}.querySelector('input[type=checkbox]')`, `${name}'s box`);
    await waitFor(`!!${table}.querySelector('[data-use-bulk]') && /2\\s*chosen/.test(${table}.querySelector('[data-use-bulk]').textContent)`, 4000);
    await js(`window.__t.setSelect(${table}.querySelector('select[aria-label="Model for the chosen"]'), 'haiku')`);
    await waitFor(`${JSON.stringify(two)}.every((n) => ${table}.querySelector('[data-use-employee=' + JSON.stringify(n) + '] select[aria-label$="model"]').value === 'haiku')`, 4000);
    const draft = await js(`({ note: ${table}.querySelector('[data-use-save]').textContent, apply: ${table}.querySelector('[data-use-apply]').textContent.trim(), now: ${JSON.stringify(two)}.map((n) => window.__t.emp(n).model) })`);
    const moved = two.filter((_, i) => was[i] !== 'haiku').length;
    if (!new RegExp(`Unsaved — ${moved} employee`).test(draft.note) || !/model/.test(draft.note) || draft.apply !== `Apply to ${moved}` || JSON.stringify(draft.now) !== JSON.stringify(was)) throw new Error(`the draft: ${JSON.stringify(draft)} (they had ${JSON.stringify(was)})`);
    await shot('claude-who-is-on-what');
    await click(`[...${table}.querySelectorAll('[data-use-save] button')].find((b) => b.textContent.trim() === 'Discard')`, 'Discard');
    await waitFor(`/Nothing is changed/.test(${table}.querySelector('[data-use-save]').textContent)`, 4000);
    // Applied for somebody who is not at work, so that nobody's turn is cut for the test: their effort, and back.
    const idle = await js(`(() => { const s = window.__t.store(); const busy = new Set(Object.values(s.sessions).filter((x) => x.status === 'running' || x.status === 'starting').map((x) => x.employeeId)); const e = Object.values(s.employees).find((x) => !x.archived && x.hostId && s.hosts[x.hostId] && s.hosts[x.hostId].name === 'dev-mac' && !busy.has(x.id)); return e ? { name: e.name, effort: e.effort || '' } : null; })()`);
    let applied = 'nobody was free to apply it to';
    if (idle) {
      const want = idle.effort === 'low' ? 'medium' : 'low';
      await js(`window.__t.setSelect(${row(idle.name)}.querySelector('select[aria-label$="effort"]'), ${JSON.stringify(want)})`);
      await waitFor(`${table}.querySelector('[data-use-apply]').textContent.trim() === 'Apply to 1'`, 4000);
      await click(`${table}.querySelector('[data-use-apply]')`, 'Apply to 1');
      await waitFor(`window.__t.emp(${JSON.stringify(idle.name)}).effort === ${JSON.stringify(want)} && /Nothing is changed/.test(${table}.querySelector('[data-use-save]').textContent)`, 10000);
      await js(`window.__t.setSelect(${row(idle.name)}.querySelector('select[aria-label$="effort"]'), ${JSON.stringify(idle.effort)})`);
      await click(`${table}.querySelector('[data-use-apply]')`, 'Apply to 1');
      await waitFor(`(window.__t.emp(${JSON.stringify(idle.name)}).effort || '') === ${JSON.stringify(idle.effort)}`, 10000);
      applied = `${idle.name}'s effort set to ${want} and back`;
    }
    await close();
    return `${first.machines.join(', ')}; ${two.join(' and ')} set to Haiku together as a draft, discarded; ${applied}`;
  });

  await step('Hi-fi: a station is switched on for the office and says what is on air; it is quieter far from the hi-fi; volume and mute are this computer\'s; the top bar stops it for everyone', async () => {
    // The station of this step is on this very machine, and an office whose door is open does not read "now playing"
    // from an address inside (the door was opened to let the suite's member in): it is closed from here on.
    const shut = await js(`(async () => (await fetch('/api/sharing', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ((window.orchestrator && window.orchestrator.token) || localStorage.getItem('orch.token') || '') }, body: JSON.stringify({ open: false }) })).status)()`);
    if (shut !== 200) throw new Error(`closing the door: ${shut}`);
    await open('radio');
    await waitFor(`!!document.querySelector('.win .radio-now')`, 8000);
    const builtIn = await js(`window.__t.store().settings.radio.stations.map((x) => x.name).join(', ')`);
    const officeVolume = await js(`window.__t.store().settings.radio.volume`);
    await clickText('Add a station');
    await type(`window.__t.field('Name')`, ctx.radioName);
    await type(`window.__t.field('Stream address')`, ctx.radioUrl);
    await type(`window.__t.field('Now-playing address')`, ctx.radioNow);
    await click(`window.__t.submit('Add and play')`, 'Add and play');
    // The office has it on (its state, as the server told every window), and this window plays its own copy.
    const name = JSON.stringify(ctx.radioName);
    await waitFor(`(() => { const s = window.__t.store(); return !!s.hifi && s.hifi.station.name === ${name} && s.radio.status === 'playing' && s.radio.name === ${name}; })()`, 15000);
    await waitFor(`window.__t.store().radio.nowPlaying === ${JSON.stringify(ctx.radioTitle)}`, 10000);
    await waitFor(`/Switched on by you/.test(window.__t.scope().textContent) && /Playing on this computer/.test(window.__t.scope().textContent)`, 5000);
    // My volume: a real click in the middle of the slider. It is this computer's, not the office's.
    await click(`window.__t.scope().querySelector('.radio-volume input[type=range]')`, 'volume slider');
    await waitFor(`Math.abs(window.__orchPrefs.getState().prefs.radioVolume - 0.5) < 0.1`, 8000);
    const mine = await js(`window.__orchPrefs.getState().prefs.radioVolume`);
    if ((await js(`window.__t.store().settings.radio.volume`)) !== officeVolume) throw new Error('my volume was written into the office\'s settings');
    await shot('hifi-playing');
    await clickText('✕');
    await waitFor(`!document.querySelector('.win')`, 5000);
    await waitFor(`!!document.querySelector('.radio-mini') && document.querySelector('.radio-mini').textContent.includes(${JSON.stringify(ctx.radioTitle)})`, 5000);
    // Next to the hi-fi it is as loud as my volume; at the far end of the office it is quiet, not silent.
    const was = await js(`({ x: window.__orchPlayer.x, z: window.__orchPlayer.z, rot: window.__orchPlayer.rot })`);
    const spots = await js(`window.__orchPlayer.spots || []`);
    const hifi = spots.find((s) => s.kind === 'hifi');
    if (!hifi) throw new Error('the office has no hi-fi to walk up to');
    const far = spots.filter((s) => s.kind !== 'hifi').sort((p, q) => Math.hypot(q.x - hifi.x, q.z - hifi.z) - Math.hypot(p.x - hifi.x, p.z - hifi.z))[0];
    await js(`window.__orchPlayer.goto = { x: ${hifi.x}, z: ${hifi.z}, rot: 0 }; true`);
    await waitFor(`(() => { const r = window.__orchRadio(); return r.loudness === 1 && Math.abs(r.volume - ${mine}) < 0.01; })()`, 8000);
    await js(`window.__orchPlayer.goto = { x: ${far.x}, z: ${far.z}, rot: 0 }; true`);
    await waitFor(`(() => { const r = window.__orchRadio(); return r.loudness < 0.6 && r.loudness >= 0.14 && Math.abs(r.volume - ${mine} * r.loudness) < 0.01; })()`, 8000);
    const heard = await js(`window.__orchRadio()`);
    if (!(heard.volume > 0.05) || heard.paused) throw new Error(`far from the hi-fi the music is gone: ${JSON.stringify(heard)}`);
    // Mute is for this computer only: the office's hi-fi stays on, this window stops playing its copy.
    await click(`document.querySelector('.radio-mini button[aria-label="Mute the hi-fi on this computer"]')`, 'Mute in the top bar');
    await waitFor(`window.__orchPrefs.getState().prefs.radioMuted === true && window.__orchRadio().loaded === null && !!window.__t.store().hifi && !!document.querySelector('.radio-mini')`, 5000);
    await click(`document.querySelector('.radio-mini button[aria-label="Unmute the hi-fi on this computer"]')`, 'Unmute in the top bar');
    await waitFor(`window.__orchPrefs.getState().prefs.radioMuted === false && window.__t.store().radio.status === 'playing'`, 15000);
    // The stop button says what it does, and does it for the office.
    await click(`document.querySelector('.radio-mini button[aria-label="Stop the hi-fi for everyone"]')`, 'the stop button in the top bar');
    await waitFor(`!window.__t.store().hifi && window.__t.store().radio.status === 'idle' && !document.querySelector('.radio-mini') && window.__orchRadio().loaded === null`, 5000);
    await js(`window.__orchPlayer.goto = { x: ${was.x}, z: ${was.z}, rot: ${was.rot} }; true`);
    return `stations before: ${builtIn}; "${ctx.radioName}" played "${ctx.radioTitle}" for the office; my volume ${mine} (the office's stays ${officeVolume}); at the ${far.kind} spot ${Math.hypot(far.x - hifi.x, far.z - hifi.z).toFixed(0)} m away it was heard at ${(heard.loudness * 100).toFixed(0)}%`;
  });

  await step('Machines: "A server over SSH" checks a server with the real ssh client and says plainly why it cannot connect', async () => {
    await open('hosts');
    await clickText('Add a machine');
    await clickText('A server over SSH');
    const server = `window.__t.scope().querySelector('input[aria-label="Server"]')`;
    await type(server, 'not a server; rm -rf /');
    if (!(await js(`window.__t.byText('Check the server') === null || window.__t.byText('Check the server').disabled`))) throw new Error('nonsense was accepted as a server');
    // Nothing listens for SSH on port 1 of this machine: the real client is refused at once.
    await type(server, 'nobody@127.0.0.1:1');
    await clickText('Check the server');
    await waitFor(`/refused the connection|did not answer/.test(window.__t.scope().textContent)`, 30000);
    const said = await js(`[...window.__t.scope().querySelectorAll('[data-ssh-form] .bad')].map((e) => e.textContent).join(' ')`);
    if (!said) throw new Error('why the server cannot be reached is not said in the form');
    if (await js(`!!window.__t.byText('Connect', 'button') && !window.__t.byText('Connect', 'button').disabled && window.__t.byText('Connect', 'button').textContent.trim() === 'Connect'`)) throw new Error('Connect is enabled for a server that could not be checked');
    await shot('ssh-link-form');
    await clickText('Cancel');
    await close();
    return said.slice(0, 110);
  });

  await step('waiting for a colleague: the one who waits says for whom, and the awaited one\'s card and Talk window say who is waiting', async () => {
    await close();
    await camera('CEO');
    // Two people of the shared office who are at their prompt and have nothing of their own scheduled.
    const pair = await js(`(() => {
      const st = window.__t.store();
      const busy = new Set(Object.values(st.routines || {}).map((r) => r.employeeId));
      const free = Object.values(st.employees).filter((e) => !e.archived && !e.paused && e.roleKey !== 'foreman' && !busy.has(e.id) && !(st.hosts[e.hostId || ''] || {}).memberId
        && Object.values(st.sessions).some((x) => x.employeeId === e.id && x.status === 'running' && x.inTurn === false && !x.waitingOn)
        && !Object.values(st.tasks).some((t) => t.assigneeId === e.id && ['IN_PROGRESS', 'ASSIGNED', 'REVIEW', 'BLOCKED'].includes(t.status))
        && !Object.values(st.questions).some((q) => q.employeeId === e.id && q.status === 'open'));
      for (const a of free) { const b = free.find((x) => x.id !== a.id && x.hostId === a.hostId); if (b) return { a: { id: a.id, name: a.name }, b: { id: b.id, name: b.name } }; }
      return null;
    })()`);
    if (!pair) throw new Error('no two free employees to try waiting with');
    const { a, b } = pair;
    const tell = (id, body) => js(`(async () => (await fetch('/api/employees/${id}/message', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ((window.orchestrator && window.orchestrator.token) || localStorage.getItem('orch.token') || '') }, body: JSON.stringify({ body: ${JSON.stringify(body)} }) })).status)()`);
    const sess = (id) => `Object.values(window.__t.store().sessions).find((x) => x.employeeId === ${JSON.stringify(id)} && x.status === 'running')`;
    // The colleague is in the middle of something, so the request cannot reach them for a while.
    await tell(b.id, 'A long job first. @@fake: sleep 12000; say colleague-free-4410@@');
    await waitFor(`(${sess(b.id)}).inTurn === true`, 15000);
    await tell(a.id, `Ask them. @@fake: mcp request_collaboration {"to":${JSON.stringify(b.name)},"summary":"Which port does the API use","wait":true}; say waiter-has-it-4410@@`);
    await waitFor(`(() => { const x = ${sess(a.id)}; return !!x && !!x.waitingOn && x.waitingOn.employeeId === ${JSON.stringify(b.id)}; })()`, 20000);
    const card = `(document.querySelector('.near-card') || { textContent: '' }).textContent`;
    // The one who waits: the card says WAITING and for whom.
    await js(`window.__t.store().selectEmployee(${JSON.stringify(a.id)})`);
    const theirs = `Waiting for ${b.name}'s answer`;
    await waitFor(`(${card}).includes(${JSON.stringify(theirs)})`, 8000);
    const badge = await js(`(document.querySelector('.near-card .badge') || { textContent: '' }).textContent.trim()`);
    if (!/waiting/i.test(badge)) throw new Error(`the card of the one who waits is labelled "${badge}"`);
    await sleep(250);
    await shot('waiting-card-waiter');
    // The awaited one: their card names who cannot go on.
    const line = `${a.name} is waiting for an answer from them`;
    await js(`window.__t.store().selectEmployee(${JSON.stringify(b.id)})`);
    await waitFor(`(${card}).includes(${JSON.stringify(line)})`, 8000);
    const clipped = await js(`(() => { const el = [...document.querySelectorAll('.near-card div')].find((d) => d.textContent === ${JSON.stringify(line)}); return !el || el.scrollWidth > el.clientWidth + 1; })()`);
    if (clipped) throw new Error('the line on the card is cut off');
    await sleep(250);
    await shot('waiting-card-awaited');
    // And so does the window in which the owner talks to them.
    await js(`window.__t.store().openPanel('talk', ${JSON.stringify(b.id)})`);
    await waitFor(`[...window.__t.scope().querySelectorAll('.talk-note')].some((n) => n.textContent.trim() === ${JSON.stringify(line)})`, 8000);
    await sleep(250);
    await shot('waiting-talk');
    // The colleague's turn ends, the request reaches them, they answer: nobody waits any more, and the lines go.
    await waitFor(`(() => { const x = ${sess(a.id)}; return !!x && !x.waitingOn; })()`, 45000);
    await waitFor(`![...window.__t.scope().querySelectorAll('.talk-note')].some((n) => n.textContent.trim() === ${JSON.stringify(line)})`, 8000);
    await close();
    await waitFor(`!(${card}).includes(${JSON.stringify(line)})`, 8000);
    await js(`window.__t.store().selectEmployee(null)`);
    return `${a.name} waited for ${b.name}; shown on both cards and in Talk, gone after the answer`;
  });

  await step('a command in the background: ⏳ COMMAND RUNNING over their head, the command on their card and in their profile, gone when it ends', async () => {
    await close();
    // Somebody on Auto (their Bash is not asked about) between turns, with nothing open.
    const candidate = `(() => {
      const st = window.__t.store();
      const e = Object.values(st.employees).find((e) => !e.archived && e.autonomy !== 'standard' && e.roleKey !== 'foreman' && e.roleKey !== 'lead'
        && Object.values(st.sessions).some((x) => x.employeeId === e.id && x.status === 'running' && x.inTurn === false && !x.waitingOn)
        && !Object.values(st.questions).some((q) => q.employeeId === e.id && q.status === 'open'));
      return e ? { id: e.id, name: e.name } : null;
    })()`;
    await waitFor(`!!${candidate}`, 30000).catch(() => undefined);
    const who = await js(candidate);
    if (!who) throw new Error('nobody on Auto between turns to run a command in the background');
    const tell = (id, body) => js(`(async () => (await fetch('/api/employees/${id}/message', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ((window.orchestrator && window.orchestrator.token) || localStorage.getItem('orch.token') || '') }, body: JSON.stringify({ body: ${JSON.stringify(body)} }) })).status)()`);
    const sess = `Object.values(window.__t.store().sessions).find((x) => x.employeeId === ${JSON.stringify(who.id)} && x.status === 'running')`;
    await tell(who.id, 'Run the suite. @@fake: bg sleep 16 => Run the full test suite; say The suite is running.@@');
    await waitFor(`(() => { const x = ${sess}; return !!x && x.activity === 'waiting_command'; })()`, 20000);
    // Over their head in the office: the state, and under it the command.
    if ((await js(`window.__t.store().cameraMode`)) !== 'command') {
      await camera('Command center');
      await sleep(3500);
    }
    const tag = `[...document.querySelectorAll('.tag')].find((t) => t.querySelector('.tag-name') && t.querySelector('.tag-name').textContent.trim().startsWith(${JSON.stringify(who.name)}))`;
    await waitFor(`!!(${tag}) && (${tag}).querySelector('.tag-state').textContent.trim() === '⏳ COMMAND RUNNING' && ((${tag}).querySelector('.tag-bg') || { textContent: '' }).textContent.includes('Run the full test suite')`, 10000);
    const looks = await js(`(() => { const t = ${tag}; const bg = t.querySelector('.tag-bg'); return { state: getComputedStyle(t.querySelector('.tag-state')).color, line: getComputedStyle(bg).color, inside: bg.getBoundingClientRect().right <= t.getBoundingClientRect().right + 0.5 }; })()`);
    if (looks.state !== 'rgb(127, 227, 214)' || looks.line !== 'rgb(127, 227, 214)') throw new Error(`the state and its line are not in the colour of a running command: ${JSON.stringify(looks)}`);
    if (!looks.inside) throw new Error('the line naming the command sticks out of the tag');
    await sleep(250);
    await shot('background-command-office');
    // On their card (the Command center view has its own list instead): the command once — the state's own detail
    // line is not repeated — with how long it has run.
    await camera('Management');
    await waitFor(`window.__t.store().cameraMode === 'management'`, 4000);
    await js(`window.__t.store().selectEmployee(${JSON.stringify(who.id)})`);
    await waitFor(`!!document.querySelector('.near-card [data-in-background]') && document.querySelector('.near-card [data-in-background]').textContent.includes('Run the full test suite')`, 8000);
    const times = await js(`[...document.querySelectorAll('.near-card *')].filter((d) => d.children.length === 0 && d.textContent.trim() === 'Run the full test suite').length`);
    if (times !== 1) throw new Error(`the command is on the card ${times} times`);
    await sleep(250);
    await shot('background-command-card');
    // In their profile, under the session.
    await open('employee', `${JSON.stringify(who.id)} + ':session'`);
    await waitFor(`!!window.__t.scope().querySelector('[data-in-background]') && window.__t.scope().querySelector('[data-in-background]').textContent.includes('Run the full test suite')`, 8000);
    await sleep(250);
    await shot('background-command-profile');
    // It ends: the state, the line and the rows go.
    await waitFor(`(() => { const x = ${sess}; return !!x && x.activity !== 'waiting_command' && !(x.background || []).length; })()`, 30000);
    await waitFor(`!window.__t.scope().querySelector('[data-in-background]')`, 8000);
    await close();
    await waitFor(`!(${tag}).querySelector('.tag-bg') && (${tag}).querySelector('.tag-state').textContent.trim() !== '⏳ COMMAND RUNNING'`, 8000);
    await waitFor(`!document.querySelector('.near-card [data-in-background]')`, 8000);
    await js(`window.__t.store().selectEmployee(null)`);
    return `${who.name}: shown over their head, on the card and in the profile; gone when it ended`;
  });

  await step('/goal in Talk: the goal stands over the conversation, over their head and in their profile, they keep at it, and Clear ends it', async () => {
    await close();
    const free = `(() => { const st = window.__t.store(); const e = Object.values(st.employees).find((e) => !e.archived && e.autonomy !== 'standard' && e.roleKey !== 'foreman' && e.roleKey !== 'lead' && Object.values(st.sessions).some((x) => x.employeeId === e.id && x.status === 'running' && x.inTurn === false && !x.waitingOn) && !Object.values(st.questions).some((q) => q.employeeId === e.id && q.status === 'open')); return e ? { id: e.id, name: e.name } : null; })()`;
    await waitFor(`!!${free}`, 30000).catch(() => undefined);
    const who = await js(free);
    if (!who) throw new Error('nobody on Auto between turns to give a goal to');
    const goal = `Object.values(window.__t.store().employees).find((e) => e.id === ${JSON.stringify(who.id)}).goal`;
    const messagesBefore = await js(`Object.values(window.__t.store().messages).filter((m) => m.toEmployeeId === ${JSON.stringify(who.id)} && m.from.kind === 'owner').length`);
    await js(`window.__t.store().openPanel('talk', ${JSON.stringify(who.id)})`);
    // A step every turn that never finishes it: they keep at it until the goal is cleared.
    await type(`window.__t.scope().querySelector('textarea')`, '/goal The notes are complete. @@fake: sleep 1200; bash echo note >> ui-goal-notes.txt@@');
    await clickText('Send');
    await waitFor(`(() => { const g = ${goal}; return !!g && g.status === 'active'; })()`, 8000);
    await waitFor(`!!window.__t.scope().querySelector('.goal-strip[data-goal="active"]') && window.__t.scope().querySelector('.goal-strip').textContent.includes('The notes are complete.')`, 8000);
    // (The strip can come with the office's update a moment before the box is emptied: the answer to the request.)
    if (!(await waitFor(`window.__t.scope().querySelector('textarea').value === ''`, 4000).then(() => true, () => false))) throw new Error('the box still holds the /goal line');
    const sent = await js(`Object.values(window.__t.store().messages).filter((m) => m.toEmployeeId === ${JSON.stringify(who.id)} && m.from.kind === 'owner').length`);
    if (sent !== messagesBefore) throw new Error('/goal went to them as a message of mine as well');
    // Sent on: the count of turns goes up while nobody types anything.
    await waitFor(`(${goal}).turns >= 2`, 30000);
    await sleep(300);
    await shot('goal-talk');
    // Over their head.
    await close();
    await camera('Management');
    const tag = `[...document.querySelectorAll('.tag')].find((t) => t.querySelector('.tag-name') && t.querySelector('.tag-name').textContent.trim().startsWith(${JSON.stringify(who.name)}))`;
    await waitFor(`!!(${tag}) && ((${tag}).querySelector('.tag-goal') || { textContent: '' }).textContent.includes('The notes are complete')`, 10000);
    // In their profile, and cleared from there.
    await open('employee', JSON.stringify(who.id));
    await waitFor(`!!window.__t.scope().querySelector('[data-profile-goal]') && window.__t.scope().querySelector('[data-profile-goal]').textContent.includes('Goal: The notes are complete.')`, 8000);
    await sleep(300);
    await shot('goal-profile');
    await click(`[...window.__t.scope().querySelectorAll('[data-profile-goal] button')].find((b) => b.textContent.trim() === 'Clear')`, 'Clear');
    await waitFor(`(${goal}).status === 'stopped'`, 8000);
    const turns = await js(`(${goal}).turns`);
    await close();
    await waitFor(`!(${tag}).querySelector('.tag-goal')`, 8000);
    // Nothing sends them on any more.
    await sleep(4000);
    if ((await js(`(${goal}).turns`)) !== turns) throw new Error('they were sent on after the goal was cleared');
    return `${who.name}: sent on ${turns} times, shown in Talk, over their head and in the profile; cleared from the profile`;
  });

  await step('Access: the address people come to, an invitation as a short link, the member listed as invited, and access taken away', async () => {
    await close();
    const port = await new Promise((resolve) => { const srv = require('node:net').createServer(); srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); }); });
    const post = (p, body) => js(`(async () => { const r = await fetch('/api${p}', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ((window.orchestrator && window.orchestrator.token) || localStorage.getItem('orch.token') || '') }, body: JSON.stringify(${JSON.stringify(body)}) }); return { status: r.status, body: await r.json() }; })()`);
    // The door's port is the server's business (a free one here); everything else is done in the window.
    const closed = await post('/sharing', { open: false, port, address: '' });
    if (closed.status !== 200) throw new Error(`setting the door's port: ${JSON.stringify(closed).slice(0, 200)}`);
    await js(`window.__t.store().openPanel('people')`);
    await waitFor(`!!window.__t.scope().querySelector('.win-titles') && /^Access/.test(window.__t.scope().querySelector('.win-titles').textContent.trim())`, 8000);
    await waitFor(`/The office is closed/.test(window.__t.scope().textContent)`, 8000);
    const text0 = await js(`window.__t.scope().textContent`);
    if (/Say something|Talk to the people here|Reachable at/.test(text0) || (await js(`!!window.__t.scope().querySelector('input[placeholder^="Say"]')`))) throw new Error('the chat or the list of addresses is still in the window');
    if (await js(`!!window.__t.scope().querySelector('input[aria-label="Their name"]')`)) throw new Error('inviting is offered while the office is closed');
    await sleep(250);
    await shot('access-closed');
    await clickText('Open');
    await waitFor(`/The office is open to the people you invite/.test(window.__t.scope().textContent)`, 20000);
    // No address yet: this computer's own are offered, and inviting waits for one.
    await waitFor(`/No address of your own\?/.test(window.__t.scope().textContent)`, 8000);
    const why = await js(`(() => { const b = [...window.__t.scope().querySelectorAll('button[type=submit]')].find((x) => x.textContent.trim() === 'Invite'); return b.disabled && /Save the address people come to first/.test(window.__t.scope().textContent); })()`);
    if (!why) throw new Error('without an address, Invite is not held back with a reason in view');
    await type(`window.__t.field('Address people come to')`, 'https://office.example.test');
    await clickText('Save');
    await waitFor(`!/No address of your own\?/.test(window.__t.scope().textContent)`, 8000);
    await type(`window.__t.scope().querySelector('input[aria-label="Their name"]')`, 'Lena');
    await click(`window.__t.submit('Invite')`, 'Invite');
    await waitFor(`!!window.__t.scope().querySelector('.access-made input')`, 8000);
    const link = await js(`window.__t.scope().querySelector('.access-made input').value`);
    if (!/^https:\/\/office\.example\.test\/join\/[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/.test(link)) throw new Error(`the invitation is not a short link: ${link.slice(0, 120)}`);
    const said = await js(`window.__t.scope().querySelector('.access-made').textContent`);
    if (!/Send this link to Lena\..*Connect to an office.*It works once, until /.test(said)) throw new Error(`what is said about the link: ${said.slice(0, 200)}`);
    const row = `window.__t.scope().querySelector('[data-member="Lena"]')`;
    await waitFor(`!!(${row}) && /invited · the link works until/.test((${row}).textContent)`, 8000);
    await sleep(250);
    await shot('access');
    await click(`[...(${row}).querySelectorAll('button')].find((b) => b.textContent.trim() === 'Revoke…')`, 'Revoke… in the row of Lena');
    await waitFor(`!(${row})`, 8000);
    const asked = await js(`(window.__confirms || []).slice(-1)[0] || ''`);
    if (!/Take away Lena's access\?/.test(asked)) throw new Error(`revoking asked: "${asked.slice(0, 120)}"`);
    await clickText('Close');
    await waitFor(`/The office is closed/.test(window.__t.scope().textContent)`, 10000);
    await close();
    return link;
  });

  await step('Projects: an owner deletes a project after being told what goes and what stays', async () => {
    await close();
    const made = await js(`(async () => { const r = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ((window.orchestrator && window.orchestrator.token) || localStorage.getItem('orch.token') || '') }, body: JSON.stringify({ name: 'Made By Mistake' }) }); return { status: r.status, body: await r.json() }; })()`);
    if (made.status !== 200) throw new Error(`making a project to delete: ${JSON.stringify(made).slice(0, 200)}`);
    const there = `Object.values(window.__t.store().projects).some((p) => p.name === 'Made By Mistake')`;
    await waitFor(there, 8000);
    await js(`window.__t.store().openPanel('projects', ${JSON.stringify(made.body.id)})`);
    await waitFor(`!!window.__t.byText('Delete project…')`, 8000);
    await sleep(250);
    await shot('project-delete');
    await js(`window.__confirms = []; true`);
    await clickText('Delete project…');
    await waitFor(`!(${there})`, 8000);
    const asked = await js(`(window.__confirms || []).slice(-1)[0] || ''`);
    if (!/Delete Made By Mistake\?/.test(asked) || !/It has no tasks\./.test(asked) || !/Nothing on disk is touched/.test(asked) || !/cannot be undone/.test(asked)) throw new Error(`deleting asked: "${asked.replace(/\s+/g, ' ').slice(0, 240)}"`);
    // The window shows another project, not an empty form; the deleted one is not in the list.
    await waitFor(`![...window.__t.scope().querySelectorAll('button.pw-list-btn')].some((b) => b.textContent.includes('Made By Mistake'))`, 5000);
    if (await js(`!!window.__t.field('Name')`)) throw new Error('after deleting, the window shows the new-project form instead of another project');
    await close();
    return asked.replace(/\s+/g, ' ');
  });

  await step('Vault: a credential is added through the window, listed by name without its value, shown to the owner on request, and removed', async () => {
    await close();
    await js(`window.__t.store().openPanel('vault')`);
    await waitFor(`!!window.__t.scope().querySelector('.win-titles') && /^Vault/.test(window.__t.scope().querySelector('.win-titles').textContent.trim())`, 8000);
    await waitFor(`!!window.__t.byText('Add a credential')`, 8000);
    const secret = 'Ui-Suite-S3cret!42';
    await clickText('Add a credential');
    await type(`window.__t.field('What it opens')`, 'registry.example.test');
    await type(`window.__t.field('Login (if it has one)')`, 'ci');
    await type(`window.__t.scope().querySelector('input[aria-label="The value"]')`, secret);
    await type(`window.__t.field('Note (optional)')`, 'Pulls images in the pipeline');
    await sleep(250);
    await shot('vault-add');
    await click(`window.__t.submit('Put it in the vault')`, 'Put it in the vault');
    const row = `window.__t.scope().querySelector('[data-vault="example-ci-password"]')`;
    await waitFor(`!!(${row})`, 8000);
    const text = await js(`(${row}).textContent`);
    if (!/example-ci-password/.test(text) || !/Password/.test(text) || !/registry\.example\.test · login ci/.test(text) || !/Pulls images in the pipeline/.test(text) || !/added by .* · not used yet · 18 characters/.test(text)) throw new Error(`the row reads: ${text.slice(0, 260)}`);
    if ((await js(`document.body.innerHTML.includes(${JSON.stringify(secret)})`)) || (await js(`JSON.stringify(window.__t.store()).includes(${JSON.stringify(secret)})`))) throw new Error('the value is in the page or in the office state without having been asked for');
    // An owner asks to see it: the value appears, and can be put away again.
    await click(`[...(${row}).querySelectorAll('button')].find((b) => b.textContent.trim() === 'Show')`, 'Show');
    await waitFor(`(() => { const t = (${row}).querySelector('textarea'); return !!t && t.value === ${JSON.stringify(secret)}; })()`, 8000);
    await sleep(250);
    await shot('vault');
    await click(`[...(${row}).querySelectorAll('button')].find((b) => b.textContent.trim() === 'Hide')`, 'Hide');
    await waitFor(`!(${row}).querySelector('textarea')`, 5000);
    await js(`window.__confirms = []; true`);
    await click(`[...(${row}).querySelectorAll('button')].find((b) => b.textContent.trim() === 'Remove…')`, 'Remove…');
    await waitFor(`!(${row})`, 8000);
    const asked = await js(`(window.__confirms || []).slice(-1)[0] || ''`);
    if (!/Remove example-ci-password from the vault\?/.test(asked) || !/cannot be brought back/.test(asked)) throw new Error(`removing asked: "${asked.replace(/\s+/g, ' ').slice(0, 200)}"`);
    await close();
    return 'example-ci-password: added, listed without its value, shown, hidden, removed';
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
    await camera('CEO');
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

  await step("an employee's own Telegram bot: three steps, the token, Connect — a code to scan; a phone and a group come in, and the group is set to everything", async () => {
    const quinn = await js(`window.__t.emp(${JSON.stringify(ctx.hireName)}).id`);
    await js(`window.__t.store().openPanel('employee', ${JSON.stringify(quinn + ':telegram')})`);
    await waitFor(`!!window.__t.scope().querySelector('[data-telegram="setup"]')`, 8000);
    const steps = await js(`window.__t.scope().querySelectorAll('.tg-steps > li').length`);
    if (steps !== 3) throw new Error(`${steps} set-up steps, not 3`);
    // A token of the wrong shape is refused in words.
    await type(`window.__t.scope().querySelector('[data-telegram-token]')`, '12345:short');
    await clickText('Connect');
    await waitFor(`!!window.__t.scope().querySelector('.tg-error')`, 5000);
    await shot('telegram-setup');
    await type(`window.__t.scope().querySelector('[data-telegram-token]')`, ctx.telegramToken);
    await clickText('Connect');
    await waitFor(`!!window.__t.scope().querySelector('[data-telegram="connected"] [data-telegram-link="phone"] svg.tg-qr path')`, 10000);
    const link = await js(`window.__t.scope().querySelector('[data-telegram-link] a').getAttribute('href')`);
    if (!/^https:\/\/t\.me\/ui_suite_bot\?start=/.test(link)) throw new Error(`the link is ${link}`);
    if (await js(`document.body.innerHTML.includes(${JSON.stringify(ctx.telegramToken)})`)) throw new Error('the token is still on the page');
    await shot('telegram-code');
    // The phone opens it: the person is listed and the code is put away by itself.
    fs.writeFileSync(path.join(outDir, 'telegram-phone.txt'), link);
    await waitFor(`!!window.__t.scope().querySelector('[data-telegram-person="ana_tests"]') && !window.__t.scope().querySelector('[data-telegram-link]')`, 15000);
    // A group: its link, used; then "Everything".
    await click(`window.__t.scope().querySelector('[data-telegram-group]')`, 'Add to a group');
    await waitFor(`!!window.__t.scope().querySelector('[data-telegram-link="group"] svg.tg-qr')`, 5000);
    fs.writeFileSync(path.join(outDir, 'telegram-group.txt'), await js(`window.__t.scope().querySelector('[data-telegram-link] a').getAttribute('href')`));
    await waitFor(`!!window.__t.scope().querySelector('[data-telegram-chat="Launch team"]') && !window.__t.scope().querySelector('[data-telegram-link]')`, 15000);
    await click(`window.__t.scope().querySelector('[data-telegram-chat="Launch team"] [data-telegram-mode="all"]')`, 'Everything');
    await waitFor(`window.__t.scope().querySelector('[data-telegram-chat="Launch team"] [data-telegram-mode="all"]').getAttribute('aria-pressed') === 'true'`, 5000);
    if (!(await js(`!!window.__t.scope().querySelector('[data-telegram-privacy]')`))) throw new Error('no word about the privacy mode');
    await shot('telegram-connected');
    // Back on "When talked to"; somebody in the group asks them by name — and Talk shows it as the group's, with the answer said to have gone there.
    await click(`window.__t.scope().querySelector('[data-telegram-chat="Launch team"] [data-telegram-mode="addressed"]')`, 'When talked to');
    await waitFor(`window.__t.scope().querySelector('[data-telegram-chat="Launch team"] [data-telegram-mode="addressed"]').getAttribute('aria-pressed') === 'true'`, 5000);
    fs.writeFileSync(path.join(outDir, 'telegram-say.txt'), `${ctx.hireName}, can you check the docs? @@fake: say [reply #1] the notes are in docs/GUIDE.md@@`);
    await js(`window.__t.store().openPanel('talk', ${JSON.stringify(quinn)})`);
    await waitFor(`!!document.querySelector('[data-talk-group="Launch team"]') && [...document.querySelectorAll('.talk-meta')].some((m) => /sent to Telegram · Launch team/.test(m.textContent))`, 40000);
    const shown = await js(`document.querySelector('[data-talk-group="Launch team"] .pre').textContent`);
    if (/Earlier in the chat|On Telegram|release notes/.test(shown) || !/^Dana: Quinn, can you check the docs\?/.test(shown)) throw new Error(`Talk shows the prompt, not what was said: ${shown}`);
    if (await js(`[...document.querySelectorAll('.talk-them')].some((b) => /\\[reply #/.test(b.textContent))`)) throw new Error('the reply mark is shown in Talk');
    await shot('telegram-in-talk');
    await js(`window.__t.store().openPanel(null)`);
    return `${link.replace(/start=.*/, 'start=…')}; Ana paired; "Launch team" on Everything and back; in Talk: ${shown.replace(/\n/g, ' / ')}`;
  });

  await step('Rent: the owner makes a client in Access → Rent; the client sets a password with the link and talks to the employee on the portal — computer and phone — and the owner reads it there, not in Talk', async () => {
    const quinn = await js(`window.__t.emp(${JSON.stringify(ctx.hireName)}).id`);
    // The address people come to: the link starts with it.
    await js(`fetch('/api/sharing', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + localStorage.getItem('orch.token') }, body: JSON.stringify({ address: 'https://office.example.test' }) }).then((r) => r.ok)`);
    await js(`window.__t.store().openPanel('people', 'rent')`);
    await waitFor(`!!window.__t.scope().querySelector('[data-rent-tab]')`, 8000);
    await click(`window.__t.scope().querySelector('[data-rent-open-new]')`, 'New client');
    await waitFor(`!!window.__t.scope().querySelector('[data-rent-new]')`, 4000);
    await type(`window.__t.scope().querySelector('[data-rent-new] input[aria-label="Their name"]')`, 'Ana Client');
    await type(`window.__t.scope().querySelector('[data-rent-new] input[aria-label="Company"]')`, 'Acme');
    await click(`window.__t.scope().querySelector('[data-rent-new] .k-many-add')`, 'Add an employee');
    await waitFor(`!!document.querySelector('.k-pop [data-pick-option="${quinn}"]')`, 4000);
    await click(`document.querySelector('.k-pop [data-pick-option="${quinn}"]')`, ctx.hireName);
    await key('Escape');
    await shot('rent-new-client');
    await click(`window.__t.scope().querySelector('[data-rent-create]')`, 'Make the client and a link');
    await waitFor(`!!window.__t.scope().querySelector('[data-rent-link="Ana Client"] .k-code')`, 8000);
    const link = await js(`window.__t.scope().querySelector('[data-rent-link] .k-code').firstChild.textContent.trim()`);
    if (!/\/r\/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(link)) throw new Error(`the link: ${link}`);
    await shot('rent-access');
    // The client, in a browser of their own.
    const origin = new URL(win.webContents.getURL()).origin;
    const guest = new BrowserWindow({ width: 1280, height: 820, show: false, webPreferences: { backgroundThrottling: false, partition: 'rent-client' } });
    const gjs = (code) => guest.webContents.executeJavaScript(code, true);
    const gwait = async (code, timeout = 15000) => {
      for (const end = Date.now() + timeout; Date.now() < end; await sleep(150)) {
        const v = await gjs(`(() => { try { return (${code}); } catch (e) { return null; } })()`).catch(() => null);
        if (v) return v;
      }
      throw new Error(`the client's browser: timed out waiting for ${String(code).slice(0, 140)}`);
    };
    const gset = (sel, value) => gjs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const gshot = async (name) => fs.writeFileSync(path.join(outDir, `${name}.png`), (await guest.webContents.capturePage()).toPNG());
    let shown = '';
    try {
      await guest.loadURL(`${origin}/r/${link.split('/r/')[1]}`);
      await gwait(`!!document.querySelector('[data-rent-password]') && /Welcome, Ana/.test(document.body.textContent)`);
      // The team on their feet, in 3D, once the figures are loaded.
      await gwait(`!!document.querySelector('.rp-team-canvas canvas')`, 20000);
      await sleep(1500);
      await gset('[data-rent-password]', 'a good password 42');
      await gset('[data-rent-password-again]', 'a good password 42');
      await gshot('rent-portal-join');
      await gjs(`document.querySelector('[data-rent-join]').click()`);
      await gwait(`!!document.querySelector('[data-rent-box]') && location.pathname === '/rent'`, 15000);
      await gshot('rent-portal-hello');
      await gset('[data-rent-box]', 'Hi Quinn, can you check the docs folder for me? @@fake: sleep 1200; say Sure, Ana. **Found two guides** in the docs folder:\n\n- GUIDE.md — the steps\n- README.md — the overview\n\nWant me to summarise them?@@');
      await gjs(`document.querySelector('[data-rent-send]').click()`);
      await gwait(`!!document.querySelector('[data-rent-typing]')`, 10000);
      await gwait(`[...document.querySelectorAll('[data-rent-line="agent"]')].some((b) => /Found two guides/.test(b.textContent))`, 40000);
      // The desk in 3D beside the conversation; a click on the employee is a hello.
      await gwait(`!!document.querySelector('[data-rent-stage] canvas')`, 20000);
      await gjs(`document.querySelector('.rp-stage-canvas').click()`);
      await gwait(`/Hi Ana/.test(document.querySelector('.rp-stage-bubble')?.textContent || '')`, 5000);
      await sleep(900);
      shown = await gjs(`document.querySelector('[data-rent-line="agent"] .rp-md').textContent.slice(0, 60)`);
      await gshot('rent-portal');
      // A phone: the conversation alone, and the team behind its back button.
      guest.setSize(390, 844);
      await sleep(400);
      await gwait(`getComputedStyle(document.querySelector('.rp-side')).display !== 'none' && document.documentElement.scrollWidth <= 390 && document.querySelector('.rp-agent').getBoundingClientRect().right <= 390`);
      await gshot('rent-portal-phone-team');
      await gjs(`document.querySelector('[data-rent-agent="${ctx.hireName}"]').click()`);
      await gwait(`getComputedStyle(document.querySelector('.rp-side')).display === 'none' && !!document.querySelector('[data-rent-box]') && document.querySelector('.rp-box').getBoundingClientRect().right <= 390`);
      await sleep(300);
      await gshot('rent-portal-phone');
      if (!(await gjs(`[...document.querySelectorAll('[data-rent-line="client"] .rp-tick')].some((t) => /Seen/.test(t.textContent))`))) throw new Error('the line the employee answered is not shown as seen');
    } finally {
      guest.destroy();
    }
    // The owner reads it in Access → Rent …
    await click(`window.__t.scope().querySelector('[data-rent-read="${ctx.hireName}"]')`, 'Conversation');
    await waitFor(`/Found two guides/.test(window.__t.scope().querySelector('[data-rent-convo]')?.textContent || '')`, 8000);
    await shot('rent-access-conversation');
    // … and not in their own conversation with the employee.
    await js(`window.__t.store().openPanel('talk', ${JSON.stringify(quinn)})`);
    await waitFor(`!!window.__t.scope().querySelector('.talk-compose')`, 5000);
    await sleep(500);
    if (await js(`/check the docs folder|Found two guides/.test(window.__t.scope().textContent)`)) throw new Error("the client's conversation is in the owner's Talk");
    // The rental ends: Quinn is the office's again for whatever comes next.
    await js(`window.__orchConfirm = () => true; true`);
    await js(`window.__t.store().openPanel('people', 'rent')`);
    await waitFor(`!!window.__t.scope().querySelector('[data-rent-client="Ana Client"] .k-row-click')`, 6000);
    if (!(await js(`!!window.__t.scope().querySelector('[data-rent-end]')`))) await click(`window.__t.scope().querySelector('[data-rent-client="Ana Client"] .k-row-click')`, 'Ana Client');
    await waitFor(`!!window.__t.scope().querySelector('[data-rent-end]')`, 6000);
    await click(`window.__t.scope().querySelector('[data-rent-end]')`, 'End the rental');
    await waitFor(`!window.__t.scope().querySelector('[data-rent-client="Ana Client"]')`, 8000);
    await js(`delete window.__orchConfirm; window.__t.store().openPanel(null); true`);
    return `link ${link.replace(/\/r\/.*/, '/r/…')}; the client's answer: "${shown}"`;
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
    // The page at its own size: a zoom somebody left on this address in this profile (it is kept per address) would
    // put every click somewhere else.
    win.webContents.setZoomFactor(1);
    await js(HELPERS);
    win.webContents.focus();
    await scenario();
  } catch (e) {
    fatal = e.message;
  }
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ results, pageErrors: [...new Set(pageErrors)], pageWarnings: [...new Set(pageWarnings)].slice(0, 20), fatal }, null, 2));
  app.quit();
});
