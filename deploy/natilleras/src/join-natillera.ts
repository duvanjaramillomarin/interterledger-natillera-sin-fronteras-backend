// POST /natilleras/join (flujo 8) { natilleraInvitation } → natillera (vista de la app).
import { joinNatillera } from './domain';
import { currentIdentity, parseBody, withErrors } from './shared';

export const handler = withErrors(async (event) => joinNatillera(currentIdentity(event).username, parseBody(event)));
