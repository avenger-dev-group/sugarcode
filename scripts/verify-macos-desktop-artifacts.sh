#!/usr/bin/env bash

set -euo pipefail

architecture="${1:-}"
case "$architecture" in
  arm64 | x64) ;;
  *)
    echo "Usage: $0 <arm64|x64>" >&2
    exit 1
    ;;
esac

workspace_root="$(cd "$(dirname "$0")/.." && pwd)"
make_directory="$workspace_root/apps/desktop/out/make"
zip_directory="$make_directory/zip/darwin/$architecture"
dmg_count="$(find "$make_directory" -maxdepth 1 -type f -name 'SugarCode-*.dmg' | wc -l | tr -d ' ')"
zip_count="$(find "$zip_directory" -maxdepth 1 -type f -name 'SugarCode-*.zip' | wc -l | tr -d ' ')"

test "$dmg_count" = "1" || {
  echo "Expected one macOS DMG, found $dmg_count." >&2
  exit 1
}
test "$zip_count" = "1" || {
  echo "Expected one macOS ZIP for $architecture, found $zip_count." >&2
  exit 1
}

dmg_path="$(find "$make_directory" -maxdepth 1 -type f -name 'SugarCode-*.dmg' -print -quit)"
zip_path="$(find "$zip_directory" -maxdepth 1 -type f -name 'SugarCode-*.zip' -print -quit)"
mount_directory="$(mktemp -d /tmp/sugarcode-desktop-dmg.XXXXXX)"
attached=false

cleanup() {
  if [ "$attached" = true ]; then
    hdiutil detach "$mount_directory" >/dev/null 2>&1 || true
  fi
  rmdir "$mount_directory" >/dev/null 2>&1 || true
}
trap cleanup EXIT

hdiutil verify "$dmg_path" >/dev/null
hdiutil attach -readonly -nobrowse -mountpoint "$mount_directory" "$dmg_path" >/dev/null
attached=true

application_path="$mount_directory/SugarCode.app"
info_plist="$application_path/Contents/Info.plist"
native_module="$application_path/Contents/Resources/sugarcode-desktop-native.node"
source_version="$(node -p "require('$workspace_root/apps/desktop/package.json').version")"

test -d "$application_path"
test -L "$mount_directory/Applications"
test "$(readlink "$mount_directory/Applications")" = "/Applications"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$info_plist")" = "com.simonf.sugarcode"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$info_plist")" = "$source_version"
codesign --verify --deep --strict --verbose=2 "$application_path"

case "$architecture" in
  arm64)
    file "$native_module" | grep -q 'arm64'
    ;;
  x64)
    file "$native_module" | grep -q 'x86_64'
    ;;
esac

unzip -tq "$zip_path"
shasum -a 256 "$dmg_path" "$zip_path"

hdiutil detach "$mount_directory" >/dev/null
attached=false
rmdir "$mount_directory"
trap - EXIT

echo "Verified macOS $architecture DMG and ZIP artifacts."
