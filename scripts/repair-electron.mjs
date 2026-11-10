#!/usr/bin/env node
/**
 * Electron's installer can leave an empty dist/ on very new Node versions
 * (its unzip step exits silently). This finishes the job with the system
 * `unzip` from the archive Electron already downloaded.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'apps/desktop/package.json'));
const pkgDir = path.dirname(require.resolve('electron/package.json'));
const { version } = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const pathFile = path.join(pkgDir, 'path.txt');
const ok = () => fs.existsSync(pathFile) && fs.existsSync(path.join(pkgDir, 'dist', fs.readFileSync(pathFile, 'utf8')));
if (ok()) {
  console.log(`Electron ${version} is installed correctly.`);
  process.exit(0);
}
spawnSync(process.execPath, [path.join(pkgDir, 'install.js')], { stdio: 'inherit' });
if (ok()) process.exit(0);
const platform = process.platform === 'win32' ? 'win32' : process.platform;
const name = `electron-v${version}-${platform}-${process.arch}.zip`;
const caches = [process.env.electron_config_cache, path.join(os.homedir(), 'Library/Caches/electron'), path.join(os.homedir(), '.cache/electron'), path.join(process.env.LOCALAPPDATA ?? '', 'electron/Cache')].filter(Boolean);
let zip = null;
for (const dir of caches) {
  if (!fs.existsSync(dir)) continue;
  const found = fs.readdirSync(dir, { recursive: true }).find((f) => String(f).endsWith(name));
  if (found) {
    zip = path.join(dir, String(found));
    break;
  }
}
if (!zip) {
  console.error(`Could not find ${name} in Electron's download cache. Run "pnpm install" again with network access.`);
  process.exit(1);
}
fs.rmSync(path.join(pkgDir, 'dist'), { recursive: true, force: true });
fs.mkdirSync(path.join(pkgDir, 'dist'));
execFileSync('unzip', ['-q', zip, '-d', path.join(pkgDir, 'dist')], { stdio: 'inherit' });
const exe = platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : platform === 'win32' ? 'electron.exe' : 'electron';
fs.writeFileSync(pathFile, exe);
console.log(`Electron ${version} repaired from ${zip}`);
