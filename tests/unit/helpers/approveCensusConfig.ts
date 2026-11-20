/** The approve / post census's primitives and gates (the analyser's inputs; approvePostEntryCensus.test.ts and a human following a finding both read it). */
/** Services that approve, post, reverse or finalise a ledger document when a route calls them. */
export const POSTING_SERVICES = [
  // GL / accounts
  'postJournalEntry', 'reverseJournalEntry', 'postOpeningBalances', 'executeMigration', 'runDepreciation',
  'closeFiscalYear', 'closePeriod', 'closeYear', 'lockPeriod', 'reopenPeriod', 'runBulkPeriodAction',
  'runRecurringJournal', 'postAssetDisposalToGL', 'postCapitalizationExpenseToGL', 'closeLoanPeriod',
  'postPeriodJournals', 'postEliminationAdjustment', 'reverseEliminationAdjustment',
  // AP
  'approveSupplierInvoice', 'cancelSupplierInvoice', 'postSupplierInvoiceToGL', 'approveSupplierPayment',
  'processSupplierPayment', 'voidSupplierPayment', 'approveBatch', 'processBatch', 'reverseBatch',
  'approveCreditNote', 'cancelCreditNote', 'approveClaim', 'postClaimToGl', 'postReceiptAsPettyCashJournal',
  'runCapturePostFollowUps', 'attachEvidenceAndSettleApproved',
  // AR
  'approveCustomerInvoice', 'cancelCustomerInvoice', 'postCustomerInvoiceToGL', 'confirmCustomerPayment',
  'cancelCustomerPayment', 'runRecurringInvoice', 'approveWriteOff',
  // banking
  'allocateTransaction', 'splitAllocateTransaction', 'bulkAcceptTransactions', 'reverseReconciledTransaction',
  'confirmBulkAccept', 'undoBulkAcceptBatch', 'confirmReceiptMatch', 'confirmCustomerInvoiceMatch',
  'confirmSupplierInvoiceMatch', 'confirmPurchaseOrderMatch', 'postBankTransfer', 'postProvisional',
  // VAT, items, practice, budgets, approvals
  'approveVATAdjustment', 'reopenReconciliation', 'finaliseReturn', 'approveAdjustment', 'approveEntries', 'approvePracticeEntries',
  'transitionVersion', 'decideRequest', 'approvePurchaseOrder',
  // payroll
  'approvePayrollRun', 'reopenPayrollRun', 'postBatch', 'bookEtiForMonthLocked', 'markUifDeclarationPaid',
  // recurring templates (the run decides per template type)
  'executeRecurring',
] as const;

export const GATES: ReadonlySet<string> = new Set([
  'refuseWithoutApprove', 'refuseWithoutGroupApprove', 'mayApprove', 'mayApproveInGroup', 'assertMayApprove',
  'mayApproveSupplierInvoices', 'assertMayApproveCreditNote', 'approveModuleForRequest', 'refuseApprovalRequestWithoutApprove',
]);
/** Wrappers on the default export that gate the whole route (Payroll module: read for GET, write otherwise). */
export const ROUTE_WRAPPERS = ['withPayrollModule'] as const;

