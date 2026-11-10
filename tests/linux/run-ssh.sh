#!/bin/sh
# A server reachable only over SSH is linked to the office from this machine: no port is
# opened on either side, the agent is installed over SSH and talks back through a reverse tunnel.
#   tests/linux/run-ssh.sh     (needs Docker and ssh; the worker on the server is the scripted test fixture)
set -eu
cd "$(dirname "$0")/../.."
mkdir -p .orchestrator-dev
TMP="$(mktemp -d "$PWD/.orchestrator-dev/ssh-XXXXXX")"
NAME="orch-ssh-test-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$TMP"' EXIT
docker build -q -t orchestrator-ssh-server -f tests/linux/Dockerfile.ssh tests/linux >/dev/null
node scripts/build.mjs >/dev/null 2>&1
ssh-keygen -q -t ed25519 -N '' -f "$TMP/key" -C orchestrator-ssh-test
docker run -d --name "$NAME" -p 127.0.0.1::22 orchestrator-ssh-server >/dev/null
docker exec -i -u dev "$NAME" sh -c 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat > ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys' < "$TMP/key.pub"
docker cp tests/fixtures/fake-claude.mjs "$NAME":/opt/claude-code/cli.js >/dev/null
PORT="$(docker port "$NAME" 22/tcp | head -1 | sed 's/.*://')"
# The client configuration the office's ssh uses in this test: a name, a key, and its own known-hosts file.
cat > "$TMP/ssh_config" <<CFG
Host my-server
  HostName 127.0.0.1
  Port $PORT
  User dev
  IdentityFile $TMP/key
  IdentitiesOnly yes
  UserKnownHostsFile $TMP/known_hosts
  StrictHostKeyChecking yes
CFG
ORCH_SSH_CONFIG="$TMP/ssh_config" node tests/linux/ssh-link.ts "$TMP" "$NAME"
