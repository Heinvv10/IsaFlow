/**
 * Set or clear the asset / fleet LINK on a bank line (mig 853) — `POST /api/accounting/bank-match-asset` and
 * `bank-match-fleet`.
 *
 * A link is an ANNOTATION ONLY (Hein, 2026-10-05): the UPDATE writes the three link columns and `updated_at`, never
 * `status`, `matched_journal_line_id` or `reconciliation_id`, and nothing is posted. The line is allocated the normal
 * way. So a link is outside D12's "a completed reconciliation is immutable" (bank/.claude.md) — a reconciled line of a
 * completed session may still be annotated — and needs no stale-stamp handling, because the status never turns.
 *
 * Order, all BEFORE the write:
 *   1. the bank line, locked (`lockBankTransactionForUpdate`: its stamped session FOR SHARE, then the line FOR UPDATE,
 *      under the 5 s budget — held -> `BankTransactionLockTimeoutError`, 503) — missing or another company's: `line`;
 *   2. the target record in THIS company, FOR KEY SHARE (a delete in flight is waited for, bounded, and then reads as
 *      gone) — missing or another company's: `target`, one answer for both;
 *   3. the line's feed_state is `posted` — else `not_posted`;
 *   4. an unlink (null target) of a kind the line does not carry — `no_link`: answering success there told a stale
 *      client "Link removed" while another kind's link stayed on the line.
 * Lock order: bank line -> target record. The record delete (`fleetRecordsService`) locks only the record.
 */
import { sql, type DbRow } from '@/lib/neon';
import { underFlowLockBudget } from '../core/rowLockBudget';
import { feedStateOf } from './bankFeedStateGuard';
import { lockBankTransactionForUpdate } from './bankTxLock';
import type { BankTxLinkKind } from './bankTxLink';
import type { FeedState } from '../../types/bank.types';

export type BankLinkRefusal =
  | { ok: false; refused: 'line' }
  | { ok: false; refused: 'target' }
  | { ok: false; refused: 'not_posted'; feedState: Exclude<FeedState, 'posted'> }
  | { ok: false; refused: 'no_link' };

export type BankLinkResult = { ok: true } | BankLinkRefusal;

const LINK_COLUMN: Record<BankTxLinkKind, string> = {
  asset: 'linked_asset_id', fuel: 'linked_fleet_fuel_id', service: 'linked_fleet_service_id',
};

/** The target exists in this company — read FOR KEY SHARE under the 5 s budget. */
async function lockTarget(companyId: string, kind: BankTxLinkKind, id: string): Promise<boolean> {
  const rows = await underFlowLockBudget('The linked record', async () => (kind === 'asset'
    ? await sql`SELECT id FROM assets WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID FOR KEY SHARE`
    : kind === 'fuel'
      ? await sql`SELECT id FROM fleet_fuel_transactions
          WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID FOR KEY SHARE`
      : await sql`SELECT id FROM fleet_service_history
          WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID FOR KEY SHARE`) as DbRow[]);
  return rows.length > 0;
}

/**
 * Link the line to `targetId` of `kind` (the other two link columns cleared — one link per line), or, with
 * `targetId` null, clear the `kind` link only.
 */
export async function setBankLineLink(
  companyId: string, bankTxId: string, kind: BankTxLinkKind, targetId: string | null,
): Promise<BankLinkResult> {
  const line = await lockBankTransactionForUpdate(companyId, bankTxId);
  if (!line) return { ok: false, refused: 'line' };
  if (targetId !== null && !(await lockTarget(companyId, kind, targetId))) return { ok: false, refused: 'target' };
  const feedState = feedStateOf(line);
  if (feedState !== 'posted') return { ok: false, refused: 'not_posted', feedState };
  if (targetId === null && !line[LINK_COLUMN[kind]]) return { ok: false, refused: 'no_link' };

  if (targetId !== null) {
    await sql`
      UPDATE bank_transactions SET
        linked_asset_id = ${kind === 'asset' ? targetId : null}::UUID,
        linked_fleet_fuel_id = ${kind === 'fuel' ? targetId : null}::UUID,
        linked_fleet_service_id = ${kind === 'service' ? targetId : null}::UUID,
        updated_at = NOW()
      WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`;
  } else {
    await sql`
      UPDATE bank_transactions SET
        linked_asset_id = CASE WHEN ${kind}::TEXT = 'asset' THEN NULL ELSE linked_asset_id END,
        linked_fleet_fuel_id = CASE WHEN ${kind}::TEXT = 'fuel' THEN NULL ELSE linked_fleet_fuel_id END,
        linked_fleet_service_id = CASE WHEN ${kind}::TEXT = 'service' THEN NULL ELSE linked_fleet_service_id END,
        updated_at = NOW()
      WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`;
  }
  return { ok: true };
}
