#!/usr/bin/env bash
# Package the extension for the stores:
#   dist/fast-venue-rank-<version>-firefox.xpi   -> addons.mozilla.org
#   dist/fast-venue-rank-<version>-chrome.zip    -> Chrome Web Store
# Each package gets a browser-specific manifest: Firefox keeps background.scripts (event page),
# Chrome keeps background.service_worker; keys the other browser does not know are dropped.
# Usage: ./build.sh [firefox|chrome]   (default: both). Needs jq and zip.
set -euo pipefail
cd "$(dirname "$0")"

FILES=(
  background.js options.html options.js
  content/scholar.js content/style.css
  lib/catalog.js lib/compat.js lib/customlist.js lib/normalize.js lib/rankings.js
  data/index.json data/sjr.json data/core.json data/lists.json
  icons/16.png icons/32.png icons/48.png icons/128.png
)

for f in manifest.json "${FILES[@]}"; do
  [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }
done

VERSION="$(jq -r .version manifest.json)"
mkdir -p dist

package() {   # <browser> <jq filter for manifest.json> <output file>
  local browser="$1" filter="$2" out="dist/$3"
  local stage
  stage="$(mktemp -d)"
  cp --parents "${FILES[@]}" "$stage/"
  jq "$filter" manifest.json > "$stage/manifest.json"
  rm -f "$out"
  # -X: no extra file attributes (uid/gid, extended timestamps).
  (cd "$stage" && zip -qX -9 "$OLDPWD/$out" manifest.json "${FILES[@]}")
  rm -rf "$stage"
  echo "$browser: $out ($(du -h "$out" | cut -f1))"
}

build_firefox() {
  package firefox 'del(.background.service_worker, .minimum_chrome_version)' \
    "fast-venue-rank-$VERSION-firefox.xpi"
}

build_chrome() {
  package chrome 'del(.background.scripts, .browser_specific_settings)' \
    "fast-venue-rank-$VERSION-chrome.zip"
}

case "${1:-all}" in
  firefox) build_firefox ;;
  chrome)  build_chrome ;;
  all)     build_firefox; build_chrome ;;
  *) echo "usage: $0 [firefox|chrome]" >&2; exit 2 ;;
esac
