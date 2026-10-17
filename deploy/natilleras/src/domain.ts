// Lógica del bloque A: flujos 5 (cuentas guardadas), 7 (crear natillera), 8 (unirse) y 13 (lecturas).
// Cada handler de src/*.ts solo envuelve una de estas funciones con withErrors.
import { randomInt, randomUUID } from 'node:crypto';
import { GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { dynamo, env, HttpError, type Amount, requiredString } from './shared';

// ---------------------------------------------------------------- Billeteras (lectura pública)

export type WalletInfo = { exists: boolean; walletAddress: string; assetCode?: string; assetScale?: number };

// Acepta la URL completa, `$ilp.interledger-test.dev/abc` o solo el id (`abc`), como el pre-signup.
// Solo hosts permitidos: la Lambda no debe poder consultar URLs arbitrarias (SSRF).
export const normalizeWalletUrl = (input: unknown): string => {
  const raw = typeof input === 'string' ? input.trim() : '';
  const candidate = raw.startsWith('$')
    ? `https://${raw.slice(1)}`
    : /^[A-Za-z0-9_-]+$/.test(raw)
      ? `https://${env.walletHosts[0]}/${raw}`
      : raw;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new HttpError(400, 'InvalidWalletAddress', 'Invalid wallet address');
  }
  if (url.protocol !== 'https:' || !env.walletHosts.includes(url.hostname) || url.username || url.password) {
    throw new HttpError(400, 'InvalidWalletAddress', 'Wallet address host not allowed');
  }
  return url.href;
};

export const lookupWallet = async (input: unknown): Promise<WalletInfo> => {
  const url = normalizeWalletUrl(input);
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
  } catch (error) {
    console.log('wallet lookup failed', url, error);
    throw new HttpError(502, 'WalletLookupFailed', 'Could not reach the wallet address');
  }
  if (!response.ok) return { exists: false, walletAddress: url };
  const data = (await response.json().catch(() => null)) as { id?: string; assetCode?: string; assetScale?: number } | null;
  if (!data?.assetCode || !Number.isInteger(data.assetScale)) return { exists: false, walletAddress: url };
  return { exists: true, walletAddress: data.id ?? url, assetCode: data.assetCode, assetScale: data.assetScale };
};

const requireWallet = async (input: unknown) => {
  const wallet = await lookupWallet(input);
  if (!wallet.exists) throw new HttpError(400, 'InvalidWalletAddress', 'Wallet address does not exist');
  return wallet as Required<WalletInfo>;
};

// ---------------------------------------------------------------- Perfil (GET /me)

export const getMe = async (username: string, sub?: string) => {
  const { Item } = await dynamo.send(new GetCommand({ TableName: env.usersTable, Key: { source: username, id: 1 } }));
  if (!Item) throw new HttpError(404, 'UserNotFound', 'User not found');
  return {
    userId: sub ?? username,
    username,
    displayName: (Item.displayName as string) || username,
    email: Item.email,
    phone: Item.phone ?? Item.phone_number,
    walletAddress: Item.walletAddress,
    assetCode: Item.assetCode,
    assetScale: Item.assetScale,
  };
};

// ---------------------------------------------------------------- Cuentas guardadas (flujo 5)

type SavedAccount = { customWalletName: string; walletAddress: string; assetCode: string; assetScale: number };

export const saveAccount = async (username: string, body: Record<string, any>): Promise<SavedAccount> => {
  const customWalletName = requiredString(body.customWalletName, 'customWalletName', 40);
  const wallet = await requireWallet(body.walletAddress);
  const account = { customWalletName, walletAddress: wallet.walletAddress, assetCode: wallet.assetCode, assetScale: wallet.assetScale };
  // Mismo nombre = se actualiza la billetera (la persona corrigió la dirección).
  await dynamo.send(
    new PutCommand({
      TableName: env.savedAccountsTable,
      Item: { author: username, ...account, updatedAt: new Date().toISOString() },
    }),
  );
  return account;
};

export const listAccounts = async (username: string): Promise<SavedAccount[]> => {
  const { Items = [] } = await dynamo.send(
    new QueryCommand({
      TableName: env.savedAccountsTable,
      KeyConditionExpression: 'author = :a',
      ExpressionAttributeValues: { ':a': username },
    }),
  );
  return Items.map((i) => ({
    customWalletName: i.customWalletName,
    walletAddress: i.walletAddress,
    assetCode: i.assetCode,
    assetScale: i.assetScale,
  }));
};

// ---------------------------------------------------------------- Natilleras (flujos 7, 8 y 13)

