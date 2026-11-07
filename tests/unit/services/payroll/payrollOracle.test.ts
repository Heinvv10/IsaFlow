/**
 * Payroll oracle (wave-4 spec §4 O): every case in tests/fixtures/payroll-oracle is costed by the
 * pure calculatePayrollLine and compared to the cent with figures from an outside source
 * (Sage, SimplePay, a SARS guide, a client register), never from the engine itself.
 *
 * knownGaps.json is a ratchet, never a mask: the set of (case, field) misses must EQUAL it.
 * - a new miss is red (the engine moved, or a fixture is wrong);
 * - a listed gap that now passes is red until its entry is removed (the W3 PR that closes
 *   it removes the line in the same commit).
 * Only documented rounding is tolerated, per case and field (`tolerance`, with its reason).
 *
 * Gate for W3 (spec §4 O exit rule): W3 PRs stay out until every case not on the gap list
 * passes and Hein has named the tax-table owner (see taxTableHash.test.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  failingFields, loadCases, loadKnownGaps, ORACLE_FIELDS, runCase, type OracleCase,
} from '../../../fixtures/payroll-oracle/oracle';

const cases = loadCases();
const gaps = loadKnownGaps();
const key = (id: string, field: string) => `${id}:${field}`;

describe('payroll oracle fixtures', () => {
  it('holds the seed cases (11 Sage employees, the bonus, UIF ceiling, SDL after deductions, RA cap, directive, ETI)', () => {
    const ids = cases.map(c => c.id);
    expect(ids.filter(id => /^sage-2027-03-[a-z]+$/.test(id))).toHaveLength(11);
    for (const id of [
      'sage-2027-03-kesh-bonus-40000', 'uif-ceiling-20000', 'sdl-after-para-2-4-deductions',
      'ra-annual-cap-binds-2027', 'fixed-rate-directive-20pct', 'eti-year1-taper-6000', 'eti-year2-flat-4000',
    ]) expect(ids).toContain(id);
  });

  it('every known gap names a real case, real fields, a reason and the W3 item or PR that closes it', () => {
    const ids = new Set(cases.map(c => c.id));
    for (const g of gaps) {
      expect(ids.has(g.case), `${g.case} has no fixture`).toBe(true);
      expect(g.fields.length, g.case).toBeGreaterThan(0);
      for (const f of g.fields) expect(ORACLE_FIELDS as readonly string[], `${g.case}.${f}`).toContain(f);
      expect(g.reason.length, g.case).toBeGreaterThan(20);
      expect(g.closedBy.length, g.case).toBeGreaterThan(5);
    }
    expect(new Set(gaps.map(g => g.case)).size, 'one entry per case').toBe(gaps.length);
  });

  it('#1142 is merged: SDL after para 2(4) deductions is not a known gap', () => {
    expect(gaps.map(g => g.case)).not.toContain('sdl-after-para-2-4-deductions');
  });
});

describe('payroll oracle: calculatePayrollLine against the outside figures, to the cent', () => {
  const misses = new Map<string, string>();
  const results = cases.map((c: OracleCase) => {
    const actual = runCase(c);
    for (const f of failingFields(c, actual)) misses.set(key(c.id, f), `${c.id}.${f}: engine ${actual[f]}, ${c.source} ${c.expected[f]}`);
    return { c, actual };
  });

  it('the failing set equals knownGaps.json exactly (a new miss and a closed gap are both red)', () => {
    const listed = new Set(gaps.flatMap(g => g.fields.map(f => key(g.case, f))));
    const newMisses = [...misses.keys()].filter(k => !listed.has(k)).map(k => misses.get(k));
    const nowPassing = [...listed].filter(k => !misses.has(k));
    expect(newMisses, 'new misses (not in knownGaps.json): fix the engine or the fixture').toEqual([]);
    expect(nowPassing, 'listed gaps that now pass: remove them from knownGaps.json').toEqual([]);
  });

  it.each(results.filter(r => !gaps.some(g => g.case === r.c.id)).map(r => [r.c.id, r] as const))(
    '%s matches its source on every asserted field',
    (_id, { c, actual }) => {
      const asserted = Object.fromEntries(Object.keys(c.expected).map(f => [f, actual[f as keyof typeof actual]]));
      expect(failingFields(c, actual), `engine ${JSON.stringify(asserted)} vs ${c.source} ${JSON.stringify(c.expected)}`).toEqual([]);
    },
  );
});
