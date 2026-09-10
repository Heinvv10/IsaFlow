import {requireArControl} from './arControlBoundary';
import {assertEffectivePermission} from '@/lib/auth/effectivePermissions';
import {resolveArAccounts} from '../controls/arControlAccounts';
/**
 * PRD-060: FibreFlow Accounting Module — Phase 3
 * Customer Payment Service
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { randomUUID } from 'crypto';
import { log } from '@/lib/logger';
import type {
  CustomerPayment,
  CustomerPaymentAllocation,
  CustomerPaymentCreateInput,
  CustomerPaymentStatus,
} from '../../types/ar.types';

type Row = DbRow;

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
    const limit = Math.min(filters?.limit || 50, 200);
    const offset = filters?.offset || 0;
    let rows: Record<string, unknown>[];
    let countRows: Record<string, unknown>[];

    if (filters?.clientId) {
      rows = (await sql`
        SELECT cp.*, c.name AS client_name,
          COALESCE((SELECT SUM(cpa.amount_allocated) FROM customer_payment_allocations cpa WHERE cpa.payment_id = cp.id AND cpa.reversed_at IS NULL), 0) AS allocated_amount
        FROM customer_payments cp LEFT JOIN customers c ON c.id = cp.client_id AND c.company_id = cp.company_id
        WHERE cp.client_id = ${filters.clientId}::UUID AND cp.company_id = ${companyId}
        ORDER BY cp.payment_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM customer_payments WHERE client_id = ${filters.clientId}::UUID AND company_id = ${companyId}
      `) as Row[];
    } else if (filters?.status) {
      rows = (await sql`
        SELECT cp.*, c.name AS client_name,
          COALESCE((SELECT SUM(cpa.amount_allocated) FROM customer_payment_allocations cpa WHERE cpa.payment_id = cp.id AND cpa.reversed_at IS NULL), 0) AS allocated_amount
        FROM customer_payments cp LEFT JOIN customers c ON c.id = cp.client_id AND c.company_id = cp.company_id
        WHERE cp.status = ${filters.status} AND cp.company_id = ${companyId}
        ORDER BY cp.payment_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM customer_payments WHERE status = ${filters.status} AND company_id = ${companyId}
      `) as Row[];
    } else {
      rows = (await sql`
        SELECT cp.*, c.name AS client_name,
          COALESCE((SELECT SUM(cpa.amount_allocated) FROM customer_payment_allocations cpa WHERE cpa.payment_id = cp.id AND cpa.reversed_at IS NULL), 0) AS allocated_amount
        FROM customer_payments cp LEFT JOIN customers c ON c.id = cp.client_id AND c.company_id = cp.company_id
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
      FROM customer_payments cp LEFT JOIN customers c ON c.id = cp.client_id AND c.company_id = cp.company_id
      WHERE cp.id = ${id} AND cp.company_id = ${companyId}
    `) as Row[];
    if (rows.length === 0) return null;

    const allocRows = (await sql`
      SELECT cpa.*, ci.invoice_number
      FROM customer_payment_allocations cpa
      JOIN customer_payments cp ON cp.id = cpa.payment_id
      LEFT JOIN customer_invoices ci ON ci.id = cpa.invoice_id AND ci.company_id = cp.company_id
      WHERE cpa.payment_id = ${id} AND cp.company_id = ${companyId}::UUID AND cpa.reversed_at IS NULL
    `) as Row[];

    return { ...mapPaymentRow(rows[0]!), allocations: allocRows.map(mapAllocationRow) };
  } catch (err) {
    log.error('Failed to get customer payment', { id, error: err }, 'accounting');
    throw err;
  }
}

/** The authority a customer payment asserts, callable by a preview that skips only the write. */
export async function assertCustomerPaymentAuthority(companyId: string, userId: string): Promise<void> {
  await assertEffectivePermission(requireArControl(companyId, userId), 'write:bank-tx');
}

