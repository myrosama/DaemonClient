#!/usr/bin/env bash
# Self-test for check-routes.sh: a served route passes, any other fails; ids and comments handled.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
t="$(mktemp -d)"; trap 'rm -rf "$t"' EXIT
mkdir -p "$t/App"
expect() { printf '%s\n' "$2" > "$t/App/A.swift"; IOS_DIR="$t" bash "$here/check-routes.sh" >/dev/null 2>&1; got=$?
  [ "$got" = "$1" ] || { echo "FAIL: $3 (exit $got, wanted $1)"; exit 1; }; }
expect 0 'let a = try await request("albums")' "a served route"
expect 0 'let u = try? url("assets/\(id)/thumbnail", query: q)' "an id becomes {}"
expect 0 'let u = try? url("assets/\(ids[0].id)/original")' "a nested interpolation becomes {}"
expect 0 '// let p = try await request("people")' "a commented-out call"
expect 1 'let p = try await request("people")' "a route v1 does not serve"
expect 1 'try await raw("assets/\(id)/edits", method: "DELETE")' "an unserved sub-route of a served one"
echo "check-routes self-test: ok"
