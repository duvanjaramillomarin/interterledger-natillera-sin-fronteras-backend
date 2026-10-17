#!/usr/bin/env bash
# Despliega el bloque A (flujos 5, 7, 8 y 13) con AWS CLI: tablas, permiso del rol, Lambdas, rutas del
# API REST (VTL, mismo patrón que infra/deploy-payments.sh) y stage. Idempotente. No toca las Lambdas
# de pagos: solo agrega una política inline al rol que ya usan (lectura/escritura de las tablas nuevas).
#
# Uso:  cd deploy/natilleras && npm install && npm run build && cd ../..
#       AWS_PROFILE=natillera bash infra/deploy-natilleras.sh
set -euo pipefail

export AWS_REGION="${AWS_REGION:-us-east-2}"
export AWS_PAGER=""
export MSYS_NO_PATHCONV=1  # Git Bash: no convertir "/authorizationType" ni "/natilleras" en rutas de Windows
ACCOUNT="349607459198"
API_ID="${API_ID:-lofoyfhz52}"
STAGE="${STAGE:-dev}"
AUTHORIZER_NAME="cognito_authorizer"
USERS_TABLE="user-info"
SAVED_ACCOUNTS_TABLE="saved-accounts"
NATILLERAS_TABLE="natillera-registration"
RECORDS_TABLE="natillera-records"
INVITATION_INDEX="invitation-index"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/deploy/natilleras/dist"
TMP="$(mktemp -d)"
if command -v cygpath >/dev/null 2>&1; then TMP="$(cygpath -m "$TMP")"; DIST="$(cygpath -m "$DIST")"; fi
trap 'rm -rf "$TMP"' EXIT

PY=""
for c in python3 python py; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import json' >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "Falta Python 3"; exit 1; }
fpath() { if command -v cygpath >/dev/null 2>&1; then echo "file://$(cygpath -m "$1")"; else echo "file://$1"; fi; }
bpath() { if command -v cygpath >/dev/null 2>&1; then echo "fileb://$(cygpath -m "$1")"; else echo "fileb://$1"; fi; }
log() { echo; echo "== $*"; }

aws sts get-caller-identity --query Account --output text | grep -q "$ACCOUNT" || { echo "Sesión en otra cuenta"; exit 1; }

# ---------------------------------------------------------------- 1. Tablas
# ensure_table nombre "PK:S" ["SK:N"]. Si ya existe, se exige el mismo esquema de llaves (no se borra nada).
ensure_table() {
  local name="$1" pk="${2%%:*}" pkt="${2##*:}" sk="${3:-}"
  log "Tabla $name"
  local want="$pk"; [ -n "$sk" ] && want="$pk ${sk%%:*}"
  if aws dynamodb describe-table --table-name "$name" >/dev/null 2>&1; then
    local have; have="$(aws dynamodb describe-table --table-name "$name" --query 'Table.KeySchema[].AttributeName' --output text | tr '\t' ' ')"
    [ "$have" = "$want" ] || { echo "La tabla $name existe con llaves '$have' y se esperaban '$want'. Revisar antes de seguir."; exit 1; }
    echo "ya existe ($have)"
    return
  fi
  local attrs="AttributeName=$pk,AttributeType=$pkt" keys="AttributeName=$pk,KeyType=HASH"
  if [ -n "$sk" ]; then
    attrs="$attrs AttributeName=${sk%%:*},AttributeType=${sk##*:}"
    keys="$keys AttributeName=${sk%%:*},KeyType=RANGE"
  fi
  # shellcheck disable=SC2086
  aws dynamodb create-table --table-name "$name" --billing-mode PAY_PER_REQUEST \
    --attribute-definitions $attrs --key-schema $keys --query 'TableDescription.TableStatus' --output text
  aws dynamodb wait table-exists --table-name "$name"
  echo "creada"
}
ensure_table "$SAVED_ACCOUNTS_TABLE" author:S customWalletName:S
ensure_table "$NATILLERAS_TABLE" natilleraId:S
ensure_table "$RECORDS_TABLE" natilleraId:S id:N   # la escribe complete.ts de pagos (NATILLERA_RECORDS_TABLE)

