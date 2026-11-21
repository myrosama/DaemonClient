#!/usr/bin/env bash
# I1 (docs/mobile/plans/I1-identity.md): the iPhone app carries our identity,
# nothing of HomeRoll's, no shared container (I0b) and only English + Russian
# (SPEC D28, D30, D31: the app is "Phosphor Photos"). IOS_DIR points it at another folder (its self-test).
set -uo pipefail
ios="${IOS_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
fail=0
bad() { printf '✗ %b\n' "$*"; fail=1; }

# 1. HomeRoll's ids, the App Group, the widget feeder, a registered URL scheme.
hits=$(grep -rnE 'org\.homeroll|application-groups|AppGroup|WidgetFeeder|CFBundleURLSchemes|group\.(org|com|net|io|app|uz|dev)\.' "$ios" \
  --include='*.swift' --include='*.yml' --include='*.plist' --include='*.entitlements' 2>/dev/null)
[ -z "$hits" ] || bad "HomeRoll's identity or a shared container is left:\n$hits"

# 2. The project: our bundle id and name, one target (no extensions).
p="$ios/project.yml"
if [ ! -f "$p" ]; then bad "no project.yml"; else
  grep -qE '^\s*PRODUCT_BUNDLE_IDENTIFIER: uz\.daemonclient\.photos\s*$' "$p" || bad "bundle id is not uz.daemonclient.photos"
  grep -qE '^\s*CFBundleDisplayName: Phosphor Photos\s*$' "$p" || bad "display name is not \"Phosphor Photos\""
  n=$(grep -cE '^\s+type: (application|app-extension)' "$p")
  [ "$n" = 1 ] || bad "$n targets, expected 1 (no extensions)"
  grep -qE '^\s*developmentLanguage: en\s*$' "$p" || bad "developmentLanguage is not en"
  grep -qE 'CFBundleLocalizations: \[en, ru\]' "$p" || bad "CFBundleLocalizations is not [en, ru]"
fi

# 3. String catalogs: English source, English and Russian for every key, no German.
out=$(python3 - "$ios" <<'PY'
import json, pathlib, sys
for f in sorted(pathlib.Path(sys.argv[1]).rglob('*.xcstrings')):
    d = json.loads(f.read_text())
    if d.get('sourceLanguage') != 'en': print(f'{f.name}: source language {d.get("sourceLanguage")!r}, not en')
    for k, v in d['strings'].items():
        locs = v.get('localizations') or {}
        if 'de' in locs: print(f'{f.name}: German left for {k[:50]!r}'); continue
        if k and not ({'en', 'ru'} <= set(locs)): print(f'{f.name}: {k[:50]!r} lacks {sorted({"en","ru"} - set(locs))}')
        for l in locs.values():
            if 'HomeRoll' in json.dumps(l): print(f'{f.name}: "HomeRoll" shown for {k[:50]!r}')
PY
)
[ -z "$out" ] || bad "string catalogs:\n$(printf '%s' "$out" | head -20)"

# 4. "HomeRoll" never shown: not inside a Swift string literal (comments and
#    type names are not shown).
shown=$(grep -rnE '"[^"]*HomeRoll[^"]*"' "$ios" --include='*.swift' 2>/dev/null | grep -vE '^[^:]+:[0-9]+:\s*//')
[ -z "$shown" ] || bad "\"HomeRoll\" shown to users:\n$shown"

[ "$fail" = 0 ] && echo "ios identity: ok"
exit "$fail"
