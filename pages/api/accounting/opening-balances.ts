import { sql } from '@/lib/neon';
/**
 * Opening Balances API
 * GET /api/accounting/opening-balances - Get posting-level accounts for balance entry
 * POST /api/accounting/opening-balances - Save opening balances as journal entry
 * Sage equivalent: Accountant's Area > Opening Balances
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';


async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

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
    const { balances } = req.body;

    if (!balances || !Array.isArray(balances) || balances.length === 0) {
      return apiResponse.validationError(res, { balances: 'Array of {accountId, debit, credit} required' });
    }

    // Validate DR = CR
    const totalDebit = balances.reduce((sum: number, b: { debit: number }) => sum + Number(b.debit || 0), 0);
    const totalCredit = balances.reduce((sum: number, b: { credit: number }) => sum + Number(b.credit || 0), 0);

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return apiResponse.badRequest(res, `Debits (${totalDebit.toFixed(2)}) must equal Credits (${totalCredit.toFixed(2)})`);
    }

    try {
      // Get first open fiscal period
      const [period] = await sql`
        SELECT id FROM fiscal_periods
        WHERE status = 'open' AND company_id = ${companyId}
        ORDER BY start_date ASC
        LIMIT 1
      `;

      // Create opening balance journal entry
      const entryRows = await sql`
        INSERT INTO gl_journal_entries (
          id, company_id, entry_number, entry_date, description,
          source, status, fiscal_period_id,
          total_debit, total_credit,
          created_by, created_at
        ) VALUES (
          gen_random_uuid(),
          ${companyId},
          'OB-' || LPAD((SELECT COALESCE(MAX(CAST(SUBSTRING(entry_number FROM 4) AS INTEGER)), 0) + 1 FROM gl_journal_entries WHERE entry_number LIKE 'OB-%' AND company_id = ${companyId})::text, 4, '0'),
          COALESCE((SELECT start_date FROM fiscal_periods WHERE id = ${period?.id || null} AND company_id = ${companyId}), CURRENT_DATE),
          'Opening Balances',
          'opening_balance', 'posted', ${period?.id || null},
          ${totalDebit}, ${totalCredit},
          ${userId}, NOW()
        )
        RETURNING *
      `;
      const entry = entryRows[0];
      if (!entry) throw new Error('Failed to create journal entry');

      // Create journal lines
      for (const b of balances as { accountId: string; debit: number; credit: number }[]) {
        if (Number(b.debit) > 0 || Number(b.credit) > 0) {
          await sql`
            INSERT INTO gl_journal_lines (id, journal_entry_id, gl_account_id, debit, credit, description, created_at)
            VALUES (gen_random_uuid(), ${entry.id}, ${b.accountId}, ${Number(b.debit) || 0}, ${Number(b.credit) || 0}, 'Opening Balance', NOW())
          `;
        }
      }

      log.info('Opening balances posted', {
        entryId: entry.id,
        lines: balances.length,
        totalDebit,
        module: 'accounting',
      });

      return apiResponse.success(res, { journalEntry: entry });
    } catch (err) {
      log.error('Failed to save opening balances', { error: err, module: 'accounting' });
      return apiResponse.databaseError(res, err, 'Failed to save opening balances');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withRole('admin')(withErrorHandler(handler)));
