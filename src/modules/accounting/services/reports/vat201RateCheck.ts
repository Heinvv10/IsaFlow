/**
 * SARS's 15% check, judged on the figures the VAT201 FILES rather than on the report's boxes.
 *
 * THE FIGURE. Output tax is checked against the TAXED OUTPUT BASE: every output box except the nil-rated 2, 2A
 * and 3 (so boxes 1, 1A, 12 and `unclassified`), VAT-exclusive, less the nil-rated supplies that sit on journals
 * also carrying output VAT (`getNilRatedSupplies().onTaxedJournals`). It is the ledger aggregate
 * `field1_standardRatedSupplies` (vat201LedgerFields), NOT the SARS form's field 1, which is box 1 alone,
 * VAT-inclusive, with field 1A separate (vat201SarsFields). Both give back the same nil-rated share.
 *
 * WHY THE REPORT'S CHECK IS NOT THE FILING CHECK. `deriveVatBoxes` apportions a journal's whole base pro-rata by
 * tax, so a zero-rated or exempt revenue line on a journal that also carries output VAT lands in box 1 (its type
 * takes a nil share of the tax). `getVat201Report().rateCheck` measures the base with that share in it; the return
 * gives it back to fields 2 and 3, so the report's check describes a declaration nobody makes: one journal of
 * R1 000 standard + R300 zero-rated + R200 exempt with R150 of VAT reads R75 out, while the taxed output base the
 * return files (R1 000) is exactly 15%.
 *
 * ONE PLACE. The taxed output base and its variance are computed here for the return (`vat201LedgerFields`), the
 * ISV filability decision (`evaluateVat201Filability`, through `filedRateVariance`) and its audit event, and the three gates that refuse a
 * failing period unless forced (`finaliseVatReturn`, POST /vat-period-locks, MCP `lock_vat_period`), which also
 * share the refusal wording (`rateCheckFailure`) and the payload (`rateCheckPayload`).
 *
 * WHAT IS KEPT FROM THE REPORT, unchanged: the input variance (the per-journal over-claim, see vatInputOverclaim),
 * the demand that no journal carry tax without a base, and the R1 absolute RATE_CHECK_TOLERANCE. Only the output
 * side moves, so a variance no nil-rated supply on a taxed journal explains fails as it did. Two consequences, both
 * intended: a box 2/2A/3 base (a journal whose only output leg is nil-coded, e.g. a R0.00 zero-rated leg on an
 * export) no longer counts against the check; and a variance the nil-rated base had MASKED (output tax at 15% of
 * the whole mixed base, i.e. over-declared on the taxed part) now fails.
 *
 * NAMED LIMIT: the check proves output VAT is 15% of the base CODED taxable; it cannot prove the coding. A taxable
 * line miscoded exempt or zero-rated on a journal that carries output VAT ties, because the VAT charged is exactly
 * 15% of what is coded standard. The excluded amounts are visible in fields 2 and 3 of the return and in the
 * give-back each refusal and each lock or dry-run payload states (`nilRatedGivenBack`).
 *
 * The rate comes off the report, so the check cannot run at a rate the boxes were not derived at.
 */
import type { NilRatedSupplies } from './vat201NilRatedSupplies';
import type { Vat201Report } from './vat201ReportService';
import { RATE_CHECK_TOLERANCE } from './vatBoxTypes';

/** Output boxes whose value is reported in field 2 or field 3, not in the taxed output base. */
const NIL_RATED_OUTPUT_BOXES: readonly string[] = ['2', '2A', '3'];

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The taxed output base (`field1_standardRatedSupplies`): every TAXED output supply, not only box 1.
 *
 * Boxes 12 (imported services / other output) and `unclassified` (an output VAT
 * type outside the box map) carry tax that field 5 counts. Leaving their base
 * out would file output tax with no supply value behind it and break the same
 * 15% relation the return is checked on, so this is every output box except
 * the nil-rated ones, whose values come from the documents.
 */
