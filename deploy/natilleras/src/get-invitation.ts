// GET /invitations/{code} (flujo 8, vista previa) → { code, natilleraName, adminName, quota }.
import { getInvitation } from './domain';
import { currentIdentity, param, withErrors } from './shared';

export const handler = withErrors(async (event) => {
  currentIdentity(event);
  return getInvitation(param(event, 'code'));
});
