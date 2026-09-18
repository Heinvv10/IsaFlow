/**
 * What an entity actually owes, once the credit sitting against its name is
 * taken off.
 *
 * ── WHY THE AGED TOTAL WAS NEVER THE ANSWER ─────────────────────────────────
 *
 * Aged debtors and aged creditors bucket OPEN DOCUMENTS. Cash received against
 * no invoice, and credit granted against no bill, are in none of those buckets —
 * so an entity with R10,000 of open bills and an R8,000 payment nobody applied
 * read as R10,000 owing on a report used to decide who gets paid. The MCP tools
 * named the figure in a footer and deliberately did not net it, because netting
 * a company-wide number onto per-entity rows would have invented a figure no
 * report owned.
 *
 * That objection disappears once the credit is attributed PER ENTITY, which is
 * what this module does. The buckets stay gross — the age of a debt is a fact
 * about the documents and netting would destroy it — and every row carries
 * `unapplied` (negative) and `net` beside them.
 *
 * ── WHAT COUNTS AS UNAPPLIED ────────────────────────────────────────────────
 *
 *  · a payment or receipt with a document, dated on or before the as-at date,
 *    whose allocations do not consume it;
 *  · the face value a live credit note has not consumed.
 *
 * Both are read as at the report's date, so a payment made after it is not
 * netted off an earlier balance.
 *
 * ── THE ONE THING THIS CANNOT NET ───────────────────────────────────────────
 *
 * Cash whose counterparty cannot be resolved — a payment whose supplier row was
 * deleted — has no entity to attach to, so it stays in the footer total and out
 * of every `net`. The footer is therefore the larger, and correctly so; the
 * difference is exactly the unattributable cash the footer already reports.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { AgingBucket } from '../../types/ap.types';
import type { CreditNoteSide } from './creditNoteFifo';
import { EPS, round2 } from './autoAllocateStrategy';

export type AgedSide = 'ar' | 'ap';

export interface EntityUnapplied {
  entityName: string;
  /** Unapplied cash: receipts on AR, payments on AP. */
  payments: number;
  /** Face value live credit notes have not consumed. */
  creditNotes: number;
  /** The two added — the amount that comes off this entity's gross. */
  total: number;
}

/**
 * An aged row with the credit netted. `total` and the buckets are unchanged and
 * still gross; `unapplied` is NEGATIVE so that `net = total + unapplied` reads
 * as an addition rather than asking the reader to remember a sign.
 */
export interface NettedAgingRow extends AgingBucket {
  unapplied: number;
  net: number;
}

/**
 * Merge the per-entity credit into the aged rows, and emit a row for an entity
 * that has credit and NO open document — otherwise the report's net total
 * silently omits the entities most worth seeing, the ones in credit.
 */
export function netAgingRows(
  rows: readonly AgingBucket[],
  unapplied: ReadonlyMap<string, EntityUnapplied>,
): NettedAgingRow[] {
  const out: NettedAgingRow[] = rows.map((row) => {
    const credit = round2(unapplied.get(row.entityId)?.total ?? 0);
    // `credit === 0 ? 0 : -credit` rather than a bare negation: JSON.stringify
    // renders -0 as `-0`, and an aged row reporting "-0 unapplied" reads as a
    // rounding artefact nobody can explain.
    return { ...row, unapplied: credit === 0 ? 0 : -credit, net: round2(row.total - credit) };
  });

  const seen = new Set(rows.map((r) => r.entityId));
  for (const [entityId, credit] of unapplied) {
    if (seen.has(entityId) || credit.total <= EPS) continue;
    out.push({
      entityId,
      entityName: credit.entityName,
      current: 0, days30: 0, days60: 0, days90: 0, days120Plus: 0,
      total: 0,
      unapplied: -round2(credit.total),
      net: -round2(credit.total),
    });
  }
  return out;
}

function merge(
  map: Map<string, EntityUnapplied>,
  entityId: string,
  entityName: string,
  field: 'payments' | 'creditNotes',
  amount: number,
): void {
  const existing = map.get(entityId)
    ?? { entityName, payments: 0, creditNotes: 0, total: 0 };
  existing[field] = round2(existing[field] + amount);
  existing.total = round2(existing.payments + existing.creditNotes);
  if (existing.entityName === '' && entityName !== '') existing.entityName = entityName;
  map.set(entityId, existing);
}

/**
 * Unapplied cash and unapplied credit per entity, as at a date.
 *
 * The cash halves mirror `ar/unappliedReceiptService` and
 * `ap/unappliedPaymentService` — same status sets, same cent tolerance, same
 * allocation tables — aggregated rather than paged. A payment whose entity is
 * NULL is skipped here and stays in those services' unattributed stream.
 */
