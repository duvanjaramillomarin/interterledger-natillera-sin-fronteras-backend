# Curls para probar el backend

Todos los requests en un solo lugar, listos para copiar en **Git Bash** o **CloudShell**.
Explicación del API: [API.md](API.md). Prueba guiada automática: `bash scripts/probar-pago.sh`.

> Estado al 2026-10-16 (noche): todas las rutas de este archivo están desplegadas en `dev` y piden
> el **IdToken** (sin token → 401). Pagos: secciones 3–8. Bloque A (perfil, billeteras, cuentas
> guardadas, natilleras): secciones 9–14. Préstamos fase 1: secciones 15–19. Primer pago real
> EUR→COP completado con este flujo.

## 0 · Variables

```bash
API=https://lofoyfhz52.execute-api.us-east-2.amazonaws.com/dev
```

```bash
CLIENT_ID=20b10a2tnnr69lqlp2sf62orv0
```

## 1 · Crear cuenta (Cognito SignUp)

La wallet tiene que existir en la Test Wallet. Responde `{"UserConfirmed": true, "UserSub": "…"}`.

```bash
curl -s https://cognito-idp.us-east-2.amazonaws.com/ -H 'Content-Type: application/x-amz-json-1.1' -H 'X-Amz-Target: AWSCognitoIdentityProviderService.SignUp' -d '{"ClientId":"'"$CLIENT_ID"'","Username":"<usuario>","Password":"<Clave#2026>","UserAttributes":[{"Name":"email","Value":"<correo@ejemplo.com>"},{"Name":"phone_number","Value":"+57<numero>"},{"Name":"custom:walletId","Value":"https://ilp.interledger-test.dev/<wallet>"}]}'
```

## 2 · Iniciar sesión (Cognito InitiateAuth)

```bash
curl -s https://cognito-idp.us-east-2.amazonaws.com/ -H 'Content-Type: application/x-amz-json-1.1' -H 'X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth' -d '{"ClientId":"'"$CLIENT_ID"'","AuthFlow":"USER_PASSWORD_AUTH","AuthParameters":{"USERNAME":"<usuario>","PASSWORD":"<clave>"}}'
```

Copiar **`AuthenticationResult.IdToken`** (el API es REST con autorizador Cognito: va el IdToken,
no el AccessToken). No pegar tokens en chats ni en el repo.

```bash
TOKEN=<IdToken>
```

Renovar cuando vence (1 h):

```bash
curl -s https://cognito-idp.us-east-2.amazonaws.com/ -H 'Content-Type: application/x-amz-json-1.1' -H 'X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth' -d '{"ClientId":"'"$CLIENT_ID"'","AuthFlow":"REFRESH_TOKEN_AUTH","AuthParameters":{"REFRESH_TOKEN":"<RefreshToken>"}}'
```

## 3 · Iniciar pago — `POST /payments`

Paga la wallet del usuario logueado; recibe `walletAddress` (debe ser otra wallet). Monto en
unidades menores (`"100"` = 1,00) en la moneda de quien paga **o** de quien recibe.

Ejemplo probado (EUR → COP): monto fijo **en la moneda de quien recibe** (4.000,00 COP).

```bash
curl -s -X POST "$API/payments" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"kind":"p2p","walletAddress":"https://ilp.interledger-test.dev/<wallet-que-recibe>","value":"400000","assetCode":"COP","assetScale":2,"returnUrl":"natillera://retorno"}'
```

> Con monto fijo en EUR hacia una wallet COP, Rafiki falla la cotización
> (`502 OpenPaymentsError: non-positive receive amount`). Pendiente de revisar.

Pagar con una cuenta guardada (sección 11): `"customWalletName":"<nombre>"` en lugar de `walletAddress`.

Aporte a mi natillera (sección 12): `kind` `aporte` + `natilleraId`; al completarse suma a `fundTotal`.

```bash
curl -s -X POST "$API/payments" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"kind":"aporte","natilleraId":"'"$NATILLERA_ID"'","value":"5000000","assetCode":"COP","assetScale":2,"returnUrl":"natillera://retorno"}'
```

Respuesta: `{ "paymentId", "redirectUrl", "debitAmount", "receiveAmount" }`.

```bash
PAYMENT_ID=<paymentId>
```

## 4 · Aprobar en la billetera (navegador)

1. Abrir `redirectUrl` (vence en ~10 min) con la sesión de la Test Wallet **dueña de la wallet que
   paga** → **Accept**. Si la abre otra cuenta, la Test Wallet rechaza el grant.
