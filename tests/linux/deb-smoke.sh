#!/bin/sh
# Installs the .deb built by `pnpm package:linux` on Debian with dpkg, runs what it installed,
# and removes it again. Needs Docker.
set -eu
cd "$(dirname "$0")/../.."
VERSION="$(node -p "require('./package.json').version")"
DEB="release/orchestrator_${VERSION}_all.deb"
[ -f "$DEB" ] || { echo "$DEB not found — run: pnpm package:linux" >&2; exit 1; }
docker build -q -t orchestrator-linux-host tests/linux >/dev/null
docker run --rm --user root -v "$PWD/release:/release:ro" orchestrator-linux-host bash -c "
  set -e
  dpkg -i /release/orchestrator_${VERSION}_all.deb >/dev/null
  echo \"installed: \$(dpkg-query -W -f='\${Package} \${Version} (\${Status})' orchestrator)\"
  echo \"owner of installed files: \$(stat -c '%U:%G' /opt/orchestrator/bin/orchestrator)\"
  echo \"agent: \$(orchestrator-agent version)\"
  orchestrator-server --help | head -1
  su dev -c 'cd ~ && (orchestrator --json --port 4777 > /tmp/office.json 2>/tmp/office.err &) ; for i in \$(seq 1 60); do grep -q token /tmp/office.json 2>/dev/null && break; sleep 0.5; done; cat /tmp/office.json | cut -c1-40; curl -s -o /dev/null -w \"office UI http %{http_code}\n\" http://127.0.0.1:4777/'
  dpkg -r orchestrator >/dev/null
  test ! -e /usr/bin/orchestrator && test ! -e /opt/orchestrator/bin && echo 'removed cleanly'
" > /tmp/orch-deb-smoke.$$ 2>&1 || true
cat /tmp/orch-deb-smoke.$$
if grep -q "install ok installed" /tmp/orch-deb-smoke.$$ && grep -q "root:root" /tmp/orch-deb-smoke.$$ && grep -q "agent: $VERSION" /tmp/orch-deb-smoke.$$ && grep -q "office UI http 200" /tmp/orch-deb-smoke.$$ && grep -q "removed cleanly" /tmp/orch-deb-smoke.$$; then
  echo "✔ the .deb installs with dpkg, the installed commands run a working office, and it uninstalls cleanly"
  STATUS=0
else
  echo "✖ the .deb check failed"
  STATUS=1
fi
unlink /tmp/orch-deb-smoke.$$
exit $STATUS
