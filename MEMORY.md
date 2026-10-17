# MEMORY.md — estado compartido entre sesiones

Memoria viva del backend. Cada sesión lee esto al empezar y actualiza **solo su sección** al
terminar. Fechas absolutas (YYYY-MM-DD). Reglas de uso en [CLAUDE.md](CLAUDE.md).

## Estado general

- 2026-10-16 — Repo creado por Duvan (`initial commit`: solo `app/package.json` con
  `@interledger/open-payments ^7.4.0`). Arquitectura final transcrita a
  [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md). Setup de CLAUDE.md / MEMORY.md / AI_USAGE.md subido a la rama `david`.
- Ramas: `master` (integración por PR), `duvdev` (la crea y maneja Duvan), `docs` (Camilo: info de
  conexión con el frontend), `david` (David + sus
  sesiones de Claude; las sesiones salen de `david` con `feat/<carril>-...` y vuelven a `david`).

## Metas acordadas con todo el equipo (2026-10-16)

Enfoque actual: **pagos 1 a 1**. Lo demás espera a que P0 funcione.

| Cuándo | Meta | Entregable | Responsable |
|---|---|---|---|
| Vie 16, 11:00–14:00 | **P0** Pago 1 a 1 con grant interactivo (solicitud, autorización, ejecución, confirmación) | Pago real **EUR→COP** en la Test Wallet | Duvan (backend); Camilo y David (pantalla) |
| Vie 16, 15:00–17:30 | **P1** Cuota recurrente con scheduler + aporte desde el exterior | Cuota cobrada por el backend | Duvan, David |
| Vie 16 noche | **P2** App de la natillera: crear, unirse, aportar, historial | Flujo completo navegable | Camilo, Henry |
| Vie 16 (si 17:30 estable) | P3 Préstamo con aprobación de la tesorera (opcional) | Préstamo + plan de pagos | Duvan |
| Sáb 17, 8:00–9:00 | P4 Diciembre / reparto (opcional, solo si P0–P2 firmes) | Reparto de diciembre | Camilo, David |
| Sáb 17, 9:00–11:00 | Pruebas, README, `AI_USAGE.md`, `/prompts` | Repo listo | Henry, todos |
| **Sáb 17, 11:00** | **CÓDIGO CONGELADO** en `main` del repo público | Commit final | Todos |
| Sáb 17, antes 12:00 | Video demo (pantalla del pago real) y slides | Video + slides | Henry |
| Sáb 17, 12:00 / 14:30–16:30 | Ronda 1 (8 criterios 0–5) / Ronda 2 y ganadores | Pitch | Henry / todos |

Mapeo a la arquitectura: P0 = flujos 3 y 4 (+ signup/login mínimos); P1 = flujos 12 y 9;
P2 = flujos 7, 8, 9, 13; P3 = flujos 10, 11, 12B; P4 no está en el diagrama.

## Carriles de trabajo

| Carril | Alcance (flujos de docs/ARQUITECTURA.md) | Dueño de archivos compartidos | Equipo (duvdev / david) | Sesión | Estado |
|---|---|---|---|---|---|
| `infra` | Infra AWS manual / AWS CLI: API Gateway, Cognito, 9 tablas DynamoDB, Secrets Manager, EventBridge Scheduler | Definición de infra y tablas | david | — | libre |
| `op-core` | Capa compartida del cliente Open Payments (cliente autenticado, verificar wallet, incoming, quote, grants, continue, outgoing, rotate token) + utilidades de montos | Capa Open Payments, tipos de montos | duvdev | — | libre |
| `pagos` | Flujos 3 y 4 (start / finish payment), 5 y 6 (cuentas guardadas y pago a ellas) | — | duvdev | — | libre |
| `usuarios` | Flujos 1 y 2 (signup con verificación de wallet, login Cognito) y 13 (lecturas GET) | Middleware de auth (sub del token) | duvdev | — | libre |
| `natillera` | Flujos 5, 7, 8 y 13 sin préstamos (cuentas, crear, unirse, `/me`, `/natilleras/mine`) | Tablas `saved-accounts`, `natillera-registration` | Camilo (rama `feat/natilleras`) | Claude Code de Camilo, 2026-10-16 noche | código + pruebas locales listos; falta desplegar (Ciro) |
| `credito` | Flujos 10, 11, 12, 12B (préstamos, recurrentes, cobro de cuotas) | — | Henry (10, 11 y lecturas de préstamos; 12/12B quedan en demo) | Claude Code de Henry, 2026-10-16 noche | reclamado |

