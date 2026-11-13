/**
 * Deleting a fixed asset that never left a trace (MCP `delete_fixed_asset`). Nothing else deletes an `assets` row.
 *
 * An asset is deletable only while NOTHING refers to it. The footprint census (every table with a foreign key to
 * `assets`, from pg_constraint, plus the journals that name an asset by its number) is:
 *   asset_period_ledger, asset_depreciation_schedule (ON DELETE CASCADE) - a depreciation run reached it;
 *   asset_disposals (NO ACTION)                                          - it was disposed;
 *   fleet_fuel_transactions, fleet_service_history (CASCADE)             - fleet records hang off it;
 *   bank_transactions.linked_asset_id (SET NULL)                         - a bank line is linked to it;
 *   gl_journal_entries by number: DEP-<n>- (depreciation) in entry_number, DIS-<n>- (disposal) and EXP-<n>-
 *   (below-threshold expensing) in reference - no FK, so only the number ties them.
 * plus the asset's own columns a posting flow writes (status, disposal_date, accumulated depreciation, last
 * depreciation date, below_threshold). Any of them refuses: CASCADE would silently erase the history and SET NULL
 * would silently unlink a bank line. `tests/integration/delete-fixed-asset.int.test.ts` pins the FK list, so a new
 * table that references `assets` fails that test until it is counted here.
 *
 * WHY FOR UPDATE, NOT FOR NO KEY UPDATE (pages/api/accounting/assets/.claude.md, brk-fleet B1, says asset writers take
 * NO KEY UPDATE because FOR UPDATE conflicts with the FOR KEY SHARE a bank-line link, a fleet-record create and the
 * composite-FK checks take). A DELETE is a key change, so it needs the FOR UPDATE-level lock at delete time whatever
 * is taken first; the only question is whether the census is read before or after the KEY SHARE holders are out of
 * the way. Under NO KEY UPDATE the census runs while a bank-line link in flight (uncommitted, holding KEY SHARE) is
 * invisible: it reads clean, the DELETE then waits for that link to commit, and the FK's ON DELETE SET NULL silently
 * unlinks the committed bank line. FOR UPDATE first makes the delete wait for (or fence out) every KEY SHARE holder
 * BEFORE the census, so it sees what they committed and refuses. The B1 cycle needs a holder that keeps waiting on
 * another resource after taking the asset lock; this one reads and deletes, and the wait for the lock is bounded
 * (5 s, then RowLockTimeoutError: retry). `delete-fixed-asset.int.test.ts` runs the delete against a concurrent bank
 * link and fleet fuel / service insert in both orders (no deadlock, no silent unlink), and fails if this is weakened.
 *
 * The depreciation run and disposal lock the same row FOR NO KEY UPDATE, which conflicts with FOR UPDATE, so a run in
 * flight either holds the row first (the delete waits, then sees its rows and refuses) or waits behind this
 * transaction and finds the asset gone (its per-asset savepoint rolls back: nothing written). Call both functions
 * inside the request transaction.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { RowLockTimeoutError, withRowLockBudget } from '../core/rowLockBudget';

export interface AssetDeleteBlocker {
  code: string;
  detail: string;
}

export interface AssetDeleteInspection {
  assetId: string;
  assetNumber: string;
  name: string;
  status: string;
  blockers: AssetDeleteBlocker[];
}

const IN_SERVICE = ['available', 'assigned', 'in_maintenance'];

const nonZero = (v: unknown): boolean => v !== null && v !== undefined && Number(v) !== 0;

/** Locks the company's asset and lists everything that stops it being deleted. `null`: no such asset here. */
export async function lockAndInspectAsset(companyId: string, assetId: string): Promise<AssetDeleteInspection | null> {
  const [a] = await withRowLockBudget(async () => (await sql`
    SELECT id, asset_number, name, status, disposal_date, accumulated_depreciation, tax_accumulated_depreciation,
           tax_opening_acc_dep, last_depreciation_date, below_threshold
    FROM assets
    WHERE id = ${assetId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `) as DbRow[], () => new RowLockTimeoutError(`Asset ${assetId}`));
  if (!a) return null;

  const number = String(a.asset_number);
  const [n] = (await sql`
    SELECT
      (SELECT COUNT(*)::INT FROM asset_period_ledger WHERE asset_id = ${assetId}::UUID) AS period_ledger,
      (SELECT COUNT(*)::INT FROM asset_depreciation_schedule WHERE asset_id = ${assetId}::UUID) AS dep_schedule,
      (SELECT COUNT(*)::INT FROM asset_disposals WHERE asset_id = ${assetId}::UUID) AS disposals,
      (SELECT COUNT(*)::INT FROM fleet_fuel_transactions
        WHERE asset_id = ${assetId}::UUID AND company_id = ${companyId}::UUID) AS fuel,
      (SELECT COUNT(*)::INT FROM fleet_service_history
        WHERE asset_id = ${assetId}::UUID AND company_id = ${companyId}::UUID) AS service,
      (SELECT COUNT(*)::INT FROM bank_transactions
        WHERE linked_asset_id = ${assetId}::UUID AND company_id = ${companyId}::UUID) AS bank_links,
      (SELECT COUNT(*)::INT FROM gl_journal_entries
        WHERE company_id = ${companyId}::UUID
          AND (starts_with(COALESCE(entry_number, ''), ${`DEP-${number}-`})
            OR starts_with(COALESCE(reference, ''), ${`DIS-${number}-`})
            OR starts_with(COALESCE(reference, ''), ${`EXP-${number}-`}))) AS journals
  `) as DbRow[];

  const blockers: AssetDeleteBlocker[] = [];
  const add = (cond: boolean, code: string, detail: string) => { if (cond) blockers.push({ code, detail }); };
  const status = String(a.status);
  add(!IN_SERVICE.includes(status) || a.disposal_date !== null, 'disposed', `it is ${status}`);
  add(Number(n?.period_ledger) > 0 || Number(n?.dep_schedule) > 0 || nonZero(a.accumulated_depreciation)
    || nonZero(a.tax_accumulated_depreciation) || nonZero(a.tax_opening_acc_dep) || a.last_depreciation_date !== null,
  'depreciated', 'depreciation has been recorded against it');
  add(Number(n?.disposals) > 0, 'disposal_recorded', 'a disposal is recorded for it');
  add(Number(n?.journals) > 0, 'journal_posted', 'a depreciation, disposal or expensing journal names it');
  add(a.below_threshold === true, 'expensed', 'it was expensed as below the capitalisation threshold');
  add(Number(n?.fuel) > 0 || Number(n?.service) > 0, 'fleet_records', 'fuel or service records are attached to it');
  add(Number(n?.bank_links) > 0, 'bank_linked', 'a bank transaction is linked to it');
  return { assetId, assetNumber: number, name: String(a.name), status, blockers };
}

/** Deletes the asset `lockAndInspectAsset` locked and found clear. Throws if the row is not there to delete. */
export async function deleteLockedAsset(companyId: string, assetId: string): Promise<void> {
  const gone = (await sql`
    DELETE FROM assets WHERE id = ${assetId}::UUID AND company_id = ${companyId}::UUID RETURNING id
  `) as DbRow[];
  if (gone.length !== 1) throw new Error(`Asset ${assetId} was not deleted: the locked row was not found`);
}
