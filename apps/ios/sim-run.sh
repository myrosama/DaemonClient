#!/bin/bash
# Builds the app and starts it on the booted Simulator, signed in by token (no password typed).
# The token comes from a file, never the repo: FOTOS_SERVER=<worker URL> FOTOS_TOKEN_FILE=<file> ./sim-run.sh
set -euo pipefail
cd "$(dirname "$0")"
../../core/dc-ffi/build-ios.sh >/dev/null   # never link a stale core
xcodegen generate -q
xcodebuild -project DCPhotos.xcodeproj -scheme DCPhotos \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath build -quiet build 2>&1 \
  | grep -E "error:|warning: unre" || true
test -d build/Build/Products/Debug-iphonesimulator/DCPhotos.app
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/DCPhotos.app
SIMCTL_CHILD_FOTOS_SERVER="${FOTOS_SERVER:?FOTOS_SERVER is missing (the worker URL)}" \
SIMCTL_CHILD_FOTOS_TOKEN="$(cat "${FOTOS_TOKEN_FILE:?FOTOS_TOKEN_FILE is missing}")" \
SIMCTL_CHILD_FOTOS_BACKUP_OFF="${FOTOS_BACKUP_OFF:-1}" \
  xcrun simctl launch --terminate-running-process booted uz.daemonclient.photos >/dev/null
echo "started"
