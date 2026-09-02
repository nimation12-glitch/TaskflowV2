#!/usr/bin/env bash
# TaskFlow end-to-end API smoke test
set -e
BASE="http://localhost:3000"
JAR="/tmp/taskflow-cookies.txt"
rm -f "$JAR"

EMAIL="founder.$(date +%s)@test-taskflow.dev"
PASSWORD="Passw0rd123"
PHONE="+4477009$(date +%M%S)"  # unique per run: verified-phone uniqueness refuses reuse

echo "=== 1. Register account (pending until email+phone verified — correction spec §17) ==="
REGISTER=$(curl -s -c "$JAR" -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"name\":\"John Carter\",\"password\":\"$PASSWORD\",\"phone\":\"$PHONE\"}")
echo "$REGISTER" | head -c 300; echo
echo "$REGISTER" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('status:', d['user']['status'], '| emailVerificationSent:', d['emailVerificationSent'])
assert d['user']['status'] == 'PENDING', 'new accounts start PENDING'
assert d['emailVerificationSent'] is True
"

echo "=== 1b. Email verification via dev outbox (single-use token; replay refused) ==="
TOKEN=$(curl -s -b "$JAR" "$BASE/api/dev/email-outbox?to=$EMAIL" | python3 -c "
import json,sys,re
d=json.load(sys.stdin)
msgs=[m for m in d['messages'] if 'Verify your TaskFlow' in m['subject']]
assert msgs, 'no verification email in outbox'
m=re.search(r'token=([A-Za-z0-9_-]+)', msgs[0]['body'])
assert m, 'no token in email body'
print(m.group(1))
")
curl -s -X POST "$BASE/api/auth/verify-email" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}" | python3 -c "
import json,sys; d=json.load(sys.stdin); print('verified:', d['ok'], '| next:', d.get('next')); assert d['ok'] and d.get('next')=='verify_phone'
"
curl -s -o /dev/null -w "replay of the same token → status=%{http_code} (expect 400)\n" -X POST "$BASE/api/auth/verify-email" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\"}"

