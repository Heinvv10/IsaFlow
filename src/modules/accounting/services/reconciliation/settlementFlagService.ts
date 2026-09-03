/**
 * Bills whose settlement FLAG contradicts their balance.
 *
 * `fourWayMatchService#recordPaymentMatch` sets `supplier_invoices.
 * payment_matched = true` when `amount_paid + allocatedAmount` covers the
 * bill. It never writes `amount_paid` — the caller is expected to have — so
 * when the caller's write does not happen, the flag is the only record that
 * anything was considered paid. On production Velocity Fibre that is 397 bills
 * carrying R16,151,543.00, every one at `amount_paid = 0.00`, with no
 * `payment_allocations` row and no `supplier_payments` row. Brightsphere has
 * none, so this is a per-company defect rather than a system-wide one.
 *
 * ── WHY THIS IS NOT A RECONCILING ITEM ─────────────────────────────────────
 *
 * The cash side of those bills is already on the control account: 1,090
 * `auto_supplier_payment` journals move Velocity's AP control by
 * −R61,115,350.09 with no `supplier_payments` row behind any of them, and
 * `unappliedCashService` counts every one of them as
 * `posting_with_no_document`. A second item for the same money would
 * double-count it and push the residual to exactly minus this figure.
 *
 * So this ATTRIBUTES part of an existing item rather than adding one, and it is
 * reported outside `reconcilingItems` where it cannot enter the arithmetic. The
 * distinction matters to a reader: "R61.1m of cash reached the control account
 * with no payment document" is the difference, and "R16.2m of it belongs to
 * bills a matching process already believed settled" is the lead worth
 * following first.
 *
 * The population is the subledger's population exactly — same status rule, same
 * as-at cutoff, same settlement rewind — so these rows are always a strict
 * subset of the documents behind `subledgerTotal`.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { fmtDate } from '@/lib/fmtDate';
import { effectivePaidExpr, rewindAmount } from '../shared/agingRewind';
import type { SubledgerRole } from '../gl/controlAccountService';
import { round2 } from './reconciliationMath';

/**
 * How many flagged bills are listed by id. The total and the count are always
 * complete; only the id list is capped, and `truncated` says when it was.
 */
const ID_CAP = 200;

export interface SettlementFlaggedRow {
  id: string;
  documentNumber: string | null;
  entityName: string | null;
  documentDate: string;
  /** 'YYYY-MM-DD' the flag was set, or null where the column is empty. */
  flaggedAt: string | null;
  /** Still outstanding as at the reporting date, despite the flag. */
  amount: number;
}

export interface SettlementFlagged {
  rows: SettlementFlaggedRow[];
  /** Outstanding across EVERY flagged bill, not just the listed ones. */
  total: number;
  /** How many there are, not how many are listed. */
  count: number;
  truncated: boolean;
}

const NONE: SettlementFlagged = { rows: [], total: 0, count: 0, truncated: false };

/**
 * @param asAtDate 'YYYY-MM-DD'. String throughout — no Date arithmetic.
 * @returns an empty result for every role but `ap`: `payment_matched` exists on
 *   `supplier_invoices` alone, and querying a column that is not there is how a
 *   42703 reaches production wearing a report's name.
 */
export async function getSettlementFlagged(
  companyId: string,
  role: SubledgerRole,
  asAtDate: string,
): Promise<SettlementFlagged> {
  if (role !== 'ap') return NONE;

  try {
    // Both bounds of the rewind window from ONE clock — see arSubledgerService.
    const todayStr = fmtDate(new Date());
    const paid = effectivePaidExpr('ap');

    const rows = (await sql`
      SELECT si.id,
             si.invoice_number AS document_number,
             s.name AS entity_name,
             COALESCE(si.invoice_date, si.created_at::date) AS document_date,
             si.payment_matched_at,
             (si.total_amount - ${sql.unsafe(paid)}) AS amount
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = ${companyId}::UUID
      LEFT JOIN LATERAL (
        ${rewindAmount({ companyId, asAtStr: asAtDate, todayStr, side: 'ap' })}
      ) unpaid ON TRUE
      WHERE si.company_id = ${companyId}::UUID
        AND si.payment_matched = TRUE
        AND si.status NOT IN ('draft', 'cancelled')
        AND COALESCE(si.invoice_date, si.created_at::date) <= ${asAtDate}::DATE
        AND (si.total_amount - ${sql.unsafe(paid)}) > 0
      ORDER BY (si.total_amount - ${sql.unsafe(paid)}) DESC, si.id
    `) as DbRow[];

    // The total is over EVERY row, taken before the cap: a capped total would
    // understate the finding and read as agreement.
    const total = round2(rows.reduce((s, r) => s + Number(r.amount ?? 0), 0));

    return {
      rows: rows.slice(0, ID_CAP).map((r) => ({
        id: String(r.id),
        documentNumber: r.document_number == null ? null : String(r.document_number),
        entityName: r.entity_name == null ? null : String(r.entity_name),
        documentDate: fmtDate(r.document_date as string | Date),
        flaggedAt: r.payment_matched_at == null ? null : fmtDate(r.payment_matched_at as string | Date),
        amount: round2(Number(r.amount ?? 0)),
      })),
      total,
      count: rows.length,
      truncated: rows.length > ID_CAP,
    };
  } catch (err) {
    log.error('Failed to read settlement-flagged bills', { role, error: err }, 'accounting');
    throw err;
  }
}
