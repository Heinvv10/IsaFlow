/**
 * Wave 6 PSP-H: the nature-of-person H certificate record (SARS PAYE Employer Reconciliation BRS V25.3.0): 3020 H (p. 17),
 * 3030 the trading name and never 3040 / 3050 / 3060 / 3080 (pp. 20-26), 3065 1 or 2 with 3066 (pp. 23-24), 3100 (pp. 26-27),
 * 3170 / 3180 (pp. 31-32), 3200 / 3210 (p. 32), 3601 (G21 p. 31), 4102, 4141 nil, 4142.
 */
import { describe, expect, it } from 'vitest';
import { buildPspCertificateRecord, type PspCertificateInput } from '@/modules/accounting/services/payroll/easyFilePspCertificate';
import { pspFilingWarning } from '@/modules/accounting/services/payroll/pspFiling';

const base: PspCertificateInput = {
  employeeId: 'e1', certificateNumber: '712345678920270200000000000003', yearOfAssessment: 2027, entityType: 'company',
  tradingName: 'Acme Consulting (Pty) Ltd', registrationNumber: '2015/123456/07', taxReference: '9012345678',
  periodStart: '20260301', periodEnd: '20260430', payPeriods: 12, periodsWorked: 2, directiveNumbers: [],
  gross3601: 80_000, paye4102: 21_600, uif4141: 0, sdl4142: 800,
};
const fields = (r: string[]) => new Map(r.map((l) => [l.slice(0, l.indexOf(',')), l.slice(l.indexOf(',') + 1)]));

describe('buildPspCertificateRecord', () => {
  it('a PSP company: H, the trading name, 3065 = 1 with its number, 3100, the period, 3601 / 4102 / nil 4141 / 4142', () => {
    const f = fields(buildPspCertificateRecord(base));
    expect([f.get('3015'), f.get('3020'), f.get('3030'), f.get('3065'), f.get('3066'), f.get('3100')])
      .toEqual(['"IRP5"', '"H"', '"Acme Consulting (Pty) Ltd"', '1', '"2015/123456/07"', '9012345678']);
    expect([f.get('3170'), f.get('3180'), f.get('3200'), f.get('3210')]).toEqual(['20260301', '20260430', '12.0000', '2.0000']);
    expect([f.get('3601'), f.get('4102'), f.get('4141'), f.get('4142')]).toEqual(['80000', '21600.00', '0.00', '800.00']);
  });

  it('never a natural person\'s fields: no 3040, 3050, 3060, 3080', () => {
    const f = fields(buildPspCertificateRecord(base));
    expect(['3040', '3050', '3060', '3080'].filter((c) => f.has(c))).toEqual([]);
  });

  it('a trust: 3065 = 2; no registration number: no 3065 or 3066; a directive: 3230', () => {
    expect(fields(buildPspCertificateRecord({ ...base, entityType: 'trust', registrationNumber: 'IT1234/2019' })).get('3065')).toBe('2');
    const f = fields(buildPspCertificateRecord({ ...base, registrationNumber: null, directiveNumbers: ['1234567890'] }));
    expect([f.has('3065'), f.has('3066'), f.get('3230')]).toEqual([false, false, '"1234567890"']);
  });

  it('no PAYE: refused by name (an IRP5 needs PAYE; no IT3(a) reason for a PSP)', () => {
    expect(() => buildPspCertificateRecord({ ...base, paye4102: 0 })).toThrow(/Acme Consulting.*no PAYE/);
  });
});

describe('pspFilingWarning (PSP-H wording)', () => {
  const t = { employeeId: 'e1', employeeNumber: 'P1', name: 'Pat Doe', gross: 40_000, paye: 10_800, sdl: 400, alsoEmployee: false };
  it('certified: names the entity\'s own H certificate in the e@syFile file', () => {
    const w = pspFilingWarning({ ...t, certifiedAs: 'Acme (Pty) Ltd' }, 'IRP5 dataset');
    expect(w).toContain('It is on Acme (Pty) Ltd\'s own certificate in the e@syFile file: nature of person H');
    expect(w).not.toContain('no certificate');
  });
  it('without particulars: on no certificate, and says to add them', () => {
    const w = pspFilingWarning({ ...t, certifiedAs: null }, 'IRP5 dataset');
    expect(w).toContain('It is on no certificate');
    expect(w).toContain('Add them on the employee\'s Work card');
  });
});
