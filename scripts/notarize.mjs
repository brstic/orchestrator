#!/usr/bin/env node
/**
 * Signs the macOS app with a Developer ID and has Apple notarize it:  pnpm package:notarize
 *
 * NOT TESTED END TO END: it needs an Apple Developer ID certificate and account, which the machine
 * this was written on does not have. `--check` (which was run) only verifies the prerequisites.
 *
 *   ORCH_SIGN_IDENTITY     "Developer ID Application: Your Name (TEAMID)"  — as listed by
 *                          `security find-identity -v -p codesigning`
 *   and either
 *   ORCH_NOTARY_PROFILE    a notarytool keychain profile (`xcrun notarytool store-credentials`)
 *   or
 *   APPLE_ID, APPLE_TEAM_ID, APPLE_APP_PASSWORD   (an app-specific password)
 *
 *   --check     report what is present and what is missing; change nothing
 *   --sign-only [--app <path>]
 *               only the signing step (hardened runtime, entitlements, inside out), with whatever
 *               ORCH_SIGN_IDENTITY says — "-" for an ad-hoc signature. This is how the signing
 *               logic was verified without a certificate: the result must still launch.
 *
 * It works on release/Orchestrator.app (build it first with `pnpm package`), signs every binary
 * inside it from the inside out with the hardened runtime, submits it, staples the ticket, then
 * rebuilds, signs, notarizes and staples the .dmg.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const release = path.join(root, 'release');
const signOnly = process.argv.includes('--sign-only');
const app = process.argv.includes('--app') ? path.resolve(process.argv[process.argv.indexOf('--app') + 1]) : path.join(release, 'Orchestrator.app');
const dmg = path.join(release, `Orchestrator-${version}-${process.arch}.dmg`);
const checkOnly = process.argv.includes('--check');
const identity = process.env.ORCH_SIGN_IDENTITY ?? '';
const profile = process.env.ORCH_NOTARY_PROFILE ?? '';
const credentials = profile ? ['--keychain-profile', profile] : process.env.APPLE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_APP_PASSWORD ? ['--apple-id', process.env.APPLE_ID, '--team-id', process.env.APPLE_TEAM_ID, '--password', process.env.APPLE_APP_PASSWORD] : null;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });

// ───────────── prerequisites ─────────────
const problems = [];
if (signOnly) {
  if (!identity) throw new Error('--sign-only needs ORCH_SIGN_IDENTITY ("-" for ad hoc)');
  if (!fs.existsSync(app)) throw new Error(`${app} does not exist`);
} else {
if (process.platform !== 'darwin') problems.push('this only works on macOS');
const identities = process.platform === 'darwin' ? (spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).stdout ?? '') : '';
const developerIds = [...identities.matchAll(/"(Developer ID Application: [^"]+)"/g)].map((m) => m[1]);
console.log(`Developer ID certificates in the keychain: ${developerIds.length ? developerIds.length : 'none'}`);
if (!developerIds.length) problems.push('no "Developer ID Application" certificate in the keychain (create one at developer.apple.com → Certificates, and install it)');
if (!identity) problems.push('ORCH_SIGN_IDENTITY is not set');
else if (!developerIds.includes(identity)) problems.push(`ORCH_SIGN_IDENTITY ("${identity}") is not one of the installed Developer ID certificates`);
const notarytool = spawnSync('xcrun', ['--find', 'notarytool'], { encoding: 'utf8' });
console.log(`notarytool: ${notarytool.status === 0 ? notarytool.stdout.trim() : 'not found'}`);
if (notarytool.status !== 0) problems.push('xcrun notarytool was not found (install Xcode or the command line tools)');
console.log(`notarization credentials: ${profile ? `keychain profile "${profile}"` : credentials ? 'Apple ID + team + app-specific password' : 'none'}`);
if (!credentials) problems.push('no notarization credentials: set ORCH_NOTARY_PROFILE, or APPLE_ID + APPLE_TEAM_ID + APPLE_APP_PASSWORD');
console.log(`app: ${fs.existsSync(app) ? app : 'not built'}`);
if (!fs.existsSync(app)) problems.push('release/Orchestrator.app does not exist — run: pnpm package');
if (problems.length) {
  console.log(`\nNot ready to notarize:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
if (checkOnly) {
  console.log('\nEverything needed is present. Run without --check to sign and notarize.');
  process.exit(0);
}
}

// ───────────── sign, inside out, with the hardened runtime ─────────────
// What Electron needs under the hardened runtime: JIT for V8, and loading its own frameworks.
const entitlements = path.join(path.dirname(app), 'orchestrator-entitlements.plist');
fs.writeFileSync(
  entitlements,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
`,
);
const isMachO = (file) => {
  try {
    const fd = fs.openSync(file, 'r');
    const magic = Buffer.alloc(4);
    fs.readSync(fd, magic, 0, 4, 0);
    fs.closeSync(fd);
    return ['cffaedfe', 'cefaedfe', 'cafebabe', 'feedfacf', 'feedface'].includes(magic.toString('hex'));
  } catch {
    return false;
  }
};
const targets = [];
(function walk(dir, depth) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walk(p, depth + 1);
      if (/\.(app|framework)$/.test(entry.name)) targets.push({ p, depth, bundle: true });
    } else if (isMachO(p)) targets.push({ p, depth: depth + 1, bundle: false });
  }
})(app, 0);
// Deepest first; at the same depth, plain binaries before the bundles that contain them.
targets.sort((a, b) => b.depth - a.depth || Number(a.bundle) - Number(b.bundle));
// A secure timestamp needs a real certificate; an ad-hoc signature cannot have one.
const timestamp = identity === '-' ? [] : ['--timestamp'];
const sign = (p) => run('codesign', ['--force', ...timestamp, '--options', 'runtime', '--entitlements', entitlements, '--sign', identity, p], { stdio: ['ignore', 'ignore', 'inherit'] });
for (const t of targets) sign(t.p);
sign(app);
run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
console.log(`signed ${targets.length + 1} items with ${identity === '-' ? 'an ad-hoc identity' : identity}`);
if (signOnly) {
  fs.rmSync(entitlements, { force: true });
  process.exit(0);
}

// ───────────── notarize and staple the app, then the disk image ─────────────
const submit = (file) => run('xcrun', ['notarytool', 'submit', file, ...credentials, '--wait']);
const zip = path.join(release, 'Orchestrator-notarize.zip');
fs.rmSync(zip, { force: true });
run('ditto', ['-c', '-k', '--keepParent', app, zip]);
submit(zip);
fs.rmSync(zip, { force: true });
run('xcrun', ['stapler', 'staple', app]);

const dmgRoot = path.join(release, 'dmg');
fs.rmSync(dmgRoot, { recursive: true, force: true });
fs.mkdirSync(dmgRoot);
run('ditto', [app, path.join(dmgRoot, 'Orchestrator.app')]);
fs.symlinkSync('/Applications', path.join(dmgRoot, 'Applications'));
fs.rmSync(dmg, { force: true });
run('hdiutil', ['create', '-volname', 'Orchestrator', '-srcfolder', dmgRoot, '-ov', '-format', 'UDZO', dmg], { stdio: ['ignore', 'ignore', 'inherit'] });
fs.rmSync(dmgRoot, { recursive: true, force: true });
run('codesign', ['--force', '--timestamp', '--sign', identity, dmg]);
submit(dmg);
run('xcrun', ['stapler', 'staple', dmg]);
fs.rmSync(entitlements, { force: true });
run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
console.log(`\nNotarized and stapled:\n  ${app}\n  ${dmg}`);
