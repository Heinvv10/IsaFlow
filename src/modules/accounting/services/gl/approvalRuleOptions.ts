/**
 * The vocabulary an approval rule is written in, with no database import so the
 * Rules tab can offer exactly what the server accepts (R-035 follow-up, PR A).
 * Moved here from approvalMatching.ts (operators) and approvalEnforcement.ts
 * (enforceable types); both re-export, so every existing import site is unchanged.
 */
import type { DocumentType } from './approvalService';

/** The only operators checkApproval can evaluate. Mirrored by the CHECK constraint in 647. */
export const CONDITION_OPERATORS = ['any', 'greater_than', 'greater_equal'] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];
export const isConditionOperator = (value: unknown): value is ConditionOperator =>
  typeof value === 'string' && (CONDITION_OPERATORS as readonly string[]).includes(value);

/** The largest amount `approval_rules.condition_value` (NUMERIC(15,2)) holds. */
export const MAX_RULE_AMOUNT = 9_999_999_999_999.99;

/** A rule amount every write path accepts: a finite number from 0 to MAX_RULE_AMOUNT. */
export const isRuleAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_RULE_AMOUNT;

/**
 * The types whose posting paths consult the approval gate — the only types an
 * Enforce switch can turn on (approvalEnforcement.ts). Grows by one type per PR.
 */
export const ENFORCEABLE_DOCUMENT_TYPES: readonly DocumentType[] = [
  'supplier_invoice', 'customer_credit_note', 'supplier_credit_note', 'customer_invoice',
  'supplier_payment', 'payment_batch', 'manual_journal',
];

/**
 * The types the New rule form offers: the enforceable ones, and supplier
 * invoices whatever that list says (goal §3). Never a legacy type — those are
 * refused for new rules (approvalDocumentTypes.ts).
 */
export const RULE_FORM_DOCUMENT_TYPES: readonly DocumentType[] = ENFORCEABLE_DOCUMENT_TYPES.includes('supplier_invoice')
  ? ENFORCEABLE_DOCUMENT_TYPES : ['supplier_invoice', ...ENFORCEABLE_DOCUMENT_TYPES];
