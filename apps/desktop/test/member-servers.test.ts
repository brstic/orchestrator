import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/**
 * The parts of electron/member-servers.cjs that decide what is handed to `ssh` and what is said about a server.
 * The whole of it — the real scripts against a stand-in server and a real office — is in tests/e2e/21-member-servers-lock.test.ts.
 */
const require = createRequire(import.meta.url);
const { parseTarget, cleanRoots, readProbe, explain, publiclyTrusted } = require('../electron/member-servers.cjs') as {
  parseTarget: (t: string) => { dest: string; port: number | null; host: string; text: string };
  cleanRoots: (r: unknown) => string[];
  readProbe: (out: string, host: string) => { os: string; node: string | null; problems: string[]; warnings: string[]; hostname: string };
  explain: (stderr: string, target: string) => string;
  publiclyTrusted: (address: string) => Promise<boolean>;
};

test('a server is named the way ssh takes it, and nothing typed can be read as an option or a command', () => {
  assert.deepEqual(parseTarget('deploy@build.example.com'), { dest: 'deploy@build.example.com', port: null, host: 'build.example.com', text: 'deploy@build.example.com' });
  assert.deepEqual(parseTarget(' ssh://deploy@10.0.0.7:2222/ '), { dest: 'deploy@10.0.0.7', port: 2222, host: '10.0.0.7', text: 'deploy@10.0.0.7:2222' });
  assert.equal(parseTarget('buildbox').dest, 'buildbox', 'a name from ~/.ssh/config');
  for (const bad of ['', '-oProxyCommand=evil host', 'host; rm -rf ~', 'user@host:99999', 'user@@host', 'a b', '$(whoami)@host', 'host`id`']) assert.throws(() => parseTarget(bad), /user@host|valid port/, bad);
});

test('folders on the server: absolute or under the home folder, and nothing that climbs out', () => {
  assert.deepEqual(cleanRoots([' ~/code ', '/srv/app', '']), ['~/code', '/srv/app']);
  assert.deepEqual(cleanRoots(undefined), []);
  assert.deepEqual(cleanRoots(['~', '~/']), ['~/', '~/'], '~ alone is the home folder');
  for (const bad of ['code', '../etc', '/srv/../etc', '~/a; rm -rf /', '/tmp/$(id)', '~root']) assert.throws(() => cleanRoots([bad]), /not a folder path/, bad);
});

test('what the look at a server says: what stands in the way, and what is only worth knowing', () => {
  const good = readProbe('os=Linux\narch=x86_64\nhostname=build\nuser=deploy\nhome=/home/deploy\nnode=v22.21.0\ntmux=tmux 3.4\nclaude=2.1.300 (Claude Code)\ngit=git version 2.43.0\ncurl=yes\n', 'x');
  assert.deepEqual([good.problems, good.warnings, good.hostname], [[], [], 'build']);
  const old = readProbe('os=Linux\nnode=v18.19.1\ntmux=\nclaude=\ngit=\ncurl=no\n', 'fallback.example.com');
  assert.equal(old.hostname, 'fallback.example.com');
  assert.deepEqual(old.problems.map((p) => p.split(' ')[0]), ['Node.js', 'tmux', 'curl']);
  assert.match(old.problems[0]!, /v18\.19\.1 is too old/);
  assert.equal(old.warnings.length, 2, 'no claude and no git: said, not refused');
  assert.match(readProbe('os=MINGW64_NT\nnode=v22.21.0\ntmux=tmux 3.4\ncurl=yes\n', 'x').problems[0]!, /Linux or macOS/);
  assert.match(readProbe('os=Linux\nnode=v22.17.9\ntmux=t\ncurl=yes\n', 'x').problems[0]!, /too old/);
  assert.deepEqual(readProbe('os=Darwin\nnode=v24.1.0\ntmux=t\ncurl=yes\nclaude=x\ngit=y\n', 'x').problems, []);
});

test('what ssh says is passed on in words a person can act on, and a password is never the way', () => {
  assert.match(explain('deploy@build: Permission denied (publickey,password).', 'deploy@build'), /did not accept any of your SSH keys.*Passwords are never asked for/s);
  assert.match(explain('Host key verification failed.', 'h'), /never connected to h before/);
  assert.match(explain('@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @', 'h'), /Nothing was sent/);
  assert.match(explain('ssh: Could not resolve hostname nope: Name or service not known', 'nope'), /could not be found/);
  assert.match(explain('', 'h'), /without saying why/);
});

test('an office a server could not recognise by itself: an address that is not a domain over TLS', async () => {
  // No connection is made for these: an IP address has no name a certificate could vouch for, and plain http has no certificate.
  assert.equal(await publiclyTrusted('https://<server-lan-ip>:4610'), false);
  assert.equal(await publiclyTrusted('https://[::1]:4610'), false);
  assert.equal(await publiclyTrusted('http://office.example.com'), false);
  assert.equal(await publiclyTrusted('not an address'), false);
});
