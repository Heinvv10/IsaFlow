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
 * mirrored document of THIS group eliminates for the period: the stored, exclusive link intercompany_mirror_link makes (one mirror, one
 * sale row and one purchase row, across every run and period). A run for a period whose mirror stopped eliminating the row in it (judged as
 * at that period, so a stop after it is the mirror's own counter-elimination later) releases the link and drafts the row.
 */
export interface SkippedEliminationRow extends EliminationRowLabel { transactionId: string; reason: string; cutover: string; mirroredRef: string }
export const ELIMINATED_BY_MIRRORING = 'eliminated by mirroring';
const SALE_TYPES = new Set(['sale', 'purchase', 'mgmt_fee']);
/** Why a post-cutover row was drafted, by the stored link's answer (intercompany_mirror_link). */
const NOT_LEFT_TO_MIRROR: Record<string, (ref: string, periodEnd: string) => string> = {
  released: (ref, end) => `mirrored document ${ref} no longer eliminates this row for the period to ${end} (it was left to it before)`,
  taken: (ref) => `mirrored document ${ref} already eliminates another row`,
  closer: (ref) => `mirrored document ${ref} belongs to a closer row`,
  none: (ref, end) => ref ? `mirrored document ${ref} is not eliminated automatically for the period to ${end}` : 'no mirrored document eliminates this row',
};
/** Whether every named mirror is eliminated automatically for the period ending `periodEnd` (intercompany_mirror_stands). */
async function mirrorsStand(rows: unknown, periodEnd: string): Promise<boolean> {
  const ids = Array.isArray(rows) ? rows.map(String) : [];
  if (ids.length === 0) return false;
  const r = (await sql`SELECT bool_and(COALESCE(public.intercompany_mirror_stands(x, ${periodEnd}::DATE), false)) AS s FROM unnest(${ids}::UUID[]) x`) as DbRow[];
  return r[0]?.s === true;
}
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
             ict.transaction_type, ict.amount, ict.description, ict.transaction_date::TEXT AS td
      FROM intercompany_transactions ict
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
    for (const tx of icTxRows) {
      // One elimination per row: a second run skips a row whose elimination already stands (draft or posted). Two runs at once are serialised by
      // the lock above; where 1019 could build the partial unique index on consolidation_adjustments(source_intercompany_id), a duplicate insert
      // is also refused there (23505, mapped to EliminationAlreadyStandsError) and skipped.
      const standing = (await sql`
        SELECT 1 FROM consolidation_adjustments WHERE source_intercompany_id=${String(tx.id)}::UUID AND status IN ('draft','posted') LIMIT 1
      `) as DbRow[];
      if (standing.length > 0) continue;
      // the possible mirrored duplicate, judged as at the period (only for a row this run may draft: a row left to mirroring needs none)
      const dupOf = async () => ((await sql`SELECT mirror_rows, mirror_ref FROM public.intercompany_mirrored_duplicate(${String(tx.id)}::UUID, ${periodEnd}::DATE)`) as DbRow[])[0];
      let mirroredRef = '';
      let mirrorRows: unknown = null;
      // RULING 2026-11-21: on or after the pair's cutover a sale-class row is left to mirroring ONLY when a mirrored document of this group
      // eliminates it for this period, and that answer is STORED (intercompany_mirror_link): one mirror accounts for at most one sale row and
      // one purchase row across every run and period, so a later run reads the link instead of matching again. Otherwise the row is drafted.
      const cutover = cutoverOf(tx);
      let why = '';
      if (cutover) {
        const link = ((await sql`SELECT state, mirror_ref FROM public.intercompany_mirror_link(${String(tx.id)}::UUID, ${periodEnd}::DATE)`) as DbRow[])[0];
        const state = String(link?.state ?? 'none');
        if (link?.mirror_ref) mirroredRef = String(link.mirror_ref);
        else { const d = await dupOf(); if (d?.mirror_rows) mirroredRef = String(d.mirror_ref); }
        if (state === 'linked') {
          skipped.push({ transactionId: String(tx.id), reason: `${ELIMINATED_BY_MIRRORING} (${mirroredRef})`, cutover, mirroredRef, ...label(tx) });
          continue;
        }
        why = (NOT_LEFT_TO_MIRROR[state] ?? NOT_LEFT_TO_MIRROR.none!)(mirroredRef, periodEnd);
      } else {
        const d = await dupOf();
        if (d?.mirror_rows) { mirroredRef = String(d.mirror_ref); mirrorRows = d.mirror_rows; }
      }
      // Before the cutover, a manual (P1) row that may be the same sale as a mirrored document is drafted, never skipped (a skip judged once could
      // not follow the mirror accepted, withdrawn or booked in another month later), and marked for the person who posts it, saying whether
      // that mirror is eliminated automatically for the period (a cancelled or unapproved one is not: then this may be the sale's only elimination).
      const preStands = !cutover && mirroredRef ? await mirrorsStand(mirrorRows, periodEnd) : false;
      const reason = cutover
        ? `the pair mirrors from ${cutover}, but ${why}: post it if it is correct`
        : preStands
          ? `possibly the same sale as mirrored document ${mirroredRef} (the same companies and direction, and its amount and date): posting it would eliminate the sale twice`
          : `possibly the same sale as mirrored document ${mirroredRef} (the same companies and direction, and its amount and date), which is NOT eliminated automatically for the period to ${periodEnd}: this may be the sale's only elimination`;
      const note = cutover || mirroredRef ? `CHECK BEFORE POSTING: ${reason} - ` : '';
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
