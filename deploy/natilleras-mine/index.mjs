// Lambda "natilleras-mine" — GET /natilleras/mine (pantallas 10 y 11 del front).
// Devuelve la natillera de quien llama, con la forma exacta de `Natillera` en docs/openapi.yaml del front,
// o `null` si no está en ninguna.
// Runtime: Node.js 22.x · archivo index.mjs · handler index.handler · API REST con integración PROXY
// y autorizador Cognito (IdToken). Sin Open Payments: solo lee DynamoDB.
//
// Identidad: `cognito:username` (o `username`) de los claims del autorizador, nunca del request.
// Es la misma que usa start-payment para `author` e `integrants`, por eso `members[].userId` = username.
//
// Tablas (variables de entorno, con estos valores por defecto):
//   NATILLERAS_TABLE natillera-registration  PK natilleraId
//     { natilleraId, natilleraName, author, integrants: [username], admins?: [username],
//       walletAddress, assetCode, assetScale, quota: "5000000", invitationCode, joinUrl,
//       names?: { username: "Doña Rosa" }, openingTotals?: { username: "10000000" } }
//   PAYMENTS_TABLE   payments-history        (aportes `completed` con este natilleraId)
// Permisos del rol: dynamodb:Scan sobre natillera-registration y payments-history.
//
// Reglas de negocio mínimas para la demo (las decide el back, el front pinta lo que llegue):
//  - Total de cada socio = openingTotals (saldo sembrado) + aportes completed a su nombre (onBehalfOf ?? author).
//  - Total del fondo = suma de los totales de los socios.
//  - Cuota exigida: 1 por mes calendario (hora de Colombia). «al-dia» si ya tiene un aporte completed
//    este mes o si la semilla lo marca en `paidThisMonth` (para que la demo arranque con alguien al día).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const NATILLERAS_TABLE = process.env.NATILLERAS_TABLE || 'natillera-registration';
const PAYMENTS_TABLE = process.env.PAYMENTS_TABLE || 'payments-history';
const LAST_RECORDS = 5;

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// Scan paginado. Las tablas de la demo son pequeñas; con más datos esto pasaría a un GSI.
async function scanAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await dynamo.send(new ScanCommand({ ...params, ExclusiveStartKey }));
    items.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

// Montos en unidades menores como string; se suman con BigInt (nunca floats).
const toBig = (value) => {
  try {
    return BigInt(String(value ?? '0'));
  } catch {
    return 0n;
  }
};

// "2026-10" en hora de Colombia (UTC-5, sin horario de verano).
const monthKey = (iso) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t - 5 * 3600 * 1000).toISOString().slice(0, 7);
};

export function buildNatillera(item, payments, username, now = new Date()) {
  const asset = { assetCode: String(item.assetCode), assetScale: Number(item.assetScale) };
  const amount = (big) => ({ value: big.toString(), ...asset });
  const integrants = Array.isArray(item.integrants) ? item.integrants.map(String) : [];
  const admins = new Set(Array.isArray(item.admins) && item.admins.length ? item.admins.map(String) : [String(item.author)]);
  const names = item.names ?? {};
  const nameOf = (u) => names[u] || u;
  const opening = item.openingTotals ?? {};
  const paidThisMonth = new Set(Array.isArray(item.paidThisMonth) ? item.paidThisMonth.map(String) : []);
  const currentMonth = monthKey(now.toISOString());

  // Solo aportes completados a este fondo y en la moneda del fondo.
  const aportes = payments
    .filter((p) => p.kind === 'aporte' && p.status === 'completed' && p.natilleraId === item.natilleraId)
    .filter((p) => p.receiveAmount && p.receiveAmount.assetCode === asset.assetCode && Number(p.receiveAmount.assetScale) === asset.assetScale)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const totals = new Map(integrants.map((u) => [u, toBig(opening[u])]));
  for (const p of aportes) {
    const owner = String(p.onBehalfOf || p.author);
    totals.set(owner, (totals.get(owner) ?? 0n) + toBig(p.receiveAmount.value));
    if (monthKey(p.createdAt) === currentMonth) paidThisMonth.add(owner);
  }

  const members = integrants.map((u) => {
    const upToDate = paidThisMonth.has(u);
    return {
      userId: u,
      name: nameOf(u),
      isAdmin: admins.has(u),
      total: amount(totals.get(u) ?? 0n),
      status: upToDate ? 'al-dia' : 'debe',
      pendingCount: upToDate ? 0 : 1,
    };
  });
  const me = members.find((m) => m.userId === username);
  const fund = [...totals.values()].reduce((a, b) => a + b, 0n);

  return {
    natilleraId: String(item.natilleraId),
    natilleraName: String(item.natilleraName),
    walletAddress: String(item.walletAddress),
    asset,
    quota: amount(toBig(item.quota)),
    invitationCode: String(item.invitationCode ?? ''),
    joinUrl: String(item.joinUrl ?? ''),
    isAdmin: admins.has(username),
    fundTotal: amount(fund),
    myTotal: me ? me.total : amount(0n),
    myStatus: me ? me.status : 'debe',
    members,
    lastRecords: aportes.slice(0, LAST_RECORDS).map((p) => ({
      id: String(p.paymentId),
      authorName: nameOf(String(p.onBehalfOf || p.author)),
      paidByName: nameOf(String(p.author)),
      amount: p.receiveAmount,
      createdAt: String(p.createdAt),
    })),
  };
}

export const handler = async (event) => {
  const authorizer = event?.requestContext?.authorizer ?? {};
  const claims = authorizer.jwt?.claims ?? authorizer.claims ?? {}; // HTTP API (JWT) o REST API (Cognito)
  const username = claims['cognito:username'] ?? claims.username;
  if (!username) return json(401, { error: 'Unauthorized', message: 'Missing username claim' });

  try {
    const mine = await scanAll({
      TableName: NATILLERAS_TABLE,
      FilterExpression: 'contains(integrants, :u)',
      ExpressionAttributeValues: { ':u': username },
    });
    if (mine.length === 0) return json(200, null);
    // Una natillera por persona en la demo: si hay varias, la más reciente.
    mine.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    const item = mine[0];

    const payments = await scanAll({
      TableName: PAYMENTS_TABLE,
      FilterExpression: 'natilleraId = :n AND #s = :c',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':n': item.natilleraId, ':c': 'completed' },
    });
    return json(200, buildNatillera(item, payments, username));
  } catch (error) {
    console.log('natilleras-mine failed', error);
    return json(500, { error: 'InternalError', message: 'Could not read the natillera' });
  }
};