log "Índice $INVITATION_INDEX en $NATILLERAS_TABLE (buscar por código de invitación)"
if aws dynamodb describe-table --table-name "$NATILLERAS_TABLE" --query "Table.GlobalSecondaryIndexes[?IndexName=='$INVITATION_INDEX'].IndexName" --output text | grep -q "$INVITATION_INDEX"; then
  echo "ya existe"
else
  aws dynamodb update-table --table-name "$NATILLERAS_TABLE" \
    --attribute-definitions AttributeName=natilleraInvitation,AttributeType=S \
    --global-secondary-index-updates "[{\"Create\":{\"IndexName\":\"$INVITATION_INDEX\",\"KeySchema\":[{\"AttributeName\":\"natilleraInvitation\",\"KeyType\":\"HASH\"}],\"Projection\":{\"ProjectionType\":\"KEYS_ONLY\"}}}]" \
    --query 'TableDescription.TableStatus' --output text
fi
for _ in $(seq 1 60); do
  st="$(aws dynamodb describe-table --table-name "$NATILLERAS_TABLE" --query "Table.GlobalSecondaryIndexes[?IndexName=='$INVITATION_INDEX'].IndexStatus" --output text)"
  [ "$st" = "ACTIVE" ] && { echo "índice ACTIVE"; break; }
  echo "índice $st…"; sleep 5
done

# ---------------------------------------------------------------- 2. Permisos del rol
ROLE_ARN="$(aws lambda get-function-configuration --function-name start-payment --query Role --output text)"
ROLE_NAME="${ROLE_ARN##*/}"
log "Política inline natilleras-dynamo en el rol $ROLE_NAME"
T="arn:aws:dynamodb:$AWS_REGION:$ACCOUNT:table"
"$PY" - "$TMP/policy.json" "$T" "$USERS_TABLE" "$SAVED_ACCOUNTS_TABLE" "$NATILLERAS_TABLE" "$RECORDS_TABLE" <<'PYEOF'
import json, sys
out, t, users, saved, nat, rec = sys.argv[1:]
json.dump({"Version": "2012-10-17", "Statement": [
  {"Sid": "ReadUsers", "Effect": "Allow", "Action": ["dynamodb:GetItem"], "Resource": f"{t}/{users}"},
  {"Sid": "Natilleras", "Effect": "Allow",
   "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:Scan"],
   "Resource": [f"{t}/{saved}", f"{t}/{nat}", f"{t}/{nat}/index/*", f"{t}/{rec}"]}]}, open(out, "w"))
PYEOF
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name natilleras-dynamo --policy-document "$(fpath "$TMP/policy.json")"
echo "ok"

# ---------------------------------------------------------------- 3. Lambdas
"$PY" - "$TMP/env.json" "$USERS_TABLE" "$SAVED_ACCOUNTS_TABLE" "$NATILLERAS_TABLE" "$RECORDS_TABLE" "$INVITATION_INDEX" <<'PYEOF'
import json, sys
out, users, saved, nat, rec, idx = sys.argv[1:]
json.dump({"Variables": {"INTEGRATION_MODE": "vtl", "USER_VIEW_TABLE": users, "SAVED_ACCOUNTS_TABLE": saved,
  "NATILLERAS_TABLE": nat, "NATILLERA_RECORDS_TABLE": rec, "INVITATION_INDEX": idx}}, open(out, "w"))
PYEOF

