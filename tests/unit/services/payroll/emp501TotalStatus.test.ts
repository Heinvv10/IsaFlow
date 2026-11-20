/** The EMP501 reconciliation's Total-row status (review of #1566, coordinator ruling on the Total row). */
import { describe, expect, it } from 'vitest';
import { emp501AllReconciled, emp501TotalStatus } from '@/components/payroll/emp501TotalStatus';

const row = (variance: number, pspPaye?: number) => ({ variance, ...(pspPaye === undefined ? {} : { pspPaye, unexplainedVariance: variance - pspPaye }) });

describe('emp501TotalStatus', () => {
  it('a year whose whole variance is PSP PAYE reads explained_psp, as its rows do', () => {
    expect(emp501TotalStatus([row(0, 0), row(4_050, 4_050), row(0, 0)], 4_050)).toBe('explained_psp');
  });
  it('any variance PSP PAYE does not explain keeps it a variance', () => {
    expect(emp501TotalStatus([row(4_050, 4_050), row(100, 0)], 4_150)).toBe('variance');
    expect(emp501TotalStatus([row(5_000, 4_050)], 5_000)).toBe('variance');
    // Offsetting months: +500 unexplained in one, -500 in another, nil in sum, are still variances.
    expect(emp501TotalStatus([row(4_550, 4_050), row(-500, 0)], 4_050)).toBe('variance');
  });
  it('no PSP PAYE, or no per-row PSP figures (a viewer): variance; nil variance: balanced', () => {
    expect(emp501TotalStatus([row(100, 0)], 100)).toBe('variance');
    expect(emp501TotalStatus([row(4_050)], 4_050)).toBe('variance');
    expect(emp501TotalStatus([row(0, 0)], 0)).toBe('balanced');
  });
});

describe('emp501AllReconciled', () => {
  it('a PSP-explained month is not "all periods reconcile"', () => {
    expect(emp501AllReconciled([{ status: 'balanced' }, { status: 'explained_psp' }])).toBe(false);
    expect(emp501AllReconciled([{ status: 'balanced' }, { status: 'no_data' }])).toBe(true);
    expect(emp501AllReconciled([{ status: 'no_data' }])).toBe(false);
  });
});
