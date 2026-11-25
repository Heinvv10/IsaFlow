/** Wave 7 PP: the one period label, and the file-name token that tells a company's weekly slips apart. */
import { describe, expect, it } from 'vitest';
import { payslipPeriodTitle, payslipPeriodToken, type PeriodFacts } from '@/modules/accounting/services/payroll/payslipPeriod';
import { payslipFilename } from '@/modules/accounting/services/payroll/payslipPdf';
import type { PayslipRun } from '@/modules/accounting/services/payroll/payslipModel';

const monthly: PeriodFacts = { periodMonth: 11, periodYear: 2026, periodStart: null, periodEnd: null, payFrequency: 'monthly', runKind: 'regular', offCycleReason: null };
const week = (start: string, end: string): PeriodFacts => ({ ...monthly, payFrequency: 'weekly', periodStart: start, periodEnd: end });

describe('payslipPeriodTitle', () => {
  it('names each kind', () => {
    expect(payslipPeriodTitle(monthly)).toBe('November 2026');
    expect(payslipPeriodTitle(week('2026-11-16', '2026-11-22'))).toBe('Week 16–22 Nov 2026');
    expect(payslipPeriodTitle({ ...week('2026-12-28', '2027-01-03'), periodMonth: 1, periodYear: 2027 })).toBe('Week 28 Dec 2026 – 3 Jan 2027');
    expect(payslipPeriodTitle({ ...week('2026-11-09', '2026-11-22'), payFrequency: 'fortnightly' })).toBe('Fortnight 9–22 Nov 2026');
    expect(payslipPeriodTitle({ ...monthly, runKind: 'off_cycle', offCycleReason: 'bonus' })).toBe('Bonus, Nov 2026');
    expect(payslipPeriodTitle({ ...monthly, runKind: 'off_cycle', offCycleReason: 'termination' })).toBe('Termination, Nov 2026');
  });

  it('a weekly run with no dates falls back to the month rather than printing nothing', () => {
    expect(payslipPeriodTitle({ ...monthly, payFrequency: 'weekly' })).toBe('November 2026');
  });
});

describe('payslipFilename', () => {
  const name = (f: PeriodFacts) => payslipFilename(f as unknown as PayslipRun, 'E-001');
  it('keeps the monthly name and gives each week and each off-cycle run its own', () => {
    expect(payslipPeriodToken(monthly)).toBe('2026-11');
    expect(name(monthly)).toBe('payslip-2026-11-E-001.pdf');
    expect(name(week('2026-11-09', '2026-11-15'))).toBe('payslip-2026-11-09-E-001.pdf');
    expect(name(week('2026-11-16', '2026-11-22'))).not.toBe(name(week('2026-11-09', '2026-11-15')));
    const bonus = { ...monthly, runKind: 'off_cycle', offCycleReason: 'bonus' };
    expect(name({ ...bonus, runId: 'a1b2c3d4-0000-4000-8000-000000000001' })).toBe('payslip-2026-11-bonus-a1b2c3d4-E-001.pdf');
  });

  it('two bonus runs of one month give different names (L1)', () => {
    const bonus = { ...monthly, runKind: 'off_cycle', offCycleReason: 'bonus' };
    expect(name({ ...bonus, runId: 'a1b2c3d4-0000-4000-8000-000000000001' })).not.toBe(name({ ...bonus, runId: 'e5f6a7b8-0000-4000-8000-000000000002' }));
  });
});
