/**
 * The pre-953 supersede rule, outside the reader (getEmployeeComponents, migration 953): among rows written by code from
 * before this release (supersede_inferred), a once-off counts as superseded when a live such row of the same employee
 * and component starts the day after it ends. A change to those rows can flip that inference: Edit dates and End refuse
 * it (payrollComponentDateEdit); a package apply records it instead, by setting superseded_at on the once-off it would
 * otherwise revive (payPackageSupersede).
 */
import { payrollRunReadDate } from './payrollRunReadDate';
import type { AssignmentWindow } from './payrollComponentPaidMonths';

export type Sibling = AssignmentWindow & { id: string };

export const live = (w: AssignmentWindow) => w.to === null || w.to >= w.from;

/** The calendar day `days` after an ISO date, without a zone. */
export function shiftDay(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The reader's pre-953 rule: a live pre-953 sibling starts the day after `x` ends. */
function inferredSuperseded(x: Sibling, rows: Sibling[]): boolean {
  return x.legacy === true && x.to !== null
    && rows.some((y) => y.id !== x.id && y.legacy === true && live(y) && y.from === shiftDay(x.to!, 1));
}

/**
 * Every pre-953 leaver row (recurring, ending on the employee's end date between the 27th and the month end) that has
 * a live pre-953 same-component successor from the next day in `before` and none in `after`. The reader's leaver rule
 * skips such a row only while that successor stands (getEmployeeComponents); a package that cuts or voids the
 * successor must record the supersede on the leaver row (superseded_at), or the row would be paid in full beside the
 * package's own once-off.
 */
export function legacyLeaverSuccessorLost(before: Sibling[], after: Sibling[]): Sibling[] {
  const successor = (x: Sibling, rows: Sibling[]) =>
    rows.some((y) => y.id !== x.id && y.legacy === true && live(y) && y.from === shiftDay(x.to!, 1));
  return before.filter((x) => {
    if (!x.recurring || !x.legacy || x.supersededAt != null || x.to === null || x.to !== x.employeeEnd || !live(x)) return false;
    if (x.to.slice(8, 10) < '27') return false;
    return successor(x, before) && !successor(x, after);
  });
}

/** Every pre-953 once-off whose inferred supersede the change from `before` to `after` flips, where that decides pay. */
export function legacyFlips(before: Sibling[], after: Sibling[]): Array<{ row: Sibling; paidAgain: boolean }> {
  const out: Array<{ row: Sibling; paidAgain: boolean }> = [];
  for (const x of before) {
    const y = after.find((r) => r.id === x.id);
    if (!y || x.recurring || !x.legacy || x.supersededAt != null || !live(x) || !live(y) || x.to === null || y.to === null) continue;
    // A once-off covering its month's last day is paid whether superseded or not.
    if (y.to >= payrollRunReadDate({ year: Number(y.to.slice(0, 4)), month: Number(y.to.slice(5, 7)) })) continue;
    const was = inferredSuperseded(x, before);
    const is = inferredSuperseded(y, after);
    if (was !== is) out.push({ row: x, paidAgain: was && !is });
  }
  return out;
}
