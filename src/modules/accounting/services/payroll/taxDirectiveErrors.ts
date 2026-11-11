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

/**
 * The employee's cost-centre split changed while the payment was being made: it now names a centre the
 * payment did not lock first, or a mapped labour account was deactivated before the post (taxDirectiveLabour).
 * Nothing is left written; retrying reads the new split.
 */
export class TaxDirectiveSplitChangedError extends Error {
  readonly code = 'TAX_DIRECTIVE_SPLIT_CHANGED';
  readonly retryable = true;
  constructor(readonly directiveId: string) {
    super(`The employee's cost-centre split or its account mapping changed while directive ${directiveId} was being paid. Nothing was written — try again.`);
    this.name = 'TaxDirectiveSplitChangedError';
  }
}

/**
 * Raised when the directive already carries a payment — because it always did,
 * or because a concurrent request has just claimed it. Raised BEFORE the
 * journal is created, so a route may answer it with a 4xx without `withAuth`
 * committing a half-applied directive.
 */
export class TaxDirectiveAlreadyAppliedError extends Error {
  readonly code = 'TAX_DIRECTIVE_ALREADY_APPLIED';
  constructor(readonly directiveId: string, readonly paymentId: string | null, readonly payrollRunId: string | null = null) {
    super(payrollRunId
      ? `Directive ${directiveId} is paid by payroll run ${payrollRunId}, so it cannot be paid again here`
      : `Directive ${directiveId} has already been applied${paymentId ? ` (paymentId: ${paymentId})` : ''}`);
    this.name = 'TaxDirectiveAlreadyAppliedError';
  }
}

/**
 * A fixed-percentage or fixed-amount directive (IRP3(b)/(c), taxDirectiveKinds) taxes regular pay in each run: it is
 * never paid as a lump sum, nor declared as one. Raised before anything is read under lock or written.
 */
export class TaxDirectiveNotLumpSumError extends Error {
  readonly code = 'TAX_DIRECTIVE_NOT_LUMP_SUM';
  constructor(readonly directiveId: string, readonly directiveType: string) {
    super(`Tax directive ${directiveId} is a ${directiveType.replace('_', '-')} directive on regular pay: each payroll run applies it to `
      + 'that period\'s PAYE, so it cannot be paid as a lump sum.');
    this.name = 'TaxDirectiveNotLumpSumError';
  }
}
