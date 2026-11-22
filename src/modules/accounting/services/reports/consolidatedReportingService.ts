/**
 * Consolidated Reporting Service
 *
 * Group dashboard stats, elimination journal CRUD, and auto-generation.
 * Re-exports trial balance and statement generators for backward compatibility.
 */

import { toIsoTimestamp } from '@/lib/dateUtils';
import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getGroupMembers } from './consolidatedTrialBalanceService';
import { getMirroredEliminations, type DroppedMirroredElimination } from './mirrorEliminations';
import type { DbRow } from '@/types/db';
import { AR_OPEN_STATUSES, AP_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { BANK_SUBTYPES } from '../gl/accountSubtypes';
import { asAtTodayStr, documentInLedgerAsAtFragmentForRowTenant } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { EliminationAlreadyStandsError, EliminationStateError, EliminationUnbalancedError } from './eliminationErrors';
import { storedEliminationRows } from './eliminationDuplicates';
import { allStand, anyLinkedElsewhere, factsFromRows, type MirrorFacts } from './mirrorFacts';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';

// ── Re-exports ────────────────────────────────────────────────────────────────

export { getConsolidatedTrialBalance } from './consolidatedTrialBalanceService';
export type { ConsolidatedTrialBalance } from './consolidatedTrialBalanceService';
export { getConsolidatedIncomeStatement, getConsolidatedBalanceSheet } from './consolidatedStatementsService';
export { autoGenerateEliminations } from './eliminationGenerator';
export { postEliminationAdjustment } from './eliminationDuplicates';
export type { ConsolidatedIncomeStatement, ConsolidatedBalanceSheet } from './consolidatedStatementsService';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EntitySummary {
  companyId: string; companyName: string; revenue: number;
  expenses: number; netProfit: number; cashPosition: number;
}
export interface GroupDashboardStats {
  groupId: string; combinedCashPosition: number; combinedARTotal: number;
  combinedAPTotal: number; combinedRevenue: number; combinedExpenses: number;
  entitySummaries: EntitySummary[];
}
export interface EliminationLine { groupAccountId: string; debit: number; credit: number; description: string; }
export interface ConsolidationAdjustment {
  id: string; groupId: string; adjustmentNumber: string; adjustmentType: string;
  description: string; periodStart: string; periodEnd: string; status: string;
  lines: EliminationLine[]; sourceIntercompanyId: string | null;
  postedBy: string | null; postedAt: string | null; createdAt: string;
  /** A derived line (mirrored intercompany documents): computed from the ledgers at read time, never stored; it cannot be posted or reversed. */
  automatic?: boolean;
  /** A draft or posted stored adjustment whose source row now matches a live mirrored sale (intercompany_mirrored_duplicate): the mirror(s) named (facts.label). */
  mirroredDuplicateOf?: string | null;
  /** What is true of that mirror(s) for the adjustment's period (intercompany_mirror_facts): every sentence about it is worded from these (mirrorFacts.ts). */
  mirrorFacts?: MirrorFacts | null;
  /** Derived from mirrorFacts (never worded on its own): every named mirror is eliminated automatically for the period. */
  mirrorStands?: boolean | null;
  /** Derived from mirrorFacts: some named mirror is held by another row's active link. */
  mirrorLinked?: boolean | null;
  /** How many listed adjustments name the same mirror(s): more than one means at most one of them can be the duplicate. */
  mirrorShared?: number | null;
  /** The row is on or after its mirroring pair's cutover (so no standing mirror was left to it): the cutover date. */
  pairCutover?: string | null;
  /** Why a person made this elimination by hand for a group whose pairs mirror (required on or after a pair's cutover). */
  manualReason?: string | null;
}
export interface CreateEliminationInput {
  adjustmentType: string; description: string; periodStart: string; periodEnd: string;
  lines: EliminationLine[]; sourceIntercompanyId?: string; manualReason?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function mapAdjustmentRow(r: DbRow): ConsolidationAdjustment {
  const rawLines = typeof r.lines === 'string' ? JSON.parse(r.lines) : r.lines;
  return {
    id: String(r.id), groupId: String(r.group_id),
    adjustmentNumber: String(r.adjustment_number ?? ''), adjustmentType: String(r.adjustment_type),
    description: r.description ? String(r.description) : '',
    periodStart: String(r.period_start ?? ''), periodEnd: String(r.period_end ?? ''),
    status: String(r.status), lines: Array.isArray(rawLines) ? rawLines : [],
    sourceIntercompanyId: r.source_intercompany_id ? String(r.source_intercompany_id) : null,
    postedBy: r.posted_by ? String(r.posted_by) : null,
    postedAt: r.posted_at ? toIsoTimestamp(r.posted_at as Date | string) : null, createdAt: (toIsoTimestamp(r.created_at as Date | string) ?? ''),
    manualReason: r.manual_reason ? String(r.manual_reason) : null,
  };
}

// ── Group Dashboard Stats ─────────────────────────────────────────────────────

export async function getGroupDashboardStats(groupId: string): Promise<GroupDashboardStats> {
  try {
    const members = await getGroupMembers(groupId);
    let combinedCashPosition = 0, combinedARTotal = 0, combinedAPTotal = 0, combinedRevenue = 0, combinedExpenses = 0;
    const entitySummaries: EntitySummary[] = [];
    const currentYear = new Date().getFullYear();
    const yearStart = `${currentYear}-01-01`; const yearEnd = `${currentYear}-12-31`;

    const companyIds = members.map(m => m.companyId);
    // K-053: AR/AP below are "as at now". See shared/softDeleteLedgerPresence.
    const groupAsAtStr = asAtTodayStr();

    // Batch all 4 queries using company_id = ANY(...) instead of N loops
    const [cashRows, arRows, apRows, plRows] = await Promise.all([
      // is_active is NOT a filter here: it is a chart-of-accounts picker
      // flag, so a deactivated member bank account must still contribute its
      // cash to the group position.
      // Latent, not benign: R0 delta today only because no inactive bank
      // account holds a bank_transactions row yet. Do not reinstate.
      // Cash is SUM(bank_transactions.amount) over bank-subtype GL accounts —
      // the same definition kpiDashboardService and bankAccountStatusService
      // use. bank_accounts.current_balance was read here previously, but
      // bank_accounts is vestigial (0 rows in production) so group cash was
      // always 0.
      sql`SELECT bt.company_id, COALESCE(SUM(bt.amount),0) AS cash
          FROM bank_transactions bt
          JOIN gl_accounts ga ON ga.id = bt.bank_account_id AND ga.company_id = bt.company_id
          WHERE bt.company_id = ANY(${companyIds}::UUID[])
            AND ga.company_id = ANY(${companyIds}::UUID[])
            AND ga.account_subtype = ANY(${BANK_SUBTYPES as string[]})
            AND bt.feed_state = 'posted'
          GROUP BY bt.company_id` as Promise<DbRow[]>,
      // There is no balance_due column on either invoice table — these queries
      // threw 42703, taking the whole dashboard down. Outstanding is
      // total_amount - amount_paid, and the open-status allowlists are the
      // shared LIVE constants ('partial' was never a legal status, and
      // supplier_invoices has no 'overdue'). NOT the aging reports' set: this
      // used to say it was. See src/lib/constants/invoiceStatuses.ts.
      sql`SELECT company_id, COALESCE(SUM(total_amount - COALESCE(amount_paid,0)),0) AS ar
          FROM customer_invoices ci
          WHERE ci.company_id = ANY(${companyIds}::UUID[])
            AND ${documentInLedgerAsAtFragmentForRowTenant('ci', groupAsAtStr)}
            AND ci.status = ANY(${Array.from(AR_OPEN_STATUSES)}::text[])
          GROUP BY ci.company_id` as Promise<DbRow[]>,
      sql`SELECT company_id, COALESCE(SUM(total_amount - COALESCE(amount_paid,0)),0) AS ap
          FROM supplier_invoices si
          WHERE si.company_id = ANY(${companyIds}::UUID[])
            AND ${documentInLedgerAsAtFragmentForRowTenant('si', groupAsAtStr)}
            AND si.status = ANY(${Array.from(AP_OPEN_STATUSES)}::text[])
          GROUP BY si.company_id` as Promise<DbRow[]>,
      sql`SELECT je.company_id, ga.account_type, COALESCE(SUM(jl.debit),0) AS total_debit, COALESCE(SUM(jl.credit),0) AS total_credit
          FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id=jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id=jl.gl_account_id
          WHERE je.status='posted' AND je.source IS DISTINCT FROM ${YEAR_END_JOURNAL_SOURCE} AND jl.company_id = ANY(${companyIds}::UUID[]) AND je.company_id = ANY(${companyIds}::UUID[]) AND ga.company_id = ANY(${companyIds}::UUID[])
            AND je.entry_date>=${yearStart} AND je.entry_date<=${yearEnd} AND ga.account_type IN ('revenue','expense')
          GROUP BY je.company_id, ga.account_type` as Promise<DbRow[]>,
    ]);

    // Index results by company_id for O(1) lookups
    const cashByCompany = new Map(cashRows.map(r => [String(r.company_id), Number(r.cash ?? 0)]));
    const arByCompany = new Map(arRows.map(r => [String(r.company_id), Number(r.ar ?? 0)]));
    const apByCompany = new Map(apRows.map(r => [String(r.company_id), Number(r.ap ?? 0)]));
    const plByCompany = new Map<string, { revenue: number; expenses: number }>();
    for (const r of plRows) {
      const cid = String(r.company_id);
      const entry = plByCompany.get(cid) ?? { revenue: 0, expenses: 0 };
      if (String(r.account_type) === 'revenue') entry.revenue = Number(r.total_credit) - Number(r.total_debit);
      else entry.expenses = Number(r.total_debit) - Number(r.total_credit);
      plByCompany.set(cid, entry);
    }

    for (const member of members) {
      const cash = cashByCompany.get(member.companyId) ?? 0;
      const ar = arByCompany.get(member.companyId) ?? 0;
      const ap = apByCompany.get(member.companyId) ?? 0;
      const pl = plByCompany.get(member.companyId) ?? { revenue: 0, expenses: 0 };
      combinedCashPosition += cash; combinedARTotal += ar;
      combinedAPTotal += ap; combinedRevenue += pl.revenue; combinedExpenses += pl.expenses;
      entitySummaries.push({ companyId: member.companyId, companyName: member.companyName, revenue: pl.revenue, expenses: pl.expenses, netProfit: pl.revenue - pl.expenses, cashPosition: cash });
    }
    return { groupId, combinedCashPosition, combinedARTotal, combinedAPTotal, combinedRevenue, combinedExpenses, entitySummaries };
  } catch (err) {
    log.error('Failed to generate group dashboard stats', { groupId, error: err }, 'accounting');
    throw err;
  }
}

// ── Elimination Journal CRUD ──────────────────────────────────────────────────

export async function createEliminationAdjustment(
  groupId: string, input: CreateEliminationInput
): Promise<ConsolidationAdjustment> {
  try {
    let totalDebit = 0, totalCredit = 0;
    for (const line of input.lines) { totalDebit += line.debit; totalCredit += line.credit; }
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new EliminationUnbalancedError(totalDebit, totalCredit);
    }
    // No ON CONFLICT: 1019 builds the partial unique index only where no legacy duplicates exist, and an ON CONFLICT naming an index that is
    // absent fails every insert. Where the index exists a second standing elimination of a row is a unique violation, mapped to the skip.
    let rows: DbRow[];
    try {
      rows = await withSavepoint('consolidation_adjustment_insert', async () => (await sql`
        INSERT INTO consolidation_adjustments (
          group_id, adjustment_type, description, period_start, period_end, lines, source_intercompany_id, manual_reason
        ) VALUES (
          ${groupId}::UUID, ${input.adjustmentType}, ${input.description},
          ${input.periodStart}, ${input.periodEnd}, ${JSON.stringify(input.lines)}::JSONB,
          ${input.sourceIntercompanyId ?? null}::UUID, ${input.manualReason ?? null}
        ) RETURNING *
      `) as DbRow[]);
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === '23505' && e.constraint === 'uq_consolidation_adjustments_standing_source') throw new EliminationAlreadyStandsError(input.sourceIntercompanyId ?? '');
      throw err;
    }
    log.info('Created elimination adjustment', { groupId, id: rows[0]!.id }, 'accounting');
    return mapAdjustmentRow(rows[0]!);
  } catch (err) {
    if (err instanceof EliminationAlreadyStandsError) log.info('Elimination already stands for this row', { groupId, sourceIntercompanyId: input.sourceIntercompanyId }, 'accounting');
    else log.error('Failed to create elimination adjustment', { groupId, error: err }, 'accounting');
    throw err;
  }
}

