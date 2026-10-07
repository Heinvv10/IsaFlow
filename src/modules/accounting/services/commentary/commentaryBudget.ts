/**
 * The pack-wide budget on approved commentary, as the service applies it: which
 * packs it protects, the per-pack lock, and the sum under that lock. The unit
 * is `commentaryEms` (commentaryLimits.ts), the same function the editor uses.
 */
import { sql, type DbRow } from '@/lib/neon';
import { als } from '@/lib/als';
import { canonicalParamsHash, PACK_TYPES } from '@/modules/accounting/services/reports/packParamsHash';
import { approxCharsLeft, packEmsUsed } from './commentaryLimits';

/** Only the board pack prints approved commentary on a fixed sheet (page 4);
 *  management and monthly packs flow it on screen and in the share link. The
 *  pack type is hashed into `params_hash`, so it is recovered by matching. A
 *  row that matches none is treated as board: fail closed. */
export function printsOnFixedPage(row: { paramsHash: string; periodStart: string; periodEnd: string }): boolean {
  const type = PACK_TYPES.find((t) =>
    canonicalParamsHash({ type: t, from: row.periodStart, to: row.periodEnd }) === row.paramsHash);
  return type === undefined || type === 'board';
}

export function budgetReason(remainingEms: number): string {
  return 'The approved commentary for this pack has to fit on one page of the board pack. About '
    + `${approxCharsLeft(remainingEms)} characters of ordinary text remain; shorten this text or `
    + 'withdraw another approved sentence.';
}

/**
 * Serialises approvals PER PACK, then reads what the pack has already spent —
 * costed in TS with the page's own ruler (`commentaryEms`), on the rows read
 * under the lock. The lock is a transaction advisory lock, so it only holds
 * inside the request transaction `withAuth` opens (released at COMMIT, after
 * the UPDATE): on a pooled connection it would be released the instant it was
 * taken and two approvals could both pass the sum — hence the refusal, as in
 * `assertClosesInOrder`. Tag 611 is this table's migration number.
 */
export async function lockPackAndSumApproved(
  companyId: string, id: string, reportKind: string, paramsHash: string,
): Promise<number> {
  if (!als.getStore()?.client) {
    throw new Error('approveCommentary requires a request transaction (withAuth): the pack lock would release immediately otherwise');
  }
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${companyId}:${reportKind}:${paramsHash}`}::text, 611))`;
  const rows = (await sql`
    SELECT approved_text FROM report_commentary
    WHERE company_id = ${companyId}::uuid AND report_kind = ${reportKind} AND params_hash = ${paramsHash}
      AND status = 'approved' AND approved_text IS NOT NULL AND id <> ${id}::uuid
  `) as DbRow[];
  return packEmsUsed(rows.map((r) => ({ status: 'approved', approvedText: String(r.approved_text) })));
}
