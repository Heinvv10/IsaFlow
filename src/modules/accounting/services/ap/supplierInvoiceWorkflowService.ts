/**
 * Supplier Invoice Workflow Service
 * Approval, GL posting, payment allocation, status transitions, 3-way match.
 * Extracted from supplierInvoiceService.ts for file-size compliance.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '../gl/journalEntryService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import { validateThreeWayMatch } from '../../utils/threeWayMatch';
import { getSupplierInvoiceById } from './supplierInvoiceService';
import type { SupplierInvoice } from '../../types/ap.types';
import type { JournalLineInput } from '../../types/gl.types';

type Row = DbRow;

/**
 * Build the expense journal lines for a supplier invoice.
 *
 * Handles gross vs net line totals: if the sum of lineTotals matches
 * totalAmount (gross-inclusive storage), scale each line down to net
 * to avoid double-counting VAT. Uses a last-line adjustment so the
 * per-line rounding errors don't accumulate into a debit/credit imbalance.
 */
function buildExpenseLines(
  invoice: SupplierInvoice,
  defaultGlAccountId: string,
): JournalLineInput[] {
  const items = invoice.items ?? [];
  const sumLineTotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const lineTotalsAreGross = invoice.taxRate > 0 && Math.abs(sumLineTotal - invoice.totalAmount) < 0.02;
  const netTotal = invoice.subtotal;
  const lines: JournalLineInput[] = [];

  let allocatedNet = 0;
  const itemCount = items.length;

  items.forEach((item, idx) => {
    const glAccountId = item.glAccountId || defaultGlAccountId;
    let debit: number;

    if (idx === itemCount - 1) {
      // Last line: absorb rounding residual so debits sum exactly to subtotal.
      debit = Math.round((netTotal - allocatedNet) * 100) / 100;
    } else if (lineTotalsAreGross && sumLineTotal > 0) {
      debit = Math.round(item.lineTotal * (netTotal / sumLineTotal) * 100) / 100;
    } else {
      debit = Math.round(item.lineTotal * 100) / 100;
    }

    allocatedNet += debit;
    lines.push({
      glAccountId,
      debit,
      credit: 0,
      description: item.description,
      projectId: item.projectId || invoice.projectId,
      costCenterId: item.costCenterId || invoice.costCenterId,
    });
  });

  return lines;
}

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

    const lines: JournalLineInput[] = buildExpenseLines(invoice, defaultExpenseAccount.id);

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

    // sourceDocumentId FKs to captured_documents(id) — not supplier_invoices.
    // The invoice↔JE link is maintained via supplier_invoices.gl_journal_entry_id
    // below.
    const journalEntry = await createJournalEntry(companyId, {
      entryDate: invoice.invoiceDate,
      description: `Supplier invoice ${invoice.invoiceNumber}`,
      source: 'auto_supplier_invoice',
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

/**
 * Idempotent GL backfill for already-approved supplier invoices.
 * Equivalent of approveSupplierInvoice but skips the status guard.
 */
export async function postSupplierInvoiceToGL(
  companyId: string,
  id: string,
  userId: string,
): Promise<{ journalEntryId: string; alreadyPosted: boolean }> {
  const invoice = await getSupplierInvoiceById(companyId, id);
  if (!invoice) throw new Error(`Supplier invoice ${id} not found`);

  if (invoice.glJournalEntryId) {
    return { journalEntryId: invoice.glJournalEntryId, alreadyPosted: true };
  }

  const apAccount = await getSystemAccount('payable', companyId);
  const vatAccount = await getSystemAccount('vat_input', companyId);
  const defaultExpenseAccount = await getSystemAccount('default_expense', companyId);

  const lines: JournalLineInput[] = buildExpenseLines(invoice, defaultExpenseAccount.id);

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
    lines,
  }, userId);

  await postJournalEntry(companyId, journalEntry.id, userId);

  await sql`
    UPDATE supplier_invoices
    SET gl_journal_entry_id = ${journalEntry.id}::UUID
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Backfilled supplier invoice GL', { id, journalEntryId: journalEntry.id }, 'accounting');
  return { journalEntryId: journalEntry.id, alreadyPosted: false };
}

export async function cancelSupplierInvoice(
  companyId: string,
  id: string,
  userId: string,
): Promise<SupplierInvoice> {
  try {
    // FOR UPDATE: serialise concurrent cancels — both passing the guards
    // would double-reverse the same approval journal.
    const lockRows = (await sql`
      SELECT id, status, gl_journal_entry_id FROM supplier_invoices
      WHERE id = ${id} AND company_id = ${companyId}::UUID
      FOR UPDATE
    `) as Row[];
    if (lockRows.length === 0) throw new Error(`Supplier invoice ${id} not found`);
    const locked = lockRows[0]!;
    const status = String(locked.status);
    if (status === 'paid' || status === 'partially_paid') {
      throw new Error('Cannot cancel invoice with payments');
    }
    if (status === 'cancelled') {
      throw new Error('Supplier invoice is already cancelled');
    }

    // P1.1 (audit C1, systemic): approve posts GL — cancel must reverse it.
    // Reverse BEFORE the flip so a blocked reversal (locked period) aborts
    // the cancel; the caller's request transaction keeps this atomic.
    if (locked.gl_journal_entry_id) {
      await reverseJournalEntry(companyId, String(locked.gl_journal_entry_id), userId);
    }

    const rows = (await sql`
      UPDATE supplier_invoices SET status = 'cancelled'
      WHERE id = ${id} AND company_id = ${companyId}::UUID AND status != 'cancelled'
      RETURNING *
    `) as Row[];
    if (rows.length !== 1) {
      throw new Error('Supplier invoice state changed concurrently — cancel aborted');
    }
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
