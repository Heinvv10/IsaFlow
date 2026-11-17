/**
 * The bank-file card's settlement lines (review #1524 D-3/E-5): a file confirmed against an earlier approval names, per
 * employee and never netted, what is still to pay and what was overpaid. "Overpaid" never stands alone while anyone
 * is owed.
 */
import { describe, expect, it } from 'vitest';
import { settlementLines } from '@/components/payroll/SalaryBankFileCard';
import type { PayrollBankFile } from '@/modules/accounting/services/payroll/payrollBankFileStatus';
import type { FileSettlement } from '@/modules/accounting/services/payroll/payrollBankFileSettlement';

const file = (settlement: FileSettlement | null): PayrollBankFile => ({
  id: 'f', status: 'confirmed', layout: 'fnb_obe_2023_02', sha256: 'a'.repeat(64), lineCount: 2, totalCents: 1_000_000,
  actionDate: '2099-01-15', createdAt: '2026-11-17T00:00:00Z', confirmedAt: '2026-11-17T01:00:00Z', voidedAt: null, stale: true, settlement,
});
const A = { employeeNumber: 'E-1', name: 'Ann A', cents: 370_000 };
const B = { employeeNumber: 'E-2', name: 'Ben B', cents: 405_288 };

describe('settlementLines', () => {
  it('says nothing for a file of the current approval', () => {
    expect(settlementLines(file(null))).toEqual([]);
  });
  it('E-5: one owed and one overpaid are two sentences, never netted to "R352.88 overpaid"', () => {
    const lines = settlementLines(file({ owedCents: 370_000, owedTo: [A], overpaidCents: 405_288, overpaidBy: [B] }));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Still to pay R\s?3[\s ]?700\.00 to 1 employee separately: Ann A \(E-1\)/);
    expect(lines[1]).toMatch(/^Overpaid R\s?4[\s ]?052\.88 by 1 employee: Ben B \(E-2\)/);
    expect(lines.join(' ')).not.toMatch(/352\.88/);
  });
  it('names every employee owed, with the count', () => {
    expect(settlementLines(file({ owedCents: 775_288, owedTo: [A, B], overpaidCents: 0, overpaidBy: [] }))).toEqual([
      expect.stringMatching(/to 2 employees separately: Ann A \(E-1\) .*, Ben B \(E-2\) /),
    ]);
  });
  it('says nothing more is due when every employee was paid their current net', () => {
    expect(settlementLines(file({ owedCents: 0, owedTo: [], overpaidCents: 0, overpaidBy: [] }))).toEqual([
      'Nothing more to pay: every employee was paid their current net.',
    ]);
  });
});
