/**
 * The value checks every approval-rule write runs before it reads or writes a
 * row (createRule, updateRule; split out of approvalService.ts, 300-line
 * ceiling). Each takes the body value as `unknown` and judges its TYPE first:
 * the guards downstream compare with `===` and numerically, while Postgres
 * coerces — `isActive: 'false'` became false past `weakensRule`'s
 * `=== false`, and `conditionValue: 'NaN'` was stored as NaN, which no amount
 * exceeds (R-035 follow-up PR A, review round 1).
 */
import { APPROVER_ROLES, isApproverRole } from './approvalRank';
import {
  CONDITION_OPERATORS, MAX_RULE_AMOUNT, RULE_FORM_DOCUMENT_TYPES, RULE_NAME_MAX, isConditionOperator, isRuleAmount, isRuleName,
} from './approvalRuleOptions';

export class ApprovalOperatorInvalidError extends Error {
  constructor(operator: string) {
    super(`conditionOperator must be one of: ${CONDITION_OPERATORS.join(', ')} (got ${operator})`);
    this.name = 'ApprovalOperatorInvalidError';
  }
}

/**
 * The only two values `condition_field` may take.
 *
 * checkApproval matches on the resolved document amount and never reads this
 * column, so both of these name the SAME number — the field is descriptive, not
 * a selector. It was neither validated nor evaluated, which made it worse than
 * decorative: the rules page renders `${conditionField} > ${conditionValue}`, so
 * a rule authored as `vat` read as a VAT threshold while it governed the total.
 */
export const CONDITION_FIELDS = ['total', 'amount'] as const;

export class ApprovalFieldInvalidError extends Error {
  constructor(field: string) {
    super(`conditionField must be one of: ${CONDITION_FIELDS.join(', ')} (got ${field})`);
    this.name = 'ApprovalFieldInvalidError';
  }
}

export class ApprovalRoleInvalidError extends Error {
  constructor(role: string) {
    super(`approverRole must be one of: ${APPROVER_ROLES.join(', ')} (got ${role})`);
    this.name = 'ApprovalRoleInvalidError';
  }
}

/**
 * An approver_role the rank ladder does not know silently means 'admin', so a
 * typed 'Owner' would quietly weaken an owner-only rule. Refuse it at the source.
 */
function assertApproverRole(role: unknown): void {
  if (role !== undefined && !isApproverRole(role)) {
    throw new ApprovalRoleInvalidError(String(role));
  }
}

/**
 * An operator checkApproval cannot evaluate now fails CLOSED, so writing one
 * makes the rule demand approval on every document of its type. The route used
 * to be the only thing stopping that; any other caller of this module — a
 * script, an MCP tool, the `services/gl/index.ts` re-export — could still write
 * it, and on a database where the CHECK has not landed the column takes it.
 */
function assertConditionOperator(operator: unknown): void {
  if (operator !== undefined && !isConditionOperator(operator)) {
    throw new ApprovalOperatorInvalidError(String(operator));
  }
}

/**
 * Both accepted values mean the document's resolved amount; the column records
 * which word the author used, and nothing branches on it.
 */
function assertConditionField(field: unknown): void {
  if (field !== undefined && !(CONDITION_FIELDS as readonly unknown[]).includes(field)) {
    throw new ApprovalFieldInvalidError(String(field));
  }
}

export class ApprovalAmountInvalidError extends Error {
  constructor() {
    super(`conditionValue must be a number from 0 to ${MAX_RULE_AMOUNT.toFixed(2)} with at most 2 decimals`);
    this.name = 'ApprovalAmountInvalidError';
  }
}

export class ApprovalActiveFlagInvalidError extends Error {
  constructor() {
    super('isActive must be true or false');
    this.name = 'ApprovalActiveFlagInvalidError';
  }
}

export class ApprovalNameInvalidError extends Error {
  constructor() {
    super(`name must be text of 1 to ${RULE_NAME_MAX} characters`);
    this.name = 'ApprovalNameInvalidError';
  }
}

export class ApprovalDocumentTypeInvalidError extends Error {
  constructor() {
    super(`documentType must be one of: ${RULE_FORM_DOCUMENT_TYPES.join(', ')}`);
    this.name = 'ApprovalDocumentTypeInvalidError';
  }
}

/**
 * A NEW rule's type must be one a rule can govern (review round 2): the census
 * of every caller of rule matching (checkApproval, strictestMatchingRule, the
 * gate, the unattended and MCP paths) finds RULE_FORM_DOCUMENT_TYPES and the
 * legacy types only, and the legacy ones are refused first with their own
 * message (assertRuleDocumentTypeCreatable). Anything else — another case, an
 * unknown name, a non-string — made a rule that governs nothing.
 */
export function assertRuleDocumentTypeOffered(documentType: unknown): void {
  if (!(RULE_FORM_DOCUMENT_TYPES as readonly unknown[]).includes(documentType)) throw new ApprovalDocumentTypeInvalidError();
}

/** Throws the matching *InvalidError for the first value a rule may not hold; absent fields are not judged. */
export function assertRuleInput(input: {
  name?: unknown; approverRole?: unknown; conditionOperator?: unknown; conditionField?: unknown; conditionValue?: unknown;
  isActive?: unknown;
}): void {
  if (input.name !== undefined && !isRuleName(input.name)) throw new ApprovalNameInvalidError();
  assertApproverRole(input.approverRole);
  assertConditionOperator(input.conditionOperator);
  assertConditionField(input.conditionField);
  // numeric(15,2): a larger value is a 22003 inside the transaction — a 500 carrying the raw pg message.
  if (input.conditionValue !== undefined && !isRuleAmount(input.conditionValue)) throw new ApprovalAmountInvalidError();
  if (input.isActive !== undefined && typeof input.isActive !== 'boolean') throw new ApprovalActiveFlagInvalidError();
}
