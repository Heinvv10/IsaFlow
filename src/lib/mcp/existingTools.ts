import {duplicateInvoiceChecksTool,paymentRiskChecksTool} from './tools/forensicRiskChecks';
/**
 * Assembles MCP_TOOLS into the singleton registry the transport dispatches
 * through. Read tools register here (Task 2.6); write/post tools append in
 * Phase 3. The drift-guard test keeps CLIENT_MCP_TOOL_NAMES in sync.
 */
import { companyProfileTool, listCompaniesTool } from './tools/company';
import { listGlAccountsTool, searchGlTool } from './tools/reports';
import { trialBalanceTool } from './tools/reportsTrialBalance';
import { getInvoiceTool, listInvoicesTool, listQuotesTool } from './tools/invoices';
import { listCustomersTool, listSuppliersTool } from './tools/contacts';
import { bankAccountsStatusTool, listBankTransactionsTool } from './tools/bank';
import { listImportBatchesTool } from './tools/importBatches';
import { reconcileSubledgerTool } from './tools/reconcileSubledger';
import { generalLedgerTool } from './tools/generalLedger';
import { balanceSheetTool } from './tools/reportsBalanceSheet';
import { agedCreditorsTool, agedDebtorsTool } from './tools/reportsAging';
import { profitAndLossTool } from './tools/reportsProfitAndLoss';
import { listJournalsTool } from './tools/journals';
import { attachDocumentTool } from './tools/writeAttachDocument';
import { getMatchCandidatesTool } from './tools/bankMatch';
import { listUnappliedReceiptsTool, suggestReceiptMatchesTool } from './tools/receipts';
import { listUnappliedPaymentsTool } from './tools/supplierPayments';
import { applyReceiptToInvoiceTool } from './tools/writeApplyReceipt';
import { applyPaymentToSupplierInvoiceTool } from './tools/writeApplySupplierPayment';
import { reverseJournalEntryTool } from './tools/writeJournalReverse';
import { settleByContraTool } from './tools/writeSettleByContra';
import {
  createCustomerTool,
  updateCustomerTool,
  createSupplierTool,
  updateSupplierTool,
} from './tools/writeContacts';
import { vatStatusTool } from './tools/vat';
import { chartOfAccountsHealthTool, dataIntegrityChecksTool } from './tools/integrity';
import { lockVatPeriodTool, vat201ExportTool, vatReconciliationTool } from './tools/vatReports';
import { listAgentPostingsTool } from './tools/agentActivity';
import { auditTrailTool } from './tools/auditTrail';
import {
  listDocumentsTool,
  getDocumentTool,
  listUnsupportedTransactionsTool,
} from './tools/documents';
import {
  createDraftInvoiceTool,
  createDraftQuoteTool,
  finalizeInvoiceTool,
} from './tools/writeInvoices';
import { createDraftJournalTool, postJournalTool } from './tools/writeJournals';
import { proposeReclassificationTool } from './tools/reclassificationPropose';
import { postReclassificationBatchTool } from './tools/writeReclassification';
import { suggestBankAllocationTool } from './tools/writeBank';
import { allocateBankTransactionTool, reverseBankAllocationTool } from './tools/writeBankAllocate';
import { importBankStatementTool, undoBankImportTool } from './tools/writeBankImport';
import {
  bulkAllocateBankTransactionsTool,
} from './tools/writeBankBulkAllocate';
import { reverseBankAllocationBatchTool } from './tools/writeBankReverseBatch';
import { reverseAllocationsTool } from './tools/writeBankReverseRange';
import { setOpeningBalanceTool } from './tools/writeOpeningBalance';
import {
  createGlAccountTool,
  updateGlAccountTool,
  deactivateGlAccountTool,
} from './tools/writeGlAccounts';
import { mergeGlAccountsTool } from './tools/writeMergeGlAccounts';
import { listSupplierInvoicesTool, getSupplierInvoiceTool } from './tools/supplierInvoices';
import {
  createSupplierInvoiceTool,
  approveSupplierInvoiceTool,
} from './tools/writeSupplierInvoices';
import { bulkCreateSupplierInvoicesTool } from './tools/writeBulkInvoices';
import { bulkApproveSupplierInvoicesTool } from './tools/writeBulkApproveSupplierInvoices';
import { bulkFinalizeInvoicesTool } from './tools/writeBulkFinalizeInvoices';
import { bulkApproveCreditNotesTool } from './tools/writeBulkApproveCreditNotes';
import { bulkCreateCustomerInvoicesTool } from './tools/writeBulkCustomerInvoices';
import { voidReceiptTool, voidPaymentTool } from './tools/writeVoidPayments';
import { listBankRulesTool, getBankRuleTool } from './tools/bankRules';
import { listCreditNotesTool, getCreditNoteTool } from './tools/creditNotes';
import {
  createCreditNoteTool,
  approveCreditNoteTool,
  cancelCreditNoteTool,
} from './tools/writeCreditNotes';
import {
  listBankReconciliationsTool,
  cancelBankReconciliationTool,
} from './tools/bankReconciliations';
import {
  createBankRuleTool,
  updateBankRuleTool,
  disableBankRuleTool,
} from './tools/writeBankRules';
import {
  listPracticeClientsTool,
  listJobCategoriesTool,
  listWorkItemsTool,
  listTimeEntriesTool,
} from './tools/practice';
import { createJobCategoryTool, createWorkItemTool } from './tools/writePracticeSetup';
import { listEmployeesTool, listPayRunsTool } from './tools/payroll';
import {
  getEmployeeTool,
  listEmployeeComponentsTool,
  listPayrollComponentsTool,
} from './tools/payrollComponents';
import { emp201StatusTool, irp5DataTool } from './tools/payrollSars';
import {
  customerStatementTool,
  projectProfitabilityTool,
  wipReportTool,
} from './tools/domainReports';
import { budgetVarianceTool } from './tools/budgetVariance';
import { jobCostReportTool } from './tools/jobCost';
import { listFixedAssetsTool, assetRegisterTool } from './tools/assets';
import { reconcileFixedAssetsTool } from './tools/reconcileFixedAssets';
import { runDepreciationTool } from './tools/writeDepreciation';
import {
  listItemsTool,
  stockValuationTool,
  supplierStatementTool,
} from './tools/inventoryAndAp';
import { createPayRunTool, postPayrollJournalTool } from './tools/writePayroll';
import {
  assignEmployeeComponentTool,
  createEmployeeTool,
  endEmployeeComponentTool,
  updateEmployeeTool,
} from './tools/writeEmployees';
import { approvePayRunTool, calculatePayRunTool } from './tools/writePayrollRun';
import {
  listFiscalPeriodsTool,
  getFiscalPeriodTool,
  periodCloseChecklistTool,
} from './tools/fiscalPeriods';
import { bankStatementCoverageTool, getOpeningBalancesTool } from './tools/bankCoverage';
import {
  closeFiscalPeriodTool,
  reopenFiscalPeriodTool,
  yearEndCloseTool,
} from './tools/writeFiscalPeriods';
import { performBankReconciliationTool } from './tools/writeBankReconciliation';
import { logTimeEntryTool, submitTimeEntriesTool } from './tools/writePracticeTime';

