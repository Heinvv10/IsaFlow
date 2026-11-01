/**
 * The approved, unallocated customer credit notes `getARAging` appends to the
 * open invoices — a note not tied to an invoice (`customer_invoice_id IS NULL`)
 * is a credit on the customer's account.
 *
 * Own function so the read can be tested where it is exported: these rows are
 * pushed with a NEGATIVE balance and `calculateAgingBuckets` drops every
 * balance <= 0, so nothing about them is observable through the buckets.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { AgingInvoice } from '../../types/ap.types';
import { UNKNOWN_CUSTOMER } from './arAgingInvoices';

export async function fetchUnallocatedCreditNotes(
  companyId: string,
  asAtStr: string,
): Promise<AgingInvoice[]> {
  const rows = (await sql`
    SELECT cn.id, cn.client_id AS entity_id, COALESCE(c.name, ${UNKNOWN_CUSTOMER}) AS entity_name,
      cn.credit_date AS due_date, cn.total_amount, 0 AS amount_paid,
      -cn.total_amount AS balance
    FROM credit_notes cn
    -- credit_notes.client_id is a bare FK to customers(id): without the
    -- company_id match a note could name another tenant's customer. LEFT, as
    -- the open invoices: such a note stays, under UNKNOWN_CUSTOMER.
    LEFT JOIN customers c ON c.id = cn.client_id AND c.company_id = cn.company_id
    WHERE cn.company_id = ${companyId}
      AND cn.type = 'customer' AND cn.status = 'approved'
      AND cn.customer_invoice_id IS NULL
      -- A note with no party has no line to age on; the LEFT must not admit it.
      AND cn.client_id IS NOT NULL
      -- A credit note granted after the as-at date had not reduced the
      -- customer's balance on that date.
      --
      -- This filter is currently INERT and kept only so it stays correct if
      -- the behaviour below changes: these rows are pushed with a NEGATIVE
      -- balance, and calculateAgingBuckets drops everything with balance <= 0,
      -- so an unallocated credit note never reaches a bucket at any as-at
      -- date. That AR aging does not net unallocated credit is pre-existing
      -- and out of scope here — it is noted so the next reader does not
      -- conclude from this filter that it does.
      AND cn.credit_date <= ${asAtStr}::date
  `) as DbRow[];

  return rows.map((r) => ({
    id: String(r.id),
    entityId: String(r.entity_id),
    entityName: String(r.entity_name),
    dueDate: String(r.due_date),
    totalAmount: Number(r.total_amount),
    amountPaid: Number(r.amount_paid),
    balance: Number(r.balance),
  }));
}
