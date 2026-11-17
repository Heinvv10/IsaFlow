/**
 * The HTTP side shared by the salary bank-file routes (wave 6 BF, spec rule 14). A bank-file write moves money or
 * records that money moved, and the file carries every employee's full account number, so a write is taken only by:
 *   - an owner or admin (the roles that read full bank details; a manager sees them masked);
 *   - a person signed in as themselves: a token channel (no session id) is 403 AGENT_FORBIDDEN, as the payslip route;
 *   - not under Login-as (403 IMPERSONATION_FORBIDDEN).
 * All judged before the service reads or writes anything.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import type { CompanyAuthedRequest } from '@/lib/auth';
import { assertNotImpersonating, respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { currentSessionActor } from '@/lib/auth/impersonationSessions';
import { getClientIp } from '@/lib/rateLimit';
import { PayrollBankFileRefusal } from '@/modules/accounting/services/payroll/payrollBankFileStatus';
import type { BankFileActor } from '@/modules/accounting/services/payroll/payrollBankFileService';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The actor of a bank-file write, or null once a refusal has been sent. */
export async function bankFileWriter(req: NextApiRequest, res: NextApiResponse): Promise<BankFileActor | null> {
  const { companyRole, user } = req as CompanyAuthedRequest;
  if (!['owner', 'admin'].includes(companyRole)) {
    apiResponse.forbidden(res, 'Only an owner or admin can make, confirm or void a salary bank file.');
    return null;
  }
  if ((await currentSessionActor()) === 'unknown') {
    apiResponse.error(res, ErrorCode.FORBIDDEN, 'Only a person signed in as themselves can do this; an agent or a job cannot.',
      { reason: 'AGENT_FORBIDDEN' });
    return null;
  }
  try {
    await assertNotImpersonating();
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return null;
    throw err;
  }
  const sessionId = typeof user.claims.session_id === 'string' ? user.claims.session_id : null;
  const agent = req.headers['user-agent'];
  return { userId: user.id, userEmail: user.email, ip: getClientIp(req), userAgent: typeof agent === 'string' ? agent : undefined, sessionId };
}

const CODE: Record<number, ErrorCode> = { 400: ErrorCode.BAD_REQUEST, 403: ErrorCode.FORBIDDEN, 404: ErrorCode.NOT_FOUND, 409: ErrorCode.CONFLICT };

/** Answers a PayrollBankFileRefusal (raised before any write); false for anything else. */
export function respondIfBankFileRefused(res: NextApiResponse, err: unknown): boolean {
  if (!(err instanceof PayrollBankFileRefusal)) return false;
  apiResponse.error(res, CODE[err.status]!, err.message, { reason: err.reason, problems: err.problems });
  return true;
}
