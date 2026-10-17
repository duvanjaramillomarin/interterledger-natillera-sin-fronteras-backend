// GET /natilleras/mine (flujo 13) → natillera de quien llama con socios, totales y últimos aportes, o null.
import { getMyNatillera } from './domain';
import { currentIdentity, withErrors } from './shared';

export const handler = withErrors(async (event) => getMyNatillera(currentIdentity(event).username));
