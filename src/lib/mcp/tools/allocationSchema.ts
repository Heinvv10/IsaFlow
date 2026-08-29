/**
 * JSON-schema fragments for the allocation tools' manifests.
 *
 * Split out of allocationLine.ts purely for size — these are inert data that
 * getManifest() serialises, while allocationLine.ts is the runtime gate. Note
 * that `enum` here is DOCUMENTATION: the MCP transport does not enforce it, so
 * the arrays in allocationLine.ts are what actually reject a bad value.
 */
import { ALLOC_TYPES, VAT_CODES } from './allocationLine';

/** Schema fragment shared by every tool that names a transaction. */
export const SELECTOR_PROPERTIES = {
  transaction_id: {
    type: 'string',
    description: 'Bank transaction UUID. Supply this OR bank_reference, not both.',
  },
  bank_reference: {
    type: 'string',
    description:
      'The reference printed on the bank statement, matched exactly (after trimming) against '
      + 'either reference column on the transaction — the same value list_bank_transactions returns as bank_reference. '
      + 'Use it instead of transaction_id when working from a statement — no id lookup needed. '
      + 'Must resolve to exactly one transaction; if it does not, the tool lists the candidates.',
  },
  bank_account_id: {
    type: 'string',
    description: 'Optional: narrows a bank_reference lookup to one bank account.',
  },
} as const;

/** Schema fragment for the allocation fields themselves. */
export const ALLOCATION_PROPERTIES = {
  contra_account_id: {
    type: 'string',
    description:
      'GL account UUID the other side of the transaction is booked to. Required for alloc_type "account" (the default); ignored for supplier/customer, which post to the AP/AR control account.',
  },
  description: { type: 'string' },
  alloc_type: { type: 'string', enum: [...ALLOC_TYPES] },
  entity_id: { type: 'string' },
  invoice_id: { type: 'string' },
  vat_code: { type: 'string', enum: [...VAT_CODES] },
} as const;

/**
 * The date a reversal's contra journal carries.
 *
 * Shared by both reverse tools so the wording an agent reads is identical in
 * each. Stating the DEFAULT matters as much as offering the override: before
 * this existed, no description said which date a contra would land on, and an
 * agent correcting a closed month had no way to find out except by posting one.
 */
export const REVERSAL_DATE_PROPERTY = {
  reversal_date: {
    type: 'string' as const,
    description:
      'Optional YYYY-MM-DD date for the reversing journal. Omit it and the reversal takes the '
      + "ORIGINAL entry's date when that period is still open, falling back to today when it is "
      + 'closed — which keeps the correction in the period it corrects. Give a date to override '
      + 'that, typically to correct a closed month from the current open one. It may not be '
      + 'earlier than the entry being reversed, and its period must be open.',
  },
};
