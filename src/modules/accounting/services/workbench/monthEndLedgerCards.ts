/** The ledger-fed cards of the Month-End workbench: bank, receivables, payables, VAT, payroll. */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';
import { fmtDate } from '@/lib/fmtDate';
import { payRunFinalSql } from '@/modules/accounting/services/payroll/payRunFinalSql';
import { runOrderKeySql } from '@/modules/accounting/services/payroll/payrollRunOrder';
import { getSalesFigures, getPurchasesFigures } from './monthEndSalesFigures';
import type { CardStatus, WorkbenchCard } from './monthEndWorkbenchService';

export function fmtR(n: number): string {
  return formatMoney(n);
}

export async function buildBankingCard(companyId: string, periodEnd: string): Promise<WorkbenchCard> {
  // Two separate queries — joining bank_transactions to bank_reconciliations
  // would multiply the txn count rows by the number of completed recons per
  // account, so the COUNT(*) FILTER values come out wrong.
  const txnRows = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'imported' AND feed_state = 'posted' AND transaction_date <= ${periodEnd}::date) AS unmatched,
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
  const lastRecon = lastReconRaw ? formatDisplayDate(fmtDate(lastReconRaw)) : 'never';
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

export async function buildSalesCard(companyId: string, periodEnd: string): Promise<WorkbenchCard> {
  const { total, overdue, parties, past, asAt } = await getSalesFigures(companyId, periodEnd);
  const status: CardStatus = overdue > total * 0.4 ? 'attention' : overdue > 0 ? 'in_progress' : 'ready';
  return {
    id: 'sales',
    title: 'Sales & Receivables',
    status,
    primary: `${fmtR(overdue)} overdue`,
    secondary: `${fmtR(total)} outstanding · ${parties} customers · as at ${formatDisplayDate(asAt)}`,
    // The aged debtors report is the population this card totals (debtors-manager is not).
    href: past ? `/accounting/ar-aging?as_at_date=${periodEnd}` : '/accounting/ar-aging',
  };
}

export async function buildPurchasesCard(companyId: string, periodEnd: string): Promise<WorkbenchCard> {
  const { total, overdue, parties: suppliers, past, asAt } = await getPurchasesFigures(companyId, periodEnd);
  const status: CardStatus = overdue > 0 ? 'attention' : total > 0 ? 'in_progress' : 'ready';
  return {
    id: 'purchases',
    title: 'Supplier Bills & Payments',
    status,
    primary: `${fmtR(overdue)} overdue`,
    secondary: `${fmtR(total)} outstanding · ${suppliers} suppliers · as at ${formatDisplayDate(asAt)}`,
    href: past ? `/accounting/ap-aging?as_at_date=${periodEnd}` : '/accounting/ap-aging',
  };
}


export async function buildVatCard(companyId: string, periodStart: string, periodEnd: string): Promise<WorkbenchCard> {
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
      href: '/accounting/sars/vat201',
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
    href: '/accounting/sars/vat201',
  };
}

/** A run named by its kind: "regular run", "bonus run", "termination run". */
const runName = (r: DbRow): string => `${r.run_kind === 'off_cycle' ? String(r.off_cycle_reason ?? 'off-cycle') : 'regular'} run`;

/**
 * The month's pay runs, all but cancelled ones (wave 6 FQb2; review #1549 N-L1): a month may hold an off-cycle bonus beside its regular run. The card
 * is ready only when every run is final (payRunFinalSql, the R-035 rule the EMP201 declares by; review #1549 L3), shows
 * their gross together and the people paid across them (review L2), and names the runs not final yet. One run reads as
 * before, except that readiness is finality, so a paid run is ready and an unstamped approved one is not.
 */
export async function buildPayrollCard(companyId: string, period: string): Promise<WorkbenchCard> {
  const [year, month] = period.split('-').map(Number) as [number, number];
  const runs = (await sql`
    SELECT h.status, h.run_kind, h.off_cycle_reason, h.total_gross, ${sql.unsafe(payRunFinalSql('h'))} AS final,
           COUNT(*) OVER () AS runs,
           (SELECT COUNT(DISTINCT l.employee_id) FROM payroll_run_lines l
              JOIN payroll_run_headers m ON m.id = l.run_id
             WHERE m.company_id = ${companyId}::uuid AND m.period_year = ${year}::int AND m.period_month = ${month}::int
               AND m.status <> 'cancelled') AS employees
      FROM payroll_run_headers h
     WHERE h.company_id = ${companyId}::uuid AND h.period_year = ${year}::int AND h.period_month = ${month}::int
       AND h.status <> 'cancelled'
     ORDER BY ${runOrderKeySql('h')}
  `) as DbRow[];
  if (runs.length === 0) {
    return {
      id: 'payroll',
      title: 'Payroll Run',
      status: 'not_started',
      primary: 'No run for period',
      secondary: 'Create payroll run to start',
      href: '/payroll/runs',
    };
  }
  const notFinal = runs.filter(r => r.final !== true);
  const status: CardStatus = notFinal.length === 0 ? 'ready' : 'in_progress';
  const gross = runs.reduce((t, r) => t + (Number(r.total_gross) || 0), 0);
  // People with a line on the month's runs (not the header's employee_count): a run with no lines yet counts 0.
  const employees = Number(runs[0]!.employees) || 0;
  const state = runs.length === 1
    ? String(runs[0]!.status)
    : notFinal.length === 0
      ? `${runs.length} runs, all final`
      : `${notFinal.length} of ${runs.length} runs not final: ${notFinal.map(r => `${runName(r)} (${String(r.status)})`).join(', ')}`;
  return {
    id: 'payroll',
    title: 'Payroll Run',
    status,
    primary: `${fmtR(gross)} gross`,
    secondary: `${employees} employees · ${state}`,
    href: '/payroll/runs',
  };
}
