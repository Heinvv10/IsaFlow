/**
 * Bank Accounts API
 * GET /api/accounting/bank-accounts - List bank GL accounts with transaction summaries
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

const PutBankAccountSchema = z.object({
  id: UUID,
  bankAccountNumber: z.string().max(50).optional(),
  bankName: z.string().max(100).optional(),
  bankBranchName: z.string().max(100).optional(),
  bankBranchCode: z.string().max(20).optional(),
  bankAccountType: z.string().max(20).optional(),
  bankIsDefault: z.boolean().optional(),
  bankDefaultPaymentMethod: z.string().max(20).optional(),
  bankOpeningBalance: z.union([z.number(), z.string()]).optional(),
  bankOpeningBalanceDate: z.string().max(10).optional(),
  description: z.string().max(500).optional(),
  accountName: z.string().max(100).optional(),
  isActive: z.boolean().optional(),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'PUT') {
    try {
      const parsed = PutBankAccountSchema.safeParse(req.body);
      if (!parsed.success) {
        return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
      }
      const b = parsed.data;
      const { id } = b;
      const s = (v: string | undefined) => (typeof v === 'string' && v.trim() ? v.trim() : null);
      const n = (v: number | string | undefined) =>
        v !== undefined && v !== null && v !== '' ? Number(v) : null;
      const bool = (v: boolean | undefined) => (typeof v === 'boolean' ? v : null);

      await sql`
        UPDATE gl_accounts SET
          bank_account_number = COALESCE(${s(b.bankAccountNumber)}, bank_account_number),
          bank_name = COALESCE(${s(b.bankName)}, bank_name),
          bank_branch_name = COALESCE(${s(b.bankBranchName)}, bank_branch_name),
          bank_branch_code = COALESCE(${s(b.bankBranchCode)}, bank_branch_code),
          bank_account_type = COALESCE(${s(b.bankAccountType)}, bank_account_type),
          bank_is_default = COALESCE(${bool(b.bankIsDefault)}, bank_is_default),
          bank_default_payment_method = COALESCE(${s(b.bankDefaultPaymentMethod)}, bank_default_payment_method),
          bank_opening_balance = COALESCE(${n(b.bankOpeningBalance)}, bank_opening_balance),
          bank_opening_balance_date = COALESCE(${s(b.bankOpeningBalanceDate)}::date, bank_opening_balance_date),
          description = COALESCE(${s(b.description)}, description),
          account_name = COALESCE(${s(b.accountName)}, account_name),
          is_active = COALESCE(${bool(b.isActive)}, is_active),
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
        ga.bank_name,
        ga.bank_branch_name,
        ga.bank_branch_code,
        ga.bank_account_type,
        ga.bank_is_default,
        ga.bank_default_payment_method,
        ga.bank_opening_balance,
        ga.bank_opening_balance_date,
        COALESCE(s.txn_count, 0)         AS txn_count,
        COALESCE(s.total_debits, 0)       AS total_debits,
        COALESCE(s.total_credits, 0)      AS total_credits,
        COALESCE(s.balance, 0)            AS balance,
        COALESCE(s.reconciled_balance, 0) AS reconciled_balance,
        COALESCE(s.unreconciled_balance, 0) AS unreconciled_balance,
        COALESCE(s.unreconciled_count, 0) AS unreconciled_count,
        COALESCE(s.unallocated_count, 0)  AS unallocated_count,
        COALESCE(s.allocated_count, 0)    AS allocated_count,
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
          COUNT(CASE WHEN bt.status IN ('imported', 'allocated') THEN 1 END)::INT AS unreconciled_count,
          -- Allocated = has any category: AI suggestion OR explicitly saved allocation
          COUNT(CASE WHEN (
            bt.suggested_gl_account_id IS NOT NULL OR
            bt.suggested_supplier_id   IS NOT NULL OR
            bt.suggested_client_id     IS NOT NULL OR
            bt.allocation_type         IS NOT NULL
          ) THEN 1 END)::INT AS allocated_count,
          -- Unallocated = no category at all, not excluded
          COUNT(CASE WHEN (
            bt.suggested_gl_account_id IS NULL AND
            bt.suggested_supplier_id   IS NULL AND
            bt.suggested_client_id     IS NULL AND
            bt.allocation_type         IS NULL AND
            bt.status != 'excluded'
          ) THEN 1 END)::INT AS unallocated_count,
          MIN(bt.transaction_date)                                     AS first_date,
          MAX(bt.transaction_date)                                     AS last_date
        FROM bank_transactions bt
        WHERE bt.bank_account_id = ga.id
      ) s ON TRUE
      WHERE ga.account_subtype = 'bank'
        AND ga.is_active = TRUE
        AND ga.company_id = ${companyId}
        -- Show only leaf bank accounts. Tenants commonly nest 1110 Bank under
        -- 1100 Current Assets, and some nest per-employee paycards under a
        -- bank-subtype rollup; both used to hide every nested bank from this
        -- list. We keep rollup parents out by excluding any row that has a
        -- bank-subtype child.
        AND NOT EXISTS (
          SELECT 1 FROM gl_accounts child
           WHERE child.parent_account_id = ga.id
             AND child.company_id = ga.company_id
             AND child.account_subtype = 'bank'
        )
      ORDER BY ga.account_code
    `;

    const accounts = rows.map(r => ({
      id: r.id,
      accountCode: r.account_code,
      accountName: r.account_name,
      description: r.description,
      bankAccountNumber: r.bank_account_number || null,
      bankName: r.bank_name || null,
      bankBranchName: r.bank_branch_name || null,
      bankBranchCode: r.bank_branch_code || null,
      bankAccountType: r.bank_account_type || 'current',
      bankIsDefault: r.bank_is_default || false,
      bankDefaultPaymentMethod: r.bank_default_payment_method || 'eft',
      bankOpeningBalance: Number(r.bank_opening_balance || 0),
      bankOpeningBalanceDate: r.bank_opening_balance_date ? String(r.bank_opening_balance_date).split('T')[0] : null,
      isActive: r.is_active,
      txnCount: Number(r.txn_count),
      totalDebits: Number(r.total_debits),
      totalCredits: Number(r.total_credits),
      balance: Number(r.balance),
      reconciledBalance: Number(r.reconciled_balance),
      unreconciledBalance: Number(r.unreconciled_balance),
      unreconciledCount: Number(r.unreconciled_count),
      allocatedCount:   Number(r.allocated_count ?? 0),
      unallocatedCount: Number(r.unallocated_count ?? 0),
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

 
// Bank account structure is a financial control point — only owners
// and admins can edit. Managers can still import statements, reconcile,
// and allocate transactions through the other bank-* endpoints.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler, { allowedRoles: ['owner', 'admin'] }))));