Orden sugerido: `infra` + `op-core` primero (desbloquean todo); `usuarios` en paralelo con
mocks; luego `pagos`, `natillera`, `credito`.

## Decisiones abiertas (del diagrama)

1. Periodo de la cuota recurrente: mensual (`P1M`) o quincenal (`P15D`), y número de repeticiones.
2. Tasa del préstamo (TEA): aparecen 2,7 %, 2 % mensual y 1 % quincenal.
3. Amortización (12B): capital fijo con cuota decreciente, o cuota fija. Qué pasa con la mora.
4. Integración API Gateway: Lambda proxy o VTL en los flujos que tocan Open Payments.
5. Canal de aviso a la administradora además de la lista en la app (SMS o Telegram).

Decisiones técnicas aún sin tomar:
- API Gateway: HTTP API (recomendado, authorizer JWT de Cognito) o REST API (necesario si se usa VTL).

## Decisiones tomadas

- 2026-10-16 · Lenguaje: **TypeScript**.
- 2026-10-16 · Región AWS: **`us-east-2` (Ohio)**, un solo entorno. Cuenta `349607459198`.
- 2026-10-16 · **Sin herramienta de IaC** (ni CDK, SAM, Terraform). La infra AWS se crea a mano en
  la consola siguiendo [docs/AWS-SETUP.md](docs/AWS-SETUP.md); más adelante se automatiza con
  scripts de **AWS CLI**.
- 2026-10-16 · Reparto: **Duvan escribe el código de las Lambdas** (rama `duvdev`); **David monta
  y opera la infra AWS** (rama `david`), porque Duvan no tiene acceso a AWS por ahora.

## Pedidos entre carriles

- 2026-10-16 · de infra (david) a duvdev: arreglos a `cognito-pre-signup.handler.ts` (versión ya
  desplegable en `deploy/pre-signup/index.mjs`): (1) región `us-east-1` fija → usar
  `process.env.AWS_REGION` (estamos en us-east-2); (2) `getSecrets` devuelve el string sin
  `JSON.parse`; (3) [corregido: el SDK 7.4.0 sí acepta el PEM como string] para solo verificar una wallet basta
  un GET público sin llaves; (4) `if (!walletId && !isWalletCreated)` debe ser `||` (hoy deja pasar
  wallets inexistentes); (5) el trigger debe hacer `return event` y poner
  `event.response.autoConfirmUser = true`; (6) usar `event.userPoolId` en vez de `USER_POOL_ID`;
  (7) `@interledger/open-payments` no viene en el runtime de Lambda: hay que empaquetarlo (esbuild).
- 2026-10-16 · de infra (david) a duvdev: sobre `saveUserEvent` (commit fbd01d3), ya integrado en
  `deploy/pre-signup/index.mjs`: (1) el campo es `event.userName`, no `event.Username` (llegaba
  undefined y el Put fallaba); (2) en Pre sign-up no existe el `sub` → `Users-info` usa PK
  `username` (el access token trae el claim `username`); (3) se guardan `walletAddress`,
  `assetCode`, `assetScale` leídos de la wallet en vez de `source`/`id: 1`; (4) `PutItem` con
  `attribute_not_exists(username)` para no pisar a otro usuario; (5) `saveUserEvent` va después
  de las validaciones (ya estaba bien). Si prefieren `userId = sub`, hay que moverlo a un trigger
  Post confirmation.
- 2026-10-16 · del front (Camilo y equipo) a duvdev + david — prioridad máxima, antes de las
  2:00 a. m.: (1) desplegar iniciar y finalizar pago con la forma de `docs/openapi.yaml` del repo
  del front (`POST /payments` + finalización) y pasarles la URL base del HTTP API; (2) iniciar debe
  devolver además `debitAmount` y `receiveAmount` de la quote; (3) aceptar `returnUrl` del body
  (`natillera://retorno` o `exp://...`) como `interact.finish.uri`, con allowlist de esos dos
  esquemas — aplica también a `/recurring`, `/loans/requests/{id}/repayment-grant` y `/decision`;
  (4) reglas de la hackathon: rama `main` con el código, `AI_USAGE.md` con las 4 secciones (hecho
  en `david`) y `/prompts` al día.
