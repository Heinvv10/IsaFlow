/**
 * Wave 6 EF: the one SQL fragment for a final pay run, and the two warnings the EMP201/IRP5 name runs with.
 * What the fragment selects is proven on real PG (tests/integration/w6-ef-emp201-finality.int.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { payRunFinalSql, PAY_RUN_FINAL_STATUSES } from '@/modules/accounting/services/payroll/payRunFinalSql';
import { notFinalRunWarning } from '@/modules/accounting/services/payroll/payRunNotFinal';
import { uifSplitMismatchWarning } from '@/modules/accounting/services/reports/emp201LineUif';
import { formatMoney } from '@/lib/money/formatMoney';

describe('payRunFinalSql', () => {
  it('is status approved/paid AND an approval time, on the alias given', () => {
    expect(payRunFinalSql('prh')).toBe(
      "(prh.status IN ('approved', 'paid') AND COALESCE(prh.approved_at, prh.approval_grandfathered_at) IS NOT NULL)");
    expect([...PAY_RUN_FINAL_STATUSES]).toEqual(['approved', 'paid']);
  });

  it.each(['', 'prh.id', 'prh; DROP TABLE x', 'PRH', '1prh', 'prh '])('refuses %j as an alias', (alias) => {
    expect(() => payRunFinalSql(alias)).toThrow(/not a table alias/);
  });
});

describe('notFinalRunWarning', () => {
  it('names the month, the status, why it is left out, the form and the fix', () => {
    const w = notFinalRunWarning({ id: 'r1', month: '2028-10', status: 'approved' }, 'EMP201');
    expect(w).toBe('The approved pay run for 2028-10 has no approval time (approved_at or grandfathered), so it is not '
      + 'final and is not on this EMP201. Reopen it and approve it again.');
  });
});

describe('uifSplitMismatchWarning', () => {
  it('is null when the line split adds up to the header total, to the cent', () => {
    expect(uifSplitMismatchWarning('2028-09', 6_428, { employee: 2_771.2, employer: 3_656.8 })).toBeNull();
    expect(uifSplitMismatchWarning('2028-09', 0.3, { employee: 0.1, employer: 0.2 })).toBeNull();
  });

  it('names the run when they differ by a cent or more', () => {
    const w = uifSplitMismatchWarning('2028-09', 1_200, { employee: 400, employer: 600 });
    expect(w).toContain('2028-09');
    expect(w).toContain(`${formatMoney(1_200)} on its header but ${formatMoney(1_000)} on its lines`);
    expect(uifSplitMismatchWarning('2028-09', 1_000.01, { employee: 400, employer: 600 })).not.toBeNull();
  });
});
