#!/usr/bin/env bash
# P2 task 2.3: the app reads every picture and video through the core's local
# server, never the worker's byte routes (SPEC D23). Over the app's Dart
# (generated code aside):
#  1. a URL under /assets/<id>/ is built only on the core's addresses
#     (`CoreMedia.`, or in lib/utils/image_url_builder.dart, which builds them
#     from `CoreMedia`) — never on Immich's server endpoint;
#  2. the generated API's byte calls (downloadAsset, downloadArchive,
#     viewAsset, playAssetVideo) are not called.
# shortcut: inside the builder only lines naming `serverEndpoint` are caught
# (a variable holding it is not); the file is small and reviewed per change.
# A line may opt out with a `media-paths: allowed (<why>)` comment.
# MEDIA_PATHS_LIB points it at another folder (its self-test).
set -uo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
lib="${MEDIA_PATHS_LIB:-$root/immich/mobile/lib}"
builder="$lib/utils/image_url_builder.dart"
[ -f "$builder" ] || { echo "missing ${builder#$root/} (moved upstream? update this check)"; exit 1; }
fail=0
scan() { grep -rnE --include='*.dart' "$1" "$lib" | grep -v '/generated/' | grep -v 'media-paths: allowed'; }

outside=$(scan "/assets/" | grep -v '^[^:]*/utils/image_url_builder\.dart:' | grep -v 'CoreMedia\.')
inside=$(scan "/assets/" | grep '^[^:]*/utils/image_url_builder\.dart:' | grep 'serverEndpoint')
if [ -n "$outside$inside" ]; then
  echo "a byte URL not built on the core's local server (use CoreMedia / image_url_builder):"
  printf '%s\n%s\n' "$outside" "$inside" | grep . | sed "s|$root/||"
  fail=1
fi
calls=$(scan '(downloadAsset|downloadArchive|viewAsset|playAssetVideo)(WithHttpInfo)?\(')
if [ -n "$calls" ]; then
  echo "a worker byte route called through the API (read through the core instead):"
  echo "$calls" | sed "s|$root/||"
  fail=1
fi
[ "$fail" = 0 ] && echo "media paths: ok"
exit "$fail"
