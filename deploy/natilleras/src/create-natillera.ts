// POST /natilleras (flujo 7) { natilleraName, walletAddress, quota? } → natillera (vista de la app).
import { createNatillera } from './domain';
import { currentIdentity, parseBody, withErrors } from './shared';

export const handler = withErrors(async (event) => createNatillera(currentIdentity(event).username, parseBody(event)));
