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
 * Whether `text` holds a control character (Unicode Cc). Refused anywhere in a
 * name once trimmed: NUL reached Postgres as a 500 carrying the raw pg message,
 * and the rest (BEL, TAB, …) have no place in one-line display text.
 */
export const hasControlCharacter = (text: string): boolean => /\p{Cc}/u.test(text);

/**
 * Whether `text` has at least one character outside whitespace, control (Cc),
 * format (Cf — zero-width space, word joiner), combining marks (M — the
 * grapheme joiner, variation selectors) and the blank-looking fillers U+115F,
 * U+1160, U+3164, U+FFA0 and U+2800 (reviews r3, r4).
 *
 * "Visible" is BEST-EFFORT and rendering-dependent: a font can still draw some
 * other code point as nothing. A rule name is display text, not a security
 * boundary: a rule is identified by id and the gate matches it by type and
 * amount. The name does carry one meaning — the starter's duplicate check
 * matches an active rule by (document_type, name) — and that compares the
 * trimmed text exactly, whatever it renders as. So this guards against a name
 * that shows as blank; do not extend it into an arms race. Its job is a
 * readable table and audit row.
 */
export const hasVisibleCharacter = (text: string): boolean =>
  /[^\s\p{Cc}\p{Cf}\p{M}\u115F\u1160\u3164\uFFA0\u2800]/u.test(text);

/**
 * A rule name every write path accepts: text of 1 to RULE_NAME_MAX characters
 * once trimmed, with no control character and at least one visible character.
 */
export const isRuleName = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.trim().length <= RULE_NAME_MAX
  && !hasControlCharacter(value.trim()) && hasVisibleCharacter(value);

/**
 * The types whose posting paths consult the approval gate — the only types an
 * Enforce switch can turn on (approvalEnforcement.ts). Grows by one type per PR.
 */
export const ENFORCEABLE_DOCUMENT_TYPES: readonly DocumentType[] = [
  'supplier_invoice', 'customer_credit_note', 'supplier_credit_note', 'customer_invoice',
  'supplier_payment', 'payment_batch', 'manual_journal',
];

/**
 * Supplier bank-detail verification (forensic-controls step 1, migration 876)
 * shares the one switchboard, `approval_enforcement`, but is no approval
 * DOCUMENT type: no rule is written for it — who may verify follows the
 * supplier-payment rules — so it never reaches the rule form.
 */
export const SUPPLIER_BANK_DETAILS = 'supplier_bank_details' as const;
/**
 * Bank-rule change approval (forensic-controls step 2, migration 877): the
 * same kind of switch — no rule is written for it; who approves a held rule
 * change follows the manual-journal rules (bank/bankRuleApprovers.ts).
 */
export const BANK_RULE = 'bank_rule' as const;
export type EnforcementType = DocumentType | typeof SUPPLIER_BANK_DETAILS | typeof BANK_RULE;

/** Every type an Enforce switch can turn on: the document types, then supplier bank details and bank rules. */
export const ENFORCEABLE_TYPES: readonly EnforcementType[] = [...ENFORCEABLE_DOCUMENT_TYPES, SUPPLIER_BANK_DETAILS, BANK_RULE];

/**
 * The types the New rule form offers: the enforceable ones, and supplier
 * invoices whatever that list says (goal §3). Never a legacy type — those are
 * refused for new rules (approvalDocumentTypes.ts).
 */
export const RULE_FORM_DOCUMENT_TYPES: readonly DocumentType[] = ENFORCEABLE_DOCUMENT_TYPES.includes('supplier_invoice')
  ? ENFORCEABLE_DOCUMENT_TYPES : ['supplier_invoice', ...ENFORCEABLE_DOCUMENT_TYPES];
