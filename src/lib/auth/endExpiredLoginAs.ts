// src/lib/auth/endExpiredLoginAs.ts
import type { NextApiResponse } from 'next';
import { logout } from './gotrue';
import { clearAuthCookies } from './cookies';
import { clearImpersonationCookies } from './impersonation-cookies';
import { closeLoginAsRecord } from './loginAsRecord';
import { log } from '@/lib/logger';

/**
 * A Login-as session whose proof has run out, refused at /api/auth/refresh. Ends it
 * as end-impersonation would, minus restoring the admin: revoked at GoTrue so a copy
 * of the refresh token cannot keep it going, the admin's stashed tokens removed by the
 * parties on the session record (the stash cookie is only a browser's say-so), and the
 * end recorded (closeLoginAsRecord). The refusal stands whichever of those fail, so the
 * cookies always clear.
 */
export async function endExpiredLoginAs(res: NextApiResponse, accessToken: string, stashId?: string): Promise<void> {
  try { await logout(accessToken, 'local'); }
  catch (err) {
    log.error('end of expired Login-as: revocation failed', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
  }

  await closeLoginAsRecord(accessToken, stashId, 'proof_expired');

  clearAuthCookies(res);
  clearImpersonationCookies(res);
}
