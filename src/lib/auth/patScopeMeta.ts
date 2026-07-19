/**
 * UI metadata for the PAT scope vocabulary. Typed Record<PatScope, …> makes
 * this compile-time exhaustive: adding a scope to PAT_SCOPES without adding
 * its label/description here fails tsc, and the drift-guard test
 * (tests/unit/auth/patScopeMeta.test.ts) closes the reverse direction.
 * Consumed by pages/developer/personal-tokens.tsx.
 */
import type { PatScope } from './patScopes';

export interface PatScopeMeta {
  label: string;
  desc: string;
}

export const PAT_SCOPE_META: Record<PatScope, PatScopeMeta> = {
  'read:reports': {
    label: 'Read reports',
    desc: 'Trial balance, income statement, balance sheet, etc.',
  },
  'read:invoices': {
    label: 'Read invoices',
    desc: 'List and view customer/supplier invoices',
  },
  'write:invoices': {
    label: 'Write invoices',
    desc: 'Create, edit, and post invoices',
  },
  'read:bank-tx': {
    label: 'Read bank transactions',
    desc: 'View imported bank statements and allocations',
  },
  'write:bank-tx': {
    label: 'Write bank transactions',
    desc: 'Allocate, edit, and post bank transactions',
  },
  'write:journals': {
    label: 'Write journals',
    desc: 'Post General Ledger journal entries',
  },
  'read:contacts': {
    label: 'Read contacts',
    desc: 'List customers and suppliers, including balances',
  },
  'read:vat': {
    label: 'Read VAT status',
    desc: 'Current VAT201 period summary and VAT return status',
  },
  'write:post': {
    label: 'Post & finalize (irreversible)',
    desc: 'Allows this token to POST journals and finalize documents — irreversible entries. Grant only if you trust this integration.',
  },
};
