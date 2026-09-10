/**
 * Bank Rules Preview API
 * GET — returns count of transactions matching a pattern
 * Query params: bankAccountId, pattern, matchType, matchField
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { toSqlPattern } from '@/modules/accounting/services/bank/bankRulesMatchingHelpers';

type Row = Record<string, unknown>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
  }

  const { bankAccountId, pattern, matchType = 'contains', matchField = 'description' } = req.query;

  if (!pattern || typeof pattern !== 'string') {
    return apiResponse.badRequest(res, 'pattern is required');
  }

  const raw = pattern.trim();
  if (!raw) return apiResponse.success(res, { matchCount: 0 });

  // Built by the same helper `applyRules` uses, so the count shown is the count
  // the rule will act on. Assembled here from the raw param, a pattern carrying
  // `_` or `%` previewed as the over-matched (larger) set while the apply path
  // escaped them — and the preview exists precisely to answer "how many
  // transactions will this rule affect".
  const ilike = toSqlPattern(typeof matchType === 'string' ? matchType : 'contains', raw);

  const bid = typeof bankAccountId === 'string' ? bankAccountId : null;
  const field = typeof matchField === 'string' ? matchField : 'description';

  // Audit Finding 4: preview must answer "how many actionable transactions
  // will this rule affect", not "how many historical descriptions match".
  // Restrict to status = 'imported' (not yet allocated, not excluded) so the
  // user sees the impact on the review queue, not the entire history.
  let rows: Row[];

  if (bid && field === 'description') {
    rows = (await sql`SELECT COUNT(*)::INT AS cnt FROM bank_transactions WHERE bank_account_id = ${bid}::UUID AND description ILIKE ${ilike} AND status = 'imported' AND company_id = ${companyId}`) as Row[];
  } else if (bid && field === 'reference') {
    rows = (await sql`SELECT COUNT(*)::INT AS cnt FROM bank_transactions WHERE bank_account_id = ${bid}::UUID AND reference ILIKE ${ilike} AND status = 'imported' AND company_id = ${companyId}`) as Row[];
  } else if (bid && field === 'both') {
    rows = (await sql`SELECT COUNT(*)::INT AS cnt FROM bank_transactions WHERE bank_account_id = ${bid}::UUID AND (description ILIKE ${ilike} OR reference ILIKE ${ilike}) AND status = 'imported' AND company_id = ${companyId}`) as Row[];
  } else if (field === 'reference') {
    rows = (await sql`SELECT COUNT(*)::INT AS cnt FROM bank_transactions WHERE reference ILIKE ${ilike} AND status = 'imported' AND company_id = ${companyId}`) as Row[];
  } else if (field === 'both') {
    rows = (await sql`SELECT COUNT(*)::INT AS cnt FROM bank_transactions WHERE (description ILIKE ${ilike} OR reference ILIKE ${ilike}) AND status = 'imported' AND company_id = ${companyId}`) as Row[];
  } else {
    rows = (await sql`SELECT COUNT(*)::INT AS cnt FROM bank_transactions WHERE description ILIKE ${ilike} AND status = 'imported' AND company_id = ${companyId}`) as Row[];
  }

  return apiResponse.success(res, { matchCount: Number(rows[0]?.cnt || 0) });
}


export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
