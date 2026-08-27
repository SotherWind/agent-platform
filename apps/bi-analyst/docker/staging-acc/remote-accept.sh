#!/usr/bin/env bash
# Remote L4 acceptance for the staging-acc stack.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

: "${BI_ACC_MYSQL_ROOT_PASSWORD:?BI_ACC_MYSQL_ROOT_PASSWORD must be set}"
: "${BI_ACC_MYSQL_PASSWORD:?BI_ACC_MYSQL_PASSWORD must be set}"
: "${BI_ACC_POSTGRES_PASSWORD:?BI_ACC_POSTGRES_PASSWORD must be set}"
: "${BI_ACC_AUDIT_DATABASE_URL:?BI_ACC_AUDIT_DATABASE_URL must be set}"
: "${BI_STAGING_MOCK_ADMIN_KEY:?BI_STAGING_MOCK_ADMIN_KEY must be set}"
: "${BI_ACC_STATE_ENCRYPTION_SECRET:?BI_ACC_STATE_ENCRYPTION_SECRET must be set}"

echo "==> [1/6] build slim images (project bi-analyst-staging-acc)"
sudo docker compose -p bi-analyst-staging-acc -f docker-compose.yml build

echo "==> [2/6] up stack"
sudo docker compose -p bi-analyst-staging-acc -f docker-compose.yml up -d

echo "==> [3/6] wait healthy"
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:13000/health" >/tmp/bi-acc-health.json 2>/dev/null; then
    echo "app healthy"
    break
  fi
  if [[ "$i" -eq 60 ]]; then
    echo "ERROR: app health timeout" >&2
    sudo docker compose -p bi-analyst-staging-acc -f docker-compose.yml logs --tail=80
    exit 1
  fi
  sleep 3
done

echo "==> image sizes"
sudo docker images 'bi-analyst-staging-acc' --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}'

echo "==> [4/6] functional checks (L4 JWT + live)"
CODE_HEALTH=$(curl -sS -o /tmp/bi-acc-health.json -w '%{http_code}' http://127.0.0.1:13000/health)
echo "health HTTP=$CODE_HEALTH body=$(cat /tmp/bi-acc-health.json)"
test "$CODE_HEALTH" = "200"
grep -Eq '"environment"[[:space:]]*:[[:space:]]*"staging"' /tmp/bi-acc-health.json
grep -Eq 'sales_mysql|analytics_pg' /tmp/bi-acc-health.json

CODE_TOKEN=$(curl -sS -o /tmp/bi-acc-token.json -w '%{http_code}' \
  -X POST http://127.0.0.1:13000/api/staging/mock-token \
  -H 'content-type: application/json' \
  -H "x-bi-staging-admin-key: ${BI_STAGING_MOCK_ADMIN_KEY}" \
  -d '{"subjectId":"user-dev","tenantId":"tenant-1","roles":["analyst","BI_QUERY_DEBUG","BI_AUDIT_READER"]}')
echo "mock-token HTTP=$CODE_TOKEN"
test "$CODE_TOKEN" = "200"
TOKEN=$(python3 -c 'import json; print(json.load(open("/tmp/bi-acc-token.json"))["access_token"])' 2>/dev/null \
  || node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/bi-acc-token.json","utf8")).access_token)')

CODE_ANALYZE=$(curl -sS -o /tmp/bi-acc-analyze.json -w '%{http_code}' \
  http://127.0.0.1:13000/api/analyze \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"query":"GMV"}')
echo "analyze HTTP=$CODE_ANALYZE"
test "$CODE_ANALYZE" = "200"
grep -Eq 'finalAnswer|clarification|needsClarification' /tmp/bi-acc-analyze.json
grep -Eq '"requestId"[[:space:]]*:[[:space:]]*"[^"]+"' /tmp/bi-acc-analyze.json
grep -Eq '"traceId"[[:space:]]*:[[:space:]]*"[^"]+"' /tmp/bi-acc-analyze.json

CODE_FORGE=$(curl -sS -o /tmp/bi-acc-forbid.json -w '%{http_code}' \
  http://127.0.0.1:13000/api/analyze \
  -H 'content-type: application/json' \
  -d '{"query":"orders","userId":"hacker","tenantId":"x"}')
echo "forged-identity HTTP=$CODE_FORGE"
test "$CODE_FORGE" != "200"

CODE_CLAR=$(curl -sS -o /tmp/bi-acc-clar.json -w '%{http_code}' \
  http://127.0.0.1:13000/api/analyze \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"query":"order count","clarificationChoice":"range.last_30d"}')
echo "clarificationChoice HTTP=$CODE_CLAR"
test "$CODE_CLAR" = "200"

CODE_AUDIT=$(curl -sS -o /tmp/bi-acc-audit.json -w '%{http_code}' \
  "http://127.0.0.1:13000/api/audit?limit=20" \
  -H "authorization: Bearer $TOKEN")
echo "audit HTTP=$CODE_AUDIT"
test "$CODE_AUDIT" = "200"
grep -Eq '"items"' /tmp/bi-acc-audit.json
python3 -c 'import json; d=json.load(open("/tmp/bi-acc-audit.json")); assert isinstance(d.get("items"), list) and len(d["items"]) >= 1, d' 2>/dev/null \
  || node -e 'const d=JSON.parse(require("fs").readFileSync("/tmp/bi-acc-audit.json","utf8")); if(!Array.isArray(d.items)||d.items.length<1){console.error(d); process.exit(1)}'

echo "==> [5/6] live datasource analyze (explicit choice)"
CODE_MYSQL=$(curl -sS -o /tmp/bi-acc-mysql.json -w '%{http_code}' \
  http://127.0.0.1:13000/api/analyze \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"query":"GMV","clarificationChoice":"datasource.sales_mysql"}')
echo "analyze mysql HTTP=$CODE_MYSQL"
test "$CODE_MYSQL" = "200"
grep -Eq 'finalAnswer|clarification|needsClarification' /tmp/bi-acc-mysql.json

CODE_PG=$(curl -sS -o /tmp/bi-acc-pg.json -w '%{http_code}' \
  http://127.0.0.1:13000/api/analyze \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"query":"GMV","clarificationChoice":"datasource.analytics_pg"}')
echo "analyze pg HTTP=$CODE_PG"
test "$CODE_PG" = "200"
grep -Eq 'finalAnswer|clarification|needsClarification' /tmp/bi-acc-pg.json

echo "==> [6/6] compose ps"
sudo docker compose -p bi-analyst-staging-acc -f docker-compose.yml ps

echo
echo "ACCEPTANCE PASSED (L4 staging + live analyze + meta/audit)"
