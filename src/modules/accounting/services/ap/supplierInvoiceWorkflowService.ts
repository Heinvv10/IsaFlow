/**
 * Supplier Invoice Workflow Service
 * Approval, GL posting, payment allocation, status transitions, 3-way match.
 * Extracted from supplierInvoiceService.ts for file-size compliance.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from '../gl/journalEntryService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { validateThreeWayMatch } from '../../utils/threeWayMatch';
import { getSupplierInvoiceById } from './supplierInvoiceService';
import type { SupplierInvoice } from '../../types/ap.types';
import type { JournalLineInput } from '../../types/gl.types';

type Row = DbRow;

export async function approveSupplierInvoice(
  companyId: string,
  id: string,
  userId: string,
): Promise<SupplierInvoice> {
  try {
    const invoice = await getSupplierInvoiceById(companyId, id);
    if (!invoice) throw new Error(`Supplier invoice ${id} not found`);
    if (invoice.status !== 'draft' && invoice.status !== 'pending_approval') {
      throw new Error(`Cannot approve invoice with status: ${invoice.status}`);
    }

    // Auto-post GL entry: DR Expense + DR VAT Input, CR Accounts Payable
    const apAccount = await getSystemAccount('payable', companyId);
    const vatAccount = await getSystemAccount('vat_input', companyId);
    const defaultExpenseAccount = await getSystemAccount('default_expense', companyId);
    const lines: JournalLineInput[] = [];

    for (const item of invoice.items) {
      const glAccountId = item.glAccountId || defaultExpenseAccount.id;
      if (!glAccountId) throw new Error('No GL account for invoice item and no default expense account');
      lines.push({
        glAccountId,
        debit: item.lineTotal,
        credit: 0,
        description: item.description,
        projectId: item.projectId || invoice.projectId,
        costCenterId: item.costCenterId || invoice.costCenterId,
      });
    }

    if (invoice.taxAmount > 0) {
      lines.push({
        glAccountId: vatAccount.id,
        debit: invoice.taxAmount,
        credit: 0,
        description: `VAT on ${invoice.invoiceNumber}`,
        vatType: 'standard',
      });
    }

    lines.push({
      glAccountId: apAccount.id,
      debit: 0,
      credit: invoice.totalAmount,
      description: `AP: ${invoice.invoiceNumber}`,
    });

    const journalEntry = await createJournalEntry(companyId, {
      entryDate: invoice.invoiceDate,
      description: `Supplier invoice ${invoice.invoiceNumber}`,
      source: 'auto_supplier_invoice',
      sourceDocumentId: id,
      lines,
    }, userId);

    await postJournalEntry(companyId, journalEntry.id, userId);

    const updated = (await sql`
      UPDATE supplier_invoices
      SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW(),
          gl_journal_entry_id = ${journalEntry.id}::UUID
      WHERE id = ${id} AND company_id = ${companyId}::UUID
      RETURNING *
    `) as Row[];

    log.info('Approved supplier invoice', { id, journalEntryId: journalEntry.id }, 'accounting');
    return mapInvoiceRow(updated[0]!);
  } catch (err) {
    log.error('Failed to approve supplier invoice', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function cancelSupplierInvoice(
  companyId: string,
  id: string,
): Promise<SupplierInvoice> {
  try {
    const invoice = await getSupplierInvoiceById(companyId, id);
    if (!invoice) throw new Error(`Supplier invoice ${id} not found`);
    if (invoice.status === 'paid' || invoice.status === 'partially_paid') {
      throw new Error('Cannot cancel invoice with payments');
    }
    const rows = (await sql`
      UPDATE supplier_invoices SET status = 'cancelled'
      WHERE id = ${id} AND company_id = ${companyId}::UUID RETURNING *
    `) as Row[];
    return mapInvoiceRow(rows[0]!);
  } catch (err) {
    log.error('Failed to cancel supplier invoice', { id, error: err }, 'accounting');
    throw err;
  }
}

const DEFAULT_TOLERANCE_PERCENT = 2;

export interface ThreeWayMatchItemResult {
  itemId: string;
  itemDescription: string;
  lineMatchStatus: 'unmatched' | 'po_matched' | 'grn_matched' | 'fully_matched';
  qtyVariancePct: number;
  priceVariancePct: number;
  match: ReturnType<typeof validateThreeWayMatch>;
}

export async function performThreeWayMatch(
  companyId: string,
  invoiceId: string,
): Promise<{
  invoiceId: string;
  matchStatus: 'unmatched' | 'po_matched' | 'grn_matched' | 'fully_matched';
  itemResults: ThreeWayMatchItemResult[];
}> {
  const invoice = await getSupplierInvoiceById(companyId, invoiceId);
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);

  if (!invoice.purchaseOrderId) {
    log.info('performThreeWayMatch: invoice has no linked PO — returning unmatched', { invoiceId }, 'accounting');
    return { invoiceId, matchStatus: 'unmatched', itemResults: [] };
  }

  // Load tolerance from supplier_coding_rules; fall back to 2%
  const ruleRows = (await sql`
    SELECT qty_tolerance_pct, price_tolerance_pct
    FROM supplier_coding_rules
    WHERE company_id = ${companyId}::UUID AND supplier_id = ${invoice.supplierId}::UUID
    LIMIT 1
  `) as Row[];
  const qtyTolerance = ruleRows.length > 0 && ruleRows[0]!.qty_tolerance_pct != null
    ? Number(ruleRows[0]!.qty_tolerance_pct) : DEFAULT_TOLERANCE_PERCENT;
  const priceTolerance = ruleRows.length > 0 && ruleRows[0]!.price_tolerance_pct != null
    ? Number(ruleRows[0]!.price_tolerance_pct) : DEFAULT_TOLERANCE_PERCENT;

  const poItems = (await sql`
    SELECT * FROM po_items
    WHERE purchase_order_id = ${invoice.purchaseOrderId}::UUID AND company_id = ${companyId}::UUID
  `) as Row[];

  const grnItems = invoice.grnId
    ? ((await sql`
        SELECT * FROM grn_items
        WHERE grn_id = ${invoice.grnId}::UUID AND company_id = ${companyId}::UUID
      `) as Row[])
    : [];

  const itemResults: ThreeWayMatchItemResult[] = [];

  for (const item of (invoice.items ?? [])) {
    const poItem = item.poItemId ? poItems.find((p: Row) => String(p.id) === item.poItemId) : null;
    const grnItem = poItem
      ? grnItems.find((g: Row) => String(g.po_item_id) === String(poItem.id))
      : null;

    const poQty = poItem ? Number(poItem.quantity) : 0;
    const poPrice = poItem ? Number(poItem.unit_price) : 0;
    const grnQtyReceived = grnItem ? Number(grnItem.quantity_received) : 0;

    const qtyVariancePct = (item.quantity - poQty) / Math.max(poQty, 1) * 100;
    const priceVariancePct = (item.unitPrice - poPrice) / Math.max(poPrice, 1) * 100;

    const match = validateThreeWayMatch({
      poQuantity: poQty,
      poUnitPrice: poPrice,
      grnQuantityReceived: grnQtyReceived,
      invoiceQuantity: item.quantity,
      invoiceUnitPrice: item.unitPrice,
      qtyTolerancePercent: qtyTolerance,
      priceTolerancePercent: priceTolerance,
    });

    const lineMatchStatus = match.status;

    // Persist per-line match state — log failures but keep processing other lines
    try {
      // supplier_invoice_items has no company_id; scope via parent invoice
      await sql`
        UPDATE supplier_invoice_items sii
        SET line_match_status = ${lineMatchStatus},
            qty_variance_pct   = ${qtyVariancePct},
            price_variance_pct = ${priceVariancePct},
            match_computed_at  = NOW()
        FROM supplier_invoices si
        WHERE sii.id = ${item.id}::UUID
          AND si.id = sii.supplier_invoice_id
          AND si.company_id = ${companyId}::UUID
      `;
    } catch (updateErr) {
      log.error('Failed to persist line match status', { itemId: item.id, error: updateErr }, 'accounting');
    }

    itemResults.push({
      itemId: item.id,
      itemDescription: item.description,
      lineMatchStatus,
      qtyVariancePct,
      priceVariancePct,
      match,
    });
  }

  const overallStatus = itemResults.length === 0
    ? 'unmatched'
    : itemResults.every(r => r.lineMatchStatus === 'fully_matched')
      ? 'fully_matched'
      : itemResults.some(r => r.lineMatchStatus === 'po_matched')
        ? 'po_matched'
        : itemResults.some(r => r.lineMatchStatus === 'grn_matched')
          ? 'grn_matched'
          : 'unmatched';

  await sql`
    UPDATE supplier_invoices SET match_status = ${overallStatus}
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('3-way match completed', { invoiceId, matchStatus: overallStatus, lineCount: itemResults.length }, 'accounting');
  return { invoiceId, matchStatus: overallStatus, itemResults };
}

// ── Private mapper (duplicated from supplierInvoiceService to avoid circular import) ──
import { fmtDate } from '@/lib/neon';
import type { VatType } from '../../types/gl.types';
import type { SupplierInvoiceItem } from '../../types/ap.types';

function mapInvoiceRow(row: Row): SupplierInvoice {
  return {
    id: String(row.id),
    invoiceNumber: String(row.invoice_number),
    supplierId: String(row.supplier_id),
    purchaseOrderId: row.purchase_order_id ? String(row.purchase_order_id) : undefined,
    grnId: row.grn_id ? String(row.grn_id) : undefined,
    invoiceDate: fmtDate(row.invoice_date),
    dueDate: row.due_date ? fmtDate(row.due_date) : undefined,
    receivedDate: row.received_date ? fmtDate(row.received_date) : undefined,
    subtotal: Number(row.subtotal),
    taxRate: Number(row.tax_rate),
    taxAmount: Number(row.tax_amount),
    totalAmount: Number(row.total_amount),
    amountPaid: Number(row.amount_paid),
    balance: Number(row.balance),
    paymentTerms: row.payment_terms ? String(row.payment_terms) : undefined,
    currency: String(row.currency),
    reference: row.reference ? String(row.reference) : undefined,
    status: String(row.status) as SupplierInvoice['status'],
    matchStatus: String(row.match_status) as SupplierInvoice['matchStatus'],
    projectId: row.project_id ? String(row.project_id) : undefined,
    costCenterId: row.cost_center_id ? String(row.cost_center_id) : undefined,
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    sageInvoiceId: row.sage_invoice_id ? String(row.sage_invoice_id) : undefined,
    notes: row.notes ? String(row.notes) : undefined,
    createdBy: String(row.created_by),
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    approvedAt: row.approved_at ? String(row.approved_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    supplierName: row.supplier_name ? String(row.supplier_name) : undefined,
    poNumber: row.po_number ? String(row.po_number) : undefined,
  };
}

export type { SupplierInvoiceItem, VatType };
