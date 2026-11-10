#!/bin/sh
# Three machines, three operating systems, one office: this Mac plus a Debian and an
# Ubuntu container, each enrolled over TLS. Includes a real network partition.
#   tests/linux/run-multi.sh     (needs Docker; workers are the scripted test fixture; takes ~3 minutes)
set -eu
cd "$(dirname "$0")/../.."
mkdir -p .orchestrator-dev
TMP="$(mktemp -d "$PWD/.orchestrator-dev/multi-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
# The office is published on this machine's real network address, so that every machine —
# including this one — reaches it the same way.
ADDR="${ORCH_TEST_ADDR:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)}"
if [ -z "$ADDR" ]; then
  echo "This test needs a network address for this machine (set ORCH_TEST_ADDR=<ip>)." >&2
  exit 1
fi
export ORCH_TEST_ADDR="$ADDR"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -subj "/CN=$ADDR" -addext "subjectAltName=IP:$ADDR,DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
docker build -q -t orchestrator-linux-host tests/linux >/dev/null
docker build -q -t orchestrator-ubuntu-host -f tests/linux/Dockerfile.ubuntu tests/linux >/dev/null
node scripts/build.mjs >/dev/null 2>&1
NODE_EXTRA_CA_CERTS="$TMP/cert.pem" node tests/linux/multi-machine.ts "$TMP"
