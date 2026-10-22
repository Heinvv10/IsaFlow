/**
 * The on-account credit the aged reports net, ONE ROW PER DOCUMENT: payments
 * or receipts their allocations do not consume, and the face value a live
 * credit note has not consumed — as at a date.
 *
 * `agedNetting.getUnappliedByEntity` is these rows summed per entity, and the
 * `ap_open_items` / `ar_open_items` exports list them as they are, so the
 * export's negative rows are exactly what aged_creditors / aged_debtors take
 * off the gross. The rules (status sets, cent tolerance, refunds carried with
 * their own sign, a counterparty that must resolve) are documented on
 * getUnappliedByEntity.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { EPS } from './autoAllocateStrategy';

export type UnappliedSide = 'ar' | 'ap';

export interface UnappliedDocument {
  kind: 'payment' | 'credit_note';
  id: string;
  /** Payment or credit-note number; null when none was issued. */
  number: string | null;
  /** YYYY-MM-DD: payment_date or credit_date. */
  date: string;
  entityId: string;
  entityName: string;
  /** The document's face value (a refund is negative). */
  totalAmount: number;
  /** What is left unconsumed — the figure netted off the entity. */
  amount: number;
  /** Bank reference (payments) or source-system number (credit notes), when captured. */
  reference: string | null;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
}

const text = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

function toDocument(kind: UnappliedDocument['kind'], r: DbRow): UnappliedDocument {
  return {
    kind,
    id: String(r.id),
    number: text(r.doc_number),
    date: fmtDate(r.doc_date),
    entityId: String(r.entity_id),
    entityName: String(r.entity_name ?? ''),
    totalAmount: Number(r.total_amount),
    amount: Number(r.amount),
    reference: text(r.reference),
    cc1Id: text(r.cc1_id),
    cc2Id: text(r.cc2_id),
    buId: text(r.bu_id),
  };
}

export async function getUnappliedDocuments(
  companyId: string,
  side: UnappliedSide,
  asAt: string,
): Promise<UnappliedDocument[]> {
  const cashRows = (side === 'ar'
    ? await sql`
        SELECT cp.id, cp.payment_number AS doc_number, cp.payment_date AS doc_date,
               cp.client_id AS entity_id, COALESCE(c.name, '') AS entity_name,
               cp.total_amount, cp.bank_reference AS reference,
               NULL::UUID AS cc1_id, NULL::UUID AS cc2_id, NULL::UUID AS bu_id,
               cp.total_amount
                 - LEAST(COALESCE(alloc.allocated, 0), GREATEST(cp.total_amount, 0)) AS amount
        FROM customer_payments cp
        JOIN customers c ON c.id = cp.client_id AND c.company_id = cp.company_id
        LEFT JOIN LATERAL (
          SELECT SUM(cpa.amount_allocated) AS allocated
          FROM customer_payment_allocations cpa
          WHERE cpa.payment_id = cp.id
        ) alloc ON TRUE
        WHERE cp.company_id = ${companyId}::UUID
          AND cp.status <> 'cancelled'
          AND cp.payment_date <= ${asAt}::DATE
          AND ABS(cp.total_amount
                  - LEAST(COALESCE(alloc.allocated, 0), GREATEST(cp.total_amount, 0))) > ${EPS}
        ORDER BY cp.payment_date, cp.id`
    : await sql`
        SELECT sp.id, sp.payment_number AS doc_number, sp.payment_date AS doc_date,
               sp.supplier_id AS entity_id, COALESCE(s.name, '') AS entity_name,
               sp.total_amount, sp.reference,
               NULL::UUID AS cc1_id, NULL::UUID AS cc2_id, NULL::UUID AS bu_id,
               sp.total_amount
                 - LEAST(COALESCE(alloc.allocated, 0), GREATEST(sp.total_amount, 0)) AS amount
        FROM supplier_payments sp
        JOIN suppliers s ON s.id = sp.supplier_id AND s.company_id = sp.company_id
        LEFT JOIN LATERAL (
          SELECT SUM(pa.amount_allocated) AS allocated
          FROM payment_allocations pa
          WHERE pa.payment_id = sp.id
        ) alloc ON TRUE
        WHERE sp.company_id = ${companyId}::UUID
          AND sp.status IN ('processed', 'reconciled')
          AND sp.payment_date <= ${asAt}::DATE
          AND ABS(sp.total_amount
                  - LEAST(COALESCE(alloc.allocated, 0), GREATEST(sp.total_amount, 0))) > ${EPS}
        ORDER BY sp.payment_date, sp.id`) as DbRow[];

  // `type` discriminates; the entity column is whichever of the two is populated.
  const creditRows = (await sql`
    SELECT cn.id, cn.credit_note_number AS doc_number, cn.credit_date AS doc_date,
           COALESCE(cn.client_id, cn.supplier_id) AS entity_id,
           COALESCE(c.name, s.name, '') AS entity_name,
           cn.total_amount, cn.external_document_number AS reference, cn.cc1_id, cn.cc2_id, cn.bu_id,
           (cn.total_amount - cn.applied_amount) AS amount
    FROM credit_notes cn
    LEFT JOIN customers c ON c.id = cn.client_id AND c.company_id = cn.company_id
    LEFT JOIN suppliers s ON s.id = cn.supplier_id AND s.company_id = cn.company_id
    WHERE cn.company_id = ${companyId}::UUID
      AND cn.type = ${side === 'ar' ? 'customer' : 'supplier'}
      AND cn.status IN ('approved', 'partially_applied')
      AND cn.credit_date <= ${asAt}::DATE
      AND (cn.total_amount - cn.applied_amount) > ${EPS}
      AND COALESCE(cn.client_id, cn.supplier_id) IS NOT NULL
    ORDER BY cn.credit_date, cn.id
  `) as DbRow[];

  return [
    ...cashRows.map((r) => toDocument('payment', r)),
    ...creditRows.map((r) => toDocument('credit_note', r)),
  ];
}
