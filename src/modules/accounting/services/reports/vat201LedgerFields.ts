/**
 * The VAT201 field1..field11 shape, derived from the LEDGER.
 *
 * THE DEFECT THIS FIXES (audit K-031). `generateVAT201` reads
 * `customer_invoices`, `supplier_invoices` and `supplier_invoice_items` and
 * nothing else. It never reads `credit_notes` or manual VAT journals, so every
 * credit note in the period is missing from the figures it produces. The
 * export (`vat201ExportService`) and the MCP tools already answer from
 * `getVat201Report`, which derives the boxes from the journals. The on-screen
 * return, the saved draft submission and the ISV filing payload did not — so
 * the return a user saw and persisted could be higher than the ledger by the
 * whole of the period's credit notes.
 *
 * One arithmetic now answers all of them: `getVat201Report`, mapped here into
 * the field shape the route contract and `sarsEfilingClient` expect.
 *
 * WHAT STILL COMES FROM THE INVOICES. `outputInvoices` / `inputInvoices` are
 * the drill-down list of invoices in the period, and `degradedSources` says
 * which of those source tables could not be read. They are supporting detail
 * for the reader, NOT the source of any field: a period containing credit
 * notes or manual VAT journals will show a detail list that does not add up to
 * the boxes, which is the honest statement that those documents are not
 * invoices. The exceptions panel is where that difference is explained.
 */
import { generateVAT201, type VAT201Data } from './vat201Service';
import { getVat201Report, type Vat201Report } from './vat201ReportService';

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

function boxTotal(report: Vat201Report, field: 'base' | 'tax', boxes: readonly string[]): number {
  return r2(report.boxes.filter((b) => boxes.includes(b.box)).reduce((s, b) => s + b[field], 0));
}

/**
 * Build the VAT201 field totals for a period from the journals, keeping the
 * invoice drill-down lists that the detail view renders.
 *
 * Field 8 (input VAT on services) has no ledger counterpart: the journal
 * `vat_type` vocabulary distinguishes capital goods and imports but not goods
 * from services. It is reported as zero and its tax falls in field 7, which is
 * what keeps `field6 + field7 + field8 + field9 === field10`.
 */
export async function getLedgerVAT201(
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<VAT201Data> {
  const [report, invoiceDerived] = await Promise.all([
    getVat201Report(companyId, periodStart, periodEnd, { detail: 'summary' }),
    generateVAT201(companyId, periodStart, periodEnd),
  ]);

  const field6_capitalGoods = boxTotal(report, 'tax', ['14']);
  const field9_imports = boxTotal(report, 'tax', ['14A/15A']);
  const field10_totalInputVAT = r2(report.totals.inputTax);
  // Everything else claimable — box 15 plus the adjustment boxes 16/17/18 —
  // so the four input fields still sum to the total the ledger reports.
  const field7_otherGoods = r2(field10_totalInputVAT - field6_capitalGoods - field9_imports);

  return {
    periodStart,
    periodEnd,
    field1_standardRatedSupplies: boxTotal(report, 'base', ['1', '1A']),
    field2_zeroRatedSupplies: boxTotal(report, 'base', ['2', '2A']),
    field3_exemptSupplies: boxTotal(report, 'base', ['3']),
    field4_totalImports: boxTotal(report, 'base', ['14A/15A']),
    field5_outputVAT: r2(report.totals.outputTax),
    field6_capitalGoods,
    field7_otherGoods,
    field8_services: 0,
    field9_imports,
    field10_totalInputVAT,
    field11_vatPayableOrRefundable: r2(report.totals.netVat),
    outputInvoices: invoiceDerived.outputInvoices,
    inputInvoices: invoiceDerived.inputInvoices,
    degradedSources: invoiceDerived.degradedSources,
  };
}
