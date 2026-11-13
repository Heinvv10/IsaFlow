/**
 * Bills settled by more than one source, or paid by more than their settlements explain (`find_double_settlements`,
 * step 6, 2026-11-13).
 *
 * Found by hand against Sage at Velocity Fibre: a petty-cash bill settled by a contra (SP-2026-01861) AND by a paycard
 * line (SP-2026-05014); a credit note (CN-2026-00562) applied to a bill already paid; 13 claimant contras on 13 Oct.
 * Each settles the bill once in the subledger's eyes and the over-settlement only shows as a supplier with phantom
 * credit. This lists them.
 *
 * ── THE SETTLEMENTS ─────────────────────────────────────────────────────────
 * Every recorded way the AP subledger settles a bill (the census in `shared/agingRewind.ts`):
 *   - supplier payments, through `payment_allocations`, at the statuses that moved `amount_paid` (processed,
 *     reconciled — `core/paymentVoidService` VOIDABLE_STATUSES); kind per `settlementKind.ts`;
 *   - supplier credit notes, through `credit_note_allocations` (approved / partially_applied / applied), and the
 *     pre-677 shape — `applied_amount` on the one bill a note names, only when the note has no allocation rows.
 * `bank-match-confirm` and the importers write `amount_paid` with no settlement row; that is reported as the bill's
 * `amount_paid` beside the settlements, never as a settlement.
 *
 * ── REPORTED ────────────────────────────────────────────────────────────────
 *   (a) `over_settled`: the live settlements sum to more than the bill's total (by at least a cent) — one document
 *       allocated past the total counts too;
 *   (b) `multiple_sources` (narrowed in review round 1): the settlements cover the whole bill (≥ total − 1c) AND, summed
 *       PER KIND, at least two kinds each cover at least half of it, one of them a contra or a card line — the
 *       double-settlement pattern (a contra and a card line both paying a petty-cash bill). Half a credit note and half
 *       a payment is an ordinary settlement and is not reported; nor are two payments of one kind. Named limit: a
 *       payment matched to a statement line later reads `card_line`, so two half payments, one later matched, are
 *       reported;
 *   (c) `amount_paid_unexplained`: the bill's own `amount_paid` exceeds its total, or exceeds what its settlement rows
 *       add up to, by more than a cent — paid by something that left no settlement row (bank-match-confirm, an
 *       importer). Cancelled bills are left out of (c). AP has no write-off document (customer_write_offs is AR-only),
 *       so no supplier bill's `amount_paid` is explained by a write-off.
 * Filtered by the bill's invoice date and supplier; paged by offset over (invoice_date, id).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { creditedAccountIdSql, paymentSettlementKindSql, type SettlementKind } from './settlementKind';

export type DoubleSettlementReason = 'over_settled' | 'multiple_sources' | 'amount_paid_unexplained';

/** Settlements listed per bill; `settlement_count` always carries the full number. */
export const MAX_SETTLEMENTS_PER_BILL = 50;

export interface DoubleSettlementFilters {
  supplierId: string | null;
  fromDate: string | null;
  toDate: string | null;
  limit: number;
  offset: number;
}

export interface BillSettlement {
  kind: SettlementKind;
  documentId: string;
  documentNumber: string | null;
  date: string | null;
  amount: number;
  /** The account a payment credited (its bank, card or contra account); null for a credit note. */
  accountId: string | null;
  accountCode: string | null;
  accountName: string | null;
  paymentMethod: string | null;
}

export interface DoubleSettledBill {
  billId: string;
  billNumber: string;
  invoiceDate: string;
  supplierId: string;
  /** Null when the bill names a supplier this company does not hold. */
  supplierName: string | null;
  total: number;
  amountPaid: number;
  settledTotal: number;
  overSettledBy: number;
  reasons: DoubleSettlementReason[];
  settlementCount: number;
  settlements: BillSettlement[];
}

const num = (v: unknown): number => Math.round(Number(v ?? 0) * 100) / 100;
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

