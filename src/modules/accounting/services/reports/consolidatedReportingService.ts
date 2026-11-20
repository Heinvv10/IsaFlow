/**
 * Consolidated Reporting Service
 *
 * Group dashboard stats, elimination journal CRUD, and auto-generation.
 * Re-exports trial balance and statement generators for backward compatibility.
 */

import { toIsoTimestamp } from '@/lib/dateUtils';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getGroupMembers } from './consolidatedTrialBalanceService';
import type { DbRow } from '@/types/db';
import { AR_OPEN_STATUSES, AP_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';
import { BANK_SUBTYPES } from '../gl/accountSubtypes';
import { asAtTodayStr, documentInLedgerAsAtFragmentForRowTenant } from '@/modules/accounting/services/shared/softDeleteLedgerPresence';
import { EliminationNotCarriedError, EliminationStateError, EliminationUnbalancedError } from './eliminationErrors';
import { YEAR_END_JOURNAL_SOURCE } from '@/modules/accounting/services/gl/yearEndJournalSource';

// ── Re-exports ────────────────────────────────────────────────────────────────

export { getConsolidatedTrialBalance } from './consolidatedTrialBalanceService';
export type { ConsolidatedTrialBalance } from './consolidatedTrialBalanceService';
export { getConsolidatedIncomeStatement, getConsolidatedBalanceSheet } from './consolidatedStatementsService';
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
interface EliminationLine { groupAccountId: string; debit: number; credit: number; description: string; }
export interface ConsolidationAdjustment {
  id: string; groupId: string; adjustmentNumber: string; adjustmentType: string;
  description: string; periodStart: string; periodEnd: string; status: string;
  lines: EliminationLine[]; sourceIntercompanyId: string | null;
  postedBy: string | null; postedAt: string | null; createdAt: string;
}
interface CreateEliminationInput {
  adjustmentType: string; description: string; periodStart: string; periodEnd: string;
  lines: EliminationLine[]; sourceIntercompanyId?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapAdjustmentRow(r: DbRow): ConsolidationAdjustment {
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
  };
}

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
    const rows = (await sql`
      INSERT INTO consolidation_adjustments (
        group_id, adjustment_type, description, period_start, period_end, lines, source_intercompany_id
      ) VALUES (
        ${groupId}::UUID, ${input.adjustmentType}, ${input.description},
        ${input.periodStart}, ${input.periodEnd}, ${JSON.stringify(input.lines)}::JSONB,
        ${input.sourceIntercompanyId ?? null}::UUID
      ) RETURNING *
    `) as DbRow[];
    log.info('Created elimination adjustment', { groupId, id: rows[0]!.id }, 'accounting');
    return mapAdjustmentRow(rows[0]!);
  } catch (err) {
    log.error('Failed to create elimination adjustment', { groupId, error: err }, 'accounting');
    throw err;
  }
}

/** The elimination feed of one group has one writer at a time: the generator, a post, and every definer that changes a mirrored row's match state take this lock first. */
async function lockEliminations(groupId: string): Promise<void> {
  await sql`SELECT public.intercompany_lock_eliminations(${groupId}::UUID)`;
}

