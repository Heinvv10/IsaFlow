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
import { log } from '@/lib/logger';
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
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (!match) throw new Error(`Invalid period: ${period} (expected YYYY-MM, month 01–12)`);
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
  // Two separate queries — joining bank_transactions to bank_reconciliations
  // would multiply the txn count rows by the number of completed recons per
  // account, so the COUNT(*) FILTER values come out wrong.
  const txnRows = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'imported' AND transaction_date <= ${periodEnd}::date) AS unmatched,
      COUNT(*) FILTER (WHERE matched_journal_line_id IS NOT NULL AND transaction_date <= ${periodEnd}::date) AS matched
    FROM bank_transactions
    WHERE company_id = ${companyId}::uuid
  `) as DbRow[];
  const reconRows = (await sql`
    SELECT MAX(completed_at) AS last_recon_completed_at
    FROM bank_reconciliations
    WHERE company_id = ${companyId}::uuid AND status = 'completed'
  `) as DbRow[];

  const t = txnRows[0]!;
  const unmatched = Number(t.unmatched) || 0;
  const matched = Number(t.matched) || 0;
  const lastReconRaw = reconRows[0]?.last_recon_completed_at;
  const lastRecon = lastReconRaw ? String(lastReconRaw).slice(0, 10) : 'never';
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
  // Match a return whose period is wholly inside the requested month-range,
  // not any return that overlaps it. Bi-monthly tenants will get whichever
  // return covers their canonical period; a tenant on monthly VAT will get
  // the exact month.
  const rows = (await sql`
    SELECT status, net_vat
    FROM vat_returns
    WHERE company_id   = ${companyId}::uuid
      AND period_start >= ${periodStart}::date
      AND period_end   <= ${periodEnd}::date
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
      href: '/accounting/reports/vat-return',
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
    href: '/accounting/reports/vat-return',
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
    FROM afs_sections
    WHERE document_id = ${thisDoc.id}::uuid
      AND company_id  = ${companyId}::uuid
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
      (SELECT COUNT(*) FROM bank_transactions WHERE company_id = ${companyId}::uuid AND status = 'imported' AND transaction_date <= ${periodEnd}::date AND suggested_gl_account_id IS NULL) AS unsuggested,
      (SELECT COUNT(*) FROM gl_journal_entries WHERE company_id = ${companyId}::uuid AND status = 'draft' AND entry_date <= ${periodEnd}::date) AS draft_journals
  `) as DbRow[];
  const r = rows[0]!;
  const draftInv = Number(r.draft_invoices) || 0;
  const draftBills = Number(r.draft_bills) || 0;
  const unsugg = Number(r.unsuggested) || 0;
  // Unposted draft journals are close-blocking exceptions too, so the workbench
  // surfaces them. This is a workbench heuristic (draft, dated up to period end) —
  // NOT byte-for-byte the close run's unpostedJournalsCheck (which keys on
  // fiscal_period_id and status != 'posted'); the per-client close run is authoritative.
  const draftJournals = Number(r.draft_journals) || 0;
  const totalExceptions = draftInv + draftBills + unsugg + draftJournals;
  const status: CardStatus = totalExceptions === 0 ? 'ready' : totalExceptions < 10 ? 'in_progress' : 'attention';
  return {
    id: 'exceptions',
    title: 'Exceptions',
    status,
    primary: `${totalExceptions} items`,
    secondary: `${draftInv} draft invoices · ${draftBills} draft bills · ${unsugg} unclassified bank txns · ${draftJournals} draft journals`,
    count: totalExceptions,
  };
}

async function buildReviewCard(
  companyId: string,
  periodStart: string,
  periodEnd: string,
  period: string,
): Promise<WorkbenchCard> {
  // Range predicate on the indexed start_date column instead of LIKE on a
  // text cast — both faster and not dependent on Postgres's default DATE
  // serialization. periodStart/End come from parsePeriod, not raw user input.
  const rows = (await sql`
    SELECT status
    FROM fiscal_periods
    WHERE company_id = ${companyId}::uuid
      AND start_date >= ${periodStart}::date
      AND start_date <= ${periodEnd}::date
    LIMIT 1
  `) as DbRow[];
  const status = rows[0]?.status ? String(rows[0].status) : null;
  const closed = status === 'closed' || status === 'locked';
  return {
    id: 'review',
    title: 'Review & Sign-off',
    status: closed ? 'ready' : 'in_progress',
    primary: closed ? 'Period closed' : 'Awaiting review',
    secondary: closed ? `Status: ${status} for ${period}` : status ? `Status: ${status}` : 'Reviewer to confirm and close',
    href: '/accounting/fiscal-periods',
  };
}

async function buildTrialBalance(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<{ balanced: boolean; diff: number }> {
  // Period-only check — entries posted strictly inside [periodStart, periodEnd].
  // Cumulative-to-date trivially balances for any consistent ledger and the
  // indicator carries no signal; the reviewer flagged the previous version
  // as a tautology.
  const rows = (await sql`
    SELECT
      COALESCE(SUM(gjl.debit), 0) AS dr,
      COALESCE(SUM(gjl.credit), 0) AS cr
    FROM gl_journal_lines gjl
    JOIN gl_journal_entries gje ON gje.id = gjl.journal_entry_id
    WHERE gje.company_id = ${companyId}::uuid
      AND gje.status     = 'posted'
      AND gje.entry_date >= ${periodStart}::date
      AND gje.entry_date <= ${periodEnd}::date
  `) as DbRow[];
  const dr = Number(rows[0]?.dr) || 0;
  const cr = Number(rows[0]?.cr) || 0;
  const diff = Math.round((dr - cr) * 100) / 100;
  return { balanced: Math.abs(diff) < 0.01, diff };
}

function failedCard(
  id: string,
  title: string,
  err: unknown,
  companyId: string,
  period: string,
): WorkbenchCard {
  // Never surface raw error messages to the tenant — Postgres errors include
  // column/table names that disclose schema. Log server-side with full
  // context, return a generic message to the user.
  log.error('Workbench card failed', { id, title, error: err, companyId, period }, 'workbench');
  return {
    id,
    title,
    status: 'blocked',
    primary: 'Unable to load',
    secondary: 'Card failed to load — check the server logs.',
  };
}

export async function getMonthEndWorkbench(
  companyId: string,
  period: string,
): Promise<MonthEndWorkbench> {
  const { start, end } = parsePeriod(period);

  // Each card runs independently — one broken sub-query (e.g. a missing
  // column after a future migration) must not blank the whole workbench.
  const settled = await Promise.allSettled([
    buildBankingCard(companyId, end),
    buildSalesCard(companyId, end),
    buildPurchasesCard(companyId, end),
    buildVatCard(companyId, start, end),
    buildPayrollCard(companyId, period),
    buildAfsCard(companyId, period),
    buildExceptionsCard(companyId, end),
    buildReviewCard(companyId, start, end, period),
    buildTrialBalance(companyId, start, end),
  ]);

  const cardLabels: ReadonlyArray<{ id: string; title: string }> = [
    { id: 'banking',     title: 'Bank Reconciliation' },
    { id: 'sales',       title: 'Sales & Receivables' },
    { id: 'purchases',   title: 'Supplier Bills & Payments' },
    { id: 'vat',         title: 'VAT Readiness' },
    { id: 'payroll',     title: 'Payroll Run' },
    { id: 'afs',         title: 'Management Pack / AFS' },
    { id: 'exceptions',  title: 'Exceptions' },
    { id: 'review',      title: 'Review & Sign-off' },
  ];
  const cardResults: WorkbenchCard[] = cardLabels.map((label, i) => {
    const r = settled[i]!;
    if (r.status === 'fulfilled') return r.value as WorkbenchCard;
    return failedCard(label.id, label.title, r.reason, companyId, period);
  });

  const tbResult = settled[8]!;
  const tb = tbResult.status === 'fulfilled'
    ? tbResult.value as { balanced: boolean; diff: number }
    : { balanced: false, diff: 0 };

  const banking = cardResults[0]!;
  const sales = cardResults[1]!;
  const purchases = cardResults[2]!;
  const vat = cardResults[3]!;
  const payroll = cardResults[4]!;
  const afs = cardResults[5]!;
  const exceptions = cardResults[6]!;
  const review = cardResults[7]!;

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