export function taxedOutputBase(report: Pick<Vat201Report, 'boxes'>, nilRatedInside: number): number {
  const taxed = report.boxes
    .filter((b) => b.direction === 'output' && !NIL_RATED_OUTPUT_BOXES.includes(b.box))
    .reduce((s, b) => s + b.base, 0);
  // `deriveVatBoxes` apportions a journal's whole base pro-rata by tax, so a
  // nil-rated line sharing a journal with a taxed one lands here. It is
  // declared in field 2 or 3, so the taxed base gives it up rather than the
  // same rand being reported in two boxes.
  return r2(taxed - nilRatedInside);
}

/**
 * Output tax less 15% of the taxed output base. The implied tax is rounded to the cent first, as the report
 * rounds its own, so a period with nothing given back reads exactly the report's `outputVariance`.
 */
export function field1OutputVariance(outputTax: number, field1: number, rate: number): number {
  return r2(outputTax - r2(field1 * rate));
}

export interface RateCheckVerdict {
  ties: boolean;
  /** Output tax less 15% of the taxed output base. */
  outputVariance: number;
  /** The report's per-journal input over-claim, unchanged. */
  inputVariance: number;
}

export interface FilingRateCheck extends RateCheckVerdict {
  /** The base output tax was checked against (`field1_standardRatedSupplies`). */
  taxedOutputBase: number;
  /** Zero-rated and exempt supplies on journals carrying output VAT, excluded from that base (fields 2 and 3). */
  nilRatedGivenBack: number;
  /** The part of `nilRatedGivenBack` that is revenue with no VAT code on documents that recorded no VAT. */
  uncodedGivenBack: number;
}

/** The R1 tie-out on output tax against a taxed output base already worked out. Pure. */
function judgeRateCheck(
  rateCheck: Pick<Vat201Report['rateCheck'], 'rate' | 'inputVariance' | 'entriesWithoutBaseTotal'>,
  outputTax: number,
  taxedBase: number,
): RateCheckVerdict {
  const { rate, inputVariance, entriesWithoutBaseTotal } = rateCheck;
  const outputVariance = field1OutputVariance(outputTax, taxedBase, rate);
  return {
    ties: entriesWithoutBaseTotal === 0
      && Math.abs(outputVariance) <= RATE_CHECK_TOLERANCE && Math.abs(inputVariance) <= RATE_CHECK_TOLERANCE,
    outputVariance,
    inputVariance,
  };
}

/** The verdict the filing gates refuse on (unless forced). Pure. */
export function rateCheckForFiling(
  report: Pick<Vat201Report, 'boxes' | 'totals' | 'rateCheck'>,
  nilRated: Pick<NilRatedSupplies, 'onTaxedJournals' | 'uncodedOnTaxedJournals'>,
): FilingRateCheck {
  const base = taxedOutputBase(report, nilRated.onTaxedJournals);
  return {
    ...judgeRateCheck(report.rateCheck, report.totals.outputTax, base),
    taxedOutputBase: base,
    nilRatedGivenBack: nilRated.onTaxedJournals,
    uncodedGivenBack: nilRated.uncodedOnTaxedJournals,
  };
}

/**
 * Rands of 15% variance tolerated before a return is called unfilable, as a
 * share of the tax declared in that direction, with an absolute floor.
 *
 * NOT `rateCheck.ties`, which is `vatBoxBasis`'s R1 ABSOLUTE tolerance on the
 * whole return plus a demand that no journal carry tax without a base. Neither
 * is reachable by a real book — that file's own header records a residual
 * variance of R4 407 on Velocity Fibre and calls it a genuine finding rather
 * than an error — so gating filing on it would block that company forever.
 * `ties` stays the assurance report's stricter signal; this is the filing bar.
 * (Moved from vat201LedgerFields so the ISV event records this predicate.)
 */
const RATE_CHECK_FLOOR = 1;
const RATE_CHECK_PROPORTION = 0.005;

function varianceIsMaterial(variance: number, taxDeclared: number): boolean {
  return Math.abs(variance) > Math.max(RATE_CHECK_FLOOR, Math.abs(taxDeclared) * RATE_CHECK_PROPORTION);
}

