#!/usr/bin/env node
/**
 * Builds the distributable packages:  pnpm package
 *
 *   release/orchestrator-<version>.tar.gz
 *       Portable install for macOS and Linux: the bundled server, the bundled host
 *       agent, the built office UI and launchers. Needs Node.js 22.18+, tmux, git
 *       and the claude CLI on the machine. Unpack it anywhere and run bin/orchestrator.
 *
 *   release/Orchestrator.app  and  release/Orchestrator-<version>-<arch>.dmg   (macOS only)
 *       The desktop app: the Electron shell with the same files inside. It starts
 *       the server and this machine's agent itself. The app is ad-hoc signed, not
 *       notarized: the first launch needs right-click → Open (or it has to be signed
 *       with your own Developer ID).
 *
 *   --skip-build   reuse the existing bundles and UI build
 *   --no-app       only the tarball
 *   --no-dmg       the .app but no disk image
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const release = path.join(root, 'release');
const name = `orchestrator-${version}`;
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', cwd: root, ...opts });
const size = (p) => `${(fs.statSync(p).size / 1024 / 1024).toFixed(1)} MB`;

if (!args.has('--skip-build')) {
  run(process.execPath, ['scripts/build.mjs']);
  run('pnpm', ['build:ui']);
}
const need = ['apps/server/dist/orchestrator-server.mjs', 'apps/host-agent/dist/orchestrator-agent.mjs', 'apps/desktop/dist/index.html'];
for (const f of need) if (!fs.existsSync(path.join(root, f))) throw new Error(`${f} is missing — run without --skip-build`);

/**
 * The payload mirrors the repository layout, so the launcher, the server (which
 * serves the UI and the agent download) and the desktop shell find each other
 * the same way they do in a checkout.
 */
function stagePayload(dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  const copy = (from, to = from) => fs.cpSync(path.join(root, from), path.join(dest, to), { recursive: true });
  copy('apps/server/dist/orchestrator-server.mjs');
  copy('apps/host-agent/dist/orchestrator-agent.mjs');
  copy('apps/desktop/dist');
  copy('scripts/start-local.mjs');
  copy('README.md');
  copy('docs');
  copy('examples');
  fs.writeFileSync(path.join(dest, 'VERSION'), `${version}\n`);
}

