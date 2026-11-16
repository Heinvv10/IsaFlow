/**
 * Importer ≠ allocator for the transfer auto-link (2026-11-16).
 *
 * The link passes (import auto-link, relink / bank-relink-transfers) clear a
 * bank line against an existing transfer journal with no approval. A user who
 * pushed a forged line through the bank extension must not clear it that way
 * against a journal a colleague's allocation posted. While manual_journal
 * approval is enforced and the request's user is not the sole approver, a feed
 * line whose extension batch that user imported is left for a colleague. The
 * allocation that posted the journal is unaffected. Statement lines keep
 * linking as before. A pass with no request user (no auth.uid) holds nothing.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { armEnforced, isSoleAsCaller } from './bankLineImporterGate';

/** The request user whose own extension lines the pass must leave alone, or null when nothing is held. */
export async function extensionLinkHoldUser(companyId: string): Promise<string | null> {
  if (!(await armEnforced(companyId, 'manual_journal'))) return null;
  const [row] = (await sql`SELECT auth.uid()::TEXT AS uid`) as DbRow[];
  if (row?.uid == null) return null;
  return (await isSoleAsCaller(companyId, String(row.uid))) ? null : String(row.uid);
}

/** extensionLinkHoldUser, read once per pass run (inside the pass's savepoint, so a failed read stays non-fatal). */
export function extensionLinkHoldReader(companyId: string): () => Promise<string | null> {
  let held: string | null | undefined;
  return async () => (held === undefined ? (held = await extensionLinkHoldUser(companyId)) : held);
}

type LineColumn = 'n.id' | 'bt_new.id';

/** TRUE unless `holdUser` brought this line in through the extension. One `sql.unsafe`, interpolation only (see journalInForceAsAt). */
export function notHeldExtensionLineFragment(lineColumn: LineColumn, companyId: string, holdUser: string | null) {
  return sql.unsafe(
    `($2::TEXT IS NULL OR NOT EXISTS (SELECT 1 FROM bank_transactions h
      JOIN bank_import_batches hb ON hb.id = h.import_batch_id AND hb.company_id = h.company_id
      WHERE h.id = ${lineColumn} AND h.company_id = $1::UUID AND h.bank_feed_connection_id IS NOT NULL
        AND hb.import_channel = 'extension' AND lower(hb.imported_by) = lower($2::TEXT)))`,
    [companyId, holdUser],
  );
}
