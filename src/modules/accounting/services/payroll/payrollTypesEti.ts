export interface EtiInput {
  dateOfBirth: Date;
  employmentStartDate: Date;
  periodDate: Date;
  monthlyRemuneration: number;
  isUifExcluded: boolean;
  /**
   * Hours employed and paid in the month and the wage for ordinary hours (ET; etiHours.ts). Null or absent: the hours
   * cannot be told, so ETI is neither apportioned (s7(5)) nor tested against the minimum wage (s4(1)(a)).
   */
  hours?: EtiHoursInput | null;
  /** ETI Act s6(b) (etiEligibility): false when no valid SA ID number or recorded permit shows a document is held. */
  idDocumentShown?: boolean;
  /** Months employed by this employer before the current start date (a rehire continues the 24 months; guide §3.3). */
  priorMonths?: number;
}

export interface EtiHoursInput {
  /** Hours employed and paid (s7(5)): ordinary plus overtime. */
  monthlyHours: number;
  /** Ordinary hours paid, the minimum-wage divisor (s4(4)); null: the test is not run (R-B assumed hours). */
  ordinaryHours: number | null;
  ordinaryWageCents: number;
}

/** An employee field the ETI engine needs and may not have. */
export type EtiMissingInput = 'date_of_birth' | 'employment_start_date' | 'id_document';

export interface EtiResult {
  /**
   * True only when the engine DETERMINED the employee qualifies. False covers
   * both "determined ineligible" and "could not determine" — read
   * `isDeterminable` to tell those apart before acting on it.
   */
  isEligible: boolean;
  /**
   * Why the employee was determined ineligible. Undefined when eligible, and
   * ALSO undefined when `isDeterminable` is false — stating a reason there would
   * assert a determination that was never made.
   */
  ineligibilityReason?: string;
  /**
   * False when the engine lacked an input it needs, so eligibility was never
   * assessed. Distinguishes "this employee does not qualify" (a finding) from
   * "we do not know" (a data gap that silently forfeits a tax credit).
   */
  isDeterminable: boolean;
  /** The absent inputs. Always empty when `isDeterminable` is true. */
  missingInputs: EtiMissingInput[];
  monthsEmployed: number;
  employmentYear: 1 | 2 | null;
  monthlyEti: number;
}
