/**
 * Payroll oracle, emp201 kind (wave-6 O3): ETI rolled over inside a reconciliation period and refunded at its end, through
 * the pure etiCarryLedger / summariseCarry the EMP201 and the payroll journal read (etiCarry.ts). Figures come from the
 * SARS ETI employer guide (PAYE-GEN-01-G05 Rev 17 s12 p. 8, s14 p. 9), never from the ledger.
 */
import { describe, expect, it } from 'vitest';
import { emp201CaseProblems, loadEmp201Cases, validateEmp201Case } from '../../../fixtures/payroll-oracle/emp201Oracle';

const cases = loadEmp201Cases();

describe('payroll oracle, emp201 kind', () => {
  it('holds exactly the pinned set of cases', () => {
    expect(cases.map(c => c.id).sort()).toEqual(['eti-nothing-brought-into-march', 'eti-refund-at-end-of-february', 'eti-rollover-inside-period']);
  });

  it.each(cases.map(c => [c.id, c] as const))('%s matches its source to the cent', (_id, c) => {
    expect(emp201CaseProblems(c)).toEqual([]);
  });

  it('the guard refuses an unknown key, a missing figure, an UNVERIFIED source and a personal-data key', () => {
    const ok = JSON.parse(JSON.stringify(cases[0])) as Record<string, unknown>;
    const file = `${String(ok.id)}.json`;
    expect(() => validateEmp201Case(ok, file)).not.toThrow();
    expect(() => validateEmp201Case({ ...ok, extra: 1 }, file)).toThrow(/needs exactly id/);
    expect(() => validateEmp201Case({ ...ok, source: 'UNVERIFIED' }, file)).toThrow(/source "UNVERIFIED"/);
    const noFigure = { ...ok, expected: { broughtForward: 0, used: 0, carriedForward: 0 } };
    expect(() => validateEmp201Case(noFigure, file)).toThrow(/expected needs exactly/);
    const pii = { ...ok, input: { ...(ok.input as object), employeeName: 'x' } };
    expect(() => validateEmp201Case(pii, file)).toThrow(/personal data/);
  });
});
