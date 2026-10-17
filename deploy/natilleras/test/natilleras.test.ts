// Pruebas locales del bloque A con un DynamoDB en memoria y fetch falso (sin AWS ni red).
// Se corren en modo VTL, que es como está montado el API REST: npm test
process.env.INTEGRATION_MODE = 'vtl';

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { dynamo, env } from '../src/shared';
import { handler as createNatillera } from '../src/create-natillera';
import { handler as getInvitation } from '../src/get-invitation';
import { handler as joinNatillera } from '../src/join-natillera';
import { handler as getMyNatillera } from '../src/get-my-natillera';
import { handler as saveAccount } from '../src/save-account';
import { handler as listAccounts } from '../src/list-accounts';
import { handler as getMe } from '../src/get-me';
import { handler as verifyWallet } from '../src/verify-wallet';

type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};
const keysOf: Record<string, string[]> = {
  [env.usersTable]: ['source', 'id'],
  [env.savedAccountsTable]: ['author', 'customWalletName'],
  [env.natillerasTable]: ['natilleraId'],
  [env.recordsTable]: ['natilleraId', 'id'],
};
const rows = (t: string) => (tables[t] ??= []);
const sameKey = (t: string, a: Row, b: Row) => keysOf[t].every((k) => a[k] === b[k]);

// Solo lo que usa domain.ts: Get, Put (+attribute_not_exists), Query, Scan con contains, Update con list_append.
(dynamo as any).send = async (cmd: any) => {
  const name = cmd.constructor.name as string;
  const i = cmd.input;
  const t = i.TableName as string;
  switch (name) {
    case 'GetCommand':
      return { Item: rows(t).find((r) => sameKey(t, r, i.Key)) };
    case 'PutCommand': {
      const idx = rows(t).findIndex((r) => sameKey(t, r, i.Item));
      if (idx >= 0 && i.ConditionExpression?.includes('attribute_not_exists')) throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
      if (idx >= 0) rows(t)[idx] = structuredClone(i.Item);
      else rows(t).push(structuredClone(i.Item));
      return {};
    }
    case 'QueryCommand': {
      const [field] = (i.KeyConditionExpression as string).split(' = ');
      const value = Object.values(i.ExpressionAttributeValues)[0];
      return { Items: rows(t).filter((r) => r[field] === value).map((r) => structuredClone(r)) };
    }
    case 'ScanCommand': {
      const u = i.ExpressionAttributeValues[':u'];
      return { Items: rows(t).filter((r) => r.integrants?.includes(u)).map((r) => structuredClone(r)) };
    }
    case 'UpdateCommand': {
      const row = rows(t).find((r) => sameKey(t, r, i.Key));
      const u = i.ExpressionAttributeValues[':u'];
      if (!row || row.integrants.includes(u)) throw Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
      row.integrants.push(...i.ExpressionAttributeValues[':me']);
      return {};
    }
  }
  throw new Error(`fake dynamo: ${name} no implementado`);
};

const wallets: Record<string, { assetCode: string; assetScale: number }> = {
  'https://ilp.interledger-test.dev/fondo-rosa': { assetCode: 'COP', assetScale: 2 },
  'https://ilp.interledger-test.dev/luz-eur': { assetCode: 'EUR', assetScale: 2 },
};
const fetched: string[] = [];
globalThis.fetch = (async (url: string) => {
  fetched.push(url);
  const w = wallets[url];
  return w
    ? new Response(JSON.stringify({ id: url, ...w }), { status: 200 })
    : new Response('not found', { status: 404 });
}) as typeof fetch;

const ev = (username: string | null, extra: Row = {}) => ({ op: 'test', auth: username ? { username, sub: `sub-${username}` } : {}, ...extra });
// En VTL un error llega como excepción "[status] {json}".
const fails = async (p: Promise<unknown>, status: number, error?: string) => {
  await assert.rejects(p, (e: Error) => {
    assert.match(e.message, new RegExp(`^\\[${status}\\]`));
    if (error) assert.equal(JSON.parse(e.message.slice(6)).error, error);
    return true;
  });
};

beforeEach(() => {
  tables = {};
  fetched.length = 0;
  rows(env.usersTable).push({ source: 'rosa', id: 1, email: 'r@x.co', phone: '+573001', walletAddress: 'https://ilp.interledger-test.dev/fondo-rosa', assetCode: 'COP', assetScale: 2 });
});

test('sin usuario en el token → 401', async () => {
  await fails(getMyNatillera(ev(null)), 401, 'Unauthorized');
});

test('GET /me devuelve el perfil normalizado', async () => {
  const me: any = await getMe(ev('rosa'));
  assert.equal(me.userId, 'sub-rosa');
  assert.equal(me.username, 'rosa');
  assert.equal(me.displayName, 'rosa');
  assert.equal(me.assetCode, 'COP');
  await fails(getMe(ev('nadie')), 404, 'UserNotFound');
});

test('verificar billetera: id corto, $ilp, inexistente y host no permitido', async () => {
  assert.deepEqual(await verifyWallet(ev('rosa', { params: { url: 'fondo-rosa' } })), {
    exists: true, walletAddress: 'https://ilp.interledger-test.dev/fondo-rosa', assetCode: 'COP', assetScale: 2,
  });
  assert.equal(((await verifyWallet(ev('rosa', { params: { url: '$ilp.interledger-test.dev/luz-eur' } }))) as any).assetCode, 'EUR');
  assert.equal(((await verifyWallet(ev('rosa', { params: { url: 'no-existe' } }))) as any).exists, false);
  await fails(verifyWallet(ev('rosa', { params: { url: 'https://evil.example/x' } })), 400, 'InvalidWalletAddress');
  await fails(verifyWallet(ev('rosa', { params: { url: 'http://ilp.interledger-test.dev/fondo-rosa' } })), 400, 'InvalidWalletAddress');
  assert.ok(!fetched.some((u) => u.includes('evil')), 'nunca consulta hosts no permitidos');
});

