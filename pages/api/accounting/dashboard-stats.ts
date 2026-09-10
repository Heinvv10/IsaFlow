/**
 * Accounting Dashboard Stats API
 * GET /api/accounting/dashboard-stats
 * Returns aggregated financial metrics for the dashboard overview
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { BANK_SUBTYPES } from '@/modules/accounting/services/gl/accountClassification';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { AR_OPEN_STATUSES, AP_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { fmtDate } from '@/lib/fmtDate';
import { documentInLedgerAsAtFragment } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    // The dashboard is "right now", so that is the date the AR/AP totals below
    // ask their soft-delete question at.
    const asAtStr = fmtDate(now);

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
      // Bank account balances from GL (posted journal lines against bank accounts)
      // Reads from gl_journal_lines so the balance matches the Trial Balance,
      // not the raw bank_transactions sum which inflates unreconciled imports.
      //
      // The posted filter MUST live inside this subquery. It used to sit in the
      // ON-clause of a LEFT JOIN onto gl_journal_entries while the SUM read
      // gl_journal_lines, so it restricted nothing: a draft line simply got NULL
      // entry columns and was still summed. That understated Brightsphere cash
      // by R106,843.88.
      //
      // is_active is deliberately absent. It is a chart-of-accounts picker flag,
      // not a statement about whether the account holds money. This currently
      // adds R6,550.00 on account 1110 Bank - Primary, which is deactivated and
      // still carries a balance.
      sql`
        SELECT ga.account_code, ga.account_name,
          COALESCE(b.balance, 0) AS balance
        FROM gl_accounts ga
        LEFT JOIN (
          SELECT jl.gl_account_id, SUM(jl.debit - jl.credit) AS balance
          FROM gl_journal_lines jl
          JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
          WHERE jl.company_id = ${companyId}::UUID
            AND je.company_id = ${companyId}::UUID
            AND je.status = 'posted'
          GROUP BY jl.gl_account_id
        ) b ON b.gl_account_id = ga.id
        WHERE ga.account_subtype = ANY(${BANK_SUBTYPES as string[]}::TEXT[])
          AND ga.company_id = ${companyId}::UUID
        ORDER BY ga.account_code
      `,
      // Accounts Payable total, TODAY, on the LIVE open set (AP_OPEN_STATUSES).
      // NOT the ageing's population, and this comment used to claim it was
      // ("same set as apAgingService so dashboard == aging report"). The
      // ageing uses shared/documentPopulation, which is wider — see
      // src/lib/constants/invoiceStatuses.ts for the rows the two differ on.
      sql`
        SELECT COALESCE(SUM(si.total_amount - COALESCE(si.amount_paid, 0)), 0) AS total
        FROM supplier_invoices si
        WHERE si.company_id = ${companyId}
          AND ${documentInLedgerAsAtFragment('si', asAtStr, companyId)}
          AND si.status = ANY(${Array.from(AP_OPEN_STATUSES)}::text[])
      `,
      // Accounts Receivable total, TODAY, on the LIVE open set (AR_OPEN_STATUSES).
      // NOT the ageing's population, and this comment used to claim it was.
      // Same caveat as the AP total above.
      sql`
        SELECT COALESCE(SUM(ci.total_amount - COALESCE(ci.amount_paid, 0)), 0) AS total
        FROM customer_invoices ci
        WHERE ci.company_id = ${companyId}
          AND ${documentInLedgerAsAtFragment('ci', asAtStr, companyId)}
          AND ci.status = ANY(${Array.from(AR_OPEN_STATUSES)}::text[])
      `,
      // Revenue this month (account_type = 'revenue')
      sql`
        SELECT COALESCE(SUM(credit - debit), 0) AS total
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE ga.account_type = 'revenue' AND je.status = 'posted'
          AND je.company_id = ${companyId} AND jl.company_id = ${companyId}::UUID AND je.entry_date >= ${monthStart}
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
          (SELECT SUM(debit) FROM gl_journal_lines WHERE journal_entry_id = je.id AND company_id = ${companyId}::UUID) AS total_debit
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

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
