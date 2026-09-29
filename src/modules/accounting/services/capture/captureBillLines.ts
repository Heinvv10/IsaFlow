/**
 * The line items `capture/[id]/post` writes with the supplier invoice it creates
 * (R-131).
 *
 * That route inserted the invoice and no `supplier_invoice_items`. Every posting
 * path builds the journal's expense side from the items (`buildExpenseLines`), so
 * a bill with none books only DR VAT / CR AP — an entry the validator refuses. An
 * auto-approved capture therefore sat 'approved' with no journal: owing in the AP
 * subledger, absent from the GL.
 *
 * Extracted line items are used as they are; with none, ONE line carries the
 * extracted net (total − VAT) and VAT on the supplier's default expense account.
 * No total, or no account for that one line, is a refusal — never a bill with no
 * lines. `planCaptureBillLines` only reads, so the route runs it before its
 * posting claim, where a 4xx still commits nothing.
 */
import { sql } from '@/lib/neon';
import type { SupplierRule } from './supplierRulesService';
import type { PipelineInvoiceInput } from '../core/aiInvoicePipelineService';
import { billLineAccountRefusal } from '../ap/billLineAccountGuard';
import {
  assertSupplierInvoiceLines,
  computeSupplierInvoiceTotals,
  defaultVatClassification,
} from '../ap/supplierInvoiceTotals';

export interface CaptureBillLine {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  taxAmount: number;
  lineTotal: number;
  glAccountId: string | null;
}

export type CaptureBillLinesPlan = { lines: CaptureBillLine[] } | { refusal: string };

/** What buildInvoiceFromExtraction calls the line it synthesises from the totals. */
const TOTALS_LINE_DESCRIPTION = 'As per invoice';

export async function planCaptureBillLines(
  companyId: string,
  invoice: PipelineInvoiceInput,
  extractedLineCount: number,
  rule: SupplierRule | null,
): Promise<CaptureBillLinesPlan> {
  if (!(invoice.totalAmount > 0)) {
    return { refusal: 'The document has no total to bill. Correct the extracted total, then post it again.' };
  }
  const accountId = rule?.defaultGlAccountId ?? null;

  let lines: CaptureBillLine[];
  if (extractedLineCount > 0) {
    try {
      assertSupplierInvoiceLines(invoice.items, false);
    } catch (err) {
      return { refusal: `Extracted line item refused — ${err instanceof Error ? err.message : String(err)}` };
    }
    // The rounding rules every bill's lines follow. The header totals stay the
    // document's own: posting books those, and buildExpenseLines allocates them
    // over these lines.
    lines = computeSupplierInvoiceTotals(invoice.items, invoice.taxRate, false).items
      .map((i) => ({ ...i, glAccountId: accountId }));
  } else {
    if (!accountId) {
      return {
        refusal: 'The document has no line items and its supplier has no default expense account to put '
          + 'its total on. Set one on the supplier\'s coding rule, then post it again.',
      };
    }
    const net = Math.round((invoice.totalAmount - invoice.taxAmount) * 100) / 100;
    lines = [{
      description: TOTALS_LINE_DESCRIPTION, quantity: 1, unitPrice: net, lineTotal: net,
      taxRate: invoice.taxRate, taxAmount: invoice.taxAmount, glAccountId: accountId,
    }];
  }

  const accountRefusal = await billLineAccountRefusal(companyId, lines.map((l) => l.glAccountId));
  return accountRefusal ? { refusal: accountRefusal } : { lines };
}

/** On the request transaction, straight after the invoice INSERT — the column list createSupplierInvoice writes. */
export async function insertCaptureBillLines(invoiceId: string, lines: readonly CaptureBillLine[]): Promise<void> {
  for (const line of lines) {
    await sql`
      INSERT INTO supplier_invoice_items (
        supplier_invoice_id, description, quantity, unit_price,
        tax_rate, tax_amount, line_total, gl_account_id, vat_classification
      ) VALUES (
        ${invoiceId}::UUID, ${line.description}, ${line.quantity}, ${line.unitPrice},
        ${line.taxRate}, ${line.taxAmount}, ${line.lineTotal}, ${line.glAccountId}::UUID,
        ${defaultVatClassification(line.taxRate)}
      )
    `;
  }
}
