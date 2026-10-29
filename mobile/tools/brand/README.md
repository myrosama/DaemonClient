# Brand images for the phone apps

The Photos app's icons, launch screens and in-app logos are rendered from the
one DaemonClient logo in the repository, `drive/public/logo.png` (536 × 446).
There is no vector version, so everything is drawn from that PNG on macOS:

```sh
mkdir -p /tmp/brand
swift render-apple-and-app.swift ../../../drive/public/logo.png /tmp/brand
swift render-android.swift       ../../../drive/public/logo.png /tmp/brand
```

Re-running both on the same logo reproduces the committed images byte for
byte (checked 2026-10-27, 58 files). Copy the outputs as follows; paths are
under `immich/mobile/`.

| Output | Destination |
|---|---|
| `icon-<n>.png` | `ios/Runner/Assets.xcassets/AppIcon.appiconset/<n>.png`; `icon-1024.png` also → `assets/immich-logo-w-bg.png` |
| `LaunchImage{,@2x,@3x}.png` | `ios/Runner/Assets.xcassets/LaunchImage.imageset/` |
| `logo-1024.png` | `assets/immich-logo.png` |
| `text-{light,dark}.png` | `assets/immich-text-{light,dark}.png` |
| `inline-{light,dark}.png` | `assets/immich-logo-inline-{light,dark}.png`, and wrapped as base64 in an `<image>` of the same width and height in `assets/immich-logo-inline-{light,dark}.svg` |
| `android-<density>-foreground.png` | `android/app/src/main/res/mipmap-<density>/ic_launcher_foreground.png`; `xxhdpi` also → `assets/immich-logo-android-adaptive-icon.png` |
| `android-<density>-legacy.png` | `android/app/src/main/res/mipmap-<density>/ic_launcher.png` |
| `android-<density>-splash.png` | `android/app/src/main/res/drawable-<density>/splash.png`; `xxxhdpi` also → `assets/immich-splash.png` |
| `android-<density>-android12splash.png` | `android/app/src/main/res/drawable{,-night}-<density>/android12splash.png`; `xxxhdpi` also → `assets/immich-splash-android12.png` |

The `assets/immich-*` files keep Immich's names on purpose: the app's code and
the icon/splash generator configs (`pubspec.yaml` `flutter_launcher_icons`,
`flutter_native_splash.yaml`) refer to them, and keeping the names keeps the
fork's diff small. Because those generator sources now hold our images,
re-running the generators no longer brings the Immich logo back.

The adaptive-icon background colour is white:
`android/app/src/main/res/values/colors.xml` `ic_launcher_background`.
