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
import { lockGroupEliminations } from './eliminationLock';
import { factsFromRows, generatorReason, linkedMirrorState, type LinkAnswer, type MirrorFacts } from './mirrorFacts';

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
export interface SkippedEliminationRow extends EliminationRowLabel {
  transactionId: string; reason: string; cutover: string; mirroredRef: string;
  /** What is true of the mirror for the period (mirrorFacts.ts): whether its elimination falls after the period, and on which date. */
  detail: string;
}
export const ELIMINATED_BY_MIRRORING = 'eliminated by mirroring';
const SALE_TYPES = new Set(['sale', 'purchase', 'mgmt_fee']);
/** What is true of the row's possible mirrored duplicate for the period (intercompany_mirror_facts), or null when it matches no mirror. */
async function factsOf(rowId: string, periodEnd: string): Promise<MirrorFacts | null> {
  return factsFromRows((await sql`SELECT f.*, f.elim_date::TEXT AS elim_date FROM public.intercompany_mirror_facts(${rowId}::UUID, ${periodEnd}::DATE) f`) as DbRow[], periodEnd);
}
const label = (tx: DbRow): EliminationRowLabel => ({ description: String(tx.description ?? ''), date: String(tx.td), amount: Number(tx.amount) });

/** The draft's description: the flag's note (if any) before the row's own description. */
function descriptionOf(tx: DbRow, note: string): string {
  const t = String(tx.transaction_type);
  return `Auto-elimination: intercompany ${t}${t === 'loan' || t === 'transfer' ? ' balance' : ''} - ${note}${String(tx.description ?? '')}`.trim();
}

/** Drafts the row's elimination (revenue / expense for a sale type, payable / receivable for a loan or transfer); null when it cannot or one stands. */
async function draft(groupId: string, tx: DbRow, note: string, periodStart: string, periodEnd: string, created: ConsolidationAdjustment[]): Promise<ConsolidationAdjustment | null> {
  const txType = String(tx.transaction_type);
  const amount = Number(tx.amount);
  const srcId = String(tx.source_company_id);
  const tgtId = String(tx.target_company_id);
  const base = { periodStart, periodEnd, description: descriptionOf(tx, note), sourceIntercompanyId: String(tx.id) };
  if (SALE_TYPES.has(txType)) {
    const revGaId = await findGroupAccountByType(groupId, srcId, 'revenue');
    const expGaId = await findGroupAccountByType(groupId, tgtId, 'expense');
    if (!revGaId || !expGaId) return null;
    const lines: EliminationLine[] = [
      { groupAccountId: revGaId, debit: amount, credit: 0, description: `Eliminate intercompany ${txType} revenue` },
      { groupAccountId: expGaId, debit: 0, credit: amount, description: `Eliminate intercompany ${txType} expense` },
    ];
    return createUnlessStanding(created, groupId, { ...base, adjustmentType: 'interco_revenue', lines });
  }
  if (txType === 'loan' || txType === 'transfer') {
    const recGaId = await findGroupAccountBySubtype(groupId, srcId, 'receivable');
    const payGaId = await findGroupAccountBySubtype(groupId, tgtId, 'payable');
    if (!recGaId || !payGaId) return null;
    const lines: EliminationLine[] = [
      { groupAccountId: payGaId, debit: amount, credit: 0, description: `Eliminate intercompany payable` },
      { groupAccountId: recGaId, debit: 0, credit: amount, description: `Eliminate intercompany receivable` },
    ];
    return createUnlessStanding(created, groupId, { ...base, adjustmentType: 'interco_balance', lines });
  }
  return null;
}

