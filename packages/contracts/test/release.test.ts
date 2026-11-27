import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseOf, releaseRisks, releaseRulesOf } from '../src/index.ts';

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

/*
 * Read from a week of the live office's own commands (19 771 of them, replayed through the rule): 241 were held, and
 * most of those only read production — they wrote their findings to a file here, or a probe into /tmp there. Only
 * what runs there is read now, and what it writes outside /tmp.
 */
test('reading production is free even when the command writes here, or into /tmp there', () => {
  assert.equal(r("mkdir -p /work/out && ssh -p 22 deploy@64.0.2.10 'cd /home/x/www/app && git log -1 && git status --short' > /work/out/before.txt"), null);
  assert.equal(r("ssh deploy@64.0.2.10 'rm -rf /tmp/t1; mkdir -m 700 /tmp/t1; cp /home/x/www/app/.env.example /tmp/t1/'"), null);
  assert.equal(r('mkdir -p /work/out && curl -s https://app.example.net/health > /work/out/h.txt'), null, 'a request to the site is not a change on the server');
  assert.equal(r('scp deploy@64.0.2.10:/var/log/app.log /work/out/'), null, 'copied from production: read');
  assert.equal(r("ssh deploy@64.0.2.10 'crontab -l'"), null);
  assert.equal(r("ssh deploy@64.0.2.10 'bash -s' <<'EOF'\ncd /home/x/www/app\ncat > /tmp/q.php <<'PHP'\n<?php $r = $db->query(\"SELECT id, plan FROM users WHERE id = 5\");\nPHP\nphp /tmp/q.php\nEOF"), null);
});

test('production is changed: by what runs there, also through variables, in a heredoc, or uploaded', () => {
  assert.match(r('S="ssh -p 22 -i ~/.ssh/k"; P=deploy@64.0.2.10; $S $P \'cd /srv/app && git pull --ff-only\'')!, /64\.0\.2\.10/);
  assert.match(r("ssh deploy@64.0.2.10 'bash -s' <<'EOF'\ncd /srv/app\ncat > /tmp/t.php <<'PHP'\n<?php $db->query(\"UPDATE users SET plan = 2 WHERE id = 5\");\nPHP\nphp /tmp/t.php\nEOF")!, /64\.0\.2\.10/);
  assert.match(r('scp dist/app.js deploy@64.0.2.10:/home/x/www/app/js/')!, /64\.0\.2\.10/);
  assert.match(r("ssh deploy@64.0.2.10 '(crontab -l; echo \"*/5 * * * * php /srv/app/index.php cron\") | crontab -'")!, /64\.0\.2\.10/);
  assert.match(r("ssh deploy@64.0.2.10 'cat > /home/x/www/app/config.php' < /work/config.php")!, /64\.0\.2\.10/);
  // A program sent from here: what it does is read when the file can be, and held when it cannot.
  const probe = "ssh deploy@64.0.2.10 'cd /srv/app && php /dev/stdin' < /work/probe.php";
  assert.match(r(probe)!, /runs a program from this machine on 64\.0\.2\.10/);
  const read = (text: string) => (p: string) => (p === '/work/probe.php' ? text : null);
  assert.equal(releaseOf(probe, rules, '/work', on('x'), read('<?php echo $db->query("SELECT count(*) FROM users")->fetch_row()[0];')), null);
  assert.match(releaseOf(probe, rules, '/work', on('x'), read('<?php $db->query("DELETE FROM sessions WHERE expired = 1");'))!, /64\.0\.2\.10/);
});

