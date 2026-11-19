#!/usr/bin/env bash
# Runs the Gate 2 audit (immich/mobile/integration_test/audit) on the running
# Android emulator or iOS Simulator, signed in already, and takes a screenshot
# at every `AUDIT|shot|<name>` line. Results: <out>/audit.txt, <out>/*.png.
# flutter drive would uninstall the app (and the session) when done: --keep-app-running.
# Usage: audit.sh android|ios [out-dir]
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
platform="${1:?usage: audit.sh android|ios [out-dir]}"
out="${2:-${TMPDIR:-/tmp}/dc-audit-$platform-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$out"
case "$platform" in
  android)
    adb="${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools/adb"
    device=$("$adb" devices | awk 'NR>1 && $2=="device" {print $1; exit}')
    shot() { "$adb" -s "$device" exec-out screencap -p > "$out/$1.png"; } ;;
  ios)
    device=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)
    shot() { xcrun simctl io "$device" screenshot "$out/$1.png" >/dev/null 2>&1; } ;;
  *) echo "usage: audit.sh android|ios [out-dir]"; exit 2 ;;
esac
[ -n "${device:-}" ] || { echo "no $platform device running"; exit 1; }
cd "$here/../../immich/mobile"
flutter drive --driver=integration_test/audit/audit_driver.dart \
  --target=integration_test/audit/audit_test.dart -d "$device" --keep-app-running 2>&1 |
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$out/log.txt"
  case "$line" in *'AUDIT|'*)
    printf '%s\n' "${line#*AUDIT|}" >> "$out/audit.txt"
    case "$line" in *'AUDIT|shot|'*) shot "${line##*AUDIT|shot|}" ;; esac ;;
  esac
done
echo "results in $out"
