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

/**
 * An elimination THIS run drafted for a manual row that may be the same sale as a mirrored document (whose elimination is derived): it is
 * marked CHECK BEFORE POSTING, because posting it would eliminate the sale a second time. Never skipped.
 */
export interface FlaggedEliminationRow { transactionId: string; adjustmentId: string; mirroredRef: string; reason: string }

/**
 * A row this run did NOT draft because its pair mirrors (RULING 2026-11-21: a sale-class row of a mirroring pair dated on or after the pair's
 * cutover): the pair's documents are eliminated by mirroring.
 */
export interface SkippedEliminationRow { transactionId: string; reason: string; cutover: string }
export const ELIMINATED_BY_MIRRORING = 'eliminated by mirroring';
const SALE_TYPES = new Set(['sale', 'purchase', 'mgmt_fee']);

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
    `) as DbRow[];

    const created: ConsolidationAdjustment[] = [];
    const cutovers = await getPairCutovers(groupId);

    for (const tx of icTxRows) {
      // RULING 2026-11-21: from the pair's cutover its sales (either direction, sale / purchase / mgmt_fee) are eliminated by mirroring only
      const cutover = pairCutover(cutovers, String(tx.source_company_id), String(tx.target_company_id));
      if (cutover && SALE_TYPES.has(String(tx.transaction_type)) && String(tx.td) >= cutover) {
        skipped.push({ transactionId: String(tx.id), reason: ELIMINATED_BY_MIRRORING, cutover });
        continue;
      }
      // Before the cutover, a manual (P1) row that may be the same sale as a mirrored document is drafted, never skipped (a skip judged once could
      // not follow the mirror accepted, withdrawn or booked in another month later), and marked for the person who posts it.
      const mirroredRef = tx.mirror_rows ? String(tx.mirror_ref) : '';
      // One elimination per row: a second run skips a row whose elimination already stands (draft or posted). Two runs at once are serialised by
      // the lock above; where 1019 could build the partial unique index on consolidation_adjustments(source_intercompany_id), a duplicate insert
      // is also refused there (23505, mapped to EliminationAlreadyStandsError) and skipped.
      const standing = (await sql`
        SELECT 1 FROM consolidation_adjustments WHERE source_intercompany_id=${String(tx.id)}::UUID AND status IN ('draft','posted') LIMIT 1
      `) as DbRow[];
      if (standing.length > 0) continue;
      const txType = String(tx.transaction_type);
      const amount = Number(tx.amount);
      const srcId = String(tx.source_company_id);
      const tgtId = String(tx.target_company_id);
      const desc = `${mirroredRef ? `CHECK BEFORE POSTING: possibly the same sale as mirrored document ${mirroredRef} - ` : ''}${String(tx.description ?? '')}`;
      const flag = (made: ConsolidationAdjustment | null) => {
        if (made && mirroredRef) flagged.push({ transactionId: String(tx.id), adjustmentId: made.id, mirroredRef, reason: `possibly the same sale as mirrored document ${mirroredRef} (the same companies and direction, and its amount and date): posting it would eliminate the sale twice` });
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
