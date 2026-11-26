#!/usr/bin/env bash
# I2/I3 (docs/mobile/plans/I2-I3-v1-scope.md): every server route the app calls is one the worker really serves
# (tools/v1-routes.txt). A route outside it is a feature v1 does not have. IOS_DIR points it at another folder.
set -uo pipefail
ios="${IOS_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
here="$(cd "$(dirname "$0")" && pwd)"
python3 - "$ios" "$here/v1-routes.txt" <<'PY'
import pathlib, re, sys
ios, allowed = pathlib.Path(sys.argv[1]), set()
for line in pathlib.Path(sys.argv[2]).read_text().splitlines():
    line = line.split('#')[0].strip()
    if line: allowed.add(line)
# request("…"), raw("…"), url("…"): the route, with every \(…) interpolation as {}
call = re.compile(r'\b(?:request|raw|url)\(\s*"((?:[^"\\]|\\.)*)"')
bad = []
for f in sorted((ios / 'App').rglob('*.swift')):
    for n, line in enumerate(f.read_text().splitlines(), 1):
        if line.lstrip().startswith('//'): continue
        for m in call.finditer(line):
            route = re.sub(r'\\\((?:[^()]|\([^()]*\))*\)', '{}', m.group(1)).removeprefix('api/')
            if route not in allowed: bad.append(f'{f.relative_to(ios)}:{n}: {route}')
if bad:
    print('✗ routes v1 does not serve:\n' + '\n'.join(bad)); sys.exit(1)
print('ios routes: ok')
PY
