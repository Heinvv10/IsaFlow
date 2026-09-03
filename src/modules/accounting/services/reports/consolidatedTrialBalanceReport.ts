/**
 * Consolidated Trial Balance
 *
 * GRP-06: this used to filter `je.entry_date >= periodStart`, so every
 * balance-sheet account reported the range's MOVEMENT rather than its balance
 * — which is why it disagreed with the consolidated balance sheet, which reads
 * cumulatively. It now follows the same basis as the single-company trial
 * balance (see gl/trialBalanceBasis.ts):
 *
 *   - balance-sheet group accounts: cumulative from inception to periodEnd;
 *   - income-statement group accounts: movement over periodStart..periodEnd;
 *   - each entity's profit earned before periodStart on a single DERIVED
 *     brought-forward row, since the ledger has no closing journals. It is not
 *     merged into a posted equity account — see BROUGHT_FORWARD_CODE.
 *
 * Eliminations follow the same split: cumulative for balance-sheet group
 * accounts (as getConsolidatedBalanceSheet already does), range-bound for
 * income-statement ones.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { BROUGHT_FORWARD_CODE, broughtForwardLine, round2, splitNet } from '../gl/trialBalanceBasis';
import {
  getGroupMembers,
  getCoaMappingsForCompanies,
  getPostedEliminations,
  type EntityBalance,
  type MappingEntry,
  type GroupMember,
} from './consolidatedTrialBalanceService';

type Row = DbRow;

/** The earliest date the ledger can hold — "since inception" for a range query. */
const INCEPTION = '1900-01-01';

const BALANCE_SHEET_TYPES = new Set(['asset', 'liability', 'equity']);

