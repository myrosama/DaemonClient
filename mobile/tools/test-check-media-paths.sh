#!/usr/bin/env bash
# Self-test for check-media-paths.sh: it passes on clean code and fails on
# each way of reading bytes from the worker.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
mkdir -p "$t/utils" "$t/x"
good() {
  printf "%s\n" "String a(String id) => '\${CoreMedia.viewerBase}/api/assets/\$id/original';" > "$t/utils/image_url_builder.dart"
  printf "%s\n" "final u = '\${CoreMedia.viewerBase}/api/assets/\$id/\$postfix';" \
    "final c = '\$serverEndpoint/assets/\$id/thumbnail'; // media-paths: allowed (cast)" > "$t/x/ok.dart"
  rm -f "$t/x/bad.dart"
}
expect() { # want description
  MEDIA_PATHS_LIB="$t" bash "$here/check-media-paths.sh" >/dev/null 2>&1; got=$?
  if [ "$got" != "$1" ]; then echo "FAIL: $2 (exit $got, wanted $1)"; exit 1; fi
}
good; expect 0 "clean code passes"
good; printf "%s\n" "final u = '\${Store.get(StoreKey.serverEndpoint)}/assets/\$id/original';" > "$t/x/bad.dart"; expect 1 "a worker URL"
good; printf "%s\n" "final base = endpoint;" "final u = '\$base/assets/\$id/thumbnail';" > "$t/x/bad.dart"; expect 1 "a worker URL through another variable"
good; printf "%s\n" "final r = await _api.downloadAssetWithHttpInfo(id);" > "$t/x/bad.dart"; expect 1 "the API's download call"
good; printf "%s\n" "String a(String id) => '\${Store.get(StoreKey.serverEndpoint)}/assets/\$id/original';" > "$t/utils/image_url_builder.dart"; expect 1 "the builder on the worker"
good; rm "$t/utils/image_url_builder.dart"; expect 1 "the builder moved away"
echo "check-media-paths self-test: ok"
