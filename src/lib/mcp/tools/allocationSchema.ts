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
      'The reference printed on the bank statement, matched exactly (after trimming). '
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