- 2026-10-16 · revisión de `start-payment.ts` (commit 87d69a6) de infra (david) a duvdev.
  Bloqueantes: (1) lee `event.username/walletAddress/amount`, pero en HTTP API el usuario está en
  `event.requestContext.authorizer.jwt.claims.username` y los datos en `JSON.parse(event.body)`;
  (2) `getSecrets(userInfo.source)` usa el username como nombre del secreto → debe ser
  `natillera/open-payments-client`, y falta `JSON.parse(SecretString)`; (3) región `us-east-1`
  fija (estamos en us-east-2); (4) `userInfo.walletInfo.walletAddress.*` no existe: `user-info`
  guarda `walletAddress` (URL) → hacer `client.walletAddress.get` de la wallet del que paga;
  (5) el grant interactivo no tiene `finish` → la billetera no devuelve a la app ni hay
  `interact_ref`: falta `finish: { method: 'redirect', uri: returnUrl + '?paymentId=…', nonce }` con
  allowlist de `returnUrl`; (6) no guarda en `payments-history` (paymentId, author, quoteId,
  incomingPaymentId, continueUri, continueToken, nonce, status pending, montos) → `finish` no
  podría continuar; (7) no devuelve nada (solo `console.log`): debe responder
  `{ paymentId, redirectUrl, debitAmount, receiveAmount }`; (8) el export se llama
  `paymentHandler` (handler en Lambda: `index.paymentHandler` o renombrar a `handler`).
  Contrato del front (`docs/api-contrato.md`): `POST /payments` recibe `{ kind: 'p2p'|'aporte',
  customWalletName? | natilleraId?, value, assetCode, assetScale, returnUrl }`, no `walletAddress`.
  Faltan además `POST /payments/{id}/finish` y `GET /payments/{id}`.
- 2026-10-16 noche · de natillera (Camilo) a pagos (Ciro): (1) poner `NATILLERA_RECORDS_TABLE=natillera-records`
  en el entorno de `finish-payment` y `return-payment` (en `env_file` de `deploy-payments.sh`); sin eso
  `complete.ts` no registra aportes y el total del fondo queda en 0. (2) Desplegar el bloque A con
  `infra/deploy-natilleras.sh` (ver docs/API-NATILLERAS.md).
- 2026-10-17 · de front (Henry) a Duvan (dueño del repo): **crear la rama `main` y ponerla por defecto antes de las 11:00** (regla de la hackatón: todo en `main` del repo público). Hoy la rama por defecto es `master` y solo tiene el commit inicial; todo el trabajo está en `david`. Pasos: (1) fusionar los PR abiertos en `david`; (2) `git push origin origin/david:refs/heads/main` (o en GitHub: Branches → New branch `main` desde `david`); (3) Settings → General → Default branch → `main` (solo el dueño puede); (4) desde ahí, todo PR va a `main`. No borrar `master` ni `david` hasta después de la entrega.
- formato: `YYYY-MM-DD · de <carril> a <carril>: <qué se necesita>`

## Bitácora por carril

### infra
- 2026-10-16 · Guía de montaje manual en [docs/AWS-SETUP.md](docs/AWS-SETUP.md). Avance paso a
  paso en la tabla "Estado" de esa guía (IDs y ARNs que no son secretos van ahí).
- 2026-10-16 · Pasos 0, 2 y 3 listos: secreto Open Payments, user pool `us-east-2_2pQzW95IK`,
  app client `20b10a2tnnr69lqlp2sf62orv0`, Lambda `pre-signup` desplegada. Signup + login probados
  de punta a punta (usuario `prueba1`). Requests para el front en `docs/API-AUTH.md`.
- 2026-10-16 · Pagos P0 escritos por infra (pendiente revisión de Duvan): `deploy/payments`
  (TS + esbuild → 3 zips) con `start-payment`, `finish-payment`, `get-payment` según el contrato del
  front; guía de despliegue y curl de prueba en `docs/API-PAGOS.md`. Probado local: tipos, bundle,
  validaciones y conexión firmada del SDK a la Test Wallet. Sin probar en AWS.
- 2026-10-16 · API REST `lofoyfhz52` (stage `dev`) con `cognito_authorizer` e integración **VTL**
  (Duvan). Lambdas de pagos en modo `INTEGRATION_MODE=vtl`: identidad solo en `auth.username`,
  body en `body`, transferencia del cuerpo = Nunca. Errores `[status] {json}` mapeados en la
  respuesta de integración. Token: IdToken.
