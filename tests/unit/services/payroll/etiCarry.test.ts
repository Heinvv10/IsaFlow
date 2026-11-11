/**
 * ETI carry-forward on the EMP201 (master plan wave 5, ET). Sources: ETI Act s9(1), s10(1) and s10(3); SARS Guide to the
 * Employment Tax Incentive, Issue 5 (27 July 2026), §6.1 p. 42, §7 pp. 46-47 (Example 19), §8 p. 48.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/payroll/directivePaymentFiling', () => ({
  listStandaloneDirectivePayments: vi.fn(async () => []),
}));
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sql } from '@/lib/neon';
import { listStandaloneDirectivePayments } from '@/modules/accounting/services/payroll/directivePaymentFiling';
import {
  etiCarryLedger, reconciliationStart, summariseCarry,
} from '@/modules/accounting/services/payroll/etiCarry';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';

const CO = '11111111-1111-1111-1111-111111111111';

describe('the ledger, on hand-written headers', () => {
  it('guide Example 19: R33 000 ETI against R25 000 PAYE carries R8 000 into the next month', () => {
    const l = etiCarryLedger({ year: 2025, month: 4 }, { year: 2025, month: 5 }, [
      { year: 2025, month: 4, paye: 25_000, eti: 33_000 },
    ]);
    expect(l.map((m) => [m.month, m.broughtForward, m.used, m.carriedForward])).toEqual([
      [3, 0, 0, 0], [4, 0, 25_000, 8_000], [5, 8_000, 0, 8_000],
    ]);
  });

  it('three months: an excess is brought forward, used against the next PAYE, and the rest carried on', () => {
    const l = etiCarryLedger({ year: 2026, month: 4 }, { year: 2026, month: 6 }, [
      { year: 2026, month: 4, paye: 1_000, eti: 3_000 },
      { year: 2026, month: 5, paye: 1_200.5, eti: 500 },
      { year: 2026, month: 5, paye: 300, eti: 0 }, // a second run in May
      { year: 2026, month: 6, paye: 5_000, eti: 1_000 },
    ]).filter((m) => m.month >= 4);
    expect(l.map((m) => [m.broughtForward, m.available, m.used, m.carriedForward])).toEqual([
      [0, 3_000, 1_000, 2_000],
      [2_000, 2_500, 1_500.5, 999.5],
      [999.5, 1_999.5, 1_999.5, 0],
    ]);
  });

  it('the excess at the end of August (or February) is claimable as a refund and is not carried into September (s10(3))', () => {
    const l = etiCarryLedger({ year: 2026, month: 8 }, { year: 2026, month: 9 }, [
      { year: 2026, month: 8, paye: 100, eti: 1_500 },
      { year: 2026, month: 9, paye: 2_000, eti: 0 },
    ]);
    const aug = l.find((m) => m.month === 8)!;
    const sep = l.find((m) => m.month === 9)!;
    expect([aug.carriedForward, aug.refundClaimable]).toEqual([1_400, 1_400]);
    expect([sep.broughtForward, sep.used]).toEqual([0, 0]);
  });

  it('February: the excess at the end of the September-February period is the refund claimable, and March starts at nil', () => {
    const l = etiCarryLedger({ year: 2026, month: 1 }, { year: 2026, month: 3 }, [
      { year: 2025, month: 12, paye: 0, eti: 700 },
      { year: 2026, month: 1, paye: 200, eti: 500 },
    ]);
    const feb = l.find((m) => m.month === 2)!;
    expect([feb.broughtForward, feb.carriedForward, feb.refundClaimable]).toEqual([1_000, 1_000, 1_000]);
    expect(l.find((m) => m.month === 3)!.broughtForward).toBe(0);
  });

  it('a month with negative PAYE (a refund through payroll) uses no ETI and carries it all', () => {
    const l = etiCarryLedger({ year: 2026, month: 4 }, { year: 2026, month: 4 }, [{ year: 2026, month: 4, paye: -300, eti: 500 }]);
    expect(l.find((m) => m.month === 4)).toMatchObject({ used: 0, carriedForward: 500 });
  });

  it('the reconciliation period starts in March or September; January and February belong to the previous September', () => {
    expect(reconciliationStart({ year: 2026, month: 1 })).toEqual({ year: 2025, month: 9 });
    expect(reconciliationStart({ year: 2026, month: 2 })).toEqual({ year: 2025, month: 9 });
    expect(reconciliationStart({ year: 2026, month: 3 })).toEqual({ year: 2026, month: 3 });
    expect(reconciliationStart({ year: 2026, month: 8 })).toEqual({ year: 2026, month: 3 });
    expect(reconciliationStart({ year: 2026, month: 12 })).toEqual({ year: 2026, month: 9 });
  });

  it('a range summary: brought forward into its first month, used in it, carried out of its last', () => {
    const l = etiCarryLedger({ year: 2026, month: 5 }, { year: 2026, month: 6 }, [
      { year: 2026, month: 4, paye: 1_000, eti: 3_000 },
      { year: 2026, month: 5, paye: 500, eti: 0 },
      { year: 2026, month: 6, paye: 200, eti: 0 },
    ]);
    expect(summariseCarry(l, { year: 2026, month: 5 })).toEqual({ broughtForward: 2_000, used: 700, carriedForward: 1_300, refundClaimable: 0 });
  });
});

describe('generateEMP201 uses the carry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a month with no run and no directive still shows the carry, and February\'s refund (ledger-breaker C)', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([{ table_name: 'payroll_run_headers' }, { table_name: 'payroll_run_lines' }] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([{ period_year: 2026, period_month: 1, paye: 0, eti: 1_000, status: 'approved' }] as never)
      .mockResolvedValueOnce([] as never) // February's run header: none, so nothing booked by a run journal
      .mockResolvedValueOnce([{ used: 0, refund: 0 }] as never); // February's ETI journals: none
    const feb = await generateEMP201(CO, '2026-02-01', '2026-02-28');
    expect(feb.etiCarry).toEqual({ broughtForward: 1_000, used: 0, carriedForward: 1_000, refundClaimable: 1_000 });
    expect(feb.payePayable).toBe(0);
    // Review L3: the refund nobody has booked is named.
    expect(feb.etiWarnings).toEqual([expect.stringMatching(/^ETI refund R.1.000\.00 claimable for September 2025–February 2026 is not booked: no February 2026 payroll journal/)]);
  });

  it('June: May\'s excess (from earlier headers and a directive) reduces June\'s PAYE payable', async () => {
    vi.mocked(sql)
      .mockResolvedValueOnce([{ table_name: 'payroll_run_headers' }, { table_name: 'payroll_run_lines' }] as never)
      .mockResolvedValueOnce([{ id: 'jun', period_month: 6, period_year: 2026, employee_count: 2, total_gross: 20_000,
        total_paye: 3_000, total_uif: 400, total_sdl: 200, total_eti: 500, non_cash: 0, employee_ids: ['a'] }] as never)
      // the earlier months of the period (March-May): May's ETI exceeds its PAYE by R1 800 less the directive's R300
      .mockResolvedValueOnce([{ period_year: 2026, period_month: 5, paye: 200, eti: 2_000, status: 'paid' }] as never);
    vi.mocked(listStandaloneDirectivePayments)
      .mockResolvedValueOnce([]) // June's own directives
      .mockResolvedValueOnce([{ paymentDate: '2026-05-20', paye: 300 } as never]);
    const res = await generateEMP201(CO, '2026-06-01', '2026-06-30');
    expect(res.etiCarry).toEqual({ broughtForward: 1_500, used: 2_000, carriedForward: 0, refundClaimable: 0 });
    expect(res.totalETI).toBe(500);
    expect(res.payePayable).toBe(1_000);
    expect(res.totalDeductions).toBe(1_600);
    const earlier = vi.mocked(sql).mock.calls[2]!;
    expect((earlier[0] as TemplateStringsArray).join('?')).toContain('company_id = ?::uuid');
    expect(earlier.slice(1)).toContain(CO);
    expect(vi.mocked(listStandaloneDirectivePayments).mock.calls[1]).toEqual([CO, { start: '2026-03-01', end: '2026-05-31' }]);
  });
});
