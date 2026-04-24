/**
 * Pure split-builder for the payroll labour-expense debit lines.
 *
 * Given per-employee labour amounts + per-employee cost-centre (or
 * allocation split) + the cost-centre → expense-account map, produce
 * one JournalLineInput per distinct account. The default account
 * absorbs:
 *   - employees with no cost centre
 *   - employees whose centre has no mapping
 *   - any allocation rows pointing at unmapped centres
 *   - rounding residual (so the account totals tie to the sum of inputs)
 *
 * The default line comes last so reversal output is deterministic and
 * the legacy single-line case is a drop-in replacement.
 */

import type { JournalLineInput } from '@/modules/accounting/types/gl.types';

export interface RunLabourLine {
  employeeId: string;
  labourAmount: number;
}

export interface AllocationShare {
  costCentreId: string;
  percentage: number;
}

export interface BuildLabourDebitInput {
  runLines: RunLabourLine[];
  /** employeeId → costCentreId (or null). Only used when employeeAllocations has no entry for the employee. */
  employeeCostCentre: Record<string, string | null>;
  /** employeeId → allocation splits. When present, overrides employeeCostCentre. */
  employeeAllocations: Record<string, AllocationShare[]>;
  /** costCentreId → expenseAccountId */
  mappings: Record<string, string>;
  /** Fallback GL account when the centre has no mapping or the employee has no centre. */
  defaultAccountId: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function buildLabourDebitLines(input: BuildLabourDebitInput): JournalLineInput[] {
  const { runLines, employeeCostCentre, employeeAllocations, mappings, defaultAccountId } = input;
  if (runLines.length === 0) return [];

  const byAccount = new Map<string, number>();
  const accumulate = (accountId: string, amount: number): void => {
    byAccount.set(accountId, r2((byAccount.get(accountId) ?? 0) + amount));
  };

  let grandTotalInput = 0;

  for (const line of runLines) {
    grandTotalInput = r2(grandTotalInput + line.labourAmount);
    const allocations = employeeAllocations[line.employeeId];
    if (allocations && allocations.length > 0) {
      const shares = allocations.map(a => ({
        accountId: mappings[a.costCentreId] ?? defaultAccountId,
        amount: r2((line.labourAmount * a.percentage) / 100),
      }));
      const summed = shares.reduce<number>((s, x) => s + x.amount, 0);
      const residual = r2(line.labourAmount - summed);
      if (residual !== 0 && shares.length > 0) {
        const last = shares[shares.length - 1]!;
        last.amount = r2(last.amount + residual);
      }
      for (const s of shares) accumulate(s.accountId, s.amount);
    } else {
      const centre = employeeCostCentre[line.employeeId] ?? null;
      const accountId = centre != null ? (mappings[centre] ?? defaultAccountId) : defaultAccountId;
      accumulate(accountId, line.labourAmount);
    }
  }

  // Ensure rounding residual never leaks — adjust default bucket so totals tie.
  const summed = Array.from(byAccount.values()).reduce((s, a) => s + a, 0);
  const residual = r2(grandTotalInput - summed);
  if (residual !== 0) {
    byAccount.set(defaultAccountId, r2((byAccount.get(defaultAccountId) ?? 0) + residual));
  }

  const nonDefault = Array.from(byAccount.entries())
    .filter(([acct]) => acct !== defaultAccountId)
    .sort(([a], [b]) => a.localeCompare(b));

  const defaultAmount = byAccount.get(defaultAccountId);
  const orderedEntries: Array<[string, number]> = [...nonDefault];
  if (defaultAmount !== undefined && defaultAmount !== 0) {
    orderedEntries.push([defaultAccountId, defaultAmount]);
  }

  return orderedEntries.map(([glAccountId, debit]) => ({
    glAccountId,
    debit,
    credit: 0,
    description: 'Labour costs — gross pay + statutory employer contributions − ETI',
  }));
}
