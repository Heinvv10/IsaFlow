/**
 * Loan repayments for the forecast (ruling 2026-11-16; review L1, L2, L6). Each ACTIVE loan's schedule
 * (`previewSchedule`, loans/loanScheduleService.ts — it writes nothing): instalment + lump sum, less what
 * `loan_payments` already settled (loanPlan.ts). Each loan in its own savepoint: a loan the database cannot
 * read, or one the schedule refuses (not found, an empty rate curve, more skips than repayments), is that
 * loan's `source_unavailable` warning and the others go on.
 *
 * A loan in a currency other than the company's functional currency has no stored exchange rate (`loans`
 * carries a currency and nothing to convert it with), so it is left out and warned `currency_not_converted`.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { previewSchedule } from '@/modules/accounting/services/loans/loanScheduleService';
import { guardedSource, refusalOf } from './guardedSource';
import { toCents } from './lines';
import { loanDue } from './loanPlan';
import type { ForecastWarning, KnownItem } from './types';

/** What previewSchedule / amortise throw for a loan they refuse (loanScheduleService.ts, lib/amortisation). */
export const LOAN_REFUSALS = refusalOf([], [/^Loan \S+ not found$/, /^Rate curve is empty$/, /^Loan skips more periods than it repays/]);

async function payments(companyId: string, loanId: string) {
  const rows = (await sql`
    SELECT period_number, payment_date, amount FROM loan_payments
    WHERE company_id = ${companyId}::UUID AND loan_id = ${loanId}::UUID
    ORDER BY payment_date, id
  `) as DbRow[];
  return rows.map((r) => ({ periodNumber: r.period_number == null ? null : Number(r.period_number), date: fmtDate(r.payment_date), cents: toCents(String(r.amount)) }));
}

export async function loanItems(companyId: string, today: string, horizonEnd: string, warnings: ForecastWarning[]): Promise<KnownItem[]> {
  const loans = (await sql`
    SELECT l.id, COALESCE(NULLIF(l.description, ''), NULLIF(l.reference, ''), l.product, 'Loan') AS label, l.principal,
           NULLIF(upper(btrim(l.currency)), '') AS currency, co.functional_currency
    FROM loans l JOIN companies co ON co.id = l.company_id
    WHERE l.company_id = ${companyId}::UUID AND l.status = 'active'
    ORDER BY l.id
  `) as DbRow[];
  const items: KnownItem[] = [];
  const unrecorded: string[] = [];
  const foreign: string[] = [];
  for (const loan of loans) {
    const id = String(loan.id);
    const label = String(loan.label);
    if (loan.currency !== null && loan.currency !== loan.functional_currency) {
      foreign.push(`${label} (${String(loan.currency)} ${String(loan.principal)})`);
      continue;
    }
    const plan = await guardedSource('cash13_loan', `loan ${label}`, warnings, async () => {
      const rows = (await previewSchedule(companyId, id)).map((r) => ({ period: r.period, date: r.date, cents: toCents(r.payment) + toCents(r.lump) }));
      return loanDue(rows, await payments(companyId, id), today, horizonEnd);
    }, LOAN_REFUSALS);
    if (!plan) continue;
    if (plan.noPayments) unrecorded.push(label);
    for (const d of plan.due) {
      items.push({
        lineKey: `loan:${id}`, lineLabel: `Loan repayment: ${label}`, category: 'loans', date: d.date, amountCents: -d.cents,
        ref: `${id}:${d.period}`, refLabel: `Instalment ${d.period}`, ...(d.overdue ? { flags: ['loan_overdue'] } : {}),
      });
    }
  }
  if (unrecorded.length > 0) {
    warnings.push({ code: 'loan_payments_not_recorded', source: 'loans', message: `No loan payments recorded for ${unrecorded.join(', ')}: instalments before today are assumed paid` });
  }
  if (foreign.length > 0) {
    warnings.push({ code: 'currency_not_converted', source: 'loans', message: `Loans in another currency have no stored exchange rate and are left out: ${foreign.join('; ')}` });
  }
  return items;
}
