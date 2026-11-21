#!/usr/bin/env bash
# Self-test for check-identity.sh: passes on a minimal good app folder and
# fails on each way the identity can go wrong.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
good() {
  rm -rf "$t"/*; mkdir -p "$t/App" "$t/Resources"
  cat > "$t/project.yml" <<'Y'
name: DCPhotos
options:
  developmentLanguage: en
targets:
  DCPhotos:
    type: application
    info:
      properties:
        CFBundleDisplayName: Phosphor Photos
        CFBundleLocalizations: [en, ru]
    settings:
      base:
        PRODUCT_BUNDLE_IDENTIFIER: uz.daemonclient.photos
Y
  printf '%s\n' '{"sourceLanguage":"en","strings":{"":{},"Hallo":{"localizations":{"en":{"stringUnit":{"value":"Hello"}},"ru":{"stringUnit":{"value":"Привет"}}}}},"version":"1.0"}' > "$t/Resources/Localizable.xcstrings"
  printf '%s\n' '// HomeRoll in a comment is fine' 'final class DCPhotosAppDelegate {}' 'let title = "Phosphor Photos"' > "$t/App/App.swift"
}
expect() { IOS_DIR="$t" bash "$here/check-identity.sh" >/dev/null 2>&1; got=$?
  [ "$got" = "$1" ] || { echo "FAIL: $2 (exit $got, wanted $1)"; exit 1; }; }
good; expect 0 "a good app passes"
good; sed -i.b 's/uz.daemonclient.photos/org.homeroll.app/' "$t/project.yml"; expect 1 "HomeRoll's bundle id"
good; sed -i.b 's/Phosphor Photos/Photos/' "$t/project.yml"; expect 1 "the name \"Photos\""
good; printf '  FotosWidget:\n    type: app-extension\n' >> "$t/project.yml"; expect 1 "an extension target"
good; printf '%s\n' 'let g = "group.uz.daemonclient.photos"' >> "$t/App/App.swift"; expect 1 "an App Group"
good; printf '%s\n' 'enum WidgetFeeder {}' >> "$t/App/App.swift"; expect 1 "the widget feeder"
good; sed -i.b 's/"sourceLanguage":"en"/"sourceLanguage":"de"/' "$t/Resources/Localizable.xcstrings"; expect 1 "German as the source language"
good; sed -i.b 's/"ru":{"stringUnit":{"value":"Привет"}}/"de":{"stringUnit":{"value":"Hallo"}}/' "$t/Resources/Localizable.xcstrings"; expect 1 "German strings"
good; sed -i.b 's/,"ru":{"stringUnit":{"value":"Привет"}}//' "$t/Resources/Localizable.xcstrings"; expect 1 "a key without Russian"
good; printf '%s\n' 'Text("HomeRoll 1.0")' >> "$t/App/App.swift"; expect 1 "\"HomeRoll\" shown"
good; sed -i.b 's/CFBundleLocalizations: \[en, ru\]/CFBundleLocalizations: [en, de, ru]/' "$t/project.yml"; expect 1 "German localization listed"
good; printf '%s\n' 'let d = UserDefaults(suiteName: "group.so.phosphor.photos")' >> "$t/App/App.swift"; expect 1 "a shared defaults suite"
good; printf '%s\n' 'let u = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: x)' >> "$t/App/App.swift"; expect 1 "a group container"
good; printf '%s\n' 'q[kSecAttrAccessGroup] = g' >> "$t/App/App.swift"; expect 1 "a shared Keychain group"
good; printf '%s\n' 'c.sharedContainerIdentifier = g' >> "$t/App/App.swift"; expect 1 "a shared upload container"
good; printf '    entitlements:\n      path: App/X.entitlements\n' >> "$t/project.yml"; expect 1 "an entitlements key"
good; touch "$t/App/X.entitlements"; expect 1 "an entitlements file"
good; printf '  Clip:\n    type: app-clip\n' >> "$t/project.yml"; expect 1 "an app clip"
good; printf '%s\n' 'let s = "homeroll://asset/1"' >> "$t/App/App.swift"; expect 1 "a lowercase homeroll id"
good; printf '%s\n' '{ not json' > "$t/Resources/Broken.xcstrings"; expect 1 "a malformed catalog"
good; printf '%s\n' '// From the old Shared/AppGroup.swift' >> "$t/App/App.swift"; expect 0 "a comment naming the old file"
good; printf '<plist><dict><key>CFBundleDisplayName</key><string>HomeRoll</string></dict></plist>\n' > "$t/App/Info.plist"; expect 1 "HomeRoll as the plist display name"
good; printf '<plist><dict><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>phosphor</string></array></dict></array></dict></plist>\n' > "$t/App/Info.plist"; expect 1 "a registered URL scheme"
good; printf '        NSCameraUsageDescription: HomeRoll needs the camera\n' >> "$t/project.yml"; expect 1 "HomeRoll in a permission text"
good; printf '%s\n' 'let g = "group.x.y" // HomeRoll' >> "$t/App/App.swift"; expect 1 "an App Group behind a HomeRoll comment"
good; printf '%s\n' '{"sourceLanguage":"en","strings":{"CFBundleDisplayName":{"localizations":{"en":{"stringUnit":{"value":"Phosphor Photos"}},"ru":{"stringUnit":{"value":"Фото"}}}}},"version":"1.0"}' > "$t/Resources/InfoPlist.xcstrings"; expect 1 "another home-screen name in Russian"
good; printf '%s\n' '{"sourceLanguage":"en","strings":{"CFBundleDisplayName":{"localizations":{"en":{"stringUnit":{"value":"Phosphor Photos"}},"ru":{"stringUnit":{"value":"Phosphor Photos"}}}}},"version":"1.0"}' > "$t/Resources/InfoPlist.xcstrings"; expect 0 "the home-screen name in both languages"
echo "check-identity self-test: ok"
