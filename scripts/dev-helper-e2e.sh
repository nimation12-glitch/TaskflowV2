#!/bin/bash
# Simulates the DevOutboxHelper data path end-to-end through the LIVE preview URL:
# register → email-outbox link extraction → verify → phone request → sms-outbox code
# extraction → confirm → activated. Uses the same normalization/extraction logic
# as src/components/taskflow/dev-outbox-helper.tsx.
set -u
BASE="https://preview-chat-970b43ea-568a-4d4b-b88d-383d3eae4f1d.space-z.ai"
EMAIL="devhelper-$(date +%s)@test-preview.dev"
PHONE="+4477009009$(printf '%02d' $((RANDOM % 100)))"
JAR=$(mktemp)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "1. register ($EMAIL, $PHONE)"
code=$(curl -s -o /tmp/reg.json -w "%{http_code}" -c "$JAR" -X POST -H "Origin: $BASE" -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"preview-test-123\",\"phone\":\"$PHONE\",\"name\":\"Dev Helper Test\"}" "$BASE/api/auth/register")
[ "$code" = "201" ] && ok "register 201" || bad "register → $code: $(cat /tmp/reg.json)"

echo "2. /me shows PENDING (cookie set at register)"
me=$(curl -s -b "$JAR" "$BASE/api/auth/me")
echo "$me" | grep -q '"status":"PENDING"' && ok "status PENDING" || bad "/me: $me"

echo "3. dev outbox: fetch verification email (filtered by ?to=, like the helper)"
norm=$(echo "$EMAIL" | tr 'A-Z' 'a-z')
email_body=$(curl -s -b "$JAR" "$BASE/api/dev/email-outbox?to=$norm" | python3 -c "
import sys, json, re
msgs = json.load(sys.stdin)['messages']
rows = [m for m in msgs if m['to'].lower() == '$norm']
body = rows[0]['body'] if rows else ''
m = re.search(r'https://[^\s\x22<>]+#/(?:verify-email|reset-password|invite)\?token=[^\s\x22<>]+', body)
print(m.group(0) if m else '')")
link="$email_body"
[ -n "$link" ] && ok "verification link extracted: ${link:0:80}…" || bad "no link found"

echo "4. follow the link's token (what the verify-email screen does)"
token=$(python3 -c "
from urllib.parse import urlparse, parse_qs, unquote
u = '$link'.split('#')[1]
print(parse_qs(urlparse('x://x'+u).query)['token'][0])")
code=$(curl -s -o /tmp/ver.json -w "%{http_code}" -b "$JAR" -X POST -H "Origin: $BASE" -H "Content-Type: application/json" \
  -d "{\"token\":\"$token\"}" "$BASE/api/auth/verify-email")
grep -q '"next":"verify_phone"' /tmp/ver.json && ok "email verified → next=verify_phone" || bad "verify → $code: $(cat /tmp/ver.json)"

echo "5. request SMS code (server normalizes $PHONE)"
curl -s -b "$JAR" -X POST -H "Origin: $BASE" -H "Content-Type: application/json" -d '{}' "$BASE/api/auth/phone/request" > /tmp/smsreq.json
grep -q '"sent":true' /tmp/smsreq.json && ok "code sent" || bad "phone/request: $(cat /tmp/smsreq.json)"

echo "6. sms outbox: extract 6-digit code (helper's regex + E.164 normalization)"
normphone=$(echo "$PHONE" | tr -d ' \-().')
# '+' in a query string decodes to a space — percent-encode like the component does.
encphone=$(python3 -c "import urllib.parse;print(urllib.parse.quote('$normphone', safe=''))")
sms_code=$(curl -s -b "$JAR" "$BASE/api/dev/sms-outbox?to=$encphone" | python3 -c "
import sys, json, re
msgs = json.load(sys.stdin)['messages']
rows = [m for m in msgs if m['to'].replace(' ','').replace('-','') == '$normphone']
m = re.search(r'\b(\d{6})\b', rows[0]['body']) if rows else None
print(m.group(1) if m else '')")
[ ${#sms_code} = "6" ] && ok "code extracted: $sms_code" || bad "no code for $normphone"

echo "7. confirm → activation provisions workspace"
code=$(curl -s -o /tmp/conf.json -w "%{http_code}" -b "$JAR" -X POST -H "Origin: $BASE" -H "Content-Type: application/json" \
  -d "{\"code\":\"$sms_code\"}" "$BASE/api/auth/phone/confirm")
grep -q '"activated":true' /tmp/conf.json && ok "activated" || bad "confirm → $code: $(cat /tmp/conf.json)"

echo "8. /me shows ACTIVE + org + phoneVerified"
me=$(curl -s -b "$JAR" "$BASE/api/auth/me")
echo "$me" | grep -q '"status":"ACTIVE"' && ok "status ACTIVE" || bad "/me: $(echo $me | head -c 200)"
echo "$me" | grep -q '"phoneVerified":true' && ok "phoneVerified true" || bad "phoneVerified missing"

# cleanup test account
bun -e "import('@/lib/db').then(async m=>{const u=await m.db.user.findUnique({where:{email:'$EMAIL'}}); if(u){await m.db.user.delete({where:{id:u.id}})}; process.exit(0)})" >/dev/null 2>&1

echo; echo "PASS=$PASS FAIL=$FAIL"; rm -f "$JAR"; [ $FAIL = 0 ]
