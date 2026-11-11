/**
 * Integrity check: does each month's PAYE payable in the ledger equal the EMP201's (wave 5 ET, Hein ruling R-A)?
 *
 * Only payroll's own journals write account 2140 (the run journal and a stand-alone directive journal, both source
 * 'auto_payroll'; netPayTargetRules keeps it off net pay). Their net credit for a month is the PAYE payable the
 * books carry for it, and K-079 makes it equal `generateEMP201(...).payePayable`, ETI brought forward included. A
 * difference means an earlier month's run or directive changed after a later month's journal booked its ETI, or a
 * journal was posted by hand: the EMP201 and the ledger then disagree on what is owed to SARS.
 *
 * Also the ETI refund (Hein ruling R-C): in August and February the ETI refund receivable booked by those journals
 * against the EMP201's refund claimable; an August or February with no payroll journal to book it is reported here.
 * SCOPE: the twelve months to as_at. Payments to SARS are not auto_payroll and are left out on purpose; a reversal
 * dated in another month than its original moves both months (reported, as it should be).
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { num, r2, type IntegrityCheckContext, type IntegrityCheckResult } from './types';

const pad = (n: number): string => String(n).padStart(2, '0');

export async function payePayableDiffersFromEmp201(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  // Every month of the twelve to as_at: the net 2140 credit and the ETI refund receivable debit of the posted
  // auto_payroll journals dated in it (run, directive and ETI journals; Hein ruling R-C books the refund).
  const months = (await sql`
    SELECT EXTRACT(YEAR FROM m)::int AS period_year, EXTRACT(MONTH FROM m)::int AS period_month,
           COALESCE((
             SELECT SUM(CASE WHEN ga.account_code = '2140' THEN jl.credit - jl.debit ELSE 0 END)
               FROM gl_journal_lines jl
               JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
               JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
              WHERE jl.company_id = ${ctx.companyId}::UUID AND je.source = 'auto_payroll' AND je.status = 'posted'
                AND je.entry_date >= m AND je.entry_date < m + INTERVAL '1 month' AND je.entry_date <= ${ctx.asAt}::DATE
           ), 0) AS ledger,
           COALESCE((
             SELECT SUM(jl.debit - jl.credit)
               FROM gl_journal_lines jl
               JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
               JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
              WHERE jl.company_id = ${ctx.companyId}::UUID AND je.source = 'auto_payroll' AND je.status = 'posted'
                AND ga.account_subtype = 'eti_refund_receivable'
                AND je.entry_date >= m AND je.entry_date < m + INTERVAL '1 month' AND je.entry_date <= ${ctx.asAt}::DATE
           ), 0) AS refund
      FROM generate_series(date_trunc('month', ${ctx.asAt}::DATE) - INTERVAL '11 months', date_trunc('month', ${ctx.asAt}::DATE), INTERVAL '1 month') AS m
     ORDER BY m
  `) as DbRow[];

  const failing: Array<{ id: string; label: string; amount: number; detail: string }> = [];
  for (const m of months) {
    const year = Number(m.period_year);
    const month = Number(m.period_month);
    const start = `${year}-${pad(month)}-01`;
    const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const emp201 = await generateEMP201(ctx.companyId, start, end);
    const ledger = r2(num(m.ledger));
    const refund = r2(num(m.refund));
    const payeDiff = r2(ledger - emp201.payePayable);
    const refundDiff = r2(refund - emp201.etiCarry.refundClaimable);
    const label = `${year}-${pad(month)}`;
    if (Math.abs(payeDiff) >= 0.01) {
      failing.push({ id: label, label, amount: payeDiff, detail: `2140 from payroll journals ${formatMoney(ledger)}; EMP201 PAYE payable ${formatMoney(emp201.payePayable)}` });
    }
    if (Math.abs(refundDiff) >= 0.01) {
      failing.push({
        id: `${label}-refund`, label, amount: refundDiff,
        detail: `ETI refund booked ${formatMoney(refund)}; EMP201 refund claimable ${formatMoney(emp201.etiCarry.refundClaimable)}`
          + (refund === 0 ? ' (no payroll journal posted in the month to book it, or no account holds the ETI refund receivable role)' : ''),
      });
    }
  }
  return {
    id: 'paye_payable_differs_from_emp201',
    label: 'PAYE payable or ETI refund in the ledger differs from the EMP201',
    severity: 'high',
    count: failing.length,
    amount: r2(failing.reduce((t, f) => t + Math.abs(f.amount), 0)),
    sample: failing.slice(0, ctx.limit),
    finding: 'Months whose payroll journals credit PAYE payable (2140), or book the ETI refund receivable, by a different amount than the EMP201 declares. '
      + 'Usually an earlier month in the same ETI period changed after a later month was posted (ETI Act s9(1)), a directive payment was '
      + 'reversed without its ETI journal, or an August/February with no payroll journal left the refund (s10(1)) unbooked.',
  };
}
