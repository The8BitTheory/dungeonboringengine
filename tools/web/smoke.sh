#!/bin/sh
# Headless smoke test of the editor app (docs/specs/P8-js-tools.md 4.5): serves the repo read-only over HTTP,
# opens the demo scene in Chrome (headless) and checks that the map and the live view were rendered.
# usage: tools/web/smoke.sh [OUT.png]     needs: python3, chrome (Chrome for Testing in ~/.local/bin is fine)
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CHROME=${CHROME:-$(command -v chrome || command -v google-chrome || command -v chromium)}
TMP=$(mktemp -d)
PORT=$(python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1])")
python3 -m http.server "$PORT" --bind 127.0.0.1 -d "$ROOT" >"$TMP/http.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$TMP"' EXIT
until curl -s -o /dev/null "http://127.0.0.1:$PORT/"; do :; done
URL="http://127.0.0.1:$PORT/tools/web/?http=/&open=demo/preview.toml"
OPTS="--headless=new --disable-gpu --no-sandbox --user-data-dir=$TMP/chrome --window-size=1400,950 --virtual-time-budget=20000"
DOM=$(timeout 120 "$CHROME" $OPTS --dump-dom "$URL" 2>/dev/null)
[ $# -ge 1 ] && timeout 120 "$CHROME" $OPTS --screenshot="$1" "$URL" >/dev/null 2>&1
echo "$DOM" | grep -q 'data-ready="1"' || { echo "FAIL: app did not finish"; exit 1; }
echo "$DOM" | grep -q 'demo/demo.toml: 20 × 16' || { echo "FAIL: map not opened"; exit 1; }
echo "$DOM" | grep -qE 'VCL [0-9]+ \+ VMS [0-9]+ bytes' || { echo "FAIL: live view not rendered"; exit 1; }
echo "smoke ok"
