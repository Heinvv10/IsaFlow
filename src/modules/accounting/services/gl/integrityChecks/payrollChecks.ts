/**
 * Integrity check: does each month's PAYE payable in the ledger equal the EMP201's (wave 5 ET, Hein ruling R-A)?
 *
 * Only payroll's own journals write account 2140 (the run journal and a stand-alone directive journal, both source
 * 'auto_payroll'; netPayTargetRules keeps it off net pay). Their net credit for a month is the PAYE payable the
 * books carry for it, and K-079 makes it equal `generateEMP201(...).payePayable`, ETI brought forward included. A
 * difference means an earlier month's run or directive changed after a later month's journal booked its ETI, or a
 * journal was posted by hand: the EMP201 and the ledger then disagree on what is owed to SARS.
 *
 * SCOPE: the twelve months to as_at that have a posted run journal. Payments to SARS are not auto_payroll and are left
 * out on purpose; a reversal dated in another month than its original moves both months (reported, as it should be).
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { num, r2, type IntegrityCheckContext, type IntegrityCheckResult } from './types';

const pad = (n: number): string => String(n).padStart(2, '0');

export async function payePayableDiffersFromEmp201(ctx: IntegrityCheckContext): Promise<IntegrityCheckResult> {
  const months = (await sql`
    SELECT h.period_year, h.period_month,
           COALESCE((
             SELECT SUM(jl.credit - jl.debit)
               FROM gl_journal_lines jl
               JOIN gl_journal_entries je ON je.id = jl.journal_entry_id AND je.company_id = jl.company_id
               JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
              WHERE jl.company_id = ${ctx.companyId}::UUID
                AND ga.account_code = '2140'
                AND je.source = 'auto_payroll'
                AND je.status = 'posted'
                AND je.entry_date >= make_date(h.period_year, h.period_month, 1)
                AND je.entry_date < make_date(h.period_year, h.period_month, 1) + INTERVAL '1 month'
                AND je.entry_date <= ${ctx.asAt}::DATE
           ), 0) AS ledger
      FROM payroll_run_headers h
     WHERE h.company_id = ${ctx.companyId}::UUID
       AND h.journal_entry_id IS NOT NULL
       AND make_date(h.period_year, h.period_month, 1) <= ${ctx.asAt}::DATE
       AND make_date(h.period_year, h.period_month, 1) > ${ctx.asAt}::DATE - INTERVAL '12 months'
     ORDER BY h.period_year, h.period_month
  `) as DbRow[];

  const failing: Array<{ id: string; label: string; amount: number; detail: string }> = [];
  for (const m of months) {
    const year = Number(m.period_year);
    const month = Number(m.period_month);
    const start = `${year}-${pad(month)}-01`;
    const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    const emp201 = await generateEMP201(ctx.companyId, start, end);
    const ledger = r2(num(m.ledger));
    const diff = r2(ledger - emp201.payePayable);
    if (Math.abs(diff) >= 0.01) {
      failing.push({
        id: `${year}-${pad(month)}`, label: `${year}-${pad(month)}`, amount: diff,
        detail: `2140 from payroll journals ${formatMoney(ledger)}; EMP201 PAYE payable ${formatMoney(emp201.payePayable)}`,
      });
    }
  }
  return {
    id: 'paye_payable_differs_from_emp201',
    label: 'PAYE payable in the ledger differs from the EMP201',
    severity: 'high',
    count: failing.length,
    amount: r2(failing.reduce((t, f) => t + Math.abs(f.amount), 0)),
    sample: failing.slice(0, ctx.limit),
    finding: 'Months whose payroll journals credit PAYE payable (2140) by a different amount than the EMP201 declares as payable. '
      + 'Usually an earlier month in the same ETI period changed after a later month was posted (ETI carried forward, ETI Act s9(1)).',
  };
}
