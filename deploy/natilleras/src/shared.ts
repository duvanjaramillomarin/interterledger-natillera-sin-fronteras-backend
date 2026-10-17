// Utilidades de la Lambda natilleras-api (bloque A: perfil, billeteras, cuentas guardadas y natilleras).
// Mismo contrato de eventos y errores que deploy/payments/src/shared.ts (INTEGRATION_MODE, withErrors);
// copia mínima para no depender del SDK de Open Payments: aquí solo se leen direcciones públicas.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const env = {
  usersTable: process.env.USER_VIEW_TABLE || 'user-info',
  savedAccountsTable: process.env.SAVED_ACCOUNTS_TABLE || 'saved-accounts',
  natillerasTable: process.env.NATILLERAS_TABLE || 'natillera-registration',
  recordsTable: process.env.NATILLERA_RECORDS_TABLE || 'natillera-records',
  invitationIndex: process.env.INVITATION_INDEX || 'invitation-index',
  walletHosts: (process.env.WALLET_HOSTS || 'ilp.interledger-test.dev').split(',').map((h) => h.trim()),
  joinBaseUrl: process.env.JOIN_BASE_URL || 'natillera://unirse/',
};

export const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }), {
  marshallOptions: { removeUndefinedValues: true },
});

export type Amount = { value: string; assetCode: string; assetScale: number };

export class HttpError extends Error {
  constructor(readonly statusCode: number, readonly error: string, message: string) {
    super(message);
  }
}

export const json = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// `vtl`: REST sin proxy. La plantilla de cada ruta arma el evento:
//   { "op": "<operación fija de la ruta>", "auth": { "username", "sub" }, "params": {...}, "body": <body> }
// `proxy` (por defecto): integración proxy; la operación sale del método y el recurso de la ruta.
export const isProxy = () => process.env.INTEGRATION_MODE !== 'vtl';

export const withErrors =
  (fn: (event: any) => Promise<unknown>) =>
  async (event: any) => {
    let status: number;
    let body: { error: string; message: string };
    try {
      const result = await fn(event);
      return isProxy() ? json(200, result) : result;
    } catch (error: any) {
      if (error instanceof HttpError) {
        status = error.statusCode;
        body = { error: error.error, message: error.message };
      } else {
        console.log('Unhandled error', error);
        status = 500;
        body = { error: 'InternalError', message: 'Unexpected error' };
      }
    }
    if (isProxy()) return json(status, body);
    // La respuesta de integración mapea `^\[<status>\].*` al status real (ver infra/deploy-natilleras.sh).
    throw new Error(`[${status}] ${JSON.stringify(body)}`);
  };

// La identidad sale del token validado por el autorizador (regla 0), nunca del body.
export const currentIdentity = (event: any): { username: string; sub?: string } => {
  let username: unknown;
  let sub: unknown;
  if (isProxy()) {
    const authorizer = event?.requestContext?.authorizer ?? {};
    const claims = authorizer.jwt?.claims ?? authorizer.claims ?? {};
    username = claims.username ?? claims['cognito:username'];
    sub = claims.sub;
  } else {
    username = event?.auth?.username;
    sub = event?.auth?.sub;
  }
  if (typeof username !== 'string' || !username) throw new HttpError(401, 'Unauthorized', 'Missing username claim');
  return { username, sub: typeof sub === 'string' && sub ? sub : undefined };
};

export const parseBody = (event: any): Record<string, any> => {
  if (!isProxy()) {
    return event?.body && typeof event.body === 'object' && !Array.isArray(event.body) ? event.body : {};
  }
  if (!event?.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new HttpError(400, 'BadRequest', 'Body must be valid JSON');
  }
};

// Parámetros de ruta y de query: `params` de la plantilla en VTL; pathParameters/queryStringParameters en proxy.
export const param = (event: any, name: string): string | undefined => {
  const value = isProxy()
    ? event?.pathParameters?.[name] ?? event?.queryStringParameters?.[name]
    : event?.params?.[name];
  return typeof value === 'string' && value ? value : undefined;
};

export const requiredString = (value: unknown, field: string, max: number): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new HttpError(400, 'BadRequest', `${field} is required (max ${max} chars)`);
  return text;
};
