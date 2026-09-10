/**
 * The VAT201 field1..field11 shape, and the basis each field comes from.
 *
 * THE DEFECT THIS FIXES (audit K-031). `generateVAT201` reads
 * `customer_invoices`, `supplier_invoices` and `supplier_invoice_items` and
 * nothing else. It never reads `credit_notes` or manual VAT journals, so every
 * credit note in the period was missing from the tax it reported. The export
 * and the MCP tools already answer from the journal-derived `getVat201Report`;
 * the on-screen return, the saved draft and the ISV payload did not.
 *
 * NO SINGLE BASIS CAN ANSWER THE WHOLE FORM, so this states which basis
 * answers which field rather than zeroing what one of them cannot see:
 *
 *   LEDGER (`getVat201Report`) — 1, 4, 5, 6, 7, 9, 10, 11.
 *     Every field whose value is a VAT amount, plus the supply values that
 *     have a VAT leg to attribute them to. This is the K-031 correction.
 *   JOURNAL LINES (`getNilRatedSupplies`) — 2, 3, and a deduction from 1.
 *     A zero-rated or exempt supply posts no VAT control leg, so the box basis
 *     never selects its journal. Read per LINE, so a mixed invoice splits
 *     instead of declaring its whole value twice. See that file.
 *   DOCUMENTS (`generateVAT201`) — 8, and the drill-down invoice lists.
 *     Input tax on services is `supplier_invoice_items.vat_classification`;
 *     journal `vat_type` has no goods/services split, so the ledger cannot
 *     produce field 8 at all.
 *
 * WHERE THIS DIVERGES FROM `vat201ExportService`. That consumer of the same
 * report puts box 14A/15A into its `inputVATOther` and boxes 16/17/18 into a
 * separate `adjustments` field. Here 14A/15A is field 9 ("Input VAT — Imports",
 * which is what the form calls it) and 16/17/18 fall into the field 7
 * remainder, because the form has no adjustments field. The two agree on
 * field10/box 19; they group the breakdown differently on purpose.
 *
 * `degradedSources` still carries what `generateVAT201` could not read, and it
 * still means a field may be wrong — but only the document-derived ones now: a
 * failed `supplier_invoice_items` query understates field 8, a failed
 * `customer_invoices` query empties the drill-down list. The ledger fields are
 * unaffected by it, and `getNilRatedSupplies` throws rather than degrading,
 * because a compulsory disclosure silently reading zero is what K-031 was.
 *
 * COST. A GET now runs the VAT-journal line scan AND the invoice queries AND
 * the nil-rated query, where it previously ran the invoice queries alone. The
 * drill-down lists and fields 2/3/8 need the document population; the boxes
 * need the ledger.
 */
import { generateVAT201, type VAT201Data } from './vat201Service';
import { getVat201Report, type Vat201Report } from './vat201ReportService';
import { getNilRatedSupplies } from './vat201NilRatedSupplies';

/** Output boxes whose value is reported in field 2 or field 3, not field 1. */
const NIL_RATED_OUTPUT_BOXES: readonly string[] = ['2', '2A', '3'];

