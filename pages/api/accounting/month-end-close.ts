import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { generateCloseChecklist, checkCompleteness, buildCloseProgressSummary } from '@/modules/accounting/services/monthEndCloseService';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method === 'GET') {
    const { companyId } = req;
    const period = new Date().toISOString().slice(0, 7); // YYYY-MM
    const monthStart = `${period}-01`;
    const monthEnd = new Date(Number(period.split('-')[0]), Number(period.split('-')[1]), 0).toISOString().split('T')[0];

    // Query actual completion status from DB (with graceful fallbacks for missing tables)
    const safeCount = async (query: Promise<Row[]>) => {
      try { const rows = await query; return Number(rows[0]?.cnt ?? 0) > 0; }
      catch { return false; }
    };

    const [hasPayrollPosted, hasDepreciationRun, hasBankRecon, hasVATRecon, hasAccruals] = await Promise.all([
      safeCount(sql`SELECT COUNT(*) as cnt FROM payroll_runs WHERE company_id = ${companyId} AND status = 'completed' AND pay_date >= ${monthStart}::DATE AND pay_date <= ${monthEnd}::DATE` as Promise<Row[]>),
      safeCount(sql`SELECT COUNT(*) as cnt FROM gl_journal_entries WHERE company_id = ${companyId} AND source = 'auto_depreciation' AND entry_date >= ${monthStart}::DATE AND entry_date <= ${monthEnd}::DATE` as Promise<Row[]>),
      safeCount(sql`SELECT COUNT(*) as cnt FROM bank_reconciliations WHERE company_id = ${companyId} AND status = 'completed' AND statement_end_date >= ${monthStart}::DATE` as Promise<Row[]>),
      safeCount(sql`SELECT COUNT(*) as cnt FROM gl_journal_entries WHERE company_id = ${companyId} AND source = 'vat' AND entry_date >= ${monthStart}::DATE AND entry_date <= ${monthEnd}::DATE` as Promise<Row[]>),
      safeCount(sql`SELECT COUNT(*) as cnt FROM gl_journal_entries WHERE company_id = ${companyId} AND description ILIKE '%accrual%' AND entry_date >= ${monthStart}::DATE AND entry_date <= ${monthEnd}::DATE` as Promise<Row[]>),
    ]);

    const checklist = generateCloseChecklist('with_payroll');
    const completeness = checkCompleteness({ hasPayrollPosted, hasDepreciationRun, hasBankRecon, hasVATRecon, hasAccruals });
    const completedCount = [hasPayrollPosted, hasDepreciationRun, hasBankRecon, hasVATRecon, hasAccruals].filter(Boolean).length;
    const progress = buildCloseProgressSummary(completedCount, checklist.length, period);
    return apiResponse.success(res, { checklist, completeness, progress });
  }
  return apiResponse.methodNotAllowed(res, req.method!, ['GET']);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
