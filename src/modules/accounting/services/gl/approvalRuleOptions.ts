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

/**
 * A rule amount every write path accepts: a finite number from 0 to
 * MAX_RULE_AMOUNT in whole cents. A sub-cent value is refused, not rounded:
 * the weakening guard judges the value sent, the column stores it rounded, so
 * 999.995 passed as "below 1 000" and was stored as 1000.00 (review round 2).
 */
export const isRuleAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_RULE_AMOUNT
  && Number(value.toFixed(2)) === value;

/**
 * `approval_rules.name` is TEXT, but every rule write audits it as
 * `audit_log.entity_ref`, a VARCHAR(100): a longer name was a 500 on create and
 * on rename. 100 is the bound the write path can actually store.
 */
export const RULE_NAME_MAX = 100;

/**
 * Whether `text` shows anything: `trim` leaves format characters (Unicode Cf —
 * a zero-width space, a word joiner), so a name of only those rendered blank in
 * the table and in the audit row (review round 3).
 */
export const hasVisibleCharacter = (text: string): boolean => /[^\s\p{Cf}]/u.test(text);

/** A rule name every write path accepts: text of 1 to RULE_NAME_MAX characters once trimmed, with one visible. */
export const isRuleName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= RULE_NAME_MAX
  && hasVisibleCharacter(value);

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