// ───────────── portable tarball ─────────────
fs.mkdirSync(release, { recursive: true });
const stage = path.join(release, name);
stagePayload(stage);
fs.mkdirSync(path.join(stage, 'bin'));
const launcher = (target, argv = '') => `#!/bin/sh
# Orchestrator ${version}
set -e
SELF="$0"
while [ -L "$SELF" ]; do
  LINK="$(readlink "$SELF")"
  case "$LINK" in /*) SELF="$LINK" ;; *) SELF="$(dirname "$SELF")/$LINK" ;; esac
done
HERE="$(cd "$(dirname "$SELF")/.." && pwd -P)"
NODE="\${ORCH_NODE:-node}"
if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "Orchestrator needs Node.js 22.18 or newer (set ORCH_NODE to its path if it is not on PATH)." >&2
  exit 1
fi
exec "$NODE" --disable-warning=ExperimentalWarning "$HERE/${target}" ${argv}"$@"
`;
for (const [bin, target] of [
  ['orchestrator', 'scripts/start-local.mjs'],
  ['orchestrator-server', 'apps/server/dist/orchestrator-server.mjs'],
  ['orchestrator-agent', 'apps/host-agent/dist/orchestrator-agent.mjs'],
]) {
  fs.writeFileSync(path.join(stage, 'bin', bin), launcher(target), { mode: 0o755 });
}
fs.writeFileSync(
  path.join(stage, 'INSTALL.txt'),
  `Orchestrator ${version} — portable package

Requirements on this machine: Node.js 22.18+, tmux, git, and the claude CLI (Claude Code), signed in.

  Local office (server + this machine's agent, localhost only):
      bin/orchestrator --open

  Only the control server (e.g. on a VPS; see docs/INSTALL.md for TLS):
      bin/orchestrator-server --help

  Only the host agent (a machine that joins an office running elsewhere):
      bin/orchestrator-agent login --server https://office.example --token <enrollment-token>
      bin/orchestrator-agent connect

You can symlink the files in bin/ into a directory on your PATH.
State lives in ~/.orchestrator (override with ORCH_SERVER_HOME / ORCH_AGENT_HOME).
`,
);
const tarball = path.join(release, `${name}.tar.gz`);
fs.rmSync(tarball, { force: true });
run('tar', ['--no-xattrs', '-czf', tarball, '-C', release, name], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
console.log(`\n${path.relative(root, tarball)}  ${size(tarball)}`);

// ───────────── Debian/Ubuntu package (--deb, also part of --linux) ─────────────
// The portable package as a .deb: files under /opt/orchestrator, commands in /usr/bin. Architecture
// "all" (it is JavaScript and shell). Node.js 22.18+ is not in the Debian/Ubuntu archives yet, so it
// is a recommendation, and the launchers say so if it is missing.
if (args.has('--deb') || args.has('--linux')) {
  const build = path.join(release, 'deb-build');
  fs.rmSync(build, { recursive: true, force: true });
  const data = path.join(build, 'data');
  const opt = path.join(data, 'opt', 'orchestrator');
  stagePayload(opt);
  fs.cpSync(path.join(stage, 'bin'), path.join(opt, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(data, 'usr', 'bin'), { recursive: true });
  for (const bin of ['orchestrator', 'orchestrator-server', 'orchestrator-agent']) fs.symlinkSync(`/opt/orchestrator/bin/${bin}`, path.join(data, 'usr', 'bin', bin));
  const kb = Math.ceil(Number(execFileSync('du', ['-sk', data], { encoding: 'utf8' }).split('\t')[0]));
  const control = path.join(build, 'control');
  fs.mkdirSync(control);
  fs.writeFileSync(
    path.join(control, 'control'),
    `Package: orchestrator
Version: ${version}
Section: devel
Priority: optional
Architecture: all
Depends: tmux, git, curl
Recommends: nodejs (>= 22.18)
Installed-Size: ${kb}
Maintainer: Orchestrator <root@localhost>
Description: A virtual office where real Claude Code sessions work as employees
 The Orchestrator control server, the host agent and the office UI.
 Run "orchestrator --open" for a local office, "orchestrator-agent" to join
 a machine to an office running elsewhere. Needs Node.js 22.18 or newer and
 the Claude Code CLI.
`,
  );
  // Files in a package belong to root, whoever built it.
  const owner = process.platform === 'darwin' ? ['--no-xattrs', '--uid', '0', '--gid', '0', '--uname', 'root', '--gname', 'root'] : ['--owner=0', '--group=0', '--numeric-owner'];
  const tarEnv = { env: { ...process.env, COPYFILE_DISABLE: '1' } };
  run('tar', [...owner, '-czf', path.join(build, 'data.tar.gz'), '-C', data, '.'], tarEnv);
  run('tar', [...owner, '-czf', path.join(build, 'control.tar.gz'), '-C', control, '.'], tarEnv);
  fs.writeFileSync(path.join(build, 'debian-binary'), '2.0\n');
  const deb = path.join(release, `orchestrator_${version}_all.deb`);
  fs.rmSync(deb, { force: true });
  // A .deb is an `ar` archive of exactly these three members in this order. Written directly:
  // the format is 60-byte text headers, and macOS's own ar produces a variant dpkg rejects.
  const members = ['debian-binary', 'control.tar.gz', 'data.tar.gz'].map((name) => {
    const body = fs.readFileSync(path.join(build, name));
    const header = Buffer.from(`${name.padEnd(16)}${String(Math.floor(Date.now() / 1000)).padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(body.length).padEnd(10)}\`\n`, 'ascii');
    return Buffer.concat([header, body, body.length % 2 ? Buffer.from('\n') : Buffer.alloc(0)]);
  });
  fs.writeFileSync(deb, Buffer.concat([Buffer.from('!<arch>\n', 'ascii'), ...members]));
  fs.rmSync(build, { recursive: true, force: true });
  console.log(`${path.relative(root, deb)}  ${size(deb)}`);
}

// ───────────── Linux desktop bundle (--linux) ─────────────
// The same Electron version the macOS app uses, downloaded from Electron's release page and
// checked against its published SHA-256 before anything is unpacked.
if (args.has('--linux') || args.has('--windows')) {
  const { createHash } = await import('node:crypto');
  const electronVersion = fs.readFileSync(path.join(root, 'apps/desktop/node_modules/electron/dist/version'), 'utf8').trim();
  const cache = path.join(root, '.orchestrator-dev', 'electron-cache', `v${electronVersion}`);
  fs.mkdirSync(cache, { recursive: true });
  const releaseUrl = `https://github.com/electron/electron/releases/download/v${electronVersion}`;
  const download = async (file) => {
    const dest = path.join(cache, file);
    if (fs.existsSync(dest)) return dest;
    const res = await fetch(`${releaseUrl}/${file}`);
    if (!res.ok) throw new Error(`could not download ${file}: HTTP ${res.status}`);
    fs.writeFileSync(`${dest}.part`, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(`${dest}.part`, dest);
    return dest;
  };
  const sums = fs.readFileSync(await download('SHASUMS256.txt'), 'utf8');
  const targets = [...(args.has('--linux') ? [['linux', 'arm64'], ['linux', 'x64']] : []), ...(args.has('--windows') ? [['win32', 'x64'], ['win32', 'arm64']] : [])];
  for (const [platform, arch] of targets) {
    const zipName = `electron-v${electronVersion}-${platform}-${arch}.zip`;
    const zip = await download(zipName);
    const expected = new RegExp(`^([0-9a-f]{64}) \\*?${zipName.replace(/\./g, '\\.')}$`, 'm').exec(sums)?.[1];
    const actual = createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
    if (!expected || expected !== actual) {
      fs.rmSync(zip, { force: true });
      throw new Error(`${zipName}: checksum mismatch (expected ${expected ?? 'an entry in SHASUMS256.txt'}, got ${actual})`);
    }
    const dirName = `orchestrator-desktop-${version}-${platform === 'win32' ? 'windows' : 'linux'}-${arch}`;
    const dir = path.join(release, dirName);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    run('unzip', ['-q', '-o', zip, '-d', dir]);
    fs.rmSync(path.join(dir, 'resources', 'default_app.asar'), { force: true });
    const appDir = path.join(dir, 'resources', 'app');
    stagePayload(appDir);
    fs.cpSync(path.join(root, 'apps/desktop/electron'), path.join(appDir, 'apps/desktop/electron'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: 'orchestrator', productName: 'Orchestrator', version, main: 'apps/desktop/electron/main.cjs', description: 'ORCHESTRATOR — Your code. Your company. Your world.' }, null, 2));
    if (platform === 'win32') {
      // Windows: the app is a client. Workers need tmux, so the office itself runs in WSL2 or on
      // another machine, and the app's connect screen points at it. Built here, never run here.
      fs.renameSync(path.join(dir, 'electron.exe'), path.join(dir, 'Orchestrator.exe'));
      fs.writeFileSync(
        path.join(dir, 'README-WINDOWS.txt'),
        `Orchestrator ${version} — Windows desktop app (${arch})\r\n\r\nNOT TESTED: this bundle was assembled on macOS from Electron's official Windows build and has\r\nnever been started on Windows.\r\n\r\nRun Orchestrator.exe. It shows a connect screen: enter the address of an Orchestrator server and\r\nits owner token.\r\n\r\n  - Server in WSL2 on this PC:  http://localhost:4600   (run the server and agent inside WSL2;\r\n    see docs/INSTALL.md in resources\\app\\docs)\r\n  - Server on another machine:  https://office.example.com\r\n\r\nClaude Code workers need tmux, so employees never run natively on Windows.\r\n`,
      );
      const outZip = path.join(release, `${dirName}.zip`);
      fs.rmSync(outZip, { force: true });
      run('zip', ['-qr', '-X', outZip, dirName], { cwd: release });
      console.log(`${path.relative(root, outZip)}  ${size(outZip)}  (Electron ${electronVersion}, checksum verified; NOT run — no Windows machine)`);
      continue;
    }
    fs.writeFileSync(
      path.join(dir, 'orchestrator-desktop'),
      `#!/bin/sh
# Orchestrator ${version} desktop app (Electron ${electronVersion}, linux-${arch})
HERE="$(cd "$(dirname "$0")" && pwd -P)"
exec "$HERE/electron" "$@"
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(dir, 'orchestrator.desktop'), `[Desktop Entry]\nType=Application\nName=Orchestrator\nComment=Your code. Your company. Your world.\nExec=${dirName}/orchestrator-desktop\nTerminal=false\nCategories=Development;\n`);
    fs.writeFileSync(
      path.join(dir, 'README-LINUX.txt'),
      `Orchestrator ${version} — Linux desktop app (${arch})

Needs on this machine: Node.js 22.18+ (the app starts the server and this machine's agent with it;
set ORCH_NODE if it is not on PATH), tmux, git and the claude CLI.

  ./orchestrator-desktop

Chromium's sandbox: Electron needs either unprivileged user namespaces or its setuid helper.
If the app refuses to start with a sandbox error, make the helper setuid root once:

  sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox

To open an office that runs on another machine instead of starting one here:

  ORCH_SERVER_URL=https://office.example.com ORCH_TOKEN=<owner token> ./orchestrator-desktop

Edit the Exec= line of orchestrator.desktop to the full path if you want a menu entry.
`,
    );
    const out = path.join(release, `${dirName}.tar.gz`);
    fs.rmSync(out, { force: true });
    run('tar', ['--no-xattrs', '-czf', out, '-C', release, dirName], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    console.log(`${path.relative(root, out)}  ${size(out)}  (Electron ${electronVersion}, checksum verified)`);
  }
}

// ───────────── macOS desktop app ─────────────
if (process.platform !== 'darwin' || args.has('--no-app')) {
  if (process.platform !== 'darwin') console.log('The desktop .app/.dmg is only assembled on macOS. On Linux, run the office in a browser (bin/orchestrator --open).');
  process.exit(0);
}
const electronApp = path.join(root, 'apps/desktop/node_modules/electron/dist/Electron.app');
if (!fs.existsSync(path.join(electronApp, 'Contents/MacOS/Electron'))) throw new Error('Electron is not installed correctly (run: pnpm electron:repair)');
const app = path.join(release, 'Orchestrator.app');
// Never replace an app that is running: its files would vanish underneath it.
const runningApp = spawnSync('pgrep', ['-f', path.join(app, 'Contents/MacOS/')], { encoding: 'utf8' }).stdout.trim();
if (runningApp && !args.has('--replace-running')) {
  console.error(`\n${path.relative(root, app)} is running (pid ${runningApp.split('\n').join(', ')}). Quit it first, then run this again.`);
  process.exit(1);
}
fs.rmSync(app, { recursive: true, force: true });
// ditto keeps the framework symlinks and extended attributes intact.
run('ditto', [electronApp, app]);
const resources = path.join(app, 'Contents/Resources');
fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
const payload = path.join(resources, 'app');
stagePayload(payload);
fs.cpSync(path.join(root, 'apps/desktop/electron'), path.join(payload, 'apps/desktop/electron'), { recursive: true });
fs.writeFileSync(path.join(payload, 'package.json'), JSON.stringify({ name: 'orchestrator', productName: 'Orchestrator', version, main: 'apps/desktop/electron/main.cjs', description: 'ORCHESTRATOR — Your code. Your company. Your world.' }, null, 2));
const plist = path.join(app, 'Contents/Info.plist');
const set = (key, value) => {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'ignore' });
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist], { stdio: 'ignore' });
  }
};
set('CFBundleName', 'Orchestrator');
set('CFBundleDisplayName', 'Orchestrator');
set('CFBundleIdentifier', 'local.orchestrator.desktop');
set('CFBundleShortVersionString', version);
set('CFBundleVersion', version);
// Changing the bundle invalidates Electron's signature; Apple silicon refuses to run an invalid one.
run('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: ['ignore', 'ignore', 'inherit'] });
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
console.log(`${path.relative(root, app)}  (ad-hoc signed)`);

if (!args.has('--no-dmg')) {
  const dmgRoot = path.join(release, 'dmg');
  fs.rmSync(dmgRoot, { recursive: true, force: true });
  fs.mkdirSync(dmgRoot);
  run('ditto', [app, path.join(dmgRoot, 'Orchestrator.app')]);
  fs.symlinkSync('/Applications', path.join(dmgRoot, 'Applications'));
  const dmg = path.join(release, `Orchestrator-${version}-${process.arch}.dmg`);
  fs.rmSync(dmg, { force: true });
  run('hdiutil', ['create', '-volname', 'Orchestrator', '-srcfolder', dmgRoot, '-ov', '-format', 'UDZO', dmg], { stdio: ['ignore', 'ignore', 'inherit'] });
  fs.rmSync(dmgRoot, { recursive: true, force: true });
  console.log(`${path.relative(root, dmg)}  ${size(dmg)}`);
}
