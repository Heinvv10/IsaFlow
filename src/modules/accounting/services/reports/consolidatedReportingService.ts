/**
 * Consolidated Reporting Service
 *
 * Group dashboard stats, elimination journal CRUD, and auto-generation.
 * Re-exports trial balance and statement generators for backward compatibility.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getGroupMembers } from './consolidatedTrialBalanceService';
import type { DbRow } from '@/types/db';
import { AR_OPEN_STATUSES, AP_OPEN_STATUSES } from '@/lib/constants/invoiceStatuses';


// ── Re-exports ────────────────────────────────────────────────────────────────

export { getConsolidatedTrialBalance } from './consolidatedTrialBalanceService';
export type { ConsolidatedTrialBalance } from './consolidatedTrialBalanceService';
export { getConsolidatedIncomeStatement, getConsolidatedBalanceSheet } from './consolidatedStatementsService';
export type { ConsolidatedIncomeStatement, ConsolidatedBalanceSheet } from './consolidatedStatementsService';

// ── Types ─────────────────────────────────────────────────────────────────────

interface EntitySummary {
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
    postedAt: r.posted_at ? String(r.posted_at) : null, createdAt: String(r.created_at),
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

    // Batch all 4 queries using company_id = ANY(...) instead of N loops
    const [cashRows, arRows, apRows, plRows] = await Promise.all([
      // Cash is SUM(bank_transactions.amount) over bank-subtype GL accounts —
      // the same definition kpiDashboardService and bankAccountStatusService
      // use. bank_accounts.current_balance was read here previously, but
      // bank_accounts is vestigial (0 rows in production) so group cash was
      // always 0.
      sql`SELECT bt.company_id, COALESCE(SUM(bt.amount),0) AS cash
          FROM bank_transactions bt
          JOIN gl_accounts ga ON ga.id = bt.bank_account_id
          WHERE bt.company_id = ANY(${companyIds}::UUID[])
            AND ga.company_id = ANY(${companyIds}::UUID[])
            AND ga.account_subtype = 'bank' AND ga.is_active = true
          GROUP BY bt.company_id` as Promise<DbRow[]>,
      // There is no balance_due column on either invoice table — these queries
      // threw 42703, taking the whole dashboard down. Outstanding is
      // total_amount - amount_paid, and the open-status allowlists are the
      // shared constants the aging reports use ('partial' was never a legal
      // status, and supplier_invoices has no 'overdue').
      sql`SELECT company_id, COALESCE(SUM(total_amount - COALESCE(amount_paid,0)),0) AS ar
          FROM customer_invoices
          WHERE company_id = ANY(${companyIds}::UUID[])
            AND status = ANY(${Array.from(AR_OPEN_STATUSES)}::text[])
          GROUP BY company_id` as Promise<DbRow[]>,
      sql`SELECT company_id, COALESCE(SUM(total_amount - COALESCE(amount_paid,0)),0) AS ap
          FROM supplier_invoices
          WHERE company_id = ANY(${companyIds}::UUID[])
            AND status = ANY(${Array.from(AP_OPEN_STATUSES)}::text[])
          GROUP BY company_id` as Promise<DbRow[]>,
      sql`SELECT je.company_id, ga.account_type, COALESCE(SUM(jl.debit),0) AS total_debit, COALESCE(SUM(jl.credit),0) AS total_credit
          FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id=jl.journal_entry_id
          JOIN gl_accounts ga ON ga.id=jl.gl_account_id
          WHERE je.status='posted' AND jl.company_id = ANY(${companyIds}::UUID[]) AND je.company_id = ANY(${companyIds}::UUID[]) AND ga.company_id = ANY(${companyIds}::UUID[])
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
      throw new Error(`Elimination adjustment lines do not balance: debit=${totalDebit}, credit=${totalCredit}`);
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

export async function postEliminationAdjustment(adjustmentId: string, groupId: string): Promise<void> {
  try {
    const result = (await sql`
      UPDATE consolidation_adjustments SET status='posted', posted_at=NOW(), updated_at=NOW()
      WHERE id=${adjustmentId}::UUID AND group_id=${groupId}::UUID AND status='draft' RETURNING id
    `) as DbRow[];
    if (result.length === 0) throw new Error(`Adjustment ${adjustmentId} not found or not in draft status`);
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
    if (result.length === 0) throw new Error(`Adjustment ${adjustmentId} not found or not in posted status`);
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

export async function autoGenerateEliminations(
  groupId: string, periodStart: string, periodEnd: string
): Promise<ConsolidationAdjustment[]> {
  try {
    const icTxRows = (await sql`
      SELECT ict.id, ict.source_company_id, ict.target_company_id,
             ict.transaction_type, ict.amount, ict.description
      FROM intercompany_transactions ict
      WHERE ict.group_id=${groupId}::UUID AND ict.match_status='matched'
        AND ict.transaction_date>=${periodStart} AND ict.transaction_date<=${periodEnd}
    `) as DbRow[];

    const created: ConsolidationAdjustment[] = [];

    for (const tx of icTxRows) {
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
          created.push(await createEliminationAdjustment(groupId, { adjustmentType: 'interco_revenue', description: `Auto-elimination: intercompany ${txType} - ${desc}`.trim(), periodStart, periodEnd, lines, sourceIntercompanyId: String(tx.id) }));
        }
      } else if (txType === 'loan' || txType === 'transfer') {
        const recGaId = await findGroupAccountBySubtype(groupId, srcId, 'receivable');
        const payGaId = await findGroupAccountBySubtype(groupId, tgtId, 'payable');
        if (recGaId && payGaId) {
          const lines: EliminationLine[] = [
            { groupAccountId: payGaId, debit: amount, credit: 0, description: `Eliminate intercompany payable` },
            { groupAccountId: recGaId, debit: 0, credit: amount, description: `Eliminate intercompany receivable` },
          ];
          created.push(await createEliminationAdjustment(groupId, { adjustmentType: 'interco_balance', description: `Auto-elimination: intercompany ${txType} balance - ${desc}`.trim(), periodStart, periodEnd, lines, sourceIntercompanyId: String(tx.id) }));
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
