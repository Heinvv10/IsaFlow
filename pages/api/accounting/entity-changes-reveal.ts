/**
 * Reveal one recorded change in full (forensic-controls step 3; Hein's
 * decision 2): POST { changeId } — owner / admin only, a person in their own
 * session (Login-as 403 IMPERSONATION_FORBIDDEN, a token 403 AGENT_FORBIDDEN);
 * the bank account / ID / tax numbers the history masks are returned, and the
 * reveal is recorded in audit_log (`export`, `entity_change`) in the same
 * transaction. 404 when this company has no such change.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { assertHumanSession } from '@/modules/accounting/services/bank/bankControlRefusal';
import { respondIfBankControlRefused } from '@/modules/accounting/services/bank/bankControlResponse';
import { revealEntityChange } from '@/modules/accounting/services/core/entityChanges/entityChangeReveal';
import { isHistoryAdmin } from '@/modules/accounting/services/core/entityChanges/entityChangeTypes';

const Body = z.object({ changeId: UUID });

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { companyId, companyRole, user } = req as CompanyAuthedRequest;
  if (!isHistoryAdmin(companyRole)) return apiResponse.forbidden(res, 'Only an owner or admin can reveal recorded values.');
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  try {
    await assertHumanSession('reveal recorded bank, ID or tax numbers');
  } catch (err) {
    if (respondIfBankControlRefused(res, err)) return;
    throw err;
  }
  const forwardedFor = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(',')[0]?.trim() || req.socket?.remoteAddress;
  const change = await revealEntityChange(companyId, parsed.data.changeId, {
    userId: user.id, userEmail: user.email, ip, userAgent: req.headers['user-agent'],
  });
  if (!change) return apiResponse.notFound(res, 'Change');
  return apiResponse.success(res, change);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
