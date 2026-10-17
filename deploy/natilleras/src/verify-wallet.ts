// GET /wallets/verify?url= → { exists, walletAddress, assetCode?, assetScale? } (lectura pública, sin llaves).
import { lookupWallet } from './domain';
import { currentIdentity, HttpError, param, withErrors } from './shared';

export const handler = withErrors(async (event) => {
  currentIdentity(event);
  const url = param(event, 'url');
  if (!url) throw new HttpError(400, 'BadRequest', 'url is required');
  return lookupWallet(url);
});
