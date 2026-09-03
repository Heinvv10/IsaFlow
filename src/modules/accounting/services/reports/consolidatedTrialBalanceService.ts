/**
 * Consolidated Trial Balance Service
 *
 * Shared types and shared DB helpers for consolidated reporting.
 * The trial balance generator itself lives in consolidatedTrialBalanceReport.ts
 * and is re-exported here so existing import sites keep working.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

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
  groupAccountType: string; groupNormalBalance: string; companyAccountId: string;
}

export async function getCoaMappings(groupId: string, companyId: string): Promise<Map<string, MappingEntry>> {
  const rows = (await sql`
    SELECT gcm.company_account_id, gcm.group_account_id, gcm.company_id,
           ga.account_code AS group_account_code, ga.account_name AS group_account_name,
           ga.account_type AS group_account_type, ga.normal_balance AS group_normal_balance
    FROM group_coa_mappings gcm
    JOIN group_accounts ga ON ga.id = gcm.group_account_id
    WHERE gcm.group_id = ${groupId}::UUID AND gcm.company_id = ${companyId}::UUID
  `) as Row[];
  const map = new Map<string, MappingEntry>();
  for (const r of rows) {
    map.set(String(r.company_account_id), {
      groupAccountId: String(r.group_account_id), groupAccountCode: String(r.group_account_code),
      groupAccountName: String(r.group_account_name), groupAccountType: String(r.group_account_type),
      groupNormalBalance: String(r.group_normal_balance), companyAccountId: String(r.company_account_id),
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
           ga.account_type AS group_account_type, ga.normal_balance AS group_normal_balance
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
      groupNormalBalance: String(r.group_normal_balance), companyAccountId: String(r.company_account_id),
    });
  }
  return result;
}

export interface EliminationLineWithAccount {
  groupAccountId: string; groupAccountCode: string; groupAccountName: string;
  /** Group account type — decides whether an elimination accumulates or resets each year. */
  groupAccountType: string;
  debit: number; credit: number;
}

export async function getPostedEliminations(
  groupId: string, periodStart: string, periodEnd: string
): Promise<EliminationLineWithAccount[]> {
  const adjRows = (await sql`
    SELECT ca.lines FROM consolidation_adjustments ca
    WHERE ca.group_id = ${groupId}::UUID AND ca.status = 'posted'
      AND ca.period_start >= ${periodStart} AND ca.period_end <= ${periodEnd}
  `) as Row[];

  const allLines: EliminationLineWithAccount[] = [];
  for (const adj of adjRows) {
    const lines = typeof adj.lines === 'string' ? JSON.parse(adj.lines) : adj.lines;
    for (const line of lines) {
      const gaRows = (await sql`
        SELECT id, account_code, account_name, account_type FROM group_accounts WHERE id = ${line.groupAccountId}::UUID
      `) as Row[];
      if (gaRows.length > 0) {
        allLines.push({
          groupAccountId: String(gaRows[0]!.id), groupAccountCode: String(gaRows[0]!.account_code),
          groupAccountName: String(gaRows[0]!.account_name),
          groupAccountType: String(gaRows[0]!.account_type ?? ''),
          debit: Number(line.debit || 0), credit: Number(line.credit || 0),
        });
      }
    }
  }
  return allLines;
}

// ── Consolidated Trial Balance ─────────────────────────────────────────────────

export { getConsolidatedTrialBalance } from './consolidatedTrialBalanceReport';
export type { ConsolidatedTrialBalance } from './consolidatedTrialBalanceReport';
