#!/bin/sh
# Runs the packaged Linux desktop app (pnpm package --linux) on Ubuntu 24.04 under a virtual
# display: it must start its own backend and render the office. Needs Docker.
#   tests/linux/desktop-smoke.sh [out.png]
#   ORCH_DESKTOP_ARCH=x64 tests/linux/desktop-smoke.sh     run the other architecture under emulation
#                                                          (needs the Docker VM to emulate it, e.g. colima start --vz-rosetta)
set -eu
cd "$(dirname "$0")/../.."
VERSION="$(node -p "require('./package.json').version")"
case "$(docker info --format '{{.Architecture}}')" in aarch64|arm64) NATIVE=arm64 ;; *) NATIVE=x64 ;; esac
ARCH="${ORCH_DESKTOP_ARCH:-$NATIVE}"
case "$ARCH" in arm64) PLATFORM=linux/arm64 ;; x64) PLATFORM=linux/amd64 ;; *) echo "unknown architecture $ARCH" >&2; exit 1 ;; esac
IMAGE="orchestrator-linux-desktop-$ARCH"
TARBALL="release/orchestrator-desktop-$VERSION-linux-$ARCH.tar.gz"
[ -f "$TARBALL" ] || { echo "$TARBALL not found — run: pnpm package --linux" >&2; exit 1; }
mkdir -p .orchestrator-dev
OUT="$(mktemp -d "$PWD/.orchestrator-dev/desktop-XXXXXX")"
chmod 777 "$OUT"
trap 'rm -rf "$OUT"' EXIT
docker build -q --platform "$PLATFORM" -t "$IMAGE" -f tests/linux/Dockerfile.desktop tests/linux >/dev/null
# --no-sandbox only because containers do not allow Chromium's sandbox; software GL because there is no GPU.
docker run --rm --platform "$PLATFORM" -v "$PWD/release:/release:ro" -v "$OUT:/out" "$IMAGE" bash -c "
  set -e
  mkdir -p ~/app && tar -xzf /release/orchestrator-desktop-$VERSION-linux-$ARCH.tar.gz -C ~/app
  cd ~/app/orchestrator-desktop-$VERSION-linux-$ARCH
  ORCH_SMOKE_SCREENSHOT=/out/desktop.png ORCH_SMOKE_WAIT_MS=${ORCH_SMOKE_WAIT_MS:-20000} timeout ${ORCH_SMOKE_TIMEOUT:-120} xvfb-run -a -s '-screen 0 1680x1050x24' ./orchestrator-desktop --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader > /out/app.log 2>&1 || echo \"app exit \$?\" >> /out/app.log
  ls ~/.orchestrator/server/owner-token >/dev/null 2>&1 && echo 'backend state created' >> /out/app.log
  cat /etc/os-release | grep ^PRETTY >> /out/app.log
  echo \"machine: \$(uname -m), electron: \$(file -b ./electron 2>/dev/null | cut -c1-60 || echo n/a)\" >> /out/app.log
" || true
SIZE=$(wc -c < "$OUT/desktop.png" 2>/dev/null || echo 0)
grep -E "backend state created|PRETTY|app exit|machine:" "$OUT/app.log" || true
if [ "$SIZE" -gt 30000 ] && grep -q "backend state created" "$OUT/app.log"; then
  echo "✔ the Linux desktop bundle ($ARCH) started its backend and rendered the office (screenshot $SIZE bytes)"
  [ -n "${1:-}" ] && cp "$OUT/desktop.png" "$1" && echo "  screenshot saved to $1"
  exit 0
fi
echo "✖ the Linux desktop bundle did not render (screenshot $SIZE bytes)"; tail -30 "$OUT/app.log" || true
exit 1
