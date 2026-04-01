/**
 * Accounting Dashboard Stats API
 * GET /api/accounting/dashboard-stats
 * Returns aggregated financial metrics for the dashboard overview
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;

  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;

    // Run all queries in parallel
    const [
      bankBalances,
      apTotal,
      arTotal,
      monthRevenue,
      monthExpenses,
      unallocatedCount,
      recentJournals,
    ] = await Promise.all([
      // Bank account balances (from bank_transactions, matching bank-accounts API)
      sql`
        SELECT ga.account_code, ga.account_name,
          COALESCE(SUM(CASE WHEN bt.amount > 0 THEN bt.amount ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN bt.amount < 0 THEN ABS(bt.amount) ELSE 0 END), 0) AS balance
        FROM gl_accounts ga
        LEFT JOIN bank_transactions bt ON bt.bank_account_id = ga.id
        WHERE ga.account_subtype = 'bank' AND ga.is_active = true AND ga.company_id = ${companyId}
        GROUP BY ga.id, ga.account_code, ga.account_name
        ORDER BY ga.account_code
      `,
      // Accounts Payable total (from supplier_invoices, matching AP aging)
      sql`
        SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS total
        FROM supplier_invoices
        WHERE company_id = ${companyId} AND status NOT IN ('cancelled', 'paid')
      `,
      // Accounts Receivable total (from customer_invoices, matching AR aging)
      sql`
        SELECT COALESCE(SUM(total_amount - COALESCE(amount_paid, 0)), 0) AS total
        FROM customer_invoices
        WHERE company_id = ${companyId} AND status NOT IN ('cancelled', 'paid')
      `,
      // Revenue this month (account_type = 'revenue')
      sql`
        SELECT COALESCE(SUM(credit - debit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE ga.account_type = 'revenue' AND je.status = 'posted'
          AND je.company_id = ${companyId} AND je.entry_date >= ${monthStart}
      `,
      // Expenses this month (account_type = 'expense')
      sql`
        SELECT COALESCE(SUM(debit - credit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE ga.account_type = 'expense' AND je.status = 'posted'
          AND je.company_id = ${companyId} AND je.entry_date >= ${monthStart}
      `,
      // Unallocated bank transactions
      sql`
        SELECT COUNT(*) AS count FROM bank_transactions WHERE company_id = ${companyId} AND status = 'imported'
      `,
      // Recent journal entries (last 5)
      sql`
        SELECT id, entry_date, description, source, status,
          (SELECT SUM(debit) FROM gl_journal_lines WHERE journal_entry_id = je.id) AS total_debit
        FROM gl_journal_entries je
        WHERE je.company_id = ${companyId}
        ORDER BY created_at DESC LIMIT 5
      `,
    ]);

    const banks = (bankBalances as { account_code: string; account_name: string; balance: string }[]).map(b => ({
      code: b.account_code,
      name: b.account_name,
      balance: Number(b.balance),
    }));

    return apiResponse.success(res, {
      banks,
      totalBankBalance: banks.reduce((sum, b) => sum + b.balance, 0),
      apTotal: Number((apTotal as { total: string }[])[0]?.total || 0),
      arTotal: Number((arTotal as { total: string }[])[0]?.total || 0),
      monthRevenue: Number((monthRevenue as { total: string }[])[0]?.total || 0),
      monthExpenses: Number((monthExpenses as { total: string }[])[0]?.total || 0),
      unallocatedTx: Number((unallocatedCount as { count: string }[])[0]?.count || 0),
      recentJournals: (recentJournals as Record<string, unknown>[]).map(j => ({
        id: j.id,
        date: j.entry_date,
        description: j.description,
        source: j.source,
        status: j.status,
        amount: Number(j.total_debit || 0),
      })),
    });
  } catch (err) {
    log.error('Failed to load dashboard stats', { error: err }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to load dashboard stats');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
