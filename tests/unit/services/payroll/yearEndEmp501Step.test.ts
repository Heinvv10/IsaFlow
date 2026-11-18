/** The year-end checklist's EMP501 step text (review of #1566 round 3, L1). */
import { describe, expect, it } from 'vitest';
import { emp501StepDetail } from '@/components/payroll/yearEndEmp501Step';

const base = { balanced: false, totalEmp201: 30_000, totalIrp5: 19_200, totalVariance: 10_800 };

describe('emp501StepDetail', () => {
  it('a variance wholly explained by PSP PAYE says so and why it cannot be done yet', () => {
    const t = emp501StepDetail({ ...base, pspPaye: 10_800, unexplainedVariance: 0 });
    expect(t.startsWith('Explained by PSP PAYE (')).toBe(true);
    expect(t).toContain('the PSP certificate (PSP-H) is not built yet');
  });
  it('a variance PSP PAYE does not wholly explain is a variance, with the PSP part named', () => {
    const t = emp501StepDetail({ ...base, pspPaye: 5_000, unexplainedVariance: 5_800 });
    expect(t.startsWith('EMP201 ')).toBe(true);
    expect(t).toContain('of which PSP PAYE');
    expect(t).not.toContain('Explained by');
  });
  it('no PSP: the figures alone; withheld PSP figures (a viewer, one payee): the note; no data: the prompt', () => {
    expect(emp501StepDetail({ ...base, totalVariance: 0, balanced: true, totalIrp5: 30_000 }).startsWith('EMP201 ')).toBe(true);
    expect(emp501StepDetail({ ...base, pspNote: 'PSP detail is available to payroll roles' })).toContain('· PSP detail is available to payroll roles');
    expect(emp501StepDetail({ ...base, totalEmp201: 0 })).toBe('No EMP501 data yet — post runs first');
  });
});
