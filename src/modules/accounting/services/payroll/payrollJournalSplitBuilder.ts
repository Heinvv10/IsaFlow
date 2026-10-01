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

/**
 * Tie the run lines' labour to the labour debit by moving only ROUNDING — at
 * most half a cent per line — onto the largest line. A bigger gap means the
 * run lines disagree with the header; absorbing it would move real cost onto
 * one cost centre silently, so it is left for the plan's exact balance check
 * to refuse as 'unbalanced'.
 *
 * A tie between largest lines goes to the lowest employeeId, so the cent — and
 * with it the posted split and the plan hash — never depends on the order the
 * lines were read in (W3-01, BRK-596 R2-5). Returns new line objects.
 */
export function placeLabourRounding(runLines: RunLabourLine[], labourDebit: number): RunLabourLine[] {
  const out = runLines.map((l) => ({ ...l }));
  if (out.length === 0) return out;
  const residual = r2(labourDebit - out.reduce((s, l) => s + l.labourAmount, 0));
  const roundingCents = Math.ceil(out.length / 2);
  if (residual === 0 || Math.abs(Math.round(residual * 100)) > roundingCents) return out;
  const largest = out.reduce((a, b) => (
    b.labourAmount > a.labourAmount || (b.labourAmount === a.labourAmount && b.employeeId < a.employeeId) ? b : a));
  largest.labourAmount = r2(largest.labourAmount + residual);
  return out;
}

/**
 * How many cents of the labour split depend on the ORDER the run's lines and
 * allocations were read in — the most a journal posted before those reads were
 * ordered (W3-01 round 2) can differ from the plan, between labour accounts,
 * with nothing having changed. `untied` is the lines before
 * placeLabourRounding, `tied` after.
 *
 *   · a split's leftover goes on the LAST share read: that leftover, per
 *     employee with two or more shares — capped at rounding (half a cent per
 *     share), so shares that do not sum to 100 never widen it;
 *   · the rounding placeLabourRounding moves went to the FIRST largest line
 *     read: counted only when two or more lines tie for largest, and a tied
 *     line that is itself split gets the cap, as its amount is then in doubt.
 */
export function labourRoundingSlackCents(
  untied: RunLabourLine[],
  tied: RunLabourLine[],
  employeeAllocations: Record<string, AllocationShare[]>,
): number {
  const cents = (n: number) => Math.round(n * 100);
  const sum = (ls: RunLabourLine[]) => ls.reduce((s, l) => s + l.labourAmount, 0);
  const moved = Math.abs(cents(sum(tied) - sum(untied)));
  const largest = Math.max(...untied.map((l) => l.labourAmount));
  const tiedIds = new Set(untied.filter((l) => l.labourAmount === largest).map((l) => l.employeeId));
  const tieInDoubt = moved !== 0 && tiedIds.size > 1;

  let slack = tieInDoubt ? moved : 0;
  for (const line of tied) {
    const shares = employeeAllocations[line.employeeId] ?? [];
    if (shares.length < 2) continue;
    const cap = Math.ceil(shares.length / 2);
    const leftover = Math.abs(cents(line.labourAmount)
      - shares.reduce((s, a) => s + cents(r2((line.labourAmount * a.percentage) / 100)), 0));
    slack += tieInDoubt && tiedIds.has(line.employeeId) ? cap : Math.min(leftover, cap);
  }
  return slack;
}
