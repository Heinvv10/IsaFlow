/**
 * The 15% check the filing gates (finalise, the lock route, MCP lock_vat_period) judge a VAT201 on: output tax
 * against FIELD 1, the taxed output base after the nil-rated share of a mixed journal is given back to fields 2
 * and 3. The report's own `rateCheck` measures box 1 BEFORE that give-back. The input side and the
 * journals-without-base clause are the report's, unchanged.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ getVatPeriodLines: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/vatBoxBasisQuery', () => ({ getVatPeriodLines: m.getVatPeriodLines }));

import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { rateCheckForFiling } from '@/modules/accounting/services/reports/vat201RateCheck';
import { MIXED_LINES, MIXED_REPORT, NIL_NONE, NIL_ON_TAXED, vatLine } from './helpers/vat201MixedJournal';

const linesAre = (lines: unknown[]) =>
  m.getVatPeriodLines.mockResolvedValue({ lines, postedThrough: '2026-07-31T00:00:00.000Z' });
const report = () => getVat201Report('c1', '2026-07-01', '2026-07-31', { detail: 'summary' });
/** MIXED_REPORT with `onTaxedJournals` rands given back. */
const giveBack = (onTaxedJournals: number) => rateCheckForFiling(MIXED_REPORT, { ...NIL_ON_TAXED, onTaxedJournals });

beforeEach(() => {
  vi.clearAllMocks();
  linesAre(MIXED_LINES);
});

describe('rateCheckForFiling', () => {
  it('the mixed journal: the report fails its check by R75, field 1 (R1 000) ties at 15%', async () => {
    const r = await report();
    // The helper's fixture is what the real report service builds from these lines.
    expect({ boxes: r.boxes, totals: r.totals, rateCheck: r.rateCheck }).toEqual(MIXED_REPORT);
    expect(r.rateCheck.ties).toBe(false);
    expect(rateCheckForFiling(r, NIL_ON_TAXED)).toEqual({ ties: true, outputVariance: 0, inputVariance: 0 });
  });

  it('a variance no nil-rated supply explains still fails, by the report\'s own figure', () => {
    expect(rateCheckForFiling(MIXED_REPORT, NIL_NONE)).toEqual({ ties: false, outputVariance: -75, inputVariance: 0 });
  });

  it('a variance only partly explained still fails, by the unexplained part', () => {
    // field 1 = 1 500 - 300 = 1 200; 15% = 180 against 150 of tax.
    expect(giveBack(300)).toEqual({ ties: false, outputVariance: -30, inputVariance: 0 });
  });

  it('tolerance is the report check\'s: R1.00 either way ties, R1.01 does not', () => {
    // field 1 = 1 006.67 -> implied 151.00 -> variance -1.00.
    expect(giveBack(493.33)).toMatchObject({ ties: true, outputVariance: -1 });
    // field 1 = 1 006.73 -> implied 151.01 -> variance -1.01.
    expect(giveBack(493.27)).toMatchObject({ ties: false, outputVariance: -1.01 });
    // field 1 = 993.33 -> implied 149.00 -> variance +1.00; 993.27 -> 148.99 -> +1.01.
    expect(giveBack(506.67)).toMatchObject({ ties: true, outputVariance: 1 });
    expect(giveBack(506.73)).toMatchObject({ ties: false, outputVariance: 1.01 });
  });

  it('a period with no nil-rated give-back keeps the report\'s variance and verdict exactly', () => {
    const tying = { ...MIXED_REPORT, rateCheck: { ...MIXED_REPORT.rateCheck, outputVariance: 0, ties: true } };
    const plain = {
      ...tying,
      boxes: [{ ...MIXED_REPORT.boxes[0]!, base: 1000, impliedTax: 150, variance: 0 }],
    };
    expect(rateCheckForFiling(plain, NIL_NONE)).toEqual({ ties: true, outputVariance: 0, inputVariance: 0 });
  });

  it('the input side is the report\'s, unchanged: an over-claim fails even when field 1 ties', () => {
    const overclaim = (inputVariance: number) => rateCheckForFiling(
      { ...MIXED_REPORT, rateCheck: { ...MIXED_REPORT.rateCheck, inputVariance } }, NIL_ON_TAXED,
    );
    expect(overclaim(5)).toEqual({ ties: false, outputVariance: 0, inputVariance: 5 });
    expect(overclaim(1)).toEqual({ ties: true, outputVariance: 0, inputVariance: 1 });
  });

  it('a journal carrying tax with no base still fails, as the report\'s check does', () => {
    const baseless = { ...MIXED_REPORT, rateCheck: { ...MIXED_REPORT.rateCheck, entriesWithoutBaseTotal: 1 } };
    expect(rateCheckForFiling(baseless, NIL_ON_TAXED).ties).toBe(false);
  });

  it('judges field 1, so a variance the nil-rated base had masked now fails (tax over-declared on R1 000)', async () => {
    // R195 of output VAT on a journal of R1 000 standard + R300 zero-rated: 15% of the whole R1 300 base, so the
    // report ties, but field 1 is R1 000 and SARS's check on the filed figures is R45 out.
    linesAre([
      vatLine({ lineId: 'l1', accountSubtype: 'receivable', debit: 1495 }),
      vatLine({ lineId: 'l2', accountType: 'revenue', accountSubtype: 'sales', vatType: 'standard', credit: 1000 }),
      vatLine({ lineId: 'l3', accountType: 'revenue', accountSubtype: 'sales', vatType: 'zero_rated', credit: 300 }),
      vatLine({ lineId: 'l4', accountType: 'liability', accountSubtype: 'vat_output', vatType: 'standard', credit: 195 }),
    ]);
    const r = await report();
    expect(r.rateCheck.ties).toBe(true);
    expect(rateCheckForFiling(r, { ...NIL_NONE, zeroRated: 300, onTaxedJournals: 300 }))
      .toEqual({ ties: false, outputVariance: 45, inputVariance: 0 });
  });

  it('field 1 holds no zero-rated box: an export journal posting a R0.00 zero-rated VAT leg is field 2, not variance', async () => {
    // The R0.00 leg coded zero_rated puts the R20 000 in box 2 (getNilRatedSupplies does not count that journal
    // as taxed). The report's check counts box 2's base and reads R3 000 out; field 1 is the R1 000 sale alone.
    linesAre([
      ...MIXED_LINES.filter((l) => l.lineId !== 'l3' && l.lineId !== 'l4').map((l) => (l.lineId === 'l1' ? { ...l, debit: 1150 } : l)),
      vatLine({ journalEntryId: 'j2', lineId: 'e1', accountSubtype: 'receivable', debit: 20000 }),
      vatLine({ journalEntryId: 'j2', lineId: 'e2', accountType: 'revenue', accountSubtype: 'sales', vatType: 'export', credit: 20000 }),
      vatLine({ journalEntryId: 'j2', lineId: 'e3', accountType: 'liability', accountSubtype: 'vat_output', vatType: 'export' }),
    ]);
    const r = await report();
    expect(r.rateCheck).toMatchObject({ outputVariance: -3000, ties: false });
    expect(rateCheckForFiling(r, { ...NIL_NONE, zeroRated: 20000, exported: 20000 }))
      .toEqual({ ties: true, outputVariance: 0, inputVariance: 0 });
  });
});
