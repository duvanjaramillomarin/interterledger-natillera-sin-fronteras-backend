# GET /me y GET /natilleras/mine

Escritas por el front (Henry) para que la app salga de los datos de ejemplo en las pantallas 04, 10 y 11.
Solo leen DynamoDB; no tocan Open Payments ni Secrets Manager.

| Ruta | Lambda | Carpeta | Integración |
|---|---|---|---|
| `GET /me` | `natillera-me` | `deploy/me` | REST **proxy** + `cognito_authorizer` |
| `GET /natilleras/mine` | `natilleras-mine` | `deploy/natilleras-mine` | REST **proxy** + `cognito_authorizer` |

Proxy (no VTL) a propósito: sin plantillas ni respuestas de integración, los errores llegan con su status real.

## Desplegar

```bash
AWS_PROFILE=natillera bash infra/deploy-natillera.sh
```

Hace, idempotente y con versión de respaldo de cada Lambda: tabla `natillera-registration` (PK `natilleraId`),
semilla `infra/seed-natillera.json`, política de solo lectura `natillera-read` en el rol de `start-payment`,
las dos Lambdas (Node 22, `index.handler`), las dos rutas y *Deploy API* a `dev`. Al final, sin token,
las dos rutas deben dar `401`.

## Semilla (natillera `n-rosa`)

Para la demo con los usuarios de prueba que ya tienen la wallet `melos` (COP):

| Usuario | Nombre en la app | Rol | Saldo inicial | Estado |
|---|---|---|---|---|
| `prueba1` | Doña Rosa | admin | 33,00 € | al día |
| `prueba2` | Luz | socia | 22,00 € | al día |
| `prueba3` | Andrés | socio | 11,00 € | **debe** (al poner la cuota queda al día: camino del pitch) |

Fondo: `https://ilp.interledger-test.dev/f9a1abde` (EUR, la misma del primer pago real). Cuota: 11,00 €.
Pagar desde `melos` (COP) a un fondo en EUR muestra la conversión en la pantalla 28.

## Reglas

- **Identidad = `cognito:username`.** `GET /me` ahora devuelve `userId = username` (antes `sub`, que va en
  `sub`). Es lo que usa `start-payment` en `author`/`integrants`, y la app compara `members[].userId` con
  `me.userId` para «¿A nombre de quién?» (el `author` que manda en un aporte).
- Total de cada socio = `openingTotals` + aportes `completed` a su nombre (`onBehalfOf ?? author`),
  en la moneda del fondo. Total del fondo = suma de los socios.
- Cuota exigida: 1 por mes (hora de Colombia). «al-dia» si tiene un aporte `completed` este mes o está en
  `paidThisMonth` de la semilla.
- `lastRecords`: los 5 aportes `completed` más recientes.
- Sin natillera → `200 null` (la app muestra «crear o unirse»).

## Comprobar con token

```bash
curl -s -H "Authorization: Bearer $ID_TOKEN" https://lofoyfhz52.execute-api.us-east-2.amazonaws.com/dev/natilleras/mine
```

En el front, Camilo agrega `getMe,getMyNatillera` a `EXPO_PUBLIC_REAL_METHODS` (junto con
`startPayment,finishPayment,getPayment`).