- 2026-10-16 (~19:50 COL) · Despliegue por AWS CLI con `infra/deploy-payments.sh` (perfil
  `natillera`, `aws login`): tabla `payments-history` (+ GSI `author-index`); Lambdas
  `finish-payment` y `get-payment` con el código del repo, `INTEGRATION_MODE=vtl`, timeouts 25/10 s;
  rutas `/payments` (POST, GET), `/payments/{id}` (GET), `/payments/{id}/finish` (POST) con
  `cognito_authorizer`, VTL con username escapado, transferencia del cuerpo NEVER y respuestas de
  error; rutas viejas endurecidas igual; deployment en `dev`. Verificado: todas las rutas 401 sin
  token; `get-payment`/`finish-payment` responden 404 bien formado (DynamoDB OK).
  **`start-payment`: Duvan lo está desplegando en paralelo desde la consola** (subió su código a las
  00:42 y 00:52 UTC). Su versión lee `USERS_VIEW_TABLE`, que no está en la Lambda → falla con
  `tableName null`. Respaldos: v1 (edición en consola), v2 (repo), v3 (código de Duvan de 00:42).
  Acordar cuál `start-payment` queda antes de volver a correr el script.
- 2026-10-16 (~20:01 COL) · Decisión: queda el `start-payment` **del repo** (código de Duvan
  respaldado como v4); David coordina con Duvan para no volver a subirlo desde la consola.
  Verificado invocando la Lambda: validaciones 400/401/404 OK y **un inicio de pago real contra
  Open Payments** (prueba1, wallet `melos` COP → `f9a1abde` EUR: 1,00 EUR llega, 3.552,19 COP sale;
  pago `d010eca7…` en `pending`). Usuarios de prueba prueba1/2/3 tienen la wallet `melos` (COP).
- 2026-10-16 (~20:50 COL) · Aprobar en la Test Wallet con `finish.uri = exp://…` da *Internal
  Server Error* al aceptar (probado: el front lo abrió en 1 min, no era vencimiento). Se implementó la
  **opción B**: `start-payment` usa `finish.uri = <API>/payments/{id}/return` (env `RETURN_BASE_URL`);
  nueva Lambda `return-payment` (ruta pública `GET /payments/{id}/return`, proxy) verifica el hash,
  finaliza y responde 302 a `<returnUrl>?paymentId=…&result=ok|rejected|failed|pending`. Sin hash no
  cambia nada. `POST /payments/{id}/finish` queda como respaldo (idempotente). Desplegado (`c9epko`).
  Ojo: si alguien abre el enlace de aprobación con una cuenta que no es dueña de la wallet que paga,
  la Test Wallet **rechaza el grant** automáticamente (enlace inservible).
- 2026-10-16 · `pre-signup` ahora también guarda en `user-info` (PK `source` + `id`), basado en el
  cambio de Duvan. Falta crear la tabla y desplegar.
- 2026-10-16 (~21:40 COL) · El registro fallaba con `PreSignUp failed with error exports is not
  defined in ES module scope`: en la Lambda **`pre-signup`** se había subido (19:37 COL) un
  start-payment compilado a CommonJS dentro de `index.mjs`. Se respaldó como **versión 1** y se
  restauró `deploy/pre-signup/index.mjs` del repo; timeout 3 s → 10 s. Verificado: rechaza wallet
  inválida. **Antes de subir desde la consola, revisar el nombre de la Lambda.**
- 2026-10-16 (~21:32 COL) · **P0 logrado: primer pago real EUR→COP completo.** Usuario
  `ciro-demo-euro` (wallet `ciroeur`, EUR) → `cirocol` (COP): 2,13 EUR → 4.000 COP, pago
  `a03971c1…`, outgoing payment `d1a0f088…`. Flujo opción B: aprobar en la Test Wallet →
  `return-payment` verificó el hash y finalizó → `completed`. La Test Wallet **igual mostró
  "Internal Server Error"**: su backend convierte en 500 cualquier error de Rafiki que no sea el texto
  `'Bad Request'` (p. ej. un segundo PATCH sobre una interacción ya aceptada). **El 500 no significa
  que el pago falló: revisar `GET /payments/{id}`.** Monto fijo de débito en EUR hacia COP falló en
  la cotización (`non-positive receive amount`); monto fijo de recepción en COP sí funciona.
