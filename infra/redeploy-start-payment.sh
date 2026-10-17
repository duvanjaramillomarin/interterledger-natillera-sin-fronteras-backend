#!/usr/bin/env bash
# Vuelve a desplegar SOLO la Lambda start-payment con el código del repo (deploy/payments, el que hizo
# el pago real EUR→COP) y la deja con la configuración que esperan la ruta VTL y la opción B.
# No toca rutas, tablas, roles ni las otras Lambdas (finish, get, return siguen como están).
#
# Antes de reemplazar publica una VERSIÓN de respaldo de lo que haya desplegado (p. ej. la de Duvan
# de las 23:29); el número sale impreso ("respaldo publicado: versión N"). Para volver a ella:
#   curl -so /tmp/v.zip "$(aws lambda get-function --function-name start-payment --qualifier N --query Code.Location --output text)"
#   aws lambda update-function-code --function-name start-payment --zip-file fileb:///tmp/v.zip
# (y su handler/variables, que se ven con get-function-configuration --qualifier N).
#
# Uso:  cd deploy/payments && npm ci && node build.mjs && cd ../..
#       AWS_PROFILE=natillera bash infra/redeploy-start-payment.sh            # despliega y verifica
#       TEST_USER=prueba1 AWS_PROFILE=natillera bash infra/redeploy-start-payment.sh
#         (además inicia un pago real de prueba de 1,00 EUR de prueba1 al fondo f9a1abde: queda
#          `pending` en payments-history y NO mueve plata hasta que alguien lo apruebe en la Test Wallet)
set -euo pipefail

export AWS_REGION="${AWS_REGION:-us-east-2}"
export AWS_PAGER=""
export MSYS_NO_PATHCONV=1
ACCOUNT="349607459198"
API_ID="${API_ID:-lofoyfhz52}"
STAGE="${STAGE:-dev}"
FN="start-payment"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZIP="$ROOT/deploy/payments/dist/start-payment.zip"
TMP="$(mktemp -d)"
if command -v cygpath >/dev/null 2>&1; then TMP="$(cygpath -m "$TMP")"; ZIP="$(cygpath -m "$ZIP")"; fi
trap 'rm -rf "$TMP"' EXIT
log() { echo; echo "== $*"; }
PY=""
for c in python3 python py; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import zipfile' >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -n "$PY" ] || { echo "Falta Python 3"; exit 1; }

aws sts get-caller-identity --query Account --output text | grep -q "$ACCOUNT" || { echo "Sesión en otra cuenta"; exit 1; }
[ -f "$ZIP" ] || { echo "Falta $ZIP (cd deploy/payments && npm ci && node build.mjs)"; exit 1; }
# El zip debe traer el arreglo del ENOENT del SDK (validateResponses: false).
"$PY" - "$ZIP" <<'PYEOF' || { echo "El zip no trae validateResponses: false: recompilar desde el repo"; exit 1; }
import sys, zipfile
src = zipfile.ZipFile(sys.argv[1]).read("index.js").decode("utf-8")
sys.exit(0 if "validateResponses: false" in src and "src/start-payment.ts" in src else 1)
PYEOF

log "Estado actual de $FN"
aws lambda get-function-configuration --function-name "$FN" \
  --query '{handler:Handler,runtime:Runtime,timeout:Timeout,memory:MemorySize,modified:LastModified,env:Environment.Variables}' --output json

log "Respaldo de lo desplegado"
BACKUP="$(aws lambda publish-version --function-name "$FN" --description "respaldo antes de redeploy-start-payment $(date -u +%FT%TZ)" --query Version --output text)"
echo "respaldo publicado: versión $BACKUP"

log "Código del repo"
aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$ZIP" --query 'CodeSha256' --output text
aws lambda wait function-updated-v2 --function-name "$FN"

log "Configuración (VTL + opción B)"
BASE_URL="https://$API_ID.execute-api.$AWS_REGION.amazonaws.com/$STAGE"
cat > "$TMP/env.json" <<EOF
{"Variables":{"INTEGRATION_MODE":"vtl","OP_SECRET_ID":"natillera/open-payments-client","USER_VIEW_TABLE":"user-info","PAYMENTS_TABLE":"payments-history","NATILLERAS_TABLE":"natillera-registration","SAVED_ACCOUNTS_TABLE":"saved-accounts","NATILLERA_RECORDS_TABLE":"natillera-records","RETURN_BASE_URL":"$BASE_URL"}}
EOF
aws lambda update-function-configuration --function-name "$FN" --handler index.handler --runtime nodejs22.x \
  --timeout 25 --memory-size 512 --environment "file://$TMP/env.json" --query 'LastUpdateStatus' --output text
aws lambda wait function-updated-v2 --function-name "$FN"

invoke() { # invoke '<evento json>' → imprime la respuesta (o el errorMessage) de la Lambda
  printf '%s' "$1" > "$TMP/event.json"
  aws lambda invoke --function-name "$FN" --cli-binary-format raw-in-base64-out \
    --payload "file://$TMP/event.json" "$TMP/out.json" --query 'FunctionError' --output text >/dev/null || true
  cat "$TMP/out.json"; echo
}

log "Verificación 1: validación sin Open Payments (debe decir [400] InvalidReturnUrl)"
OUT="$(invoke '{"auth":{"username":"prueba1"},"body":{"kind":"p2p","value":"100","assetCode":"EUR","assetScale":2}}')"
echo "$OUT"
grep -q 'InvalidReturnUrl' <<<"$OUT" || { echo "FALLO: la Lambda no responde como la del repo. Revisar logs: aws logs tail /aws/lambda/$FN --since 5m"; exit 1; }

log "Verificación 2: la ruta sin token (debe dar 401)"
echo "POST /payments → $(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/payments")"

if [ -n "${TEST_USER:-}" ]; then
  log "Verificación 3: inicio de pago REAL de $TEST_USER → fondo f9a1abde (1,00 EUR; queda pending, no mueve plata)"
  OUT="$(invoke "{\"auth\":{\"username\":\"$TEST_USER\"},\"body\":{\"kind\":\"p2p\",\"walletAddress\":\"https://ilp.interledger-test.dev/f9a1abde\",\"value\":\"100\",\"assetCode\":\"EUR\",\"assetScale\":2,\"returnUrl\":\"natillera://retorno\"}}")"
  echo "$OUT" | head -c 600; echo
  if grep -q '"redirectUrl"' <<<"$OUT"; then
    echo "OK: Open Payments respondió (incoming payment + quote + grant). El pago queda pending hasta aprobarlo."
  else
    echo "FALLO en Open Payments o datos: revisar el mensaje de arriba y aws logs tail /aws/lambda/$FN --since 5m"
    exit 1
  fi
fi

echo
echo "Listo. Si hay que volver atrás: la versión $BACKUP tiene lo que estaba antes."
echo "Siguiente: en la app (Expo Go o APK) con prueba1/2/3 → poner la cuota o pagar → aprobar en la Test Wallet → resultado."
