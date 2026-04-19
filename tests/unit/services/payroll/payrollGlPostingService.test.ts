import { describe, it, expect } from 'vitest';
import { buildPayrollJournalLines } from '@/modules/accounting/services/payroll/payrollGlPostingService';
import { PAYROLL_GL_ROLES, type PayrollGlRole } from '@/modules/accounting/services/payroll/payrollGlConfigService';

const MAP: Record<PayrollGlRole, string> = Object.fromEntries(
  PAYROLL_GL_ROLES.map((r, i) => [
    r,
    `gl-${String(i).padStart(4, '0')}aaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`,
  ]),
) as Record<PayrollGlRole, string>;

const BASE = {
  totalGross:       100000,
  totalPaye:         15000,
  totalUif:           2000,
  totalUifEmployee:   1000,
  totalUifEmployer:   1000,
  totalSdl:           1000,
  totalNet:          84000,
};

describe('buildPayrollJournalLines', () => {
  it('produces 7 lines that balance', () => {
    const lines = buildPayrollJournalLines(BASE, MAP, 'Apr 2026');

    expect(lines).toHaveLength(7);

    const totalDr = lines.reduce((sum, l) => sum + l.debit, 0);
    const totalCr = lines.reduce((sum, l) => sum + l.credit, 0);

    // Dr = gross + uif_er + sdl = 100000 + 1000 + 1000 = 102000
    expect(totalDr).toBeCloseTo(102000, 2);
    // Cr = paye + uif_total + sdl + net = 15000 + 2000 + 1000 + 84000 = 102000
    expect(totalCr).toBeCloseTo(102000, 2);
    expect(totalDr).toBeCloseTo(totalCr, 2);
  });

  it('each line debits XOR credits — never both, never neither', () => {
    const lines = buildPayrollJournalLines(BASE, MAP, 'Apr 2026');

    for (const line of lines) {
      const hasDebit  = line.debit  > 0;
      const hasCredit = line.credit > 0;
      // Exactly one side is positive, the other is zero
      expect(hasDebit !== hasCredit).toBe(true);
    }
  });

  it('uses the correct GL account for each role', () => {
    const lines = buildPayrollJournalLines(BASE, MAP, 'Apr 2026');

    // Each line's description starts with the role name
    const roleToLine = Object.fromEntries(
      lines.map((l) => [l.description.split(':')[0], l]),
    );

    for (const role of PAYROLL_GL_ROLES) {
      const line = roleToLine[role];
      expect(line, `Expected a line for role "${role}"`).toBeDefined();
      expect(line!.glAccountId).toBe(MAP[role]);
    }
  });

  it('skips zero-amount lines when total_sdl === 0 → 5 lines', () => {
    const lines = buildPayrollJournalLines({ ...BASE, totalSdl: 0 }, MAP, 'Apr 2026');

    // sdl_employer_expense (Dr) and sdl_payable (Cr) should both be dropped
    expect(lines).toHaveLength(5);

    const descriptions = lines.map((l) => l.description.split(':')[0]);
    expect(descriptions).not.toContain('sdl_employer_expense');
    expect(descriptions).not.toContain('sdl_payable');
  });

  it('rounds amounts to 2dp', () => {
    const lines = buildPayrollJournalLines(
      { ...BASE, totalGross: 100.005 },
      MAP,
      'Apr 2026',
    );

    const salariesLine = lines.find((l) =>
      l.description.startsWith('salaries_expense'),
    );
    expect(salariesLine).toBeDefined();
    // Math.round(100.005 * 100) / 100 = 100.01
    expect(salariesLine!.debit).toBe(100.01);
    // No trailing floating-point noise
    expect(String(salariesLine!.debit)).not.toMatch(/\d{6,}/);
  });
});