export async function createCustomerPayment(companyId: string,
  input: CustomerPaymentCreateInput,
  userId: string
): Promise<CustomerPayment> {
  try {
  await assertCustomerPaymentAuthority(companyId,userId);
  const ctx=requireArControl(companyId,userId);
  const {ledgerCurrency}=await resolveArAccounts(ctx,[]);
    // Validate allocations against invoice balances. W3 (P2.1): amount_paid
    // only reflects CONFIRMED payments — without counting other DRAFT
    // payments' pending allocations, two drafts could each claim the full
    // balance and both confirm into an over-payment.
    for (const alloc of input.allocations) {
      const invRows = (await sql`
        SELECT total_amount, amount_paid FROM customer_invoices
        WHERE id = ${alloc.invoiceId}::UUID AND company_id = ${companyId}::UUID
      `) as Row[];
      if (invRows.length === 0) throw new Error(`Invoice ${alloc.invoiceId} not found`);
      const pendingRows = (await sql`
        SELECT COALESCE(SUM(cpa.amount_allocated), 0) AS pending
        FROM customer_payment_allocations cpa
        JOIN customer_payments cp ON cp.id = cpa.payment_id
        WHERE cpa.invoice_id = ${alloc.invoiceId}::UUID
          AND cp.company_id = ${companyId}::UUID
          AND cp.status = 'draft'
      `) as Row[];
      const pending = Number(pendingRows[0]?.pending ?? 0);
      const balance =
        Number(invRows[0]!.total_amount) - Number(invRows[0]!.amount_paid) - pending;
      if (alloc.amount > balance + 0.01) {
        throw new Error(
          `Allocation R${alloc.amount.toFixed(2)} exceeds invoice balance R${balance.toFixed(2)}` +
            (pending > 0 ? ` (R${pending.toFixed(2)} already pending on draft payments)` : ''),
        );
      }
    }

    const totalAllocated = input.allocations.reduce((s, a) => s + a.amount, 0);
    if (Math.abs(totalAllocated - input.totalAmount) > 0.01) {
      throw new Error(`Allocations total R${totalAllocated.toFixed(2)} does not match payment R${input.totalAmount.toFixed(2)}`);
    }

    // Pre-generate UUID so all queries can be batched atomically via HTTP transaction
    const paymentId = randomUUID();

    await sql.transaction((tx) => [
      tx`
        INSERT INTO customer_payments (
          id, company_id, client_id, payment_date, total_amount, payment_method,
          bank_reference, bank_account_id, description, project_id, created_by, currency_code
        ) VALUES (
          ${paymentId}::UUID, ${companyId}::UUID, ${input.clientId}::UUID, ${input.paymentDate}, ${input.totalAmount},
          ${input.paymentMethod || 'eft'}, ${input.bankReference || null},
          ${input.bankAccountId || null}, ${input.description || null},
          ${input.projectId || null}, ${userId}::UUID, ${ledgerCurrency}
        )
      `,
      ...input.allocations.map(alloc =>
        tx`
          INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount_allocated)
          VALUES (${paymentId}::UUID, ${alloc.invoiceId}::UUID, ${alloc.amount})
        `
      ),
    ] as ReturnType<typeof tx>[]);

    const paymentRows = (await sql`SELECT cp.*, c.name AS client_name FROM customer_payments cp LEFT JOIN customers c ON c.id = cp.client_id AND c.company_id = cp.company_id WHERE cp.id = ${paymentId}::UUID AND cp.company_id = ${companyId}::UUID`) as Row[];
    const paymentRow = paymentRows[0]!;

    log.info('Created customer payment', { paymentId, totalAmount: input.totalAmount }, 'accounting');
    return mapPaymentRow(paymentRow);
  } catch (err) {
    log.error('Failed to create customer payment', { error: err }, 'accounting');
    throw err;
  }
}

// ── Workflow functions (re-exported from customerPaymentAllocationService) ────

export {
  confirmCustomerPayment,
  cancelCustomerPayment,
  postCustomerInvoiceToGL,
} from './customerPaymentAllocationService';

function mapPaymentRow(row: Row): CustomerPayment {
  return {
    id: String(row.id),
    paymentNumber: row.payment_number ? String(row.payment_number) : '',
    clientId: String(row.client_id),
    paymentDate: fmtDate(row.payment_date),
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
