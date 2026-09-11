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
    // A refusal the person can fix: their own input (400), or what the company's rows do not allow (422).
    if (err instanceof BankTransferRefusalError) {
      return err.status === 400 ? apiResponse.badRequest(res, err.message) : apiResponse.error(res, ErrorCode.BUSINESS_RULE_VIOLATION, err.message);
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
