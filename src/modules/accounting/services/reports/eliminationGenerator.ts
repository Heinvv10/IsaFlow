/**
 * Auto-generation of the STORED (manual / legacy) intercompany eliminations. A mirrored document's elimination is never stored: it is derived from
 * the ledgers at read time (mirrorEliminations.ts), so this generator skips mirrored rows. One elimination per row: a second run skips a row whose
 * elimination already stands, and the partial unique index on consolidation_adjustments(source_intercompany_id) (1019, when it could be built)
 * turns a concurrent loser's insert into a skip.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import { createEliminationAdjustment } from './consolidatedReportingService';
import type { ConsolidationAdjustment, CreateEliminationInput, EliminationLine } from './consolidatedReportingService';
import { EliminationAlreadyStandsError } from './eliminationErrors';
import { getPairCutovers, pairCutover } from './eliminationDuplicates';

async function findGroupAccountByType(groupId: string, companyId: string, accountType: string): Promise<string | null> {
  const rows = (await sql`
    SELECT gcm.group_account_id FROM group_coa_mappings gcm
    JOIN gl_accounts ga ON ga.id = gcm.company_account_id
    WHERE gcm.group_id = ${groupId}::UUID AND gcm.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID AND ga.account_type = ${accountType}
    LIMIT 1
  `) as DbRow[];
  return rows.length > 0 ? String(rows[0]!.group_account_id) : null;
}

async function findGroupAccountBySubtype(groupId: string, companyId: string, subtype: string): Promise<string | null> {
  const rows = (await sql`
    SELECT gcm.group_account_id FROM group_coa_mappings gcm
    JOIN gl_accounts ga ON ga.id = gcm.company_account_id
    WHERE gcm.group_id = ${groupId}::UUID AND gcm.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID AND ga.account_subtype = ${subtype}
    LIMIT 1
  `) as DbRow[];
  return rows.length > 0 ? String(rows[0]!.group_account_id) : null;
}

/** Creates the elimination of a row unless one already stands (a concurrent run won): that is a skip, not an error. Returns the one created. */
async function createUnlessStanding(created: ConsolidationAdjustment[], groupId: string, input: CreateEliminationInput): Promise<ConsolidationAdjustment | null> {
  try {
    const made = await createEliminationAdjustment(groupId, input);
    created.push(made);
    return made;
  } catch (err) {
    if (!(err instanceof EliminationAlreadyStandsError)) throw err;
    return null;
  }
}

/** What a person recognises a row by (never its id): its description, date and amount. */
export interface EliminationRowLabel { description: string; date: string; amount: number }

/**
 * An elimination THIS run drafted with a flag, marked CHECK BEFORE POSTING: before its pair's cutover, a manual row that may be the same sale
 * as a mirrored document (posting it could eliminate the sale twice); on or after it, a row no standing mirrored elimination accounts for.
 */
export interface FlaggedEliminationRow extends EliminationRowLabel { transactionId: string; adjustmentId: string; mirroredRef: string; reason: string }

/**
 * A row this run did NOT draft (RULING 2026-11-21): a sale-class row of a mirroring pair dated on or after the pair's cutover whose sale a
 * mirrored document of THIS group eliminates now (intercompany_mirrored_duplicate matches it and intercompany_mirror_stands says the pair
 * stands). Judged again at every run: if that mirror stops standing (a reversal, a withdrawal), the next run drafts the row.
 */
export interface SkippedEliminationRow extends EliminationRowLabel { transactionId: string; reason: string; cutover: string; mirroredRef: string }
export const ELIMINATED_BY_MIRRORING = 'eliminated by mirroring';
const SALE_TYPES = new Set(['sale', 'purchase', 'mgmt_fee']);
const label = (tx: DbRow): EliminationRowLabel => ({ description: String(tx.description ?? ''), date: String(tx.td), amount: Number(tx.amount) });

