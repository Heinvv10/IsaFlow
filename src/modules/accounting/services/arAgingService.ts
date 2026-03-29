/**
 * PRD-060: FibreFlow Accounting Module — Phase 3
 * AR Aging Report Service
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { calculateAgingBuckets } from '../utils/aging';
import type { AgingBucket, AgingInvoice } from '../types/ap.types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

export async function getARAging(companyId: string, asAtDate?: string): Promise<AgingBucket[]> {
  try {
    const asAt = asAtDate ? new Date(asAtDate) : new Date();

    const rows = (await sql`
      SELECT ci.id, ci.client_id AS entity_id, c.company_name AS entity_name,
        ci.due_date, ci.total_amount, ci.amount_paid,
        (ci.total_amount - ci.amount_paid) AS balance
      FROM customer_invoices ci
      JOIN clients c ON c.id = ci.client_id
      WHERE ci.status IN ('approved', 'sent', 'partially_paid', 'overdue')
        AND (ci.total_amount - ci.amount_paid) > 0
        AND ci.due_date IS NOT NULL
      ORDER BY ci.due_date
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

    // Include unallocated credit notes as negative balances
    const cnRows = (await sql`
      SELECT cn.id, cn.client_id AS entity_id, c.company_name AS entity_name,
        cn.credit_date AS due_date, cn.total_amount, 0 AS amount_paid,
        -cn.total_amount AS balance
      FROM credit_notes cn
      JOIN clients c ON c.id = cn.client_id
      WHERE cn.type = 'customer' AND cn.status = 'approved'
        AND cn.customer_invoice_id IS NULL
    `) as Row[];

    for (const r of cnRows) {
      invoices.push({
        id: String(r.id),
        entityId: String(r.entity_id),
        entityName: String(r.entity_name),
        dueDate: String(r.due_date),
        totalAmount: Number(r.total_amount),
        amountPaid: Number(r.amount_paid),
        balance: Number(r.balance),
      });
    }

    return calculateAgingBuckets(invoices, asAt);
  } catch (err) {
    log.error('Failed to get AR aging', { error: err }, 'accounting');
    throw err;
  }
}

export async function getARAgingDetail(companyId: string, 
  clientId: string,
  asAtDate?: string
): Promise<{ client: { id: string; name: string }; invoices: AgingInvoice[]; buckets: AgingBucket | null }> {
  try {
    const asAt = asAtDate ? new Date(asAtDate) : new Date();

    const clientRows = (await sql`SELECT id, company_name AS name FROM clients WHERE id = ${clientId}::UUID`) as Row[];
    if (clientRows.length === 0) throw new Error(`Client ${clientId} not found`);

    const rows = (await sql`
      SELECT ci.id, ci.client_id AS entity_id, c.company_name AS entity_name,
        ci.due_date, ci.invoice_number, ci.total_amount, ci.amount_paid,
        (ci.total_amount - ci.amount_paid) AS balance
      FROM customer_invoices ci
      JOIN clients c ON c.id = ci.client_id
      WHERE ci.client_id = ${clientId}::UUID
        AND ci.status IN ('approved', 'sent', 'partially_paid', 'overdue')
        AND (ci.total_amount - ci.amount_paid) > 0
        AND ci.due_date IS NOT NULL
      ORDER BY ci.due_date
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
      client: { id: String(clientRows[0]!.id), name: String(clientRows[0]!.name) },
      invoices,
      buckets: buckets.length > 0 ? buckets[0]! : null,
    };
  } catch (err) {
    log.error('Failed to get AR aging detail', { clientId, error: err }, 'accounting');
    throw err;
  }
}