type NatilleraItem = {
  natilleraId: string;
  natilleraName: string;
  author: string; // ADMIN: quien la creó
  integrants: string[];
  walletAddress: string;
  assetCode: string;
  assetScale: number;
  quota: Amount;
  natilleraInvitation: string;
  joinNatilleraUrl: string;
  // Lo suma el carril de préstamos al quedar `completed` un desembolso (regla 7: fondo = aportes − préstamos).
  disbursedTotal?: string;
  createdAt: string;
};

type RecordItem = {
  natilleraId: string;
  id: number;
  author: string;
  paymentAuthor: string;
  amount: Amount;
  createdAt?: string;
};

const normalizeCode = (code: unknown) => (typeof code === 'string' ? code.trim().toUpperCase() : '');

// Código legible para dictarlo por teléfono: primera palabra del nombre + 4 dígitos (ROSA-4821).
const newInvitationCode = (natilleraName: string) => {
  const word = (natilleraName.normalize('NFD').replace(/[^A-Za-z0-9 ]/g, '').split(' ').find(Boolean) ?? 'NAT')
    .toUpperCase()
    .slice(0, 8);
  return `${word || 'NAT'}-${randomInt(1000, 10000)}`;
};

const findByInvitation = async (code: string) => {
  if (!code) return null;
  const { Items = [] } = await dynamo.send(
    new QueryCommand({
      TableName: env.natillerasTable,
      IndexName: env.invitationIndex,
      KeyConditionExpression: 'natilleraInvitation = :c',
      ExpressionAttributeValues: { ':c': code },
    }),
  );
  // El índice es una proyección: se relee la fila para tener `integrants` al día.
  return Items[0] ? getNatillera(Items[0].natilleraId as string) : null;
};

const getNatillera = async (natilleraId: string) => {
  const { Item } = await dynamo.send(new GetCommand({ TableName: env.natillerasTable, Key: { natilleraId } }));
  return (Item as NatilleraItem | undefined) ?? null;
};

// Una persona = una natillera (la app muestra "Mi natillera"). Scan con filtro: en la hackatón hay
// pocas filas; con más volumen convendría guardar el natilleraId en user-info.
const findNatilleraOf = async (username: string) => {
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const page = await dynamo.send(
      new ScanCommand({
        TableName: env.natillerasTable,
        FilterExpression: 'contains(integrants, :u)',
        ExpressionAttributeValues: { ':u': username },
        ExclusiveStartKey,
      }),
    );
    if (page.Items?.[0]) return page.Items[0] as NatilleraItem;
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return null;
};

// Cuota sugerida si el body no la trae: 50.000 en COP; 20,00 en otras monedas.
const defaultQuota = (assetCode: string, assetScale: number): Amount => ({
  value: assetCode === 'COP' ? String(50000 * 10 ** assetScale) : String(20 * 10 ** assetScale),
  assetCode,
  assetScale,
});

const parseQuota = (value: unknown, assetCode: string, assetScale: number): Amount => {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>).value : value;
  if (raw === undefined || raw === null || raw === '') return defaultQuota(assetCode, assetScale);
  if (typeof raw !== 'string' || !/^[1-9]\d{0,15}$/.test(raw)) {
    throw new HttpError(400, 'InvalidAmount', 'quota.value must be a positive integer string in minor units');
  }
  // La cuota siempre va en la moneda del fondo (la de su billetera).
  return { value: raw, assetCode, assetScale };
};

export const createNatillera = async (username: string, body: Record<string, any>) => {
  const natilleraName = requiredString(body.natilleraName, 'natilleraName', 60);
  if (await findNatilleraOf(username)) throw new HttpError(409, 'AlreadyMember', 'User already belongs to a natillera');
  const wallet = await requireWallet(body.walletAddress);

  // El código es único: se reintenta si ya existe (4 dígitos por palabra alcanzan de sobra para la demo).
  let natilleraInvitation = '';
  for (let attempt = 0; attempt < 5 && !natilleraInvitation; attempt++) {
    const code = newInvitationCode(natilleraName);
    if (!(await findByInvitation(code))) natilleraInvitation = code;
  }
  if (!natilleraInvitation) throw new HttpError(500, 'InternalError', 'Could not generate an invitation code');

  const item: NatilleraItem = {
    natilleraId: randomUUID(),
    natilleraName,
    author: username,
    integrants: [username],
    walletAddress: wallet.walletAddress,
    assetCode: wallet.assetCode,
    assetScale: wallet.assetScale,
    quota: parseQuota(body.quota, wallet.assetCode, wallet.assetScale),
    natilleraInvitation,
    joinNatilleraUrl: `${env.joinBaseUrl}${natilleraInvitation}`,
    disbursedTotal: '0',
    createdAt: new Date().toISOString(),
  };
  await dynamo.send(
    new PutCommand({ TableName: env.natillerasTable, Item: item, ConditionExpression: 'attribute_not_exists(natilleraId)' }),
  );
  return toView(item, username, []);
};

