# AI Usage — Natillera sin Fronteras (backend)

Divulgación del uso de IA según la [política de IA de la hackathon](https://interledger.org/hackathon/ai-policy/).
Cada persona del equipo agrega lo suyo en las cuatro secciones y sus prompts literales en
[`/prompts`](prompts/). Última actualización: 2026-10-17.

## Tools Used

| Herramienta | Modelo | Quién | Plan / créditos |
|---|---|---|---|
| Claude Code (app de escritorio) | Claude Opus 5.5 | David Ciro | Plan de pago de Claude (suscripción); consumo de créditos: _por completar_ |
| _(Duvan: agregar si usó alguna herramienta de IA)_ | | Duvan Jaramillo | |
| Claude Code (app de escritorio) | Claude Opus 5.5 | Henry Taborda (front, apoyo al back) | Plan de pago de Claude (suscripción) |

## Where and How We Used AI

**David Ciro · Claude Code (infra AWS, documentación, Lambdas de soporte)**

- **Lectura de la arquitectura:** Claude extrajo el contenido de la página 3 del draw.io desde
  Google Drive y lo transcribió a [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md).
- **Coordinación del equipo y de las sesiones de IA:** [`CLAUDE.md`](CLAUDE.md) y [`MEMORY.md`](MEMORY.md).
  Contienen las reglas, el modelo de ramas, los carriles de trabajo, las decisiones y los pedidos entre carriles.
- **Guía de montaje en AWS:** [`docs/AWS-SETUP.md`](docs/AWS-SETUP.md). Cubre Secrets Manager, Cognito,
  DynamoDB, IAM con políticas de mínimo privilegio, Lambda, API Gateway con authorizer JWT y EventBridge.
  Claude la escribió y guió paso a paso; David ejecutó cada paso a mano en la consola.
- **Lambda `pre-signup`:** [`deploy/pre-signup/index.mjs`](deploy/pre-signup/index.mjs). Es una versión
  desplegable del handler TypeScript de Duvan (`app/src/handlers/cognito-pre-signup.handler.ts`).
  Claude encontró y corrigió errores: región fija, secreto sin `JSON.parse`, `&&` en lugar de `||`,
  falta de `return event`, `event.Username` en lugar de `event.userName` y una dependencia no
  incluida en el runtime. Una revisión automática de seguridad marcó además un SSRF y la
  auto-verificación de email/teléfono, y ambas cosas se corrigieron.
- **Lambda `natillera-me`:** [`deploy/me/index.mjs`](deploy/me/index.mjs). Es un `GET /me` de prueba
  para verificar la cadena Cognito → API Gateway → Lambda → DynamoDB.
- **Lambdas de pagos P0** ([`deploy/payments/src`](deploy/payments/src)): `start-payment`
  (incoming payment + quote + grant interactivo con `finish` y allowlist de `returnUrl`),
  `finish-payment` (verificación del hash de interacción, continuación del grant, outgoing payment,
  idempotencia) y `get-payment`. Claude las escribió desde el contrato del front y la revisión del
  borrador de Duvan (`app/src/handlers/start-payment.ts`), y las probó en local (tipos, bundle,
  validaciones, conexión firmada a la Test Wallet). Duvan las revisa antes de desplegar.
  Guía y requests de prueba: [`docs/API-PAGOS.md`](docs/API-PAGOS.md).
- **Despliegue por AWS CLI** ([`infra/deploy-payments.sh`](infra/deploy-payments.sh)): Claude
  escribió y ejecutó el script (tabla, Lambdas, rutas VTL, autorizador, respuestas de error,
  deployment) con credenciales temporales de `aws login`, aprobado por David. Dos revisiones
  automáticas de seguridad marcaron la inyección del `username` en las plantillas y la
  suplantación por passthrough; ambas se corrigieron y verificaron (todas las rutas 401 sin token).
- **Documentación del API y script de prueba:** [`docs/API.md`](docs/API.md) (piezas, auth,
  endpoints, flujo de pago, errores) y [`scripts/probar-pago.sh`](scripts/probar-pago.sh) (prueba
  interactiva de punta a punta sin exponer tokens).
- **Requests de auth para el front:** [`docs/API-AUTH.md`](docs/API-AUTH.md). Incluye SignUp e
  InitiateAuth contra Cognito y un ejemplo con `fetch` para React Native.
- **Verificaciones automáticas:** consultas a la wallet de prueba (`GET` público), una llamada de
  prueba al endpoint de Cognito y la validación de sintaxis de las Lambdas con `node --check`.
- **Opción B del retorno** ([`deploy/payments/src/return-payment.ts`](deploy/payments/src/return-payment.ts),
  [`complete.ts`](deploy/payments/src/complete.ts)): la billetera vuelve por https al backend, que
  verifica el hash, finaliza el pago y redirige a la app. Una revisión automática marcó un open
  redirect; se corrigió revalidando `returnUrl` contra la lista cerrada.
- **Depuración del primer pago real:** Claude restauró la Lambda `pre-signup` (tenía cargado otro
  código), leyó el código fuente de la Test Wallet y de Rafiki para explicar el "Internal Server Error"
  al aceptar, consultó el estado del grant y los logs, y confirmó el **primer pago EUR→COP completado**
  (2,13 EUR → 4.000 COP). David hizo la aprobación en su Test Wallet.
- **Diagnóstico de AWS para Duvan:** el `AccessDenied` al leer un secreto venía de una SCP de la
  organización (no de IAM); y la falta de logs, de log streams borrados sin invocaciones nuevas.
  Reporte para el equipo: [`docs/REPORTE-DUVAN.md`](docs/REPORTE-DUVAN.md).
- **Integración y despliegue del bloque A** (código de Camilo y Henry): Claude revisó el código y el
  script, corrió las pruebas, desplegó en `dev` y probó las 8 rutas. Una revisión automática marcó que
  el código de invitación (`PALABRA-1234`) se podía adivinar; se cambió a `PALABRA-XXXX-XXXX`
  (Crockford base32, ~2^40). Requests: [`docs/CURLS.md`](docs/CURLS.md) secciones 9–14.

**Camilo · Claude Code (bloque A: natilleras, cuentas guardadas y perfil)**

- **Lambdas de natilleras** ([`deploy/natilleras/src`](deploy/natilleras/src)): crear natillera,
  invitación, unirse, "mi natillera" con totales y estado de cada socio, cuentas guardadas, `GET /me` y
  verificación de billetera. Claude las escribió desde `docs/ARQUITECTURA.md` y el contrato del front,
  con el mismo patrón VTL de pagos, y las probó en local con un DynamoDB en memoria (6 casos).
- **Despliegue** ([`infra/deploy-natilleras.sh`](infra/deploy-natilleras.sh)): script de AWS CLI que
  Claude escribió; lo ejecuta David Ciro. Doc: [`docs/API-NATILLERAS.md`](docs/API-NATILLERAS.md).

Los commits hechos con IA llevan `Co-Authored-By: Claude` en el historial de git.

## What We Did Ourselves

- **Arquitectura y diseño de flujos** (draw.io, 13 flujos y tablas): el equipo, sin IA.
- **Handlers de las Lambdas en TypeScript** (`app/src/handlers/*`, rama `duvdev`): Duvan Jaramillo.
  _(Duvan: confirmar si usó IA en algún archivo.)_
- **Montaje real en AWS:** David creó a mano en la consola los siguientes recursos y probó el registro y
  el login de punta a punta:
  - cuenta, MFA y budget;
  - secreto en Secrets Manager;
  - user pool y app client de Cognito;
  - triggers de Cognito;
  - tablas DynamoDB;
  - Lambdas y API Gateway.
- **Billeteras y llaves de la Test Wallet de Interledger:** Duvan.
- **Revisión humana:** cada cambio propuesto por la IA se revisó antes de desplegarlo. Las
  decisiones fueron del equipo: TypeScript, sin IaC, región `us-east-2`, el reparto de trabajo y las
  llaves de las tablas.

**Henry Taborda · Claude Code (apoyo del front al back, 2026-10-16 noche)**

- **`GET /me` con `userId = username`:** Claude cambió `getMe` en [`deploy/natilleras/src/domain.ts`](deploy/natilleras/src/domain.ts) (el `sub` va en `sub`), ajustó la prueba y regeneró `dist/get-me.zip`. Motivo: la app compara `me.userId` con `members[].userId` (username) en cuota y recurrente.
- **Revisión humana:** Henry pidió el cambio; Ciro lo revisó y Claude lo desplegó (solo la Lambda `get-me`).
- **Préstamos, fase 1 (sin Open Payments):** Claude escribió [`deploy/prestamos`](deploy/prestamos) (simular, pedir, listar pendientes, mi préstamo, rechazar; 5 Lambdas con el patrón del bloque A y 5 pruebas locales), [`infra/deploy-prestamos.sh`](infra/deploy-prestamos.sh) y [`docs/API-PRESTAMOS.md`](docs/API-PRESTAMOS.md). Henry decidió el alcance; Ciro revisa y despliega.
- **README del repo:** Claude escribió [`README.md`](README.md) (arquitectura, pago con Open Payments, rutas, despliegue, seguridad) y el pedido de la rama `main` en `MEMORY.md`; Henry lo revisó.
- **Redespliegue de `start-payment` del repo:** Claude verificó el bundle (zip idéntico al build, validaciones y cliente de Open Payments con `validateResponses: false` probados en Node) y escribió [`infra/redeploy-start-payment.sh`](infra/redeploy-start-payment.sh) y [`docs/ENCARGO-CIRO-START-PAYMENT.md`](docs/ENCARGO-CIRO-START-PAYMENT.md). El despliegue lo hace Ciro.

## Prompt Log

Prompts literales en [`/prompts`](prompts/):

| Archivo | Persona | Herramienta | Tema |
|---|---|---|---|
| [`prompts/backend-infra-claude-code-2026-10-16.md`](prompts/backend-infra-claude-code-2026-10-16.md) | David | Claude Code | Setup del repo, infra AWS, Cognito, pre-signup, API Gateway, pagos, bloque A |
| [`prompts/henry-claude-code-2026-10-16.md`](prompts/henry-claude-code-2026-10-16.md) | Henry | Claude Code | `GET /me` con `userId = username`; préstamos fase 1 |
| [`prompts/backend-natilleras-claude-code-2026-10-16.md`](prompts/backend-natilleras-claude-code-2026-10-16.md) | Camilo | Claude Code | Bloque A: natilleras, cuentas guardadas, perfil |