export async function postEliminationAdjustment(adjustmentId: string, groupId: string): Promise<void> {
  try {
    await lockEliminations(groupId);
    const source = (await sql`
      SELECT ca.source_intercompany_id AS src, public.intercompany_row_eliminable(ca.source_intercompany_id) AS ok
        FROM consolidation_adjustments ca WHERE ca.id=${adjustmentId}::UUID AND ca.group_id=${groupId}::UUID AND ca.source_intercompany_id IS NOT NULL
    `) as DbRow[];
    if (source[0] && source[0].ok !== true) throw new EliminationNotCarriedError(adjustmentId);
    const result = (await sql`
      UPDATE consolidation_adjustments SET status='posted', posted_at=NOW(), updated_at=NOW()
      WHERE id=${adjustmentId}::UUID AND group_id=${groupId}::UUID AND status='draft' RETURNING id
    `) as DbRow[];
    if (result.length === 0) throw new EliminationStateError(adjustmentId, 'draft');
    log.info('Posted elimination adjustment', { adjustmentId, groupId }, 'accounting');
  } catch (err) {
    log.error('Failed to post elimination adjustment', { adjustmentId, groupId, error: err }, 'accounting');
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

export async function getEliminationAdjustments(
  groupId: string, periodStart?: string, periodEnd?: string
): Promise<ConsolidationAdjustment[]> {
  try {
    const pStart = periodStart ?? null; const pEnd = periodEnd ?? null;
    const rows = (await sql`
      SELECT * FROM consolidation_adjustments
      WHERE group_id=${groupId}::UUID
        AND (${pStart}::DATE IS NULL OR period_start >= ${pStart}::DATE)
        AND (${pEnd}::DATE IS NULL OR period_end <= ${pEnd}::DATE)
      ORDER BY created_at DESC
    `) as DbRow[];
    return rows.map(mapAdjustmentRow);
  } catch (err) {
    log.error('Failed to fetch elimination adjustments', { groupId, error: err }, 'accounting');
    throw err;
  }
}

// ── Auto-generation ───────────────────────────────────────────────────────────

/**
 * Reverses (with when and why) the standing eliminations of mirrored group rows that are no longer carried by both ledgers: the repair for a
 * release that was missed (a failed hook, a reversal made some other way). A row that is no message's is never touched.
 */
export async function reverseStaleEliminations(groupId: string): Promise<number> {
  await sql`SELECT public.intercompany_release_stale_rows(${groupId}::UUID)`;   // (the rows that still say matched; their eliminations are reversed with them)
  const rows = (await sql`
    UPDATE consolidation_adjustments ca
       SET status = 'reversed', updated_at = NOW(), reversed_at = NOW(), reversed_reason = 'the intercompany row is no longer carried by both ledgers'
     WHERE ca.group_id = ${groupId}::UUID AND ca.status IN ('draft', 'posted') AND ca.source_intercompany_id IS NOT NULL
       AND public.intercompany_row_eliminable(ca.source_intercompany_id) IS NOT TRUE
    RETURNING ca.id
  `) as DbRow[];
  if (rows.length > 0) log.warn('Stale intercompany eliminations reversed', { groupId, count: rows.length }, 'accounting');
  return rows.length;
}

export async function autoGenerateEliminations(
  groupId: string, periodStart: string, periodEnd: string
): Promise<ConsolidationAdjustment[]> {
  try {
    // One generator per group at a time (the second waits for the first's commit, then finds its eliminations). An advisory lock, not row locks:
    // FOR UPDATE through the UPDATE policy silently drops the rows a group writer of only a THIRD company may not update.
    await lockEliminations(groupId);
    await reverseStaleEliminations(groupId);
    const icTxRows = (await sql`
      SELECT ict.id, ict.source_company_id, ict.target_company_id,
             ict.transaction_type, ict.amount, ict.description
      FROM intercompany_transactions ict
      WHERE ict.group_id=${groupId}::UUID AND ict.match_status='matched'
        AND ict.transaction_date>=${periodStart} AND ict.transaction_date<=${periodEnd}
    `) as DbRow[];

    const created: ConsolidationAdjustment[] = [];

    for (const tx of icTxRows) {
      // One elimination per matched row: a second run (or two at once: the row locks above make the second wait, then see this one) skips a
      // row whose elimination already stands. A reversed one (the row was unmatched since) does not stand, so a re-matched row is eliminated again.
      const standing = (await sql`
        SELECT 1 FROM consolidation_adjustments WHERE source_intercompany_id=${String(tx.id)}::UUID AND status IN ('draft','posted') LIMIT 1
      `) as DbRow[];
      if (standing.length > 0) continue; // (a standing one that is no longer carried was reversed above)
      // A row the mirror recorded is eliminated only while the ledgers still carry it (both journals stand, its target is named): re-checked
      // NOW, whatever its match_status says (a direct reversal of a journal, or a status written by hand, is not a hook).
      const eligible = (await sql`SELECT public.intercompany_row_eliminable(${String(tx.id)}::UUID) AS ok`) as DbRow[];
      if (eligible[0]?.ok !== true) {
        log.warn('Elimination skipped: the intercompany row is not carried by both ledgers', { groupId, transactionId: String(tx.id) }, 'accounting');
        continue;
      }
      const txType = String(tx.transaction_type);
      // A negative amount (a credit note) is the invoice's entry with its sides swapped, in positive amounts (never a negative debit or credit).
      const amount = Math.abs(Number(tx.amount));
      const reversed = Number(tx.amount) < 0;
      const srcId = String(tx.source_company_id);
      const tgtId = String(tx.target_company_id);
      const desc = tx.description ?? '';

      if (txType === 'sale' || txType === 'purchase' || txType === 'mgmt_fee') {
        const revGaId = await findGroupAccountByType(groupId, srcId, 'revenue');
        const expGaId = await findGroupAccountByType(groupId, tgtId, 'expense');
        if (revGaId && expGaId) {
          const lines: EliminationLine[] = [
            { groupAccountId: revGaId, debit: reversed ? 0 : amount, credit: reversed ? amount : 0, description: `Eliminate intercompany ${txType} revenue` },
            { groupAccountId: expGaId, debit: reversed ? amount : 0, credit: reversed ? 0 : amount, description: `Eliminate intercompany ${txType} expense` },
          ];
          created.push(await createEliminationAdjustment(groupId, { adjustmentType: 'interco_revenue', description: `Auto-elimination: intercompany ${txType} - ${desc}`.trim(), periodStart, periodEnd, lines, sourceIntercompanyId: String(tx.id) }));
        }
      } else if (txType === 'loan' || txType === 'transfer') {
        const recGaId = await findGroupAccountBySubtype(groupId, srcId, 'receivable');
        const payGaId = await findGroupAccountBySubtype(groupId, tgtId, 'payable');
        if (recGaId && payGaId) {
          const lines: EliminationLine[] = [
            { groupAccountId: payGaId, debit: reversed ? 0 : amount, credit: reversed ? amount : 0, description: `Eliminate intercompany payable` },
            { groupAccountId: recGaId, debit: reversed ? amount : 0, credit: reversed ? 0 : amount, description: `Eliminate intercompany receivable` },
          ];
          created.push(await createEliminationAdjustment(groupId, { adjustmentType: 'interco_balance', description: `Auto-elimination: intercompany ${txType} balance - ${desc}`.trim(), periodStart, periodEnd, lines, sourceIntercompanyId: String(tx.id) }));
        }
      }
    }

    // Verified once more now it is written (without a transaction around the generator a release could land between the check and the insert;
    // inside a request the lock above rules that out): an elimination whose row stopped being carried is reversed here, not left standing.
    const kept: ConsolidationAdjustment[] = [];
    for (const adj of created) {
      const ok = adj.sourceIntercompanyId ? (await sql`SELECT public.intercompany_row_eliminable(${adj.sourceIntercompanyId}::UUID) AS ok`) as DbRow[] : [{ ok: true }];
      if (ok[0]?.ok === true) {
        kept.push(adj);
      } else {
        await reverseStaleEliminations(groupId);
      }
    }
    log.info('Auto-generated elimination adjustments', { groupId, count: kept.length }, 'accounting');
    return kept;
  } catch (err) {
    log.error('Failed to auto-generate eliminations', { groupId, error: err }, 'accounting');
    throw err;
  }
}
