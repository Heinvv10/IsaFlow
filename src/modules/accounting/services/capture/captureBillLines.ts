/**
 * The line items `capture/[id]/post` (R-131) and `ai-invoice-pipeline` (R-160)
 * write with the supplier invoice they create.
 *
 * That route inserted the invoice and no `supplier_invoice_items`. Every posting
 * path builds the journal's expense side from the items (`buildExpenseLines`), so
 * a bill with none books only DR VAT / CR AP — an entry the validator refuses. An
 * auto-approved capture therefore sat 'approved' with no journal: owing in the AP
 * subledger, absent from the GL.
 *
 * Extracted line items are used as they are; with none, ONE line carries the
 * extracted net (total − VAT) and VAT (Hein, 2026-09-29). Its account is the
 * capture event's own (`resolved_gl_account_id`), else the supplier coding
 * rule's default, else the company's `default_expense` system account — the one
 * approval already posts every uncoded line to. No total, or none of the three,
 * is a refusal — never a bill with no lines. Extracted lines carry the event's
 * or the rule's account when there is one, and otherwise stay uncoded as every
 * other bill's lines do. `planCaptureBillLines` only reads, so each route runs it
 * before its posting claim, where a 4xx still commits nothing. The pipeline
 * skipped a line it could not use and inserted the bill anyway — with no lines
 * when it skipped them all, and a R0 bill for a document with no total.
 * Dimensions (budgets P5-2b, breaker REPRO 2 and round 2): when the slip is
 * the evidence of a bank-first provisional (the one `attachEvidenceToProvisional`
 * will link, `findAttachableProvisional`), a line takes that provisional's
 * dimensions (`ap/supplierInvoiceProvisionalDims`); a line that inherits nothing
 * takes the supplier's default CC1 / CC2 / BU (migration 890) through
 * `resolveBillLineDimensions`, as `createSupplierInvoice` does. Both are written
 * with the lines, before an approval request can bind the draft's digest.
 */
import { sql } from '@/lib/neon';
import type { SupplierRule } from './supplierRulesService';
import type { PipelineInvoiceInput } from '../core/aiInvoicePipelineService';
import { billLineAccountRefusal } from '../ap/billLineAccountGuard';
import { getSystemAccountId } from '../gl/systemAccountResolver';
import { MissingSystemAccountError } from '../gl/systemAccountKeys';
import { resolveBillLineDimensions } from '../gl/dimensions/supplierDimensionDefaults';
import { DimensionRefusal } from '../gl/dimensions/dimensionTypes';
import { inheritSlipDimensions, provisionalDimLines } from '../ap/supplierInvoiceProvisionalDims';
import { findAttachableProvisional } from './evidenceAttachmentService';
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
  cc1Id?: string;
  cc2Id?: string;
  buId?: string;
}

export type CaptureBillLinesPlan = { lines: CaptureBillLine[] } | { refusal: string };

/** What buildInvoiceFromExtraction calls the line it synthesises from the totals. */
const TOTALS_LINE_DESCRIPTION = 'As per invoice';

/** The company's default expense account, or null when that role is not configured. */
async function companyDefaultExpense(companyId: string): Promise<string | null> {
  try {
    return await getSystemAccountId('default_expense', companyId);
  } catch (err) {
    // Only a MISSING ROLE means "no account"; any other fault is a real error.
    if (err instanceof MissingSystemAccountError) return null;
    throw err;
  }
}

export async function planCaptureBillLines(
  companyId: string,
  invoice: PipelineInvoiceInput,
  extractedLineCount: number,
  captureAccountId: string | null,
  rule: SupplierRule | null,
): Promise<CaptureBillLinesPlan> {
  if (!(invoice.totalAmount > 0)) {
    return { refusal: 'The document has no total to bill. Correct the extracted total, then post it again.' };
  }
  const accountId = captureAccountId ?? rule?.defaultGlAccountId ?? null;

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
    // Field by field, and a line's own account wins: the event's or the rule's
    // account only codes a line the extraction left uncoded.
    lines = computeSupplierInvoiceTotals(invoice.items, invoice.taxRate, false).items
      .map((i) => ({
        description: i.description, quantity: i.quantity, unitPrice: i.unitPrice, taxRate: i.taxRate,
        taxAmount: i.taxAmount, lineTotal: i.lineTotal, glAccountId: i.glAccountId ?? accountId,
      }));
  } else {
    const lineAccountId = accountId ?? await companyDefaultExpense(companyId);
    if (!lineAccountId) {
      return {
        refusal: 'The document has no line items and there is no expense account to put its total on: '
          + 'set a default on the supplier\'s coding rule or the Default Expense account in Default Accounts, '
          + 'then post it again.',
      };
    }
    const net = Math.round((invoice.totalAmount - invoice.taxAmount) * 100) / 100;
    lines = [{
      description: TOTALS_LINE_DESCRIPTION, quantity: 1, unitPrice: net, lineTotal: net,
      taxRate: invoice.taxRate, taxAmount: invoice.taxAmount, glAccountId: lineAccountId,
    }];
  }

  const accountRefusal = await billLineAccountRefusal(companyId, lines.map((l) => l.glAccountId));
  if (accountRefusal) return { refusal: accountRefusal };
  try {
    // The slip's provisional first; the supplier's defaults only for the lines that inherited nothing.
    const slip = await slipLines(companyId, invoice, lines);
    const rest = await resolveBillLineDimensions(companyId, invoice.supplierId, lines.filter((_, i) => !slip.inherited[i]));
    let next = 0;
    return { lines: slip.lines.map((l, i) => (slip.inherited[i] ? l : rest[next++]!)) };
  } catch (err) {
    if (err instanceof DimensionRefusal) return { refusal: err.message };
    throw err;
  }
}

/** The lines with the dimensions of the provisional the slip will evidence, if any (read only). */
async function slipLines(companyId: string, invoice: PipelineInvoiceInput, lines: readonly CaptureBillLine[]) {
  const prov = await findAttachableProvisional(companyId, invoice.supplierId || null, invoice.totalAmount, invoice.invoiceDate);
  if (!prov) return { lines: [...lines], inherited: lines.map(() => false) };
  const header = { subtotal: Math.round((invoice.totalAmount - invoice.taxAmount) * 100) / 100, totalAmount: invoice.totalAmount, taxRate: invoice.taxRate };
  return inheritSlipDimensions(companyId, lines, header, await provisionalDimLines(companyId, prov.jeId, prov.bankAccountId),
    await companyDefaultExpense(companyId));
}

/** On the request transaction, straight after the invoice INSERT — the column list createSupplierInvoice writes. */
export async function insertCaptureBillLines(invoiceId: string, lines: readonly CaptureBillLine[]): Promise<void> {
  for (const line of lines) {
    await sql`
      INSERT INTO supplier_invoice_items (
        supplier_invoice_id, description, quantity, unit_price,
        tax_rate, tax_amount, line_total, gl_account_id, vat_classification, cc1_id, cc2_id, bu_id
      ) VALUES (
        ${invoiceId}::UUID, ${line.description}, ${line.quantity}, ${line.unitPrice},
        ${line.taxRate}, ${line.taxAmount}, ${line.lineTotal}, ${line.glAccountId}::UUID,
        ${defaultVatClassification(line.taxRate)}, ${line.cc1Id ?? null}::UUID, ${line.cc2Id ?? null}::UUID, ${line.buId ?? null}::UUID
      )
    `;
  }
}