test('what only looks like a change: a comparison in awk, a word in a message, a file mktemp made', () => {
  assert.equal(r(`ssh deploy@64.0.2.10 'awk "\\$4 >= \\"[19/Nov/2026:19:34:19\\"" /var/log/apache2/app-access.log | wc -l'`), null);
  assert.equal(r(`ssh deploy@64.0.2.10 'echo "== crontab lines that fire at 03:10"; crontab -l | grep -v "^#"'`), null);
  assert.equal(r(`ssh deploy@64.0.2.10 'redis-cli --scan --pattern "sess:*" > $(mktemp /tmp/k.XXXX); git log -1'`), null);
  assert.equal(r(`ssh deploy@64.0.2.10 'cd /srv/app && git merge-base --is-ancestor 1a2b3c HEAD && echo in'`), null);
  assert.match(r(`ssh deploy@64.0.2.10 'cd /srv/app && cat > application/controllers/Probe.php' < /work/Probe.php`)!, /64\.0\.2\.10/);
  assert.match(r(`ssh deploy@64.0.2.10 'crontab /home/deploy/new.cron'`)!, /64\.0\.2\.10/);
});

test('a deploy script run on production is held: what it does is not read here', () => {
  assert.match(r("ssh deploy@64.0.2.10 bash -s <<'REMOTE'\ncd /home/x/www/studio\n./scripts/deploy.sh --verify 2>&1 | tail -5\nREMOTE")!, /64\.0\.2\.10/);
  assert.equal(r("ssh deploy@64.0.2.10 'ls -l scripts/deploy.sh; cat scripts/deploy.sh | head'"), null, 'looking at it is not running it');
});

test('what makes a release the boss\'s to let out, and what was said to be left out', () => {
  assert.deepEqual(releaseRisks('Push master; pull on the app server. No SQL, no cron, no switch.'), []);
  assert.deepEqual(releaseRisks('Code only: no SQL, cron or credential. Push the branch to master.'), []);
  assert.deepEqual(releaseRisks('Run the migration, then push master.'), ['the database']);
  assert.deepEqual(releaseRisks('Stripe webhook: push master'), ['payments']);
  assert.deepEqual(releaseRisks('Publish 2.0.1 to WordPress.org (svn tag)'), ['public publishing']);
  assert.deepEqual(releaseRisks('Reload nginx with the new vhost'), ['server configuration']);
  assert.deepEqual(releaseRisks('Fix the stored XSS'), ['security']);
});

test('a command written into a file here, or said in a message, is not run there (a cron file and a plan in the repo were held)', () => {
  const rules = { on: true, branches: ['main', 'master'], hosts: ['64.0.2.10'] };
  const r = (c: string) => releaseOf(c, rules, '/tmp/x', () => 'feature');
  // Text: written into a file, echoed, a commit message.
  assert.equal(r("cat >> crons/http1 <<'EOF'\n# not installed yet\n*/5 * * * * ssh xagio@64.0.2.10 'systemctl restart nginx'\nEOF"), null);
  assert.equal(r("tee plan.md > /dev/null <<'EOF'\nOn approval: ssh 64.0.2.10 'rm -rf /srv/old'\nEOF"), null);
  assert.equal(r("echo \"later: ssh 64.0.2.10 'reboot'\" >> plan.txt"), null);
  assert.equal(r("printf '%s\\n' \"ssh 64.0.2.10 'git pull'\" > steps.txt"), null);
  assert.equal(r("git commit -m \"Plan: ssh 64.0.2.10 'git pull' once approved\""), null);
  // Run: still held.
  assert.match(r("bash -c \"ssh 64.0.2.10 'rm -rf /srv/old'\"") ?? '', /changes something on 64\.0\.2\.10/);
  assert.match(r("ssh 64.0.2.10 bash <<'EOF'\nrm -rf /srv/old\nEOF") ?? '', /changes something/);
  assert.match(r("bash <<'EOF'\nssh 64.0.2.10 'rm -rf /srv/old'\nEOF") ?? '', /changes something/);
  assert.match(r("echo go && ssh 64.0.2.10 'rm -rf /srv/old'") ?? '', /changes something/);
  assert.match(r("cat steps.txt; ssh 64.0.2.10 'git pull'") ?? '', /changes something/);
});
