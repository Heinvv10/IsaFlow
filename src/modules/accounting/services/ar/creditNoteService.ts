/**
 * PRD-060: FibreFlow Accounting Module — Phase 3
 * Credit Note Service (Customer & Supplier)
 */

import { sql, fmtDate } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from '../gl/journalEntryService';
import { getSystemAccount } from '../gl/systemAccountResolver';
import type { CreditNote, CreditNoteCreateInput, CreditNoteStatus } from '../../types/ar.types';
import type { JournalLineInput } from '../../types/gl.types';

interface CreditNoteFilters {
  type?: 'customer' | 'supplier';
  status?: CreditNoteStatus;
  limit?: number;
  offset?: number;
}

export async function getCreditNotes(companyId: string, filters?: CreditNoteFilters): Promise<{
  creditNotes: CreditNote[];
  total: number;
}> {
  try {
    const limit = Math.min(filters?.limit || 50, 200);
    const offset = filters?.offset || 0;
    let rows: Record<string, unknown>[];
    let countRows: Record<string, unknown>[];

    if (filters?.type) {
      rows = (await sql`
        SELECT cn.*, c.name AS client_name, COALESCE(s.company_name, s.name) AS supplier_name,
          COALESCE(ci.invoice_number, si.invoice_number) AS invoice_number
        FROM credit_notes cn
        LEFT JOIN customers c ON c.id = cn.client_id
        LEFT JOIN suppliers s ON s.id = cn.supplier_id
        LEFT JOIN customer_invoices ci ON ci.id = cn.customer_invoice_id
        LEFT JOIN supplier_invoices si ON si.id = cn.supplier_invoice_id
        WHERE cn.company_id = ${companyId} AND cn.type = ${filters.type}
        ORDER BY cn.credit_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Record<string, unknown>[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM credit_notes WHERE company_id = ${companyId} AND type = ${filters.type}
      `) as Record<string, unknown>[];
    } else {
      rows = (await sql`
        SELECT cn.*, c.name AS client_name, COALESCE(s.company_name, s.name) AS supplier_name,
          COALESCE(ci.invoice_number, si.invoice_number) AS invoice_number
        FROM credit_notes cn
        LEFT JOIN customers c ON c.id = cn.client_id
        LEFT JOIN suppliers s ON s.id = cn.supplier_id
        LEFT JOIN customer_invoices ci ON ci.id = cn.customer_invoice_id
        LEFT JOIN supplier_invoices si ON si.id = cn.supplier_invoice_id
        WHERE cn.company_id = ${companyId}
        ORDER BY cn.credit_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Record<string, unknown>[];
      countRows = (await sql`SELECT COUNT(*) AS cnt FROM credit_notes WHERE company_id = ${companyId}`) as Record<string, unknown>[];
    }

    return { creditNotes: rows.map(mapRow), total: Number(countRows[0]!.cnt) };
  } catch (err) {
    log.error('Failed to get credit notes', { error: err }, 'accounting');
    throw err;
  }
}

export async function getCreditNoteById(companyId: string, id: string): Promise<CreditNote | null> {
  const rows = (await sql`
    SELECT cn.*, c.name AS client_name, COALESCE(s.company_name, s.name) AS supplier_name,
      COALESCE(ci.invoice_number, si.invoice_number) AS invoice_number
    FROM credit_notes cn
    LEFT JOIN customers c ON c.id = cn.client_id
    LEFT JOIN suppliers s ON s.id = cn.supplier_id
    LEFT JOIN customer_invoices ci ON ci.id = cn.customer_invoice_id
    LEFT JOIN supplier_invoices si ON si.id = cn.supplier_invoice_id
    WHERE cn.id = ${id}::UUID AND cn.company_id = ${companyId}
  `) as Record<string, unknown>[];
  return rows.length > 0 ? mapRow(rows[0]!) : null;
}

export async function createCreditNote(companyId: string, 
  input: CreditNoteCreateInput,
  userId: string
): Promise<CreditNote> {
  try {
    const taxRate = input.taxRate ?? 15;
    const taxAmount = Math.round(input.subtotal * taxRate / 100 * 100) / 100;
    const totalAmount = input.subtotal + taxAmount;

    const rows = (await sql`
      INSERT INTO credit_notes (
        company_id,
        type, client_id, customer_invoice_id, supplier_id, supplier_invoice_id,
        credit_date, reason, subtotal, tax_rate, tax_amount, total_amount,
        project_id, created_by
      ) VALUES (
        ${companyId}::UUID,
        ${input.type}, ${input.clientId || null}, ${input.customerInvoiceId || null},
        ${input.supplierId ? Number(input.supplierId) : null},
        ${input.supplierInvoiceId || null},
        ${input.creditDate}, ${input.reason || null},
        ${input.subtotal}, ${taxRate}, ${taxAmount}, ${totalAmount},
        ${input.projectId || null}, ${userId}::UUID
      ) RETURNING *
    `) as Record<string, unknown>[];

    log.info('Created credit note', { id: String(rows[0]!.id), type: input.type }, 'accounting');
    return mapRow(rows[0]!);
  } catch (err) {
    log.error('Failed to create credit note', { error: err }, 'accounting');
    throw err;
  }
}

export async function approveCreditNote(companyId: string, id: string, userId: string): Promise<CreditNote> {
  try {
    const cnRows = (await sql`SELECT * FROM credit_notes WHERE id = ${id} AND company_id = ${companyId}`) as Record<string, unknown>[];
    if (cnRows.length === 0) throw new Error(`Credit note ${id} not found`);
    const cn = cnRows[0]!;
    if (String(cn.status) !== 'draft') throw new Error(`Cannot approve credit note with status: ${cn.status}`);

    let lines: JournalLineInput[];

    if (String(cn.type) === 'customer') {
      // Customer CN: DR Revenue, CR Accounts Receivable
      const revenueAccount = await getSystemAccount('default_revenue', companyId);
      const arAccount = await getSystemAccount('receivable', companyId);
      const vatAccount = await getSystemAccount('vat_output', companyId);

      lines = [
        { glAccountId: revenueAccount.id, debit: Number(cn.subtotal), credit: 0,
          description: `Credit note ${cn.credit_note_number}` },
      ];
      if (Number(cn.tax_amount) > 0 && vatAccount) {
        lines.push({ glAccountId: vatAccount.id, debit: Number(cn.tax_amount), credit: 0,
          description: `VAT reversal: ${cn.credit_note_number}` });
      }
      lines.push({ glAccountId: arAccount.id, debit: 0, credit: Number(cn.total_amount),
        description: `AR credit: ${cn.credit_note_number}` });
    } else {
      // Supplier CN: DR Accounts Payable, CR Expense
      const apAccount = await getSystemAccount('payable', companyId);
      const expenseAccount = await getSystemAccount('default_expense', companyId);
      const vatAccount = await getSystemAccount('vat_input', companyId);

      lines = [
        { glAccountId: apAccount.id, debit: Number(cn.total_amount), credit: 0,
          description: `AP credit: ${cn.credit_note_number}` },
      ];
      if (Number(cn.tax_amount) > 0 && vatAccount) {
        lines.push({ glAccountId: vatAccount.id, debit: 0, credit: Number(cn.tax_amount),
          description: `VAT reversal: ${cn.credit_note_number}` });
      }
      lines.push({ glAccountId: expenseAccount.id, debit: 0, credit: Number(cn.subtotal),
        description: `Expense credit: ${cn.credit_note_number}` });
    }

    // credit_date comes back from pg as a Date object (or a string on some
    // paths); String(Date) yields "Fri Jul 04 2026 ... GMT+0200 (...)" which
    // Postgres rejects as an invalid time zone when inserted into entry_date.
    // fmtDate (not toISODate) is required here: node-postgres constructs DATE
    // columns at LOCAL midnight, so toISODate's UTC-based slicing rolls the
    // date back a day on this server's UTC+2 timezone — fmtDate reads the
    // same local getters pg used to build the Date, and also handles the
    // string shape (already 'YYYY-MM-DD' or an ISO timestamp).
    const entryDate = fmtDate(cn.credit_date);
    if (!entryDate) throw new Error(`Credit note ${id} has an invalid credit_date value`);

    // No sourceDocumentId: gl_journal_entries.source_document_id has an FK to
    // captured_documents(id) only (migration 409); a credit note's own id
    // would violate it. The credit_note <-> journal entry link is instead
    // persisted below via credit_notes.gl_journal_entry_id.
    const je = await createJournalEntry(companyId, {
      entryDate,
      description: `Credit note ${cn.credit_note_number}`,
      source: 'auto_credit_note',
      lines,
    }, userId);
    await postJournalEntry(companyId, je.id, userId);

    // N6 (P2.1): approving a LINKED note auto-applies it, so it must land in
    // 'applied' — leaving it 'approved' let the separate apply action credit
    // the same invoice a SECOND time (applyCreditNoteToInvoice recomputes
    // outstanding from the already-bumped row and happily double-credits).
    let autoApplied = false;
    if (String(cn.type) === 'customer' && cn.customer_invoice_id) {
      await sql`
        UPDATE customer_invoices SET amount_paid = amount_paid + ${Number(cn.total_amount)}
        WHERE id = ${cn.customer_invoice_id}::UUID AND company_id = ${companyId}::UUID
      `;
      autoApplied = true;
    } else if (String(cn.type) === 'supplier' && cn.supplier_invoice_id) {
      await sql`
        UPDATE supplier_invoices SET amount_paid = amount_paid + ${Number(cn.total_amount)}
        WHERE id = ${cn.supplier_invoice_id}::UUID AND company_id = ${companyId}::UUID
      `;
      autoApplied = true;
    }

    const finalStatus = autoApplied ? 'applied' : 'approved';
    const updatedRows = (await sql`
      UPDATE credit_notes SET status = ${finalStatus}, approved_by = ${userId}::UUID,
        approved_at = NOW(), gl_journal_entry_id = ${je.id}::UUID
      WHERE id = ${id} AND company_id = ${companyId}::UUID RETURNING *
    `) as Record<string, unknown>[];
    const updated = updatedRows[0] as Record<string, unknown>;

    log.info('Approved credit note', { id, journalEntryId: je.id }, 'accounting');
    return mapRow(updated);
  } catch (err) {
    log.error('Failed to approve credit note', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function cancelCreditNote(companyId: string, 
  id: string,
  userId: string,
  reason?: string
): Promise<CreditNote> {
  try {
    const cnRows = (await sql`SELECT * FROM credit_notes WHERE id = ${id} AND company_id = ${companyId}`) as Record<string, unknown>[];
    if (cnRows.length === 0) throw new Error(`Credit note ${id} not found`);
    const cn = cnRows[0]!;
    if (String(cn.status) !== 'approved') {
      throw new Error(`Cannot cancel credit note with status: ${cn.status}`);
    }

    // Reverse GL journal entry — manages its own transaction, must stay outside
    if (cn.gl_journal_entry_id) {
      await reverseJournalEntry(companyId, String(cn.gl_journal_entry_id), userId);
    }

    if (String(cn.type) === 'customer' && cn.customer_invoice_id) {
      await sql`
        UPDATE customer_invoices
        SET amount_paid = GREATEST(0, amount_paid - ${Number(cn.total_amount)})
        WHERE id = ${cn.customer_invoice_id}::UUID AND company_id = ${companyId}::UUID
      `;
      await sql`
        UPDATE customer_invoices SET status = CASE
          WHEN amount_paid <= 0.01 THEN 'approved'
          WHEN amount_paid < total_amount THEN 'partially_paid'
          ELSE status
        END
        WHERE id = ${cn.customer_invoice_id}::UUID AND company_id = ${companyId}::UUID
      `;
    } else if (String(cn.type) === 'supplier' && cn.supplier_invoice_id) {
      await sql`
        UPDATE supplier_invoices
        SET amount_paid = GREATEST(0, amount_paid - ${Number(cn.total_amount)})
        WHERE id = ${cn.supplier_invoice_id}::UUID AND company_id = ${companyId}::UUID
      `;
    }

    const cancelledRows = (await sql`
      UPDATE credit_notes
      SET status = 'cancelled', cancelled_by = ${userId}::UUID,
          cancelled_at = NOW(), cancel_reason = ${reason || null}
      WHERE id = ${id} AND company_id = ${companyId}::UUID RETURNING *
    `) as Record<string, unknown>[];
    const updated = cancelledRows[0] as Record<string, unknown>;

    log.info('Cancelled credit note', { id, reason }, 'accounting');
    return mapRow(updated);
  } catch (err) {
    log.error('Failed to cancel credit note', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function applyCreditNoteToInvoice(
  companyId: string,
  creditNoteId: string,
  invoiceId: string,
  userId: string
): Promise<CreditNote> {
  const cnRows = (await sql`
    SELECT * FROM credit_notes WHERE id = ${creditNoteId}::UUID AND company_id = ${companyId}
  `) as Record<string, unknown>[];
  if (cnRows.length === 0) throw new Error('Credit note not found');
  const cn = cnRows[0]!;
  if (String(cn.status) !== 'approved') throw new Error('Credit note must be approved before applying');
  if (String(cn.type) !== 'customer') throw new Error('Only customer credit notes can be applied to invoices');

  const invRows = (await sql`
    SELECT * FROM customer_invoices
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}
  `) as Record<string, unknown>[];
  if (invRows.length === 0) throw new Error('Invoice not found');
  const inv = invRows[0]!;

  const clientMatch = String(inv.client_id || inv.customer_id) === String(cn.client_id);
  if (!clientMatch) throw new Error('Invoice and credit note must belong to the same customer');

  const outstanding = Math.max(0, Number(inv.total_amount) - Number(inv.amount_paid));
  const applyAmount = Math.min(Number(cn.total_amount), outstanding);
  if (applyAmount <= 0) throw new Error('Invoice has no outstanding balance');

  const newPaid = Number(inv.amount_paid) + applyAmount;
  const newStatus = newPaid >= Number(inv.total_amount) * 0.999 ? 'paid'
    : newPaid > 0.01 ? 'partially_paid' : String(inv.status);
  await sql`
    UPDATE customer_invoices
    SET amount_paid = ${newPaid}, status = ${newStatus}
    WHERE id = ${invoiceId}::UUID AND company_id = ${companyId}
  `;
  const appliedRows = (await sql`
    UPDATE credit_notes
    SET status = 'applied', customer_invoice_id = ${invoiceId}::UUID, updated_at = NOW()
    WHERE id = ${creditNoteId}::UUID AND company_id = ${companyId}
    RETURNING *
  `) as Record<string, unknown>[];
  const updated = appliedRows[0] as Record<string, unknown>;

  log.info('Applied credit note to invoice', { creditNoteId, invoiceId, applyAmount, userId }, 'accounting');
  return mapRow(updated);
}

function mapRow(row: Record<string, unknown>): CreditNote {
  return {
    id: String(row.id),
    creditNoteNumber: row.credit_note_number ? String(row.credit_note_number) : '',
    type: String(row.type) as CreditNote['type'],
    clientId: row.client_id ? String(row.client_id) : undefined,
    customerInvoiceId: row.customer_invoice_id ? String(row.customer_invoice_id) : undefined,
    supplierId: row.supplier_id ? String(row.supplier_id) : undefined,
    supplierInvoiceId: row.supplier_invoice_id ? String(row.supplier_invoice_id) : undefined,
    creditDate: String(row.credit_date),
    reason: row.reason ? String(row.reason) : undefined,
    subtotal: Number(row.subtotal),
    taxRate: Number(row.tax_rate),
    taxAmount: Number(row.tax_amount),
    totalAmount: Number(row.total_amount),
    status: String(row.status) as CreditNoteStatus,
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    createdBy: String(row.created_by),
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    approvedAt: row.approved_at ? String(row.approved_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    clientName: row.client_name ? String(row.client_name) : undefined,
    supplierName: row.supplier_name ? String(row.supplier_name) : undefined,
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : undefined,
  };
}
