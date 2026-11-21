#!/bin/bash
# Baut die App und startet sie im gebooteten Simulator, angemeldet per Token (kein Passwort-Tippen).
# Token kommt aus einer Datei (nie ins Repo): FOTOS_SERVER=http://<server>:2283 FOTOS_TOKEN_FILE=~/.homeroll-token ./sim-run.sh
set -euo pipefail
cd "$(dirname "$0")"
xcodegen generate -q
xcodebuild -project HomeRoll.xcodeproj -scheme HomeRoll \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build -quiet build 2>&1 \
  | grep -E "error:|warning: unre" || true
test -d build/Build/Products/Debug-iphonesimulator/HomeRoll.app
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/HomeRoll.app
SIMCTL_CHILD_FOTOS_SERVER="${FOTOS_SERVER:?FOTOS_SERVER fehlt, z. B. http://192.168.1.10:2283}" \
SIMCTL_CHILD_FOTOS_TOKEN="$(cat "${FOTOS_TOKEN_FILE:?Token-Datei fehlt}")" \
SIMCTL_CHILD_FOTOS_BACKUP_OFF="${FOTOS_BACKUP_OFF:-1}" \
  xcrun simctl launch --terminate-running-process booted org.homeroll.app >/dev/null
echo "gestartet"
