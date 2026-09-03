/**
 * OAuth consent-screen copy — the "this app would like to" strings.
 *
 * Deliberately a plain module rather than a const inside ConsentScopeList.tsx:
 * this is the text someone reads before granting an MCP connector access to
 * their books, and it must be assertable from the unit suite, which cannot
 * import JSX. consentScopeCopy.test.ts keeps it in step with PAT_SCOPE_META —
 * the two drifted once already, leaving the consent screen saying a token could
 * only "create and edit invoices" when it could also reduce receivables.
 */
import type { OAuthScope } from './oauth';

// Typed against the OAuth vocabulary: adding a scope to OAUTH_SCOPES without a
// label here fails tsc.
export const SCOPE_LABELS: Record<OAuthScope, string> = {
  'read:invoices': 'Read your invoices and credit notes',
  // Credit notes are named because they run the OTHER WAY to an invoice: one
  // reduces what a customer owes you, or what you owe a supplier. "Create and
  // edit invoices" did not tell anyone they were authorising that. Keep in step
  // with PAT_SCOPE_META['write:invoices'] — consentScopeCopy.test.ts asserts it.
  'write:invoices': 'Create and edit invoices, and raise or cancel credit notes against them',
  'read:bank-tx': 'Read your bank transactions',
  'write:bank-tx': 'Allocate and post bank transactions',
  'write:journals': 'Post General Ledger journals',
  'write:accounts': 'Create and edit your chart of accounts',
  'read:reports': 'Read your financial reports',
  'read:contacts': 'Read your customers and suppliers',
  // Named separately from write:invoices because it is a different kind of
  // trust: this grant lets an integration change a supplier's BANKING DETAILS,
  // and nobody granting "create and edit invoices" would expect that. Keep in
  // step with PAT_SCOPE_META['write:contacts'] — consentScopeCopy.test.ts
  // asserts it.
  'write:contacts': 'Create and edit your customers and suppliers, including supplier banking details',
  'read:vat': 'Read your VAT status',
  'read:practice': 'Read your practice clients, job categories and logged time',
  'write:practice': 'Create job categories and work items, and log and submit time entries',
  // Named explicitly because payroll data is personal information under POPIA
  // and staff pay is not what anyone expects "read your reports" to cover.
  'read:payroll': 'Read your payroll — employees, pay runs, and PAYE, UIF and SDL totals',
  'write:payroll': 'Open payroll runs and post the payroll journal to your ledger',
  // Copy tracks what the grant actually permits: it now also unlocks automated
  // bank allocation, which posts AP/AR journals, records customer payments as
  // confirmed, and marks supplier invoices paid. Keep in step with
  // PAT_SCOPE_META['write:post'].
  'write:post': 'Post journals, finalize documents, allocate bank transactions, and reverse posted entries in your ledger',
  'offline_access': 'Stay connected (refresh access in the background)',
};

