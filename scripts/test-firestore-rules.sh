#!/usr/bin/env bash
# Checks firestore.rules against the cases below WITHOUT deploying, using the
# Firebase Rules API's test endpoint. Needs `gcloud` signed in to an account
# that can read the project's rules.   Usage: scripts/test-firestore-rules.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT="${PROJECT:-daemonclient-c0625}"
BODY="$(mktemp)"; RESULT="$(mktemp)"; trap 'rm -f "$BODY" "$RESULT"' EXIT
export BODY RESULT
python3 - "$PROJECT" <<'PY' > "$BODY"
import json, sys
project = sys.argv[1]
rules = open('firestore.rules').read()
base = '/databases/(default)/documents/artifacts/default-daemon-client/users'
def case(expect, method, path, uid='u1', data=None):
    req = {'path': path, 'method': method}
    if uid: req['auth'] = {'uid': uid}
    c = {'expectation': expect, 'request': req}
    if method in ('update', 'delete', 'get'):
        c['resource'] = {'data': data or {'x': 1}}
    return c
cases = [
  case('ALLOW', 'get',    f'{base}/u1/config/cloudflare'),
  case('DENY',  'update', f'{base}/u1/config/cloudflare'),
  case('DENY',  'create', f'{base}/u1/config/cloudflare'),
  case('DENY',  'delete', f'{base}/u1/config/cloudflare'),
  case('DENY',  'update', '/databases/(default)/documents/artifacts/other-app/users/u1/config/cloudflare'),
  case('ALLOW', 'update', f'{base}/u1/config/telegram'),
  case('ALLOW', 'delete', f'{base}/u1/config/telegram'),
  case('ALLOW', 'create', f'{base}/u1/photos/p1'),
  case('ALLOW', 'update', f'{base}/u1/profile/settings'),
  case('DENY',  'get',    f'{base}/u1/config/cloudflare', uid='u2'),
  case('DENY',  'update', f'{base}/u1/config/telegram', uid='u2'),
  case('DENY',  'get',    f'{base}/u1/config/cloudflare', uid=None),
  case('ALLOW', 'get',    '/databases/(default)/documents/global/announcement'),
  case('DENY',  'update', '/databases/(default)/documents/global/announcement'),
]
print(json.dumps({'source': {'files': [{'name': 'firestore.rules', 'content': rules}]},
                  'testSuite': {'testCases': cases}}))
PY
TOKEN="$(gcloud auth print-access-token)"
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" \
  -H 'Content-Type: application/json' --data @"$BODY" \
  "https://firebaserules.googleapis.com/v1/projects/$PROJECT:test" > "$RESULT"
unset TOKEN
python3 - <<'PY'
import json
import os
r = json.load(open(os.environ['RESULT']))
if 'error' in r: raise SystemExit(f"API error: {r['error'].get('message')}")
body = json.load(open(os.environ['BODY']))['testSuite']['testCases']
fails = 0
for c, res in zip(body, r.get('testResults', [])):
    ok = res.get('state') == 'SUCCESS'
    fails += not ok
    print(('ok    ' if ok else 'FAIL  ') + c['expectation'].ljust(6) + c['request']['method'].ljust(7) + c['request']['path'].split('/documents/')[1] + ('' if 'auth' in c['request'] else '  (signed out)') + ('' if ok else '  ' + json.dumps(res.get('debugMessages', []))[:200]))
if len(r.get('testResults', [])) != len(body): raise SystemExit('result count mismatch')
print(f"{len(body) - fails}/{len(body)} rule cases pass")
raise SystemExit(1 if fails else 0)
PY
