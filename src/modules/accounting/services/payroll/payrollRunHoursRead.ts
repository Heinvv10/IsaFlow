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
  employees: Array<{ employeeId: string; unit: QuantityUnit; rate: number | null }>;
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

export function hoursInputsOf(employees: PayrollEmployee[]): RunInputHours['employees'] {
  return employees.flatMap((e) => {
    const unit = unitOf(e);
    return unit == null ? [] : [{ employeeId: e.id, unit, rate: rateOf(e) }];
  });
}
