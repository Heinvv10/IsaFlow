/**
 * One posted sale that mixes VAT types on ONE journal: R1 000 standard-rated, R300 zero-rated and R200 exempt
 * revenue, R150 output VAT, R1 650 to the debtor. `deriveVatBoxes` apportions the journal's whole R1 500 base to
 * box 1 (the nil-rated types take a nil share of the tax), so the report's 15% check reads R75 out; the taxed output base (`field1_standardRatedSupplies`) gives
 * the R500 back (`getNilRatedSupplies().onTaxedJournals`) and is R1 000, exactly 15% of the tax.
 *
 * `MIXED_REPORT` is what `getVat201Report` builds from `MIXED_LINES` (vat201RateCheck.test.ts holds it to that),
 * so the gate tests can mock the report and still be fed a real one.
 */
export function vatLine(over: Record<string, unknown>) {
  return {
    journalEntryId: 'j1', entryNumber: 'J-1', entryDate: '2026-07-10', lineId: 'l1', accountId: 'a1',
    accountCode: '1', accountName: 'x', accountType: 'asset', accountSubtype: null, vatType: null,
    debit: 0, credit: 0, cancelledSource: false, ...over,
  };
}

export const MIXED_LINES = [
  vatLine({ lineId: 'l1', accountId: 'ar', accountType: 'asset', accountSubtype: 'receivable', debit: 1650 }),
  vatLine({ lineId: 'l2', accountId: 'sales', accountType: 'revenue', accountSubtype: 'sales', vatType: 'standard', credit: 1000 }),
  vatLine({ lineId: 'l3', accountId: 'sales', accountType: 'revenue', accountSubtype: 'sales', vatType: 'zero_rated', credit: 300 }),
  vatLine({ lineId: 'l4', accountId: 'sales', accountType: 'revenue', accountSubtype: 'sales', vatType: 'exempt', credit: 200 }),
  vatLine({ lineId: 'l5', accountId: 'vat', accountType: 'liability', accountSubtype: 'vat_output', vatType: 'standard', credit: 150 }),
];

export const MIXED_REPORT = {
  boxes: [{
    box: '1', label: 'Standard rated supplies', direction: 'output' as const, vatType: 'standard',
    base: 1500, tax: 150, impliedTax: 225, variance: -75, lateClaimTax: 0,
  }],
  totals: {
    outputTax: 150, inputTax: 0, netVat: 150, standardRatedSupplies: 1500, standardRatedPurchases: 0, lateClaimInputTax: 0,
  },
  rateCheck: {
    rate: 0.15, outputImpliedTax: 225, outputVariance: -75, inputImpliedTax: 0, inputVariance: 0, ties: false,
    entriesWithoutBase: [] as string[], entriesWithoutBaseTotal: 0,
  },
};

/** The period's nil-rated supplies when the R500 sits on the taxed journal above. */
export const NIL_ON_TAXED = {
  zeroRated: 300, exported: 0, exempt: 200, onTaxedJournals: 500, onTaxedCapital: 0, onTaxedAmbiguous: 0,
  uncodedAssumedZeroRated: 0, uncodedOnTaxedJournals: 0,
};

/** The same report with NO nil-rated supply behind the variance: a genuine R75 under-declaration of tax. */
export const NIL_NONE = { ...NIL_ON_TAXED, zeroRated: 0, exempt: 0, onTaxedJournals: 0 };

/** A period of one plain R1 000 standard-rated sale: the report's check and the taxed output base both tie. */
export const TYING_REPORT = {
  ...MIXED_REPORT,
  boxes: [{ ...MIXED_REPORT.boxes[0]!, base: 1000, impliedTax: 150, variance: 0 }],
  totals: { ...MIXED_REPORT.totals, standardRatedSupplies: 1000 },
  rateCheck: { ...MIXED_REPORT.rateCheck, outputImpliedTax: 150, outputVariance: 0, ties: true },
};
