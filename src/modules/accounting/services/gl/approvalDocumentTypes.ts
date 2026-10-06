/**
 * Which approval document type a stored document is (R-035).
 *
 * A credit note is one of two types (Hein, 2026-10-06), each with its own
 * rules and its own Enforce switch, and the type follows `credit_notes.type`.
 * Every mapping goes through here so a caller cannot pick the other type's —
 * possibly laxer — rules for a note. The column is CHECKed to 'customer' |
 * 'supplier'; anything else is refused rather than guessed.
 */
import type { DocumentType } from './approvalService';

export function creditNoteApprovalType(type: string): DocumentType {
  if (type === 'customer') return 'customer_credit_note';
  if (type === 'supplier') return 'supplier_credit_note';
  throw new Error(`Unknown credit note type: ${type}`);
}

/**
 * A NEW rule of a legacy type would govern nothing, so creating one is
 * refused, naming the types that do. `credit_note` governs neither
 * credit-note type (R-035 PR3 review B2); `payment` governs neither supplier
 * payments nor payment batches (R-035 PR5). Existing legacy rows are left alone.
 */
const LEGACY_TYPES: Record<string, string> = {
  credit_note: 'Approval rules of type credit_note no longer govern any credit note. Create a customer_credit_note or '
    + 'supplier_credit_note rule instead.',
  payment: 'Approval rules of type payment no longer govern any supplier payment. Create a supplier_payment or '
    + 'payment_batch rule instead.',
};

export class ApprovalRuleLegacyTypeError extends Error {
  constructor(documentType: string) {
    super(LEGACY_TYPES[documentType]);
    this.name = 'ApprovalRuleLegacyTypeError';
  }
}

export function assertRuleDocumentTypeCreatable(documentType: string): void {
  if (Object.hasOwn(LEGACY_TYPES, documentType)) throw new ApprovalRuleLegacyTypeError(documentType);
}
