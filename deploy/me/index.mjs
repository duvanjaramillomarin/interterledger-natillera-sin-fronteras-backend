// Lambda "natillera-me" — GET /me en el HTTP API. Devuelve el usuario logueado desde Users-info.
// Sirve para probar de punta a punta: login en Cognito → token → API Gateway (authorizer JWT) → Lambda → DynamoDB.
// El usuario sale del token validado por API Gateway (claim `username`), nunca del request (regla 0).
// Runtime: Node.js 22.x · archivo index.mjs · handler index.handler · payload v2.0 (HTTP API).
// Variable de entorno: USER_VIEW_TABLE (por defecto `user-info`, llave source + id).
// Permiso extra del rol: dynamodb:GetItem sobre la tabla.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const USERS_TABLE = process.env.USER_VIEW_TABLE || 'user-info';

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  const authorizer = event?.requestContext?.authorizer ?? {};
  const claims = authorizer.jwt?.claims ?? authorizer.claims ?? {}; // HTTP API (JWT) o REST API (Cognito)
  const username = claims.username ?? claims['cognito:username'];
  if (!username) return json(401, { error: 'Unauthorized', message: 'Missing username claim' });

  const { Item } = await dynamo.send(new GetCommand({ TableName: USERS_TABLE, Key: { source: username, id: 1 } }));
  if (!Item) return json(404, { error: 'NotFound', message: 'User not found' });

  // userId = username: es la identidad que usan start-payment (`author`, `integrants`) y
  // GET /natilleras/mine (`members[].userId`); el front los compara para «¿A nombre de quién?».
  return json(200, { ...Item, userId: username, username, sub: claims.sub });
};
