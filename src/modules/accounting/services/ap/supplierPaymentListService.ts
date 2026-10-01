/**
 * Every supplier payment, with what it has applied and what it has not.
 *
 * `getUnappliedPayments` answers "which cash is attached to no bill" and so
 * shows only the unapplied remainder of processed payments. Matching a
 * company's payments against a Sage export needs ALL of them — every status,
 * applied or not — filterable by supplier, status, date range and reference,
 * and able to page to the last row of thousands.
 *
 * ORDER BY payment_date DESC, id DESC: a TOTAL order. Many payments share a
 * date (a payment run, a bank import), and with the date alone OFFSET pages
 * skip some and repeat others.
 *
 * `payment_allocations` carries no company_id; it is reached only through a
 * payment already fenced to the company.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export interface SupplierPaymentListFilters {
  supplierId?: string | null;
  status?: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  /** Matches payment number, reference or description (case-insensitive substring). */
  search?: string | null;
  limit: number;
  offset: number;
}

export interface SupplierPaymentListRow {
  paymentId: string;
  paymentNumber: string | null;
  paymentDate: string;
  supplierId: string;
  supplierName: string | null;
  paymentAmount: number;
  allocatedAmount: number;
  unappliedAmount: number;
  status: string | null;
  paymentMethod: string | null;
  reference: string | null;
  description: string | null;
  journalEntryId: string | null;
  batchId: string | null;
}

export interface SupplierPaymentTotals {
  paymentAmount: number;
  allocatedAmount: number;
  unappliedAmount: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function listSupplierPayments(
  companyId: string,
  f: SupplierPaymentListFilters,
): Promise<{ rows: SupplierPaymentListRow[]; total: number; totals: SupplierPaymentTotals }> {
  const supplierId = f.supplierId || null;
  const status = f.status || null;
  const fromDate = f.fromDate || null;
  const toDate = f.toDate || null;
  const search = f.search && f.search.trim() ? `%${f.search.trim()}%` : null;

  const [rows, agg] = await Promise.all([
    sql`
      SELECT sp.id, sp.payment_number, to_char(sp.payment_date, 'YYYY-MM-DD') AS payment_date,
             sp.supplier_id, s.name AS supplier_name, sp.total_amount,
             COALESCE(a.allocated, 0) AS allocated, sp.status, sp.payment_method,
             sp.reference, sp.description, sp.gl_journal_entry_id, sp.batch_id
      FROM supplier_payments sp
      LEFT JOIN suppliers s ON s.id = sp.supplier_id AND s.company_id = sp.company_id
      LEFT JOIN LATERAL (
        SELECT SUM(pa.amount_allocated) AS allocated
        FROM payment_allocations pa WHERE pa.payment_id = sp.id
      ) a ON TRUE
      WHERE sp.company_id = ${companyId}::UUID
        AND (${supplierId}::UUID IS NULL OR sp.supplier_id = ${supplierId}::UUID)
        AND (${status}::TEXT IS NULL OR sp.status = ${status}::TEXT)
        AND (${fromDate}::DATE IS NULL OR sp.payment_date >= ${fromDate}::DATE)
        AND (${toDate}::DATE IS NULL OR sp.payment_date <= ${toDate}::DATE)
        AND (${search}::TEXT IS NULL OR sp.payment_number ILIKE ${search}::TEXT
             OR sp.reference ILIKE ${search}::TEXT OR sp.description ILIKE ${search}::TEXT)
      ORDER BY sp.payment_date DESC, sp.id DESC
      LIMIT ${f.limit} OFFSET ${f.offset}`,
    sql`
      SELECT COUNT(*) AS n, COALESCE(SUM(sp.total_amount), 0) AS paid,
             COALESCE(SUM(COALESCE(a.allocated, 0)), 0) AS allocated
      FROM supplier_payments sp
      LEFT JOIN LATERAL (
        SELECT SUM(pa.amount_allocated) AS allocated
        FROM payment_allocations pa WHERE pa.payment_id = sp.id
      ) a ON TRUE
      WHERE sp.company_id = ${companyId}::UUID
        AND (${supplierId}::UUID IS NULL OR sp.supplier_id = ${supplierId}::UUID)
        AND (${status}::TEXT IS NULL OR sp.status = ${status}::TEXT)
        AND (${fromDate}::DATE IS NULL OR sp.payment_date >= ${fromDate}::DATE)
        AND (${toDate}::DATE IS NULL OR sp.payment_date <= ${toDate}::DATE)
        AND (${search}::TEXT IS NULL OR sp.payment_number ILIKE ${search}::TEXT
             OR sp.reference ILIKE ${search}::TEXT OR sp.description ILIKE ${search}::TEXT)`,
  ]);

  const a = (agg as DbRow[])[0]!;
  const paid = round2(Number(a.paid));
  const allocated = round2(Number(a.allocated));
  return {
    rows: (rows as DbRow[]).map(toRow),
    total: Number(a.n),
    totals: { paymentAmount: paid, allocatedAmount: allocated, unappliedAmount: round2(paid - allocated) },
  };
}

function toRow(r: DbRow): SupplierPaymentListRow {
  const amount = round2(Number(r.total_amount));
  const allocated = round2(Number(r.allocated));
  const str = (v: unknown) => (v == null ? null : String(v));
  return {
    paymentId: String(r.id),
    paymentNumber: str(r.payment_number),
    paymentDate: String(r.payment_date),
    supplierId: String(r.supplier_id),
    supplierName: str(r.supplier_name),
    paymentAmount: amount,
    allocatedAmount: allocated,
    unappliedAmount: round2(amount - allocated),
    status: str(r.status),
    paymentMethod: str(r.payment_method),
    reference: str(r.reference),
    description: str(r.description),
    journalEntryId: str(r.gl_journal_entry_id),
    batchId: str(r.batch_id),
  };
}
