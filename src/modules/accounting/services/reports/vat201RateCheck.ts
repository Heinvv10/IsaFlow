/**
 * SARS's 15% check, judged on the figures the VAT201 FILES rather than on the report's boxes.
 *
 * WHY THE REPORT'S CHECK IS NOT THE FILING CHECK. `deriveVatBoxes` apportions a journal's whole base pro-rata by
 * tax, so a zero-rated or exempt revenue line on a journal that also carries output VAT lands in box 1 (its type
 * takes a nil share of the tax). `getVat201Report().rateCheck` measures box 1 there. Field 1 gives that share back
 * to fields 2 and 3 (`getNilRatedSupplies().onTaxedJournals`), so the report's check describes a declaration nobody
 * makes: one journal of R1 000 standard + R300 zero-rated + R200 exempt with R150 of VAT reads R75 out, while the
 * return (field 1 = R1 000) is exactly 15%.
 *
 * ONE PLACE. Field 1 (`taxedOutputBase`) and its variance are computed here for the return
 * (`vat201LedgerFields`), the ISV filability decision (`evaluateVat201Filability`) and the three gates that refuse
 * a failing period unless forced (`finaliseVatReturn`, POST /vat-period-locks, MCP `lock_vat_period`), so none of
 * them can judge a figure the others do not file.
 *
 * WHAT `rateCheckForFiling` KEEPS FROM THE REPORT, unchanged: the input variance (the per-journal over-claim, see
 * vatInputOverclaim), the demand that no journal carry tax without a base, and the R1 absolute
 * RATE_CHECK_TOLERANCE. Only the output side moves to field 1, so a variance no nil-rated supply on a taxed
 * journal explains fails as it did. Two consequences of judging field 1, both intended: a box 2/2A/3 base (a
 * journal whose only output leg is nil-coded, e.g. a R0.00 zero-rated leg on an export) is field 2 or 3 and no
 * longer counts against the check; and a variance that the nil-rated base had MASKED (output tax at 15% of the
 * whole mixed base, i.e. over-declared on field 1) now fails.
 *
 * The rate comes off the report, so the check cannot run at a rate the boxes were not derived at.
 */
import type { NilRatedSupplies } from './vat201NilRatedSupplies';
import type { Vat201Report } from './vat201ReportService';
import { RATE_CHECK_TOLERANCE } from './vatBoxTypes';

/** Output boxes whose value is reported in field 2 or field 3, not field 1. */
const NIL_RATED_OUTPUT_BOXES: readonly string[] = ['2', '2A', '3'];

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Field 1 is every TAXED output supply, not only box 1.
 *
 * Boxes 12 (imported services / other output) and `unclassified` (an output VAT
 * type outside the box map) carry tax that field 5 counts. Leaving their base
 * out of field 1 would file output tax with no supply value behind it and break
 * the same 15% relation the return is checked on, so field 1 is every output
 * box except the two nil-rated ones, whose values come from the documents.
 */
export function taxedOutputBase(report: Pick<Vat201Report, 'boxes'>, nilRatedInside: number): number {
  const taxed = report.boxes
    .filter((b) => b.direction === 'output' && !NIL_RATED_OUTPUT_BOXES.includes(b.box))
    .reduce((s, b) => s + b.base, 0);
  // `deriveVatBoxes` apportions a journal's whole base pro-rata by tax, so a
  // nil-rated line sharing a journal with a taxed one lands here. It is
  // declared in field 2 or 3, so field 1 gives it up rather than the same rand
  // being reported in two boxes.
  return r2(taxed - nilRatedInside);
}

/**
 * Output tax less 15% of field 1. The implied tax is rounded to the cent first, as the report rounds its own, so
 * a period with nothing given back reads exactly the report's `outputVariance`.
 */
export function field1OutputVariance(outputTax: number, field1: number, rate: number): number {
  return r2(outputTax - r2(field1 * rate));
}

export interface FilingRateCheck {
  ties: boolean;
  /** Output tax less 15% of field 1 (after the nil-rated give-back). */
  outputVariance: number;
  /** The report's per-journal input over-claim, unchanged. */
  inputVariance: number;
}

/** The verdict the filing gates refuse on (unless forced). Pure. */
export function rateCheckForFiling(
  report: Pick<Vat201Report, 'boxes' | 'totals' | 'rateCheck'>,
  nilRated: Pick<NilRatedSupplies, 'onTaxedJournals'>,
): FilingRateCheck {
  const { rate, inputVariance, entriesWithoutBaseTotal } = report.rateCheck;
  const outputVariance = field1OutputVariance(
    report.totals.outputTax, taxedOutputBase(report, nilRated.onTaxedJournals), rate,
  );
  return {
    ties: entriesWithoutBaseTotal === 0
      && Math.abs(outputVariance) <= RATE_CHECK_TOLERANCE && Math.abs(inputVariance) <= RATE_CHECK_TOLERANCE,
    outputVariance,
    inputVariance,
  };
}

/**
 * The report's `rateCheck` with the verdict a filing gate judged in place of box 1's: `ties`, `outputVariance` and
 * `outputImpliedTax` (15% of field 1, so output tax less it is still the variance). Every other key, and the
 * object's shape, is the report's, so a lock or dry run never answers `ties: false` for a period it locks on.
 */
export function rateCheckPayload(
  report: Pick<Vat201Report, 'totals' | 'rateCheck'>, filing: FilingRateCheck,
): Vat201Report['rateCheck'] {
  return {
    ...report.rateCheck,
    ties: filing.ties,
    outputImpliedTax: r2(report.totals.outputTax - filing.outputVariance),
    outputVariance: filing.outputVariance,
    inputVariance: filing.inputVariance,
  };
}
