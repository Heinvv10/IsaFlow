/**
 * The dashboard's one "Needs attention" list (GET /api/accounting/dashboard/attention).
 *
 * Reads, then shapes with the pure attentionShape#shapeAttention.
 *
 * Hard readers: any failure propagates, so the route answers 500 and the
 * screen shows Retry, never an all-clear it could not prove. Soft readers
 * (the bureau work feed and the owner cash position) already degrade inside.
 *
 * Tenant scoping: every statement carries company_id, and `companyId` comes
 * only from withAuth.
 */
import { sql } from '@/lib/neon';
import { todayInSast } from '@/lib/saDateParser';
import { aggregateBureauWork, type CompanyMeta } from '@/modules/bureau/services/bureauWorkAggregatorService';
import { getOwnerCashPosition } from '@/modules/bureau/services/ownerCashPositionService';
import { getHeadlineCounts } from '../reports/headlineFigures';
import { getOpenBook } from '../reports/dashboardOpenBook';
import { getCashBalance } from '../bank/cashBalanceService';
import { getUnreconciledBankTxns, getOpenPriorPeriods } from './workbenchService';
import { shapeAttention, type AttentionList, type OpenPayRun } from './attentionShape';

interface PayRunRow { id: string; period_year: number | string; period_month: number | string; status: OpenPayRun['status'] }

async function getOpenPayRuns(companyId: string): Promise<OpenPayRun[]> {
  const rows = (await sql`
    SELECT id::text AS id, period_year, period_month, status
      FROM payroll_run_headers
     WHERE company_id = ${companyId}::uuid
       AND status IN ('draft','calculated','approved')
     ORDER BY period_year, period_month
  `) as unknown as PayRunRow[];
  return rows.map((r) => ({
    id: r.id, periodYear: Number(r.period_year), periodMonth: Number(r.period_month), status: r.status,
  }));
}

export async function getAttentionList(companyId: string, now: Date = new Date()): Promise<AttentionList> {
  const asAt = todayInSast(now);
  const [counts, ar, unreconciledBankTxns, openPriorPeriods, cashBalance, payRuns] = await Promise.all([
    getHeadlineCounts(companyId, asAt),
    // The Receivables card's own population and day (headlineFigures), so the row and the card's "overdue" are one figure.
    getOpenBook(companyId, 'ar', asAt),
    getUnreconciledBankTxns(companyId),
    getOpenPriorPeriods(companyId),
    getCashBalance(companyId, asAt),
    getOpenPayRuns(companyId),
  ]);
  const meta = new Map<string, CompanyMeta>([
    [companyId, { bureau_id: '', bureau_name: '', company_id: companyId, company_name: '' }],
  ]);
  const [work, cash] = await Promise.all([
    aggregateBureauWork([companyId], meta, now),
    getOwnerCashPosition(companyId, cashBalance.total, now),
  ]);
  const items = shapeAttention({
    asAt,
    today: now,
    counts,
    overdueInvoices: { count: ar.overdueCount, amount: ar.overdue },
    unreconciledBankTxns,
    openPriorPeriods,
    payRuns,
    work: work.items,
    cash,
  });
  return { asAt, items };
}
