/**
 * Consolidated Trial Balance Service
 *
 * Shared types and shared DB helpers for consolidated reporting.
 * The trial balance generator itself lives in consolidatedTrialBalanceReport.ts
 * and is re-exported here so existing import sites keep working.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getMirroredEliminations, mirroredLinesReachBalanceSheet, type DroppedMirroredElimination } from './mirrorEliminations';

type Row = DbRow;

// ── Shared Types ──────────────────────────────────────────────────────────────

export interface EntityBalance { debit: number; credit: number; }

export interface ConsolidatedLineItem {
  groupAccountId: string; accountCode: string; accountName: string;
  entities: Record<string, { amount: number }>;
  eliminationAmount: number; consolidatedAmount: number;
}

export interface ConsolidatedISTotals {
  entities: Record<string, number>; eliminationAmount: number; consolidatedAmount: number;
}

export interface ConsolidatedBSLineItem {
  groupAccountId: string; accountCode: string; accountName: string;
  entities: Record<string, number>; eliminationAmount: number; consolidatedAmount: number;
}

export interface ConsolidatedBSTotals {
  entities: Record<string, number>; eliminationAmount: number; consolidatedAmount: number;
}

// ── Shared DB Helpers ─────────────────────────────────────────────────────────

export interface GroupMember {
  companyId: string; companyName: string; ownershipPct: number; consolidationMethod: string;
}

export async function getGroupMembers(groupId: string): Promise<GroupMember[]> {
  const rows = (await sql`
    SELECT cgm.company_id, c.name AS company_name, cgm.ownership_pct, cgm.consolidation_method
    FROM company_group_members cgm
    JOIN companies c ON c.id = cgm.company_id
    WHERE cgm.group_id = ${groupId}::UUID AND cgm.left_date IS NULL
    ORDER BY cgm.is_holding DESC, c.name
  `) as Row[];
  return rows.map((r: Row) => ({
    companyId: String(r.company_id), companyName: String(r.company_name),
    ownershipPct: Number(r.ownership_pct), consolidationMethod: String(r.consolidation_method),
  }));
}

export interface MappingEntry {
  groupAccountId: string; groupAccountCode: string; groupAccountName: string;
  groupAccountType: string; companyAccountId: string;
}

export async function getCoaMappings(groupId: string, companyId: string): Promise<Map<string, MappingEntry>> {
  const rows = (await sql`
    SELECT gcm.company_account_id, gcm.group_account_id, gcm.company_id,
           ga.account_code AS group_account_code, ga.account_name AS group_account_name,
           ga.account_type AS group_account_type
    FROM group_coa_mappings gcm
    JOIN group_accounts ga ON ga.id = gcm.group_account_id
    WHERE gcm.group_id = ${groupId}::UUID AND gcm.company_id = ${companyId}::UUID
  `) as Row[];
  const map = new Map<string, MappingEntry>();
  for (const r of rows) {
    map.set(String(r.company_account_id), {
      groupAccountId: String(r.group_account_id), groupAccountCode: String(r.group_account_code),
      groupAccountName: String(r.group_account_name), groupAccountType: String(r.group_account_type),
      companyAccountId: String(r.company_account_id),
    });
  }
  return map;
}

/**
 * Bulk-load CoA mappings for multiple companies in a single query.
 * Returns a Map keyed by companyId → per-company mapping Map.
 * Use this before iterating members to avoid N+1 DB round-trips.
 */
export async function getCoaMappingsForCompanies(
  groupId: string,
  companyIds: string[],
): Promise<Map<string, Map<string, MappingEntry>>> {
  if (companyIds.length === 0) return new Map();
  const rows = (await sql`
    SELECT gcm.company_account_id, gcm.group_account_id, gcm.company_id,
           ga.account_code AS group_account_code, ga.account_name AS group_account_name,
           ga.account_type AS group_account_type
    FROM group_coa_mappings gcm
    JOIN group_accounts ga ON ga.id = gcm.group_account_id
    WHERE gcm.group_id = ${groupId}::UUID
      AND gcm.company_id = ANY(${companyIds}::uuid[])
  `) as Row[];

  const result = new Map<string, Map<string, MappingEntry>>();
  for (const r of rows) {
    const cid = String(r.company_id);
    if (!result.has(cid)) result.set(cid, new Map());
    result.get(cid)!.set(String(r.company_account_id), {
      groupAccountId: String(r.group_account_id), groupAccountCode: String(r.group_account_code),
      groupAccountName: String(r.group_account_name), groupAccountType: String(r.group_account_type),
      companyAccountId: String(r.company_account_id),
    });
  }
  return result;
}

export interface EliminationLineWithAccount {
  groupAccountId: string; groupAccountCode: string; groupAccountName: string;
  /** Group account type — decides whether an elimination accumulates or resets each year. */
  groupAccountType: string;
  /** Group account subtype ('cost_of_sales' ...): where an elimination on an account with no member activity lands in the income statement. */
  groupAccountSubtype?: string;
  debit: number; credit: number;
}

