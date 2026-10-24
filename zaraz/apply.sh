#!/bin/bash
# Apply zaraz/config.json + zaraz/consent.css to the avto2000.com zone (Zaraz is in
# "realtime" mode: changes are live immediately). debugKey and zarazVersion are read
# from the live config, so they never sit in this public repo.
#   ./zaraz/apply.sh            (needs: npx cf auth create avto2000; cf auth activate avto2000 .)
set -euo pipefail
cd "$(dirname "$0")/.."
cf() { env -u CLOUDFLARE_API_TOKEN -u CLOUDFLARE_ACCOUNT_ID npx -y cf "$@"; }
live=$(cf zaraz config get -z avto2000.com)
body=$(LIVE="$live" python3 - <<'PY'
import json, os
live = json.loads(os.environ['LIVE'])
c = json.load(open('zaraz/config.json'))
c['debugKey'] = live['debugKey']; c['zarazVersion'] = live['zarazVersion']
c['consent']['customCSS'] = open('zaraz/consent.css').read()
print(json.dumps(c))
PY
)
cf zaraz config update -z avto2000.com --body "$body" > /dev/null
echo "Zaraz config applied to avto2000.com"