export const getInvitation = async (rawCode: unknown) => {
  const code = normalizeCode(rawCode);
  const natillera = await findByInvitation(code);
  if (!natillera) throw new HttpError(404, 'InvitationNotFound', 'Invitation not found');
  return { code, natilleraName: natillera.natilleraName, adminName: natillera.author, quota: natillera.quota };
};

export const joinNatillera = async (username: string, body: Record<string, any>) => {
  const natillera = await findByInvitation(normalizeCode(body.natilleraInvitation));
  if (!natillera) throw new HttpError(404, 'InvitationNotFound', 'Invitation not found');
  const current = await findNatilleraOf(username);
  if (current && current.natilleraId !== natillera.natilleraId) {
    throw new HttpError(409, 'AlreadyMember', 'User already belongs to another natillera');
  }
  if (!current) {
    try {
      await dynamo.send(
        new UpdateCommand({
          TableName: env.natillerasTable,
          Key: { natilleraId: natillera.natilleraId },
          UpdateExpression: 'SET integrants = list_append(integrants, :me)',
          ConditionExpression: 'attribute_exists(natilleraId) AND NOT contains(integrants, :u)',
          ExpressionAttributeValues: { ':me': [username], ':u': username },
        }),
      );
    } catch (error: any) {
      // Dos toques seguidos al botón: ya quedó dentro, se responde igual (idempotente).
      if (error?.name !== 'ConditionalCheckFailedException') throw error;
    }
  }
  return getMyNatillera(username);
};

export const getMyNatillera = async (username: string) => {
  const natillera = await findNatilleraOf(username);
  if (!natillera) return null;
  return toView(natillera, username, await listRecords(natillera.natilleraId));
};

const listRecords = async (natilleraId: string) => {
  const items: RecordItem[] = [];
  let ExclusiveStartKey: Record<string, any> | undefined;
  do {
    const page = await dynamo.send(
      new QueryCommand({
        TableName: env.recordsTable,
        KeyConditionExpression: 'natilleraId = :n',
        ExpressionAttributeValues: { ':n': natilleraId },
        ExclusiveStartKey,
      }),
    );
    items.push(...((page.Items ?? []) as RecordItem[]));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
};

// Mes calendario en Colombia (UTC−5): quien no ha aportado este mes "debe" una cuota.
const monthKey = (iso: string) => new Date(new Date(iso).getTime() - 5 * 3600 * 1000).toISOString().slice(0, 7);

const toView = (n: NatilleraItem, username: string, records: RecordItem[]) => {
  const asset = { assetCode: n.assetCode, assetScale: n.assetScale };
  const money = (value: bigint): Amount => ({ value: value.toString(), ...asset });
  // Los aportes llegan a la billetera del fondo, así que receiveAmount ya está en su moneda;
  // si alguno trae otra moneda (dato viejo), no se suma para no mezclar unidades.
  const valid = records.filter((r) => r.amount?.assetCode === n.assetCode && r.amount?.assetScale === n.assetScale);
  const sum = (rs: RecordItem[]) => rs.reduce((acc, r) => acc + BigInt(r.amount.value), 0n);
  const thisMonth = monthKey(new Date().toISOString());

  const members = n.integrants.map((id) => {
    const mine = valid.filter((r) => r.author === id);
    const paidThisMonth = mine.some((r) => monthKey(r.createdAt ?? new Date(r.id).toISOString()) === thisMonth);
    return {
      userId: id,
      name: id,
      isAdmin: id === n.author,
      total: money(sum(mine)),
      status: paidThisMonth ? ('al-dia' as const) : ('debe' as const),
      pendingCount: paidThisMonth ? 0 : 1,
    };
  });
  const me = members.find((m) => m.userId === username);
  const fund = sum(valid) - BigInt(n.disbursedTotal ?? '0');

  return {
    natilleraId: n.natilleraId,
    natilleraName: n.natilleraName,
    walletAddress: n.walletAddress,
    asset,
    quota: n.quota,
    invitationCode: n.natilleraInvitation,
    joinUrl: n.joinNatilleraUrl,
    isAdmin: n.author === username,
    fundTotal: money(fund),
    myTotal: me?.total ?? money(0n),
    myStatus: me?.status ?? ('al-dia' as const),
    members,
    lastRecords: [...valid]
      .sort((a, b) => b.id - a.id)
      .slice(0, 5)
      .map((r) => ({
        id: String(r.id),
        authorName: r.author,
        paidByName: r.paymentAuthor,
        amount: r.amount,
        createdAt: r.createdAt ?? new Date(r.id).toISOString(),
      })),
  };
};
