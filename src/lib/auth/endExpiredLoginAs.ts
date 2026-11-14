// src/lib/auth/endExpiredLoginAs.ts
import type { NextApiResponse } from 'next';
import { clearAuthCookies } from './cookies';
import { clearImpersonationCookies } from './impersonation-cookies';
import { endLoginAsWithoutRestore, loginAsPartiesOfToken, revokeLoginAsSession } from './loginAsRecord';
import { log } from '@/lib/logger';

/**
 * A Login-as session whose proof has run out, refused at /api/auth/refresh. Ends it
 * as end-impersonation would, minus restoring the admin (loginAsRecord): the end
 * recorded first, the session revoked at GoTrue so a copy of the refresh token cannot
 * keep it going, the admin's stashed tokens removed by the parties on the session
 * record (the stash cookie is only a browser's say-so), and the outcome added to the
 * end row. The refusal stands whichever of those fail, so the cookies always clear.
 */
export async function endExpiredLoginAs(res: NextApiResponse, accessToken: string, stashId?: string): Promise<void> {
  let parties = null;
  try {
    parties = await loginAsPartiesOfToken(accessToken);
  } catch (err) {
    log.error('end of expired Login-as: session record lookup failed', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
  }
  const revoke = () => revokeLoginAsSession(accessToken, 'proof_expired');
  if (parties) await endLoginAsWithoutRestore({ parties, stashId, reason: 'proof_expired', revoke });
  else await revoke();

  clearAuthCookies(res);
  clearImpersonationCookies(res);
}
