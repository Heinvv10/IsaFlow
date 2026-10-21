/**
 * GET /api/bureau/settings?bureauId=...       — the bureau's sharing opt-in + recent changes (any member)
 * PUT /api/bureau/settings { bureauId, shareMerchantPatterns } — change it (bureau OWNER only)
 *
 * Auth: withUserAuth + bureau membership (bureauService.getBureauRole). The owner is
 * bureaus.owner_user_id, and setBureauSharingSetting re-checks it inside its write transaction.
 * Every real change writes one bureau_audit_log row (who, when, old -> new). The setting is stored only:
 * nothing pools on it until PR 2 (poolEligibility.ts).
 * Gate (merchantSharingGate.ts): while MERCHANT_SHARING_ENABLED is off, switching ON is a 409
 * sharing_pending_legal_review for everyone, the owner included; switching OFF still works. GET reports
 * the gate as `sharingAvailable`, so the page can say "Coming soon" without a NEXT_PUBLIC variable.
 */
import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withUserAuth, type UserAuthedRequest } from '@/lib/auth/withUserAuth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { log } from '@/lib/logger';
import { UUID } from '@/lib/schemas/common';
import { getBureauRole } from '@/modules/bureau/services/bureauService';
import { getBureauSharingSetting, setBureauSharingSetting } from '@/modules/bureau/services/bureauSettingsService';
import { isMerchantSharingEnabled, MERCHANT_SHARING_PENDING_CODE } from '@/modules/bureau/services/merchantSharingGate';

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
    return apiResponse.success(res, {
      bureauId: bureauId.data, role, canEdit: role === 'owner', sharingAvailable: isMerchantSharingEnabled(), ...setting,
    });
  }

  if (req.method === 'PUT') {
    const parsed = PutBody.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid input');
    }
    const result = await setBureauSharingSetting({
      bureauId: parsed.data.bureauId, actorUserId: userId, value: parsed.data.shareMerchantPatterns,
    });
    if (result.kind === 'pending_legal_review') {
      return apiResponse.conflict(res, 'Merchant-pattern sharing cannot be switched on yet: the consent wording is pending legal review',
        { code: MERCHANT_SHARING_PENDING_CODE });
    }
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
