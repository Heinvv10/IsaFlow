/**
 * What an EMP501 filing puts in sars_submissions.form_data (read by roles without payroll-detail access): totals,
 * the warning count and the runs, never a certificate, the employer record or a warning text (wave 6 EFb security H).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: Object.assign(vi.fn(), { unsafe: (t: string) => t }) }));

import { emp501PublicFigures } from '@/modules/accounting/services/returns/emp501Figures';

const figures = {
  taxYear: 2026, kind: 'interim',
  employer: { tradingName: 'Marneweck Holdings', payeReferenceNumber: '7123456789' },
  employees: [{ surname: 'Molefe', firstNames: 'Thandi', idNumber: '9001015009087', taxNumber: '0123456789', grossSalary3601: 360000 }],
  warnings: ['Thandi Molefe: R1 200,00 of PAYE was withheld'],
  totals: { certificates: 1, paye: 54000, uif: 354.24, sdl: 3600 },
  runs: [{ id: 'r1', approvedPlanHash: 'h1', approvedAt: '2025-04-01T10:00:00.000Z' }],
};

describe('emp501PublicFigures', () => {
  it('keeps totals, the warning count and the runs only', () => {
    expect(emp501PublicFigures(figures)).toEqual({
      taxYear: 2026, kind: 'interim', totals: { certificates: 1, paye: 54000, uif: 354.24, sdl: 3600 }, warningCount: 1,
      runs: [{ id: 'r1', approvedPlanHash: 'h1' }],
    });
  });

  it('carries no name, ID, tax number, pay figure or employer detail', () => {
    expect(JSON.stringify(emp501PublicFigures(figures))).not.toMatch(/Molefe|Thandi|9001015009087|0123456789|360000|Marneweck|7123456789/);
  });
});
