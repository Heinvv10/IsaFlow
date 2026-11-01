/**
 * Words for a budget driver (P4 spec §7): the row-header chip ("38% × Sales", "+2% m/m from Mar",
 * "R 32 000 × heads", "R 15 000 fixed", "5% of Turnover") and the longer description its tooltip
 * and accessible name carry. A reader's per_head line has no rate (perHeadAccess): its words name none. Pure; React escapes the text where it lands (no HTML is built).
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { monthLabel } from '@/components/accounting/budgets/budgetClient';
import { BAND_LABEL } from '@/modules/accounting/services/budgets/grid/subtotals';
import type { DriverGrain, DriverLine } from '@/modules/accounting/services/budgets/drivers/driverLine';
import { isRestrictedPerHead, PER_HEAD_RESTRICTED_NOTE, type RestrictedPerHeadLine } from '@/modules/accounting/services/budgets/drivers/perHeadAccess';

/** "5000 Cost of sales" for an account id; the id itself when the account is not listed. */
export type AccountLabelOf = (accountId: string) => string;

/** "5000 Cost of sales (Alpha)" for a row (an account at a grain). */
export function grainLabel(g: DriverGrain, accountLabel: AccountLabelOf, memberLabel: (id: string) => string): string {
  const member = g.cc1Id ?? g.cc2Id ?? g.buId;
  return member ? `${accountLabel(g.glAccountId)} (${memberLabel(member)})` : accountLabel(g.glAccountId);
}

/** A percent as typed: up to 4 decimals, no trailing zeros. */
export function pctText(pct: number): string {
  return `${Number(pct.toFixed(4))}%`;
}

const rand = (amount: number): string => formatMoney(amount, { decimals: Number.isInteger(amount) ? 0 : 2 });

/** The name of the row a pct_of_line driver reads: the account's name, without its code. */
function refName(line: DriverLine, accountName: (id: string) => string): string {
  return line.ref ? accountName(line.ref.glAccountId) : '?';
}

/** The chip text. `accountName` answers the account's NAME only (the chip is short). */
export function driverChipText(line: DriverLine | RestrictedPerHeadLine, accountName: (id: string) => string): string {
  switch (line.kind) {
    case 'fixed': return `${rand(line.amount ?? 0)} fixed`;
    case 'per_head': return isRestrictedPerHead(line) ? 'Per head × heads' : `${rand(line.amount ?? 0)} × heads`;
    case 'pct_of_line': return `${pctText(line.pct ?? 0)} × ${refName(line, accountName)}`;
    case 'pct_of_section': return `${pctText(line.pct ?? 0)} of ${line.section ? BAND_LABEL[line.section] : '?'}`;
    case 'growth': {
      const pct = line.pct ?? 0;
      return `${pct >= 0 ? '+' : ''}${pctText(pct)} m/m from ${line.baseMonth ? monthLabel(line.baseMonth).slice(0, 3) : '?'}`;
    }
  }
}

/** The months a driver covers: "Mar 2026 to Feb 2027". */
export function rangeText(line: Pick<DriverLine, 'fromMonth' | 'toMonth'>): string {
  return line.fromMonth === line.toMonth ? monthLabel(line.fromMonth) : `${monthLabel(line.fromMonth)} to ${monthLabel(line.toMonth)}`;
}

/** The chip's tooltip and accessible description: what the driver computes, over which months, at which rounding. */
export function driverDescription(line: DriverLine | RestrictedPerHeadLine, accountLabel: AccountLabelOf, memberLabel: (id: string) => string, scopeLabel: (id: string | null) => string): string {
  const range = rangeText(line);
  const rounding = line.rounding === 1 ? '' : `, rounded to ${formatMoney(line.rounding, { decimals: 0 })}`;
  switch (line.kind) {
    case 'fixed': return `${rand(line.amount ?? 0)} a month, ${range}${rounding}`;
    case 'per_head': {
      const scope = scopeLabel(line.headcountCostCentreId);
      if (isRestrictedPerHead(line)) return `Per head × headcount (${scope}), ${range}${rounding}. ${PER_HEAD_RESTRICTED_NOTE.slice(0, -1)}`;
      return `${rand(line.amount ?? 0)} per head × headcount (${scope}), ${range}${rounding}`;
    }
    case 'pct_of_line': return `${pctText(line.pct ?? 0)} of ${line.ref ? grainLabel(line.ref, accountLabel, memberLabel) : '?'}, ${range}${rounding}`;
    case 'pct_of_section': {
      const scope = line.scope === 'company' ? 'all levels' : 'this row\'s level';
      return `${pctText(line.pct ?? 0)} of ${line.section ? BAND_LABEL[line.section] : '?'} (${scope}), ${range}${rounding}`;
    }
    case 'growth': return `${pctText(line.pct ?? 0)} a month, compounding from ${line.baseMonth ? monthLabel(line.baseMonth) : '?'}, ${range}${rounding}`;
  }
}
