#!/bin/sh
# Runs a real Linux machine (Docker container) as an Orchestrator host against a
# TLS server on this machine, and checks the Linux code paths end to end.
#   tests/linux/run.sh        (needs Docker; the worker inside is the scripted test fixture)
set -eu
cd "$(dirname "$0")/../.."
# Under the repository (git-ignored), because Docker VMs on macOS only share the home directory.
mkdir -p .orchestrator-dev
TMP="$(mktemp -d "$PWD/.orchestrator-dev/linux-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
# A self-signed certificate for the name containers use to reach this machine.
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -subj "/CN=host.docker.internal" -addext "subjectAltName=DNS:host.docker.internal,DNS:host.lima.internal,DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
docker build -q -t orchestrator-linux-host tests/linux >/dev/null 2>&1
node scripts/build.mjs >/dev/null 2>&1
NODE_EXTRA_CA_CERTS="$TMP/cert.pem" node tests/linux/linux-host.ts "$TMP"
