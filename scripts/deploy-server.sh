#!/bin/sh
# Update the office on the server:  pnpm deploy:server
#
# Builds the portable package here, copies it to the server, swaps it in next to the running one
# and restarts the service. Employees' tmux sessions on the server keep running; members'
# invitations stay valid; open desktop apps reconnect by themselves (reload them to get a new UI).
# The previous version stays in ~/orchestrator-office/app.old (see --rollback).
#
#   ORCH_DEPLOY_HOST   ssh destination          (default: <user>@<server>)
#   ORCH_DEPLOY_PORT   ssh port                 (default: 22)
#   ORCH_DEPLOY_DIR    install folder there     (default: orchestrator-office, under the home folder)
#   ORCH_DEPLOY_UNIT   systemd user unit        (default: orchestrator-office)
#
# The public demo office (orchestrator-demo, docs/DEMO.md) runs from the same folder: where it is installed, it is
# restarted too — fresh, as every start of it is.
#
#   scripts/deploy-server.sh --rollback    put app.old back and restart
#   scripts/deploy-server.sh --status      what is running there
set -eu
cd "$(dirname "$0")/.."
HOST="${ORCH_DEPLOY_HOST:-<user>@<server>}"
PORT="${ORCH_DEPLOY_PORT:-22}"
DIR="${ORCH_DEPLOY_DIR:-orchestrator-office}"
UNIT="${ORCH_DEPLOY_UNIT:-orchestrator-office}"
remote() { ssh -o BatchMode=yes -p "$PORT" "$HOST" "$@"; }
# What the service reports, and the office's own view of itself (run on the server, with its own token).
# After a restart: wait until the office answers (it takes a few seconds, more when the machine is busy), three minutes at most.
UP='n=0; until curl -s -o /dev/null -m 2 http://127.0.0.1:4600/; do n=$((n+1)); [ $n -ge 90 ] && break; sleep 2; done'
STATUS='systemctl --user is-active '"$UNIT"'; cat ~/'"$DIR"'/app/VERSION ~/'"$DIR"'/app/BUILD 2>/dev/null | tr "\n" " "; echo; N=$(ls -d ~/.nvm/versions/node/v22*/bin/node 2>/dev/null | tail -1); ORCH_SERVER_HOME=~/.orchestrator-office/server ${N:-node} ~/'"$DIR"'/app/scripts/office-admin.mjs status'

case "${1:-}" in
  --status)
    remote "$STATUS"
    exit 0
    ;;
  --rollback)
    remote "set -e; cd ~/$DIR; [ -d app.old ] || { echo 'no previous version to go back to'; exit 1; }; mv app app.bad && mv app.old app && rm -rf app.bad && systemctl --user restart $UNIT && { $UP; }; $STATUS"
    exit 0
    ;;
esac

VERSION="$(node -p "require('./package.json').version")"
# The tarball only (--no-app): the desktop app on this computer is not touched.
node scripts/package.mjs --no-app >/dev/null
TARBALL="release/orchestrator-$VERSION.tar.gz"
BUILD="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)$(git diff --quiet 2>/dev/null || echo '+uncommitted') $(date -u +%Y-%m-%dT%H:%MZ)"
echo "Deploying $TARBALL ($BUILD) to $HOST:~/$DIR"
scp -q -o BatchMode=yes -P "$PORT" "$TARBALL" "$HOST:/tmp/orchestrator-office.tar.gz"
remote "set -e; cd ~/$DIR; rm -rf app.new; mkdir app.new; tar xzf /tmp/orchestrator-office.tar.gz -C app.new --strip-components=1; echo '$BUILD' > app.new/BUILD; rm -rf app.old; mv app app.old; mv app.new app; rm -f /tmp/orchestrator-office.tar.gz; systemctl --user restart $UNIT; if systemctl --user is-enabled orchestrator-demo >/dev/null 2>&1; then systemctl --user restart orchestrator-demo; echo 'demo office restarted'; fi; $UP; $STATUS"
