/**
 * The bank-file card's confirmed label (review #1524 D-3): a file confirmed against an earlier approval never reads as
 * a plain "Payment confirmed" while the current approval differs; it names what is still to pay, or the overpayment.
 */
import { describe, expect, it } from 'vitest';
import { confirmedLabel } from '@/components/payroll/SalaryBankFileCard';
import type { PayrollBankFile } from '@/modules/accounting/services/payroll/payrollBankFileStatus';

const file = (differenceCents: number | null): PayrollBankFile => ({
  id: 'f', status: 'confirmed', layout: 'fnb_obe_2023_02', sha256: 'a'.repeat(64), lineCount: 2, totalCents: 1_000_000,
  actionDate: '2099-01-15', createdAt: '2026-11-17T00:00:00Z', confirmedAt: '2026-11-17T01:00:00Z', voidedAt: null, stale: true, differenceCents,
});

describe('confirmedLabel', () => {
  it('is a plain confirmation for the current approval', () => {
    expect(confirmedLabel(file(null))).toBe('Payment confirmed');
  });
  it('names what is still to pay when the current approval pays more', () => {
    expect(confirmedLabel(file(250_050))).toMatch(/^The bank paid R\s?10[\s ]?000\.00 on the earlier approval; R\s?2[\s ]?500\.50 still to pay separately$/);
  });
  it('names the overpayment when it pays less', () => {
    expect(confirmedLabel(file(-12_345))).toMatch(/; R\s?123\.45 overpaid$/);
  });
  it('says nothing more is due when the figures agree', () => {
    expect(confirmedLabel(file(0))).toMatch(/nothing more to pay$/);
  });
});
