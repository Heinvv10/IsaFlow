/**
 * What the grid needs to record hours and days (HD): the Basic Salary (3601) component the quantity is kept on,
 * and who is paid by the hour or day at what rate.
 */
import { normaliseSarsCode } from './payeAnnualPayment';
import { rateOf, unitOf } from './payrollRunHours';
import type { PayrollEmployee, QuantityUnit } from './payrollTypes';

export interface RunInputHours {
  /** The one component hours are recorded on (hoursComponentOf); null with `problem` saying why none can be. */
  componentId: string | null;
  problem: string | null;
  /** `componentId`: where THIS employee's hours sit this month (the row they already have), else the company's hours component. */
  employees: Array<{ employeeId: string; unit: QuantityUnit; rate: number | null; componentId: string | null; duplicate: boolean }>;
}

/** The name the seeded hours component carries; a company with several 3601 earnings is told apart by it (and refused when still unclear). */
const HOURS_COMPONENT_NAME = 'basic salary';

export type HoursComponent<T> = { component: T } | { problem: string };

/**
 * The ONE component hours and days are recorded on, found among the editable 3601 earnings: the only one, or, with several (a
 * shift allowance beside Basic Salary), the one named exactly "Basic Salary". Anything still ambiguous is refused, never a
 * first match. The rows it writes carry its id, and everything downstream (hoursValidation, the grid) goes by that id.
 */
export function hoursComponentOf<T extends { name: string; sarsSourceCode: string; componentType: string }>(components: T[]): HoursComponent<T> {
  const basics = components.filter((c) => c.componentType === 'earning' && normaliseSarsCode(c.sarsSourceCode) === '3601');
  if (basics.length === 1) return { component: basics[0]! };
  if (basics.length === 0) return { problem: 'This company has no active taxable Basic Salary (3601) component to record hours or days on.' };
  const named = basics.filter((c) => c.name.trim().toLowerCase() === HOURS_COMPONENT_NAME);
  if (named.length === 1) return { component: named[0]! };
  return { problem: `This company has ${basics.length} active 3601 earnings (${basics.map((c) => c.name).join(', ')}) and none is the single one named "Basic Salary", `
    + 'so hours or days cannot be recorded: rename or deactivate until exactly one is.' };
}

/**
 * THE anchor picker, shared by the write path (setRunHours) and the read path (the grid's state): the component the employee's
 * quantity rows for the month sit on. `rowComponentIds` has one id per quantity row. Several rows are a duplicate (the write
 * is refused 409, the grid sends the user to the employee page); the id returned is then the lowest, so both readers agree.
 */
export function anchorOf(rowComponentIds: string[]): { componentId: string | null; duplicate: boolean } {
  if (rowComponentIds.length === 0) return { componentId: null, duplicate: false };
  return { componentId: [...rowComponentIds].sort()[0]!, duplicate: rowComponentIds.length > 1 };
}

/**
 * Who is paid by the hour or day, and the component each one's hours sit on: the anchor (anchorOf) of the quantity row they
 * already have this month (so a company that later adds a second 3601 earning does not move them), else `fallback`.
 */
export function hoursInputsOf(
  employees: PayrollEmployee[], amounts: Array<{ employeeId: string; componentId: string; quantity: number | null }>, fallback: string | null,
): RunInputHours['employees'] {
  return employees.flatMap((e) => {
    const unit = unitOf(e);
    if (unit == null) return [];
    const anchor = anchorOf(amounts.filter((a) => a.employeeId === e.id && a.quantity != null).map((a) => a.componentId));
    return [{ employeeId: e.id, unit, rate: rateOf(e), componentId: anchor.componentId ?? fallback, duplicate: anchor.duplicate }];
  });
}
