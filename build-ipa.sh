#!/bin/bash
# Baut eine unsignierte .ipa zum Sideloaden (AltStore/SideStore signieren sie mit deiner Apple-ID neu).
# Ergebnis: build-ipa/HomeRoll.ipa
#
# Optionen:
#   (keine)                 unsigniert bauen, ad-hoc signieren, Pfad-Prüfung aktiv (für veröffentlichte IPAs)
#   --local-sign [IDENTITÄT]  Xcode-Signierung bleibt aus; danach lokal mit deinem Zertifikat signieren
#                           (ohne Angabe: erstes "Apple Development" im Schlüsselbund, sonst ad-hoc)
#                           und die Pfad-Prüfung überspringen – nur für den eigenen Gebrauch
#   -h, --help              diese Hilfe
set -euo pipefail
cd "$(dirname "$0")"

LOCAL_SIGN=0
SIGN_ID="-"   # "-" = ad-hoc
while [ $# -gt 0 ]; do
  case "$1" in
    --local-sign)
      LOCAL_SIGN=1
      if [ $# -gt 1 ] && [[ "$2" != -* ]]; then SIGN_ID="$2"; shift; fi ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unbekannte Option: $1 (siehe --help)" >&2; exit 2 ;;
  esac
  shift
done
if [ "$LOCAL_SIGN" = 1 ] && [ "$SIGN_ID" = "-" ]; then
  FOUND=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development:[^"]*\)".*/\1/p' | head -1)
  if [ -n "$FOUND" ]; then SIGN_ID="$FOUND"; else echo "Kein Apple-Development-Zertifikat gefunden – signiere ad-hoc."; fi
fi
echo "Signatur: $([ "$SIGN_ID" = "-" ] && echo ad-hoc || echo "$SIGN_ID")"
xcodegen generate -q
rm -rf build-ipa
if ! xcodebuild -project HomeRoll.xcodeproj -scheme HomeRoll -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' -derivedDataPath build-ipa \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" \
  OTHER_SWIFT_FLAGS="-file-prefix-map $PWD=." OTHER_CFLAGS="-ffile-prefix-map=$PWD=." \
  STRIP_INSTALLED_PRODUCT=YES DEPLOYMENT_POSTPROCESSING=YES STRIP_STYLE=non-global -quiet build > build-ipa.log 2>&1; then
  echo "BUILD FEHLGESCHLAGEN – Fehler:"
  grep -E "error:|fatal error|Stack dump|Please submit a bug report" -A5 build-ipa.log | head -80 || true
  echo "Volles Protokoll: $PWD/build-ipa.log"
  exit 1
fi
APP="build-ipa/Build/Products/Release-iphoneos/HomeRoll.app"
[ -d "$APP" ] || { echo "FEHLER: $APP nicht gefunden"; exit 1; }
rm -rf Payload; mkdir Payload; cp -R "$APP" Payload/
# Ad-hoc mit Berechtigungen signieren: Sideload-Werkzeuge lesen daraus die App-Gruppe (Widget + Teilen-Erweiterung)
P=Payload/HomeRoll.app
codesign -f -s "$SIGN_ID" --entitlements Widget/FotosWidget.entitlements "$P/PlugIns/FotosWidget.appex"
codesign -f -s "$SIGN_ID" --entitlements Share/FotosShare.entitlements "$P/PlugIns/FotosShare.appex"
codesign -f -s "$SIGN_ID" --entitlements App/HomeRoll.entitlements "$P"
# Keine Spuren des Bau-Rechners veröffentlichen (Baupfade enthalten sonst den Mac-Benutzernamen)
if [ "$LOCAL_SIGN" = 0 ] && grep -raqiF -e "$USER" -e "$HOME" Payload; then
  echo "FEHLER: Benutzername oder Home-Pfad in der App – aus einem neutralen Ordner bauen (z. B. git clone nach /tmp/build)."
  rm -rf Payload; exit 1
fi
zip -qr build-ipa/HomeRoll.ipa Payload; rm -rf Payload
echo "Fertig: build-ipa/HomeRoll.ipa"