export async function getUnappliedByEntity(
  companyId: string,
  side: AgedSide,
  asAt: string,
): Promise<Map<string, EntityUnapplied>> {
  const cashRows = (side === 'ar'
    ? await sql`
        SELECT cp.client_id AS entity_id, COALESCE(c.name, '') AS entity_name,
               SUM(cp.total_amount - COALESCE(alloc.allocated, 0)) AS amount
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
          AND (cp.total_amount - COALESCE(alloc.allocated, 0)) > ${EPS}
        GROUP BY cp.client_id, c.name`
    : await sql`
        SELECT sp.supplier_id AS entity_id, COALESCE(s.name, '') AS entity_name,
               SUM(sp.total_amount - COALESCE(alloc.allocated, 0)) AS amount
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
          AND (sp.total_amount - COALESCE(alloc.allocated, 0)) > ${EPS}
        GROUP BY sp.supplier_id, s.name`) as DbRow[];

  // The credit half is one query either way: `type` discriminates and the
  // entity column is whichever of the two is populated.
  const creditRows = (await sql`
    SELECT COALESCE(cn.client_id, cn.supplier_id) AS entity_id,
           COALESCE(c.name, s.name, '') AS entity_name,
           SUM(cn.total_amount - cn.applied_amount) AS amount
    FROM credit_notes cn
    LEFT JOIN customers c ON c.id = cn.client_id AND c.company_id = cn.company_id
    LEFT JOIN suppliers s ON s.id = cn.supplier_id AND s.company_id = cn.company_id
    WHERE cn.company_id = ${companyId}::UUID
      AND cn.type = ${side === 'ar' ? 'customer' : 'supplier'}
      AND cn.status IN ('approved', 'partially_applied')
      AND cn.credit_date <= ${asAt}::DATE
      AND (cn.total_amount - cn.applied_amount) > ${EPS}
      AND COALESCE(cn.client_id, cn.supplier_id) IS NOT NULL
    GROUP BY COALESCE(cn.client_id, cn.supplier_id), COALESCE(c.name, s.name, '')
  `) as DbRow[];

  const map = new Map<string, EntityUnapplied>();
  for (const r of cashRows) {
    merge(map, String(r.entity_id), String(r.entity_name ?? ''), 'payments', Number(r.amount));
  }
  for (const r of creditRows) {
    merge(map, String(r.entity_id), String(r.entity_name ?? ''), 'creditNotes', Number(r.amount));
  }
  return map;
}

export interface UnappliedCreditNotesSummary {
  count: number;
  amount: number;
  sample: { id: string; creditNoteNumber: string; entityId: string | null; remainder: number }[];
}

/** How many sample rows a caller gets. A finding, not a page. */
const SAMPLE_LIMIT = 10;

/**
 * On-account credit: the face value a live note has NOT consumed, as at a date.
 *
 * 'applied' is excluded deliberately, and it is not the same statement as
 * "applied_amount equals total_amount". A note capped against a settled invoice
 * before migration 677 sits at 'applied' with a remainder that CANNOT be
 * applied again — it is stranded, not available — and the statement services
 * credit exactly `applied_amount` for it. Counting that remainder here would
 * put the aged report and the statement on different numbers.
 */
export async function getUnappliedCreditNotes(
  companyId: string,
  side: CreditNoteSide,
  asAt: string,
): Promise<UnappliedCreditNotesSummary> {
  const totals = (await sql`
    SELECT COUNT(*)::INT AS count, COALESCE(SUM(cn.total_amount - cn.applied_amount), 0) AS amount
    FROM credit_notes cn
    WHERE cn.company_id = ${companyId}::UUID
      AND cn.type = ${side}
      AND cn.status IN ('approved', 'partially_applied')
      AND cn.credit_date <= ${asAt}::DATE
      AND (cn.total_amount - cn.applied_amount) > ${EPS}
  `) as DbRow[];

  const sample = (await sql`
    SELECT cn.id, cn.credit_note_number,
           COALESCE(cn.client_id, cn.supplier_id) AS entity_id,
           (cn.total_amount - cn.applied_amount) AS remainder
    FROM credit_notes cn
    WHERE cn.company_id = ${companyId}::UUID
      AND cn.type = ${side}
      AND cn.status IN ('approved', 'partially_applied')
      AND cn.credit_date <= ${asAt}::DATE
      AND (cn.total_amount - cn.applied_amount) > ${EPS}
    ORDER BY cn.credit_date ASC, cn.id ASC
    LIMIT ${SAMPLE_LIMIT}
  `) as DbRow[];

  return {
    count: Number(totals[0]?.count ?? 0),
    amount: round2(Number(totals[0]?.amount ?? 0)),
    sample: sample.map((r) => ({
      id: String(r.id),
      creditNoteNumber: String(r.credit_note_number ?? ''),
      entityId: r.entity_id == null ? null : String(r.entity_id),
      remainder: round2(Number(r.remainder)),
    })),
  };
}