2. La billetera vuelve a `$API/payments/{id}/return`; el backend **finaliza el pago solo** y redirige a
   `natillera://retorno?paymentId=…&result=ok|rejected|failed|pending`. En un PC el navegador no abre
   `natillera://`: es normal.
3. Si la Test Wallet muestra **"Internal Server Error"**, no significa que falló: revisar con la sección 6.

La sección 5 queda como respaldo (opción A): solo hace falta si la app recibe `interact_ref` y `hash`.

```bash
INTERACT_REF=<interact_ref>
```

```bash
HASH=<hash>
```

## 5 · Finalizar pago — `POST /payments/{id}/finish`

```bash
curl -s -X POST "$API/payments/$PAYMENT_ID/finish" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"interact_ref":"'"$INTERACT_REF"'","hash":"'"$HASH"'"}'
```

Respuesta: el pago con `"status": "completed"` (o `rejected` si se rechazó, `failed` si falló).
Repetirlo devuelve el mismo estado sin pagar de nuevo.

## 6 · Consultar un pago — `GET /payments/{id}`

```bash
curl -s "$API/payments/$PAYMENT_ID" -H "Authorization: Bearer $TOKEN"
```

`status`: `pending` (sin aprobar), `processing`, `completed`, `rejected` o `failed`.

## 7 · Historial — `GET /payments`

```bash
curl -s "$API/payments" -H "Authorization: Bearer $TOKEN"
```

## 8 · Pruebas negativas

Sin token → **401** `{"message":"Unauthorized"}`:

```bash
curl -s -i -X POST "$API/payments" -H 'Content-Type: application/json' -d '{}'
```

`returnUrl` no permitido → **400** `InvalidReturnUrl`:

```bash
curl -s -i -X POST "$API/payments" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"kind":"p2p","walletAddress":"https://ilp.interledger-test.dev/x","value":"100","assetCode":"EUR","assetScale":2,"returnUrl":"https://evil.com"}'
```

Wallet de otro host → **400** `InvalidWalletAddress`:

```bash
curl -s -i -X POST "$API/payments" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"kind":"p2p","walletAddress":"https://evil.com/x","value":"100","assetCode":"EUR","assetScale":2,"returnUrl":"natillera://retorno"}'
```

Monto inválido → **400** `InvalidAmount`:

```bash
curl -s -i -X POST "$API/payments" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"kind":"p2p","walletAddress":"https://ilp.interledger-test.dev/x","value":"1.5","assetCode":"EUR","assetScale":2,"returnUrl":"natillera://retorno"}'
```

Pago que no existe o de otra persona → **404** `PaymentNotFound`:

```bash
curl -s -i "$API/payments/no-existe" -H "Authorization: Bearer $TOKEN"
```

