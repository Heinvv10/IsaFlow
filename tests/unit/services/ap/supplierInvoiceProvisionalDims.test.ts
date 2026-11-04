/**
 * Budgets P5-2b (breaker round 2, coordinator's ruling 2026-11-04): the pure matching rule a slip bill's blank draft
 * lines inherit the bank-first provisional's dimensions by, failing closed. Real-PG proof (validation, the draft
 * writers, approve reading stored lines only): tests/integration/budgets-p5-off-slice-provisional*.int.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  matchProvisionalDimensions, type InheritLine, type ProvisionalDimLine,
} from '@/modules/accounting/services/ap/supplierInvoiceProvisionalDims';

const line = (net: number, o: Partial<InheritLine> = {}): InheritLine => ({ account: 'opex', net, blank: true, ...o });
const prov = (net: number, cc1Id: string | null, glAccountId = 'opex'): ProvisionalDimLine => ({ glAccountId, cc1Id, cc2Id: null, buId: null, net });
const cc1 = (r: ReturnType<typeof matchProvisionalDimensions>) => r.map((d) => d?.cc1Id ?? null);

describe('matchProvisionalDimensions', () => {
  it('one candidate whose amount is the blank lines\' sum: every blank line inherits (one line, or two summing to it)', () => {
    expect(cc1(matchProvisionalDimensions([line(800)], [prov(800, 'ft'), prov(120, null, 'vat')]))).toEqual(['ft']);
    expect(cc1(matchProvisionalDimensions([line(500), line(300)], [prov(800, 'ft')]))).toEqual(['ft', 'ft']);
  });
  it('breaker C: a single FT 100 candidate against blank lines of 800 and 50 inherits nothing', () => {
    expect(cc1(matchProvisionalDimensions([line(800), line(50)], [prov(100, 'ft')]))).toEqual([null, null]);
  });
  it('breaker D: FT 400 + FT 400 against an 800 line inherits FT (all candidates agree and the sums match)', () => {
    expect(cc1(matchProvisionalDimensions([line(800)], [prov(400, 'ft'), prov(400, 'ft')]))).toEqual(['ft']);
  });
  it('different candidates: each blank line takes the ONE candidate of its own amount; none or two: nothing', () => {
    expect(cc1(matchProvisionalDimensions([line(500), line(300)], [prov(500, 'ft'), prov(300, 'ht')]))).toEqual(['ft', 'ht']);
    expect(cc1(matchProvisionalDimensions([line(800)], [prov(400, 'ft'), prov(400, 'ht')]))).toEqual([null]);
    expect(cc1(matchProvisionalDimensions([line(500), line(500)], [prov(500, 'ft'), prov(500, 'ht')]))).toEqual([null, null]);
  });
  it('each candidate is taken by one line at most: two blank 400 lines and ONE FT 400 candidate (plus HT 300) inherit nothing', () => {
    expect(cc1(matchProvisionalDimensions([line(400), line(400)], [prov(400, 'ft'), prov(300, 'ht')]))).toEqual([null, null]);
    // A line whose own candidate is unique still inherits beside them.
    expect(cc1(matchProvisionalDimensions([line(400), line(400), line(300)], [prov(400, 'ft'), prov(300, 'ht')]))).toEqual([null, null, 'ht']);
  });
  it('amounts within one cent match; two cents do not', () => {
    expect(cc1(matchProvisionalDimensions([line(300.01), line(223.74)], [prov(300, 'ft'), prov(223.74, 'ht')]))).toEqual(['ft', 'ht']);
    expect(cc1(matchProvisionalDimensions([line(800.02)], [prov(800, 'ft'), prov(1, 'ht')]))).toEqual([null]);
  });
  it('a line naming a dimension is not blank and is never matched; nor counted in the sum', () => {
    expect(cc1(matchProvisionalDimensions([line(500, { blank: false }), line(300)], [prov(300, 'ft')]))).toEqual([null, 'ft']);
  });
  it('another account never matches; a candidate with no dimensions, or a credit, gives nothing', () => {
    expect(cc1(matchProvisionalDimensions([line(800)], [prov(800, 'ft', 'travel')]))).toEqual([null]);
    expect(cc1(matchProvisionalDimensions([line(800)], [prov(800, null)]))).toEqual([null]);
    expect(cc1(matchProvisionalDimensions([line(800)], [prov(-800, 'ft')]))).toEqual([null]);
  });
});
