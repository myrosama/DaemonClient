#!/bin/sh
# Installs the approved Photos app icon ("fanned gallery", approved by the
# operator 2026-10-29; files and sources in docs/mobile/icons/) into
# immich/mobile at every size iOS and Android need. macOS only (sips).
# Usage: sh mobile/tools/brand/install-photos-icon.sh
set -eu
repo=$(cd "$(dirname "$0")/../../.." && pwd)
src="$repo/docs/mobile/icons"
app="$repo/immich/mobile"
ios="$app/ios/Runner/Assets.xcassets/AppIcon.appiconset"
res="$app/android/app/src/main/res"

fit() { sips -z "$2" "$2" "$1" --out "$3" >/dev/null; }

# iOS: every slot of the AppIcon set, from the opaque square (iOS rounds it).
for n in 16 20 29 32 40 48 50 55 57 58 60 64 66 72 76 80 87 88 92 100 102 114 \
         120 128 144 152 167 172 180 196 216 256 512 1024; do
  fit "$src/photos-ios-1024.png" "$n" "$ios/$n.png"
done

# Android: density:legacy-size:adaptive-size (adaptive canvas = 108 dp).
for d in mdpi:48:108 hdpi:72:162 xhdpi:96:216 xxhdpi:144:324 xxxhdpi:192:432; do
  density=${d%%:*}; rest=${d#*:}; legacy=${rest%%:*}; adaptive=${rest#*:}
  fit "$src/photos-ios-1024.png" "$legacy" "$res/mipmap-$density/ic_launcher.png"
  fit "$src/photos-adaptive-foreground-1024.png" "$adaptive" "$res/mipmap-$density/ic_launcher_foreground.png"
  fit "$src/photos-adaptive-monochrome-1024.png" "$adaptive" "$res/mipmap-$density/ic_launcher_monochrome.png"
done

# The icon generator's sources (pubspec.yaml `flutter_launcher_icons`), so
# re-running it keeps this icon.
cp "$src/photos-ios-1024.png" "$app/assets/immich-logo-w-bg.png"
fit "$src/photos-adaptive-foreground-1024.png" 324 "$app/assets/immich-logo-android-adaptive-icon.png"
echo "Photos icon installed."
