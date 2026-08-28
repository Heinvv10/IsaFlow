/**
 * PRD-060: FibreFlow Accounting Module — Phase 2
 * Supplier Payment Service
 * Workflow operations (approve, process) split to supplierPaymentWorkflowService.ts
 */

import { sql, withTransaction } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { validatePaymentAllocations } from '../../utils/paymentAllocation';
import type {
  SupplierPayment,
  PaymentAllocation,
  PaymentAllocationInput,
  PaymentMethod,
  PaymentStatus,
  InvoiceForAllocation,
} from '../../types/ap.types';
type Row = DbRow;


interface PaymentFilters {
  status?: PaymentStatus;
  supplierId?: string;
  limit?: number;
  offset?: number;
}

export interface CreatePaymentInput {
  supplierId: string;
  paymentDate: string;
  totalAmount: number;
  paymentMethod?: PaymentMethod;
  bankAccountId?: string;
  reference?: string;
  description?: string;
  allocations: PaymentAllocationInput[];
}

export async function getSupplierPayments(companyId: string, filters?: PaymentFilters): Promise<{
  payments: SupplierPayment[];
  total: number;
}> {
  try {
    // Sanitise: NaN / negative values from query-string coercion become safe defaults.
    const rawLimit = filters?.limit;
    const rawOffset = filters?.offset;
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
    const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    let rows: Row[];
    let countRows: Row[];

    if (filters?.status && filters?.supplierId) {
      rows = (await sql`
        SELECT sp.*, s.name AS supplier_name
        FROM supplier_payments sp LEFT JOIN suppliers s ON s.id = sp.supplier_id
        WHERE sp.company_id = ${companyId}::UUID
          AND sp.status = ${filters.status} AND sp.supplier_id = ${filters.supplierId}
        ORDER BY sp.payment_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM supplier_payments
        WHERE company_id = ${companyId}::UUID
          AND status = ${filters.status} AND supplier_id = ${filters.supplierId}
      `) as Row[];
    } else if (filters?.status) {
      rows = (await sql`
        SELECT sp.*, s.name AS supplier_name
        FROM supplier_payments sp LEFT JOIN suppliers s ON s.id = sp.supplier_id
        WHERE sp.company_id = ${companyId}::UUID AND sp.status = ${filters.status}
        ORDER BY sp.payment_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM supplier_payments
        WHERE company_id = ${companyId}::UUID AND status = ${filters.status}
      `) as Row[];
    } else if (filters?.supplierId) {
      rows = (await sql`
        SELECT sp.*, s.name AS supplier_name
        FROM supplier_payments sp LEFT JOIN suppliers s ON s.id = sp.supplier_id
        WHERE sp.company_id = ${companyId}::UUID AND sp.supplier_id = ${filters.supplierId}
        ORDER BY sp.payment_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM supplier_payments
        WHERE company_id = ${companyId}::UUID AND supplier_id = ${filters.supplierId}
      `) as Row[];
    } else {
      rows = (await sql`
        SELECT sp.*, s.name AS supplier_name
        FROM supplier_payments sp LEFT JOIN suppliers s ON s.id = sp.supplier_id
        WHERE sp.company_id = ${companyId}::UUID
        ORDER BY sp.payment_date DESC LIMIT ${limit} OFFSET ${offset}
      `) as Row[];
      countRows = (await sql`
        SELECT COUNT(*) AS cnt FROM supplier_payments WHERE company_id = ${companyId}::UUID
      `) as Row[];
    }

    return { payments: rows.map(mapPaymentRow), total: Number(countRows[0]!.cnt) };
  } catch (err) {
    log.error('Failed to get supplier payments', { error: err }, 'accounting');
    throw err;
  }
}

