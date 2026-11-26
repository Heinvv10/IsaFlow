/**
 * A payroll line's stored component breakdown item (payroll_run_lines.component_breakdown), moved out of payrollTypes.ts
 * to keep it under the file cap; re-exported there unchanged.
 */
import type { DirectiveFigures, QuantityUnit } from './payrollTypes';

/**
 * W29 (wave 7 PRA): the part of its period a recurring earning paid, when it starts or ends strictly inside employment
 * (payrollRecurringShare). `amount` = round2(fullAmount x share). Monthly: working days (Monday to Friday) of the month;
 * weekly / fortnightly: calendar days of the period.
 */
export interface RecurringShare {
  share: number;
  days: number;
  of: number;
  basis: 'working_days' | 'calendar_days';
  /** The row's amount for a whole period, before the share. */
  fullAmount: number;
}

export interface ComponentBreakdownItem {
  componentId: string;
  componentName: string;
  sarsSourceCode: string;
  amount: number;
  isTaxable: boolean;
  isUifApplicable: boolean;
  /**
   * HD: the hours or days behind `amount` (0 is an entered nil; the keys are omitted when none was recorded), and `rate` = amount / quantity,
   * the EFFECTIVE rate it was paid at, to four decimals: the employee's rate at entry, not looked up again. Omitted at quantity 0.
   */
  quantity?: number;
  quantityUnit?: QuantityUnit;
  rate?: number;
  /** RI: the overtime multiplier the hours were priced at. */
  rateMultiplier?: number;
  /** RI: made by splitTravelRows from a km row; the certificate certifies 3702 / 3703 / 3722 only from these (payrollAllowanceFiling). */
  reimbursiveTravel?: true;
  /**
   * The item counted toward this line's SDL-applicable remuneration, as costed: an earning flagged
   * is_sdl_applicable (payrollCalculator's sdlLeviable). Absent on a line costed before it existed;
   * payrollYearToDate then reads today's catalogue instead.
   */
  isSdlApplicable?: boolean;
  /** True when the earning is taxable remuneration but is not paid in cash. */
  isNonCash?: true;
  /** A once-off assignment (EmployeeComponent.isRecurring false): not time-worked pay for classification (timeWorkedEarnings). */
  onceOff?: true;
  /** As on EmployeeComponent: the PAYE inclusion the line was costed with, kept so a reader need not re-derive it. */
  payeInclusionRate?: number;
  /** What the calculator took as remuneration for PAYE from this item (amount x rate, to the cent): exact for the certificate's 4582. */
  payeIncludedAmount?: number;
  directive?: DirectiveFigures;
  /** Set on an employee retirement fund contribution (4001/4003/4006 deduction; PAYE 4c, migration 948). */
  retirementContribution?: true;
  /** Set on a contribution paid outside payroll: not deducted from this line's net pay. */
  paidOutsidePayroll?: true;
  /** RF (migration 975): a percent_of_rfi row, as costed: amount = round2(percentOfRfi x rfiBase). */
  percentOfRfi?: number;
  rfiBase?: number;
  /** DBF (migration 1014): a defined-benefit row, as costed: amount = max(0, round2(factor x rfiBase - dbEmployeeContribution)). */
  dbMemberCategoryFactor?: number;
  dbEmployeeContribution?: number;
  /** DBF: the contribution the employer pays the fund (GL 2175, IRP5 4472 / 4473, or 4585 / 4586 when dbMemberRetired). */
  dbEmployerContribution?: number;
  dbMemberRetired?: true;
  /** W29: the row paid this share of its period (payrollRecurringShare); the payslip line prints it. */
  share?: RecurringShare;
}
