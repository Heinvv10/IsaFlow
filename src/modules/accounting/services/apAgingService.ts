/**
 * PRD-060: FibreFlow Accounting Module — Phase 2
 * AP Aging Report Service
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { calculateAgingBuckets } from '../utils/aging';
import type { AgingBucket, AgingInvoice } from '../types/ap.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export async function getAPAging(asAtDate?: string): Promise<AgingBucket[]> {
  try {
    const asAt = asAtDate ? new Date(asAtDate) : new Date();

    const rows = (await sql`
      SELECT si.id, si.supplier_id AS entity_id, s.name AS entity_name,
        si.due_date, si.total_amount, si.amount_paid, si.balance
      FROM supplier_invoices si
      JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.status IN ('approved', 'partially_paid')
        AND si.balance > 0
        AND si.due_date IS NOT NULL
      ORDER BY si.due_date
    `) as Row[];

    const invoices: AgingInvoice[] = rows.map((r: Row) => ({
      id: String(r.id),
      entityId: String(r.entity_id),
      entityName: String(r.entity_name),
      dueDate: String(r.due_date),
      totalAmount: Number(r.total_amount),
      amountPaid: Number(r.amount_paid),
      balance: Number(r.balance),
    }));

    return calculateAgingBuckets(invoices, asAt);
  } catch (err) {
    log.error('Failed to get AP aging', { error: err }, 'accounting');
    throw err;
  }
}

export async function getAPAgingDetail(
  supplierId: string,
  asAtDate?: string
): Promise<{ supplier: { id: string; name: string }; invoices: AgingInvoice[]; buckets: AgingBucket | null }> {
  try {
    const asAt = asAtDate ? new Date(asAtDate) : new Date();

    const supplierRows = (await sql`SELECT id, name FROM suppliers WHERE id = ${Number(supplierId)}`) as Row[];
    if (supplierRows.length === 0) throw new Error(`Supplier ${supplierId} not found`);

    const rows = (await sql`
      SELECT si.id, si.supplier_id AS entity_id, s.name AS entity_name,
        si.due_date, si.invoice_number, si.total_amount, si.amount_paid, si.balance
      FROM supplier_invoices si
      JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.supplier_id = ${Number(supplierId)}
        AND si.status IN ('approved', 'partially_paid')
        AND si.balance > 0
        AND si.due_date IS NOT NULL
      ORDER BY si.due_date
    `) as Row[];

    const invoices: AgingInvoice[] = rows.map((r: Row) => ({
      id: String(r.id),
      entityId: String(r.entity_id),
      entityName: String(r.entity_name),
      dueDate: String(r.due_date),
      totalAmount: Number(r.total_amount),
      amountPaid: Number(r.amount_paid),
      balance: Number(r.balance),
    }));

    const buckets = calculateAgingBuckets(invoices, asAt);

    return {
      supplier: { id: String(supplierRows[0]!.id), name: String(supplierRows[0]!.name) },
      invoices,
      buckets: buckets.length > 0 ? buckets[0]! : null,
    };
  } catch (err) {
    log.error('Failed to get AP aging detail', { supplierId, error: err }, 'accounting');
    throw err;
  }
}