Si un error llega como **200** con `{"errorMessage":"[400] …"}`, faltan las *respuestas de
integración* del método ([API-PAGOS.md](API-PAGOS.md#respuestas-de-error-sin-proxy)).

---

Bloque A. Detalle de cada respuesta: [API-NATILLERAS.md](API-NATILLERAS.md). Errores con el mismo
formato `{ "error", "message" }`.

## 9 · Mi perfil — `GET /me`

```bash
curl -s "$API/me" -H "Authorization: Bearer $TOKEN"
```

Respuesta: `{ userId, sub, username, displayName, email, phone, walletAddress, assetCode, assetScale }`.
`userId` es el **username** (el mismo valor que `members[].userId` de la natillera).

## 10 · Verificar una wallet — `GET /wallets/verify?url=`

Acepta la URL completa, `$ilp.interledger-test.dev/<id>` o solo el id.

```bash
curl -s "$API/wallets/verify?url=<wallet-id>" -H "Authorization: Bearer $TOKEN"
```

Respuesta: `{ "exists": true, "walletAddress", "assetCode", "assetScale" }` o `{ "exists": false, … }`.
Host distinto de `ilp.interledger-test.dev` → **400** `InvalidWalletAddress`.

## 11 · Cuentas guardadas — `POST /accounts` y `GET /accounts`

Guardar (mismo nombre = se actualiza la wallet):

```bash
curl -s -X POST "$API/accounts" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"customWalletName":"Mamá","walletAddress":"https://ilp.interledger-test.dev/<wallet>"}'
```

Listar:

```bash
curl -s "$API/accounts" -H "Authorization: Bearer $TOKEN"
```

## 12 · Crear natillera — `POST /natilleras`

`walletAddress` es la wallet del **fondo** (define la moneda). `quota` es opcional (por defecto
50.000 COP o 20,00 en otra moneda), en unidades menores.

```bash
curl -s -X POST "$API/natilleras" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"natilleraName":"Familia Pérez","walletAddress":"https://ilp.interledger-test.dev/<wallet-del-fondo>","quota":{"value":"5000000"}}'
```

Respuesta: la natillera con `natilleraId`, `invitationCode` (formato `FAMILIA-7K3M-Q9TD`), `joinUrl`,
`fundTotal`, `members`, … Una persona solo puede estar en **una** natillera (otra vez → **409** `AlreadyMember`).

```bash
NATILLERA_ID=<natilleraId>
```

```bash
CODE=<invitationCode>
```

## 13 · Mi natillera — `GET /natilleras/mine`

```bash
curl -s "$API/natilleras/mine" -H "Authorization: Bearer $TOKEN"
```

Respuesta: la natillera (con `fundTotal`, `myTotal`, `myStatus`, `members`, `lastRecords`) o `null`.

## 14 · Invitación y unirse — `GET /invitations/{code}` y `POST /natilleras/join`

Con el token de **otra** persona (que no esté en ninguna natillera):

```bash
TOKEN_2=<IdToken de otra persona>
```

Vista previa (no distingue mayúsculas):

```bash
curl -s "$API/invitations/$CODE" -H "Authorization: Bearer $TOKEN_2"
```

Respuesta: `{ code, natilleraName, adminName, quota }`. Código inexistente → **404** `InvitationNotFound`.

Unirse (repetirlo no duplica):

```bash
curl -s -X POST "$API/natilleras/join" -H "Authorization: Bearer $TOKEN_2" -H 'Content-Type: application/json' -d '{"natilleraInvitation":"'"$CODE"'"}'
```

---

Préstamos, fase 1 (sin Open Payments). Detalle y reglas: [API-PRESTAMOS.md](API-PRESTAMOS.md).
El préstamo va en la **moneda del fondo** y no puede pasar de lo aportado (`fundTotal`).

## 15 · Simular — `GET /loans/simulate`

No guarda nada. Interés: 1 % del saldo por cuota; de 1 a 12 cuotas.

```bash
curl -s "$API/loans/simulate?value=1000000&assetCode=COP&assetScale=2&installments=3" -H "Authorization: Bearer $TOKEN"
```

Respuesta: `{ amount, installments, receiveAmount, highestInstallment, schedule: [{ n, capital, interest, total, status }] }`.

## 16 · Pedir un préstamo — `POST /loans/requests`

Solo integrantes; uno a la vez (si no → **409** `LoanAlreadyActive`); sin pasar del fondo (**409** `InsufficientFunds`).

```bash
curl -s -X POST "$API/loans/requests" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"natilleraId":"'"$NATILLERA_ID"'","value":"1000000","assetCode":"COP","assetScale":2,"installments":3}'
```

Respuesta: `{ requestId, natilleraId, requesterName, amount, installments, repaymentAuthorized, status: "pending", createdAt }`.

```bash
REQUEST_ID=<requestId>
```

## 17 · Mis préstamos — `GET /loans/mine`

Con varias natilleras se puede filtrar con `?natilleraId=$NATILLERA_ID` (también en la sección 18).

```bash
curl -s "$API/loans/mine" -H "Authorization: Bearer $TOKEN"
```

Respuesta: `{ request, loan }` (`request` = la solicitud más reciente o `null`; `loan` solo cuando ya se desembolsó).

## 18 · Solicitudes pendientes (ADMIN) — `GET /loans/requests?status=pending`

Con el token de quien **creó** la natillera. Cualquier otra persona recibe `[]`.

```bash
TOKEN_ADMIN=<IdToken de la ADMIN>
```

```bash
curl -s "$API/loans/requests?status=pending" -H "Authorization: Bearer $TOKEN_ADMIN"
```

## 19 · Decidir (ADMIN) — `POST /loans/requests/{requestId}/decision`

Rechazar → `{ "status": "rejected" }`. Repetir → **409** `AlreadyDecided`. Si no es la ADMIN → **404**.

```bash
curl -s -X POST "$API/loans/requests/$REQUEST_ID/decision" -H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json' -d '{"accepted":false}'
```

Aprobar (`"accepted":true`) todavía no desembolsa: **409** `RepaymentNotAuthorized` mientras no se
autoricen las cuotas, y **501** `DisbursementNotAvailable` hasta la fase 2 (Open Payments).
