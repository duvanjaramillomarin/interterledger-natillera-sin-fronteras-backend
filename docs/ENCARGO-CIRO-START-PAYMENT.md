# Encargo para Ciro o Camilo (Claude Code con AWS CLI) — redesplegar `start-payment` del repo

**De:** Henry (front) · **Fecha:** 2026-10-17, madrugada · **Lo corre quien tenga AWS CLI primero: Ciro o Camilo.**

> **Decisión (Henry, ~01:40):** se reemplaza la nota de la 01:00 en `MEMORY.md` («dejar el `start-payment` de Duvan»).
> Queda el **del repo**, por tres razones:
> - funciona con la app tal como está, sin tocar el front a horas del cierre;
> - ya hizo el pago real EUR → COP;
> - usa una sola llave, la del cliente, en Secrets Manager.
>
> La versión de Duvan no se borra: queda respaldada como versión numerada de la Lambda.

## Por qué

- El `start-payment` desplegado es la versión que Duvan subió por consola a las 23:29, y **no funciona** con la app. Problemas:
  - lee llaves privadas de cada usuario desde `user-info`;
  - lee `event.walletAddress` en lugar de `event.body`;
  - no pide `interact.finish`;
  - no guarda en `payments-history` ni devuelve `{ paymentId, redirectUrl, … }`.

  Antes falló además con `ENOENT … specs/wallet-address-server.yaml`, porque el SDK valida respuestas leyendo `.yaml` que esbuild no empaqueta.
- El `start-payment` **del repo** (`deploy/payments`, en `main` y `david`) es el que hizo el pago real EUR → COP. Ya trae `validateResponses: false`, la opción B (`RETURN_BASE_URL`), la lista cerrada de `returnUrl`, `kind: 'aporte'` y la respuesta que espera la app.
- La de Duvan además responde la quote, y no el `{ paymentId, redirectUrl }` que espera la app, así que con ella la billetera no abre.
- Duvan se fue a dormir y el equipo decidió volver a la del repo. **La suya no se pierde:** el script la publica como versión numerada antes de reemplazarla.

## Qué ya se verificó (Henry, sin AWS)

- `tsc --noEmit` sale limpio, y el `dist/start-payment.zip` del repo es **idéntico** a compilar `src` hoy.
- El bundle de ese zip, cargado en Node:
  - responde `[401]` sin usuario;
  - responde `[400] InvalidReturnUrl` sin `returnUrl` o con uno ajeno;
  - responde `[400] InvalidAmount` con un monto decimal;
  - y el SDK 7.4.0 crea el cliente con `validateResponses: false` y lee la billetera `melos` (COP, 2) de la Test Wallet.
- En `dev`, `POST /payments`, `GET /payments/{id}` y `POST /payments/{id}/finish` responden 401 sin token, y `GET /payments/{id}/return` responde.

## Antes de empezar (solo si es Camilo)

AWS CLI v2 con acceso a la cuenta `349607459198`. Lo da Ciro: un usuario de IAM Identity Center o una llave de acceso. **Las credenciales no se pegan en el chat, en el repo ni en un prompt**, que es público.

```bash
aws configure --profile natillera        # región us-east-2, salida json
aws sts get-caller-identity --profile natillera   # debe mostrar la cuenta 349607459198
```

Requiere también Node 22 y Python 3, y correr todo en Git Bash si está en Windows.

## Qué hacer (unos 3 minutos)

```bash
git pull origin main
cd deploy/payments && npm ci && node build.mjs && cd ../..
AWS_PROFILE=natillera TEST_USER=prueba1 bash infra/redeploy-start-payment.sh
```

El script `infra/redeploy-start-payment.sh` **solo toca la Lambda `start-payment`**: no cambia rutas, tablas, roles ni las otras Lambdas. En orden:

1. Revisa que el zip traiga `validateResponses: false` y muestra la configuración actual.
2. Publica una **versión de respaldo** de lo desplegado e imprime su número.
3. Sube el zip del repo y deja `index.handler`, Node 22, 25 s y 512 MB, con las variables de la ruta VTL y la opción B (`INTEGRATION_MODE=vtl`, `OP_SECRET_ID`, tablas y `RETURN_BASE_URL`).
4. Verifica invocando la Lambda: sin `returnUrl` debe responder `InvalidReturnUrl`. Sin token, la ruta debe dar 401.
5. Con `TEST_USER=prueba1`, inicia un pago real de 1,00 EUR de `prueba1` al fondo `f9a1abde` y exige `redirectUrl`. **No mueve plata:** queda `pending` hasta que alguien lo apruebe en la Test Wallet.

**Si algo falla:** `aws logs tail /aws/lambda/start-payment --since 5m`. Para volver atrás, el script imprime cómo restaurar la versión de respaldo.

## Después

- Avisar a Henry y Camilo con el número de la versión de respaldo y la salida de la verificación 3.
- Camilo prueba en la app con `prueba3`. **La billetera `melos`, que tienen prueba1, prueba2 y prueba3, es de Camilo**, así que él aprueba con su sesión de la Test Wallet:
  1. poner la cuota, o pagar a una persona;
  2. aprobar en la Test Wallet **con la cuenta dueña de la billetera que paga**;
  3. volver a la app y ver el resultado.

  Y graba el video.
- **No correr `infra/deploy-payments.sh` completo:** también redespliega `finish`, `get` y `return`, que ya están bien.
- **Deuda de seguridad (después de la hackatón):** borrar `walletInfo.walletKeys` de `user-info` (prueba1 lo tiene) y rotar en la Test Wallet las llaves que quedaron en DynamoDB o en los logs.

## Para pegar en Claude Code (de Ciro o de Camilo)

> Estamos en el repo back de Natillera sin Fronteras, cuenta AWS 349607459198, región us-east-2, perfil `natillera`. Lee `docs/ENCARGO-CIRO-START-PAYMENT.md` y ejecútalo: `git pull origin main`, compila `deploy/payments` (`npm ci && node build.mjs`) y corre `TEST_USER=prueba1 bash infra/redeploy-start-payment.sh`. Solo debe cambiar la Lambda `start-payment`. Antes de correrlo, muéstrame la configuración actual que imprime el script. Si la verificación 1 o la 3 fallan, no sigas: muéstrame los logs de `/aws/lambda/start-payment` de los últimos 5 minutos. Al terminar, dame el número de la versión de respaldo y la salida de las tres verificaciones.
