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
  'read:practice': {
    label: 'Read practice management',
    desc: 'Practice clients, the job category / work item taxonomy, and logged time entries.',
  },
  'write:practice': {
    label: 'Write practice management',
    desc: 'Create job categories and work items, and log and submit time entries. Time entries carry a rate and feed WIP and client invoicing, but post nothing to the ledger.',
  },
  'read:reports': {
    label: 'Read reports',
    desc: 'Trial balance, income statement, balance sheet, etc.',
  },
  'read:invoices': {
    label: 'Read invoices',
    desc: 'List and view customer/supplier invoices',
  },
  'write:invoices': {
    label: 'Write invoices and credit notes',
    // Credit notes are named explicitly because this is consent text. They run
    // the other way to an invoice — a credit note REDUCES a receivable or a
    // payable, and approving one that is linked to an invoice also reduces that
    // invoice's outstanding balance. Someone granting "post invoices" would not
    // otherwise know they had authorised that.
    desc: 'Create, edit and post invoices, and raise or cancel credit notes against them (a credit note reduces what is owed)',
  },
  'read:bank-tx': {
    label: 'Read bank transactions',
    desc: 'View imported bank statements and allocations',
  },
  'write:bank-tx': {
    label: 'Write bank transactions',
    desc: 'Allocate, edit, and post bank transactions',
  },
  'write:accounts': {
    label: 'Write chart of accounts',
    desc: 'Create, edit and deactivate GL accounts, including changing an account\'s subtype and parent. Does not post anything to the ledger.',
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
    label: 'Post, finalize & allocate (irreversible)',
    desc: 'Allows this token to POST journals, finalize documents, allocate bank transactions, and REVERSE posted entries on its own — an allocation posts an AP/AR journal, records a customer payment as confirmed, and marks a supplier invoice paid; cancelling a credit note reverses its journal. Grant only if you trust this integration.',
  },
};
