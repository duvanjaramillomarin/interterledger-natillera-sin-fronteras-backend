// GET /accounts (flujo 13) → cuentas guardadas de quien llama.
import { listAccounts } from './domain';
import { currentIdentity, withErrors } from './shared';

export const handler = withErrors(async (event) => listAccounts(currentIdentity(event).username));
