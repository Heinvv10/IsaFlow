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
 *   DOCUMENTS (`getNilRatedSupplies`) — 2, 3.
 *     A zero-rated or exempt supply posts no VAT control leg, so the ledger
 *     basis never selects its journal. See that file.
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
function taxedOutputBase(report: Vat201Report): number {
  return r2(
    report.boxes
      .filter((b) => b.direction === 'output' && !NIL_RATED_OUTPUT_BOXES.includes(b.box))
      .reduce((s, b) => s + b.base, 0),
  );
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
    field1_standardRatedSupplies: taxedOutputBase(report),
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
 * Pure decision: may this return be FILED? Separate from the exceptions gate,
 * which reconciles the invoice population; this asks whether the arithmetic on
 * the form itself is one SARS will accept.
 *
 * Two ways it is not. A box 1 that does not imply box 4 at 15% is the check
 * SARS runs on receipt — it fires when one journal mixes a taxed and a
 * nil-rated line, because the ledger basis apportions that journal's base
 * pro-rata by tax and the untaxed part lands on field 1. And a period holding
 * only credit notes produces negative supply values, which no VAT201 field can
 * carry.
 */
export function evaluateVat201Filability(
  vat201: Pick<LedgerVAT201, 'rateCheck' | (typeof SUPPLY_VALUE_FIELDS)[number][0]>,
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
  if (!vat201.rateCheck.ties) {
    return {
      filable: false,
      reason:
        `The return fails SARS's own 15% check — output tax is out by `
        + `${vat201.rateCheck.outputVariance.toFixed(2)} and input tax by `
        + `${vat201.rateCheck.inputVariance.toFixed(2)} against the supply values declared`,
    };
  }
  return { filable: true, reason: null };
}