export interface LedgerVAT201 extends VAT201Data {
  /**
   * The 15% tie-out from the ledger. `getVat201Report` computes it and the
   * export carries it; the filing path needs it too, because a return whose
   * box 1 does not imply its box 4 is one SARS will query. Never sent to SARS
   * — `submitVAT201ToSars` strips it from the payload and gates on it.
   */
  rateCheck: Vat201Report['rateCheck'];
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function boxTax(report: Vat201Report, boxes: readonly string[]): number {
  return r2(report.boxes.filter((b) => boxes.includes(b.box)).reduce((s, b) => s + b.tax, 0));
}

function boxBase(report: Vat201Report, boxes: readonly string[]): number {
  return r2(report.boxes.filter((b) => boxes.includes(b.box)).reduce((s, b) => s + b.base, 0));
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
function taxedOutputBase(report: Vat201Report, nilRatedInside: number): number {
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
 * Build the VAT201 field totals for a period.
 *
 * `outputInvoices` / `inputInvoices` remain the period's invoices: they are the
 * drill-down list, not the source of any field, and in a period holding credit
 * notes or manual VAT journals they will not add up to the boxes. That is the
 * honest statement that those documents are not invoices; the exceptions panel
 * is where the difference is explained.
 */
export async function getLedgerVAT201(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<LedgerVAT201> {
  const [report, invoiceDerived, nilRated] = await Promise.all([
    getVat201Report(companyId, periodStart, periodEnd, { detail: 'summary' }),
    generateVAT201(companyId, periodStart, periodEnd),
    getNilRatedSupplies(companyId, periodStart, periodEnd),
  ]);

  const field6_capitalGoods = boxTax(report, ['14']);
  const field9_imports = boxTax(report, ['14A/15A']);
  const field8_services = invoiceDerived.field8_services;
  const field10_totalInputVAT = r2(report.totals.inputTax);
  // Everything else claimable — box 15 plus the adjustment boxes 16/17/18 —
  // so the four input fields still sum to the total the ledger reports. A
  // negative remainder means the document-derived field 8 exceeds what the
  // ledger claims; it is left visible rather than smoothed away.
  const field7_otherGoods = r2(
    field10_totalInputVAT - field6_capitalGoods - field8_services - field9_imports,
  );

  return {
    periodStart,
    periodEnd,
    field1_standardRatedSupplies: taxedOutputBase(report, nilRated.onTaxedJournals),
    field2_zeroRatedSupplies: nilRated.zeroRated,
    field3_exemptSupplies: nilRated.exempt,
    field4_totalImports: boxBase(report, ['14A/15A']),
    field5_outputVAT: r2(report.totals.outputTax),
    field6_capitalGoods,
    field7_otherGoods,
    field8_services,
    field9_imports,
    field10_totalInputVAT,
    field11_vatPayableOrRefundable: r2(report.totals.netVat),
    outputInvoices: invoiceDerived.outputInvoices,
    inputInvoices: invoiceDerived.inputInvoices,
    degradedSources: invoiceDerived.degradedSources,
    rateCheck: report.rateCheck,
  };
}

/** Supply-value fields. A negative one is not a filable VAT201 entry. */
const SUPPLY_VALUE_FIELDS = [
  ['field1_standardRatedSupplies', 'standard-rated supplies'],
  ['field2_zeroRatedSupplies', 'zero-rated supplies'],
  ['field3_exemptSupplies', 'exempt supplies'],
  ['field4_totalImports', 'total imports'],
] as const;

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
 */
const RATE_CHECK_FLOOR = 1;
const RATE_CHECK_PROPORTION = 0.005;

function varianceIsMaterial(variance: number, taxDeclared: number): boolean {
  return Math.abs(variance) > Math.max(RATE_CHECK_FLOOR, Math.abs(taxDeclared) * RATE_CHECK_PROPORTION);
}

export type Vat201Filability = Pick<
  LedgerVAT201,
  'rateCheck' | 'field5_outputVAT' | 'field7_otherGoods' | 'field8_services'
  | 'field10_totalInputVAT' | (typeof SUPPLY_VALUE_FIELDS)[number][0]
>;

/**
 * Pure decision: may this return be FILED? Separate from the exceptions gate,
 * which reconciles the invoice population; this asks whether the arithmetic on
 * the form itself is one SARS will accept.
 *
 * Three ways it is not.
 *
 * A NEGATIVE SUPPLY VALUE. A period holding only credit notes produces one, and
 * no VAT201 supply box can carry it.
 *
 * A BOX 1 THAT DOES NOT IMPLY BOX 4 at 15%, which is the check SARS runs on
 * receipt. It fires when one journal mixes VAT types the ledger cannot split by
 * line, because the base is apportioned pro-rata by tax.
 *
 * AN INPUT BREAKDOWN THAT CONTRADICTS ITS TOTAL. Field 8 is the only input
 * figure not derived from the ledger — journal `vat_type` has no goods/services
 * split — so where the documents classify more services VAT than the ledger
 * claims in total, the field 7 remainder turns negative. That is the two bases
 * disagreeing, not a real credit, and it must not be filed as a negative box.
 */
export function evaluateVat201Filability(
  vat201: Vat201Filability,
): { filable: boolean; reason: string | null } {
  for (const [field, label] of SUPPLY_VALUE_FIELDS) {
    const value = Number(vat201[field] ?? 0);
    if (value < 0) {
      return {
        filable: false,
        reason: `VAT201 ${label} is negative (${value.toFixed(2)}) — a return cannot declare a negative supply value`,
      };
    }
  }

  const input = vat201.field10_totalInputVAT;
  const other = vat201.field7_otherGoods;
  if ((input >= 0 && other < 0) || (input < 0 && other > 0)) {
    return {
      filable: false,
      reason:
        `VAT201 input VAT on other goods is ${other.toFixed(2)} against a total of ${input.toFixed(2)} — `
        + `the services figure (${vat201.field8_services.toFixed(2)}), which comes from the invoice line `
        + `classification rather than the ledger, exceeds what the ledger claims`,
    };
  }

  // Output variance is recomputed FROM THE FIELDS BEING FILED, not taken from
  // the report: the report's box 1 base still holds the nil-rated share of a
  // mixed journal, which field 1 has given back to field 2 or 3, so the
  // report's variance describes a declaration nobody is making. Input has no
  // supply-value field on this form, so its variance stays the report's.
  //
  // The rate comes off the report rather than being imported, so this file
  // cannot check a return at a rate the boxes were not derived at. It also
  // keeps the file out of the vat-guard gate's rate-constant rule without an
  // allowlist entry, which is the honest outcome: nothing here posts.
  const outputVariance = r2(
    vat201.field5_outputVAT - vat201.field1_standardRatedSupplies * vat201.rateCheck.rate,
  );
  const { inputVariance } = vat201.rateCheck;
  if (
    varianceIsMaterial(outputVariance, vat201.field5_outputVAT)
    || varianceIsMaterial(inputVariance, vat201.field10_totalInputVAT)
  ) {
    return {
      filable: false,
      reason:
        `The return fails SARS's own 15% check — output tax is out by `
        + `${outputVariance.toFixed(2)} and input tax by ${inputVariance.toFixed(2)} `
        + `against the supply values declared`,
    };
  }

  return { filable: true, reason: null };
}
