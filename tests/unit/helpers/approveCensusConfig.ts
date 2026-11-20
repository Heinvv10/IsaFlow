/**
 * The approve / post census's primitives and gates (the analyser's inputs; approvePostEntryCensus.test.ts and a human following a
 * finding both read it).
 *
 * SINKS map a posting / reversing / approving service to the module whose Approve a route must hold before calling it ('*': the
 * module is decided by the document, any module's gate will do). They are a floor, not the definition: SQL_PRIMITIVES also
 * marks as a sink every function that itself posts a journal or flips a document to approved in SQL, so a new posting function
 * is caught without being named here (round 4, F-M2).
 */
import type { GateSpec } from './approveCensusGraph';

export const SINK_MODULES: Readonly<Record<string, string>> = {
  // GL / accounts
  postJournalEntry: 'accounts', reverseJournalEntry: 'accounts', postOpeningBalances: 'accounts', executeMigration: 'accounts',
  runDepreciation: 'accounts', closeFiscalYear: 'accounts', closePeriod: 'accounts', closeYear: 'accounts', lockPeriod: 'accounts',
  reopenPeriod: 'accounts', runBulkPeriodAction: 'accounts', runRecurringJournal: 'accounts', postAssetDisposalToGL: 'accounts',
  postCapitalizationExpenseToGL: 'accounts', closeLoanPeriod: 'accounts', postPeriodJournals: 'accounts',
  softDelete: '*', undoDelete: '*', // an invoice delete / undo: the invoice's module (customers or suppliers) is chosen by the entity type
  postEliminationAdjustment: 'group', reverseEliminationAdjustment: 'group',
  // AP
  approveSupplierInvoice: 'suppliers', cancelSupplierInvoice: 'suppliers', postSupplierInvoiceToGL: 'suppliers',
  approveSupplierPayment: 'suppliers', processSupplierPayment: 'suppliers', voidSupplierPayment: 'suppliers', approveBatch: 'suppliers',
  processBatch: 'suppliers', reverseBatch: 'suppliers', approveCreditNote: '*', cancelCreditNote: '*', approveClaim: 'suppliers',
  postClaimToGl: 'suppliers', postReceiptAsPettyCashJournal: 'suppliers', runCapturePostFollowUps: 'suppliers',
  attachEvidenceAndSettleApproved: 'suppliers',
  // AR
  approveCustomerInvoice: 'customers', cancelCustomerInvoice: 'customers', postCustomerInvoiceToGL: 'customers',
  confirmCustomerPayment: 'customers', cancelCustomerPayment: 'customers', runRecurringInvoice: 'customers', approveWriteOff: 'customers',
  // banking
  allocateTransaction: 'banking', splitAllocateTransaction: 'banking', bulkAcceptTransactions: 'banking',
  reverseReconciledTransaction: 'banking', confirmBulkAccept: 'banking', undoBulkAcceptBatch: 'banking', confirmReceiptMatch: 'banking',
  confirmCustomerInvoiceMatch: 'banking', confirmSupplierInvoiceMatch: 'banking', confirmPurchaseOrderMatch: 'banking',
  postBankTransfer: 'banking', postProvisional: 'banking', reopenReconciliation: 'banking',
  // VAT, items, practice, budgets, approvals
  approveVATAdjustment: 'vat', finaliseReturn: '*', // VAT201 (vat) or EMP501 (payroll): the return's own module approveAdjustment: 'items', approveEntries: 'accountant',
  approvePracticeEntries: 'accountant', transitionVersion: 'budgets', decideRequest: '*', approvePurchaseOrder: 'suppliers',
  // payroll
  approvePayrollRun: 'payroll', reopenPayrollRun: 'payroll', postBatch: 'payroll', bookEtiForMonthLocked: 'payroll',
  markUifDeclarationPaid: 'payroll',
  // recurring templates (the run decides per template type)
  executeRecurring: '*',
};