- 2026-10-16 (~23:30 COL) · **Bloque A desplegado en `dev`** (código del front, rama
  `back/feat-natilleras`, integrado en `david`): 3 tablas (`saved-accounts`, `natillera-registration`
  + `invitation-index`, `natillera-records`), 8 Lambdas y 8 rutas VTL con Cognito (deployment `kzds5w`).
  Corrección propia: código de invitación `PALABRA-XXXX-XXXX` (Crockford base32, ~2^40) en vez de
  `PALABRA-1234` (adivinable). Probado: 401 sin token en las 8 rutas; con `ciro-demo-euro` funcionan
  perfil, verificar wallet (y rechazo de host ajeno), cuentas guardadas, crear natillera (`Familia Ciro`,
  wallet `cirocol`), invitación, unirse idempotente y 409 al crear otra.
  `finish-payment` (v5 respaldo) y `return-payment` (v2) ahora tienen
  `NATILLERA_RECORDS_TABLE=natillera-records`, solo por configuración.
  **Duvan maneja `start-payment` por ahora: no correr `infra/deploy-payments.sh`** (la redespliega).
  Su `start-payment` falla con `AccessDenied` al leer el secreto `prueba1`: lo bloquea una **SCP de la
  organización** (no se arregla con IAM). Solución: un solo secreto (`OP_SECRET_ID`), región us-east-2.
- 2026-10-17 (~01:00 COL) · **Decisión del equipo: priorizar funcionalidad para la hackatón.** El
  `start-payment` desplegado es el de Duvan (3 fases: start → continue → complete; hoy devuelve la quote)
  y usa la llave privada de cada usuario guardada en `user-info` (`walletInfo.walletKeys`; `prueba1` ya la
  tiene). Queda como **deuda técnica de seguridad** para después de la hackatón: llaves en texto plano en
  DynamoDB y `console.log` de la llave (se pidió quitar esa línea). Versión segura de referencia:
  `deploy/payments/src/start-payment.ts` (una sola llave del cliente en Secrets Manager). Rotar las llaves
  de la Test Wallet después de la demo. Equivalencia: start+continue de Duvan = nuestro `start-payment`;
  complete = `return-payment` / `finish-payment`.
- 2026-10-17 (~01:05 COL) · **Préstamos fase 1 desplegado** (PR #3 de Henry, fusionado en `david`):
  tabla `natillera-loan-request` (+ `author-index`, `natillera-index`), 5 Lambdas y 5 rutas VTL
  (deployment `g1qlqr`). 401 sin token en las 5. Probado con `ciro-demo-euro` (ADMIN de "Familia Ciro"):
  simular OK (BigInt), pedir → 409 `InsufficientFunds` (fondo en 0, falta un aporte), otra moneda → 400,
  mis préstamos → vacío, pendientes → `[]`, decidir por no-ADMIN → 404. Aprobar/desembolsar = fase 2.
  Ojo: tras un deployment, el stage tarda ~1 min; antes responde 403 "Missing Authentication Token".
- 2026-10-17 (~01:20 COL) · **PR #4 (préstamos con varias natilleras) desplegado** sin correr el script
  completo: `request-loan`, `get-my-loans`, `list-loan-requests` (respaldo v1 de cada una) y plantillas de
  `GET /loans/requests` y `GET /loans/mine` con `natilleraId` opcional (escapado). Deployment `pxnk9k`.
  Probado: listas vacías, 409 `InsufficientFunds`, 401 sin token.

### op-core
- (vacío)

### pagos
- (vacío)

### usuarios
- (vacío)

### natillera
- 2026-10-16 noche · Bloque A en `feat/natilleras` (sale de `david`): 8 Lambdas en `deploy/natilleras`
  (`get-me`, `verify-wallet`, `save-account`, `list-accounts`, `create-natillera`, `get-invitation`,
  `join-natillera`, `get-my-natillera`), despliegue en `infra/deploy-natilleras.sh` y doc en
  [docs/API-NATILLERAS.md](docs/API-NATILLERAS.md). `npm test`: 6/6 con DynamoDB en memoria. Sin desplegar.
- Contrato con préstamos: el fondo = aportes − `disbursedTotal` (string, unidades menores) de la fila en
  `natillera-registration`; préstamos lo suma al quedar `completed` un desembolso.

### credito
- (vacío)
