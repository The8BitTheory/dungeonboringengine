#!/bin/sh
# Publish the editors with the demo project on GitHub Pages (branch gh-pages):
#   https://the8bittheory.github.io/dungeonboringengine/  ->  tools/web/?http=../../&open=demo/preview.toml
# Builds the demo assets (Node only), copies the app, the core library, the demo project and the examples with the
# built assets in their repository paths, writes files.json (the app's file list on static hosting) and pushes one
# commit to gh-pages (the branch holds only the site; it is replaced each time).
# usage: tools/web/publish.sh [--dry-run [DIR]]   (--dry-run: build the site, copy it to DIR if given, do not push)
set -eu
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
SITE=$(mktemp -d)
trap 'rm -rf "$SITE"' EXIT
node demo/build.js --no-disk -q
copy() { mkdir -p "$SITE/$(dirname "$1")"; cp -r "$1" "$SITE/$1"; }
for p in tools/web tools/js/core tools/js/vendor demo docs/specs/examples docs/tools-manual.md \
         build/demo/files build/demo/geom build/demo/tex build/demo/spr build/demo/art; do
  copy "$p"
done
rm -f "$SITE/tools/web/publish.sh" "$SITE/tools/web/smoke.sh"
find "$SITE" -name '__pycache__' -prune -exec rm -rf {} +
( cd "$SITE" && find . -type f ! -name files.json | sed 's|^\./||' | sort | node -e '
  const t = require("fs").readFileSync(0, "utf8").trim().split("\n");
  process.stdout.write(JSON.stringify(t));' > files.json )
cat > "$SITE/index.html" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>DBE Tools</title>
<meta http-equiv="refresh" content="0; url=tools/web/?http=../../&amp;open=demo/preview.toml">
<a href="tools/web/?http=../../&amp;open=demo/preview.toml">DBE Tools (demo project)</a>
HTML
touch "$SITE/.nojekyll"
SHA=$(git rev-parse --short HEAD)
if [ "${1:-}" = "--dry-run" ]; then
  [ -n "${2:-}" ] && { rm -rf "$2"; cp -r "$SITE" "$2"; }
  (cd "$SITE" && find . -type f | wc -l && du -sh .); exit 0
fi
cd "$SITE"
git init -q -b gh-pages
git add -A
git -c user.name="$(git -C "$ROOT" config user.name)" -c user.email="$(git -C "$ROOT" config user.email)" \
  commit -q -m "Editors with the demo project, from main $SHA (tools/web/publish.sh)"
git push -q -f "$(git -C "$ROOT" remote get-url origin)" gh-pages
echo "pushed gh-pages ($SHA)"
