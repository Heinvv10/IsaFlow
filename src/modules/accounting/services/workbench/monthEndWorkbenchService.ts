/**
 * Month-End Workbench aggregator.
 *
 * Read-only aggregation of close-of-month status across every relevant module
 * for a single company, scoped to one period (YYYY-MM). Per the consultant
 * review: the workbench is the practice/bookkeeper home screen — not a
 * generic dashboard. No new business logic — every count/total comes from
 * existing services or direct GL queries.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { listPayrollRuns } from '@/modules/accounting/services/payroll/payrollRunService';
import { listAfsDocuments } from '@/modules/accounting/services/afs/afsDocumentService';
import type { AgingBucket } from '@/modules/accounting/types/ap.types';

export type CardStatus = 'ready' | 'attention' | 'blocked' | 'in_progress' | 'not_started';

export interface WorkbenchCard {
  id: string;
  title: string;
  status: CardStatus;
  primary: string;
  secondary?: string;
  href?: string;
  count?: number;
}

export interface MonthEndWorkbench {
  companyId: string;
  period: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  cards: WorkbenchCard[];
  trialBalanceBalanced: boolean;
  trialBalanceDiff: number;
}

function parsePeriod(period: string): { start: string; end: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) throw new Error(`Invalid period: ${period} (expected YYYY-MM)`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

function sumAging(buckets: AgingBucket[]): { total: number; overdue: number } {
  let total = 0;
  let overdue = 0;
  for (const b of buckets) {
    const cur = Number(b.current) || 0;
    const d30 = Number(b.days30) || 0;
    const d60 = Number(b.days60) || 0;
    const d90 = Number(b.days90) || 0;
    const d120 = Number(b.days120Plus) || 0;
    total += cur + d30 + d60 + d90 + d120;
    overdue += d30 + d60 + d90 + d120;
  }
  return { total, overdue };
}

function fmtR(n: number): string {
  return `R${n.toLocaleString('en-ZA', { maximumFractionDigits: 0 })}`;
}

async function buildBankingCard(companyId: string, periodEnd: string): Promise<WorkbenchCard> {
  const rows = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE bt.status = 'imported' AND bt.transaction_date <= ${periodEnd}::date) AS unmatched,
      COUNT(*) FILTER (WHERE bt.matched_journal_line_id IS NOT NULL AND bt.transaction_date <= ${periodEnd}::date) AS matched,
      MAX(br.completed_at) AS last_recon_completed_at
    FROM bank_transactions bt
    LEFT JOIN bank_reconciliations br ON br.bank_account_id = bt.bank_account_id
      AND br.company_id = bt.company_id
      AND br.status = 'completed'
    WHERE bt.company_id = ${companyId}::uuid
  `) as DbRow[];
  const r = rows[0]!;
  const unmatched = Number(r.unmatched) || 0;
  const matched = Number(r.matched) || 0;
  const lastRecon = r.last_recon_completed_at ? String(r.last_recon_completed_at).slice(0, 10) : 'never';
  const status: CardStatus = unmatched === 0 ? 'ready' : unmatched < 20 ? 'in_progress' : 'attention';
  return {
    id: 'banking',
    title: 'Bank Reconciliation',
    status,
    primary: `${unmatched} unmatched`,
    secondary: `${matched} matched · last recon ${lastRecon}`,
    href: '/accounting/bank-reconciliation',
    count: unmatched,
  };
}

async function buildSalesCard(companyId: string, periodEnd: string): Promise<WorkbenchCard> {
  const buckets = await getARAging(companyId, periodEnd);
  const { total, overdue } = sumAging(buckets);
  const status: CardStatus = overdue > total * 0.4 ? 'attention' : overdue > 0 ? 'in_progress' : 'ready';
  return {
    id: 'sales',
    title: 'Sales & Receivables',
    status,
    primary: `${fmtR(overdue)} overdue`,
    secondary: `${fmtR(total)} outstanding · ${buckets.length} customers`,
    href: '/accounting/debtors-manager',
  };
}

async function buildPurchasesCard(companyId: string, periodEnd: string): Promise<WorkbenchCard> {
  const buckets = await getAPAging(companyId, periodEnd);
  const { total, overdue } = sumAging(buckets);
  const status: CardStatus = overdue > 0 ? 'attention' : total > 0 ? 'in_progress' : 'ready';
  return {
    id: 'purchases',
    title: 'Supplier Bills & Payments',
    status,
    primary: `${fmtR(overdue)} overdue`,
    secondary: `${fmtR(total)} outstanding · ${buckets.length} suppliers`,
    href: '/accounting/ap-aging',
  };
}

async function buildVatCard(companyId: string, periodStart: string, periodEnd: string): Promise<WorkbenchCard> {
  const rows = (await sql`
    SELECT status, net_vat
    FROM vat_returns
    WHERE company_id = ${companyId}::uuid
      AND period_end >= ${periodStart}::date
      AND period_start <= ${periodEnd}::date
    ORDER BY period_end DESC
    LIMIT 1
  `) as DbRow[];
  if (rows.length === 0) {
    return {
      id: 'vat',
      title: 'VAT Readiness',
      status: 'not_started',
      primary: 'No return drafted',
      secondary: 'Period awaits preparation',
      href: '/accounting/reports/vat-201',
    };
  }
  const r = rows[0]!;
  const status: CardStatus = r.status === 'submitted' ? 'ready' : 'in_progress';
  const netVat = Number(r.net_vat) || 0;
  return {
    id: 'vat',
    title: 'VAT Readiness',
    status,
    primary: `${fmtR(Math.abs(netVat))} ${netVat >= 0 ? 'payable' : 'refund'}`,
    secondary: String(r.status ?? 'draft'),
    href: '/accounting/reports/vat-201',
  };
}

async function buildPayrollCard(companyId: string, period: string): Promise<WorkbenchCard> {
  const [year, month] = period.split('-').map(Number) as [number, number];
  const runs = await listPayrollRuns(companyId);
  const thisRun = runs.find(r => r.periodYear === year && r.periodMonth === month);
  if (!thisRun) {
    return {
      id: 'payroll',
      title: 'Payroll Run',
      status: 'not_started',
      primary: 'No run for period',
      secondary: 'Create payroll run to start',
      href: '/payroll/runs',
    };
  }
  const status: CardStatus = thisRun.status === 'approved' ? 'ready' : 'in_progress';
  return {
    id: 'payroll',
    title: 'Payroll Run',
    status,
    primary: `${fmtR(Number(thisRun.totalGross) || 0)} gross`,
    secondary: `${thisRun.employeeCount} employees · ${thisRun.status}`,
    href: '/payroll/runs',
  };
}

async function buildAfsCard(companyId: string, period: string): Promise<WorkbenchCard> {
  const docs = await listAfsDocuments(companyId);
  const [year] = period.split('-').map(Number) as [number];
  const thisDoc = docs.find(d => d.fiscalYear === year);
  if (!thisDoc) {
    return {
      id: 'afs',
      title: 'Management Pack / AFS',
      status: 'not_started',
      primary: 'No pack for FY',
      secondary: 'Create AFS document',
      href: '/accounting/afs',
    };
  }
  const sectionRows = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'auto_generated' AND content IS NOT NULL) AS populated,
      COUNT(*) AS total
    FROM afs_sections WHERE document_id = ${thisDoc.id}::uuid
  `) as DbRow[];
  const populated = Number(sectionRows[0]?.populated) || 0;
  const total = Number(sectionRows[0]?.total) || 0;
  const status: CardStatus =
    thisDoc.status === 'filed' || thisDoc.status === 'signed_off' ? 'ready' :
    populated > 0 ? 'in_progress' : 'not_started';
  return {
    id: 'afs',
    title: 'Management Pack / AFS',
    status,
    primary: `${populated}/${total} sections ready`,
    secondary: String(thisDoc.status),
    href: '/accounting/afs',
  };
}

async function buildExceptionsCard(companyId: string, periodEnd: string): Promise<WorkbenchCard> {
  const rows = (await sql`
    SELECT
      (SELECT COUNT(*) FROM customer_invoices WHERE company_id = ${companyId}::uuid AND status = 'draft') AS draft_invoices,
      (SELECT COUNT(*) FROM supplier_invoices WHERE company_id = ${companyId}::uuid AND status = 'draft') AS draft_bills,
      (SELECT COUNT(*) FROM bank_transactions WHERE company_id = ${companyId}::uuid AND status = 'imported' AND transaction_date <= ${periodEnd}::date AND suggested_gl_account_id IS NULL) AS unsuggested
  `) as DbRow[];
  const r = rows[0]!;
  const draftInv = Number(r.draft_invoices) || 0;
  const draftBills = Number(r.draft_bills) || 0;
  const unsugg = Number(r.unsuggested) || 0;
  const totalExceptions = draftInv + draftBills + unsugg;
  const status: CardStatus = totalExceptions === 0 ? 'ready' : totalExceptions < 10 ? 'in_progress' : 'attention';
  return {
    id: 'exceptions',
    title: 'Exceptions',
    status,
    primary: `${totalExceptions} items`,
    secondary: `${draftInv} draft invoices · ${draftBills} draft bills · ${unsugg} unclassified bank txns`,
    count: totalExceptions,
  };
}

async function buildReviewCard(companyId: string, period: string): Promise<WorkbenchCard> {
  const rows = (await sql`
    SELECT status
    FROM fiscal_periods
    WHERE company_id = ${companyId}::uuid
      AND start_date::text LIKE ${period + '%'}
    LIMIT 1
  `) as DbRow[];
  const status = rows[0]?.status ? String(rows[0].status) : null;
  const closed = status === 'closed' || status === 'locked';
  return {
    id: 'review',
    title: 'Review & Sign-off',
    status: closed ? 'ready' : 'in_progress',
    primary: closed ? 'Period closed' : 'Awaiting review',
    secondary: closed ? `Status: ${status}` : status ? `Status: ${status}` : 'Reviewer to confirm and close',
    href: '/accounting/period-management',
  };
}

async function buildTrialBalance(companyId: string, periodEnd: string): Promise<{ balanced: boolean; diff: number }> {
  const rows = (await sql`
    SELECT
      COALESCE(SUM(gjl.debit), 0) AS dr,
      COALESCE(SUM(gjl.credit), 0) AS cr
    FROM gl_journal_lines gjl
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
    WHERE gje.company_id = ${companyId}::uuid
      AND gje.status = 'posted'
      AND gje.entry_date <= ${periodEnd}::date
  `) as DbRow[];
  const dr = Number(rows[0]?.dr) || 0;
  const cr = Number(rows[0]?.cr) || 0;
  const diff = Math.round((dr - cr) * 100) / 100;
  return { balanced: Math.abs(diff) < 0.01, diff };
}

export async function getMonthEndWorkbench(
  companyId: string,
  period: string,
): Promise<MonthEndWorkbench> {
  const { start, end } = parsePeriod(period);

  const [banking, sales, purchases, vat, payroll, afs, exceptions, review, tb] = await Promise.all([
    buildBankingCard(companyId, end),
    buildSalesCard(companyId, end),
    buildPurchasesCard(companyId, end),
    buildVatCard(companyId, start, end),
    buildPayrollCard(companyId, period),
    buildAfsCard(companyId, period),
    buildExceptionsCard(companyId, end),
    buildReviewCard(companyId, period),
    buildTrialBalance(companyId, end),
  ]);

  return {
    companyId,
    period,
    periodStart: start,
    periodEnd: end,
    generatedAt: new Date().toISOString(),
    cards: [banking, sales, purchases, vat, payroll, afs, exceptions, review],
    trialBalanceBalanced: tb.balanced,
    trialBalanceDiff: tb.diff,
  };
}