echo "=== 1c. Phone verification via dev SMS outbox -> activation provisions the workspace ==="
curl -s -b "$JAR" -X POST "$BASE/api/auth/phone/request" -H 'Content-Type: application/json' -d '{}' | python3 -c "
import json,sys; d=json.load(sys.stdin); assert d['sent'] and d.get('smsAccepted'), d; print('sms requested')
"
CODE=$(curl -s -b "$JAR" "$BASE/api/dev/sms-outbox?to=${PHONE/+/%2B}" | python3 -c "
import json,sys,re
d=json.load(sys.stdin)
msgs=[m for m in d['messages'] if 'verification code' in m['body']]
assert msgs, 'no SMS in outbox'
m=re.search(r'\b(\d{6})\b', msgs[0]['body'])
assert m, 'no code in SMS body'
print(m.group(1))
")
curl -s -b "$JAR" -X POST "$BASE/api/auth/phone/confirm" -H 'Content-Type: application/json' -d "{\"code\":\"$CODE\"}" | python3 -c "
import json,sys; d=json.load(sys.stdin); print('phoneVerified:', d['ok'], '| activated:', d['activated']); assert d['ok'] and d['activated']
"

echo "=== 2. Who am I (activated: org + Free plan + credits) ==="
ME=$(curl -s -b "$JAR" "$BASE/api/auth/me")
echo "$ME" | python3 -c "import json,sys; d=json.load(sys.stdin); print('plan:', d['subscription']['planId'], '| status:', d['subscription']['status'], '| balance:', d['credits']['balanceGBP'], '| entitled:', d['subscription']['entitled'])"

echo "=== 3. Create API key ==="
KEYRES=$(curl -s -b "$JAR" -X POST "$BASE/api/keys" -H 'Content-Type: application/json' -d '{"name":"E2E smoke test key"}')
RAWKEY=$(echo "$KEYRES" | python3 -c "import json,sys; print(json.load(sys.stdin)['rawKey'])")
echo "$KEYRES" | python3 -c "import json,sys; d=json.load(sys.stdin); print('prefix:', d['key']['prefix'], '| raw length:', len(d['rawKey']))"

echo "=== 4. List models via API key (OpenAI style) ==="
curl -s "$BASE/api/v1/models" -H "Authorization: Bearer $RAWKEY" | python3 -c "import json,sys; d=json.load(sys.stdin); print('models:', [m['id'] for m in d['data']])"

echo "=== 5. Call the gateway (taskflow-mini) ==="
CHAT=$(curl -s -X POST "$BASE/api/v1/chat/completions" -H "Authorization: Bearer $RAWKEY" -H 'Content-Type: application/json' \
  -d '{"model":"taskflow-mini","messages":[{"role":"user","content":"Reply with exactly: TASKFLOW_GATEWAY_OK"}]}')
echo "$CHAT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if 'error' in d: print('ERROR:', d['error'])
else:
    print('content:', d['choices'][0]['message']['content'][:80])
    print('usage:', d['usage'])
    print('taskflow:', d['taskflow'])
"

echo "=== 6. Forbidden model on Free tier (taskflow-reasoning) ==="
curl -s -X POST "$BASE/api/v1/chat/completions" -H "Authorization: Bearer $RAWKEY" -H 'Content-Type: application/json' \
  -d '{"model":"taskflow-reasoning","messages":[{"role":"user","content":"hi"}]}' | head -c 220; echo

echo "=== 7. Bad key rejected ==="
curl -s -X POST "$BASE/api/v1/chat/completions" -H "Authorization: Bearer tf_live_totallyfake" -H 'Content-Type: application/json' \
  -d '{"model":"taskflow-mini","messages":[{"role":"user","content":"hi"}]}' | head -c 200; echo

echo "=== 8. Usage analytics ==="
curl -s -b "$JAR" "$BASE/api/usage?days=7" | python3 -c "
import json,sys
d=json.load(sys.stdin)
t=d['totals']
print('requests:', t['requests'], '| tokens:', t['totalTokens'], '| charged GBP:', round(t['aiUsageGBP'],6), '| balance GBP:', round(d['credits']['remainingGBP'],4))
print('daily points:', len(d['daily']), '| models:', len(d['models']), '| recent events:', len(d['recentEvents']))
"

echo "=== 9. Credit ledger ==="
curl -s -b "$JAR" "$BASE/api/credits" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('balance GBP:', d['balanceGBP'])
for t in d['transactions'][:5]: print(' -', t['type'], t['amountGBP'], '|', t['description'])
"

echo "=== 10. Pro upgrade → real Stripe Checkout (TEST MODE) ==="
CHECKOUT=$(curl -s -b "$JAR" -X POST "$BASE/api/billing/checkout" -H 'Content-Type: application/json' -d '{"kind":"subscription","planId":"pro"}')
echo "$CHECKOUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('mode:', d.get('mode'), '| checkoutUrl:', (d.get('checkoutUrl') or 'MISSING')[:72])
assert d.get('mode') == 'test', 'expected Stripe TEST MODE'
assert d.get('checkoutUrl','').startswith('https://checkout.stripe.com'), 'expected a Stripe-hosted checkout URL'
"

echo "=== 11. No payment completed → plan stays Free (no simulated upgrades) ==="
ME2=$(curl -s -b "$JAR" "$BASE/api/auth/me")
echo "$ME2" | python3 -c "import json,sys; d=json.load(sys.stdin); print('plan:', d['subscription']['planId'], '| balance:', d['credits']['balanceGBP'], '| billing:', d['billingMode']); assert d['subscription']['planId']=='free'"
curl -s "$BASE/api/v1/models" -H "Authorization: Bearer $RAWKEY" | python3 -c "import json,sys; print('models still free tier:', [m['id'] for m in json.load(sys.stdin)['data']])"

echo "=== 11b. Credit pack on Free plan → correctly refused (entitlement gate) ==="
curl -s -b "$JAR" -X POST "$BASE/api/billing/checkout" -H 'Content-Type: application/json' -d '{"kind":"credits","amountMicros":10000000}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('error:', d.get('error'))
assert 'Pro or Max plan' in d.get('error',''), 'expected the credit-purchase entitlement gate'
"

echo "=== 11c. Checkout config (prices configured from env) ==="
curl -s -b "$JAR" "$BASE/api/billing/checkout" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('mode:', d['mode'], '| pro price:', d['pricesConfigured']['pro'], '| max price:', d['pricesConfigured']['max'], '| packs configured:', all(p.get('priceConfigured') for p in d['creditPackages']))
"

echo "=== 13. Invoices ==="
curl -s -b "$JAR" "$BASE/api/billing/invoices" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('invoices:', len(d['invoices']), '(empty until a real Stripe payment completes)')
for i in d['invoices']: print(' -', i['number'], i['amountGBP'], '|', i['description'], '|', i['status'])
"

echo "=== 14. Burst requests (pro=100rpm, fire 8 quick) ==="
for i in $(seq 1 8); do
  curl -s -o /dev/null -w "%{http_code} " -X POST "$BASE/api/v1/chat/completions" -H "Authorization: Bearer $RAWKEY" -H 'Content-Type: application/json' \
    -d '{"model":"taskflow-mini","messages":[{"role":"user","content":"ping"}]}'
done; echo

echo "=== 15. Key revoke → auth fails ==="
KEYID=$(echo "$KEYRES" | python3 -c "import json,sys; print(json.load(sys.stdin)['key']['id'])")
curl -s -b "$JAR" -X DELETE "$BASE/api/keys/$KEYID" | head -c 120; echo
curl -s -X POST "$BASE/api/v1/chat/completions" -H "Authorization: Bearer $RAWKEY" -H 'Content-Type: application/json' \
  -d '{"model":"taskflow-mini","messages":[{"role":"user","content":"hi"}]}' | head -c 160; echo

echo "=== 16. Stripe webhook rejects unsigned payloads (signature required) ==="
EV="{\"id\":\"evt_e2e_001\",\"type\":\"invoice.paid\",\"data\":{\"object\":{\"id\":\"in_e2e\",\"subscription\":\"sub_none\"}}}"
curl -s -o /dev/null -w "status=%{http_code} (expect 400)\n" -X POST "$BASE/api/webhooks/stripe" -H 'Content-Type: application/json' -d "$EV"

echo "=== 17. Webhook with an INVALID signature is rejected (S-1 regression guard) ==="
curl -s -o /dev/null -w "status=%{http_code} (expect 400)\n" -X POST "$BASE/api/webhooks/stripe" -H 'Content-Type: application/json' -H 'stripe-signature: t=1,v1=deadbeef' -d "$EV"

echo "=== 18. Health: billing mode + config ==="
curl -s "$BASE/api/health" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('status:', d['status'], '| billing:', d['billing'], '| configIssues:', d.get('billingConfigIssues'))
assert d['billing'] == 'test', 'expected Stripe TEST MODE'
assert not d.get('billingConfigIssues'), 'expected zero billing config issues'
"

# ─────────────────────────── Phase 1: identity & multi-tenancy ───────────────

echo "=== 19. Identity bootstrap: role + organizations + providers in /me ==="
curl -s -b "$JAR" "$BASE/api/auth/me" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('role:', d['role'], '| orgs:', [o['name'] for o in d['organizations']], '| emailVerified:', d['user']['emailVerified'], '| phoneVerified:', d['user']['phoneVerified'])
assert d['role'] == 'OWNER'
assert len(d['organizations']) == 1
assert d['user']['emailVerified'] is True
assert d['user']['phoneVerified'] is True
"


echo "=== 21. Second user + invitation flow (Free plan seat limit = 3) ==="
JAR2="/tmp/taskflow-cookies-2.txt"; rm -f "$JAR2"
EMAIL2="teammate.$(date +%s)@test-taskflow.dev"
PHONE2="+44770091$(date +%M%S)"  # distinct from PHONE, unique per run
curl -s -c "$JAR2" -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL2\",\"name\":\"Team Mate\",\"password\":\"$PASSWORD\",\"phone\":\"$PHONE2\"}" > /dev/null
# Activate the teammate (email + phone verification) — pending accounts cannot hold org context.
TOKEN2=$(curl -s -b "$JAR2" "$BASE/api/dev/email-outbox?to=$EMAIL2" | python3 -c "
import json,sys,re
d=json.load(sys.stdin)
msgs=[m for m in d['messages'] if 'Verify your TaskFlow' in m['subject']]
m=re.search(r'token=([A-Za-z0-9_-]+)', msgs[0]['body'])
print(m.group(1))
")
curl -s -b "$JAR2" -X POST "$BASE/api/auth/verify-email" -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN2\"}" > /dev/null
curl -s -b "$JAR2" -X POST "$BASE/api/auth/phone/request" -H 'Content-Type: application/json' -d '{}' > /dev/null
CODE2=$(curl -s -b "$JAR2" "$BASE/api/dev/sms-outbox?to=${PHONE2/+/%2B}" | python3 -c "
import json,sys,re
d=json.load(sys.stdin)
msgs=[m for m in d['messages'] if 'verification code' in m['body']]
m=re.search(r'\b(\d{6})\b', msgs[0]['body'])
print(m.group(1))
")
curl -s -b "$JAR2" -X POST "$BASE/api/auth/phone/confirm" -H 'Content-Type: application/json' -d "{\"code\":\"$CODE2\"}" > /dev/null
echo "teammate activated"
ORGID=$(curl -s -b "$JAR" "$BASE/api/auth/me" | python3 -c "import json,sys; print(json.load(sys.stdin)['organization']['id'])")
INVITE=$(curl -s -b "$JAR" -X POST "$BASE/api/orgs/$ORGID/invitations" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL2\",\"role\":\"MEMBER\"}")
INVITE_TOKEN=$(echo "$INVITE" | python3 -c "
import json,sys,re,urllib.parse
d=json.load(sys.stdin)
m=re.search(r'token=([A-Za-z0-9_-]+)', d['inviteUrl'])
print(urllib.parse.unquote(m.group(1)))
")
echo "invitation created; token extracted"
curl -s -b "$JAR2" -X POST "$BASE/api/invitations/accept" -H 'Content-Type: application/json' -d "{\"token\":\"$INVITE_TOKEN\"}" | python3 -c "
import json,sys; d=json.load(sys.stdin); print('accepted into:', d['organizationName'], '| role:', d['role']); assert d['role']=='MEMBER'
"

echo "=== 22. Tenant isolation: teammate sees the org, stranger does not ==="
curl -s -b "$JAR2" "$BASE/api/auth/me" | python3 -c "
import json,sys; d=json.load(sys.stdin)
print('teammate orgs:', [o['name'] for o in d['organizations']], '| active role:', d['role'])
assert len(d['organizations']) == 2, 'teammate has personal + invited org'
"
# Teammate switches active org to the invited one (persist the new tf_org cookie).
curl -s -b "$JAR2" -c "$JAR2" -X POST "$BASE/api/orgs/active" -H 'Content-Type: application/json' -d "{\"organizationId\":\"$ORGID\"}" | python3 -c "
import json,sys; d=json.load(sys.stdin); print('switched to:', d['organization']['name'], '| role:', d['role']); assert d['role']=='MEMBER'
"
# Teammate (MEMBER) cannot create keys or touch billing in the INVITED org.
curl -s -o /dev/null -w "member key creation → status=%{http_code} (expect 403)\n" -b "$JAR2" -X POST "$BASE/api/keys" -H 'Content-Type: application/json' -d '{"name":"nope"}'
curl -s -o /dev/null -w "member checkout → status=%{http_code} (expect 403)\n" -b "$JAR2" -X POST "$BASE/api/billing/checkout" -H 'Content-Type: application/json' -d '{"kind":"subscription","planId":"pro"}'

echo "=== 23. Free-plan seat limit blocks invitations beyond 3/3 (DB-backed, §20) ==="
EMAIL3="third.$(date +%s)@test-taskflow.dev"
# Third seat (pending): 2 members + 1 pending = 3/3 → allowed.
curl -s -b "$JAR" -X POST "$BASE/api/orgs/$ORGID/invitations" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL3\"}" | python3 -c "
import json,sys; d=json.load(sys.stdin); assert d.get('ok'), d; print('third seat invited (3/3 used)')
"
# Fourth seat → refused.
EMAIL4="fourth.$(date +%s)@test-taskflow.dev"
curl -s -b "$JAR" -X POST "$BASE/api/orgs/$ORGID/invitations" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL4\"}" | python3 -c "
import json,sys; d=json.load(sys.stdin)
print('error:', d.get('error'))
assert 'Seat limit reached (3/3)' in d.get('error',''), 'expected the DB-backed seat limit'
"

echo "=== 24. Suspended/revoked sessions: logout then reuse must fail ==="
cp "$JAR" "$JAR.bak"
curl -s -b "$JAR" -c "$JAR" -X POST "$BASE/api/auth/logout" -H 'Content-Type: application/json' -d '{}' > /dev/null
curl -s -o /dev/null -w "session reuse after logout → status=%{http_code} (expect 401)\n" -b "$JAR.bak" "$BASE/api/auth/me"
mv "$JAR.bak" "$JAR"
# Re-login to continue with a fresh session.
curl -s -c "$JAR" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" > /dev/null
curl -s -b "$JAR" "$BASE/api/auth/me" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['user']['email']=='$EMAIL'; print('fresh session OK, emailVerified:', d['user']['emailVerified'])"

echo "=== 25. Audit trail recorded (login/invitation events) ==="
AUDIT=$(bun -e "
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  const n = await db.auditLog.count({ where: { action: { in: ['signup','login','logout','invitation_created','invitation_accepted','email_verified'] } } });
  console.log(n);
  await db.\$disconnect();
})();
")
echo "audit rows for identity actions: $AUDIT"
test "$AUDIT" -ge 5

echo "=== 26. OAuth providers honestly report unconfigured state ==="
curl -s "$BASE/api/auth/providers" | python3 -c "
import json,sys
d=json.load(sys.stdin)['providers']
print({k: v['enabled'] for k, v in d.items()})
# In the sandbox none are configured; buttons must be DISABLED (no fake OAuth).
assert all(not v['enabled'] for v in d.values()), 'expected unconfigured providers in sandbox'
"

echo "=== DONE ==="
