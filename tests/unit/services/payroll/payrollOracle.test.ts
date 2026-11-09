/**
 * Payroll oracle (wave-4 spec §4 O): every case in tests/fixtures/payroll-oracle is costed by the
 * pure calculatePayrollLine and compared to the cent with figures from an outside source
 * (Sage, SimplePay, a SARS guide or rate table, a client register), never from the engine itself.
 *
 * knownGaps.json is a ratchet, never a mask. Per case (caseProblems):
 * - a case not on the list must match every asserted field (only a documented tolerance of at
 *   most 5c, with its reason, is allowed);
 * - a listed case must miss exactly its listed fields, each at exactly its pinned `engineActual`,
 *   so the engine moving inside a known gap is red too;
 * - a listed field that starts matching is red until the entry is removed (the W3 PR that closes
 *   it removes the line in the same commit).
 *
 * Gate for W3 (spec §4 O exit rule): W3 PRs stay out until every case not on the gap list
 * passes and Hein has named the tax-table owner (see taxTableHash.test.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  caseProblems, gapListProblems, loadCases, loadKnownGaps,
} from '../../../fixtures/payroll-oracle/oracle';

const cases = loadCases();
const gaps = loadKnownGaps();
const gapFor = (id: string) => gaps.find(g => g.case === id);

/** Every case, pinned: deleting or renaming a fixture is red. */
const EXPECTED_CASE_IDS = [
  'eti-below-minimum-wage-4000',
  'eti-min-wage-1c-below-4606-39',
  'eti-min-wage-exactly-at-minimum-4606-40',
  'eti-year1-120h-5000-apportioned',
  'eti-year1-taper-6000',
  'eti-year2-flat-5000',
  'fb-medical-3810-employer-contribution-taxable',
  'fb-travel-3701-20pct-taxed',
  'fb-travel-3701-80pct-taxed',
  'fb-vehicle-3802-325pct-maintenance-plan-20pct-taxed',
  'fb-vehicle-3802-35pct-80pct-taxed',
  'fixed-amount-directive-2500',
  'fixed-rate-directive-20pct',
  'fixed-rate-directive-20pct-with-ra',
  'g21-annual-bonus-statutory-table',
  'ra-annual-cap-binds-2027',
  'rf-employer-contribution-15pct-rfi-cap-binds-on-total',
  'sage-2027-03-david',
  'sage-2027-03-janneman',
  'sage-2027-03-kesh',
  'sage-2027-03-kesh-bonus-40000',
  'sage-2027-03-kg',
  'sage-2027-03-lungi',
  'sage-2027-03-marco',
  'sage-2027-03-phekis',
  'sage-2027-03-qdk',
  'sage-2027-03-rassie',
  'sage-2027-03-rassie-contractor-setup',
  'sage-2027-03-tabraiz',
  'sage-2027-03-temba',
  'sdl-after-para-2-4-deductions',
  'statutory-2027-bracket-31pct-35000',
  'statutory-2027-bracket-36pct-55000',
  'statutory-2027-bracket-39pct-60000',
  'statutory-2027-bracket-41pct-100000',
  'ts-deemed-standard-tables-not-flat-25pct',
  'ts-non-standard-5h-day-over-394-flat-25pct',
  'ts-non-standard-5h-day-under-394-nil-paye',
  'ts-non-standard-under-5h-day-flat-25pct',
  'ts-standard-below-threshold-nil-paye',
  'uif-ceiling-20000',
];

describe('payroll oracle fixtures', () => {
  it('holds exactly the pinned set of cases', () => {
    expect(cases.map(c => c.id).sort()).toEqual([...EXPECTED_CASE_IDS].sort());
  });

  it('the gap list is well formed: real cases and fields, numeric engineActual, a reason and a closer; UNVERIFIED only on a gap', () => {
    expect(gapListProblems(cases, gaps)).toEqual([]);
  });

  it('#1142 is merged: SDL after para 2(4) deductions is not a known gap; Phekis and David are tolerated rounding, not gaps', () => {
    expect(gaps.map(g => g.case)).not.toContain('sdl-after-para-2-4-deductions');
    expect(gaps.map(g => g.case)).not.toContain('sage-2027-03-phekis');
    expect(gaps.map(g => g.case)).not.toContain('sage-2027-03-david');
  });
});

describe('payroll oracle: calculatePayrollLine against the outside figures, to the cent', () => {
  it.each(cases.map(c => [c.id, c] as const))('%s', (_id, c) => {
    expect(caseProblems(c, gapFor(c.id))).toEqual([]);
  });

  it('the failing set equals knownGaps.json exactly, at the pinned amounts', () => {
    const problems = cases.flatMap(c => caseProblems(c, gapFor(c.id)));
    expect(problems).toEqual([]);
  });
});