/**
 * The stored adjustments, but never an older generator's one of a MIRRORED row (those eliminations are derived from the ledgers,
 * mirrorEliminations.ts, so it would count twice). A person's elimination of a mirrored row (it carries a manual_reason) counts: it eliminates a row nothing else does.
 */
async function storedEliminations(groupId: string, periodStart: string, periodEnd: string): Promise<EliminationLineWithAccount[]> {
  const adjRows = (await sql`
    SELECT ca.lines FROM consolidation_adjustments ca
    WHERE ca.group_id = ${groupId}::UUID AND ca.status = 'posted'
      AND ca.period_start >= ${periodStart} AND ca.period_end <= ${periodEnd}
      AND (ca.source_intercompany_id IS NULL OR ca.manual_reason IS NOT NULL OR NOT public.intercompany_is_mirrored_row(ca.source_intercompany_id))
  `) as Row[];
  if (adjRows.length === 0) return [];
  const accounts = new Map((await sql`
    SELECT id, account_code, account_name, account_type, account_subtype FROM group_accounts WHERE group_id = ${groupId}::UUID
  ` as Row[]).map((a) => [String(a.id), a]));
  const allLines: EliminationLineWithAccount[] = [];
  for (const adj of adjRows) {
    const lines = typeof adj.lines === 'string' ? JSON.parse(adj.lines) : adj.lines;
    for (const line of lines) {
      const ga = accounts.get(String(line.groupAccountId));
      if (ga) {
        allLines.push({
          groupAccountId: String(ga.id), groupAccountCode: String(ga.account_code), groupAccountName: String(ga.account_name),
          groupAccountType: String(ga.account_type ?? ''), groupAccountSubtype: String(ga.account_subtype ?? ''),
          debit: Number(line.debit || 0), credit: Number(line.credit || 0),
        });
      }
    }
  }
  return allLines;
}

const asLines = (m: Awaited<ReturnType<typeof getMirroredEliminations>>): EliminationLineWithAccount[] => m.flatMap((e) => e.lines.map((l) => ({
  groupAccountId: l.groupAccountId, groupAccountCode: l.groupAccountCode, groupAccountName: l.groupAccountName,
  groupAccountType: l.groupAccountType, groupAccountSubtype: l.groupAccountSubtype, debit: l.debit, credit: l.credit,
})));

/**
 * Posted manual adjustments plus the derived (mirrored) eliminations, both for the period. `balanceSheetOnly`: the caller uses balance-sheet
 * group accounts only (the balance sheet), so the derived ones are read only when one can land there (mirroredLinesReachBalanceSheet).
 */
export async function getPostedEliminations(
  groupId: string, periodStart: string, periodEnd: string, opts: { balanceSheetOnly?: boolean; dropped?: DroppedMirroredElimination[] } = {},
): Promise<EliminationLineWithAccount[]> {
  const derive = !opts.balanceSheetOnly || await mirroredLinesReachBalanceSheet(groupId);
  return [...await storedEliminations(groupId, periodStart, periodEnd), ...(derive ? asLines(await getMirroredEliminations(groupId, periodStart, periodEnd, opts.dropped)) : [])];
}

/**
 * The cumulative (inception to the end; balance-sheet group accounts are all its caller reads, so its derived lines are read only when one
 * can land on such an account) and the in-period eliminations a statement needs. The derived ones are dated events (an elimination,
 * a counter-elimination), so each window is its own call: the cumulative window nets to what stands at the end, the in-period one is the
 * events dated in the period (an event's netting depends on the window, so neither is a filter of the other).
 */
export async function getPostedEliminationsSplit(
  groupId: string, periodStart: string, periodEnd: string, inception: string, dropped?: DroppedMirroredElimination[],
): Promise<{ cumulative: EliminationLineWithAccount[]; inRange: EliminationLineWithAccount[] }> {
  // the cumulative window is read for balance-sheet group accounts only: derived lines reach one only through an odd mapping, so the
  // inception-to-end derivation (the group's whole mirrored history) runs only then
  const reachBalanceSheet = await mirroredLinesReachBalanceSheet(groupId);
  const [storedAll, storedRange, mirroredAll, mirroredRange] = await Promise.all([
    storedEliminations(groupId, inception, periodEnd), storedEliminations(groupId, periodStart, periodEnd),
    // (what the in-period derivation could not apply is what the page reports: the cumulative one repeats the same rows)
    reachBalanceSheet ? getMirroredEliminations(groupId, inception, periodEnd) : Promise.resolve([]), getMirroredEliminations(groupId, periodStart, periodEnd, dropped),
  ]);
  return {
    cumulative: [...storedAll, ...asLines(mirroredAll)],
    inRange: [...storedRange, ...asLines(mirroredRange)],
  };
}

// ── Consolidated Trial Balance ─────────────────────────────────────────────────

export { getConsolidatedTrialBalance } from './consolidatedTrialBalanceReport';
export type { ConsolidatedTrialBalance } from './consolidatedTrialBalanceReport';
