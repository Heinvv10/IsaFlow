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

/** Creates the elimination of a row unless one already stands (a concurrent run won): that is a skip, not an error. */
async function createUnlessStanding(created: ConsolidationAdjustment[], groupId: string, input: CreateEliminationInput): Promise<void> {
  try {
    created.push(await createEliminationAdjustment(groupId, input));
  } catch (err) {
    if (!(err instanceof EliminationAlreadyStandsError)) throw err;
  }
}

export async function autoGenerateEliminations(
  groupId: string, periodStart: string, periodEnd: string
): Promise<ConsolidationAdjustment[]> {
  try {
    // Two runs for one group are serialised (the request transaction holds this to commit), so the per-row skip below sees the other run's rows
    // even where the partial unique index could not be built (1019 skips it while legacy duplicates exist).
    await sql`SELECT pg_advisory_xact_lock(hashtext('consolidation-eliminations:' || ${groupId}::TEXT))`;
    const icTxRows = (await sql`
      SELECT ict.id, ict.source_company_id, ict.target_company_id,
             ict.transaction_type, ict.amount, ict.description
      FROM intercompany_transactions ict
      WHERE ict.group_id=${groupId}::UUID AND ict.match_status='matched'
        AND NOT public.intercompany_is_mirrored_row(ict.id) -- a mirrored document's elimination is derived from the ledgers (mirrorEliminations.ts), never stored
        AND ict.transaction_date>=${periodStart} AND ict.transaction_date<=${periodEnd}
    `) as DbRow[];

    const created: ConsolidationAdjustment[] = [];

    for (const tx of icTxRows) {
      // One elimination per row: a second run skips a row whose elimination already stands (draft or posted). Two runs at once are stopped by the
      // partial unique index on consolidation_adjustments(source_intercompany_id) (1019): the loser's insert does nothing (ON CONFLICT) and is skipped.
      const standing = (await sql`
        SELECT 1 FROM consolidation_adjustments WHERE source_intercompany_id=${String(tx.id)}::UUID AND status IN ('draft','posted') LIMIT 1
      `) as DbRow[];
      if (standing.length > 0) continue;
      const txType = String(tx.transaction_type);
      const amount = Number(tx.amount);
      const srcId = String(tx.source_company_id);
      const tgtId = String(tx.target_company_id);
      const desc = tx.description ?? '';

      if (txType === 'sale' || txType === 'purchase' || txType === 'mgmt_fee') {
        const revGaId = await findGroupAccountByType(groupId, srcId, 'revenue');
        const expGaId = await findGroupAccountByType(groupId, tgtId, 'expense');
        if (revGaId && expGaId) {
          const lines: EliminationLine[] = [
            { groupAccountId: revGaId, debit: amount, credit: 0, description: `Eliminate intercompany ${txType} revenue` },
            { groupAccountId: expGaId, debit: 0, credit: amount, description: `Eliminate intercompany ${txType} expense` },
          ];
          await createUnlessStanding(created, groupId, { adjustmentType: 'interco_revenue', description: `Auto-elimination: intercompany ${txType} - ${desc}`.trim(), periodStart, periodEnd, lines, sourceIntercompanyId: String(tx.id) });
        }
      } else if (txType === 'loan' || txType === 'transfer') {
        const recGaId = await findGroupAccountBySubtype(groupId, srcId, 'receivable');
        const payGaId = await findGroupAccountBySubtype(groupId, tgtId, 'payable');
        if (recGaId && payGaId) {
          const lines: EliminationLine[] = [
            { groupAccountId: payGaId, debit: amount, credit: 0, description: `Eliminate intercompany payable` },
            { groupAccountId: recGaId, debit: 0, credit: amount, description: `Eliminate intercompany receivable` },
          ];
          await createUnlessStanding(created, groupId, { adjustmentType: 'interco_balance', description: `Auto-elimination: intercompany ${txType} balance - ${desc}`.trim(), periodStart, periodEnd, lines, sourceIntercompanyId: String(tx.id) });
        }
      }
    }

    log.info('Auto-generated elimination adjustments', { groupId, count: created.length }, 'accounting');
    return created;
  } catch (err) {
    log.error('Failed to auto-generate eliminations', { groupId, error: err }, 'accounting');
    throw err;
  }
}