deploy_lambda() { # deploy_lambda nombre timeout
  local name="$1" timeout="$2"
  log "Lambda $name"
  [ -f "$DIST/$name.zip" ] || { echo "Falta $DIST/$name.zip (npm run build en deploy/natilleras)"; exit 1; }
  if ! aws lambda get-function-configuration --function-name "$name" >/dev/null 2>&1; then
    aws lambda create-function --function-name "$name" --runtime nodejs22.x --handler index.handler \
      --role "$ROLE_ARN" --zip-file "$(bpath "$DIST/$name.zip")" --timeout "$timeout" --memory-size 256 \
      --environment "$(fpath "$TMP/env.json")" --query 'FunctionArn' --output text
    aws lambda wait function-active-v2 --function-name "$name"
    echo "creada"
    return
  fi
  aws lambda update-function-code --function-name "$name" --zip-file "$(bpath "$DIST/$name.zip")" --query 'CodeSize' --output text
  aws lambda wait function-updated-v2 --function-name "$name"
  aws lambda update-function-configuration --function-name "$name" --handler index.handler --runtime nodejs22.x \
    --timeout "$timeout" --memory-size 256 --environment "$(fpath "$TMP/env.json")" --query 'LastUpdateStatus' --output text
  aws lambda wait function-updated-v2 --function-name "$name"
}
for fn in get-me list-accounts get-my-natillera; do deploy_lambda "$fn" 10; done
for fn in verify-wallet save-account create-natillera get-invitation join-natillera; do deploy_lambda "$fn" 15; done

# ---------------------------------------------------------------- 4. API Gateway (REST + VTL)
AUTHORIZER_ID="$(aws apigateway get-authorizers --rest-api-id "$API_ID" --query "items[?name=='$AUTHORIZER_NAME'].id" --output text)"
[ -n "$AUTHORIZER_ID" ] || { echo "No existe el autorizador $AUTHORIZER_NAME"; exit 1; }

resource_id() { aws apigateway get-resources --rest-api-id "$API_ID" --limit 500 --query "items[?path=='$1'].id" --output text; }
ensure_resource() {
  local path="$1" id
  id="$(resource_id "$path")"
  if [ -z "$id" ]; then
    local parent="${path%/*}"; [ -z "$parent" ] && parent="/"
    local part="${path##*/}"
    id="$(aws apigateway create-resource --rest-api-id "$API_ID" --parent-id "$(ensure_resource "$parent")" --path-part "$part" --query id --output text)"
  fi
  echo "$id"
}

ERROR_TEMPLATE='#set($msg = $input.path('"'"'$.errorMessage'"'"'))
$msg.substring(6)'
"$PY" - "$TMP/error-template.json" "$ERROR_TEMPLATE" <<'EOF'
import json, sys
json.dump({"application/json": sys.argv[2]}, open(sys.argv[1], "w"))
EOF