export async function reverseEliminationAdjustment(adjustmentId: string, groupId: string): Promise<void> {
  try {
    const result = (await sql`
      UPDATE consolidation_adjustments SET status='reversed', updated_at=NOW()
      WHERE id=${adjustmentId}::UUID AND group_id=${groupId}::UUID AND status='posted' RETURNING id
    `) as DbRow[];
    if (result.length === 0) throw new EliminationStateError(adjustmentId, 'posted');
    log.info('Reversed elimination adjustment', { adjustmentId, groupId }, 'accounting');
  } catch (err) {
    log.error('Failed to reverse elimination adjustment', { adjustmentId, groupId, error: err }, 'accounting');
    throw err;
  }
}

/** A draft is never deleted (the app has no DELETE on it): it is marked discarded, and counts, lists and blocks nothing. */
export async function discardEliminationAdjustment(adjustmentId: string, groupId: string): Promise<void> {
  try {
    const result = (await sql`
      UPDATE consolidation_adjustments SET status='discarded', updated_at=NOW()
      WHERE id=${adjustmentId}::UUID AND group_id=${groupId}::UUID AND status='draft' RETURNING id
    `) as DbRow[];
    if (result.length === 0) throw new EliminationStateError(adjustmentId, 'draft');
    log.info('Discarded elimination adjustment', { adjustmentId, groupId }, 'accounting');
  } catch (err) {
    log.error('Failed to discard elimination adjustment', { adjustmentId, groupId, error: err }, 'accounting');
    throw err;
  }
}

