import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseOf, releaseRulesOf } from '../src/index.ts';

/** The release gate's reading of a command (`release.ts`, docs/RELEASE-GATE.md): what reaches master/main or production. */
const rules = releaseRulesOf({ releaseGate: { on: true, hosts: ['64.0.2.10', 'app.example.net'] } });
const on = (branch: string | null) => () => branch;
const r = (cmd: string, branch: string | null = 'feature/x', cwd = '/work/repo') => releaseOf(cmd, rules, cwd, on(branch));

test('a push to a protected branch is a release; to a branch of their own it is not', () => {
  assert.match(r('git push origin master')!, /pushes to master/);
  assert.match(r('git push -u origin HEAD:main')!, /pushes to main/);
  assert.match(r('git push origin +t359:refs/heads/master')!, /pushes to master/);
  assert.match(r('cd /x/panel && git -c credential.helper= -c "credential.helper=!f() { echo u; }; f" push origin master')!, /pushes to master/);
  assert.equal(r('git push origin consolidated-websites'), null, 'the development branch is free');
  assert.equal(r('git push -u origin t359-dfs-client'), null);
  assert.equal(r('git push --dry-run origin master'), null, 'a dry run sends nothing');
  assert.equal(r('git push origin v1.2:refs/tags/v1.2'), null, 'a tag is not a branch');
});

test('a push that names no branch is a release when it is made from a protected branch', () => {
  assert.match(r('git push', 'master')!, /pushes to master/);
  assert.match(r('git push origin HEAD', 'main')!, /pushes to main/);
  assert.equal(r('git push', 'feature/x'), null);
  assert.equal(r('git push', null), null, 'a branch that cannot be told is not taken for one');
  // The folder is followed: cd, and git -C.
  const seen: string[] = [];
  releaseOf('cd /srv/other && git push; git -C ../third push', rules, '/work/repo', (d) => (seen.push(d), 'x'));
  assert.deepEqual(seen, ['/srv/other', '/srv/other/../third']);
  assert.match(r('git push --all origin')!, /every branch/);
});

test('production: a command that names a production server and changes something there; reading it is free', () => {
  assert.match(r("ssh -p 22 deploy@64.0.2.10 'cd /home/x/www/app && git pull --ff-only'")!, /64\.0\.2\.10/);
  assert.match(r('rsync -a dist/ deploy@app.example.net:/var/www/')!, /app\.example\.net/);
  assert.match(r(`ssh deploy@64.0.2.10 "mysql app -e 'ALTER TABLE users ADD x INT'"`)!, /production/);
  assert.match(r("ssh deploy@64.0.2.10 'sed -i s/a/b/ /etc/app.conf'")!, /production/);
  assert.match(r("ssh deploy@64.0.2.10 'echo x > /home/x/www/app/.env'")!, /production/);
  assert.match(r('git push ssh://deploy@64.0.2.10/srv/app.git feature/x')!, /production server/);
  assert.equal(r("ssh deploy@64.0.2.10 'cd /home/x/www/app && git log --oneline -3 && git status 2>/dev/null'"), null);
  assert.equal(r("ssh deploy@64.0.2.10 'tail -n 50 /var/log/app.log; grep -c ERROR /var/log/app.log 2>&1'"), null);
  assert.equal(r("ssh deploy@64.0.2.100 'git pull'"), null, 'another address is not the production server');
  assert.equal(r("ssh deploy@dev.example.net 'cd app && git pull'"), null, 'a development server is free');
});

test('merging a pull request is a release; nothing is one while the gate is off', () => {
  assert.match(r('gh pr merge 12 --squash')!, /merges a pull request/);
  assert.equal(releaseOf('git push origin master', releaseRulesOf({ releaseGate: { on: false } }), '/w', on('x')), null);
  assert.deepEqual(releaseRulesOf({}), { on: false, branches: ['main', 'master'], hosts: [] });
});
