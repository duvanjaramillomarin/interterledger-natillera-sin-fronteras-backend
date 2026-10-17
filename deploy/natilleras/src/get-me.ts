// GET /me → perfil de quien llama (fila de user-info + userId = sub).
import { getMe } from './domain';
import { currentIdentity, withErrors } from './shared';

export const handler = withErrors(async (event) => {
  const { username, sub } = currentIdentity(event);
  return getMe(username, sub);
});