interface ConsolidatedTrialBalanceRow {
  groupAccountId: string; accountCode: string; accountName: string; accountType: string;
  /** True for a computed line with no journal behind it (retained earnings b/f). */
  derived?: boolean;
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

function blankRow(
  groupAccountId: string, accountCode: string, accountName: string, accountType: string,
): ConsolidatedTrialBalanceRow {
  return {
    groupAccountId, accountCode, accountName, accountType,
    entities: {}, eliminationDebit: 0, eliminationCredit: 0,
    consolidatedDebit: 0, consolidatedCredit: 0,
  };
}

function upsert(
  map: Map<string, ConsolidatedTrialBalanceRow>,
  groupAccountId: string, accountCode: string, accountName: string, accountType: string,
): ConsolidatedTrialBalanceRow {
  let entry = map.get(groupAccountId);
  if (!entry) {
    entry = blankRow(groupAccountId, accountCode, accountName, accountType);
    map.set(groupAccountId, entry);
  }
  return entry;
}

/** Add a net balance to one entity's column, on whichever side it falls. */
function addEntityNet(row: ConsolidatedTrialBalanceRow, companyId: string, net: number): void {
  if (!row.entities[companyId]) row.entities[companyId] = { debit: 0, credit: 0 };
  const { debit, credit } = splitNet(net);
  row.entities[companyId]!.debit = round2(row.entities[companyId]!.debit + debit);
  row.entities[companyId]!.credit = round2(row.entities[companyId]!.credit + credit);
}

/** Per-account balances for one member on the trial-balance basis. */
async function memberBalances(
  member: GroupMember, periodStart: string, periodEnd: string,
): Promise<Row[]> {
  return (await sql`
    SELECT ga.id AS account_id,
           COALESCE(SUM(CASE WHEN ga.account_type IN ('asset', 'liability', 'equity')
                               OR je.entry_date >= ${periodStart}
                             THEN jl.debit ELSE 0 END), 0) AS total_debit,
           COALESCE(SUM(CASE WHEN ga.account_type IN ('asset', 'liability', 'equity')
                               OR je.entry_date >= ${periodStart}
                             THEN jl.credit ELSE 0 END), 0) AS total_credit
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.status = 'posted'
      AND je.company_id = ${member.companyId}::UUID
      AND jl.company_id = ${member.companyId}::UUID
      AND ga.company_id = ${member.companyId}::UUID
      AND je.entry_date <= ${periodEnd}
    GROUP BY ga.id
  `) as Row[];
}

/** Profit the member earned strictly before `periodStart`, as a credit. */
async function memberBroughtForward(companyId: string, periodStart: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS retained
    FROM gl_journal_lines jl
    JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
    JOIN gl_accounts ga ON ga.id = jl.gl_account_id
    WHERE je.status = 'posted'
      AND je.company_id = ${companyId}::UUID
      AND jl.company_id = ${companyId}::UUID
      AND ga.company_id = ${companyId}::UUID
      AND je.entry_date < ${periodStart}
      AND ga.account_type IN ('revenue', 'expense')
  `) as Row[];
  return round2(Number(rows[0]?.retained ?? 0));
}

async function applyEliminations(
  accountMap: Map<string, ConsolidatedTrialBalanceRow>,
  groupId: string, periodStart: string, periodEnd: string,
): Promise<void> {
  const [cumulative, inRange] = await Promise.all([
    getPostedEliminations(groupId, INCEPTION, periodEnd),
    getPostedEliminations(groupId, periodStart, periodEnd),
  ]);
  const applicable = [
    ...cumulative.filter(e => BALANCE_SHEET_TYPES.has(e.groupAccountType)),
    ...inRange.filter(e => !BALANCE_SHEET_TYPES.has(e.groupAccountType)),
  ];
  for (const elim of applicable) {
    const entry = upsert(
      accountMap, elim.groupAccountId, elim.groupAccountCode, elim.groupAccountName, elim.groupAccountType,
    );
    entry.eliminationDebit = round2(entry.eliminationDebit + elim.debit);
    entry.eliminationCredit = round2(entry.eliminationCredit + elim.credit);
  }
}

export async function getConsolidatedTrialBalance(
  groupId: string, periodStart: string, periodEnd: string
): Promise<ConsolidatedTrialBalance> {
  try {
    const members = await getGroupMembers(groupId);
    const accountMap = new Map<string, ConsolidatedTrialBalanceRow>();

    // Preload all CoA mappings in a single query to avoid N+1 round-trips
    const allMappings = await getCoaMappingsForCompanies(groupId, members.map((m) => m.companyId));

    for (const member of members) {
      const mappings = allMappings.get(member.companyId) ?? new Map<string, MappingEntry>();
      for (const r of await memberBalances(member, periodStart, periodEnd)) {
        const mapping = mappings.get(String(r.account_id));
        if (!mapping) continue;
        const net = round2(Number(r.total_debit) - Number(r.total_credit));
        if (net === 0) continue;
        const entry = upsert(
          accountMap, mapping.groupAccountId, mapping.groupAccountCode,
          mapping.groupAccountName, mapping.groupAccountType,
        );
        addEntityNet(entry, member.companyId, net);
      }

      // Profit earned before the range, on its own DERIVED row — never merged
      // into a posted equity account. See BROUGHT_FORWARD_CODE.
      const broughtForward = await memberBroughtForward(member.companyId, periodStart);
      if (Math.abs(broughtForward) < 0.01) continue;
      const bf = broughtForwardLine(periodStart);
      const entry = upsert(accountMap, BROUGHT_FORWARD_CODE, bf.accountCode, bf.accountName, 'equity');
      entry.derived = true;
      addEntityNet(entry, member.companyId, -broughtForward);
    }

    await applyEliminations(accountMap, groupId, periodStart, periodEnd);

    const groupAccounts: ConsolidatedTrialBalanceRow[] = [];
    const totals: ConsolidatedTrialBalanceTotals = {
      entities: {}, eliminationDebit: 0, eliminationCredit: 0,
      consolidatedDebit: 0, consolidatedCredit: 0,
    };

    for (const entry of accountMap.values()) {
      let entityDebitSum = 0, entityCreditSum = 0;
      for (const [companyId, bal] of Object.entries(entry.entities)) {
        entityDebitSum += bal.debit; entityCreditSum += bal.credit;
        if (!totals.entities[companyId]) totals.entities[companyId] = { debit: 0, credit: 0 };
        totals.entities[companyId]!.debit = round2(totals.entities[companyId]!.debit + bal.debit);
        totals.entities[companyId]!.credit = round2(totals.entities[companyId]!.credit + bal.credit);
      }
      const consolidated = splitNet(
        (entityDebitSum + entry.eliminationDebit) - (entityCreditSum + entry.eliminationCredit),
      );
      entry.consolidatedDebit = consolidated.debit;
      entry.consolidatedCredit = consolidated.credit;
      totals.eliminationDebit = round2(totals.eliminationDebit + entry.eliminationDebit);
      totals.eliminationCredit = round2(totals.eliminationCredit + entry.eliminationCredit);
      totals.consolidatedDebit = round2(totals.consolidatedDebit + entry.consolidatedDebit);
      totals.consolidatedCredit = round2(totals.consolidatedCredit + entry.consolidatedCredit);
      groupAccounts.push(entry);
    }

    groupAccounts.sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    return { groupId, periodStart, periodEnd, groupAccounts, totals };
  } catch (err) {
    log.error('Failed to generate consolidated trial balance', { groupId, error: err }, 'accounting');
    throw err;
  }
}
