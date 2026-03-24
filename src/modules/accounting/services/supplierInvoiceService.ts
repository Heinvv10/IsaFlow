/**
 * PRD-060: FibreFlow Accounting Module — Phase 2
 * Supplier Invoice Service
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import { getAccountByCode } from './chartOfAccountsService';
import { validateThreeWayMatch } from '../utils/threeWayMatch';
import type {
  SupplierInvoice,
  SupplierInvoiceItem,
  SupplierInvoiceCreateInput,
  SupplierInvoiceStatus,
  InvoiceMatchStatus,
} from '../types/ap.types';
import type { JournalLineInput, VatType } from '../types/gl.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

interface InvoiceFilters {
  status?: SupplierInvoiceStatus;
  supplierId?: number;
  matchStatus?: InvoiceMatchStatus;
  limit?: number;
  offset?: number;
}

export async function getSupplierInvoices(filters?: InvoiceFilters): Promise<{
  invoices: SupplierInvoice[];
  total: number;
}> {
  try {
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;
    let rows: Row[];
    let countRows: Row[];

    // NOTE: purchase_orders table is not available in standalone accounting app.
    // po_number is returned as NULL; purchase_order_id column is kept for data integrity.
    if (filters?.status && filters?.supplierId) {
      rows = (await sql`
        SELECT si.*, s.name AS supplier_name, NULL::text AS po_number
        FROM supplier_invoices si
        LEFT JOIN suppliers s ON s.id = si.supplier_id
        WHERE si.status = ${filters.status} AND si.supplier_id = ${filters.supplierId}
        ORDER BY si.invoice_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM supplier_invoices
        WHERE status = ${filters.status} AND supplier_id = ${filters.supplierId}
      `) as Row[];
    } else if (filters?.status) {
      rows = (await sql`
        SELECT si.*, s.name AS supplier_name, NULL::text AS po_number
        FROM supplier_invoices si
        LEFT JOIN suppliers s ON s.id = si.supplier_id
        WHERE si.status = ${filters.status}
        ORDER BY si.invoice_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM supplier_invoices WHERE status = ${filters.status}
      `) as Row[];
    } else if (filters?.supplierId) {
      rows = (await sql`
        SELECT si.*, s.name AS supplier_name, NULL::text AS po_number
        FROM supplier_invoices si
        LEFT JOIN suppliers s ON s.id = si.supplier_id
        WHERE si.supplier_id = ${filters.supplierId}
        ORDER BY si.invoice_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM supplier_invoices WHERE supplier_id = ${filters.supplierId}
      `) as Row[];
    } else {
      rows = (await sql`
        SELECT si.*, s.name AS supplier_name, NULL::text AS po_number
        FROM supplier_invoices si
        LEFT JOIN suppliers s ON s.id = si.supplier_id
        ORDER BY si.invoice_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`SELECT COUNT(*) AS cnt FROM supplier_invoices`) as Row[];
    }

    return { invoices: rows.map(mapInvoiceRow), total: Number(countRows[0]!.cnt) };
  } catch (err) {
    log.error('Failed to get supplier invoices', { error: err }, 'accounting');
    throw err;
  }
}

export async function getSupplierInvoiceById(
  id: string
): Promise<(SupplierInvoice & { items: SupplierInvoiceItem[] }) | null> {
  try {
    const rows = (await sql`
      SELECT si.*, s.name AS supplier_name, NULL::text AS po_number
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.id = ${id}
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
  input: SupplierInvoiceCreateInput,
  userId: string
): Promise<SupplierInvoice> {
  try {
    const invoiceTaxRate = input.taxRate ?? 15;
    let subtotal = 0;
    let totalTax = 0;

    const computedItems = input.items.map(item => {
      const lineTotal = Math.round(item.quantity * item.unitPrice * 100) / 100;
      const itemTaxRate = item.taxRate ?? invoiceTaxRate;
      const itemTax = Math.round(lineTotal * itemTaxRate / 100 * 100) / 100;
      subtotal += lineTotal;
      totalTax += itemTax;
      return { ...item, lineTotal, taxAmount: itemTax, taxRate: itemTaxRate };
    });

    subtotal = Math.round(subtotal * 100) / 100;
    totalTax = Math.round(totalTax * 100) / 100;
    const totalAmount = subtotal + totalTax;

    const dueDate = input.dueDate || calculateDueDate(input.invoiceDate, input.paymentTerms);

    const rows = (await sql`
      INSERT INTO supplier_invoices (
        invoice_number, supplier_id, purchase_order_id, grn_id,
        invoice_date, due_date, subtotal, tax_rate, tax_amount,
        total_amount, payment_terms, reference, project_id,
        cost_center_id, notes, created_by
      ) VALUES (
        ${input.invoiceNumber}, ${input.supplierId},
        ${input.purchaseOrderId || null}, ${input.grnId || null},
        ${input.invoiceDate}, ${dueDate || null},
        ${subtotal}, ${invoiceTaxRate}, ${totalTax}, ${totalAmount},
        ${input.paymentTerms || null}, ${input.reference || null},
        ${input.projectId || null}, ${input.costCenterId || null},
        ${input.notes || null}, ${userId}::UUID
      ) RETURNING *
    `) as Row[];

    const invoiceId = String(rows[0]!.id);

    for (const item of computedItems) {
      await sql`
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

    log.info('Created supplier invoice', { invoiceId, invoiceNumber: input.invoiceNumber }, 'accounting');
    return mapInvoiceRow(rows[0]!);
  } catch (err) {
    log.error('Failed to create supplier invoice', { error: err }, 'accounting');
    throw err;
  }
}

export async function approveSupplierInvoice(
  id: string,
  userId: string
): Promise<SupplierInvoice> {
  try {
    const invoice = await getSupplierInvoiceById(id);
    if (!invoice) throw new Error(`Supplier invoice ${id} not found`);
    if (invoice.status !== 'draft' && invoice.status !== 'pending_approval') {
      throw new Error(`Cannot approve invoice with status: ${invoice.status}`);
    }

    // Auto-post GL entry: DR Expense + DR VAT Input, CR Accounts Payable
    const apAccount = await getAccountByCode('2110');
    const vatAccount = await getAccountByCode('1140');
    if (!apAccount) throw new Error('Accounts Payable account (2110) not found');
    if (!vatAccount) throw new Error('VAT Input account (1140) not found');

    const defaultExpenseAccount = await getAccountByCode('5100');
    const lines: JournalLineInput[] = [];

    for (const item of invoice.items) {
      const glAccountId = item.glAccountId || defaultExpenseAccount?.id;
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

    const journalEntry = await createJournalEntry({
      entryDate: invoice.invoiceDate,
      description: `Supplier invoice ${invoice.invoiceNumber}`,
      source: 'auto_supplier_invoice',
      sourceDocumentId: id,
      lines,
    }, userId);

    await postJournalEntry(journalEntry.id, userId);

    const updated = (await sql`
      UPDATE supplier_invoices
      SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW(),
          gl_journal_entry_id = ${journalEntry.id}::UUID
      WHERE id = ${id}
      RETURNING *
    `) as Row[];

    log.info('Approved supplier invoice', { id, journalEntryId: journalEntry.id }, 'accounting');
    return mapInvoiceRow(updated[0]!);
  } catch (err) {
    log.error('Failed to approve supplier invoice', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function cancelSupplierInvoice(id: string): Promise<SupplierInvoice> {
  try {
    const invoice = await getSupplierInvoiceById(id);
    if (!invoice) throw new Error(`Supplier invoice ${id} not found`);
    if (invoice.status === 'paid' || invoice.status === 'partially_paid') {
      throw new Error('Cannot cancel invoice with payments');
    }
    const rows = (await sql`
      UPDATE supplier_invoices SET status = 'cancelled' WHERE id = ${id} RETURNING *
    `) as Row[];
    return mapInvoiceRow(rows[0]!);
  } catch (err) {
    log.error('Failed to cancel supplier invoice', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function performThreeWayMatch(invoiceId: string) {
  try {
    const invoice = await getSupplierInvoiceById(invoiceId);
    if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
    if (!invoice.purchaseOrderId) throw new Error('Invoice has no linked PO');

    const poItems = (await sql`
      SELECT * FROM purchase_order_items WHERE purchase_order_id = ${invoice.purchaseOrderId}
    `) as Row[];

    const grnItems = invoice.grnId
      ? ((await sql`
          SELECT * FROM goods_receipt_items WHERE grn_id = ${invoice.grnId}
        `) as Row[])
      : [];

    const results = invoice.items.map(item => {
      const poItem = item.poItemId ? poItems.find((p: Row) => String(p.id) === item.poItemId) : null;
      const grnItem = poItem ? grnItems.find((g: Row) => String(g.po_item_id) === String(poItem.id)) : null;

      return {
        itemDescription: item.description,
        match: validateThreeWayMatch({
          poQuantity: poItem ? Number(poItem.quantity_ordered) : 0,
          poUnitPrice: poItem ? Number(poItem.unit_price) : 0,
          grnQuantityReceived: grnItem ? Number(grnItem.quantity_received) : 0,
          invoiceQuantity: item.quantity,
          invoiceUnitPrice: item.unitPrice,
        }),
      };
    });

    const overallStatus = results.every(r => r.match.status === 'fully_matched')
      ? 'fully_matched'
      : results.some(r => r.match.status === 'po_matched') ? 'po_matched'
      : results.some(r => r.match.status === 'grn_matched') ? 'grn_matched'
      : 'unmatched';

    await sql`
      UPDATE supplier_invoices SET match_status = ${overallStatus} WHERE id = ${invoiceId}
    `;

    return { invoiceId, matchStatus: overallStatus, itemResults: results };
  } catch (err) {
    log.error('Failed to perform 3-way match', { invoiceId, error: err }, 'accounting');
    throw err;
  }
}

function calculateDueDate(invoiceDate: string, paymentTerms?: string): string | null {
  if (!paymentTerms) return null;
  const match = paymentTerms.match(/net(\d+)/i);
  if (!match) return null;
  const date = new Date(invoiceDate);
  date.setDate(date.getDate() + Number(match[1]));
  return date.toISOString().split('T')[0]!;
}

function mapInvoiceRow(row: Row): SupplierInvoice {
  return {
    id: String(row.id),
    invoiceNumber: String(row.invoice_number),
    supplierId: String(row.supplier_id),
    purchaseOrderId: row.purchase_order_id ? String(row.purchase_order_id) : undefined,
    grnId: row.grn_id ? String(row.grn_id) : undefined,
    invoiceDate: String(row.invoice_date),
    dueDate: row.due_date ? String(row.due_date) : undefined,
    receivedDate: row.received_date ? String(row.received_date) : undefined,
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
