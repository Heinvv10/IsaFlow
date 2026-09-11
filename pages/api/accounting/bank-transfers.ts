import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { prepareBankTransfer, executeBankTransfer } from '@/modules/accounting/services/bank/bankTransferPostingService';
import { BankTransferRefusalError } from '@/modules/accounting/services/controls/bankTransferOperationMaterializer';
import { ErrorCode } from '@/lib/apiResponse.types';
import { log } from '@/lib/logger';
import { EffectivePermissionError, deniedPermissionMessage } from '@/lib/auth/effectivePermissions';
import { OperationApprovalRequiredError } from '@/modules/accounting/services/controls/approvalExecutionService';
import { isSuppliedApprovalRefusal, suppliedApprovalRefusalText } from '@/modules/accounting/services/controls/suppliedApprovalRefusal';

const prepare = z.object({
  action: z.literal('prepare').optional(), fromAccountId: UUID, toAccountId: UUID,
  amount: z.union([z.string(), z.number()]), reference: z.string().max(500).optional(),
  transferDate: z.string().max(10).optional(),
}).strict();
const execute = z.object({ action: z.literal('execute'), intentId: UUID, approvalId: UUID.optional() }).strict();

/** Preparation returns a reviewable intent; execution always names that immutable intent. */
async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  try {
    return await transfer(req, res, companyId, userId);
  } catch (err) {
    // Each refusal the caller can act on is answered 4xx with what to do; anything else stays a 500 fault.
    // BankTransferRefusalError: their own input (400), an intent that is not theirs (404), what the company's rows
    // do not allow (422). Every one is thrown before a write or inside the operation's savepoint, so none commits.
    if (err instanceof BankTransferRefusalError) {
      if (err.status === 400) return apiResponse.badRequest(res, err.message);
      if (err.status === 404) return apiResponse.notFound(res, 'Transfer intent');
      return apiResponse.error(res, ErrorCode.BUSINESS_RULE_VIOLATION, err.message);
    }
    if (err instanceof EffectivePermissionError) return apiResponse.forbidden(res, deniedPermissionMessage(err));
    if (err instanceof OperationApprovalRequiredError) {
      log.warn('Bank transfer refused: an approval is required', { companyId, reason: err.message }, 'accounting');
      return apiResponse.conflict(res, 'This transfer needs an independent approval under the company\'s approval policy, so nothing was posted. '
        + 'Request an approval for it, have another authorised person approve it, then post again with that approval id.');
    }
    // A supplied approval id this transfer cannot use; the control kernel writes the reason, never pg.
    if (isSuppliedApprovalRefusal(err)) {
      // Logged even though it is answered 4xx, as the year-end route does: 42501 also covers a broken request context.
      log.warn('Bank transfer refused the supplied approval', { companyId, reason: suppliedApprovalRefusalText(err) }, 'accounting');
      return apiResponse.conflict(res, `The approval supplied for this transfer cannot be used (${suppliedApprovalRefusalText(err)}). `
        + 'Nothing was posted. Request an approval for this transfer and post again with its approval id.');
    }
    throw err;
  }
}
async function transfer(req: NextApiRequest, res: NextApiResponse, companyId: string, userId: string) {
  if (req.body?.action === 'execute') {
    const parsed = execute.safeParse(req.body);
    if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    return apiResponse.success(res, await executeBankTransfer(companyId, userId, parsed.data.intentId,
      { approvalId: parsed.data.approvalId }));
  }
  const parsed = prepare.safeParse(req.body);
  if (!parsed.success) return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
  const { action: _action, ...input } = parsed.data;
  const transferDate = input.transferDate ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg' }).format(new Date());
  return apiResponse.success(res, await prepareBankTransfer(companyId, userId, { ...input, transferDate }));
}
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
