/**
 * Consolidated Trial Balance
 *
 * GRP-06: this used to filter `je.entry_date >= periodStart`, so every
 * balance-sheet account reported the range's MOVEMENT rather than its balance
 * — which is why it disagreed with the consolidated balance sheet, which reads
 * cumulatively. It now genuinely follows the single-company basis (see
 * gl/trialBalanceBasis.ts and gl/fiscalYearBasis.ts):
 *
 *   - balance-sheet group accounts: cumulative from inception to periodEnd;
 *   - income-statement group accounts: YEAR-TO-DATE from each member's own
 *     fiscal year start. P2-6: the header claimed this basis while the code cut
 *     P&L at periodStart, so the same entity reported two different revenue
 *     figures depending on which report you opened;
 *   - each entity's profit earned before that fiscal year start on a single
 *     DERIVED brought-forward row, since the ledger has no closing journals. It
 *     is not merged into a posted equity account — see BROUGHT_FORWARD_CODE.
 *
 * Eliminations follow the same split: cumulative for balance-sheet group
 * accounts (as getConsolidatedBalanceSheet already does); income-statement legs
 * from the members' fiscal-year floor, earlier ones on RE-BF
 * (consolidatedTrialBalanceEliminations, D4 round 3).
 *
 * P2-5: accounts with no group-CoA mapping are excluded from the rows AND from
 * the brought-forward sum, and the count and value of what was dropped is
 * reported. The group report consolidates a DEFINED group chart, so an unmapped
 * account has no group account to land on — excluding it is the only option;
 * doing so silently, while its profit still reached the brought-forward row,
 * put the statement out by exactly the unmapped amount with nothing on screen
 * to say so. Production's only group has three members carrying R152m and R952m
 * of ledger and ZERO mappings, and this report called that healthy.
 */

import { log } from '@/lib/logger';
import { BROUGHT_FORWARD_CODE, broughtForwardLine, round2, splitNet } from '../gl/trialBalanceBasis';
import { BALANCE_TOLERANCE } from '../gl/trialBalanceService';
import { fiscalYearEndBefore, fiscalYearStartsWithin } from '../gl/fiscalYearCloseRows';
import {
  memberBalances,
  memberBroughtForward,
  memberFiscalYearStart,
} from './consolidatedTrialBalanceMembers';
import { eliminationsOnFloor } from './consolidatedTrialBalanceEliminations';
import {
  getGroupMembers,
  getCoaMappingsForCompanies,
  type EntityBalance,
  type MappingEntry,
} from './consolidatedTrialBalanceService';

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

/** One member's contribution to what the consolidation could not represent. */
export interface ConsolidatedUnmappedEntity {
  companyId: string; companyName: string; accountCount: number; value: number;
}

/**
 * Accounts discarded for want of a group-CoA mapping. `value` is the signed net
 * (debit-positive) of the balances that did not reach the consolidation.
 */
export interface ConsolidatedUnmapped {
  accountCount: number;
  value: number;
  byEntity: ConsolidatedUnmappedEntity[];
}

