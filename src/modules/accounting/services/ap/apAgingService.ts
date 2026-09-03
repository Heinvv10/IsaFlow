/**
 * PRD-060: FibreFlow Accounting Module — Phase 2
 * AP Aging Report Service
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { calculateAgingBuckets } from '../../utils/aging';
import type { AgingBucket, AgingInvoice } from '../../types/ap.types';
import { AP_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { fmtDate } from '@/lib/fmtDate';
import { getAPSubledger } from './apSubledgerService';
import { bucketsForSnapshot } from '../reports/agingReportService';
type Row = DbRow;


/**
 * Buckets for the UI. Reads `getAPSubledger` rather than issuing its own query:
 * the old one carried `AND si.due_date IS NOT NULL` and dropped unageable bills
 * with no error and no count. The subledger keeps them and labels them; the
 * buckets still cover only what can be aged, but the omission is now visible
 * through `getAgingReport` and `aged_creditors`.
 */
export async function getAPAging(companyId: string, asAtDate?: string): Promise<AgingBucket[]> {
  try {
    const asAt = asAtDate ?? fmtDate(new Date());
    if (asAtDate && Number.isNaN(new Date(asAtDate).getTime())) {
      throw new Error(`Invalid asAtDate: "${asAtDate}"`);
    }
    const snapshot = await getAPSubledger(companyId, asAt);
    // AP carries no dispute register; an empty map keeps one bucket implementation.
    return bucketsForSnapshot(snapshot, new Map(), asAt);
  } catch (err) {
    log.error('Failed to get AP aging', { error: err }, 'accounting');
    throw err;
  }
}

export async function getAPAgingDetail(companyId: string, 
  supplierId: string,
  asAtDate?: string
): Promise<{ supplier: { id: string; name: string }; invoices: AgingInvoice[]; buckets: AgingBucket | null }> {
  try {
    const asAt = asAtDate ? new Date(asAtDate) : new Date();
    if (asAtDate && isNaN(asAt.getTime())) {
      throw new Error(`Invalid asAtDate: "${asAtDate}"`);
    }

    const supplierRows = (await sql`SELECT id, name FROM suppliers WHERE id = ${supplierId}::UUID AND company_id = ${companyId}::UUID`) as Row[];
    if (supplierRows.length === 0) throw new Error(`Supplier ${supplierId} not found`);

    const rows = (await sql`
      SELECT si.id, si.supplier_id AS entity_id, s.name AS entity_name,
        si.due_date, si.invoice_number, si.total_amount, si.amount_paid, si.balance
      FROM supplier_invoices si
      JOIN suppliers s ON s.id = si.supplier_id
      WHERE si.company_id = ${companyId}::UUID
        AND si.supplier_id = ${supplierId}::UUID
        AND si.status = ANY(${Array.from(AP_OPEN_STATUSES)}::text[])
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
