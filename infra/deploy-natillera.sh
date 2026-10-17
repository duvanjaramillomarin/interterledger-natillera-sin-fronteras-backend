#!/usr/bin/env bash
# Despliega GET /me y GET /natilleras/mine con AWS CLI: tabla natillera-registration (+ semilla),
# Lambdas natillera-me y natilleras-mine, rutas del API REST con integración PROXY y autorizador
# Cognito, y deployment al stage. Idempotente, mismo estilo que infra/deploy-payments.sh.
# Sin Open Payments: estas Lambdas solo leen DynamoDB.
#
# Uso:  AWS_PROFILE=natillera bash infra/deploy-natillera.sh
#       SEED=0 … para no (re)cargar infra/seed-natillera.json
# Requiere: aws cli v2 con sesión, python y la Lambda start-payment (se reutiliza su rol).
set -euo pipefail

export AWS_REGION="${AWS_REGION:-us-east-2}"
export AWS_PAGER=""
export MSYS_NO_PATHCONV=1  # Git Bash: no convertir "/me" ni "/authorizationType" en rutas de Windows
ACCOUNT="349607459198"
API_ID="${API_ID:-lofoyfhz52}"
STAGE="${STAGE:-dev}"
AUTHORIZER_NAME="cognito_authorizer"
NATILLERAS_TABLE="natillera-registration"
PAYMENTS_TABLE="payments-history"
USERS_TABLE="user-info"
SEED="${SEED:-1}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
# En Git Bash, rutas C:/… para que las entiendan python y aws.exe (nativos de Windows).
if command -v cygpath >/dev/null 2>&1; then TMP="$(cygpath -m "$TMP")"; ROOT="$(cygpath -m "$ROOT")"; fi
trap 'rm -rf "$TMP"' EXIT

PY=""
for c in python3 python py; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import json' >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "Falta Python 3"; exit 1; }
log() { echo; echo "== $*"; }

aws sts get-caller-identity --query Account --output text | grep -q "$ACCOUNT" || { echo "Sesión en otra cuenta"; exit 1; }

# ---------------------------------------------------------------- 1. Tabla natillera-registration
log "Tabla $NATILLERAS_TABLE"
if aws dynamodb describe-table --table-name "$NATILLERAS_TABLE" >/dev/null 2>&1; then
  echo "ya existe"
else
  aws dynamodb create-table --table-name "$NATILLERAS_TABLE" --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=natilleraId,AttributeType=S \
    --key-schema AttributeName=natilleraId,KeyType=HASH \
    --query 'TableDescription.TableStatus' --output text
  aws dynamodb wait table-exists --table-name "$NATILLERAS_TABLE"
  echo "creada"
fi

if [ "$SEED" = "1" ]; then
  log "Semilla infra/seed-natillera.json"
  # JSON plano → formato DynamoDB (S, N, L, M, BOOL).
  "$PY" - "$ROOT/infra/seed-natillera.json" "$TMP/seed-item.json" <<'PYEOF'
import json, sys
def ddb(v):
    if isinstance(v, bool): return {"BOOL": v}
    if isinstance(v, (int, float)): return {"N": str(v)}
    if isinstance(v, list): return {"L": [ddb(x) for x in v]}
    if isinstance(v, dict): return {"M": {k: ddb(x) for k, x in v.items()}}
    return {"S": str(v)}
