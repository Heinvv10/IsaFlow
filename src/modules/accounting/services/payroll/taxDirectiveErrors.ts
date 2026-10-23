/**
 * Refusals of a stand-alone SARS directive payment (applyTaxDirective), raised
 * before anything is written so the route may answer them with a 4xx.
 */

/** The directive is not approved (pending, expired, cancelled). Raised before anything is written. */
export class TaxDirectiveNotApprovedError extends Error {
  readonly code = 'TAX_DIRECTIVE_NOT_APPROVED';
  constructor(readonly directiveId: string, readonly status: string) {
    super(`Cannot apply tax directive with status '${status}' — directive must be 'approved' first`);
    this.name = 'TaxDirectiveNotApprovedError';
  }
}

/** The directive names no employee, so its payment could go on no tax certificate. Raised before anything is written. */
export class TaxDirectiveWithoutEmployeeError extends Error {
  readonly code = 'TAX_DIRECTIVE_WITHOUT_EMPLOYEE';
  constructor(readonly directiveId: string) {
    super(`Tax directive ${directiveId} is not linked to an employee. Link it to the employee first: the payment `
      + "is declared on that employee's tax certificate (IRP5).");
    this.name = 'TaxDirectiveWithoutEmployeeError';
  }
}