export const POSTING_SERVICES = Object.keys(SINK_MODULES);

/**
 * SQL that makes the function holding it a primitive (matched against the static text of its tagged templates): a journal posted,
 * or a customer / supplier invoice flipped to approved.
 */
export const SQL_PRIMITIVES: readonly RegExp[] = [
  /UPDATE\s+(?:public\.)?gl_journal_entries[^;]{0,400}?status\s*=\s*'posted'/i,
  /INSERT\s+INTO\s+(?:public\.)?gl_journal_entries[^;]{0,600}?'posted'/i,
  /UPDATE\s+(?:public\.)?(?:customer_invoices|supplier_invoices)[^;]{0,300}?SET[^;]{0,300}?status\s*=\s*'approved'/i,
];

/**
 * How each gate answers. `refuse`: true means REFUSED (the route returns on it); `allow`: true means allowed; `assert`: throws when
 * refused. `moduleArg`: the index of the module argument, or `module` when the gate is for one module; a non-literal module
 * argument counts as '*'.
 */
export const GATES: Readonly<Record<string, GateSpec>> = {
  refuseWithoutApprove: { kind: 'refuse', moduleArg: 3 },
  refuseWithoutGroupApprove: { kind: 'refuse', moduleArg: 3 },
  refuseApprovalRequestWithoutApprove: { kind: 'refuse', module: '*' },
  mayApprove: { kind: 'allow', moduleArg: 2 },
  mayApproveInGroup: { kind: 'allow', moduleArg: 2 },
  mayApproveSupplierInvoices: { kind: 'allow', module: 'suppliers' },
  assertMayApprove: { kind: 'assert', moduleArg: 2 },
  assertMayApproveCreditNote: { kind: 'assert', module: '*' },
};

/** Wrappers on the default export that gate the whole route for one module (Payroll: read for GET, write otherwise). */
export const ROUTE_WRAPPERS: Readonly<Record<string, string>> = { withPayrollModule: 'payroll' };

/**
 * A PARAMETERISED sink whose gate depends on an argument: the route asks the Approve on the branch that posts, and the same service
 * call also serves the branch that does not (reject, lock, draft). Every call of the callee in the file is skipped, so each entry
 * is pinned by a per-path test (routeApproveGates.test.ts, approveGateEverything.test.ts) and checked for staleness.
 */
export const SITE_EXEMPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'pages/api/accounting/approval-requests.ts': {
    decideRequest: 'approving asks the document type\'s Approve first (refuseApprovalRequestWithoutApprove); a rejection posts nothing. approveGateEverything / approvePermissionPaths',
  },
  'pages/api/accounting/close-run/decide.ts': {
    decideProposal: 'approve asks Chart of Accounts & GL Approve first; reject and dismiss post nothing. routeApproveGates (close-run/decide)',
  },
  'pages/api/accounting/budget-versions/[id]/status.ts': {
    transitionVersion: 'approve asks Budgets Approve first; lock and unlock have no ledger effect. approveGateEverything',
  },
  'pages/api/accounting/gl-import.ts': {
    importJournalEntries: 'postImmediately asks Chart of Accounts & GL Approve first; an import without posting leaves drafts. routeApproveGates (gl-import)',
  },
  'pages/api/accounting/bank-transactions-bulk-commit.ts': {
    importParsedTransactions: 'the import itself lands for anyone who may write; its auto-post sweep is skipped (skipAutoPost) without Banking Approve. routeApproveGates',
  },
  'pages/api/accounting/ai-invoice-pipeline.ts': {
    attachEvidenceAndSettleApproved: 'a bill the person may not approve is left manual_review / draft (approveWithheld), so nothing is settled. breaker1670AiPipeline',
  },
  'pages/api/accounting/capture/[id]/post.ts': {
    runCapturePostFollowUps: 'a bill the person may not approve is stored draft (approveWithheld), so the follow-ups settle nothing. captureApprovePermission',
  },
};
