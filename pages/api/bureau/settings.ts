/**
 * GET /api/bureau/settings?bureauId=...       — the bureau's sharing opt-in + recent changes (any member)
 * PUT /api/bureau/settings { bureauId, shareMerchantPatterns } — change it (bureau OWNER only)
 *
 * Auth: withUserAuth + bureau_users membership (the bureau pattern). The owner check is
 * bureau_users.role = 'owner', and setBureauSharingSetting re-checks it inside its write transaction.
 * Every real change writes one bureau_audit_log row (who, when, old -> new). The setting is stored only:
 * nothing pools on it until PR 2 (poolEligibility.ts).
 */
import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import {
  getBureauRole, getBureauSharingSetting, setBureauSharingSetting,
} from '@/modules/bureau/services/bureauSettingsService';

const PutBody = z.object({ bureauId: UUID, shareMerchantPatterns: z.boolean() }).strict();

async function handler(req: UserAuthedRequest, res: NextApiResponse) {
  const userId = req.user.id;

  if (req.method === 'GET') {
    const bureauId = UUID.safeParse(req.query.bureauId);
    if (!bureauId.success) return apiResponse.badRequest(res, 'bureauId is required');
    const role = await getBureauRole(userId, bureauId.data);
    if (!role) return apiResponse.forbidden(res, 'Not a member of this bureau');
    const setting = await getBureauSharingSetting(bureauId.data);
    if (!setting) return apiResponse.notFound(res, 'Bureau', bureauId.data);
    return apiResponse.success(res, { bureauId: bureauId.data, role, canEdit: role === 'owner', ...setting });
  }

  if (req.method === 'PUT') {
    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const result = await setBureauSharingSetting({
      bureauId: parsed.data.bureauId, actorUserId: userId, value: parsed.data.shareMerchantPatterns,
    });
    if (result.kind === 'forbidden') {
      return apiResponse.forbidden(res, 'Only the bureau owner can change merchant-pattern sharing');
    }
    if (result.changed) {
      log.info('Bureau merchant-pattern sharing changed',
        { bureauId: parsed.data.bureauId, userId, oldValue: result.oldValue, newValue: result.newValue }, 'bureau');
    }
    return apiResponse.success(res, {
      bureauId: parsed.data.bureauId, shareMerchantPatterns: result.newValue, changed: result.changed,
    });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT']);
}

export default withUserAuth(withErrorHandler(withCsrf(handler)));
