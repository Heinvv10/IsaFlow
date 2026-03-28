/**
 * Bank Accounts API
 * GET /api/accounting/bank-accounts - List bank GL accounts with transaction summaries
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'PUT') {
    try {
      const { id, bankAccountNumber } = req.body;
      if (!id) return apiResponse.badRequest(res, 'id is required');
      await sql`
        UPDATE gl_accounts
        SET bank_account_number = ${bankAccountNumber || null},
            updated_at = NOW()
        WHERE id = ${id} AND account_subtype = 'bank' AND company_id = ${companyId}
      `;
      return apiResponse.success(res, { updated: true });
    } catch (err) {
      log.error('Failed to update bank account', { error: err }, 'accounting-api');
      return apiResponse.badRequest(res, 'Failed to update bank account');
    }
  }

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'PUT']);
  }

  try {
    const rows = await sql`
      SELECT
        ga.id,
        ga.account_code,
        ga.account_name,
        ga.description,
        ga.is_active,
        ga.bank_account_number,
        COALESCE(s.txn_count, 0)         AS txn_count,
        COALESCE(s.total_debits, 0)       AS total_debits,
        COALESCE(s.total_credits, 0)      AS total_credits,
        COALESCE(s.balance, 0)            AS balance,
        COALESCE(s.reconciled_balance, 0) AS reconciled_balance,
        COALESCE(s.unreconciled_balance, 0) AS unreconciled_balance,
        COALESCE(s.unreconciled_count, 0) AS unreconciled_count,
        s.first_date,
        s.last_date
      FROM gl_accounts ga
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::INT                                             AS txn_count,
          SUM(CASE WHEN bt.amount < 0 THEN ABS(bt.amount) ELSE 0 END) AS total_debits,
          SUM(CASE WHEN bt.amount > 0 THEN bt.amount ELSE 0 END)      AS total_credits,
          SUM(bt.amount)                                               AS balance,
          -- Reconciled = transactions matched to a GL journal entry
          SUM(CASE WHEN bt.matched_journal_line_id IS NOT NULL THEN bt.amount ELSE 0 END) AS reconciled_balance,
          -- Unreconciled = imported/suggested but not yet matched
          SUM(CASE WHEN bt.matched_journal_line_id IS NULL AND bt.status != 'excluded' THEN bt.amount ELSE 0 END) AS unreconciled_balance,
          COUNT(CASE WHEN bt.status = 'imported' THEN 1 END)::INT     AS unreconciled_count,
          MIN(bt.transaction_date)                                     AS first_date,
          MAX(bt.transaction_date)                                     AS last_date
        FROM bank_transactions bt
        WHERE bt.bank_account_id = ga.id
      ) s ON TRUE
      WHERE ga.account_subtype = 'bank'
        AND ga.is_active = TRUE
        AND ga.company_id = ${companyId}
      ORDER BY ga.account_code
    `;

    const accounts = rows.map(r => ({
      id: r.id,
      accountCode: r.account_code,
      accountName: r.account_name,
      description: r.description,
      bankAccountNumber: r.bank_account_number || null,
      isActive: r.is_active,
      txnCount: Number(r.txn_count),
      totalDebits: Number(r.total_debits),
      totalCredits: Number(r.total_credits),
      balance: Number(r.balance),
      reconciledBalance: Number(r.reconciled_balance),
      unreconciledBalance: Number(r.unreconciled_balance),
      unreconciledCount: Number(r.unreconciled_count),
      firstDate: r.first_date instanceof Date
        ? r.first_date.toISOString().split('T')[0]
        : r.first_date ? String(r.first_date).split('T')[0] : null,
      lastDate: r.last_date instanceof Date
        ? r.last_date.toISOString().split('T')[0]
        : r.last_date ? String(r.last_date).split('T')[0] : null,
    }));

    return apiResponse.success(res, accounts);
  } catch (err) {
    log.error('Failed to get bank accounts', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to get bank accounts');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
