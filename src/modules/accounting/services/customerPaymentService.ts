/**
 * PRD-060: FibreFlow Accounting Module — Phase 3
 * Customer Payment Service
 */

import { sql, withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import { createJournalEntry, postJournalEntry, reverseJournalEntry } from './journalEntryService';
import { getSystemAccount, getSystemAccountId } from './systemAccountResolver';
import type {
  CustomerPayment,
  CustomerPaymentAllocation,
  CustomerPaymentCreateInput,
  CustomerPaymentStatus,
} from '../types/ar.types';
import type { JournalLineInput } from '../types/gl.types';

type Row = Record<string, unknown>;

interface PaymentFilters {
  status?: CustomerPaymentStatus;
  clientId?: string;
  limit?: number;
  offset?: number;
}

export async function getCustomerPayments(companyId: string, filters?: PaymentFilters): Promise<{
  payments: CustomerPayment[];
  total: number;
}> {
  try {
    const limit = filters?.limit || 50;
    const offset = filters?.offset || 0;
    let rows: Record<string, unknown>[];
    let countRows: Record<string, unknown>[];

    if (filters?.clientId) {
      rows = (await sql`
        SELECT cp.*, c.name AS client_name,
          COALESCE((SELECT SUM(cpa.amount_allocated) FROM customer_payment_allocations cpa WHERE cpa.payment_id = cp.id), 0) AS allocated_amount
        FROM customer_payments cp LEFT JOIN customers c ON c.id = cp.client_id
        WHERE cp.client_id = ${filters.clientId}::UUID AND cp.company_id = ${companyId}
        ORDER BY cp.payment_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM customer_payments WHERE client_id = ${filters.clientId}::UUID AND company_id = ${companyId}
      `) as Row[];
    } else if (filters?.status) {
      rows = (await sql`
        SELECT cp.*, c.name AS client_name,
          COALESCE((SELECT SUM(cpa.amount_allocated) FROM customer_payment_allocations cpa WHERE cpa.payment_id = cp.id), 0) AS allocated_amount
        FROM customer_payments cp LEFT JOIN customers c ON c.id = cp.client_id
        WHERE cp.status = ${filters.status} AND cp.company_id = ${companyId}
        ORDER BY cp.payment_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM customer_payments WHERE status = ${filters.status} AND company_id = ${companyId}
      `) as Row[];
    } else {
      rows = (await sql`
        SELECT cp.*, c.name AS client_name,
          COALESCE((SELECT SUM(cpa.amount_allocated) FROM customer_payment_allocations cpa WHERE cpa.payment_id = cp.id), 0) AS allocated_amount
        FROM customer_payments cp LEFT JOIN customers c ON c.id = cp.client_id
        WHERE cp.company_id = ${companyId}
        ORDER BY cp.payment_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`SELECT COUNT(*) AS cnt FROM customer_payments WHERE company_id = ${companyId}`) as Row[];
    }

    return { payments: rows.map(mapPaymentRow), total: Number(countRows[0]!.cnt) };
  } catch (err) {
    log.error('Failed to get customer payments', { error: err }, 'accounting');
    throw err;
  }
}

export async function getCustomerPaymentById(companyId: string, 
  id: string
): Promise<(CustomerPayment & { allocations: CustomerPaymentAllocation[] }) | null> {
  try {
    const rows = (await sql`
      SELECT cp.*, c.name AS client_name
      FROM customer_payments cp LEFT JOIN customers c ON c.id = cp.client_id
      WHERE cp.id = ${id} AND cp.company_id = ${companyId}
    `) as Row[];
    if (rows.length === 0) return null;

    const allocRows = (await sql`
      SELECT cpa.*, ci.invoice_number
      FROM customer_payment_allocations cpa
      LEFT JOIN customer_invoices ci ON ci.id = cpa.invoice_id
      WHERE cpa.payment_id = ${id}
    `) as Row[];

    return { ...mapPaymentRow(rows[0]!), allocations: allocRows.map(mapAllocationRow) };
  } catch (err) {
    log.error('Failed to get customer payment', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function createCustomerPayment(companyId: string, 
  input: CustomerPaymentCreateInput,
  userId: string
): Promise<CustomerPayment> {
  try {
    // Validate allocations against invoice balances
    for (const alloc of input.allocations) {
      const invRows = (await sql`
        SELECT total_amount, amount_paid FROM customer_invoices WHERE id = ${alloc.invoiceId}::UUID
      `) as Row[];
      if (invRows.length === 0) throw new Error(`Invoice ${alloc.invoiceId} not found`);
      const balance = Number(invRows[0]!.total_amount) - Number(invRows[0]!.amount_paid);
      if (alloc.amount > balance + 0.01) {
        throw new Error(`Allocation R${alloc.amount.toFixed(2)} exceeds invoice balance R${balance.toFixed(2)}`);
      }
    }

    const totalAllocated = input.allocations.reduce((s, a) => s + a.amount, 0);
    if (Math.abs(totalAllocated - input.totalAmount) > 0.01) {
      throw new Error(`Allocations total R${totalAllocated.toFixed(2)} does not match payment R${input.totalAmount.toFixed(2)}`);
    }

    const paymentRow = await withTransaction(async (tx) => {
      const rows = (await tx`
        INSERT INTO customer_payments (
          client_id, payment_date, total_amount, payment_method,
          bank_reference, bank_account_id, description, project_id, created_by
        ) VALUES (
          ${input.clientId}::UUID, ${input.paymentDate}, ${input.totalAmount},
          ${input.paymentMethod || 'eft'}, ${input.bankReference || null},
          ${input.bankAccountId || null}, ${input.description || null},
          ${input.projectId || null}, ${userId}::UUID
        ) RETURNING *
      `) as Row[];

      const paymentId = String(rows[0]!.id);

      for (const alloc of input.allocations) {
        await tx`
          INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
          VALUES (${paymentId}::UUID, ${alloc.invoiceId}::UUID, ${alloc.amount})
        `;
      }

      return rows[0] as Row;
    });

    log.info('Created customer payment', { paymentId: String(paymentRow.id), totalAmount: input.totalAmount }, 'accounting');
    return mapPaymentRow(paymentRow);
  } catch (err) {
    log.error('Failed to create customer payment', { error: err }, 'accounting');
    throw err;
  }
}

export async function confirmCustomerPayment(companyId: string, 
  id: string,
  userId: string
): Promise<CustomerPayment> {
  try {
    const payment = await getCustomerPaymentById(companyId, id);
    if (!payment) throw new Error(`Payment ${id} not found`);
    if (payment.status !== 'draft') throw new Error(`Cannot confirm payment with status: ${payment.status}`);

    // Auto-post GL: DR Bank, CR Accounts Receivable
    const arAccount = await getSystemAccount('receivable');
    const bankAccount = payment.bankAccountId
      ? ((await sql`SELECT id FROM gl_accounts WHERE id = ${payment.bankAccountId}`) as Row[])[0]
      : await getSystemAccount('bank');
    if (!bankAccount) throw new Error('Bank account not found');

    const lines: JournalLineInput[] = [
      { glAccountId: String(bankAccount.id), debit: payment.totalAmount, credit: 0,
        description: `Customer payment ${payment.paymentNumber}` },
      { glAccountId: arAccount.id, debit: 0, credit: payment.totalAmount,
        description: `Customer payment ${payment.paymentNumber}` },
    ];

    const je = await createJournalEntry(companyId, {
      entryDate: payment.paymentDate,
      description: `Customer payment ${payment.paymentNumber}`,
      source: 'auto_payment',
      sourceDocumentId: id,
      lines,
    }, userId);
    await postJournalEntry(companyId, je.id, userId);

    // Update invoice balances and mark payment confirmed atomically
    const updated = await withTransaction(async (tx) => {
      for (const alloc of payment.allocations) {
        await tx`
          UPDATE customer_invoices SET amount_paid = amount_paid + ${alloc.amountAllocated}
          WHERE id = ${alloc.invoiceId}::UUID
        `;
        await tx`
          UPDATE customer_invoices SET status = CASE
            WHEN (total_amount - amount_paid) <= 0.01 THEN 'paid'
            WHEN amount_paid > 0 THEN 'partially_paid'
            ELSE status
          END, paid_at = CASE WHEN (total_amount - amount_paid) <= 0.01 THEN NOW() ELSE paid_at END
          WHERE id = ${alloc.invoiceId}::UUID
        `;
      }

      const rows = (await tx`
        UPDATE customer_payments
        SET status = 'confirmed', confirmed_by = ${userId}::UUID, confirmed_at = NOW(),
            gl_journal_entry_id = ${je.id}::UUID
        WHERE id = ${id} RETURNING *
      `) as Row[];

      return rows[0] as Row;
    });

    log.info('Confirmed customer payment', { id, journalEntryId: je.id }, 'accounting');
    return mapPaymentRow(updated);
  } catch (err) {
    log.error('Failed to confirm customer payment', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function cancelCustomerPayment(companyId: string, 
  id: string,
  userId: string,
  reason?: string
): Promise<CustomerPayment> {
  try {
    const payment = await getCustomerPaymentById(companyId, id);
    if (!payment) throw new Error(`Payment ${id} not found`);
    if (payment.status !== 'confirmed') {
      throw new Error(`Cannot cancel payment with status: ${payment.status}`);
    }

    // Reverse GL journal entry
    if (payment.glJournalEntryId) {
      await reverseJournalEntry(companyId, payment.glJournalEntryId, userId);
    }

    // Reverse invoice balance updates
    for (const alloc of payment.allocations) {
      await sql`
        UPDATE customer_invoices
        SET amount_paid = GREATEST(0, amount_paid - ${alloc.amountAllocated})
        WHERE id = ${alloc.invoiceId}::UUID
      `;
      await sql`
        UPDATE customer_invoices SET status = CASE
          WHEN amount_paid <= 0.01 THEN 'approved'
          WHEN amount_paid < total_amount THEN 'partially_paid'
          ELSE status
        END, paid_at = CASE WHEN amount_paid <= 0.01 THEN NULL ELSE paid_at END
        WHERE id = ${alloc.invoiceId}::UUID
      `;
    }

    const updated = (await sql`
      UPDATE customer_payments
      SET status = 'cancelled', cancelled_by = ${userId}::UUID,
          cancelled_at = NOW(), cancel_reason = ${reason || null}
      WHERE id = ${id} RETURNING *
    `) as Row[];

    log.info('Cancelled customer payment', { id, reason }, 'accounting');
    return mapPaymentRow(updated[0]!);
  } catch (err) {
    log.error('Failed to cancel customer payment', { id, error: err }, 'accounting');
    throw err;
  }
}

export async function postCustomerInvoiceToGL(companyId: string, invoiceId: string, userId: string): Promise<string> {
  try {
    const invRows = (await sql`
      SELECT ci.*, c.name AS client_name
      FROM customer_invoices ci LEFT JOIN customers c ON c.id = ci.client_id
      WHERE ci.id = ${invoiceId}::UUID
    `) as Row[];
    if (invRows.length === 0) throw new Error(`Invoice ${invoiceId} not found`);
    const inv = invRows[0]!;

    if (inv.gl_journal_entry_id) return String(inv.gl_journal_entry_id);

    const arAccount = await getSystemAccount('receivable');
    const revenueAccount = await getSystemAccount('default_revenue');
    const vatAccount = await getSystemAccount('vat_output');

    const lines: JournalLineInput[] = [
      { glAccountId: arAccount.id, debit: Number(inv.total_amount), credit: 0,
        description: `AR: ${inv.invoice_number}` },
      { glAccountId: revenueAccount.id, debit: 0, credit: Number(inv.subtotal),
        description: `Revenue: ${inv.invoice_number}` },
    ];

    if (Number(inv.tax_amount) > 0) {
      lines.push({
        glAccountId: vatAccount.id, debit: 0, credit: Number(inv.tax_amount),
        description: `VAT Output: ${inv.invoice_number}`,
      });
    }

    const je = await createJournalEntry(companyId, {
      entryDate: String(inv.invoice_date),
      description: `Customer invoice ${inv.invoice_number}`,
      source: 'auto_invoice',
      sourceDocumentId: invoiceId,
      lines,
    }, userId);
    await postJournalEntry(companyId, je.id, userId);

    await sql`UPDATE customer_invoices SET gl_journal_entry_id = ${je.id}::UUID WHERE id = ${invoiceId}::UUID`;

    log.info('Posted customer invoice to GL', { invoiceId, journalEntryId: je.id }, 'accounting');
    return je.id;
  } catch (err) {
    log.error('Failed to post customer invoice to GL', { invoiceId, error: err }, 'accounting');
    throw err;
  }
}

function mapPaymentRow(row: Row): CustomerPayment {
  return {
    id: String(row.id),
    paymentNumber: row.payment_number ? String(row.payment_number) : '',
    clientId: String(row.client_id),
    paymentDate: String(row.payment_date),
    totalAmount: Number(row.total_amount),
    paymentMethod: String(row.payment_method) as CustomerPayment['paymentMethod'],
    bankReference: row.bank_reference ? String(row.bank_reference) : undefined,
    bankAccountId: row.bank_account_id ? String(row.bank_account_id) : undefined,
    description: row.description ? String(row.description) : undefined,
    status: String(row.status) as CustomerPaymentStatus,
    glJournalEntryId: row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : undefined,
    projectId: row.project_id ? String(row.project_id) : undefined,
    createdBy: String(row.created_by),
    confirmedBy: row.confirmed_by ? String(row.confirmed_by) : undefined,
    confirmedAt: row.confirmed_at ? String(row.confirmed_at) : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    clientName: row.client_name ? String(row.client_name) : undefined,
    allocatedAmount: row.allocated_amount !== undefined ? Number(row.allocated_amount) : 0,
  };
}

function mapAllocationRow(row: Row): CustomerPaymentAllocation & { amount: number } {
  const amt = Number(row.amount_allocated || row.amount || 0);
  return {
    id: String(row.id),
    paymentId: String(row.payment_id),
    invoiceId: String(row.invoice_id),
    amountAllocated: amt,
    amount: amt,
    createdAt: String(row.created_at),
    invoiceNumber: row.invoice_number ? String(row.invoice_number) : undefined,
  };
}
