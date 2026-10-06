#!/usr/bin/env bash
# Makes Flutter not incorrectly append `-sdk` arguments to simulator builds
# This breaks macros that must build for the host's platform
#
# Flutter was informed of this (https://github.com/flutter/flutter/issues/146122) but has not fixed it in 2 years
#
# From upstream Immich (immich-app/immich PR #30821, mobile/ios/scripts/xcode_flutter_patch.sh).
# DaemonClient notes: flutter#146122 was closed in 2024 as an Xcode problem, but
# the failure still reproduces with Xcode 27 + Flutter 3.41.7 (docs/mobile/RESEARCH.md §7).
# DaemonClient changes: also finds a Flutter SDK installed by mise's `flutter`
# tool (SDK at the install root, not under `flutter/`) or named by FLUTTER_ROOT
# (CI); fails loudly if the file is missing or the patch did not take.

set -eu
root="${MISE_TOOL_INSTALL_PATH:-${FLUTTER_ROOT:-$(mise where flutter)}}"
if [ -d "$root/flutter/packages/flutter_tools" ]; then sdk="$root/flutter"; else sdk="$root"; fi
mac_dart="$sdk/packages/flutter_tools/lib/src/ios/mac.dart"
# DaemonClient change: a wrong path must fail loudly, not silently skip the patch.
[ -f "$mac_dart" ] || { echo "xcode_flutter_patch: $mac_dart not found" >&2; exit 1; }

pattern="buildCommands.addAll(<String>['-sdk', XcodeSdk.IPhoneSimulator.platformName]);"

# Filter out the sdk arg pattern
if awk -v pat="$pattern" 'index($0, pat) { found=1; next } { print } END { exit !found }' "$mac_dart" > "$mac_dart.tmp"; then
  # If it was filtered out, apply it
  mv "$mac_dart.tmp" "$mac_dart"

  # Force flutter itself to rebuild
  rm -f "$sdk/bin/cache/flutter_tools.snapshot" "$sdk/bin/cache/flutter_tools.stamp"

  echo "flutter postinstall: removed simulator -sdk flag from xcodebuild invocation"
else
  rm -f "$mac_dart.tmp"
fi

# DaemonClient change: verify, so a read-only SDK cannot pass silently.
if grep -qF "$pattern" "$mac_dart"; then
  echo "xcode_flutter_patch: patch not applied to $mac_dart" >&2
  exit 1
fi
