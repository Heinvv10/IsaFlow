/**
 * PRD-060: FibreFlow Accounting Module — Phase 3
 * Credit Note Service (Customer & Supplier)
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from './journalEntryService';
import { getAccountByCode } from './chartOfAccountsService';
import type { CreditNote, CreditNoteCreateInput, CreditNoteStatus } from '../types/ar.types';
import type { JournalLineInput } from '../types/gl.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

interface CreditNoteFilters {
  type?: 'customer' | 'supplier';
  status?: CreditNoteStatus;
  limit?: number;
  offset?: number;
}

export async function getCreditNotes(_companyId: string, filters?: CreditNoteFilters): Promise<{
  creditNotes: CreditNote[];
  total: number;
}> {
  try {
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;
    let rows: Row[];
    let countRows: Row[];

    if (filters?.type) {
      rows = (await sql`
        SELECT cn.*, c.company_name AS client_name, COALESCE(s.company_name, s.name) AS supplier_name,
          COALESCE(ci.invoice_number, si.invoice_number) AS invoice_number
        FROM credit_notes cn
        LEFT JOIN clients c ON c.id = cn.client_id
        LEFT JOIN suppliers s ON s.id = cn.supplier_id
        LEFT JOIN customer_invoices ci ON ci.id = cn.customer_invoice_id
        LEFT JOIN supplier_invoices si ON si.id = cn.supplier_invoice_id
        WHERE cn.type = ${filters.type}
        ORDER BY cn.credit_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM credit_notes WHERE type = ${filters.type}
      `) as Row[];
    } else {
      rows = (await sql`
        SELECT cn.*, c.company_name AS client_name, COALESCE(s.company_name, s.name) AS supplier_name,
          COALESCE(ci.invoice_number, si.invoice_number) AS invoice_number
        FROM credit_notes cn
        LEFT JOIN clients c ON c.id = cn.client_id
        LEFT JOIN suppliers s ON s.id = cn.supplier_id
        LEFT JOIN customer_invoices ci ON ci.id = cn.customer_invoice_id
        LEFT JOIN supplier_invoices si ON si.id = cn.supplier_invoice_id
        ORDER BY cn.credit_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`SELECT COUNT(*) AS cnt FROM credit_notes`) as Row[];
    }

    return { creditNotes: rows.map(mapRow), total: Number(countRows[0]!.cnt) };
  } catch (err) {
    log.error('Failed to get credit notes', { error: err }, 'accounting');
    throw err;
  }
}

export async function getCreditNoteById(_companyId: string, id: string): Promise<CreditNote | null> {
  const rows = (await sql`
    SELECT cn.*, c.company_name AS client_name, COALESCE(s.company_name, s.name) AS supplier_name,
      COALESCE(ci.invoice_number, si.invoice_number) AS invoice_number
    FROM credit_notes cn
    LEFT JOIN clients c ON c.id = cn.client_id
    LEFT JOIN suppliers s ON s.id = cn.supplier_id
    LEFT JOIN customer_invoices ci ON ci.id = cn.customer_invoice_id
    LEFT JOIN supplier_invoices si ON si.id = cn.supplier_invoice_id
    WHERE cn.id = ${id}::UUID
  `) as Row[];
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

export async function createCreditNote(_companyId: string, 
  input: CreditNoteCreateInput,
  userId: string
): Promise<CreditNote> {
  try {
    const taxRate = input.taxRate ?? 15;
    const taxAmount = Math.round(input.subtotal * taxRate / 100 * 100) / 100;
    const totalAmount = input.subtotal + taxAmount;

    const rows = (await sql`
      INSERT INTO credit_notes (
        type, client_id, customer_invoice_id, supplier_id, supplier_invoice_id,
        credit_date, reason, subtotal, tax_rate, tax_amount, total_amount,
        project_id, created_by
      ) VALUES (
        ${input.type}, ${input.clientId || null}, ${input.customerInvoiceId || null},
        ${input.supplierId ? Number(input.supplierId) : null},
        ${input.supplierInvoiceId || null},
        ${input.creditDate}, ${input.reason || null},
        ${input.subtotal}, ${taxRate}, ${taxAmount}, ${totalAmount},
        ${input.projectId || null}, ${userId}::UUID
      ) RETURNING *
    `) as Row[];

    log.info('Created credit note', { id: String(rows[0]!.id), type: input.type }, 'accounting');
    return mapRow(rows[0]!);
  } catch (err) {
    log.error('Failed to create credit note', { error: err }, 'accounting');
    throw err;
  }
}

export async function approveCreditNote(_companyId: string, id: string, userId: string): Promise<CreditNote> {
  try {
    const cnRows = (await sql`SELECT * FROM credit_notes WHERE id = ${id}`) as Row[];
    if (cnRows.length === 0) throw new Error(`Credit note ${id} not found`);
    const cn = cnRows[0]!;
    if (String(cn.status) !== 'draft') throw new Error(`Cannot approve credit note with status: ${cn.status}`);

    let lines: JournalLineInput[];

    if (String(cn.type) === 'customer') {
      // Customer CN: DR Revenue, CR Accounts Receivable
      const revenueAccount = await getAccountByCode('4100');
      const arAccount = await getAccountByCode('1120');
      const vatAccount = await getAccountByCode('2120');
      if (!revenueAccount || !arAccount) throw new Error('GL accounts 4100/1120 not found');

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

      // Reduce invoice balance
      if (cn.customer_invoice_id) {
        await sql`
          UPDATE customer_invoices SET amount_paid = amount_paid + ${Number(cn.total_amount)}
          WHERE id = ${cn.customer_invoice_id}::UUID
        `;
      }
    } else {
      // Supplier CN: DR Accounts Payable, CR Expense
      const apAccount = await getAccountByCode('2110');
      const expenseAccount = await getAccountByCode('5100');
      const vatAccount = await getAccountByCode('1140');
      if (!apAccount || !expenseAccount) throw new Error('GL accounts 2110/5100 not found');

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

      // Reduce supplier invoice balance
      if (cn.supplier_invoice_id) {
        await sql`
          UPDATE supplier_invoices SET amount_paid = amount_paid + ${Number(cn.total_amount)}
          WHERE id = ${cn.supplier_invoice_id}::UUID
        `;
      }
    }

    const je = await createJournalEntry('', {
      entryDate: String(cn.credit_date),
      description: `Credit note ${cn.credit_note_number}`,
      source: 'auto_credit_note',
      sourceDocumentId: id,
      lines,
    }, userId);
    await postJournalEntry('', je.id, userId);

    const updated = (await sql`
      UPDATE credit_notes SET status = 'approved', approved_by = ${userId}::UUID,
        approved_at = NOW(), gl_journal_entry_id = ${je.id}::UUID
      WHERE id = ${id} RETURNING *
    `) as Row[];

    log.info('Approved credit note', { id, journalEntryId: je.id }, 'accounting');
    return mapRow(updated[0]!);
  } catch (err) {
    log.error('Failed to approve credit note', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function cancelCreditNote(_companyId: string, 
  id: string,
  userId: string,
  reason?: string
): Promise<CreditNote> {
  try {
    const cnRows = (await sql`SELECT * FROM credit_notes WHERE id = ${id}`) as Row[];
    if (cnRows.length === 0) throw new Error(`Credit note ${id} not found`);
    const cn = cnRows[0]!;
    if (String(cn.status) !== 'approved') {
      throw new Error(`Cannot cancel credit note with status: ${cn.status}`);
    }

    // Reverse GL journal entry
    if (cn.gl_journal_entry_id) {
      await reverseJournalEntry('', String(cn.gl_journal_entry_id), userId);
    }

    // Reverse invoice balance adjustments
    if (String(cn.type) === 'customer' && cn.customer_invoice_id) {
      await sql`
        UPDATE customer_invoices
        SET amount_paid = GREATEST(0, amount_paid - ${Number(cn.total_amount)})
        WHERE id = ${cn.customer_invoice_id}::UUID
      `;
      await sql`
        UPDATE customer_invoices SET status = CASE
          WHEN amount_paid <= 0.01 THEN 'approved'
          WHEN amount_paid < total_amount THEN 'partially_paid'
          ELSE status
        END
        WHERE id = ${cn.customer_invoice_id}::UUID
      `;
    } else if (String(cn.type) === 'supplier' && cn.supplier_invoice_id) {
      await sql`
        UPDATE supplier_invoices
        SET amount_paid = GREATEST(0, amount_paid - ${Number(cn.total_amount)})
        WHERE id = ${cn.supplier_invoice_id}::UUID
      `;
    }

    const updated = (await sql`
      UPDATE credit_notes
      SET status = 'cancelled', cancelled_by = ${userId}::UUID,
          cancelled_at = NOW(), cancel_reason = ${reason || null}
      WHERE id = ${id} RETURNING *
    `) as Row[];

    log.info('Cancelled credit note', { id, reason }, 'accounting');
    return mapRow(updated[0]!);
  } catch (err) {
    log.error('Failed to cancel credit note', { id, error: err }, 'accounting');
    throw err;
  }
}

function mapRow(row: Row): CreditNote {
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