/** The filed figures `filedRateVariance` reads (a `LedgerVAT201` satisfies it). */
export interface FiledRateFigures {
  field1_standardRatedSupplies: number;
  field5_outputVAT: number;
  field10_totalInputVAT: number;
  rateCheck: Pick<Vat201Report['rateCheck'], 'rate' | 'inputVariance'>;
}

/**
 * The 15% part of `evaluateVat201Filability`: output tax against the taxed output base being filed (the report's
 * input variance as is), and whether either is material. The ISV `blocked` event records exactly this.
 */
export function filedRateVariance(f: FiledRateFigures): {
  rateVarianceMaterial: boolean; outputVariance: number; inputVariance: number; taxedOutputBase: number;
} {
  const outputVariance = field1OutputVariance(f.field5_outputVAT, f.field1_standardRatedSupplies, f.rateCheck.rate);
  const { inputVariance } = f.rateCheck;
  return {
    rateVarianceMaterial: varianceIsMaterial(outputVariance, f.field5_outputVAT)
      || varianceIsMaterial(inputVariance, f.field10_totalInputVAT),
    outputVariance,
    inputVariance,
    taxedOutputBase: f.field1_standardRatedSupplies,
  };
}

/**
 * The refusal's statement of what is out, by how much, and what was excluded from the base. Each gate appends
 * what the caller can do about it.
 */
export function rateCheckFailure(f: FilingRateCheck): string {
  // "Of it" only while the uncoded part IS a part: a coded credit note can net the give-back below it.
  const coded = r2(f.nilRatedGivenBack - f.uncodedGivenBack);
  const uncodedRevenue = 'revenue with no VAT code on documents that recorded no VAT';
  const uncoded = f.uncodedGivenBack === 0 ? ''
    : f.uncodedGivenBack > 0 && coded >= 0
      ? `; ${f.uncodedGivenBack.toFixed(2)} of it is ${uncodedRevenue}, assumed zero-rated`
      : `; that net figure is ${f.uncodedGivenBack.toFixed(2)} of ${uncodedRevenue} (assumed zero-rated) and `
        + `${coded.toFixed(2)} of coded zero-rated or exempt supplies`;
  const givenBack = f.nilRatedGivenBack !== 0 || f.uncodedGivenBack !== 0
    ? `, which exclude ${f.nilRatedGivenBack.toFixed(2)} of zero-rated or exempt supplies on journals that also carry `
      + `output VAT (declared in fields 2 and 3${uncoded})`
    : '';
  return `This period fails SARS's 15% check: output tax is out by ${f.outputVariance.toFixed(2)} against 15% of `
    + `the taxed output supplies of ${f.taxedOutputBase.toFixed(2)}${givenBack}, and input tax is over-claimed by `
    + `${f.inputVariance.toFixed(2)} (summed per journal).`;
}

/**
 * The report's `rateCheck` with the verdict a filing gate judged in place of the report's: `ties`,
 * `outputVariance` and `outputImpliedTax` (15% of the taxed output base, so output tax less it is still the
 * variance), plus that base and what was given back to reach it. Every other key is the report's, so a lock or
 * dry run never answers `ties: false` for a period it locks on.
 */
export function rateCheckPayload(
  report: Pick<Vat201Report, 'totals' | 'rateCheck'>, filing: FilingRateCheck,
): Vat201Report['rateCheck'] & Pick<FilingRateCheck, 'taxedOutputBase' | 'nilRatedGivenBack' | 'uncodedGivenBack'> {
  return {
    ...report.rateCheck,
    ties: filing.ties,
    outputImpliedTax: r2(report.totals.outputTax - filing.outputVariance),
    outputVariance: filing.outputVariance,
    inputVariance: filing.inputVariance,
    taxedOutputBase: filing.taxedOutputBase,
    nilRatedGivenBack: filing.nilRatedGivenBack,
    uncodedGivenBack: filing.uncodedGivenBack,
  };
}