export async function findDoubleSettlements(
  companyId: string,
  f: DoubleSettlementFilters,
): Promise<{ rows: DoubleSettledBill[]; total: number }> {
  const rows = (await sql`
    WITH bills AS (
      SELECT si.id, si.invoice_number, si.invoice_date, si.supplier_id, si.total_amount, si.status,
             COALESCE(si.amount_paid, 0) AS amount_paid
      FROM supplier_invoices si
      WHERE si.company_id = ${companyId}::UUID AND si.deleted_at IS NULL
        AND (${f.supplierId}::UUID IS NULL OR si.supplier_id = ${f.supplierId}::UUID)
        AND (${f.fromDate}::DATE IS NULL OR si.invoice_date >= ${f.fromDate}::DATE)
        AND (${f.toDate}::DATE IS NULL OR si.invoice_date <= ${f.toDate}::DATE)
    ),
    settlements AS (
      SELECT pa.invoice_id AS bill_id, ${paymentSettlementKindSql('sp')} AS kind,
             sp.id AS document_id, sp.payment_number AS document_number, sp.payment_date AS document_date,
             pa.amount_allocated AS amount, ca.id AS account_id, ca.account_code, ca.account_name,
             sp.payment_method
      FROM payment_allocations pa
      JOIN bills b ON b.id = pa.invoice_id
      JOIN supplier_payments sp ON sp.id = pa.payment_id AND sp.company_id = ${companyId}::UUID
      LEFT JOIN gl_accounts ca ON ca.id = ${creditedAccountIdSql('sp')} AND ca.company_id = ${companyId}::UUID
      WHERE sp.status IN ('processed', 'reconciled')
      UNION ALL
      SELECT cna.invoice_id, 'credit_note', cn.id, cn.credit_note_number, cn.credit_date,
             cna.amount_allocated, NULL::UUID, NULL, NULL, NULL
      FROM credit_note_allocations cna
      JOIN bills b ON b.id = cna.invoice_id
      JOIN credit_notes cn ON cn.id = cna.credit_note_id AND cn.company_id = ${companyId}::UUID
      WHERE cna.company_id = ${companyId}::UUID
        AND cn.type = 'supplier' AND cn.status IN ('approved', 'partially_applied', 'applied')
      UNION ALL
      SELECT cn.supplier_invoice_id, 'credit_note', cn.id, cn.credit_note_number, cn.credit_date,
             cn.applied_amount, NULL::UUID, NULL, NULL, NULL
      FROM credit_notes cn
      JOIN bills b ON b.id = cn.supplier_invoice_id
      WHERE cn.company_id = ${companyId}::UUID AND cn.type = 'supplier'
        AND cn.status IN ('approved', 'partially_applied', 'applied') AND cn.applied_amount > 0
        AND NOT EXISTS (
          SELECT 1 FROM credit_note_allocations x WHERE x.credit_note_id = cn.id AND x.company_id = ${companyId}::UUID)
    ),
    per_bill AS (
      SELECT s.bill_id, SUM(s.amount) AS settled_total, COUNT(*)::INT AS settlement_count
      FROM settlements s GROUP BY s.bill_id
    ),
    per_kind AS (
      SELECT s.bill_id, s.kind, SUM(s.amount) AS amount FROM settlements s GROUP BY s.bill_id, s.kind
    ),
    flagged AS (
      SELECT b.id, b.invoice_number, b.invoice_date, b.supplier_id, su.name AS supplier_name, b.total_amount,
             b.amount_paid, COALESCE(pb.settled_total, 0) AS settled_total, COALESCE(pb.settlement_count, 0) AS settlement_count,
             (COALESCE(pb.settled_total, 0) - b.total_amount >= 0.01) AS over_settled,
             (b.total_amount > 0 AND COALESCE(pb.settled_total, 0) >= b.total_amount - 0.01
               AND (SELECT COUNT(*) FROM per_kind k WHERE k.bill_id = b.id AND k.amount * 2 >= b.total_amount) >= 2
               AND EXISTS (SELECT 1 FROM per_kind k WHERE k.bill_id = b.id AND k.amount * 2 >= b.total_amount
                             AND k.kind IN ('contra', 'card_line'))) AS multi,
             (b.status <> 'cancelled' AND (b.amount_paid - b.total_amount > 0.01
               OR b.amount_paid - COALESCE(pb.settled_total, 0) > 0.01)) AS unexplained
      FROM bills b
      LEFT JOIN per_bill pb ON pb.bill_id = b.id
      LEFT JOIN suppliers su ON su.id = b.supplier_id AND su.company_id = ${companyId}::UUID
    )
    SELECT fl.*, COUNT(*) OVER () AS total_rows,
           (SELECT json_agg(x ORDER BY x.document_date, x.document_number, x.document_id) FROM (
              SELECT s.kind, s.document_id, s.document_number, s.document_date, s.amount,
                     s.account_id, s.account_code, s.account_name, s.payment_method
              FROM settlements s WHERE s.bill_id = fl.id
              ORDER BY s.document_date, s.document_number, s.document_id
              LIMIT ${MAX_SETTLEMENTS_PER_BILL}) x) AS settlements
    FROM flagged fl
    WHERE fl.over_settled OR fl.multi OR fl.unexplained
    ORDER BY fl.invoice_date, fl.id
    LIMIT ${f.limit} OFFSET ${f.offset}
  `) as DbRow[];
  return { rows: rows.map(mapBill), total: rows.length > 0 ? Number(rows[0]!.total_rows) : 0 };
}

function mapBill(r: DbRow): DoubleSettledBill {
  const total = num(r.total_amount);
  const settledTotal = num(r.settled_total);
  const reasons: DoubleSettledBill['reasons'] = [];
  if (r.over_settled === true) reasons.push('over_settled');
  if (r.multi === true) reasons.push('multiple_sources');
  if (r.unexplained === true) reasons.push('amount_paid_unexplained');
  const settlements = ((r.settlements ?? []) as Record<string, unknown>[]).map((s): BillSettlement => ({
    kind: String(s.kind) as SettlementKind,
    documentId: String(s.document_id),
    documentNumber: strOrNull(s.document_number),
    // json_agg renders a DATE as 'YYYY-MM-DD' text, never a Date.
    date: strOrNull(s.document_date),
    amount: num(s.amount),
    accountId: strOrNull(s.account_id),
    accountCode: strOrNull(s.account_code),
    accountName: strOrNull(s.account_name),
    paymentMethod: strOrNull(s.payment_method),
  }));
  return {
    billId: String(r.id),
    billNumber: String(r.invoice_number),
    invoiceDate: fmtDate(r.invoice_date as string | Date),
    supplierId: String(r.supplier_id),
    supplierName: strOrNull(r.supplier_name),
    total,
    amountPaid: num(r.amount_paid),
    settledTotal,
    overSettledBy: Math.max(0, Math.round((settledTotal - total) * 100) / 100),
    reasons,
    settlementCount: Number(r.settlement_count ?? settlements.length),
    settlements,
  };
}