/** `dropped`, when given, receives the period's mirrored eliminations that could not be applied (an account with no group account). */
export async function getEliminationAdjustments(
  groupId: string, periodStart?: string, periodEnd?: string, dropped?: DroppedMirroredElimination[],
): Promise<ConsolidationAdjustment[]> {
  try {
    const pStart = periodStart ?? null; const pEnd = periodEnd ?? null;
    // A draft or posted manual adjustment whose row now matches a live mirrored sale may be eliminating that sale a second time
    // (eliminationDuplicates.ts): the list says so, with whether the mirror is eliminated automatically and how many share it.
    const rows = await storedEliminationRows(groupId, pStart, pEnd);
    const stored = rows.map((r) => {
      const facts = factsFromRows(r.mirror_facts as DbRow[] | null, String(r.facts_period_end));
      return { ...mapAdjustmentRow(r), mirroredDuplicateOf: facts?.label ?? null, mirrorFacts: facts,
        mirrorStands: facts ? allStand(facts) : null, mirrorLinked: facts ? anyLinkedElsewhere(facts) : null,
        mirrorShared: r.mirror_shared == null ? null : Number(r.mirror_shared), pairCutover: r.pair_cutover ? String(r.pair_cutover) : null };
    });
    // The mirrored documents' eliminations are derived (the events dated in the period: an elimination, or a counter-elimination labelled as
    // one when the pair stopped standing), not stored: listed before the stored ones, labelled, with no id to act on.
    const derived = pStart && pEnd ? await getMirroredEliminations(groupId, pStart, pEnd, dropped) : [];
    return [...derived.map((m): ConsolidationAdjustment => ({
      id: `mirror:${m.transactionId}:${m.receiverJournalId}:${m.kind}`, groupId, adjustmentNumber: 'AUTO', adjustmentType: 'interco_revenue', description: m.description,
      periodStart: m.keyDate, periodEnd: m.keyDate, status: 'posted', automatic: true,
      lines: m.lines.map(l => ({ groupAccountId: l.groupAccountId, debit: l.debit, credit: l.credit, description: l.description })),
      sourceIntercompanyId: m.transactionId, postedBy: null, postedAt: null, createdAt: m.keyDate,
    })), ...stored];
  } catch (err) {
    log.error('Failed to fetch elimination adjustments', { groupId, error: err }, 'accounting');
    throw err;
  }
}
