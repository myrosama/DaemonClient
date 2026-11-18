#!/usr/bin/env bash
# P2 task 2.1: the Photos app carries no Immich identity the system sees —
# bundle ids, app group, background-task ids, signing team, verified web
# domain — and the app group is the same everywhere it is named.
# Run from anywhere; exits non-zero on the first kind of problem it lists.
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
app="$root/immich/mobile"
fail=0

# The places the system reads identity from (not Dart's Immich links: 2.10).
files=(
  "$app/ios/Runner.xcodeproj/project.pbxproj"
  "$app/ios/Runner/Info.plist"
  "$app"/ios/*/*.entitlements
  "$app/ios/Runner/Core/URLSessionManager.swift"
  "$app/ios/Runner/Background/BackgroundWorkerApiImpl.swift"
  "$app/ios/WidgetExtension/ImmichAPI.swift"
)
manifest="$app/android/app/src/main/AndroidManifest.xml"
gradle="$app/android/app/build.gradle"
for f in "${files[@]}" "$manifest" "$gradle"; do
  [ -f "$f" ] || { echo "missing ${f#$root/} (moved upstream? update this check)"; fail=1; }
done
for old in 'app\.alextran\.immich' 'app\.futo\.immich' 'group\.app\.immich' \
           'my\.immich\.app' '2W7AC6T8T5' 'immich_mobile'; do
  # -s: a missing file is reported above, not taken for "no match".
  if hits=$(grep -snE "$old" "${files[@]}"); then
    echo "still Immich's ($old):"; echo "$hits" | sed "s|$root/||"; fail=1
  fi
done

group='group.uz.daemonclient.photos'
entitlements=("$app"/ios/*/*.entitlements)
[ "${#entitlements[@]}" = 4 ] || { echo "expected 4 entitlements files, found ${#entitlements[@]}"; fail=1; }
for f in "${entitlements[@]}"; do
  grep -qxF "<string>$group</string>" <(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$f") \
    || { echo "no app group $group in ${f#$root/}"; fail=1; }
done
for spec in "ios/Runner/Core/URLSessionManager.swift:let APP_GROUP = \"$group\"" \
            "ios/WidgetExtension/ImmichAPI.swift:let IMMICH_SHARE_GROUP = \"$group\"" \
            "lib/constants/constants.dart:const String appShareGroupId = \"$group\";"; do
  f="$app/${spec%%:*}"; line="${spec#*:}"
  grep -qF "$line" "$f" || { echo "app group is not $group in ${spec%%:*}"; fail=1; }
done
# The extensions read the group from Info.plist's AppGroupId = $(CUSTOM_GROUP_ID).
pbx="$app/ios/Runner.xcodeproj/project.pbxproj"
right=$(grep -cF "CUSTOM_GROUP_ID = $group;" "$pbx")
all=$(grep -c "CUSTOM_GROUP_ID = " "$pbx")
[ "$right" = 6 ] && [ "$all" = 6 ] || { echo "CUSTOM_GROUP_ID: $right of $all are $group (expected 6 of 6)"; fail=1; }

# Android: the manifest keeps `app.alextran.immich` class names (the Kotlin
# package stays), so only the verified domain is banned there.
if hits=$(grep -sn 'my\.immich\.app' "$manifest"); then
  echo "still Immich's (my.immich.app):"; echo "$hits" | sed "s|$root/||"; fail=1
fi
grep -sqF 'applicationId "uz.daemonclient.photos"' "$gradle" \
  || { echo "android applicationId is not uz.daemonclient.photos"; fail=1; }
# iOS: all nine bundle ids are ours (3 configurations × app, share, widget).
ours=$(grep -cE 'PRODUCT_BUNDLE_IDENTIFIER = uz\.daemonclient\.photos(\.(debug|profile))?(\.(ShareExtension|Widget))?;' "$pbx")
[ "$ours" = 9 ] || { echo "PRODUCT_BUNDLE_IDENTIFIER: $ours of 9 are ours"; fail=1; }

[ "$fail" = 0 ] && echo "identity: ok"
exit "$fail"
