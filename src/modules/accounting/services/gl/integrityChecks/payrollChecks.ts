/**
 * Integrity check: does each month's PAYE payable in the ledger equal the EMP201's, and the ETI refund booked equal the
 * refund claimable (wave 5 ET; Hein rulings R-A, R-C)?
 *
 * The EMP201 side is one ETI ledger over the months (payroll/etiCarry, the EMP201's own: declared runs and directives).
 * The ledger side is tied to the MONTH by link, not by entry date (review round 2 M3), so a replacement journal dated
 * in a later month is still its run's month:
 *  - the month's run journal, through the run header's link, while it is in force: its net 2140 credit (PAYE - the ETI
 *    it booked) and its refund debit (etiBooking.bookedByRunJournal);
 *  - the month's stand-alone directive payments in force: each journal credits 2140 its PAYE;
 *  - the month's ETI journals, by reference ETI-YYYY-MM with their reversals: their 2140 debit and refund debit.
 * A difference means an earlier month of the ETI period changed after a later month was booked, a directive was undone
 * without its ETI, or an August/February with no payroll journal left the refund (s10(1)) unbooked.
 * SCOPE: the twelve months to as_at, and only months that have ended by as_at (review M2: a month still being paid is
 * not judged). A month whose run was calculated before ETI carry-forward (calculation version < 8) is listed in the
 * finding, not counted (review L1).
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { etiCarryLedger, index, reconciliationStart, type YearMonth } from '@/modules/accounting/services/payroll/etiCarry';
import { loadEtiMonths } from '@/modules/accounting/services/payroll/etiCarryRead';
import { bookedEtiJournalsByMonth, bookedRunJournalsByMonth, monthKey } from '@/modules/accounting/services/payroll/etiBooking';
import { listStandaloneDirectivePayments } from '@/modules/accounting/services/payroll/directivePaymentFiling';
import { r2, type IntegrityCheckContext, type IntegrityCheckResult } from './types';

/** The calculation version that first books ETI carry-forward (payrollCalculationVersion; ET). */
export const ETI_CARRY_CALCULATION_VERSION = 8;
const pad = (n: number): string => String(n).padStart(2, '0');
const at = (n: number): YearMonth => ({ year: Math.floor(n / 12), month: (n % 12) + 1 });
const lastOf = (ym: YearMonth): string => new Date(Date.UTC(ym.year, ym.month, 0)).toISOString().slice(0, 10);

export async function payePayableDiffersFromEmp201(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  const asAt = { year: Number(ctx.asAt.slice(0, 4)), month: Number(ctx.asAt.slice(5, 7)) };
  // The last month that has ENDED by as_at.
  const last = lastOf(asAt) <= ctx.asAt ? index(asAt) : index(asAt) - 1;
  const months = Array.from({ length: 12 }, (_, i) => at(last - 11 + i));
  const ledger = etiCarryLedger(months[0]!, months[11]!, await loadEtiMonths(ctx.companyId, reconciliationStart(months[0]!), months[11]!));
  const headers = (await sql`
    SELECT period_year, period_month, calculation_version FROM payroll_run_headers
     WHERE company_id = ${ctx.companyId}::UUID AND journal_entry_id IS NOT NULL
       AND make_date(period_year, period_month, 1) BETWEEN ${`${months[0]!.year}-${pad(months[0]!.month)}-01`}::date
                                                       AND ${`${months[11]!.year}-${pad(months[11]!.month)}-01`}::date
  `) as DbRow[];

  // Review round 3 (rev3 L2): a handful of reads for the twelve months, not five a month.
  const byRun = await bookedRunJournalsByMonth(ctx.companyId, months);
  const byEti = await bookedEtiJournalsByMonth(ctx.companyId, months);
  const directives = await listStandaloneDirectivePayments(ctx.companyId, { start: `${months[0]!.year}-${pad(months[0]!.month)}-01`, end: lastOf(months[11]!) });
  const failing: Array<{ id: string; label: string; amount: number; detail: string }> = [];
  const preEt: string[] = [];
  for (const ym of months) {
    const label = `${ym.year}-${pad(ym.month)}`;
    const line = ledger.find((m) => index(m) === index(ym));
    // adv3 L3: no floor on either side, so a month with negative PAYE compares like for like with its 2140.
    const payable = line ? r2(line.paye - line.used) : 0;
    const claimable = line?.refundClaimable ?? 0;
    const hdr = headers.find((h) => Number(h.period_year) === ym.year && Number(h.period_month) === ym.month);
    const run = byRun.get(monthKey(ym))!;
    const eti = byEti.get(monthKey(ym))!;
    const directivePaye = directives.filter((p) => p.paymentDate.slice(0, 7) === label).reduce((t, p) => t + p.paye, 0);
    const booked2140 = r2(run.net2140 + directivePaye - eti.used);
    const bookedRefund = r2(run.refund + eti.refund);
    const diffs: Array<{ id: string; amount: number; detail: string }> = [];
    if (Math.abs(booked2140 - payable) >= 0.01) {
      diffs.push({ id: label, amount: r2(booked2140 - payable), detail: `2140 from payroll journals ${formatMoney(booked2140)}; EMP201 PAYE payable ${formatMoney(payable)}` });
    }
    if (Math.abs(bookedRefund - claimable) >= 0.01) {
      diffs.push({
        id: `${label}-refund`, amount: r2(bookedRefund - claimable),
        detail: `ETI refund booked ${formatMoney(bookedRefund)}; EMP201 refund claimable ${formatMoney(claimable)}`
          + (bookedRefund === 0 ? ' (no payroll journal posted in the month to book it, or no account holds the ETI refund receivable role)' : ''),
      });
    }
    if (diffs.length === 0) continue;
    if (hdr && (hdr.calculation_version == null || Number(hdr.calculation_version) < ETI_CARRY_CALCULATION_VERSION)) {
      preEt.push(label);
      continue;
    }
    failing.push(...diffs.map((d) => ({ ...d, label })));
  }
  return {
    id: 'paye_payable_differs_from_emp201',
    label: 'PAYE payable or ETI refund in the ledger differs from the EMP201',
    severity: 'high',
    count: failing.length,
    amount: r2(failing.reduce((t, f) => t + Math.abs(f.amount), 0)),
    sample: failing.slice(0, ctx.limit),
    finding: 'Months whose payroll journals credit PAYE payable (2140), or book the ETI refund receivable, by a different amount than the EMP201 declares. '
      + 'Usually an earlier month in the same ETI period changed after a later month was booked (ETI Act s9(1)), a directive payment was '
      + 'undone without its ETI, or an August/February with no payroll journal left the refund (s10(1)) unbooked. '
      + 'An ETI journal (ETI-YYYY-MM) reversed by hand is not rebooked automatically: use "Book ETI for this month" on the EMP201 page '
      + '(or the book_eti_for_month connector tool), or the next approval, reopen, or directive payment or reversal in that half-year or the next books it.'
      + (preEt.length > 0 ? ` Not counted, calculated before ETI carry-forward was booked (calculation version < ${ETI_CARRY_CALCULATION_VERSION}): ${preEt.join(', ')}.` : ''),
  };
}