/** `flagged`, when given, receives the eliminations this run drafted with a flag, with why; `skipped` the rows it left to mirroring. */
export async function autoGenerateEliminations(
  groupId: string, periodStart: string, periodEnd: string, flagged: FlaggedEliminationRow[] = [], skipped: SkippedEliminationRow[] = [],
): Promise<ConsolidationAdjustment[]> {
  try {
    // Two runs for one group are serialised (the request transaction holds this to commit), so the per-row skip below sees the other run's rows
    // even where the partial unique index could not be built (1019 skips it while legacy duplicates exist).
    await lockGroupEliminations(groupId, 'autoGenerateEliminations');
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
    // Pass 1, in date order: the stored links (a row left to mirroring is skipped) and the drafts of the rows on or after their pair's cutover
    // that are not (drafted here, so a later row's 'closer' check sees them as drafted, as one pass did). Pass 2 words every flag once ALL of
    // the run's links are made, so a flag never says a mirror "is not matched to any row yet" that a later row of the same run took.
    const pending: Array<{ tx: DbRow; cutover: string | null; link: LinkAnswer | null; made?: ConsolidationAdjustment | null }> = [];
    for (const tx of icTxRows) {
      // One elimination per row: a second run skips a row whose elimination already stands (draft or posted). Two runs at once are serialised by
      // the lock above; where 1019 could build the partial unique index on consolidation_adjustments(source_intercompany_id), a duplicate insert
      // is also refused there (23505, mapped to EliminationAlreadyStandsError) and skipped.
      const standing = (await sql`
        SELECT 1 FROM consolidation_adjustments WHERE source_intercompany_id=${String(tx.id)}::UUID AND status IN ('draft','posted') LIMIT 1
      `) as DbRow[];
      if (standing.length > 0) continue;
      // RULING 2026-11-21: on or after the pair's cutover a sale-class row is left to mirroring ONLY when a mirrored document of this group
      // eliminates it for this period, and that answer is STORED (intercompany_mirror_link): one mirror accounts for at most one sale row and
      // one purchase row across every run and period, so a later run reads the link instead of matching again. Otherwise the row is drafted.
      const cutover = cutoverOf(tx);
      if (!cutover) { pending.push({ tx, cutover: null, link: null }); continue; }
      const link = ((await sql`SELECT state, mirror_ref FROM public.intercompany_mirror_link(${String(tx.id)}::UUID, ${periodEnd}::DATE)`) as DbRow[])[0];
      const answer: LinkAnswer = { state: String(link?.state ?? 'none'), ref: link?.mirror_ref ? String(link.mirror_ref) : '' };
      if (answer.state === 'linked') {
        const facts = await factsOf(String(tx.id), periodEnd);
        skipped.push({ transactionId: String(tx.id), reason: `${ELIMINATED_BY_MIRRORING} (${answer.ref})`, cutover, mirroredRef: answer.ref,
          detail: facts ? linkedMirrorState(facts, answer.ref) : '', ...label(tx) });
        continue;
      }
      pending.push({ tx, cutover, link: answer, made: await draft(groupId, tx, '', periodStart, periodEnd, created) });
    }

    // Pass 2: the flags. A row that may be the same sale as a mirrored document (before the cutover: drafted, never skipped, as a skip judged
    // once could not follow the mirror accepted, withdrawn or booked in another month later; on or after it: no standing mirror was left to it)
    // is marked CHECK BEFORE POSTING with what is TRUE of its mirror(s) for the period: the facts' one wording (mirrorFacts.ts).
    // the note is stored with the draft, so it says when it was true (the list's badge is the live answer)
    const runDate = String(((await sql`SELECT (now() AT TIME ZONE 'Africa/Johannesburg')::date::TEXT AS d`) as DbRow[])[0]?.d ?? '');
    for (const p of pending) {
      const facts = await factsOf(String(p.tx.id), periodEnd);
      const reason = p.cutover || facts ? generatorReason(facts, p.cutover, p.link, periodEnd) : '';
      const note = reason ? `CHECK BEFORE POSTING (as found by the run of ${runDate}): ${reason} - ` : '';
      let made = p.made;
      if (made === undefined) made = await draft(groupId, p.tx, note, periodStart, periodEnd, created);
      else if (made && note) {
        made.description = descriptionOf(p.tx, note);
        await sql`UPDATE consolidation_adjustments SET description = ${made.description} WHERE id = ${made.id}::UUID AND status = 'draft'`;
      }
      if (made && note) flagged.push({ transactionId: String(p.tx.id), adjustmentId: made.id, mirroredRef: facts?.label ?? p.link?.ref ?? '', reason, ...label(p.tx) });
    }

    log.info('Auto-generated elimination adjustments', { groupId, count: created.length, flagged: flagged.length, skipped: skipped.length }, 'accounting');
    return created;
  } catch (err) {
    log.error('Failed to auto-generate eliminations', { groupId, error: err }, 'accounting');
    throw err;
  }
}
