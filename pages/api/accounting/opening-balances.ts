import { sql } from '@/lib/neon';
import { OpeningBalanceValidationError, postOpeningBalances } from '@/modules/accounting/services/gl/openingBalancePostingService';
/**
 * Opening Balances API
 * GET /api/accounting/opening-balances - Get posting-level accounts for balance entry
 * POST /api/accounting/opening-balances - Save opening balances as journal entry
 * Sage equivalent: Accountant's Area > Opening Balances
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { apiResponse } from '@/lib/apiResponse';
import { JOURNAL_DATE_REFUSED, withJournalDateRefusal } from '@/lib/apiJournalDate';
import { withAuth, type CompanyAuthedRequest, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';


async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    try {
      // Get all posting-level (level 3) accounts
      const accounts = await sql`
        SELECT
          id, account_code, account_name, account_type,
          normal_balance, is_active
        FROM gl_accounts
        WHERE level = 3 AND is_active = true AND company_id = ${companyId}
        ORDER BY account_code
      `;

      return apiResponse.success(res, {
        accounts: accounts.map(a => ({
          ...a,
          opening_debit: 0,
          opening_credit: 0,
        })),
      });
    } catch (err) {
      log.error('Failed to fetch accounts for opening balances', { error: err, module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to fetch accounts');
    }
  }

  if (req.method === 'POST') {
    const userId = (req as AuthenticatedNextApiRequest).user.id;
    try {
      const entry = await withJournalDateRefusal(res, () => postOpeningBalances(companyId, userId, req.body?.balances));
      if (entry === JOURNAL_DATE_REFUSED) return;
      log.info('Opening balances posted', { entryId: entry.id, companyId }, 'accounting');
      return apiResponse.success(res, { journalEntry: entry });
    } catch (err) {
      if (respondIfLockTimeout(res, err)) return;
      if (err instanceof OpeningBalanceValidationError) return apiResponse.badRequest(res, err.message);
      log.error('Failed to save opening balances', { error: err, companyId }, 'accounting');
      return apiResponse.databaseError(res, err, 'Failed to save opening balances');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

 
export default withAuth(withRole('admin')(withErrorHandler(withCsrf(handler))));