export interface ConsolidatedTrialBalance {
  groupId: string; periodStart: string; periodEnd: string;
  groupAccounts: ConsolidatedTrialBalanceRow[];
  totals: ConsolidatedTrialBalanceTotals;
  /** Rows returned. The balanced assertion below describes exactly these. */
  accountCount: number;
  totalDebit: number;
  totalCredit: number;
  /** totalDebit − totalCredit, rounded to cents. */
  difference: number;
  /** True when |difference| is within BALANCE_TOLERANCE. Never recompute it. */
  balanced: boolean;
  unmapped: ConsolidatedUnmapped;
  /** Member company id → name, so a consumer can label the per-entity columns. */
  entityNames: Record<string, string>;
  /** The fiscal year start each member's income statement was measured from. */
  fiscalYearStarts: Record<string, string>;
  /**
   * Per member, the fiscal years ending inside the range (D4): their profit was closed to
   * retained earnings — derived, not posted — and sits on RE-BF. Empty when the range is
   * inside one fiscal year. The report has no opening column, so there is no per-row close.
   */
  fiscalYearEndsClosed: Record<string, string[]>;
  /**
   * False when members do not share a year end, so the income-statement columns
   * cover different windows and are not additive without adjustment.
   */
  coterminous: boolean;
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

/** Eliminations on the members' fiscal-year floor — see consolidatedTrialBalanceEliminations. */
async function applyEliminations(
  accountMap: Map<string, ConsolidatedTrialBalanceRow>,
  groupId: string, periodEnd: string, floor: string,
): Promise<void> {
  const { rows, broughtForward } = await eliminationsOnFloor(groupId, periodEnd, floor);
  const add = (entry: ConsolidatedTrialBalanceRow, debit: number, credit: number) => {
    entry.eliminationDebit = round2(entry.eliminationDebit + debit);
    entry.eliminationCredit = round2(entry.eliminationCredit + credit);
  };
  for (const e of rows) {
    add(upsert(accountMap, e.groupAccountId, e.groupAccountCode, e.groupAccountName, e.groupAccountType), e.debit, e.credit);
  }
  if (broughtForward.debit === 0 && broughtForward.credit === 0) return;
  const bf = broughtForwardLine(floor);
  const entry = upsert(accountMap, BROUGHT_FORWARD_CODE, bf.accountCode, bf.accountName, 'equity');
  entry.derived = true;
  add(entry, broughtForward.debit, broughtForward.credit);
}

export async function getConsolidatedTrialBalance(
  groupId: string, periodStart: string, periodEnd: string
): Promise<ConsolidatedTrialBalance> {
  try {
    const members = await getGroupMembers(groupId);
    const accountMap = new Map<string, ConsolidatedTrialBalanceRow>();

    // Preload all CoA mappings in a single query to avoid N+1 round-trips
    const allMappings = await getCoaMappingsForCompanies(groupId, members.map((m) => m.companyId));

    const unmappedByEntity: ConsolidatedUnmappedEntity[] = [];
    const fiscalYearStarts: Record<string, string> = {};
    const fiscalYearEndsClosed: Record<string, string[]> = {};
    const entityNames: Record<string, string> = Object.fromEntries(
      members.map(m => [m.companyId, m.companyName]),
    );

    for (const member of members) {
      const mappings = allMappings.get(member.companyId) ?? new Map<string, MappingEntry>();
      const fyStart = await memberFiscalYearStart(member.companyId, periodEnd);
      fiscalYearStarts[member.companyId] = fyStart;
      // D4: dates only. The P&L rows start at fyStart; profit of the years ending here is on RE-BF.
      fiscalYearEndsClosed[member.companyId] = fiscalYearStartsWithin(periodStart, periodEnd, Number(fyStart.slice(5, 7)))
        .map(fiscalYearEndBefore);

      let unmappedCount = 0;
      let unmappedValue = 0;

      for (const r of await memberBalances(member.companyId, fyStart, periodEnd)) {
        const net = round2(Number(r.total_debit) - Number(r.total_credit));
        const mapping = mappings.get(String(r.account_id));
        if (!mapping) {
          // Dropped: no group account to carry it. Counted, not swallowed.
          if (net !== 0) { unmappedCount += 1; unmappedValue = round2(unmappedValue + net); }
          continue;
        }
        if (net === 0) continue;
        const entry = upsert(
          accountMap, mapping.groupAccountId, mapping.groupAccountCode,
          mapping.groupAccountName, mapping.groupAccountType,
        );
        addEntityNet(entry, member.companyId, net);
      }

      if (unmappedCount > 0) {
        unmappedByEntity.push({
          companyId: member.companyId, companyName: member.companyName,
          accountCount: unmappedCount, value: unmappedValue,
        });
        log.warn(
          'Consolidated trial balance: accounts dropped for want of a group CoA mapping',
          { groupId, companyId: member.companyId, accountCount: unmappedCount, value: unmappedValue },
          'accounting',
        );
      }

      // Brought forward over the SAME chart the rows used, at the SAME date the
      // income statement was cut. Either mismatch unbalances the statement.
      const broughtForward = await memberBroughtForward(
        member.companyId, fyStart, [...mappings.keys()],
      );
      if (Math.abs(broughtForward) < 0.01) continue;
      const bf = broughtForwardLine(fyStart);
      const entry = upsert(accountMap, BROUGHT_FORWARD_CODE, bf.accountCode, bf.accountName, 'equity');
      entry.derived = true;
      addEntityNet(entry, member.companyId, -broughtForward);
    }

    // The group's floor is the holding company's (listed first): see consolidatedTrialBalanceEliminations.
    const groupFloor = members[0] ? fiscalYearStarts[members[0].companyId] : undefined;
    if (groupFloor) await applyEliminations(accountMap, groupId, periodEnd, groupFloor);

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

    // Computed ONCE, here, on the shared tolerance — exactly as the
    // single-company report does. No consumer may derive its own.
    const difference = round2(totals.consolidatedDebit - totals.consolidatedCredit);
    const years = Object.values(fiscalYearStarts);

    return {
      groupId, periodStart, periodEnd, groupAccounts, totals,
      accountCount: groupAccounts.length,
      totalDebit: totals.consolidatedDebit,
      totalCredit: totals.consolidatedCredit,
      difference,
      balanced: Math.abs(difference) < BALANCE_TOLERANCE,
      unmapped: {
        accountCount: unmappedByEntity.reduce((n, e) => n + e.accountCount, 0),
        value: round2(unmappedByEntity.reduce((v, e) => v + e.value, 0)),
        byEntity: unmappedByEntity,
      },
      entityNames,
      fiscalYearStarts,
      fiscalYearEndsClosed,
      coterminous: years.length <= 1 || years.every(y => y.slice(5) === years[0]!.slice(5)),
    };
  } catch (err) {
    log.error('Failed to generate consolidated trial balance', { groupId, error: err }, 'accounting');
    throw err;
  }
}
