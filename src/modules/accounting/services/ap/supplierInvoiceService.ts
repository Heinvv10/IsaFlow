/**
 * PRD-060: FibreFlow Accounting Module — Phase 2
 * Supplier Invoice Service — mutation side.
 *
 * The list / count / status-tab / export read-side queries live in
 * supplierInvoiceQueryService.ts. They're re-exported below so existing
 * consumers (`getSupplierInvoices`, etc.) keep working with their current
 * import paths. Adding all of them in one file pushed past the 300-line
 * project cap.
 */

import { sql, withTransaction } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type {
  SupplierInvoice,
  SupplierInvoiceItem,
  SupplierInvoiceCreateInput,
} from '../../types/ap.types';
import type { VatType } from '../../types/gl.types';
import { computeFingerprint } from '../capture/captureDeduplicationService';
import { resolvePendingAlertForInvoice } from '../capture/alertResolutionService';
import { mapInvoiceRow } from './supplierInvoiceQueryService';

type Row = DbRow;

export {
  getSupplierInvoices,
  getSupplierInvoiceStatusCounts,
  getSupplierInvoicesForExport,
  SUPPLIER_INVOICE_SORT_KEYS,
  SUPPLIER_INVOICE_EXPORT_CAP,
} from './supplierInvoiceQueryService';
export type { SupplierInvoiceSort } from './supplierInvoiceQueryService';

