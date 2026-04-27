/**
 * Account Ledger API
 * GET /api/accounting/reports/account-ledger
 *
 * Query params:
 *   account_id   — UUID of the GL account  (one of account_id or account_code required)
 *   account_code — account code (e.g. "1110") (one of account_id or account_code required)
 *   from         — ISO date YYYY-MM-DD, start of range (required)
 *   to           — ISO date YYYY-MM-DD, end of range   (required)
 *   posted_only  — "true" | "false" (default: "true")
 *   limit        — integer 1–500 (default: 200)
 *   offset       — integer >= 0  (default: 0)
 *
 * Response: { success: true, data: { rows, total, openingBalance, meta } }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { log } from '@/lib/logger';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  const {
    account_id,
    account_code,
    from,
    to,
    posted_only = 'true',
    limit: limitParam = '200',
    offset: offsetParam = '0',
  } = req.query as Record<string, string | undefined>;

  // Validate: at least one account identifier required
  const hasId = typeof account_id === 'string' && account_id.length > 0;
  const hasCode = typeof account_code === 'string' && account_code.length > 0;
  if (!hasId && !hasCode) {
    return apiResponse.badRequest(res, 'account_id (UUID) or account_code is required');
  }
  if (hasId && !UUID_RE.test(account_id as string)) {
    return apiResponse.badRequest(res, 'account_id must be a valid UUID');
  }

  if (!from || typeof from !== 'string' || !ISO_DATE_RE.test(from)) {
    return apiResponse.badRequest(res, 'from must be a valid ISO date (YYYY-MM-DD)');
  }
  if (!to || typeof to !== 'string' || !ISO_DATE_RE.test(to)) {
    return apiResponse.badRequest(res, 'to must be a valid ISO date (YYYY-MM-DD)');
  }
  if (from > to) {
    return apiResponse.badRequest(res, 'from must not be after to');
  }

  const limit = parseInt(String(limitParam), 10);
  const offset = parseInt(String(offsetParam), 10);
  if (isNaN(limit) || limit < 1 || limit > 500) {
    return apiResponse.badRequest(res, 'limit must be between 1 and 500');
  }
  if (isNaN(offset) || offset < 0) {
    return apiResponse.badRequest(res, 'offset must be >= 0');
  }

  const postedOnly = String(posted_only).toLowerCase() !== 'false';

  try {
    const result = await getAccountLedger({
      companyId,
      accountId: hasId ? (account_id as string) : undefined,
      accountCode: !hasId && hasCode ? (account_code as string) : undefined,
      fromDate: from,
      toDate: to,
      postedOnly,
      limit,
      offset,
    });

    return apiResponse.success(res, result);
  } catch (err) {
    log.error(
      'Account ledger API failed',
      { error: err, account_id, account_code },
      'accounting-api',
    );
    return apiResponse.internalError(res, err, 'Failed to load account ledger');
  }
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