export const EXISTING_MCP_TOOLS = [
  duplicateInvoiceChecksTool,
  paymentRiskChecksTool,
  companyProfileTool,
  listCompaniesTool,
  trialBalanceTool,
  profitAndLossTool,
  balanceSheetTool,
  agedDebtorsTool,
  agedCreditorsTool,
  reconcileSubledgerTool,
  generalLedgerTool,
  searchGlTool,
  listGlAccountsTool,
  listInvoicesTool,
  getInvoiceTool,
  listQuotesTool,
  listCustomersTool,
  listSuppliersTool,
  bankAccountsStatusTool,
  listBankTransactionsTool,
  getMatchCandidatesTool,
  vatStatusTool,
  vatReconciliationTool,
  vat201ExportTool,
  dataIntegrityChecksTool,
  chartOfAccountsHealthTool,
  listAgentPostingsTool,
  // Governance (W5). audit_trail supersedes list_agent_postings, which stays
  // registered: it is on the wire and agents are mid-flight against it.
  auditTrailTool,
  listDocumentsTool,
  getDocumentTool,
  listUnsupportedTransactionsTool,
  listSupplierInvoicesTool,
  getSupplierInvoiceTool,
  listBankRulesTool,
  getBankRuleTool,
  listImportBatchesTool,
  listJournalsTool,
  listBankReconciliationsTool,
  listPracticeClientsTool,
  listJobCategoriesTool,
  listWorkItemsTool,
  listTimeEntriesTool,
  listCreditNotesTool,
  getCreditNoteTool,
  suggestReceiptMatchesTool,
  listUnappliedReceiptsTool,
  listUnappliedPaymentsTool,
  // Period control and bank completeness.
  listFiscalPeriodsTool,
  getFiscalPeriodTool,
  periodCloseChecklistTool,
  bankStatementCoverageTool,
  getOpeningBalancesTool,
  listEmployeesTool,
  getEmployeeTool,
  listPayrollComponentsTool,
  listEmployeeComponentsTool,
  listPayRunsTool,
  emp201StatusTool,
  irp5DataTool,
  customerStatementTool,
  projectProfitabilityTool,
  wipReportTool,
  listFixedAssetsTool,
  assetRegisterTool,
  reconcileFixedAssetsTool,
  runDepreciationTool,
  listItemsTool,
  stockValuationTool,
  supplierStatementTool,
  jobCostReportTool,
  budgetVarianceTool,
  proposeReclassificationTool,
  createDraftInvoiceTool,
  createDraftQuoteTool,
  createDraftJournalTool,
  suggestBankAllocationTool,
  postJournalTool,
  finalizeInvoiceTool,
  bulkFinalizeInvoicesTool,
  allocateBankTransactionTool,
  reverseBankAllocationTool,
  bulkAllocateBankTransactionsTool,
  reverseBankAllocationBatchTool,
  postReclassificationBatchTool,
  importBankStatementTool,
  undoBankImportTool,
  createGlAccountTool,
  updateGlAccountTool,
  deactivateGlAccountTool,
  mergeGlAccountsTool,
  createSupplierInvoiceTool,
  approveSupplierInvoiceTool,
  bulkCreateSupplierInvoicesTool,
  bulkApproveSupplierInvoicesTool,
  bulkCreateCustomerInvoicesTool,
  voidReceiptTool,
  voidPaymentTool,
  createBankRuleTool,
  updateBankRuleTool,
  disableBankRuleTool,
  reverseAllocationsTool,
  setOpeningBalanceTool,
  attachDocumentTool,
  cancelBankReconciliationTool,
  // Practice: setup posts nothing; log/submit book billable hours that feed WIP
  // and invoicing but write no journal, so neither is requiresPost.
  createJobCategoryTool,
  createWorkItemTool,
  logTimeEntryTool,
  submitTimeEntriesTool,
  createCreditNoteTool,
  approveCreditNoteTool,
  bulkApproveCreditNotesTool,
  cancelCreditNoteTool,
  // Payroll: create_pay_run opens an empty period and posts nothing, so it is
  // not requiresPost. post_payroll_journal writes to gl_journal_entries and is.
  createPayRunTool,
  calculatePayRunTool,
  approvePayRunTool,
  postPayrollJournalTool,
  createEmployeeTool,
  updateEmployeeTool,
  assignEmployeeComponentTool,
  endEmployeeComponentTool,
  // Cash application: moves a customer's outstanding balance, and on the
  // bank-line branch posts DR Bank / CR Accounts Receivable. requiresPost.
  applyReceiptToInvoiceTool,
  applyPaymentToSupplierInvoiceTool,
  reverseJournalEntryTool,
  settleByContraTool,
  // Contacts: post nothing, and sit on their own write:contacts scope because
  // a supplier's bank account number is editable here.
  createCustomerTool,
  updateCustomerTool,
  createSupplierTool,
  updateSupplierTool,
  // Period control: close/reopen a period and close a year. All three require
  // write:post — each one changes what may post, or posts to equity.
  closeFiscalPeriodTool,
  reopenFiscalPeriodTool,
  yearEndCloseTool,
  performBankReconciliationTool,
  // Records that a VAT period has been filed. requiresPost because it freezes
  // a filed return: a control an agent can set without write:post is not one.
  lockVatPeriodTool,
] as const;