export async function getSupplierInvoiceById(
  companyId: string,
  id: string,
): Promise<(SupplierInvoice & { items: SupplierInvoiceItem[] }) | null> {
  try {
    const rows = (await sql`
      SELECT si.*, s.name AS supplier_name, NULL::text AS po_number
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.id = ${id} AND si.company_id = ${companyId}::UUID
    `) as Row[];
    if (rows.length === 0) return null;

    const itemRows = (await sql`
      SELECT sii.*, a.account_code, a.account_name
      FROM supplier_invoice_items sii
      LEFT JOIN gl_accounts a ON a.id = sii.gl_account_id
      WHERE sii.supplier_invoice_id = ${id}
      ORDER BY sii.created_at
    `) as Row[];

    return { ...mapInvoiceRow(rows[0]!), items: itemRows.map(mapItemRow) };
  } catch (err) {
    log.error('Failed to get supplier invoice', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function createSupplierInvoice(
  companyId: string,
  input: SupplierInvoiceCreateInput,
  userId: string,
): Promise<SupplierInvoice> {
  try {
    // W1 (P2.1): negative quantities/prices produce negative documents.
    for (const item of input.items || []) {
      if (!(Number(item.quantity) > 0)) {
        throw new Error(`Line "${item.description}": quantity must be positive`);
      }
      if (Number(item.unitPrice) < 0) {
        throw new Error(`Line "${item.description}": unit price cannot be negative`);
      }
    }
    const invoiceTaxRate = input.taxRate ?? 15;
    let subtotal = 0;
    let totalTax = 0;

    const computedItems = input.items.map((item) => {
      const lineTotal = Math.round(item.quantity * item.unitPrice * 100) / 100;
      const itemTaxRate = item.taxRate ?? invoiceTaxRate;
      const itemTax = Math.round(lineTotal * itemTaxRate / 100 * 100) / 100;
      // Warn when a 0% line has no explicit vatClassification — exempt and zero-rated
      // both have 0% rate but differ in input VAT recoverability under the VAT Act.
      if (itemTaxRate === 0 && !item.vatClassification) {
        log.warn('Supplier invoice line has 0% VAT with no vatClassification — defaulting to zero_rated; set vatClassification=exempt explicitly for exempt supplies', { description: item.description }, 'accounting');
      }
      subtotal += lineTotal;
      totalTax += itemTax;
      return { ...item, lineTotal, taxAmount: itemTax, taxRate: itemTaxRate };
    });

    subtotal = Math.round(subtotal * 100) / 100;
    totalTax = Math.round(totalTax * 100) / 100;
    const totalAmount = subtotal + totalTax;

    const dueDate = input.dueDate || calculateDueDate(input.invoiceDate, input.paymentTerms);

    // Currency fields — default to ZAR / 1.0 for functional currency pass-through
    const currencyCode = input.currencyCode?.trim().toUpperCase() || 'ZAR';
    const exchangeRate = (typeof input.exchangeRate === 'number' && input.exchangeRate > 0)
      ? input.exchangeRate : 1.0;
    const functionalTotal = Math.round(totalAmount * exchangeRate * 100) / 100;

    // Fetch supplier VAT number for duplicate fingerprint
    const [supplierVatRow] = (await sql`
      SELECT vat_number FROM suppliers
      WHERE id = ${input.supplierId}::UUID AND company_id = ${companyId}::UUID
    `) as Row[];
    const supplierVatNumber: string | null = supplierVatRow?.vat_number ?? null;
    const fingerprint = computeFingerprint(supplierVatNumber, input.invoiceNumber, totalAmount);

    const invoiceRow = await withTransaction(async (tx) => {
      const rows = (await tx`
        INSERT INTO supplier_invoices (
          company_id, invoice_number, supplier_id, purchase_order_id, grn_id,
          invoice_date, due_date, subtotal, tax_rate, tax_amount,
          total_amount, payment_terms, reference, project_id,
          cost_center_id, notes, created_by,
          currency_code, exchange_rate, functional_total,
          duplicate_fingerprint
        ) VALUES (
          ${companyId}::UUID, ${input.invoiceNumber}, ${input.supplierId},
          ${input.purchaseOrderId || null}, ${input.grnId || null},
          ${input.invoiceDate}, ${dueDate || null},
          ${subtotal}, ${invoiceTaxRate}, ${totalTax}, ${totalAmount},
          ${input.paymentTerms || null}, ${input.reference || null},
          ${input.projectId || null}, ${input.costCenterId || null},
          ${input.notes || null}, ${userId}::UUID,
          ${currencyCode}, ${exchangeRate}, ${functionalTotal},
          ${fingerprint}
        ) RETURNING *
      `) as Row[];

      const invoiceId = String(rows[0]!.id);

      for (const item of computedItems) {
        await tx`
          INSERT INTO supplier_invoice_items (
            supplier_invoice_id, po_item_id, description, quantity,
            unit_price, tax_rate, tax_amount, line_total,
            gl_account_id, project_id, cost_center_id, vat_classification
          ) VALUES (
            ${invoiceId}::UUID, ${item.poItemId || null}, ${item.description},
            ${item.quantity}, ${item.unitPrice}, ${item.taxRate},
            ${item.taxAmount}, ${item.lineTotal},
            ${item.glAccountId || null}, ${item.projectId || null},
            ${item.costCenterId || null},
            ${item.vatClassification || (item.taxRate > 0 ? 'standard' : 'zero_rated')}
          )
        `;
      }

      return rows[0] as Row;
    });

    log.info('Created supplier invoice', { invoiceId: String(invoiceRow.id), invoiceNumber: input.invoiceNumber }, 'accounting');

    // Best-effort alert resolution — non-blocking
    resolvePendingAlertForInvoice(
      companyId,
      input.supplierId,
      String(invoiceRow.id),
      input.invoiceDate,
    ).catch((err: unknown) => {
      log.warn('resolvePendingAlertForInvoice failed (non-blocking)', { error: err }, 'accounting');
    });

    return mapInvoiceRow(invoiceRow);
  } catch (err) {
    log.error('Failed to create supplier invoice', { error: err }, 'accounting');
    throw err;
  }
}

// ── Workflow functions (re-exported from supplierInvoiceWorkflowService) ──────

export {
  approveSupplierInvoice,
  cancelSupplierInvoice,
  performThreeWayMatch,
} from './supplierInvoiceWorkflowService';

function calculateDueDate(invoiceDate: string, paymentTerms?: string): string | null {
  if (!paymentTerms) return null;
  const match = paymentTerms.match(/net(\d+)/i);
  if (!match) return null;
  const date = new Date(invoiceDate);
  date.setDate(date.getDate() + Number(match[1]));
  return date.toISOString().split('T')[0]!;
}

function mapItemRow(row: Row): SupplierInvoiceItem {
  return {
    id: String(row.id),
    supplierInvoiceId: String(row.supplier_invoice_id),
    poItemId: row.po_item_id ? String(row.po_item_id) : undefined,
    description: String(row.description),
    quantity: Number(row.quantity),
    unitPrice: Number(row.unit_price),
    taxRate: Number(row.tax_rate),
    taxAmount: Number(row.tax_amount),
    lineTotal: Number(row.line_total),
    glAccountId: row.gl_account_id ? String(row.gl_account_id) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    costCenterId: row.cost_center_id ? String(row.cost_center_id) : undefined,
    vatClassification: row.vat_classification ? String(row.vat_classification) as VatType : undefined,
    createdAt: String(row.created_at),
  };
}

