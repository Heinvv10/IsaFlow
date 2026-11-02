/**
 * Pure split-builder for the payroll labour-expense debit lines.
 *
 * Given per-employee labour amounts + per-employee cost-centre (or
 * allocation split) + the cost-centre → expense-account map, produce one line
 * per distinct (account, CC1). The mapping picks the ACCOUNT; the centre
 * itself rides on the line as `cc1Id` (Hein 2026-11-02, so budgets by CC1 see
 * payroll actuals), unless it is not in `taggableCostCentres` — a centre the
 * ledger would refuse as a CC1 (inactive, or a CC2 project) posts untagged on
 * the same account. A dimension tag never blocks payroll.
 *
 * The default account absorbs:
 *   - employees with no cost centre (untagged)
 *   - employees whose centre has no mapping (tagged with that centre)
 *   - any allocation rows pointing at unmapped centres (tagged likewise)
 *   - the global rounding residual, on its UNTAGGED bucket (created only when
 *     the residual is not zero), so a cent no centre earned is not reported
 *     against one
 *
 * Order: by account, then CC1 with untagged after tagged; the default account
 * comes last, its untagged line last of all. So the posted journal, its
 * reversal and the plan hash never depend on input order, and the legacy
 * single-line case (no centres) is unchanged.
 */

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
  /** Centres a line may carry as CC1 (active, cc_type 'cc1'). Any other centre still picks the account, untagged. */
  taggableCostCentres: ReadonlySet<string>;
}

export interface LabourDebitLine {
  glAccountId: string;
  /** The employee's cost centre, or null (no centre, or one the ledger would refuse as a CC1). */
  cc1Id: string | null;
  debit: number;
  credit: 0;
  description: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const LABOUR_DESCRIPTION = 'Labour costs — gross pay + statutory employer contributions − ETI';

export function buildLabourDebitLines(input: BuildLabourDebitInput): LabourDebitLine[] {
  const { runLines, employeeCostCentre, employeeAllocations, mappings, defaultAccountId, taggableCostCentres } = input;
  if (runLines.length === 0) return [];

  const buckets = new Map<string, { glAccountId: string; cc1Id: string | null; amount: number }>();
  const accumulate = (centre: string | null, amount: number): void => {
    const glAccountId = centre != null ? (mappings[centre] ?? defaultAccountId) : defaultAccountId;
    const cc1Id = centre != null && taggableCostCentres.has(centre) ? centre : null;
    const key = JSON.stringify([glAccountId, cc1Id]);
    const bucket = buckets.get(key) ?? { glAccountId, cc1Id, amount: 0 };
    bucket.amount = r2(bucket.amount + amount);
    buckets.set(key, bucket);
  };

  let grandTotalInput = 0;

  for (const line of runLines) {
    grandTotalInput = r2(grandTotalInput + line.labourAmount);
    const allocations = employeeAllocations[line.employeeId];
    if (allocations && allocations.length > 0) {
      const shares = allocations.map(a => ({
        centre: a.costCentreId,
        amount: r2((line.labourAmount * a.percentage) / 100),
      }));
      const summed = shares.reduce<number>((s, x) => s + x.amount, 0);
      const residual = r2(line.labourAmount - summed);
      if (residual !== 0 && shares.length > 0) {
        const last = shares[shares.length - 1]!;
        last.amount = r2(last.amount + residual);
      }
      for (const s of shares) accumulate(s.centre, s.amount);
    } else {
      accumulate(employeeCostCentre[line.employeeId] ?? null, line.labourAmount);
    }
  }

  // Ensure rounding residual never leaks — the default account's untagged bucket takes it so totals tie.
  const summed = Array.from(buckets.values()).reduce((s, b) => s + b.amount, 0);
  const residual = r2(grandTotalInput - summed);
  if (residual !== 0) accumulate(null, residual);

  const rank = (b: { glAccountId: string; cc1Id: string | null }): [number, string, number, string] => [
    b.glAccountId === defaultAccountId ? 1 : 0, b.glAccountId, b.cc1Id === null ? 1 : 0, b.cc1Id ?? ''];
  const ordered = Array.from(buckets.values())
    .filter((b) => b.amount !== 0)
    .sort((x, y) => {
      const [a, b] = [rank(x), rank(y)];
      return a[0] - b[0] || a[1].localeCompare(b[1]) || a[2] - b[2] || a[3].localeCompare(b[3]);
    });

  return ordered.map((b) => ({
    glAccountId: b.glAccountId,
    cc1Id: b.cc1Id,
    debit: b.amount,
    credit: 0,
    description: LABOUR_DESCRIPTION,
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
