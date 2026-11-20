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
  // finaliseReturn: VAT201 (vat) or EMP501 (payroll), the return's own module
  approveVATAdjustment: 'vat', finaliseReturn: '*',
  approveAdjustment: 'items', approveEntries: 'accountant',
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
  // an invoice delete / undo asks the invoice's own module (customers or suppliers) from its entity type
  mayApproveInvoiceDelete: { kind: 'allow', module: '*' },
};

/** Wrappers on the default export that gate the whole route for one module (Payroll: read for GET, write otherwise). */
export const ROUTE_WRAPPERS: Readonly<Record<string, string>> = { withPayrollModule: 'payroll' };

/**
 * The payroll-READ census (round 6): a route outside pages/api/payroll that returns one person's pay must ask Payroll read. SQL on these
 * per-employee tables makes the function holding it a primitive; the gates are Payroll read (refuseWithoutPayrollRead, mayReadPayroll)
 * and the wrappers that ask it. Aggregate totals (a count, a monthly PAYE sum) are exempted per site with `census-exempt(sql)` or
 * `census-exempt(<callee>)` and a reason.
 */
export const PAYROLL_DETAIL_SQL: readonly RegExp[] = [
  /\b(?:FROM|JOIN)\s+(?:"?public"?\.)?"?(?:payslips|payroll_payslips|payroll_run_lines|payroll_employees|payroll_employee_components|payroll_irp5\w*|employees)"?\b/i,
  // Round 7 (M3c): the rest of the per-employee tables, a person's bank details, loans, garnishees, directives and payments
  /\b(?:FROM|JOIN)\s+(?:"?public"?\.)?"?(?:payroll_bank_details|payroll_bank_file_items|tax_directive_payments|tax_directives|payroll_loans?\w*|payroll_garnishee_\w+|payroll_external_payslips|payroll_batch_lines|payroll_employee_history|payroll_employee_fringe_benefits|pay_packages|payslip_deliveries)"?\b/i,
  // the change history of an employee or of an employee's bank details
  /\bFROM\s+(?:public\.)?entity_changes\b[^;]*?'?payroll_(?:employee|bank_detail)\b/is,
];
export const PAYROLL_READ_GATES: Readonly<Record<string, GateSpec>> = {
  refuseWithoutPayrollRead: { kind: 'refuse', module: 'payroll' },
  mayReadPayroll: { kind: 'allow', module: 'payroll' },
};
export const PAYROLL_READ_WRAPPERS: Readonly<Record<string, string>> = { withPayrollModule: 'payroll', withPayrollDetailAccess: 'payroll' };
