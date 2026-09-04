/**
 * Disposals the register recorded that the ledger never heard about.
 *
 * Split from `fixedAssetReconciliationQueries.ts` to keep both files inside the
 * 300-line cap. The reasoning lives on the function below.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

/** A disposal the register recorded and the ledger never heard about. */
export interface UnpostedDisposal {
  assetId: string;
  assetNumber: string;
  name: string;
  disposalId: string | null;
  disposalDate: string;
  proceeds: number | null;
  bookValueAtDisposal: number | null;
  gainLoss: number | null;
  /** True when the asset is disposed but no asset_disposals row exists at all. */
  disposalRecordMissing: boolean;
  /**
   * How many `asset_disposals` rows this asset carries.
   *
   * More than one is possible — `idx_disposals_asset` is a plain NON-unique
   * index and only the primary key on `id` is unique — and the totals used to
   * sum every one of them, double-counting an asset that had two. The asset is
   * the unit of the register and cannot duplicate, so exactly one row per asset
   * is reported now; this count is how a reader learns there were others rather
   * than having the choice made silently.
   */
  disposalRecordCount: number;
}

/**
 * Disposals recorded on the register with NO posted journal behind them.
 *
 * This is the register-versus-ledger disagreement the endpoint exists to find,
 * and the one shape that could never show up in `difference`. A disposed asset
 * is correctly out of the register's carrying amount, and a disposal that never
 * posted is correctly absent from the ledger — so BOTH sides are zero and the
 * arithmetic closes over a real, recorded loss. The same unfailable-identity
 * trap as the un-subtyped accounts, in a different place.
 *
 * It is not hypothetical. Production holds exactly one disposal: Brightsphere's
 * COMP-0001, sold 2026-04-12 for R8,000 against a R15,000 book value, a
 * **R7,000 loss** recorded in `asset_disposals` and on the asset row, with
 * `journal_entry_id` NULL and no disposal journal anywhere in the GL. It cannot
 * post on any tenant: `postAssetDisposalToGL` resolves the system role
 * `disposal_profit_loss`, and NO company in production has an account carrying
 * that subtype — 0 of 13. `getSystemAccount` throws on an empty role.
 *
 * Driven from `assets`, not from `asset_disposals`, so an asset marked disposed
 * with no disposal record at all is caught too — that is a worse version of the
 * same gap, not a reason to miss it. `asset_disposals` carries NO `company_id`
 * column and is reached only through this company's assets.
 */
export async function loadUnpostedDisposals(
  companyId: string,
  asOf: string,
): Promise<UnpostedDisposal[]> {
  // DISTINCT ON (a.id): exactly ONE row per asset, whatever the disposal log
  // holds. Without it two `asset_disposals` rows for one asset appeared twice
  // and DOUBLED both headline figures — and the schema permits that, since
  // `idx_disposals_asset` is non-unique. The latest disposal record wins, by an
  // explicit deterministic order rather than by heap order; `disposal_count`
  // tells the reader when there were others.
  const rows = (await sql`
    SELECT DISTINCT ON (a.id)
           a.id, a.asset_number, a.name, a.disposal_date,
           a.disposal_amount, a.disposal_gain_loss, a.current_book_value,
           d.id AS disposal_id, d.disposal_date AS d_date,
           d.disposal_amount AS d_amount,
           d.book_value_at_disposal, d.gain_loss,
           (SELECT COUNT(*)::INT FROM asset_disposals ad WHERE ad.asset_id = a.id)
             AS disposal_count
    FROM assets a
    LEFT JOIN asset_disposals d ON d.asset_id = a.id
    WHERE a.company_id = ${companyId}::UUID
      AND a.disposal_date IS NOT NULL
      AND a.disposal_date <= ${asOf}::DATE
      -- No journal claimed, or one claimed that is not a posted entry of this
      -- company. A claimed id that resolves to nothing is the worse case.
      AND NOT EXISTS (
        SELECT 1 FROM gl_journal_entries je
        WHERE je.id = d.journal_entry_id
          AND je.company_id = ${companyId}::UUID
          AND je.status = 'posted'
      )
    ORDER BY a.id, d.disposal_date DESC NULLS LAST, d.id DESC
  `) as DbRow[];

  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  return rows.map((r) => ({
    assetId: String(r.id),
    assetNumber: String(r.asset_number ?? ''),
    name: String(r.name ?? ''),
    disposalId: r.disposal_id == null ? null : String(r.disposal_id),
    // The disposal RECORD's date when there is one, else the asset's own.
    disposalDate: fmtDate(r.d_date ?? r.disposal_date),
    proceeds: num(r.d_amount ?? r.disposal_amount),
    bookValueAtDisposal: num(r.book_value_at_disposal ?? r.current_book_value),
    gainLoss: num(r.gain_loss ?? r.disposal_gain_loss),
    disposalRecordMissing: r.disposal_id == null,
    disposalRecordCount: Number(r.disposal_count) || 0,
  }));
}
