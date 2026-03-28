/**
 * PRD-060: FibreFlow Accounting Module — Phase 2
 * Supplier Payment Service
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry } from './journalEntryService';
import { getAccountByCode } from './chartOfAccountsService';
import { validatePaymentAllocations } from '../utils/paymentAllocation';
import type {
  SupplierPayment,
  PaymentAllocation,
  PaymentAllocationInput,
  PaymentMethod,
  PaymentStatus,
  InvoiceForAllocation,
} from '../types/ap.types';
import type { JournalLineInput } from '../types/gl.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

interface PaymentFilters {
  status?: PaymentStatus;
  supplierId?: number;
  limit?: number;
  offset?: number;
}

export interface CreatePaymentInput {
  supplierId: number;
  paymentDate: string;
  totalAmount: number;
  paymentMethod?: PaymentMethod;
  bankAccountId?: string;
  reference?: string;
  description?: string;
  allocations: PaymentAllocationInput[];
}

export async function getSupplierPayments(_companyId: string, filters?: PaymentFilters): Promise<{
  payments: SupplierPayment[];
  total: number;
}> {
  try {
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;
    let rows: Row[];
    let countRows: Row[];

    if (filters?.status && filters?.supplierId) {
      rows = (await sql`
        SELECT sp.*, s.name AS supplier_name
        FROM supplier_payments sp LEFT JOIN suppliers s ON s.id = sp.supplier_id
        WHERE sp.status = ${filters.status} AND sp.supplier_id = ${filters.supplierId}
        ORDER BY sp.payment_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM supplier_payments
        WHERE status = ${filters.status} AND supplier_id = ${filters.supplierId}
      `) as Row[];
    } else if (filters?.status) {
      rows = (await sql`
        SELECT sp.*, s.name AS supplier_name
        FROM supplier_payments sp LEFT JOIN suppliers s ON s.id = sp.supplier_id
        WHERE sp.status = ${filters.status}
        ORDER BY sp.payment_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM supplier_payments WHERE status = ${filters.status}
      `) as Row[];
    } else if (filters?.supplierId) {
      rows = (await sql`
        SELECT sp.*, s.name AS supplier_name
        FROM supplier_payments sp LEFT JOIN suppliers s ON s.id = sp.supplier_id
        WHERE sp.supplier_id = ${filters.supplierId}
        ORDER BY sp.payment_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM supplier_payments WHERE supplier_id = ${filters.supplierId}
      `) as Row[];
    } else {
      rows = (await sql`
        SELECT sp.*, s.name AS supplier_name
        FROM supplier_payments sp LEFT JOIN suppliers s ON s.id = sp.supplier_id
        ORDER BY sp.payment_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`SELECT COUNT(*) AS cnt FROM supplier_payments`) as Row[];
    }

    return { payments: rows.map(mapPaymentRow), total: Number(countRows[0]!.cnt) };
  } catch (err) {
    log.error('Failed to get supplier payments', { error: err }, 'accounting');
    throw err;
  }
}

export async function getSupplierPaymentById(_companyId: string, 
  id: string
): Promise<(SupplierPayment & { allocations: PaymentAllocation[] }) | null> {
  try {
    const rows = (await sql`
      SELECT sp.*, s.name AS supplier_name
      FROM supplier_payments sp LEFT JOIN suppliers s ON s.id = sp.supplier_id
      WHERE sp.id = ${id}
    `) as Row[];
    if (rows.length === 0) return null;

    const allocRows = (await sql`
      SELECT pa.*, si.invoice_number
      FROM payment_allocations pa
      LEFT JOIN supplier_invoices si ON si.id = pa.invoice_id
      WHERE pa.payment_id = ${id}
    `) as Row[];

    return { ...mapPaymentRow(rows[0]!), allocations: allocRows.map(mapAllocationRow) };
  } catch (err) {
    log.error('Failed to get supplier payment', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function createSupplierPayment(_companyId: string, 
  input: CreatePaymentInput,
  userId: string
): Promise<SupplierPayment> {
  try {
    // Load invoices for allocation validation
    const invoiceIds = input.allocations.map(a => a.invoiceId);
    const invoiceRows = (await sql`
      SELECT id, invoice_number, total_amount, amount_paid, balance
      FROM supplier_invoices
      WHERE id = ANY(${invoiceIds}::UUID[])
    `) as Row[];

    const invoices: InvoiceForAllocation[] = invoiceRows.map((r: Row) => ({
      id: String(r.id),
      invoiceNumber: String(r.invoice_number),
      totalAmount: Number(r.total_amount),
      amountPaid: Number(r.amount_paid),
      balance: Number(r.balance),
    }));

    const validation = validatePaymentAllocations(input.totalAmount, input.allocations, invoices);
    if (!validation.valid) {
      throw new Error(`Invalid allocations: ${validation.errors.join('; ')}`);
    }

    const paymentRows = (await sql`
      INSERT INTO supplier_payments (
        supplier_id, payment_date, total_amount, payment_method,
        bank_account_id, reference, description, created_by
      ) VALUES (
        ${input.supplierId}, ${input.paymentDate}, ${input.totalAmount},
        ${input.paymentMethod || 'eft'}, ${input.bankAccountId || null},
        ${input.reference || null}, ${input.description || null}, ${userId}::UUID
      ) RETURNING *
    `) as Row[];

    const paymentId = String(paymentRows[0]!.id);

    for (const alloc of input.allocations) {
      await sql`
        INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
        VALUES (${paymentId}::UUID, ${alloc.invoiceId}::UUID, ${alloc.amount})
      `;
    }

    log.info('Created supplier payment', {
      paymentId,
      paymentNumber: String(paymentRows[0]!.payment_number),
      totalAmount: input.totalAmount,
    }, 'accounting');

    return mapPaymentRow(paymentRows[0]!);
  } catch (err) {
    log.error('Failed to create supplier payment', { error: err }, 'accounting');
    throw err;
  }
}

export async function processSupplierPayment(_companyId: string, 
  id: string,
  userId: string
): Promise<SupplierPayment> {
  try {
    const payment = await getSupplierPaymentById('', id);
    if (!payment) throw new Error(`Payment ${id} not found`);
    if (payment.status !== 'approved') throw new Error(`Payment must be approved before processing`);

    // Auto-post GL entry: DR Accounts Payable, CR Bank
    const apAccount = await getAccountByCode('2110');
    const bankAccount = payment.bankAccountId
      ? ((await sql`SELECT * FROM gl_accounts WHERE id = ${payment.bankAccountId}`) as Row[])[0]
      : await getAccountByCode('1110');

    if (!apAccount) throw new Error('Accounts Payable account (2110) not found');
    if (!bankAccount) throw new Error('Bank account not found');

    const lines: JournalLineInput[] = [
      {
        glAccountId: apAccount.id,
        debit: payment.totalAmount,
        credit: 0,
        description: `Payment ${payment.paymentNumber} to supplier`,
      },
      {
        glAccountId: bankAccount.id || String(bankAccount.id),
        debit: 0,
        credit: payment.totalAmount,
        description: `Payment ${payment.paymentNumber} to supplier`,
      },
    ];

    const journalEntry = await createJournalEntry('', {
      entryDate: payment.paymentDate,
      description: `Supplier payment ${payment.paymentNumber}`,
      source: 'auto_supplier_payment',
      sourceDocumentId: id,
      lines,
    }, userId);

    await postJournalEntry('', journalEntry.id, userId);

    // Update invoice balances from allocations
    for (const alloc of payment.allocations) {
      await sql`
        UPDATE supplier_invoices
        SET amount_paid = amount_paid + ${alloc.amountAllocated}
        WHERE id = ${alloc.invoiceId}
      `;
      // Update status based on new balance
      await sql`
        UPDATE supplier_invoices SET status = CASE
          WHEN (total_amount - amount_paid) <= 0.01 THEN 'paid'
          WHEN amount_paid > 0 THEN 'partially_paid'
          ELSE status
        END
        WHERE id = ${alloc.invoiceId}
      `;
    }

    const updated = (await sql`
      UPDATE supplier_payments
      SET status = 'processed', processed_at = NOW(),
          gl_journal_entry_id = ${journalEntry.id}::UUID
      WHERE id = ${id}
      RETURNING *
    `) as Row[];

    log.info('Processed supplier payment', { id, journalEntryId: journalEntry.id }, 'accounting');
    return mapPaymentRow(updated[0]!);
  } catch (err) {
    log.error('Failed to process supplier payment', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function approveSupplierPayment(_companyId: string, 
  id: string,
  userId: string
): Promise<SupplierPayment> {
  try {
    const payment = await getSupplierPaymentById('', id);
    if (!payment) throw new Error(`Payment ${id} not found`);
    if (payment.status !== 'draft') throw new Error(`Cannot approve payment with status: ${payment.status}`);

    const rows = (await sql`
      UPDATE supplier_payments
      SET status = 'approved', approved_by = ${userId}::UUID, approved_at = NOW()
      WHERE id = ${id}
      RETURNING *
    `) as Row[];

    return mapPaymentRow(rows[0]!);
  } catch (err) {
    log.error('Failed to approve supplier payment', { id, error: err }, 'accounting');
    throw err;
  }
}

function mapPaymentRow(row: Row): SupplierPayment {
  return {
    id: String(row.id),
    paymentNumber: row.payment_number ? String(row.payment_number) : '',
    supplierId: String(row.supplier_id),
    paymentDate: String(row.payment_date),
    totalAmount: Number(row.total_amount),
    paymentMethod: String(row.payment_method) as SupplierPayment['paymentMethod'],
    bankAccountId: row.bank_account_id ? String(row.bank_account_id) : undefined,
    reference: row.reference ? String(row.reference) : undefined,
    description: row.description ? String(row.description) : undefined,
    status: String(row.status) as SupplierPayment['status'],
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    batchId: row.batch_id ? String(row.batch_id) : undefined,
    createdBy: String(row.created_by),
    approvedBy: row.approved_by ? String(row.approved_by) : undefined,
    approvedAt: row.approved_at ? String(row.approved_at) : undefined,
    processedAt: row.processed_at ? String(row.processed_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    supplierName: row.supplier_name ? String(row.supplier_name) : undefined,
  };
}

function mapAllocationRow(row: Row): PaymentAllocation {
  return {
    id: String(row.id),
    paymentId: String(row.payment_id),
    invoiceId: String(row.invoice_id),
    amountAllocated: Number(row.amount_allocated),
    createdAt: String(row.created_at),
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : undefined,
  };
}
