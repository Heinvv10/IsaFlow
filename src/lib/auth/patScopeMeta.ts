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
  'read:approvals': { label: 'Read operation approvals', desc: 'Read approval requirements and request status.' },
  'write:approvals': { label: 'Request operation approvals', desc: 'Request independent approval of a specific operation. Decisions require a signed-in human.' },
  'write:beneficiaries': { label: 'Propose beneficiary changes', desc: 'Propose banking changes for independent human verification before use.' },
  'read:access': { label: 'Review access', desc: 'Read current tenant roles and connection grants without credentials.' },
  'read:audit': { label: 'Read forensic evidence', desc: 'Read protected accounting history and control findings. Sensitive payroll needs separate permission.' },
  'write:audit': { label: 'Capture forensic evidence', desc: 'Create evidence snapshots and audit export jobs.' },
  'write:controls': { label: 'Manage control exceptions', desc: 'Assign exceptions and request resolution after a fresh control check.' },
  'read:payroll-sensitive': { label: 'Read sensitive payroll evidence', desc: 'Reveal restricted payroll identity and banking evidence with current explicit permission and read:payroll.' },

  'read:practice': {
    label: 'Read practice management',
    desc: 'Practice clients, the job category / work item taxonomy, and logged time entries.',
  },
  'write:practice': {
    label: 'Write practice management',
    desc: 'Create job categories and work items, and log and submit time entries. Time entries carry a rate and feed WIP and client invoicing, but post nothing to the ledger.',
  },
  'read:payroll': {
    label: 'Read payroll',
    desc: 'Employees, pay runs, and the PAYE/UIF/SDL totals on them. SA identity and tax numbers are masked to the last four digits unless explicitly requested.',
  },
  'write:payroll': {
    label: 'Write payroll',
    desc: 'Open a payroll run for a month, and post an approved run\'s journal to the general ledger. Posting also needs write:post.',
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
  'write:contacts': {
    label: 'Write contacts',
    // Banking details are called out explicitly because this is consent text
    // and they are the field whose misuse costs real money: a supplier's bank
    // account number is what a payment run pays into.
    desc: 'Create and edit customers and suppliers, including a supplier\'s bank name, account number and branch code. Posts nothing to the ledger and cannot delete a contact.',
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