item = json.load(open(sys.argv[1], encoding="utf-8"))
json.dump({k: ddb(v) for k, v in item.items()}, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
PYEOF
  aws dynamodb put-item --table-name "$NATILLERAS_TABLE" --item "file://$TMP/seed-item.json"
  echo "natillera n-rosa cargada (prueba1, prueba2, prueba3)"
fi

# ---------------------------------------------------------------- 2. Permisos del rol (solo lectura)
ROLE_ARN="$(aws lambda get-function-configuration --function-name start-payment --query Role --output text)"
ROLE_NAME="${ROLE_ARN##*/}"
log "Política natillera-read en el rol $ROLE_NAME"
"$PY" - "$TMP/policy.json" "$AWS_REGION" "$ACCOUNT" "$NATILLERAS_TABLE" "$PAYMENTS_TABLE" "$USERS_TABLE" <<'PYEOF'
import json, sys
out, region, account, nat, pay, users = sys.argv[1:]
arn = lambda t: f"arn:aws:dynamodb:{region}:{account}:table/{t}"
json.dump({"Version": "2012-10-17", "Statement": [
  {"Effect": "Allow", "Action": ["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:Query"],
   "Resource": [arn(nat), arn(pay), arn(users), arn(pay) + "/index/*"]}]}, open(out, "w"))
PYEOF
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name natillera-read --policy-document "file://$TMP/policy.json"
echo "lista: GetItem/Scan/Query sobre $NATILLERAS_TABLE, $PAYMENTS_TABLE y $USERS_TABLE"

# ---------------------------------------------------------------- 3. Lambdas
zip_dir() { # zip_dir carpeta salida.zip  (los archivos quedan en la raíz del zip)
  "$PY" - "$1" "$2" <<'PYEOF'
import os, sys, zipfile
src, out = sys.argv[1:]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for f in os.listdir(src):
        z.write(os.path.join(src, f), f)
PYEOF
}
echo "{\"Variables\":{\"USER_VIEW_TABLE\":\"$USERS_TABLE\",\"NATILLERAS_TABLE\":\"$NATILLERAS_TABLE\",\"PAYMENTS_TABLE\":\"$PAYMENTS_TABLE\"}}" > "$TMP/env.json"

deploy_lambda() { # deploy_lambda nombre carpeta
  local name="$1" dir="$2"
  log "Lambda $name ($dir)"
  zip_dir "$ROOT/$dir" "$TMP/$name.zip"
  if ! aws lambda get-function-configuration --function-name "$name" >/dev/null 2>&1; then
    aws lambda create-function --function-name "$name" --runtime nodejs22.x --handler index.handler \
      --role "$ROLE_ARN" --zip-file "fileb://$TMP/$name.zip" --timeout 10 --memory-size 256 \
      --environment "file://$TMP/env.json" --query 'FunctionArn' --output text
    aws lambda wait function-active-v2 --function-name "$name"
    echo "creada"
    return
  fi
  local backup
  backup="$(aws lambda publish-version --function-name "$name" --description "respaldo antes de deploy-natillera $(date -u +%FT%TZ)" --query Version --output text)"
  echo "respaldo publicado: versión $backup"
  aws lambda update-function-code --function-name "$name" --zip-file "fileb://$TMP/$name.zip" --query 'CodeSize' --output text
  aws lambda wait function-updated-v2 --function-name "$name"
  aws lambda update-function-configuration --function-name "$name" --handler index.handler --runtime nodejs22.x \
    --timeout 10 --memory-size 256 --environment "file://$TMP/env.json" --query 'LastUpdateStatus' --output text
  aws lambda wait function-updated-v2 --function-name "$name"
}
deploy_lambda natillera-me deploy/me
deploy_lambda natilleras-mine deploy/natilleras-mine

# ---------------------------------------------------------------- 4. API Gateway (REST + PROXY)
AUTHORIZER_ID="$(aws apigateway get-authorizers --rest-api-id "$API_ID" --query "items[?name=='$AUTHORIZER_NAME'].id" --output text)"
[ -n "$AUTHORIZER_ID" ] || { echo "No existe el autorizador $AUTHORIZER_NAME"; exit 1; }

resource_id() { aws apigateway get-resources --rest-api-id "$API_ID" --limit 500 --query "items[?path=='$1'].id" --output text; }
ensure_resource() { # ensure_resource /natilleras/mine
  local path="$1" id
  id="$(resource_id "$path")"
  if [ -z "$id" ]; then
    local parent="${path%/*}"; [ -z "$parent" ] && parent="/"
    local part="${path##*/}"
    id="$(aws apigateway create-resource --rest-api-id "$API_ID" --parent-id "$(ensure_resource "$parent")" --path-part "$part" --query id --output text)"
  fi
  echo "$id"
}

proxy_route() { # proxy_route METHOD /path lambda
  local method="$1" path="$2" fn="$3"
  log "Ruta $method $path → $fn (proxy, $AUTHORIZER_NAME)"
  local rid; rid="$(ensure_resource "$path")"
  if aws apigateway get-method --rest-api-id "$API_ID" --resource-id "$rid" --http-method "$method" >/dev/null 2>&1; then
    aws apigateway update-method --rest-api-id "$API_ID" --resource-id "$rid" --http-method "$method" \
      --patch-operations op=replace,path=/authorizationType,value=COGNITO_USER_POOLS op=replace,path=/authorizerId,value="$AUTHORIZER_ID" \
      --query authorizationType --output text
  else
    aws apigateway put-method --rest-api-id "$API_ID" --resource-id "$rid" --http-method "$method" \
      --authorization-type COGNITO_USER_POOLS --authorizer-id "$AUTHORIZER_ID" --query authorizationType --output text
  fi
  aws apigateway put-integration --rest-api-id "$API_ID" --resource-id "$rid" --http-method "$method" \
    --type AWS_PROXY --integration-http-method POST \
    --uri "arn:aws:apigateway:$AWS_REGION:lambda:path/2015-03-31/functions/arn:aws:lambda:$AWS_REGION:$ACCOUNT:function:$fn/invocations" \
    --query type --output text
  local sid="apigw-$method-$(echo "$path" | tr -c 'A-Za-z0-9' '-')"
  aws lambda add-permission --function-name "$fn" --statement-id "$sid" --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:$AWS_REGION:$ACCOUNT:$API_ID/*/$method$path" \
    >/dev/null 2>&1 && echo "permiso de invocación agregado" || echo "permiso de invocación ya existía"
}
proxy_route GET /me              natillera-me
proxy_route GET /natilleras/mine natilleras-mine

# ---------------------------------------------------------------- 5. Deployment
log "Deployment al stage $STAGE"
aws apigateway create-deployment --rest-api-id "$API_ID" --stage-name "$STAGE" \
  --description "deploy-natillera $(date -u +%FT%TZ)" --query id --output text

BASE_URL="https://$API_ID.execute-api.$AWS_REGION.amazonaws.com/$STAGE"
log "Comprobación sin token (las dos deben dar 401)"
for p in /me /natilleras/mine; do echo "GET $p → $(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL$p")"; done
echo
echo "Con el IdToken de prueba1:  curl -H \"Authorization: Bearer \$ID_TOKEN\" $BASE_URL/natilleras/mine"