export async function getSupplierPaymentById(companyId: string,
  id: string,
): Promise<(SupplierPayment & { allocations: PaymentAllocation[] }) | null> {
  try {
    const rows = (await sql`
      SELECT sp.*, s.name AS supplier_name
      FROM supplier_payments sp LEFT JOIN suppliers s ON s.id = sp.supplier_id
      WHERE sp.id = ${id} AND sp.company_id = ${companyId}::UUID
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

export async function createSupplierPayment(companyId: string,
  input: CreatePaymentInput,
  userId: string,
): Promise<SupplierPayment> {
  try {
    const invoiceIds = input.allocations.map(a => a.invoiceId);
    const invoiceRows = (await sql`
      SELECT id, invoice_number, total_amount, amount_paid, balance
      FROM supplier_invoices
      WHERE id = ANY(${invoiceIds}::UUID[])
        AND company_id = ${companyId}::UUID
    `) as Row[];
    if (invoiceRows.length !== invoiceIds.length) {
      throw new Error('One or more invoice IDs not found or belong to a different company');
    }

    // W3-AP (P2.1): amount_paid only moves at PROCESS time — without counting
    // unprocessed (draft/approved) payments' pending allocations, two drafts
    // could each claim the full balance and both process into an over-payment
    // (same bug class as the customer-side W3 fix).
    // payment_allocations is the LIVE table (mig 201's supplier_payment_
    // allocations has 0 rows in dev AND prod — every writer in this file,
    // batchPaymentService, and the process/void readers use payment_allocations).
    const pendingRows = (await sql`
      SELECT pa.invoice_id, COALESCE(SUM(pa.amount_allocated), 0) AS pending
      FROM payment_allocations pa
      JOIN supplier_payments sp ON sp.id = pa.payment_id
      WHERE pa.invoice_id = ANY(${invoiceIds}::UUID[])
        AND sp.company_id = ${companyId}::UUID
        AND sp.status IN ('draft', 'approved')
      GROUP BY pa.invoice_id
    `) as Row[];
    const pendingByInvoice = new Map(pendingRows.map((r) => [String(r.invoice_id), Number(r.pending)]));

    const invoices: InvoiceForAllocation[] = invoiceRows.map((r: Row) => {
      const pending = pendingByInvoice.get(String(r.id)) ?? 0;
      return {
        id: String(r.id),
        invoiceNumber: String(r.invoice_number),
        totalAmount: Number(r.total_amount),
        amountPaid: Number(r.amount_paid) + pending,
        balance: Number(r.balance) - pending,
      };
    });

    const validation = validatePaymentAllocations(input.totalAmount, input.allocations, invoices);
    if (!validation.valid) {
      throw new Error(`Invalid allocations: ${validation.errors.join('; ')}`);
    }

    const paymentRow = await withTransaction(async (tx) => {
      const rows = (await tx`
        INSERT INTO supplier_payments (
          company_id, supplier_id, payment_date, total_amount, payment_method,
          bank_account_id, reference, description, created_by
        ) VALUES (
          ${companyId}::UUID, ${input.supplierId}, ${input.paymentDate}, ${input.totalAmount},
          ${input.paymentMethod || 'eft'}, ${input.bankAccountId || null},
          ${input.reference || null}, ${input.description || null}, ${userId}::UUID
        ) RETURNING *
      `) as Row[];

      const paymentId = String(rows[0]!.id);

      for (const alloc of input.allocations) {
        await tx`
          INSERT INTO payment_allocations (payment_id, invoice_id, amount_allocated)
          VALUES (${paymentId}::UUID, ${alloc.invoiceId}::UUID, ${alloc.amount})
        `;
      }

      return rows[0] as Row;
    });

    log.info('Created supplier payment', {
      paymentId: String(paymentRow.id),
      paymentNumber: String(paymentRow.payment_number),
      totalAmount: input.totalAmount,
    }, 'accounting');

    return mapPaymentRow(paymentRow);
  } catch (err) {
    log.error('Failed to create supplier payment', { error: err }, 'accounting');
    throw err;
  }
}

// Workflow operations (approve, process) re-exported from split file
export { approveSupplierPayment, processSupplierPayment } from './supplierPaymentWorkflowService';

export function mapPaymentRow(row: Row): SupplierPayment {
  return {
    id: String(row.id),
    paymentNumber: row.payment_number ? String(row.payment_number) : '',
    supplierId: String(row.supplier_id),
    paymentDate: fmtDate(row.payment_date),
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
