#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
SRC_DIR="$ROOT_DIR/src"
CHROME_DIR="$DIST_DIR/chrome"
FIREFOX_DIR="$DIST_DIR/firefox"

rm -f "$DIST_DIR/firefox.zip" "$DIST_DIR/firefox.xpi"
mkdir -p "$CHROME_DIR" "$FIREFOX_DIR"

rsync -a --delete "$SRC_DIR/" "$CHROME_DIR/"
rsync -a --delete "$SRC_DIR/" "$FIREFOX_DIR/"

cp "$ROOT_DIR/manifest.chrome.json" "$CHROME_DIR/manifest.json"
cp "$ROOT_DIR/manifest.firefox.json" "$FIREFOX_DIR/manifest.json"

node "$ROOT_DIR/scripts/bundle-firefox.mjs"

(
  cd "$DIST_DIR"
  zip -r -q firefox.zip firefox
  cp firefox.zip firefox.xpi
)

echo "Build done"