CODES="400 401 403 404 409 500 502"
configure_route() { # configure_route METHOD /path lambda "plantilla VTL"
  local method="$1" path="$2" fn="$3" template="$4"
  log "Ruta $method $path → $fn"
  local rid; rid="$(ensure_resource "$path")"

  if aws apigateway get-method --rest-api-id "$API_ID" --resource-id "$rid" --http-method "$method" >/dev/null 2>&1; then
    aws apigateway update-method --rest-api-id "$API_ID" --resource-id "$rid" --http-method "$method" \
      --patch-operations op=replace,path=/authorizationType,value=COGNITO_USER_POOLS op=replace,path=/authorizerId,value="$AUTHORIZER_ID" \
      --query authorizationType --output text
  else
    aws apigateway put-method --rest-api-id "$API_ID" --resource-id "$rid" --http-method "$method" \
      --authorization-type COGNITO_USER_POOLS --authorizer-id "$AUTHORIZER_ID" --query authorizationType --output text
  fi

  "$PY" - "$TMP/req-template.json" "$template" <<'EOF'
import json, sys
json.dump({"application/json": sys.argv[2]}, open(sys.argv[1], "w"))
EOF
  aws apigateway put-integration --rest-api-id "$API_ID" --resource-id "$rid" --http-method "$method" \
    --type AWS --integration-http-method POST \
    --uri "arn:aws:apigateway:$AWS_REGION:lambda:path/2015-03-31/functions/arn:aws:lambda:$AWS_REGION:$ACCOUNT:function:$fn/invocations" \
    --passthrough-behavior NEVER --request-templates "$(fpath "$TMP/req-template.json")" --query passthroughBehavior --output text

  local existing; existing="$(aws apigateway get-method --rest-api-id "$API_ID" --resource-id "$rid" --http-method "$method" --query 'keys(methodResponses||`{}`)' --output text)"
  for code in 200 $CODES; do
    if ! grep -qw "$code" <<<"$existing"; then
      aws apigateway put-method-response --rest-api-id "$API_ID" --resource-id "$rid" --http-method "$method" \
        --status-code "$code" --response-models application/json=Empty --query statusCode --output text >/dev/null
    fi
  done
  aws apigateway put-integration-response --rest-api-id "$API_ID" --resource-id "$rid" --http-method "$method" \
    --status-code 200 --selection-pattern "" --query statusCode --output text >/dev/null
  for code in $CODES; do
    aws apigateway put-integration-response --rest-api-id "$API_ID" --resource-id "$rid" --http-method "$method" \
      --status-code "$code" --selection-pattern "\\[$code\\].*" --response-templates "$(fpath "$TMP/error-template.json")" \
      --query statusCode --output text >/dev/null
  done

  # Permiso para que API Gateway invoque la Lambda en esta ruta ({code} → *).
  local arn_path; arn_path="$(sed -E 's/\{[^}]+\}/*/g' <<<"$path")"
  local sid="apigw-$method-$(echo "$arn_path" | tr -c 'A-Za-z0-9' '-')"
  aws lambda add-permission --function-name "$fn" --statement-id "$sid" --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:$AWS_REGION:$ACCOUNT:$API_ID/*/$method$arn_path" \
    >/dev/null 2>&1 && echo "permiso de invocación agregado" || echo "permiso de invocación ya existía"
}

# Identidad escapada (mismo motivo que en deploy-payments.sh: evitar inyectar otro "username").
AUTH="\"auth\": { \"username\": \"\$util.escapeJavaScript(\$context.authorizer.claims['cognito:username'])\", \"sub\": \"\$util.escapeJavaScript(\$context.authorizer.claims['sub'])\" }"
BODY="\"body\": \$input.json('\$')"
P_URL="\"params\": { \"url\": \"\$util.escapeJavaScript(\$input.params('url'))\" }"
P_CODE="\"params\": { \"code\": \"\$util.escapeJavaScript(\$input.params('code'))\" }"

configure_route GET  /me                  get-me            "{ $AUTH }"
configure_route GET  /wallets/verify      verify-wallet     "{ $AUTH, $P_URL }"
configure_route POST /accounts            save-account      "{ $AUTH, $BODY }"
configure_route GET  /accounts            list-accounts     "{ $AUTH }"
configure_route POST /natilleras          create-natillera  "{ $AUTH, $BODY }"
configure_route GET  /natilleras/mine     get-my-natillera  "{ $AUTH }"
configure_route POST /natilleras/join     join-natillera    "{ $AUTH, $BODY }"
configure_route GET  /invitations/{code}  get-invitation    "{ $AUTH, $P_CODE }"

# ---------------------------------------------------------------- 5. Implementar
log "Implementar en el stage $STAGE"
aws apigateway create-deployment --rest-api-id "$API_ID" --stage-name "$STAGE" \
  --description "deploy-natilleras $(date -u +%FT%TZ)" --query id --output text
echo
echo "Listo: https://$API_ID.execute-api.$AWS_REGION.amazonaws.com/$STAGE"
echo "Recordatorio: finish-payment y return-payment necesitan NATILLERA_RECORDS_TABLE=$RECORDS_TABLE para registrar aportes."
