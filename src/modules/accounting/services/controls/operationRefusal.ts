/**
 * A controlled operation's DATA-STATE refusal: the company's own rows do not
 * allow this operation as they stand — a zero or non-cent amount, a
 * deactivated contra account, an ambiguous VAT system account, no covering
 * fiscal period, an approval policy this operation cannot be evaluated under.
 * Not the caller's input (a plan shape error stays a plain Error), not a fault
 * (a pg error, a coding defect). A batch driver counts one of these per line
 * and continues; a fault aborts it. Throw it at the site that reads the rows;
 * never wrap another error in it.
 */
export class OperationRefusalError extends Error {
  readonly code = 'OPERATION_REFUSED';
  constructor(message: string) { super(message); this.name = 'OperationRefusalError'; }
}
/** The one text for an aggregate-window payment policy meeting an operation it cannot evaluate. */
export const AGGREGATE_POLICY_UNEVALUABLE = 'Supplier aggregate policy cannot evaluate this operation';
