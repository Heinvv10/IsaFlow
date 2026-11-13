/**
 * Bills settled by more than one source (`find_double_settlements`, step 6, 2026-11-13).
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
 *   (b) `multiple_sources`: two settlements of DIFFERENT kinds each cover at least HALF the bill. "Most of" is read as
 *       half or more: two documents of different kinds each settling half or more is the double-settlement pattern
 *       even when (a) does not fire (two halves sum to exactly the total).
 * Filtered by the bill's invoice date and supplier; paged by offset over (invoice_date, id).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { creditedAccountIdSql, paymentSettlementKindSql, type SettlementKind } from './settlementKind';

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
  reasons: ('over_settled' | 'multiple_sources')[];
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
    WITH settlements AS (
      SELECT pa.invoice_id AS bill_id, ${paymentSettlementKindSql('sp')} AS kind,
             sp.id AS document_id, sp.payment_number AS document_number, sp.payment_date AS document_date,
             pa.amount_allocated AS amount, ca.id AS account_id, ca.account_code, ca.account_name,
             sp.payment_method
      FROM payment_allocations pa
      JOIN supplier_payments sp ON sp.id = pa.payment_id AND sp.company_id = ${companyId}::UUID
      LEFT JOIN gl_accounts ca ON ca.id = ${creditedAccountIdSql('sp')} AND ca.company_id = ${companyId}::UUID
      WHERE sp.status IN ('processed', 'reconciled')
      UNION ALL
      SELECT cna.invoice_id, 'credit_note', cn.id, cn.credit_note_number, cn.credit_date,
             cna.amount_allocated, NULL::UUID, NULL, NULL, NULL
      FROM credit_note_allocations cna
      JOIN credit_notes cn ON cn.id = cna.credit_note_id AND cn.company_id = ${companyId}::UUID
      WHERE cna.company_id = ${companyId}::UUID
        AND cn.type = 'supplier' AND cn.status IN ('approved', 'partially_applied', 'applied')
      UNION ALL
      SELECT cn.supplier_invoice_id, 'credit_note', cn.id, cn.credit_note_number, cn.credit_date,
             cn.applied_amount, NULL::UUID, NULL, NULL, NULL
      FROM credit_notes cn
      WHERE cn.company_id = ${companyId}::UUID AND cn.type = 'supplier'
        AND cn.status IN ('approved', 'partially_applied', 'applied')
        AND cn.supplier_invoice_id IS NOT NULL AND cn.applied_amount > 0
        AND NOT EXISTS (
          SELECT 1 FROM credit_note_allocations x WHERE x.credit_note_id = cn.id AND x.company_id = ${companyId}::UUID)
    ),
    per_bill AS (
      SELECT s.bill_id, SUM(s.amount) AS settled_total, COUNT(*)::INT AS settlement_count
      FROM settlements s GROUP BY s.bill_id
    ),
    flagged AS (
      SELECT si.id, si.invoice_number, si.invoice_date, si.supplier_id, su.name AS supplier_name,
             si.total_amount, COALESCE(si.amount_paid, 0) AS amount_paid, pb.settled_total, pb.settlement_count,
             (pb.settled_total - si.total_amount >= 0.01) AS over_settled,
             ((SELECT COUNT(DISTINCT s.kind) FROM settlements s
               WHERE s.bill_id = si.id AND si.total_amount > 0 AND s.amount * 2 >= si.total_amount) >= 2) AS multi
      FROM per_bill pb
      JOIN supplier_invoices si ON si.id = pb.bill_id AND si.company_id = ${companyId}::UUID
      LEFT JOIN suppliers su ON su.id = si.supplier_id AND su.company_id = si.company_id
      WHERE si.deleted_at IS NULL
        AND (${f.supplierId}::UUID IS NULL OR si.supplier_id = ${f.supplierId}::UUID)
        AND (${f.fromDate}::DATE IS NULL OR si.invoice_date >= ${f.fromDate}::DATE)
        AND (${f.toDate}::DATE IS NULL OR si.invoice_date <= ${f.toDate}::DATE)
    )
    SELECT fl.*, COUNT(*) OVER () AS total_rows,
           (SELECT json_agg(x ORDER BY x.document_date, x.document_number, x.document_id) FROM (
              SELECT s.kind, s.document_id, s.document_number, s.document_date, s.amount,
                     s.account_id, s.account_code, s.account_name, s.payment_method
              FROM settlements s WHERE s.bill_id = fl.id
              ORDER BY s.document_date, s.document_number, s.document_id
              LIMIT ${MAX_SETTLEMENTS_PER_BILL}) x) AS settlements
    FROM flagged fl
    WHERE fl.over_settled OR fl.multi
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