/** `flagged`, when given, receives the eliminations this run drafted with a flag, with why; `skipped` the rows it left to mirroring. */
export async function autoGenerateEliminations(
  groupId: string, periodStart: string, periodEnd: string, flagged: FlaggedEliminationRow[] = [], skipped: SkippedEliminationRow[] = [],
): Promise<ConsolidationAdjustment[]> {
  try {
    // Two runs for one group are serialised (the request transaction holds this to commit), so the per-row skip below sees the other run's rows
    // even where the partial unique index could not be built (1019 skips it while legacy duplicates exist). Outside a transaction the lock
    // would be released at the end of its own statement and serialise nothing, so that is refused: the lock must still be held afterwards.
    await sql`SELECT pg_advisory_xact_lock(hashtext('consolidation-eliminations:' || ${groupId}::TEXT))`;
    const held = (await sql`
      SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted
         AND objsubid = 1 AND objid = (hashtext('consolidation-eliminations:' || ${groupId}::TEXT)::bigint & 4294967295)::oid
    `) as DbRow[];
    if (held.length === 0) throw new Error('autoGenerateEliminations must run inside a transaction (its per-group advisory lock is transaction-scoped)');
    const icTxRows = (await sql`
      SELECT ict.id, ict.source_company_id, ict.target_company_id,
             ict.transaction_type, ict.amount, ict.description, ict.transaction_date::TEXT AS td, dup.mirror_rows, dup.mirror_ref
      FROM intercompany_transactions ict
      LEFT JOIN LATERAL public.intercompany_mirrored_duplicate(ict.id) dup ON true
      WHERE ict.group_id=${groupId}::UUID AND ict.match_status='matched'
        AND NOT public.intercompany_is_mirrored_row(ict.id) -- a mirrored document's elimination is derived from the ledgers (mirrorEliminations.ts), never stored
        AND ict.transaction_date>=${periodStart} AND ict.transaction_date<=${periodEnd}
      ORDER BY ict.transaction_date, ict.created_at, ict.id
    `) as DbRow[];

    const created: ConsolidationAdjustment[] = [];
    const cutovers = await getPairCutovers(groupId);
    const cutoverOf = (tx: DbRow): string | null => {
      const c = pairCutover(cutovers, String(tx.source_company_id), String(tx.target_company_id));
      return c && SALE_TYPES.has(String(tx.transaction_type)) && String(tx.td) >= c ? c : null;
    };
    // whether each mirror a post-cutover row matches is eliminated automatically now (judged once per distinct mirror), and its date
    const mirrors = [...new Set(icTxRows.filter(cutoverOf).flatMap((tx) => (tx.mirror_rows as string[] | null) ?? []))];
    const mirrorInfo = new Map(mirrors.length === 0 ? [] : ((await sql`
      SELECT m.id::TEXT AS id, m.transaction_date::TEXT AS d, COALESCE(public.intercompany_mirror_stands(m.id), false) AS s
        FROM intercompany_transactions m WHERE m.id = ANY(${mirrors}::UUID[])
    `) as DbRow[]).map((r) => [String(r.id), { stands: r.s === true, date: String(r.d) }] as const));
    // A mirror accounts for one sale row and one purchase row (the two sides of the same sale), never for two sales: each goes to the CLOSEST
    // post-cutover row that matches it (nearest date, then the earlier row), so a wide match never takes a mirror from the row it belongs to.
    const keysOf = (tx: DbRow) => ((tx.mirror_rows as string[] | null) ?? []).map((id) => `${id}:${String(tx.transaction_type) === 'purchase' ? 'p' : 's'}`);
    const gap = (tx: DbRow) => keysOf(tx).reduce((n, k) => n + Math.abs(Date.parse(String(tx.td)) - Date.parse(mirrorInfo.get(k.split(':')[0]!)?.date ?? String(tx.td))), 0);
    const leftToMirror = new Set<string>();
    const consumed = new Set<string>();
    for (const tx of icTxRows.filter((t) => cutoverOf(t) && keysOf(t).length > 0 && keysOf(t).every((k) => mirrorInfo.get(k.split(':')[0]!)?.stands))
      .sort((a, b) => gap(a) - gap(b))) {
      if (keysOf(tx).some((k) => consumed.has(k))) continue;
      keysOf(tx).forEach((k) => consumed.add(k));
      leftToMirror.add(String(tx.id));
    }

    for (const tx of icTxRows) {
      // One elimination per row: a second run skips a row whose elimination already stands (draft or posted). Two runs at once are serialised by
      // the lock above; where 1019 could build the partial unique index on consolidation_adjustments(source_intercompany_id), a duplicate insert
      // is also refused there (23505, mapped to EliminationAlreadyStandsError) and skipped.
      const standing = (await sql`
        SELECT 1 FROM consolidation_adjustments WHERE source_intercompany_id=${String(tx.id)}::UUID AND status IN ('draft','posted') LIMIT 1
      `) as DbRow[];
      if (standing.length > 0) continue;
      const mirroredRef = tx.mirror_rows ? String(tx.mirror_ref) : '';
      // RULING 2026-11-21: on or after the pair's cutover a sale-class row is left to mirroring ONLY when a mirror of this group that matches it
      // stands now; otherwise (rejected, pending, not approved, never sent, another group's) it is drafted, flagged, and the person decides.
      const cutover = cutoverOf(tx);
      if (cutover && leftToMirror.has(String(tx.id))) {
        skipped.push({ transactionId: String(tx.id), reason: `${ELIMINATED_BY_MIRRORING} (${mirroredRef})`, cutover, mirroredRef, ...label(tx) });
        continue;
      }
      // Before the cutover, a manual (P1) row that may be the same sale as a mirrored document is drafted, never skipped (a skip judged once could
      // not follow the mirror accepted, withdrawn or booked in another month later), and marked for the person who posts it.
      const note = cutover
        ? `CHECK BEFORE POSTING: the pair mirrors from ${cutover} but no mirrored elimination stands for this row${mirroredRef ? ` (mirrored document ${mirroredRef} is not eliminated automatically now, or already accounts for another row)` : ''}: post if correct - `
        : mirroredRef ? `CHECK BEFORE POSTING: possibly the same sale as mirrored document ${mirroredRef} - ` : '';
      const reason = cutover
        ? `the pair mirrors from ${cutover} but no mirrored elimination stands for this row${mirroredRef ? ` (mirrored document ${mirroredRef} is not eliminated automatically now, or already accounts for another row)` : ''}: post it if it is correct`
        : `possibly the same sale as mirrored document ${mirroredRef} (the same companies and direction, and its amount and date): posting it would eliminate the sale twice`;
      const txType = String(tx.transaction_type);
      const amount = Number(tx.amount);
      const srcId = String(tx.source_company_id);
      const tgtId = String(tx.target_company_id);
      const desc = `${note}${String(tx.description ?? '')}`;
      const flag = (made: ConsolidationAdjustment | null) => {
        if (made && note) flagged.push({ transactionId: String(tx.id), adjustmentId: made.id, mirroredRef, reason, ...label(tx) });
      };

      if (txType === 'sale' || txType === 'purchase' || txType === 'mgmt_fee') {
        const revGaId = await findGroupAccountByType(groupId, srcId, 'revenue');
        const expGaId = await findGroupAccountByType(groupId, tgtId, 'expense');
        if (revGaId && expGaId) {
          const lines: EliminationLine[] = [
            { groupAccountId: revGaId, debit: amount, credit: 0, description: `Eliminate intercompany ${txType} revenue` },
            { groupAccountId: expGaId, debit: 0, credit: amount, description: `Eliminate intercompany ${txType} expense` },
          ];
          flag(await createUnlessStanding(created, groupId, { adjustmentType: 'interco_revenue', description: `Auto-elimination: intercompany ${txType} - ${desc}`.trim(), periodStart, periodEnd, lines, sourceIntercompanyId: String(tx.id) }));
        }
      } else if (txType === 'loan' || txType === 'transfer') {
        const recGaId = await findGroupAccountBySubtype(groupId, srcId, 'receivable');
        const payGaId = await findGroupAccountBySubtype(groupId, tgtId, 'payable');
        if (recGaId && payGaId) {
          const lines: EliminationLine[] = [
            { groupAccountId: payGaId, debit: amount, credit: 0, description: `Eliminate intercompany payable` },
            { groupAccountId: recGaId, debit: 0, credit: amount, description: `Eliminate intercompany receivable` },
          ];
          flag(await createUnlessStanding(created, groupId, { adjustmentType: 'interco_balance', description: `Auto-elimination: intercompany ${txType} balance - ${desc}`.trim(), periodStart, periodEnd, lines, sourceIntercompanyId: String(tx.id) }));
        }
      }
    }

    log.info('Auto-generated elimination adjustments', { groupId, count: created.length, flagged: flagged.length, skipped: skipped.length }, 'accounting');
    return created;
  } catch (err) {
    log.error('Failed to auto-generate eliminations', { groupId, error: err }, 'accounting');
    throw err;
  }
}
