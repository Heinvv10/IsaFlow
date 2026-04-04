/**
 * Consolidated Trial Balance Service
 *
 * Shared types, shared DB helpers, and the consolidated trial balance generator.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── Shared Types ──────────────────────────────────────────────────────────────

export interface EntityBalance { debit: number; credit: number; }

interface ConsolidatedTrialBalanceRow {
  groupAccountId: string; accountCode: string; accountName: string; accountType: string;
  entities: Record<string, EntityBalance>;
  eliminationDebit: number; eliminationCredit: number;
  consolidatedDebit: number; consolidatedCredit: number;
}

interface ConsolidatedTrialBalanceTotals {
  entities: Record<string, EntityBalance>;
  eliminationDebit: number; eliminationCredit: number;
  consolidatedDebit: number; consolidatedCredit: number;
}

export interface ConsolidatedTrialBalance {
  groupId: string; periodStart: string; periodEnd: string;
  groupAccounts: ConsolidatedTrialBalanceRow[];
  totals: ConsolidatedTrialBalanceTotals;
}

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
    SELECT gcm.company_account_id, gcm.group_account_id,
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

export interface EliminationLineWithAccount {
  groupAccountId: string; groupAccountCode: string; groupAccountName: string;
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
        SELECT id, account_code, account_name FROM group_accounts WHERE id = ${line.groupAccountId}::UUID
      `) as Row[];
      if (gaRows.length > 0) {
        allLines.push({
          groupAccountId: String(gaRows[0].id), groupAccountCode: String(gaRows[0].account_code),
          groupAccountName: String(gaRows[0].account_name),
          debit: Number(line.debit || 0), credit: Number(line.credit || 0),
        });
      }
    }
  }
  return allLines;
}

// ── Consolidated Trial Balance ─────────────────────────────────────────────────

export async function getConsolidatedTrialBalance(
  groupId: string, periodStart: string, periodEnd: string
): Promise<ConsolidatedTrialBalance> {
  try {
    const members = await getGroupMembers(groupId);
    const accountMap = new Map<string, ConsolidatedTrialBalanceRow>();

    for (const member of members) {
      const mappings = await getCoaMappings(groupId, member.companyId);
      const rows = (await sql`
        SELECT ga.id AS account_id,
               COALESCE(SUM(jl.debit), 0) AS total_debit,
               COALESCE(SUM(jl.credit), 0) AS total_credit
        FROM gl_journal_lines jl
        JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id
        WHERE je.status = 'posted'
          AND je.company_id = ${member.companyId}::UUID
          AND ga.company_id = ${member.companyId}::UUID
          AND je.entry_date >= ${periodStart} AND je.entry_date <= ${periodEnd}
        GROUP BY ga.id
        HAVING COALESCE(SUM(jl.debit), 0) != 0 OR COALESCE(SUM(jl.credit), 0) != 0
      `) as Row[];

      for (const r of rows) {
        const mapping = mappings.get(String(r.account_id));
        if (!mapping) continue;
        const debit = Number(r.total_debit); const credit = Number(r.total_credit);
        let entry = accountMap.get(mapping.groupAccountId);
        if (!entry) {
          entry = {
            groupAccountId: mapping.groupAccountId, accountCode: mapping.groupAccountCode,
            accountName: mapping.groupAccountName, accountType: mapping.groupAccountType,
            entities: {}, eliminationDebit: 0, eliminationCredit: 0, consolidatedDebit: 0, consolidatedCredit: 0,
          };
          accountMap.set(mapping.groupAccountId, entry);
        }
        if (!entry.entities[member.companyId]) entry.entities[member.companyId] = { debit: 0, credit: 0 };
        entry.entities[member.companyId]!.debit += debit;
        entry.entities[member.companyId]!.credit += credit;
      }
    }

    for (const elim of await getPostedEliminations(groupId, periodStart, periodEnd)) {
      let entry = accountMap.get(elim.groupAccountId);
      if (!entry) {
        entry = {
          groupAccountId: elim.groupAccountId, accountCode: elim.groupAccountCode,
          accountName: elim.groupAccountName, accountType: '',
          entities: {}, eliminationDebit: 0, eliminationCredit: 0, consolidatedDebit: 0, consolidatedCredit: 0,
        };
        accountMap.set(elim.groupAccountId, entry);
      }
      entry.eliminationDebit += elim.debit;
      entry.eliminationCredit += elim.credit;
    }

    const groupAccounts: ConsolidatedTrialBalanceRow[] = [];
    const totals: ConsolidatedTrialBalanceTotals = { entities: {}, eliminationDebit: 0, eliminationCredit: 0, consolidatedDebit: 0, consolidatedCredit: 0 };

    for (const entry of accountMap.values()) {
      let entityDebitSum = 0, entityCreditSum = 0;
      for (const [companyId, bal] of Object.entries(entry.entities)) {
        entityDebitSum += bal.debit; entityCreditSum += bal.credit;
        if (!totals.entities[companyId]) totals.entities[companyId] = { debit: 0, credit: 0 };
        totals.entities[companyId]!.debit += bal.debit;
        totals.entities[companyId]!.credit += bal.credit;
      }
      entry.consolidatedDebit = entityDebitSum + entry.eliminationDebit;
      entry.consolidatedCredit = entityCreditSum + entry.eliminationCredit;
      totals.eliminationDebit += entry.eliminationDebit; totals.eliminationCredit += entry.eliminationCredit;
      totals.consolidatedDebit += entry.consolidatedDebit; totals.consolidatedCredit += entry.consolidatedCredit;
      groupAccounts.push(entry);
    }

    groupAccounts.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    return { groupId, periodStart, periodEnd, groupAccounts, totals };
  } catch (err) {
    log.error('Failed to generate consolidated trial balance', { groupId, error: err }, 'accounting');
    throw err;
  }
}
