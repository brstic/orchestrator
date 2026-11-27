#!/usr/bin/env node
/**
 * Replace the desktop app on this Mac with the build that waits in `release-next/` — closing the running app first
 * and opening the new one after. For the owner's own Mac, where the app runs from `release/Orchestrator.app`.
 *
 *   node scripts/package.mjs --out release-next && node scripts/smoke-package.mjs --out release-next
 *   node scripts/update-mac-app.mjs            # close → swap → open (only if it was running)
 *   node scripts/update-mac-app.mjs --no-open  # close → swap
 *
 * The app is closed the way a person closes it, never killed: first by the signal a build since 2026-11-12 answers
 * without asking (SIGUSR2, see `apps/desktop/electron/main.cjs`), then — for an older build — by asking it to quit,
 * which puts its "Leave this office?" question on the screen for the person to answer. If it is still running after
 * that, nothing is replaced. The build that was in `release/` is kept as `release-next/Orchestrator.app.previous-HHMM`.
 * Employees' sessions keep running in tmux through all of it; the Mac is back in the office when the app is.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const current = path.join(root, 'release', 'Orchestrator.app');
const next = path.join(root, 'release-next', 'Orchestrator.app');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (line) => console.log(line);

/** The main process of the app that runs from `release/` (its helpers have the same path and other arguments). */
function running() {
  const out = spawnSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).stdout ?? '';
  const main = `${current}/Contents/MacOS/`;
  return out
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m) => m && m[2].startsWith(main) && !/--type=/.test(m[2]))
    .map((m) => Number(m[1]));
}
async function gone(ms) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (!running().length) return true;
    await sleep(400);
  }
  return !running().length;
}

if (process.platform !== 'darwin') throw new Error('this replaces the macOS app; on other systems unpack the new bundle over the old one');
if (!fs.existsSync(path.join(next, 'Contents', 'MacOS'))) throw new Error(`no build waits in ${next} — package one first: node scripts/package.mjs --out release-next`);

let pids = running();
// (Opened again only if it was running: an app the owner had closed stays closed — their word of 2026-11-27.)
const wasRunning = pids.length > 0;
if (pids.length) {
  say(`The app is running (pid ${pids.join(', ')}): closing it.`);
  for (const pid of pids) process.kill(pid, 'SIGUSR2');
  if (!(await gone(12_000))) {
    // A build from before the signal: ask it to quit, which shows its own question.
    say('It did not close by itself (a build from before 2026-11-12). Asking it to quit: answer "Leave" in the app.');
    spawnSync('osascript', ['-e', 'tell application id "local.orchestrator.desktop" to quit'], { stdio: 'ignore', timeout: 5000 });
    // Its question is answered for the person where this terminal is allowed to (macOS: Accessibility); where it is
    // not, the attempt does nothing and the question waits for them.
    await sleep(1500);
    for (const name of ['Orchestrator', 'Electron']) {
      for (const where of ['sheet 1 of window 1', 'window 1']) spawnSync('osascript', ['-e', `tell application "System Events" to tell process "${name}" to click button "Leave" of ${where}`], { stdio: 'ignore', timeout: 4000 });
    }
    if (!(await gone(90_000))) {
      say('The app is still running, so nothing was replaced. Close it (Leave), then run this again.');
      process.exit(2);
    }
  }
  // (Its helpers and the agent it started for this computer end with it; give them a moment.)
  await sleep(1500);
}
if (running().length) throw new Error('the app started again while it was being replaced; nothing was changed');

const stamp = new Date().toISOString().slice(11, 16).replace(':', '');
// (The time of day repeats from one day to the next: a copy kept at the same minute yesterday is not overwritten.)
let kept = path.join(root, 'release-next', `Orchestrator.app.previous-${stamp}`);
for (let n = 2; fs.existsSync(kept); n++) kept = path.join(root, 'release-next', `Orchestrator.app.previous-${stamp}-${n}`);
if (fs.existsSync(current)) fs.renameSync(current, kept);
fs.renameSync(next, current);
// macOS keeps an app's icon in its caches: tell it this one is new, so that Finder and the Dock show its own icon.
const now = new Date();
fs.utimesSync(current, now, now);
spawnSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', current], { stdio: 'ignore' });
say(`Replaced. The build that was there is kept as ${path.relative(root, kept)}.`);
if (!process.argv.includes('--no-open') && wasRunning) {
  execFileSync('open', [current]);
  say('The new app is open.');
} else if (!wasRunning) {
  say('The new app is in place; it was not running, so it was left closed.');
}