test('cuentas guardadas: guardar, actualizar y listar solo las propias', async () => {
  const saved: any = await saveAccount(ev('rosa', { body: { walletAddress: 'luz-eur', customWalletName: 'Luz' } }));
  assert.deepEqual(saved, { customWalletName: 'Luz', walletAddress: 'https://ilp.interledger-test.dev/luz-eur', assetCode: 'EUR', assetScale: 2 });
  await saveAccount(ev('rosa', { body: { walletAddress: 'fondo-rosa', customWalletName: 'Luz' } }));
  await saveAccount(ev('andres', { body: { walletAddress: 'luz-eur', customWalletName: 'Tía' } }));
  const list: any = await listAccounts(ev('rosa'));
  assert.equal(list.length, 1);
  assert.equal(list[0].assetCode, 'COP', 'mismo nombre actualiza la billetera');
  await fails(saveAccount(ev('rosa', { body: { walletAddress: 'no-existe', customWalletName: 'X' } })), 400, 'InvalidWalletAddress');
  await fails(saveAccount(ev('rosa', { body: { walletAddress: 'luz-eur' } })), 400, 'BadRequest');
});

test('crear, ver invitación, unirse y ver mi natillera con aportes', async () => {
  const created: any = await createNatillera(ev('rosa', { body: { natilleraName: 'Familia Pérez', walletAddress: 'fondo-rosa' } }));
  assert.match(created.invitationCode, /^FAMILIA-\d{4}$/);
  assert.equal(created.isAdmin, true);
  assert.deepEqual(created.quota, { value: '5000000', assetCode: 'COP', assetScale: 2 });
  assert.equal(created.joinUrl, `natillera://unirse/${created.invitationCode}`);
  assert.equal(created.members.length, 1);

  await fails(createNatillera(ev('rosa', { body: { natilleraName: 'Otra', walletAddress: 'fondo-rosa' } })), 409, 'AlreadyMember');

  const preview: any = await getInvitation(ev('luz', { params: { code: created.invitationCode.toLowerCase() } }));
  assert.deepEqual(preview, { code: created.invitationCode, natilleraName: 'Familia Pérez', adminName: 'rosa', quota: created.quota });
  await fails(getInvitation(ev('luz', { params: { code: 'NO-0000' } })), 404, 'InvitationNotFound');

  const joined: any = await joinNatillera(ev('luz', { body: { natilleraInvitation: ` ${created.invitationCode} ` } }));
  assert.equal(joined.isAdmin, false);
  assert.deepEqual(joined.members.map((m: any) => m.userId), ['rosa', 'luz']);
  // Unirse dos veces no duplica.
  await joinNatillera(ev('luz', { body: { natilleraInvitation: created.invitationCode } }));

  // Aportes como los escribe complete.ts de pagos (natilleraId + id numérico), y un desembolso.
  const now = Date.now();
  rows(env.recordsTable).push(
    { natilleraId: created.natilleraId, id: now - 2, author: 'rosa', paymentAuthor: 'rosa', amount: { value: '5000000', assetCode: 'COP', assetScale: 2 }, createdAt: new Date(now - 2).toISOString() },
    { natilleraId: created.natilleraId, id: now - 1, author: 'rosa', paymentAuthor: 'luz', amount: { value: '2500000', assetCode: 'COP', assetScale: 2 }, createdAt: new Date(now - 1).toISOString() },
    { natilleraId: created.natilleraId, id: now, author: 'rosa', paymentAuthor: 'rosa', amount: { value: '999', assetCode: 'EUR', assetScale: 2 } },
  );
  rows(env.natillerasTable)[0].disbursedTotal = '1000000';

  const mine: any = await getMyNatillera(ev('luz'));
  assert.equal(mine.members.length, 2);
  assert.deepEqual(mine.fundTotal, { value: '6500000', assetCode: 'COP', assetScale: 2 }, 'aportes − desembolsos, sin mezclar monedas');
  assert.equal(mine.myStatus, 'debe');
  assert.equal(mine.myTotal.value, '0');
  const rosa = mine.members.find((m: any) => m.userId === 'rosa');
  assert.equal(rosa.status, 'al-dia');
  assert.equal(rosa.total.value, '7500000');
  assert.equal(mine.lastRecords.length, 2);
  assert.equal(mine.lastRecords[0].paidByName, 'luz', 'el más reciente primero');

  assert.equal(await getMyNatillera(ev('andres')), null);
  await fails(joinNatillera(ev('andres', { body: { natilleraInvitation: 'NO-1234' } })), 404, 'InvitationNotFound');
});

test('crear natillera valida nombre, billetera y cuota', async () => {
  await fails(createNatillera(ev('rosa', { body: { walletAddress: 'fondo-rosa' } })), 400, 'BadRequest');
  await fails(createNatillera(ev('rosa', { body: { natilleraName: 'X', walletAddress: 'no-existe' } })), 400, 'InvalidWalletAddress');
  await fails(createNatillera(ev('rosa', { body: { natilleraName: 'X', walletAddress: 'fondo-rosa', quota: { value: '1.5' } } })), 400, 'InvalidAmount');
  const ok: any = await createNatillera(ev('rosa', { body: { natilleraName: '¡Ñoños!', walletAddress: 'fondo-rosa', quota: { value: '3000000', assetCode: 'USD' } } }));
  assert.deepEqual(ok.quota, { value: '3000000', assetCode: 'COP', assetScale: 2 }, 'la cuota va en la moneda del fondo');
  assert.match(ok.invitationCode, /^NONOS-\d{4}$/);
});
