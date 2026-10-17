// POST /accounts (flujo 5) { walletAddress, customWalletName } → cuenta guardada con su moneda.
import { saveAccount } from './domain';
import { currentIdentity, parseBody, withErrors } from './shared';

export const handler = withErrors(async (event) => saveAccount(currentIdentity(event).username, parseBody(event)));
