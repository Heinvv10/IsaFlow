/**
 * The 15% check the filing gates (finalise, the lock route, MCP lock_vat_period) judge a VAT201 on: output tax
 * against the TAXED OUTPUT BASE (`field1_standardRatedSupplies`: every taxed output box, after the nil-rated share of
 * a mixed journal is given back to fields 2 and 3). The report's own `rateCheck` measures the base BEFORE that
 * give-back. The input side and the journals-without-base clause are the report's, unchanged.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ getVatPeriodLines: vi.fn() }));
vi.mock('@/modules/accounting/services/reports/vatBoxBasisQuery', () => ({ getVatPeriodLines: m.getVatPeriodLines }));

import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import {
  filedRateVariance, rateCheckFailure, rateCheckForFiling,
} from '@/modules/accounting/services/reports/vat201RateCheck';
import { assembleLedger, evaluateVat201Filability } from '@/modules/accounting/services/reports/vat201LedgerFields';
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
  it('the mixed journal: the report fails its check by R75, the taxed output base (R1 000) ties at 15%', async () => {
    const r = await report();
    // The helper's fixture is what the real report service builds from these lines.
    expect({ boxes: r.boxes, totals: r.totals, rateCheck: r.rateCheck }).toEqual(MIXED_REPORT);
    expect(r.rateCheck.ties).toBe(false);
    expect(rateCheckForFiling(r, NIL_ON_TAXED)).toEqual({
      ties: true, outputVariance: 0, inputVariance: 0, taxedOutputBase: 1000, nilRatedGivenBack: 500, uncodedGivenBack: 0,
    });
  });

  it('a variance no nil-rated supply explains still fails, by the report\'s own figure', () => {
    expect(rateCheckForFiling(MIXED_REPORT, NIL_NONE)).toMatchObject({ ties: false, outputVariance: -75, inputVariance: 0 });
  });

  it('a variance only partly explained still fails, by the unexplained part', () => {
    // taxed base = 1 500 - 300 = 1 200; 15% = 180 against 150 of tax.
    expect(giveBack(300)).toMatchObject({ ties: false, outputVariance: -30, inputVariance: 0 });
  });

  it('tolerance is the report check\'s: R1.00 either way ties, R1.01 does not', () => {
    // taxed base = 1 006.67 -> implied 151.00 -> variance -1.00.
    expect(giveBack(493.33)).toMatchObject({ ties: true, outputVariance: -1 });
    // taxed base = 1 006.73 -> implied 151.01 -> variance -1.01.
    expect(giveBack(493.27)).toMatchObject({ ties: false, outputVariance: -1.01 });
    // taxed base = 993.33 -> implied 149.00 -> variance +1.00; 993.27 -> 148.99 -> +1.01.
    expect(giveBack(506.67)).toMatchObject({ ties: true, outputVariance: 1 });
    expect(giveBack(506.73)).toMatchObject({ ties: false, outputVariance: 1.01 });
  });

  it('a period with no nil-rated give-back keeps the report\'s variance and verdict exactly', () => {
    const tying = { ...MIXED_REPORT, rateCheck: { ...MIXED_REPORT.rateCheck, outputVariance: 0, ties: true } };
    const plain = {
      ...tying,
      boxes: [{ ...MIXED_REPORT.boxes[0]!, base: 1000, impliedTax: 150, variance: 0 }],
    };
    expect(rateCheckForFiling(plain, NIL_NONE)).toMatchObject({ ties: true, outputVariance: 0, inputVariance: 0 });
  });

  it('the input side is the report\'s, unchanged: an over-claim fails even when the taxed output base ties', () => {
    const overclaim = (inputVariance: number) => rateCheckForFiling(
      { ...MIXED_REPORT, rateCheck: { ...MIXED_REPORT.rateCheck, inputVariance } }, NIL_ON_TAXED,
    );
    expect(overclaim(5)).toMatchObject({ ties: false, outputVariance: 0, inputVariance: 5 });
    expect(overclaim(1)).toMatchObject({ ties: true, outputVariance: 0, inputVariance: 1 });
  });

  it('a journal carrying tax with no base still fails, as the report\'s check does', () => {
    const baseless = { ...MIXED_REPORT, rateCheck: { ...MIXED_REPORT.rateCheck, entriesWithoutBaseTotal: 1 } };
    expect(rateCheckForFiling(baseless, NIL_ON_TAXED).ties).toBe(false);
  });

  it('judges the taxed output base, so a variance the nil-rated base had masked now fails (tax over-declared on R1 000)', async () => {
    // R195 of output VAT on a journal of R1 000 standard + R300 zero-rated: 15% of the whole R1 300 base, so the
    // report ties, but the taxed output base is R1 000 and SARS's check on the filed figures is R45 out.
    linesAre([
      vatLine({ lineId: 'l1', accountSubtype: 'receivable', debit: 1495 }),
      vatLine({ lineId: 'l2', accountType: 'revenue', accountSubtype: 'sales', vatType: 'standard', credit: 1000 }),
      vatLine({ lineId: 'l3', accountType: 'revenue', accountSubtype: 'sales', vatType: 'zero_rated', credit: 300 }),
      vatLine({ lineId: 'l4', accountType: 'liability', accountSubtype: 'vat_output', vatType: 'standard', credit: 195 }),
    ]);
    const r = await report();
    expect(r.rateCheck.ties).toBe(true);
    expect(rateCheckForFiling(r, { ...NIL_NONE, zeroRated: 300, onTaxedJournals: 300 }))
      .toMatchObject({ ties: false, outputVariance: 45, inputVariance: 0 });
  });

  it('the taxed output base holds no zero-rated box: an export journal posting a R0.00 zero-rated VAT leg is field 2, not variance', async () => {
    // The R0.00 leg coded zero_rated puts the R20 000 in box 2 (getNilRatedSupplies does not count that journal
    // as taxed). The report's check counts box 2's base and reads R3 000 out; the taxed base is the R1 000 sale alone.
    linesAre([
      ...MIXED_LINES.filter((l) => l.lineId !== 'l3' && l.lineId !== 'l4').map((l) => (l.lineId === 'l1' ? { ...l, debit: 1150 } : l)),
      vatLine({ journalEntryId: 'j2', lineId: 'e1', accountSubtype: 'receivable', debit: 20000 }),
      vatLine({ journalEntryId: 'j2', lineId: 'e2', accountType: 'revenue', accountSubtype: 'sales', vatType: 'export', credit: 20000 }),
      vatLine({ journalEntryId: 'j2', lineId: 'e3', accountType: 'liability', accountSubtype: 'vat_output', vatType: 'export' }),
    ]);
    const r = await report();
    expect(r.rateCheck).toMatchObject({ outputVariance: -3000, ties: false });
    expect(rateCheckForFiling(r, { ...NIL_NONE, zeroRated: 20000, exported: 20000 }))
      .toMatchObject({ ties: true, outputVariance: 0, inputVariance: 0 });
  });
});

describe('rateCheckFailure: what is out, by how much, and what was given back', () => {
  it('names the taxed output base, the variance and the nil-rated supplies excluded from it', () => {
    const msg = rateCheckFailure(giveBack(300));
    expect(msg).toContain('output tax is out by -30.00 against 15% of the taxed output supplies of 1200.00');
    expect(msg).toContain('which exclude 300.00 of zero-rated or exempt supplies on journals that also carry output VAT');
    expect(msg).toContain('input tax is over-claimed by 0.00 (summed per journal)');
    expect(msg).not.toMatch(/box 1|field 1/);
  });

  it('says nothing was given back when nothing was', () => {
    const msg = rateCheckFailure(rateCheckForFiling(MIXED_REPORT, NIL_NONE));
    expect(msg).toContain('output tax is out by -75.00 against 15% of the taxed output supplies of 1500.00,');
    expect(msg).not.toContain('exclude');
  });
});

describe('NAMED LIMIT: the check proves output VAT is 15% of the base CODED taxable, not that the coding is right', () => {
  it('a taxable line miscoded exempt on a journal carrying output VAT ties (master refused it, as it refused every mixed journal)', async () => {
    // R1 000 standard + R1 000 coded exempt (say it is really taxable) + R150 VAT. The report reads 150 - 15% of
    // 2 000 = -150; the give-back removes the exempt 1 000 and 150 is exactly 15% of what is coded standard. No
    // rate arithmetic tells this from a correctly exempt line: the exempt R1 000 is on the return in field 3 and in
    // the give-back a refusal or a forced lock reports. Changing this is a decision, not a fix.
    linesAre([
      vatLine({ lineId: 'l1', accountSubtype: 'receivable', debit: 2150 }),
      vatLine({ lineId: 'l2', accountType: 'revenue', accountSubtype: 'sales', vatType: 'standard', credit: 1000 }),
      vatLine({ lineId: 'l3', accountType: 'revenue', accountSubtype: 'sales', vatType: 'exempt', credit: 1000 }),
      vatLine({ lineId: 'l4', accountType: 'liability', accountSubtype: 'vat_output', vatType: 'standard', credit: 150 }),
    ]);
    const r = await report();
    expect(r.rateCheck).toMatchObject({ outputVariance: -150, ties: false });
    expect(rateCheckForFiling(r, { ...NIL_NONE, exempt: 1000, onTaxedJournals: 1000 }))
      .toMatchObject({ ties: true, outputVariance: 0, taxedOutputBase: 1000, nilRatedGivenBack: 1000 });
  });
});

describe('a legacy invoice with no stored VAT whose journal carries output VAT on uncoded revenue', () => {
  // getNilRatedSupplies treats uncoded revenue on a document with tax_amount NULL/0 as zero-rated, and its journal
  // carries a standard output leg, so the whole R1 000 is given back. The report ties (box 1 is 1 000 at 150).
  const LEGACY = [
    vatLine({ lineId: 'l1', accountSubtype: 'receivable', debit: 1150 }),
    vatLine({ lineId: 'l2', accountType: 'revenue', accountSubtype: 'sales', credit: 1000 }),
    vatLine({ lineId: 'l3', accountType: 'liability', accountSubtype: 'vat_output', vatType: 'standard', credit: 150 }),
  ];
  const NIL_LEGACY = {
    ...NIL_NONE, zeroRated: 1000, onTaxedJournals: 1000, uncodedAssumedZeroRated: 1000, uncodedOnTaxedJournals: 1000,
  };

  it('fails the gates, as the return it files already did (field1_standardRatedSupplies 0, not filable), and says why', async () => {
    linesAre(LEGACY);
    const r = await report();
    expect(r.rateCheck.ties).toBe(true);
    const filing = rateCheckForFiling(r, NIL_LEGACY);
    expect(filing).toMatchObject({ ties: false, outputVariance: 150, taxedOutputBase: 0, uncodedGivenBack: 1000 });
    const ledger = assembleLedger('2026-07-01', '2026-07-31', {
      report: r, nilRated: NIL_LEGACY,
      invoiceDerived: {
        periodStart: '2026-07-01', periodEnd: '2026-07-31', field1_standardRatedSupplies: 0, field2_zeroRatedSupplies: 0,
        field3_exemptSupplies: 0, field4_totalImports: 0, field5_outputVAT: 0, field6_capitalGoods: 0, field7_otherGoods: 0,
        field8_services: 0, field9_imports: 0, field10_totalInputVAT: 0, field11_vatPayableOrRefundable: 0,
        outputInvoices: [], inputInvoices: [], degradedSources: [],
      },
    });
    expect(ledger.field1_standardRatedSupplies).toBe(filing.taxedOutputBase);
    expect(evaluateVat201Filability(ledger).filable).toBe(false);
    expect(rateCheckFailure(filing)).toContain(
      '1000.00 of it is revenue with no VAT code on documents that recorded no VAT, assumed zero-rated',
    );
  });
});

describe('rateCheckFailure when credit notes make the uncoded part exceed the give-back', () => {
  it('states both parts as figures instead of calling the uncoded part a share "of it"', () => {
    // Given back 300 net: 500 of uncoded revenue and -200 of coded exempt (a credit note on a coded line).
    const msg = rateCheckFailure({ ...giveBack(300), uncodedGivenBack: 500 });
    expect(msg).toContain('which exclude 300.00 of zero-rated or exempt supplies');
    expect(msg).toContain('that net figure is 500.00 of revenue with no VAT code on documents that recorded no VAT '
      + '(assumed zero-rated) and -200.00 of coded zero-rated or exempt supplies');
    expect(msg).not.toContain('of it is');
  });

  it('keeps the "of it" phrasing only when 0 < uncoded <= given back', () => {
    expect(rateCheckFailure({ ...giveBack(300), uncodedGivenBack: 300 })).toContain('; 300.00 of it is revenue with no VAT code');
  });
});

describe('filedRateVariance: the materiality bar evaluateVat201Filability blocks on, and the ISV event records', () => {
  const filed = (field5: number, field1: number, inputVariance = 0) => filedRateVariance({
    field1_standardRatedSupplies: field1, field5_outputVAT: field5, field10_totalInputVAT: 0,
    rateCheck: { rate: 0.15, inputVariance },
  });

  it('a small tax: the R1 floor decides (0.90 out is not material, 1.01 is)', () => {
    expect(filed(150.9, 1000)).toEqual({ rateVarianceMaterial: false, outputVariance: 0.9, inputVariance: 0, taxedOutputBase: 1000 });
    expect(filed(151.01, 1000)).toMatchObject({ rateVarianceMaterial: true, outputVariance: 1.01 });
  });

  it('a large tax: 0.5% of it decides (200 out on 150 200 is not material, though the R1 tie-out fails)', () => {
    expect(filed(150200, 1000000)).toMatchObject({ rateVarianceMaterial: false, outputVariance: 200 });
    expect(filed(158000, 1000000)).toMatchObject({ rateVarianceMaterial: true, outputVariance: 8000 });
  });

  it('the input side is judged against the input tax declared', () => {
    expect(filed(150, 1000, 1.5)).toMatchObject({ rateVarianceMaterial: true, inputVariance: 1.5 });
  });
});
